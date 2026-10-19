import type { Prisma, PrismaClient } from '@commercebill/database';
import { resolveAuthConfig, type AuthConfig, type PartialAuthConfig } from './config.js';
import { PasswordHasher } from './password.js';
import { diffIds, rolesOutsideCeiling, withinCeiling } from './privileges.js';
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
  | 'unknown_user'
  | 'current_password_incorrect'
  | 'password_reuse'
  | 'cannot_disable_self'
  | 'cannot_reset_self'
  | 'cannot_change_own_roles'
  | 'role_exceeds_caller_privileges'
  | 'target_exceeds_caller_privileges'
  | 'last_administrator'
  | 'actor_inactive'
  | 'actor_forbidden';

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

/** What administrators see of a user. Never contains the password hash, sessions or tokens. */
export interface UserView {
  id: string;
  organizationId: string;
  username: string;
  displayName: string;
  email: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  roles: { id: string; name: string }[];
}

export interface RoleView {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
}

/** The authenticated administrator performing an operation. organizationId comes from the SESSION, never the request. */
export interface AdminContext {
  userId: string;
  organizationId: string;
  correlationId?: string | null;
}

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

  async function getPermissions(
    userId: string,
    organizationId: string,
    db: Prisma.TransactionClient | PrismaClient = prisma,
  ): Promise<Set<string>> {
    // Permissions come only from the user's roles in the user's own organization. There is no
    // administrator bypass: the Administrator role simply holds every catalogue permission.
    const rows = await db.rolePermission.findMany({
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
    input: Omit<CreateUserInput, 'password' | 'username'> & { username?: string },
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

  // ---------------------------------------------------------------------------------------------------------
  // Task 1.6: password change / reset and administrator-driven user and role management (ADR-0017).
  // Every operation is organization-scoped by the caller's session, re-validates the acting user's active state and
  // required permissions INSIDE its transaction, and writes its audit event in the same transaction.

  const userInclude = {
    roles: { include: { role: { select: { id: true, name: true } } } },
  } as const;
  type UserWithRoles = Prisma.UserGetPayload<{ include: typeof userInclude }>;

  const toUserView = (u: UserWithRoles): UserView => ({
    id: u.id,
    organizationId: u.organizationId,
    username: u.username,
    displayName: u.displayName,
    email: u.email,
    isActive: u.isActive,
    mustChangePassword: u.mustChangePassword,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
    roles: u.roles.map((r) => r.role).sort((a, b) => a.name.localeCompare(b.name)),
  });

  /** Same key the database constraint trigger takes at commit: checks for one organization queue up. */
  async function lockOrganizationAdmins(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'secadmin:' + organizationId}, 0))`;
  }

  /** The acting user must still be active and still hold the permissions the route required. */
  async function requireActor(
    tx: Prisma.TransactionClient,
    ctx: AdminContext,
    required: string[],
  ): Promise<Set<string>> {
    const actor = await tx.user.findFirst({
      where: { id: ctx.userId, organizationId: ctx.organizationId, isActive: true },
    });
    if (!actor)
      throw new AuthServiceError('actor_inactive', 'The acting user is no longer active.');
    const permissions = await getPermissions(actor.id, ctx.organizationId, tx);
    for (const key of required) {
      if (!permissions.has(key)) {
        throw new AuthServiceError(
          'actor_forbidden',
          'The acting user lacks a required permission.',
        );
      }
    }
    return permissions;
  }

  /** In-transaction twin of the database trigger, so callers get a precise error instead of a failed commit. */
  async function assertSecurityAdminRemains(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<void> {
    const org = await tx.organization.findUnique({
      where: { id: organizationId },
      select: { setupCompletedAt: true },
    });
    if (!org?.setupCompletedAt) return; // same exemption as the trigger
    const [row] = await tx.$queryRaw<
      { n: number }[]
    >`SELECT organization_security_admin_count(${organizationId}::uuid) AS n`;
    if (!row || row.n < 1) {
      throw new AuthServiceError(
        'last_administrator',
        'The organization must keep at least one active user who can manage users and roles.',
      );
    }
  }

  async function rolesWithPermissions(
    tx: Prisma.TransactionClient,
    organizationId: string,
    roleIds: string[],
  ) {
    const roles = await tx.role.findMany({
      where: { id: { in: roleIds }, organizationId },
      include: { permissions: { include: { permission: { select: { key: true } } } } },
    });
    return roles.map((r) => ({
      id: r.id,
      name: r.name,
      permissionKeys: r.permissions.map((p) => p.permission.key),
    }));
  }

  /** What the shell shows about the signed-in user: organization name and role names (display only). */
  async function getProfile(
    auth: AuthContext,
  ): Promise<{ organizationName: string; roles: string[] }> {
    const [org, roles] = await Promise.all([
      prisma.organization.findUnique({
        where: { id: auth.organizationId },
        select: { legalName: true, tradeName: true },
      }),
      prisma.role.findMany({
        where: { organizationId: auth.organizationId, users: { some: { userId: auth.userId } } },
        select: { name: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    return {
      organizationName: org?.tradeName?.trim() || org?.legalName || '',
      roles: roles.map((r) => r.name),
    };
  }

  async function listRoles(organizationId: string): Promise<RoleView[]> {
    const rows = await prisma.role.findMany({
      where: { organizationId },
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      isSystem: r.isSystem,
    }));
  }

  async function listUsers(
    organizationId: string,
    options: { limit: number; offset: number; isActive?: boolean },
  ): Promise<{ users: UserView[]; total: number }> {
    const where = {
      organizationId,
      ...(options.isActive === undefined ? {} : { isActive: options.isActive }),
    };
    const [rows, total] = await Promise.all([
      prisma.user.findMany({
        where,
        include: userInclude,
        orderBy: { username: 'asc' },
        take: options.limit,
        skip: options.offset,
      }),
      prisma.user.count({ where }),
    ]);
    return { users: rows.map(toUserView), total };
  }

  async function getUser(organizationId: string, userId: string): Promise<UserView | null> {
    const row = await prisma.user.findFirst({
      where: { id: userId, organizationId },
      include: userInclude,
    });
    return row ? toUserView(row) : null;
  }

  async function adminCreateUser(
    ctx: AdminContext,
    input: {
      username: string;
      displayName: string;
      email?: string | null;
      password: string;
      roleIds?: string[];
    },
  ): Promise<UserView> {
    const roleIds = [...new Set(input.roleIds ?? [])];
    const prepared = await prepareNewUser({ username: input.username, password: input.password });
    return prisma.$transaction(async (tx) => {
      // Creating a user with roles is role assignment: it needs BOTH permissions.
      const required =
        roleIds.length > 0
          ? ['security.user.manage', 'security.role.manage']
          : ['security.user.manage'];
      const actorPermissions = await requireActor(tx, ctx, required);
      const roles = await rolesWithPermissions(tx, ctx.organizationId, roleIds);
      if (roles.length !== roleIds.length) {
        throw new AuthServiceError('unknown_role', 'One or more roles do not exist.');
      }
      if (rolesOutsideCeiling(actorPermissions, roles).length > 0) {
        throw new AuthServiceError(
          'role_exceeds_caller_privileges',
          "A role exceeds the caller's own permissions.",
        );
      }
      const created = await insertUser(
        tx,
        {
          organizationId: ctx.organizationId,
          displayName: input.displayName,
          email: input.email ?? null,
          roleNames: roles.map((r) => r.name),
          mustChangePassword: true, // the administrator chose this password: the user must replace it
        },
        prepared,
        { userId: ctx.userId, correlationId: ctx.correlationId },
      );
      return toUserView(
        await tx.user.findUniqueOrThrow({ where: { id: created.id }, include: userInclude }),
      );
    });
  }

  async function adminSetUserRoles(
    ctx: AdminContext,
    targetUserId: string,
    requestedRoleIds: string[],
  ): Promise<UserView> {
    const roleIds = [...new Set(requestedRoleIds)];
    return prisma.$transaction(async (tx) => {
      await lockOrganizationAdmins(tx, ctx.organizationId);
      const actorPermissions = await requireActor(tx, ctx, ['security.role.manage']);
      const target = await tx.user.findFirst({
        where: { id: targetUserId, organizationId: ctx.organizationId },
        include: userInclude,
      });
      if (!target) throw new AuthServiceError('unknown_user', 'User not found.');
      if (target.id === ctx.userId) {
        throw new AuthServiceError('cannot_change_own_roles', 'You cannot change your own roles.');
      }
      const requested = await rolesWithPermissions(tx, ctx.organizationId, roleIds);
      if (requested.length !== roleIds.length) {
        throw new AuthServiceError('unknown_role', 'One or more roles do not exist.');
      }
      const currentIds = target.roles.map((r) => r.role.id);
      const { added, removed } = diffIds(currentIds, roleIds);
      // The ceiling applies to every role being granted OR revoked: roles above the caller can be neither.
      const touched = await rolesWithPermissions(tx, ctx.organizationId, [...added, ...removed]);
      if (rolesOutsideCeiling(actorPermissions, touched).length > 0) {
        throw new AuthServiceError(
          'role_exceeds_caller_privileges',
          "A role exceeds the caller's own permissions.",
        );
      }
      if (added.length === 0 && removed.length === 0) return toUserView(target);

      if (removed.length > 0) {
        await tx.userRole.deleteMany({ where: { userId: target.id, roleId: { in: removed } } });
      }
      if (added.length > 0) {
        await tx.userRole.createMany({
          data: added.map((roleId) => ({ userId: target.id, roleId })),
        });
      }
      await tx.user.update({ where: { id: target.id }, data: { version: { increment: 1 } } });
      await assertSecurityAdminRemains(tx, ctx.organizationId);
      const after = await tx.user.findUniqueOrThrow({
        where: { id: target.id },
        include: userInclude,
      });
      await audit(tx, {
        action: 'user.roles.changed',
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        entityId: target.id,
        after: {
          before: target.roles.map((r) => r.role.name).sort(),
          after: after.roles.map((r) => r.role.name).sort(),
        },
        correlationId: ctx.correlationId,
      });
      return toUserView(after);
    });
  }

  async function adminDisableUser(
    ctx: AdminContext,
    targetUserId: string,
  ): Promise<{ changed: boolean; user: UserView }> {
    return prisma.$transaction(async (tx) => {
      await lockOrganizationAdmins(tx, ctx.organizationId);
      await requireActor(tx, ctx, ['security.user.manage']);
      const target = await tx.user.findFirst({
        where: { id: targetUserId, organizationId: ctx.organizationId },
      });
      if (!target) throw new AuthServiceError('unknown_user', 'User not found.');
      if (target.id === ctx.userId) {
        throw new AuthServiceError('cannot_disable_self', 'You cannot disable your own account.');
      }
      if (!target.isActive) {
        return {
          changed: false,
          user: toUserView(
            await tx.user.findUniqueOrThrow({ where: { id: target.id }, include: userInclude }),
          ),
        };
      }
      await tx.user.update({
        where: { id: target.id },
        data: { isActive: false, version: { increment: 1 } },
      });
      const revoked = await tx.session.updateMany({
        where: { userId: target.id, revokedAt: null },
        data: { revokedAt: clock() },
      });
      await assertSecurityAdminRemains(tx, ctx.organizationId);
      await audit(tx, {
        action: 'user.disable',
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        entityId: target.id,
        after: { sessionsRevoked: revoked.count },
        correlationId: ctx.correlationId,
      });
      return {
        changed: true,
        user: toUserView(
          await tx.user.findUniqueOrThrow({ where: { id: target.id }, include: userInclude }),
        ),
      };
    });
  }

  async function adminEnableUser(
    ctx: AdminContext,
    targetUserId: string,
  ): Promise<{ changed: boolean; user: UserView }> {
    return prisma.$transaction(async (tx) => {
      await lockOrganizationAdmins(tx, ctx.organizationId);
      await requireActor(tx, ctx, ['security.user.manage']);
      const target = await tx.user.findFirst({
        where: { id: targetUserId, organizationId: ctx.organizationId },
      });
      if (!target) throw new AuthServiceError('unknown_user', 'User not found.');
      if (target.isActive) {
        return {
          changed: false,
          user: toUserView(
            await tx.user.findUniqueOrThrow({ where: { id: target.id }, include: userInclude }),
          ),
        };
      }
      await tx.user.update({
        where: { id: target.id },
        data: { isActive: true, failedLoginCount: 0, lockedUntil: null, version: { increment: 1 } },
      });
      await audit(tx, {
        action: 'user.enable',
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        entityId: target.id,
        correlationId: ctx.correlationId,
      });
      return {
        changed: true,
        user: toUserView(
          await tx.user.findUniqueOrThrow({ where: { id: target.id }, include: userInclude }),
        ),
      };
    });
  }

  /**
   * Administrator-assisted reset: the administrator SUPPLIES a temporary password (the server never generates or
   * returns one, and no existing password can be read). The user must change it at next login; all of their
   * sessions are revoked and any lockout is cleared. Distinct from changeOwnPassword.
   */
  async function adminResetPassword(
    ctx: AdminContext,
    targetUserId: string,
    temporaryPassword: string,
  ): Promise<{ sessionsRevoked: number }> {
    if (targetUserId === ctx.userId) {
      throw new AuthServiceError(
        'cannot_reset_self',
        'Use the password change to change your own password.',
      );
    }
    const preview = await prisma.user.findFirst({
      where: { id: targetUserId, organizationId: ctx.organizationId },
    });
    if (!preview) throw new AuthServiceError('unknown_user', 'User not found.');
    const prepared = await prepareNewUser({
      username: preview.username,
      password: temporaryPassword,
    });
    return prisma.$transaction(async (tx) => {
      const actorPermissions = await requireActor(tx, ctx, ['security.user.reset_password']);
      const target = await tx.user.findFirst({
        where: { id: targetUserId, organizationId: ctx.organizationId },
      });
      if (!target) throw new AuthServiceError('unknown_user', 'User not found.');
      // Resetting someone's password is taking over their account: only for users who cannot do more than the caller.
      const targetPermissions = await getPermissions(target.id, ctx.organizationId, tx);
      if (!withinCeiling(actorPermissions, targetPermissions)) {
        throw new AuthServiceError(
          'target_exceeds_caller_privileges',
          'The user has permissions beyond your own.',
        );
      }
      await tx.user.update({
        where: { id: target.id },
        data: {
          passwordHash: prepared.passwordHash,
          mustChangePassword: true,
          failedLoginCount: 0,
          lockedUntil: null,
          version: { increment: 1 },
        },
      });
      const revoked = await tx.session.updateMany({
        where: { userId: target.id, revokedAt: null },
        data: { revokedAt: clock() },
      });
      await audit(tx, {
        action: 'user.password.reset',
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        entityId: target.id,
        after: { sessionsRevoked: revoked.count },
        correlationId: ctx.correlationId,
      });
      return { sessionsRevoked: revoked.count };
    });
  }

  /** Counts a wrong current password toward the account lockout, so a stolen session cannot guess it for free. */
  async function recordWrongCurrentPassword(
    userId: string,
    correlationId?: string | null,
  ): Promise<void> {
    const now = clock();
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      const u = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      const alreadyLocked = Boolean(u.lockedUntil && u.lockedUntil > now);
      let count = u.failedLoginCount;
      let locked = alreadyLocked;
      if (!alreadyLocked) {
        const previous = u.lockedUntil && u.lockedUntil <= now ? 0 : u.failedLoginCount;
        count = previous + 1;
        locked = count >= config.lockout.maxFailures;
        await tx.user.update({
          where: { id: u.id },
          data: {
            failedLoginCount: count,
            lockedUntil: locked
              ? new Date(now.getTime() + config.lockout.lockMinutes * 60_000)
              : null,
          },
        });
      }
      await audit(tx, {
        action: 'user.password.change_failed',
        organizationId: u.organizationId,
        userId: u.id,
        entityId: u.id,
        after: { reason: 'current_password_incorrect', failedCount: count, locked },
        correlationId,
      });
    });
  }

  /**
   * Self-service password change. Requires the current password, applies the password policy, rejects re-use of
   * the current password, keeps ONLY the current session and revokes all others, and clears the forced-change flag.
   */
  async function changeOwnPassword(
    auth: AuthContext,
    input: { currentPassword: string; newPassword: string },
    correlationId?: string | null,
  ): Promise<{ sessionsRevoked: number }> {
    const user = await prisma.user.findFirst({
      where: { id: auth.userId, organizationId: auth.organizationId, isActive: true },
    });
    if (!user) throw new AuthServiceError('actor_inactive', 'The acting user is no longer active.');

    const now = clock();
    const tooLong = input.currentPassword.length > MAX_PASSWORD_INPUT;
    const verified = await hasher.verify(user.passwordHash, tooLong ? '' : input.currentPassword);
    const locked = Boolean(user.lockedUntil && user.lockedUntil > now);
    if (!verified || tooLong || locked) {
      if (!locked) await recordWrongCurrentPassword(user.id, correlationId);
      throw new AuthServiceError(
        'current_password_incorrect',
        'The current password is not correct.',
      );
    }

    const check = checkPassword(input.newPassword, { username: user.username }, config.password);
    if (!check.ok) {
      throw new AuthServiceError(
        'weak_password',
        'The new password does not meet the policy.',
        check.problems,
      );
    }
    if (await hasher.verify(user.passwordHash, input.newPassword)) {
      throw new AuthServiceError(
        'password_reuse',
        'The new password must differ from the current one.',
      );
    }
    const newHash = await hasher.hash(input.newPassword);

    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id}::uuid FOR UPDATE`;
      const fresh = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
      if (!fresh.isActive || fresh.passwordHash !== user.passwordHash) {
        // Changed by someone else while we were hashing: treat as a failed attempt rather than overwrite.
        throw new AuthServiceError(
          'current_password_incorrect',
          'The current password is not correct.',
        );
      }
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash: newHash,
          mustChangePassword: false,
          failedLoginCount: 0,
          lockedUntil: null,
          version: { increment: 1 },
        },
      });
      const revoked = await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null, id: { not: auth.sessionId } },
        data: { revokedAt: clock() },
      });
      await audit(tx, {
        action: 'user.password.changed',
        organizationId: user.organizationId,
        userId: user.id,
        entityId: user.id,
        after: { sessionsRevoked: revoked.count },
        correlationId,
      });
      return { sessionsRevoked: revoked.count };
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
    getProfile,
    listRoles,
    listUsers,
    getUser,
    adminCreateUser,
    adminSetUserRoles,
    adminDisableUser,
    adminEnableUser,
    adminResetPassword,
    changeOwnPassword,
  };
}

export type AuthService = Awaited<ReturnType<typeof createAuthService>>;
