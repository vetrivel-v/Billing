import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, inject, it } from 'vitest';
import pg from 'pg';

const dir = resolve(import.meta.dirname, '..', '..', 'prisma', 'migrations');
const NEW = '20261028000000_task_1_17_backup_recovery';
const all = readdirSync(dir)
  .filter((d) => /^\d{14}_/.test(d))
  .sort();
const previous = all
  .filter((d) => d < NEW)
  .map((d) => readFileSync(resolve(dir, d, 'migration.sql'), 'utf8'));
const m17 = readFileSync(resolve(dir, NEW, 'migration.sql'), 'utf8');

const cleanup: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const f of cleanup.reverse()) await f();
});

async function rawDb() {
  const adminUrl = inject('pgAdminUrl');
  const name = `cb_mig_${Math.random().toString(16).slice(2, 10)}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  cleanup.push(async () => {
    const a = new pg.Client({ connectionString: adminUrl });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await a.end();
  });
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  cleanup.push(() => c.end());
  for (const m of previous) await c.query(m);
  return c;
}
const one = async (c: pg.Client, q: string, p: unknown[] = []) =>
  (await c.query(q, p)).rows[0].id as string;

async function seed(c: pg.Client) {
  const org = await one(
    c,
    `INSERT INTO organizations (legal_name, setup_completed_at, updated_at) VALUES ('Populated Co (fictional)', now(), now()) RETURNING id`,
  );
  const user = await one(
    c,
    `INSERT INTO users (organization_id, username, display_name, password_hash, updated_at)
     VALUES ($1, 'u' || floor(random() * 1000000000)::text, 'A User', '$argon2id$placeholder', now()) RETURNING id`,
    [org],
  );
  return { org, user };
}
const FP = 'a'.repeat(64);
const record = (
  c: pg.Client,
  org: string,
  user: string,
  db: string,
  file = 'CommerceBill-x.cbbackup',
) =>
  one(
    c,
    `INSERT INTO backup_records (organization_id, kind, file_name, size_bytes, app_version, schema_version, backup_format, database_id, manifest_sha256, created_by)
     VALUES ($1, 'MANUAL', $4, 1000, '0.0.1', 'v', 1, $3, $5, $2) RETURNING id`,
    [org, user, db, file, FP],
  );
const DB1 = '11111111-1111-4111-8111-111111111111';

describe('migration 20261028000000_task_1_17_backup_recovery', () => {
  it('upgrades a populated Task 1.16 database without touching existing rows, and adds two empty append-only tables', async () => {
    const c = await rawDb();
    const { org } = await seed(c);
    const before = (await c.query(`SELECT * FROM organizations`)).rows;
    await c.query(m17);
    expect((await c.query(`SELECT * FROM organizations`)).rows).toEqual(before);
    for (const t of ['backup_records', 'backup_verifications'])
      expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n).toBe(0);
    const cols = (
      await c.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'backup_records' ORDER BY 1`,
      )
    ).rows.map((r) => r.column_name as string);
    expect(cols).toEqual(
      expect.arrayContaining([
        'seq',
        'file_name',
        'manifest_sha256',
        'database_id',
        'file_deleted_at',
      ]),
    );
    // nothing that could hold a secret or a path
    expect(cols.join(' ')).not.toMatch(/passphrase|password|key|salt|path/);
    expect(org).toBeTruthy();
  });

  it('validates values, keeps history append-only, and orders by a monotonic sequence', async () => {
    const c = await rawDb();
    await c.query(m17);
    const { org, user } = await seed(c);
    const id = await record(c, org, user, DB1);
    const ids = [id, await record(c, org, user, DB1, 'CommerceBill-y.cbbackup')];
    const seqs = (await c.query(`SELECT seq::int AS s FROM backup_records ORDER BY seq`)).rows.map(
      (r) => r.s,
    );
    expect(seqs[1]).toBeGreaterThan(seqs[0]);

    // history carried into a restored database may have no author there (the person was created after the backup): NULL, never a guess
    const orphan = await c.query(
      `INSERT INTO backup_records (organization_id, kind, file_name, size_bytes, app_version, schema_version, backup_format, database_id, manifest_sha256, created_by)
       VALUES ($1, 'PRE_RESTORE', 'CommerceBill-orphan.cbbackup', 1000, '0.0.1', 'v', 1, $2, $3, NULL) RETURNING id`,
      [org, DB1, FP],
    );
    expect(orphan.rows[0].id).toBeTruthy();
    // value rules
    for (const bad of ['../x.cbbackup', 'x.zip', 'a/b.cbbackup', '.hidden.cbbackup'])
      await expect(record(c, org, user, DB1, bad), bad).rejects.toThrow(
        /backup_records_file_name_form/,
      );
    await expect(
      c.query(`UPDATE backup_records SET kind = 'AUTO' WHERE false`),
    ).resolves.toBeDefined(); // no row, no trigger; the CHECK is exercised through insert below
    await expect(
      c.query(
        `INSERT INTO backup_records (organization_id, kind, file_name, size_bytes, app_version, schema_version, backup_format, database_id, manifest_sha256, created_by)
         VALUES ($1, 'AUTO', 'a.cbbackup', 1, 'v', 'v', 1, $3, $4, $2)`,
        [org, user, DB1, FP],
      ),
    ).rejects.toThrow(/backup_records_kind_valid/);
    await expect(
      c.query(
        `INSERT INTO backup_records (organization_id, kind, file_name, size_bytes, app_version, schema_version, backup_format, database_id, manifest_sha256, created_by)
         VALUES ($1, 'MANUAL', 'a.cbbackup', 1, 'v', 'v', 1, $3, 'not-a-hash', $2)`,
        [org, user, DB1],
      ),
    ).rejects.toThrow(/backup_records_manifest_form/);

    // records change only by the one-time removal mark
    await expect(
      c.query(`UPDATE backup_records SET size_bytes = 5 WHERE id = $1`, [id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      c.query(`UPDATE backup_records SET file_name = 'z.cbbackup' WHERE id = $1`, [id]),
    ).rejects.toThrow(/immutable/);
    await expect(c.query(`DELETE FROM backup_records WHERE id = $1`, [id])).rejects.toThrow(
      /immutable/,
    );
    await expect(c.query(`TRUNCATE backup_records CASCADE`)).rejects.toThrow(/immutable/);
    await c.query(`UPDATE backup_records SET file_deleted_at = now() WHERE id = $1`, [id]);
    await expect(
      c.query(`UPDATE backup_records SET file_deleted_at = NULL WHERE id = $1`, [id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      c.query(`UPDATE backup_records SET file_deleted_at = now() WHERE id = $1`, [id]),
    ).rejects.toThrow(/immutable/);

    // verifications: PASS/FAIL only, tied to the database identity of the backup, never changed or deleted
    const verify = (backup: string, db: string, result = 'PASS') =>
      c.query(
        `INSERT INTO backup_verifications (organization_id, backup_id, result, engine_version, schema_version, database_id, details, verified_by)
         VALUES ($1, $2, $5, '1.0.0', 'v', $3, '{}'::jsonb, $4) RETURNING id`,
        [org, backup, db, user, result],
      );
    await expect(verify(ids[1]!, '22222222-2222-4222-8222-222222222222')).rejects.toThrow(
      /database identity/,
    );
    await expect(verify(ids[1]!, DB1, 'MAYBE')).rejects.toThrow(
      /backup_verifications_result_valid/,
    );
    const v = (await verify(ids[1]!, DB1)).rows[0].id as string;
    await expect(
      c.query(`UPDATE backup_verifications SET result = 'FAIL' WHERE id = $1`, [v]),
    ).rejects.toThrow(/immutable/);
    await expect(c.query(`DELETE FROM backup_verifications WHERE id = $1`, [v])).rejects.toThrow(
      /immutable/,
    );
    await expect(c.query(`TRUNCATE backup_verifications`)).rejects.toThrow(/immutable/);
  });

  it('refuses records and verifications that point at another organization', async () => {
    const c = await rawDb();
    await c.query(m17);
    const a = await seed(c);
    const b = await seed(c);
    await expect(record(c, a.org, b.user, DB1)).rejects.toThrow(/another organization/);
    const id = await record(c, a.org, a.user, DB1);
    await expect(
      c.query(
        `INSERT INTO backup_verifications (organization_id, backup_id, result, engine_version, schema_version, database_id, details, verified_by)
         VALUES ($1, $2, 'PASS', '1', 'v', $3, '{}'::jsonb, $4)`,
        [b.org, id, DB1, b.user],
      ),
    ).rejects.toThrow();
  });
});
