import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  AuthServiceError,
  PasswordHasher,
  createAuthService,
  type HasherLike,
} from '@commercebill/auth';
import {
  FAST_ARGON2,
  LAUNCH_SECRET,
  PASSWORD,
  ROLE_USERS,
  call,
  createFixture,
  createRoleUsers,
  login,
  type Fixture,
} from './auth-fixture.js';

const MINUTE = 60_000;
const afterOf = (r: { afterValues: unknown }) =>
  (r.afterValues ?? {}) as { reason?: string; attempt?: string };
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

let fx: Fixture;

beforeAll(async () => {
  fx = await createFixture(inject('pgAdminUrl'));
}, 120_000);
afterAll(async () => fx?.close());

async function freshUser(
  app: Awaited<ReturnType<Fixture['makeApp']>>,
  username: string,
  role = 'Viewer/Auditor',
) {
  return app.authService!.createUser({
    organizationId: fx.orgId,
    username,
    displayName: username,
    password: PASSWORD,
    roleNames: [role],
  });
}

describe('password storage and user creation', () => {
  it('never stores plaintext; two users with the same password get different Argon2id hashes', async () => {
    const app = await fx.makeApp();
    const a = await freshUser(app, 'twin.one');
    const b = await freshUser(app, 'twin.two');
    const rows = await fx.prisma.user.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(rows).toHaveLength(2);
    const [h1, h2] = rows.map((r) => r.passwordHash);
    expect(h1).not.toBe(h2);
    for (const h of [h1!, h2!]) {
      expect(h.startsWith('$argon2id$v=19$')).toBe(true);
      expect(h).not.toContain(PASSWORD);
    }
  });

  it('never writes password material to the audit log', async () => {
    const app = await fx.makeApp();
    await freshUser(app, 'audit.clean');
    await login(app, 'audit.clean');
    await login(app, 'audit.clean', 'wrong password here 1');
    const hashes = (await fx.prisma.user.findMany({ select: { passwordHash: true } })).map(
      (u) => u.passwordHash,
    );
    const audit = JSON.stringify(await fx.prisma.auditLog.findMany());
    expect(audit).not.toContain(PASSWORD);
    expect(audit).not.toContain('wrong password here 1');
    for (const h of hashes) expect(audit).not.toContain(h.slice(0, 40));
    expect(audit).not.toMatch(/\$argon2/);
  });

  it('enforces the password policy server-side', async () => {
    const app = await fx.makeApp();
    const svc = app.authService!;
    const base = { organizationId: fx.orgId, displayName: 'x', roleNames: [] as string[] };
    await expect(
      svc.createUser({ ...base, username: 'weak.one', password: 'short' }),
    ).rejects.toMatchObject({
      code: 'weak_password',
      problems: expect.arrayContaining(['too_short']),
    });
    await expect(
      svc.createUser({ ...base, username: 'weak.two', password: 'password123456' }),
    ).rejects.toMatchObject({
      code: 'weak_password',
      problems: expect.arrayContaining(['common_password']),
    });
    await expect(
      svc.createUser({ ...base, username: 'weak.three', password: 'weak.three is my login' }),
    ).rejects.toMatchObject({ problems: expect.arrayContaining(['contains_username']) });
    expect(await fx.prisma.user.count({ where: { username: { startsWith: 'weak.' } } })).toBe(0);
  });

  it('normalises usernames, rejects duplicates (also by case) and unknown roles/organizations', async () => {
    const app = await fx.makeApp();
    const svc = app.authService!;
    const u = await freshUser(app, '  Mixed.Case  ');
    expect(u.username).toBe('mixed.case');
    await expect(freshUser(app, 'MIXED.CASE')).rejects.toMatchObject({
      code: 'duplicate_username',
    });
    await expect(freshUser(app, 'x')).rejects.toMatchObject({ code: 'invalid_username' });
    await expect(freshUser(app, 'bad name!')).rejects.toMatchObject({ code: 'invalid_username' });
    await expect(
      svc.createUser({
        organizationId: fx.orgId,
        username: 'no.role',
        displayName: 'x',
        password: PASSWORD,
        roleNames: ['Nope'],
      }),
    ).rejects.toMatchObject({ code: 'unknown_role' });
    await expect(
      svc.createUser({
        organizationId: '00000000-0000-4000-8000-000000000000',
        username: 'no.org',
        displayName: 'x',
        password: PASSWORD,
      }),
    ).rejects.toBeInstanceOf(AuthServiceError);
    expect(await fx.prisma.user.count({ where: { username: 'no.role' } })).toBe(0); // rolled back
  });

  it('the database itself rejects non-canonical usernames, raw tokens as hashes, and user deletion', async () => {
    const app = await fx.makeApp();
    const u = await freshUser(app, 'db.guard');
    await expect(
      fx.prisma.$executeRawUnsafe(
        `UPDATE users SET username = 'UPPER.CASE' WHERE id = '${u.id}'::uuid`,
      ),
    ).rejects.toThrow(/users_username_form_chk/);
    await expect(
      fx.prisma.$executeRawUnsafe(
        `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ('${u.id}'::uuid, 'a-raw-base64url-token-not-a-hash-aaaaaaaaaaaaaa', now() + interval '1 hour')`,
      ),
    ).rejects.toThrow(/sessions_token_hash_form_chk/);
    // Users are never physically deleted.
    await expect(fx.prisma.user.delete({ where: { id: u.id } })).rejects.toThrow();
    await expect(
      fx.prisma.$executeRawUnsafe(`DELETE FROM users WHERE id = '${u.id}'::uuid`),
    ).rejects.toThrow(/cannot be deleted/);
    expect(await fx.prisma.user.count({ where: { id: u.id } })).toBe(1);
  });
});

