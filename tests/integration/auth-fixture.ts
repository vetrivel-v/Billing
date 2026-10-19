import { createPrismaClient, type PrismaClient } from '@commercebill/database';
import { createIsolatedDatabase, type IsolatedDatabase } from '@commercebill/test-utilities';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps } from '../../apps/api/src/app.js';
import { seedReference } from '../../prisma/seed/reference/index.js';

/** Throwaway values for tests only. */
export const LAUNCH_SECRET = 'launch-secret-for-tests-'.padEnd(64, 'x');
export const PASSWORD = 'correct horse battery staple';
/** Cheap Argon2 settings so the suite is fast; the real defaults are exercised in one dedicated test. */
export const FAST_ARGON2 = { memoryCost: 1024, timeCost: 1, parallelism: 1 } as const;

export const ROLE_USERS = [
  { role: 'Administrator', username: 'admin.user' },
  { role: 'Accountant', username: 'accountant.user' },
  { role: 'Billing Operator', username: 'billing.user' },
  { role: 'Warehouse Operator', username: 'warehouse.user' },
  { role: 'Viewer/Auditor', username: 'viewer.user' },
] as const;

export interface TestClock {
  now: Date;
  advance(ms: number): void;
}

export function makeClock(start = new Date()): TestClock {
  const clock: TestClock = {
    now: start,
    advance(ms) {
      clock.now = new Date(clock.now.getTime() + ms);
    },
  };
  return clock;
}

export interface Fixture {
  db: IsolatedDatabase;
  prisma: PrismaClient;
  orgId: string;
  clock: TestClock;
  makeApp(overrides?: Partial<AppDeps>): Promise<FastifyInstance>;
  close(): Promise<void>;
}

/** Fresh isolated database + organization + reference seed (permissions, roles, units, tax data). */
export async function createFixture(
  adminUrl: string,
  options: { bare?: boolean } = {},
): Promise<Fixture> {
  const db = await createIsolatedDatabase(adminUrl);
  const prisma = createPrismaClient(db.url);
  // `bare` = a freshly migrated database with NO organization (fresh installation, for setup tests).
  const org = options.bare
    ? { id: '' }
    : await prisma.organization.create({ data: { legalName: 'DEMO Auth Co (fictional)' } });
  if (!options.bare) await seedReference(prisma, { organizationId: org.id });
  const clock = makeClock();
  const apps: FastifyInstance[] = [];

  return {
    db,
    prisma,
    orgId: org.id,
    clock,
    async makeApp(overrides = {}) {
      const app = await buildApp({
        env: { LOG_LEVEL: 'silent', WEB_ORIGIN: ['http://127.0.0.1:5173'] },
        prisma,
        launchSecret: LAUNCH_SECRET,
        globalRateLimit: { max: 1_000_000, timeWindowMs: 60_000 },
        loginRateLimit: { max: 100_000, timeWindowMs: 60_000 },
        changePasswordRateLimit: { max: 100_000, timeWindowMs: 60_000 },
        resetPasswordRateLimit: { max: 100_000, timeWindowMs: 60_000 },
        // Setup limits are high by default so ordinary tests are not throttled; rate-limit tests override them.
        setup: {
          completeRateLimit: { max: 100_000, timeWindowMs: 60_000 },
          draftRateLimit: { max: 100_000, timeWindowMs: 60_000 },
        },
        auth: {
          allowWeakHashingForTests: true,
          config: { argon2: FAST_ARGON2 },
          clock: () => clock.now,
        },
        ...overrides,
      });
      apps.push(app);
      return app;
    },
    async close() {
      for (const app of apps) await app.close();
      await prisma.$disconnect();
      await db.drop();
    },
  };
}

/** The response fields the tests read; any may be absent at runtime. */
export interface ApiJson {
  token: string;
  idleTimeoutSeconds: number;
  user: { id: string; username: string; organizationId: string };
  permissions: string[];
  error: {
    code: string;
    message: string;
    dataSaved: boolean;
    correlationId?: string;
    problems?: { field: string; rule: string }[];
  };
  /** GET /setup/draft */
  draft: { data: Record<string, Record<string, string>>; version: number; savedAt: string } | null;
  discarded: boolean;
  version: number;
  [key: string]: unknown;
}

export interface Req {
  token?: string;
  body?: unknown;
  /** Send the Electron launch secret (default true). */
  launch?: boolean;
  headers?: Record<string, string>;
}

export async function call(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  req: Req = {},
) {
  const headers: Record<string, string> = { ...req.headers };
  if (req.launch !== false) headers['x-commercebill-launch-secret'] = LAUNCH_SECRET;
  if (req.token) headers.authorization = `Bearer ${req.token}`;
  const res = await app.inject({
    method,
    url,
    headers,
    ...(req.body !== undefined ? { payload: req.body as object } : {}),
  });
  let json = {} as ApiJson;
  try {
    json = res.json() as ApiJson;
  } catch {
    // non-JSON body (e.g. 204): leave json empty
  }
  return { status: res.statusCode, json, headers: res.headers, body: res.body };
}

export async function login(app: FastifyInstance, username: string, password = PASSWORD) {
  return call(app, 'POST', '/auth/login', { body: { username, password } });
}

/** Creates one user per role template and logs each in. Returns tokens keyed by role name. */
export async function createRoleUsers(
  app: FastifyInstance,
  orgId: string,
): Promise<Record<string, string>> {
  const tokens: Record<string, string> = {};
  for (const { role, username } of ROLE_USERS) {
    try {
      await app.authService!.createUser({
        organizationId: orgId,
        username,
        displayName: `${role} (test)`,
        password: PASSWORD,
        roleNames: [role],
      });
    } catch (err) {
      if ((err as { code?: string }).code !== 'duplicate_username') throw err; // already created by an earlier test
    }
    const res = await login(app, username);
    if (res.status !== 200) throw new Error(`login failed for ${username}: ${res.body}`);
    tokens[role] = res.json.token as string;
  }
  return tokens;
}
