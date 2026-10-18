import type { Prisma, PrismaClient } from '@commercebill/database';
import { resolveAuthConfig, type AuthConfig, type PartialAuthConfig } from './config.js';
import { PasswordHasher } from './password.js';
import { checkPassword, type PasswordProblem } from './password-policy.js';
import {
  fingerprint,
  generateSessionToken,
  hashSessionToken,
  looksLikeSessionToken,
} from './tokens.js';

export type HasherLike = Pick<PasswordHasher, 'hash' | 'verify' | 'needsRehash'>;

export interface AuthServiceOptions {
  prisma: PrismaClient;
  config?: PartialAuthConfig;
  /** Test hook: replace the hasher (e.g. to count verify calls). */
  hasher?: HasherLike;
  /** Test hook: deterministic clock. */
  clock?: () => Date;
  appVersion?: string;
  /** Test hook only: permits Argon2 parameters below the OWASP floor so test suites stay fast. */
  allowWeakHashingForTests?: boolean;
}

export interface Actor {
  userId?: string | null;
  correlationId?: string | null;
  /**
   * Identity of a non-user actor, e.g. "system:bootstrap" during first-run setup, when no authenticated user
   * exists. Recorded in the audit event as `actor`, so system activity is never mistaken for a user's.
   */
  system?: string | null;
}

export type AuthErrorCode =
  | 'invalid_username'
  | 'weak_password'
  | 'duplicate_username'
  | 'unknown_role'
  | 'unknown_organization'
  | 'unknown_user';

export class AuthServiceError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
    readonly problems: PasswordProblem[] = [],
  ) {
    super(message);
    this.name = 'AuthServiceError';
  }
}

export interface AuthContext {
  userId: string;
  organizationId: string;
  sessionId: string;
  username: string;
  displayName: string;
  mustChangePassword: boolean;
  permissions: ReadonlySet<string>;
  sessionExpiresAt: Date;
}

export interface LoginUser {
  id: string;
  organizationId: string;
  username: string;
  displayName: string;
}

/** The public result never says WHY a login failed (no account enumeration). */
export type LoginResult =
  | {
      ok: true;
      token: string;
      expiresAt: Date;
      idleTimeoutSeconds: number;
      user: LoginUser;
      mustChangePassword: boolean;
    }
  | { ok: false };

type FailureReason = 'unknown_user' | 'disabled' | 'locked' | 'bad_password';

export interface CreateUserInput {
  organizationId: string;
  username: string;
  displayName: string;
  email?: string | null;
  password: string;
  /** Names of role templates in the same organization (e.g. "Billing Operator"). */
  roleNames?: string[];
  mustChangePassword?: boolean;
}

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._@-]{2,63}$/;
const MAX_PASSWORD_INPUT = 1024;

/** Canonical stored/lookup form; a database CHECK enforces lower-case + trimmed. */
export function normalizeUsername(username: string): string {
  return username.normalize('NFKC').trim().toLowerCase();
}

export function isValidUsername(normalized: string): boolean {
  return USERNAME_PATTERN.test(normalized);
}