describe('login (server-side credential validation)', () => {
  it('succeeds with correct credentials and stores only the SHA-256 of the token', async () => {
    const app = await fx.makeApp();
    await freshUser(app, 'good.login');
    const res = await login(app, 'good.login');
    expect(res.status).toBe(200);
    expect(res.json.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.json.user).toMatchObject({ username: 'good.login', organizationId: fx.orgId });
    expect(res.json.idleTimeoutSeconds).toBe(30 * 60);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).not.toMatch(/argon2|passwordHash|password_hash/i);

    const rows = await fx.prisma.session.findMany({ where: { user: { username: 'good.login' } } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(sha256(res.json.token));
    expect(rows[0]!.tokenHash).not.toBe(res.json.token);
    expect(rows[0]!.expiresAt.getTime() - rows[0]!.createdAt.getTime()).toBe(12 * 3_600_000);
    const user = await fx.prisma.user.findFirstOrThrow({ where: { username: 'good.login' } });
    expect(user.lastLoginAt).not.toBeNull();
  });

  it('is case-insensitive for usernames and scoped to the organization', async () => {
    const app = await fx.makeApp();
    await freshUser(app, 'case.login');
    expect((await login(app, 'CASE.Login')).status).toBe(200);
    const other = await call(app, 'POST', '/auth/login', {
      body: {
        username: 'case.login',
        password: PASSWORD,
        organizationId: '00000000-0000-4000-8000-000000000000',
      },
    });
    expect(other.status).toBe(401);
  });

  it('returns the SAME generic failure for unknown user, wrong password, disabled and locked accounts', async () => {
    const app = await fx.makeApp({
      auth: {
        allowWeakHashingForTests: true,
        config: { argon2: FAST_ARGON2, lockout: { maxFailures: 3 } },
        clock: () => fx.clock.now,
      },
    });
    await freshUser(app, 'enum.good');
    const disabled = await freshUser(app, 'enum.disabled');
    await app.authService!.disableUser(disabled.id);
    await freshUser(app, 'enum.locked');
    for (let i = 0; i < 3; i++) await login(app, 'enum.locked', 'wrong password number 1');

    const attempts = [
      await login(app, 'enum.does.not.exist'),
      await login(app, 'enum.good', 'wrong password number 1'),
      await login(app, 'enum.disabled'),
      await login(app, 'enum.locked'), // correct password, but locked
      await login(app, 'bad name!'), // not even a valid username shape
    ];
    const normalise = (r: (typeof attempts)[number]) => {
      const j = JSON.parse(JSON.stringify(r.json));
      delete j.error.correlationId;
      return { status: r.status, json: j, cache: r.headers['cache-control'] };
    };
    const first = normalise(attempts[0]!);
    expect(first.status).toBe(401);
    expect(first.json.error.code).toBe('AUTH_0001');
    for (const a of attempts) expect(normalise(a)).toEqual(first);
    // ...and none of them reveals which case applied.
    for (const a of attempts)
      expect(a.body).not.toMatch(/locked|disabled|exist|unknown|password is/i);
  });

  it('rejects malformed requests with 400 (no hashing work) and requires the launch secret first', async () => {
    const app = await fx.makeApp();
    expect((await call(app, 'POST', '/auth/login', { body: {} })).status).toBe(400);
    expect(
      (
        await call(app, 'POST', '/auth/login', {
          body: { username: 'a', password: 'x'.repeat(300) },
        })
      ).status,
    ).toBe(400);
    expect(
      (await call(app, 'POST', '/auth/login', { body: { username: 1, password: 2 } })).status,
    ).toBe(400);
    const noSecret = await call(app, 'POST', '/auth/login', {
      body: { username: 'good.login', password: PASSWORD },
      launch: false,
    });
    expect(noSecret.status).toBe(401);
    expect(noSecret.json.error.code).toBe('AUTH_0001');
    // Authenticating as a user does not substitute for the launch secret, nor vice versa.
    const login1 = await login(app, 'launch.layer');
    const me = await call(app, 'GET', '/auth/me', { token: login1.json.token, launch: false });
    expect(me.status).toBe(401);
  });

  it('exactly one Argon2 verification happens on every path (timing does not reveal the account state)', async () => {
    let verifies = 0;
    const real = new PasswordHasher(FAST_ARGON2);
    const spy: HasherLike = {
      hash: (p) => real.hash(p),
      verify: (h, p) => {
        verifies++;
        return real.verify(h, p);
      },
      needsRehash: (h) => real.needsRehash(h),
    };
    const app = await fx.makeApp({
      auth: {
        allowWeakHashingForTests: true,
        config: { argon2: FAST_ARGON2, lockout: { maxFailures: 3 } },
        clock: () => fx.clock.now,
        hasher: spy,
      },
    });
    await freshUser(app, 'timing.ok');
    const dis = await freshUser(app, 'timing.dis');
    await app.authService!.disableUser(dis.id);
    await freshUser(app, 'timing.lock');
    for (let i = 0; i < 3; i++) await login(app, 'timing.lock', 'wrong password number 1');

    const cases: [string, string][] = [
      ['timing.unknown', PASSWORD],
      ['timing.ok', 'wrong password number 1'],
      ['timing.dis', PASSWORD],
      ['timing.lock', PASSWORD],
      ['timing.ok', PASSWORD],
      ['not a valid name!', PASSWORD],
    ];
    for (const [u, p] of cases) {
      verifies = 0;
      await login(app, u, p);
      expect(verifies, `${u} / ${p}`).toBe(1);
    }
  });

  it('records successful and failed logins in the audit log without secrets, with correlation IDs', async () => {
    const app = await fx.makeApp();
    const u = await freshUser(app, 'audit.login');
    await login(app, 'audit.login');
    await login(app, 'audit.login', 'wrong password number 1');
    await login(app, 'audit.nobody');
    const rows = await fx.prisma.auditLog.findMany({
      where: { category: 'security', action: { startsWith: 'auth.login' } },
      orderBy: { occurredAt: 'asc' },
    });
    const mine = rows.filter((r) => r.entityId === u.id || afterOf(r)?.reason === 'unknown_user');
    const kinds = mine.map((r) => `${r.action}:${afterOf(r)?.reason ?? ''}`);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'auth.login.success:',
        'auth.login.failure:bad_password',
        'auth.login.failure:unknown_user',
      ]),
    );
    const unknown = rows.find(
      (r) => afterOf(r)?.reason === 'unknown_user' && JSON.stringify(r).includes('attempt'),
    )!;
    expect(JSON.stringify(unknown.afterValues)).not.toContain('audit.nobody'); // only a fingerprint
    expect(afterOf(unknown).attempt).toMatch(/^[0-9a-f]{12}$/);
    for (const r of mine) expect(r.correlationId).toBeTruthy();
    expect(mine.find((r) => r.action === 'auth.login.success')!.userId).toBe(u.id);
  });
});

