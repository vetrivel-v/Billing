// Task 1.17 (item 24): production-like check of Backup & Recovery in the REAL Electron renderer served from app://, against the REAL API
// and database, with the real IPC and control channel. Only the two NATIVE dialogs are replaced (hooks); everything else is real.
// Fictional data; a database of its own. No physical external drive is involved, and none is claimed.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PASSWORD, createFixture, createRoleUsers, type Fixture } from './auth-fixture.js';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const desktopDir = resolve(repoRoot, 'apps', 'desktop');
const PASS = 'electron smoke passphrase 2026';
let fx: Fixture;
let tmp: string;
let electronPath: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'cb-bk-el-'));
  electronPath = createRequire(import.meta.url)('electron') as string;
  fx = await createFixture(inject('pgAdminUrl'));
  await fx.prisma.organization.update({
    where: { id: fx.orgId },
    data: { setupCompletedAt: new Date() },
  });
  const app = await fx.makeApp();
  await createRoleUsers(app, fx.orgId);
}, 400_000);

afterAll(async () => {
  rmSync(tmp, { recursive: true, force: true });
  await fx?.close();
});

describe('production-like Electron: the real Backup & Recovery screens, real IPC, real API and database', () => {
  it('chooses a folder, creates and verifies an encrypted backup, and opens it for restore, all in the Electron renderer', async () => {
    const build = await new Promise<{ status: number | null; out: string }>((res, rej) => {
      const c = spawn(
        'npm run build -w @commercebill/api -w @commercebill/web -w @commercebill/desktop',
        [],
        { cwd: repoRoot, shell: true, windowsHide: true },
      );
      let out = '';
      c.stdout.on('data', (d: Buffer) => (out += d.toString()));
      c.stderr.on('data', (d: Buffer) => (out += d.toString()));
      c.on('error', rej);
      c.on('close', (status) => res({ status, out }));
    });
    expect(build.status, build.out).toBe(0);
    const dir = join(tmp, 'Business Backups');
    mkdirSync(dir);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_BACKUP_SMOKE: '1',
      DATABASE_URL: fx.db.url,
      ELECTRON_SMOKE_USER: 'admin.user',
      ELECTRON_SMOKE_PASSWORD: PASSWORD, // the fictional test credential of this test database
      ELECTRON_SMOKE_BACKUP_DIR: dir,
      ELECTRON_SMOKE_BACKUP_PASSPHRASE: PASS,
      LOG_LEVEL: 'info',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (res, rej) => {
        const c = spawn(electronPath, ['.'], { cwd: desktopDir, env, windowsHide: true });
        let stdout = '';
        let stderr = '';
        c.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
        c.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
        const t = setTimeout(() => {
          c.kill();
          rej(new Error(`backup smoke timed out\n${stdout}\n${stderr}`));
        }, 280_000);
        c.on('close', (status) => {
          clearTimeout(t);
          res({ status, stdout, stderr });
        });
      },
    );
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const line = r.stdout.split('\n').find((l) => l.startsWith('BACKUP_SMOKE_RESULT '));
    expect(line, r.stdout + r.stderr).toBeTruthy();
    const out = JSON.parse(line!.slice('BACKUP_SMOKE_RESULT '.length)) as Json;
    expect(out.bridgeKeys).toEqual([
      'chooseBackupDestination',
      'chooseRestoreFile',
      'getApiAccess',
      'getAppInfo',
      'printInvoice',
      'saveInvoicePdf',
    ]);
    expect(out.noFolderYet).toBe(true);
    expect(out.folderLabelShown).toBe(true);
    expect(out.bodyShowsPath).toBe(false); // the screen shows the folder's name, never its path
    expect(out.created).toBe(true);
    expect(out.verified).toBe(true);
    expect(out.passphraseFieldCleared).toBe(true);
    expect(out.passphraseInPage).toBe(false);
    expect(out.restoreOpened).toBe(true);
    expect(out.restoreButtonDisabled).toBe(true); // nothing restores without typing RESTORE
    expect(out.restoreFileShown).toMatch(/^CommerceBill-.*\.cbbackup$/);
    expect(out.nodeExposed).toBe(false);
    expect(out.bodyShowsPathAfter).toBe(false);
    expect(out.passphraseInApiOutput).toBe(false);
    expect(out.controlSecretInApiOutput).toBe(false);
    // exactly one backup file was written, and nothing else
    expect(out.files).toHaveLength(1);
    expect(readdirSync(dir)).toEqual(out.files);
    expect(statSync(join(dir, out.files[0])).size).toBeGreaterThan(1000);
    // neither the shell's output nor its errors carry the passphrase
    expect(r.stdout.replace(line!, '') + r.stderr).not.toContain(PASS);
  }, 400_000);
});