export async function createAuthService(options: AuthServiceOptions) {
  const { prisma } = options;
  const config: AuthConfig = resolveAuthConfig(options.config, {
    allowWeakHashingForTests: options.allowWeakHashingForTests ?? false,
  });
  if (config.session.touchIntervalSeconds >= config.session.idleMinutes * 60) {
    throw new Error(
      'Invalid auth configuration: touchIntervalSeconds must be below the idle timeout',
    );
  }
  const hasher: HasherLike = options.hasher ?? new PasswordHasher(config.argon2);
  const clock = options.clock ?? (() => new Date());
  const appVersion = options.appVersion ?? '0.0.0';

  // Hash of a random throwaway password: unknown users are verified against it so the response time
  // does not reveal whether the account exists. Computed once, with the CURRENT parameters.
  const dummyHash = await hasher.hash(generateSessionToken());

  async function audit(
    tx: Prisma.TransactionClient | PrismaClient,
    entry: {
      action: string;
      organizationId?: string | null;
      userId?: string | null;
      entityId?: string | null;
      after?: Prisma.InputJsonObject;
      correlationId?: string | null;
      system?: string | null;
    },
  ): Promise<void> {
    // Never pass password, hash or token material here; callers supply only non-secret facts.
    await tx.auditLog.create({
      data: {
        organizationId: entry.organizationId ?? null,
        userId: entry.userId ?? null,
        category: 'security',
        action: entry.action,
        entityType: 'user',
        entityId: entry.entityId ?? null,
        afterValues:
          entry.after || entry.system
            ? { ...(entry.after ?? {}), ...(entry.system ? { actor: entry.system } : {}) }
            : undefined,
        appVersion,
        correlationId: entry.correlationId ?? null,
        occurredAt: clock(),
      },
    });
  }

  async function resolveOrganizationId(explicit?: string): Promise<string | null> {
    if (explicit) {
      // An unknown organization id must not reach the audit table (foreign key) or the lookup.
      const found = await prisma.organization.findFirst({
        where: { id: explicit, isActive: true },
        select: { id: true },
      });
      return found?.id ?? null;
    }
    const orgs = await prisma.organization.findMany({
      where: { isActive: true },
      select: { id: true },
      take: 2,
    });
    return orgs.length === 1 ? orgs[0]!.id : null;
  }

  async function getPermissions(userId: string, organizationId: string): Promise<Set<string>> {
    // Permissions come only from the user's roles in the user's own organization. There is no
    // administrator bypass: the Administrator role simply holds every catalogue permission.
    const rows = await prisma.rolePermission.findMany({
      where: { role: { organizationId, users: { some: { userId } } } },
      select: { permission: { select: { key: true } } },
    });
    return new Set(rows.map((r) => r.permission.key));
  }

  /**
   * Validates the username and password policy and hashes the password. Runs OUTSIDE any database
   * transaction (Argon2 takes ~110 ms) so callers never hold locks while hashing.
   */
  async function prepareNewUser(input: {
    username: string;
    password: string;
  }): Promise<{ username: string; passwordHash: string }> {
    const username = normalizeUsername(input.username);
    if (!isValidUsername(username)) {
      throw new AuthServiceError(
        'invalid_username',
        'Username must be 3-64 characters: lower-case letters, digits, dot, underscore, hyphen or @.',
      );
    }
    const check = checkPassword(input.password, { username }, config.password);
    if (!check.ok) {
      throw new AuthServiceError(
        'weak_password',
        'The password does not meet the policy.',
        check.problems,
      );
    }
    return { username, passwordHash: await hasher.hash(input.password) };
  }

  /**
   * Inserts a user on the caller's transaction client (so first-run setup can create the Administrator
   * atomically with the organization). `prepared` must come from prepareNewUser.
   */
  async function insertUser(
    tx: Prisma.TransactionClient,
    input: Omit<CreateUserInput, 'password'>,
    prepared: { username: string; passwordHash: string },
    actor: Actor = {},
  ): Promise<LoginUser> {
    try {
      const org = await tx.organization.findUnique({ where: { id: input.organizationId } });
      if (!org) throw new AuthServiceError('unknown_organization', 'Organization not found.');
      const roleNames = [...new Set(input.roleNames ?? [])];
      const roles = await tx.role.findMany({
        where: { organizationId: input.organizationId, name: { in: roleNames } },
      });
      if (roles.length !== roleNames.length) {
        throw new AuthServiceError('unknown_role', 'One or more roles do not exist.');
      }
      const user = await tx.user.create({
        data: {
          organizationId: input.organizationId,
          username: prepared.username,
          displayName: input.displayName,
          email: input.email ?? null,
          passwordHash: prepared.passwordHash,
          mustChangePassword: input.mustChangePassword ?? false,
          roles: { create: roles.map((r) => ({ roleId: r.id })) },
        },
      });
      await audit(tx, {
        action: 'user.create',
        organizationId: input.organizationId,
        userId: actor.userId,
        entityId: user.id,
        after: { username: prepared.username, roles: roleNames },
        correlationId: actor.correlationId,
        system: actor.system,
      });
      return {
        id: user.id,
        organizationId: user.organizationId,
        username: user.username,
        displayName: user.displayName,
      };
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new AuthServiceError('duplicate_username', 'That username is already in use.');
      }
      throw err;
    }
  }

  async function createUser(input: CreateUserInput, actor: Actor = {}): Promise<LoginUser> {
    const prepared = await prepareNewUser(input);
    return prisma.$transaction((tx) => insertUser(tx, input, prepared, actor));
  }

  async function login(input: {
    username: string;
    password: string;
    organizationId?: string;
    correlationId?: string | null;
  }): Promise<LoginResult> {
    const now = clock();
    const username = normalizeUsername(input.username);
    const organizationId = await resolveOrganizationId(input.organizationId);
    const shapeOk = isValidUsername(username);
    const user =
      organizationId && shapeOk
        ? await prisma.user.findUnique({
            where: { organizationId_username: { organizationId, username } },
          })
        : null;

    // EXACTLY ONE Argon2 verification on every path (unknown user, disabled, locked, wrong or right
    // password), so timing does not distinguish them.
    const tooLong = input.password.length > MAX_PASSWORD_INPUT;
    const verified = await hasher.verify(
      user?.passwordHash ?? dummyHash,
      tooLong ? '' : input.password,
    );
    const passwordOk = Boolean(user) && verified && !tooLong;

    const newHash =
      user && passwordOk && user.isActive && hasher.needsRehash(user.passwordHash)
        ? await hasher.hash(input.password)
        : null;

    if (!user) {
      await audit(prisma, {
        action: 'auth.login.failure',
        organizationId,
        // Only a short one-way fingerprint of the attempted name: people sometimes type passwords here.
        after: { reason: 'unknown_user', attempt: fingerprint(username) },
        correlationId: input.correlationId,
      });
      return { ok: false };
    }

    return prisma.$transaction(async (tx): Promise<LoginResult> => {
      // Serialise attempts on the same account so concurrent guesses cannot bypass the counter.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id}::uuid FOR UPDATE`;
      const u = await tx.user.findUniqueOrThrow({ where: { id: user.id } });

      const fail = async (reason: FailureReason, extra: Prisma.InputJsonObject = {}) => {
        await audit(tx, {
          action: 'auth.login.failure',
          organizationId: u.organizationId,
          userId: u.id,
          entityId: u.id,
          after: { reason, ...extra },
          correlationId: input.correlationId,
        });
        return { ok: false } as const;
      };

      if (!u.isActive) return fail('disabled');
      if (u.lockedUntil && u.lockedUntil > now) return fail('locked');

      if (!passwordOk || u.passwordHash !== user.passwordHash) {
        // A lock that has expired restarts the count, so old failures never linger.
        const previous = u.lockedUntil && u.lockedUntil <= now ? 0 : u.failedLoginCount;
        const count = previous + 1;
        const lock = count >= config.lockout.maxFailures;
        await tx.user.update({
          where: { id: u.id },
          data: {
            failedLoginCount: count,
            lockedUntil: lock
              ? new Date(now.getTime() + config.lockout.lockMinutes * 60_000)
              : null,
          },
        });
        return fail('bad_password', { failedCount: count, locked: lock });
      }

      const token = generateSessionToken();
      const expiresAt = new Date(now.getTime() + config.session.absoluteHours * 3_600_000);
      await tx.session.create({
        data: {
          userId: u.id,
          tokenHash: hashSessionToken(token),
          createdAt: now,
          lastSeenAt: now,
          expiresAt,
        },
      });
      await tx.user.update({
        where: { id: u.id },
        data: {
          failedLoginCount: 0,
          lockedUntil: null,
          lastLoginAt: now,
          ...(newHash ? { passwordHash: newHash, version: { increment: 1 } } : {}),
        },
      });
      if (newHash) {
        await audit(tx, {
          action: 'auth.password.rehash',
          organizationId: u.organizationId,
          userId: u.id,
          entityId: u.id,
          after: { reason: 'parameters_upgraded' },
          correlationId: input.correlationId,
        });
      }
      await audit(tx, {
        action: 'auth.login.success',
        organizationId: u.organizationId,
        userId: u.id,
        entityId: u.id,
        correlationId: input.correlationId,
      });
      return {
        ok: true,
        token,
        expiresAt,
        idleTimeoutSeconds: config.session.idleMinutes * 60,
        user: {
          id: u.id,
          organizationId: u.organizationId,
          username: u.username,
          displayName: u.displayName,
        },
        mustChangePassword: u.mustChangePassword,
      };
    });
  }

  /** Validates a presented session token entirely server-side. Returns null for ANY invalid state. */
  async function authenticateToken(token: unknown): Promise<AuthContext | null> {
    if (!looksLikeSessionToken(token)) return null;
    const now = clock();
    const session = await prisma.session.findUnique({
      where: { tokenHash: hashSessionToken(token) },
      include: { user: true },
    });
    if (!session || session.revokedAt) return null;
    if (session.expiresAt <= now) return null;
    if (session.lastSeenAt.getTime() + config.session.idleMinutes * 60_000 <= now.getTime())
      return null;
    if (!session.user.isActive) return null;

    if (
      now.getTime() - session.lastSeenAt.getTime() >=
      config.session.touchIntervalSeconds * 1000
    ) {
      await prisma.session.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { lastSeenAt: now },
      });
    }
    return {
      userId: session.user.id,
      organizationId: session.user.organizationId,
      sessionId: session.id,
      username: session.user.username,
      displayName: session.user.displayName,
      mustChangePassword: session.user.mustChangePassword,
      permissions: await getPermissions(session.user.id, session.user.organizationId),
      sessionExpiresAt: session.expiresAt,
    };
  }

  async function logout(context: AuthContext, actor: Actor = {}): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const res = await tx.session.updateMany({
        where: { id: context.sessionId, revokedAt: null },
        data: { revokedAt: clock() },
      });
      if (res.count > 0) {
        await audit(tx, {
          action: 'auth.logout',
          organizationId: context.organizationId,
          userId: context.userId,
          entityId: context.userId,
          correlationId: actor.correlationId,
        });
      }
    });
  }

  async function revokeAllSessions(userId: string, actor: Actor = {}): Promise<number> {
    return prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new AuthServiceError('unknown_user', 'User not found.');
      const res = await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: clock() },
      });
      await audit(tx, {
        action: 'auth.sessions.revoked',
        organizationId: user.organizationId,
        userId: actor.userId,
        entityId: userId,
        after: { count: res.count },
        correlationId: actor.correlationId,
      });
      return res.count;
    });
  }

  /** Disables the account (users are never physically deleted) and ends all of its sessions. */
  async function disableUser(userId: string, actor: Actor = {}): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new AuthServiceError('unknown_user', 'User not found.');
      await tx.user.update({
        where: { id: userId },
        data: { isActive: false, version: { increment: 1 } },
      });
      const res = await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: clock() },
      });
      await audit(tx, {
        action: 'user.disable',
        organizationId: user.organizationId,
        userId: actor.userId,
        entityId: userId,
        after: { sessionsRevoked: res.count },
        correlationId: actor.correlationId,
      });
    });
  }

  async function enableUser(userId: string, actor: Actor = {}): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new AuthServiceError('unknown_user', 'User not found.');
      await tx.user.update({
        where: { id: userId },
        data: { isActive: true, failedLoginCount: 0, lockedUntil: null, version: { increment: 1 } },
      });
      await audit(tx, {
        action: 'user.enable',
        organizationId: user.organizationId,
        userId: actor.userId,
        entityId: userId,
        correlationId: actor.correlationId,
      });
    });
  }

  return {
    config,
    createUser,
    prepareNewUser,
    insertUser,
    login,
    authenticateToken,
    logout,
    revokeAllSessions,
    disableUser,
    enableUser,
    getPermissions,
  };
}

export type AuthService = Awaited<ReturnType<typeof createAuthService>>;