describe('lockout', () => {
  it('locks after N consecutive failures, ignores the right password while locked, then recovers', async () => {
    const app = await fx.makeApp({
      auth: {
        allowWeakHashingForTests: true,
        config: { argon2: FAST_ARGON2, lockout: { maxFailures: 5, lockMinutes: 15 } },
        clock: () => fx.clock.now,
      },
    });
    const u = await freshUser(app, 'lock.me');
    for (let i = 0; i < 4; i++)
      expect((await login(app, 'lock.me', 'wrong password number 1')).status).toBe(401);
    let row = await fx.prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.failedLoginCount).toBe(4);
    expect(row.lockedUntil).toBeNull();
    expect((await login(app, 'lock.me', 'wrong password number 1')).status).toBe(401); // 5th: locks
    row = await fx.prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.lockedUntil!.getTime()).toBe(fx.clock.now.getTime() + 15 * MINUTE);

    expect((await login(app, 'lock.me')).status).toBe(401); // correct password, still locked
    fx.clock.advance(14 * MINUTE);
    expect((await login(app, 'lock.me')).status).toBe(401); // 1 minute left
    const stillLockedUntil = (await fx.prisma.user.findUniqueOrThrow({ where: { id: u.id } }))
      .lockedUntil!;
    expect(stillLockedUntil.getTime()).toBe(row.lockedUntil!.getTime()); // attempts during the lock do not extend it

    fx.clock.advance(2 * MINUTE);
    const ok = await login(app, 'lock.me');
    expect(ok.status).toBe(200);
    row = await fx.prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
    const reasons = (
      await fx.prisma.auditLog.findMany({ where: { entityId: u.id, action: 'auth.login.failure' } })
    ).map((r) => afterOf(r).reason);
    expect(reasons).toEqual(expect.arrayContaining(['bad_password', 'locked']));
  });

  it('a success resets the failure counter; stale failures do not accumulate after a lock expires', async () => {
    const app = await fx.makeApp({
      auth: {
        allowWeakHashingForTests: true,
        config: { argon2: FAST_ARGON2, lockout: { maxFailures: 3, lockMinutes: 10 } },
        clock: () => fx.clock.now,
      },
    });
    const u = await freshUser(app, 'reset.count');
    await login(app, 'reset.count', 'wrong password number 1');
    await login(app, 'reset.count', 'wrong password number 1');
    expect((await login(app, 'reset.count')).status).toBe(200);
    expect((await fx.prisma.user.findUniqueOrThrow({ where: { id: u.id } })).failedLoginCount).toBe(
      0,
    );

    for (let i = 0; i < 3; i++) await login(app, 'reset.count', 'wrong password number 1'); // lock
    fx.clock.advance(11 * MINUTE);
    await login(app, 'reset.count', 'wrong password number 1'); // first failure after expiry restarts the count
    const row = await fx.prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.failedLoginCount).toBe(1);
    expect(row.lockedUntil).toBeNull();
  });

  it('concurrent guesses cannot bypass the counter', async () => {
    const app = await fx.makeApp({
      auth: {
        allowWeakHashingForTests: true,
        config: { argon2: FAST_ARGON2, lockout: { maxFailures: 5, lockMinutes: 15 } },
        clock: () => fx.clock.now,
      },
    });
    const u = await freshUser(app, 'race.me');
    const results = await Promise.all(
      Array.from({ length: 12 }, () => login(app, 'race.me', 'wrong password number 1')),
    );
    expect(results.every((r) => r.status === 401)).toBe(true);
    const row = await fx.prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.lockedUntil).not.toBeNull();
    expect(row.failedLoginCount).toBe(5); // exactly the threshold: later attempts saw the lock and did not count
    expect((await login(app, 'race.me')).status).toBe(401);
  });

  it('rate-limits POST /auth/login per route and answers 429 AUTH_0003', async () => {
    const app = await fx.makeApp({ loginRateLimit: { max: 3, timeWindowMs: 60_000 } });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await login(app, 'rate.limited')).status);
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
    expect(codes.slice(3)).toEqual([429, 429]);
    const last = await login(app, 'rate.limited');
    expect(last.json.error.code).toBe('AUTH_0003');
  });
});

describe('sessions: expiry, revocation, logout', () => {
  it('rejects forged, truncated, altered and non-bearer credentials with 401', async () => {
    const app = await fx.makeApp();
    await freshUser(app, 'forge.target');
    const { token } = (await login(app, 'forge.target')).json;
    expect((await call(app, 'GET', '/auth/me', { token })).status).toBe(200);
    const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    for (const bad of [flipped, token.slice(1), `${token}x`, 'A'.repeat(43), 'not-a-token', '']) {
      const r = await call(app, 'GET', '/auth/me', { token: bad || undefined });
      expect(r.status, bad).toBe(401);
      expect(r.json.error.code).toBe('AUTH_0001');
    }
    expect(
      (await call(app, 'GET', '/auth/me', { headers: { authorization: `Basic ${token}` } })).status,
    ).toBe(401);
    expect((await call(app, 'GET', '/auth/me', { headers: { authorization: token } })).status).toBe(
      401,
    );
    // Tokens in a URL are ignored.
    expect((await call(app, 'GET', `/auth/me?token=${token}`)).status).toBe(401);
    expect(
      (await call(app, 'GET', '/auth/me', { headers: { cookie: `token=${token}` } })).status,
    ).toBe(401);
  });

  it("a token identifies exactly one user: user A's token never yields user B's identity or rights", async () => {
    const app = await fx.makeApp();
    const tokens = await createRoleUsers(app, fx.orgId);
    const viewer = await call(app, 'GET', '/auth/me', { token: tokens['Viewer/Auditor']! });
    const admin = await call(app, 'GET', '/auth/me', { token: tokens['Administrator']! });
    expect(viewer.json.user.username).toBe('viewer.user');
    expect(admin.json.user.username).toBe('admin.user');
    expect(viewer.json.permissions).not.toContain('security.user.manage');
    expect(admin.json.permissions).toContain('security.user.manage');
    // Client-supplied identity hints are ignored.
    const spoof = await call(app, 'GET', '/auth/me', {
      token: tokens['Viewer/Auditor']!,
      headers: { 'x-user-id': admin.json.user.id, 'x-username': 'admin.user' },
    });
    expect(spoof.json.user.username).toBe('viewer.user');
  });

  it('expires after the idle timeout and after the absolute lifetime', async () => {
    const app = await fx.makeApp();
    await freshUser(app, 'expiry.user');
    const { token } = (await login(app, 'expiry.user')).json;

    fx.clock.advance(29 * MINUTE);
    expect((await call(app, 'GET', '/auth/me', { token })).status).toBe(200); // activity refreshes last_seen
    fx.clock.advance(29 * MINUTE);
    expect((await call(app, 'GET', '/auth/me', { token })).status).toBe(200);
    fx.clock.advance(31 * MINUTE);
    expect((await call(app, 'GET', '/auth/me', { token })).status).toBe(401); // idle > 30 min

    const second = (await login(app, 'expiry.user')).json.token as string;
    const issued = fx.clock.now.getTime();
    // Stay active every 29 minutes: the idle timeout never fires...
    for (let i = 0; i < 24; i++) {
      fx.clock.advance(29 * MINUTE);
      expect((await call(app, 'GET', '/auth/me', { token: second })).status).toBe(200);
    }
    // ...but the 12-hour absolute limit (720 min) still ends the session at 725 min.
    fx.clock.advance(29 * MINUTE);
    expect(fx.clock.now.getTime() - issued).toBe(725 * MINUTE);
    expect((await call(app, 'GET', '/auth/me', { token: second })).status).toBe(401);
    const row = await fx.prisma.session.findFirstOrThrow({ where: { tokenHash: sha256(second) } });
    expect(row.revokedAt).toBeNull(); // rejected by expiry, not by revocation
    expect(fx.clock.now.getTime() - row.lastSeenAt.getTime()).toBe(29 * MINUTE); // not idle either
  });

  it('only writes last_seen at the configured interval', async () => {
    const app = await fx.makeApp();
    await freshUser(app, 'touch.user');
    const { token } = (await login(app, 'touch.user')).json;
    const seen = async () =>
      (
        await fx.prisma.session.findFirstOrThrow({ where: { tokenHash: sha256(token) } })
      ).lastSeenAt.getTime();
    const t0 = await seen();
    fx.clock.advance(10_000);
    await call(app, 'GET', '/auth/me', { token });
    expect(await seen()).toBe(t0); // within the 30 s interval
    fx.clock.advance(25_000);
    await call(app, 'GET', '/auth/me', { token });
    expect(await seen()).toBe(fx.clock.now.getTime());
  });

  it('logout revokes the session immediately and is audited; a second logout is a 401', async () => {
    const app = await fx.makeApp();
    const u = await freshUser(app, 'logout.user');
    const { token } = (await login(app, 'logout.user')).json;
    expect((await call(app, 'POST', '/auth/logout', { token })).status).toBe(204);
    expect((await call(app, 'GET', '/auth/me', { token })).status).toBe(401);
    expect((await call(app, 'POST', '/auth/logout', { token })).status).toBe(401);
    const row = await fx.prisma.session.findFirstOrThrow({ where: { tokenHash: sha256(token) } });
    expect(row.revokedAt).not.toBeNull();
    expect(
      await fx.prisma.auditLog.count({ where: { action: 'auth.logout', entityId: u.id } }),
    ).toBe(1);
  });

  it('disabling a user revokes all of their sessions and blocks new ones; re-enabling restores login', async () => {
    const app = await fx.makeApp();
    const u = await freshUser(app, 'disable.user');
    const t1 = (await login(app, 'disable.user')).json.token as string;
    const t2 = (await login(app, 'disable.user')).json.token as string;
    await app.authService!.disableUser(u.id, { userId: null });
    for (const t of [t1, t2])
      expect((await call(app, 'GET', '/auth/me', { token: t })).status).toBe(401);
    expect((await login(app, 'disable.user')).status).toBe(401);
    const row = await fx.prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.isActive).toBe(false); // disabled, not deleted
    expect(await fx.prisma.session.count({ where: { userId: u.id, revokedAt: null } })).toBe(0);
    expect(
      await fx.prisma.auditLog.count({ where: { action: 'user.disable', entityId: u.id } }),
    ).toBe(1);

    await app.authService!.enableUser(u.id);
    expect((await login(app, 'disable.user')).status).toBe(200);
  });

  it('a disabled user cannot use a session even if it was somehow left unrevoked', async () => {
    const app = await fx.makeApp();
    const u = await freshUser(app, 'sneaky.user');
    const { token } = (await login(app, 'sneaky.user')).json;
    await fx.prisma.user.update({ where: { id: u.id }, data: { isActive: false } }); // bypasses disableUser
    expect((await call(app, 'GET', '/auth/me', { token })).status).toBe(401);
  });

  it('revokeAllSessions ends every session of one user and no one else', async () => {
    const app = await fx.makeApp();
    const a = await freshUser(app, 'revoke.a');
    await freshUser(app, 'revoke.b');
    const ta = (await login(app, 'revoke.a')).json.token as string;
    const tb = (await login(app, 'revoke.b')).json.token as string;
    expect(await app.authService!.revokeAllSessions(a.id)).toBe(1);
    expect((await call(app, 'GET', '/auth/me', { token: ta })).status).toBe(401);
    expect((await call(app, 'GET', '/auth/me', { token: tb })).status).toBe(200);
  });
});

describe('/auth/me', () => {
  it('returns identity and stable permission keys, never credentials', async () => {
    const app = await fx.makeApp();
    const tokens = await createRoleUsers(app, fx.orgId);
    const me = await call(app, 'GET', '/auth/me', { token: tokens['Warehouse Operator']! });
    expect(me.status).toBe(200);
    expect(me.json.user).toMatchObject({ username: 'warehouse.user', organizationId: fx.orgId });
    expect(me.json.permissions).toEqual(
      expect.arrayContaining(['inventory.pick', 'inventory.ship']),
    );
    expect(me.json.permissions).not.toContain('product.cost.read');
    expect([...me.json.permissions]).toEqual([...me.json.permissions].sort());
    expect(me.headers['cache-control']).toBe('no-store');
    expect(me.body).not.toMatch(/argon2|passwordHash|password_hash|tokenHash|token_hash/i);
    expect(ROLE_USERS).toHaveLength(5);
  });
});

describe('transparent rehash on login', () => {
  it('upgrades a hash made with weaker parameters and keeps the user able to log in', async () => {
    const weak = await fx.makeApp({
      auth: {
        allowWeakHashingForTests: true,
        config: { argon2: { memoryCost: 1024, timeCost: 1, parallelism: 1 } },
        clock: () => fx.clock.now,
      },
    });
    const u = await freshUser(weak, 'rehash.user');
    const before = await fx.prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(before.passwordHash).toContain('m=1024,t=1,p=1');

    const stronger = await fx.makeApp({
      auth: {
        allowWeakHashingForTests: true,
        config: { argon2: { memoryCost: 2048, timeCost: 2, parallelism: 1 } },
        clock: () => fx.clock.now,
      },
    });
    expect((await login(stronger, 'rehash.user')).status).toBe(200);
    const after = await fx.prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(after.passwordHash).toContain('m=2048,t=2,p=1');
    expect(after.passwordHash).not.toBe(before.passwordHash);
    expect(after.version).toBe(before.version + 1);
    expect((await login(stronger, 'rehash.user')).status).toBe(200); // new hash verifies
    expect(
      await fx.prisma.auditLog.count({ where: { action: 'auth.password.rehash', entityId: u.id } }),
    ).toBe(1);
    const audit = JSON.stringify(
      await fx.prisma.auditLog.findMany({ where: { action: 'auth.password.rehash' } }),
    );
    expect(audit).not.toContain('$argon2');
  });

  it('does not rehash when the password is wrong', async () => {
    const weak = await fx.makeApp({
      auth: {
        allowWeakHashingForTests: true,
        config: { argon2: FAST_ARGON2 },
        clock: () => fx.clock.now,
      },
    });
    const u = await freshUser(weak, 'norehash.user');
    const stronger = await fx.makeApp({
      auth: {
        allowWeakHashingForTests: true,
        config: { argon2: { memoryCost: 2048, timeCost: 2, parallelism: 1 } },
        clock: () => fx.clock.now,
      },
    });
    const before = (await fx.prisma.user.findUniqueOrThrow({ where: { id: u.id } })).passwordHash;
    await login(stronger, 'norehash.user', 'wrong password number 1');
    expect((await fx.prisma.user.findUniqueOrThrow({ where: { id: u.id } })).passwordHash).toBe(
      before,
    );
  });
});

describe('production Argon2id parameters end to end', () => {
  it('creates and verifies a user with the real default cost (ADR-0014)', async () => {
    const svc = await createAuthService({ prisma: fx.prisma, clock: () => fx.clock.now });
    const u = await svc.createUser({
      organizationId: fx.orgId,
      username: 'real.params',
      displayName: 'Real',
      password: PASSWORD,
      roleNames: ['Viewer/Auditor'],
    });
    const row = await fx.prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.passwordHash.startsWith('$argon2id$v=19$m=65536,t=4,p=1$')).toBe(true);
    const start = performance.now();
    const res = await svc.login({ username: 'real.params', password: PASSWORD });
    const ms = performance.now() - start;
    expect(res.ok).toBe(true);
    expect(ms).toBeLessThan(5000);
    expect(
      (await svc.login({ username: 'real.params', password: 'wrong password number 1' })).ok,
    ).toBe(false);
  });
});

describe('secrets never reach the logs', () => {
  it('passwords, tokens and Authorization headers are absent from structured logs at trace level', async () => {
    const lines: string[] = [];
    const app = await fx.makeApp({
      env: { LOG_LEVEL: 'trace' as never, WEB_ORIGIN: ['http://127.0.0.1:5173'] },
      logStream: { write: (m) => void lines.push(m) },
    });
    const uniquePassword = 'log-leak-check-passphrase-77';
    await app.authService!.createUser({
      organizationId: fx.orgId,
      username: 'log.user',
      displayName: 'Log',
      password: uniquePassword,
      roleNames: ['Viewer/Auditor'],
    });
    const ok = await login(app, 'log.user', uniquePassword);
    await login(app, 'log.user', 'another-wrong-passphrase-88');
    await call(app, 'GET', '/auth/me', { token: ok.json.token });
    await call(app, 'GET', '/auth/me', { token: 'Z'.repeat(43) }); // 401 path
    await call(app, 'POST', '/auth/logout', { token: ok.json.token });
    const hash = (await fx.prisma.user.findFirstOrThrow({ where: { username: 'log.user' } }))
      .passwordHash;

    const all = lines.join('\n');
    expect(all.length).toBeGreaterThan(100);
    for (const secret of [
      uniquePassword,
      'another-wrong-passphrase-88',
      ok.json.token,
      'Z'.repeat(43),
      LAUNCH_SECRET,
      hash,
      hash.slice(-30),
    ]) {
      expect(all, `log leaked ${secret.slice(0, 8)}...`).not.toContain(secret);
    }
  });
});
