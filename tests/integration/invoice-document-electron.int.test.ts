// Task 1.15 (R-090): production-like check of the document flow in the REAL Electron renderer served from app://, against the
// REAL API and database. Fictional data; a database of its own (the desktop login picks the single organization).
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PASSWORD, createFixture, createRoleUsers, type Fixture } from './auth-fixture.js';
import { body, previewAndPost, setupBillingWorld, type BillingWorld } from './invoice-fixture.js';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const desktopDir = resolve(repoRoot, 'apps', 'desktop');
let fx: Fixture;
let app: FastifyInstance;
let tokens: Record<string, string>;
let w: BillingWorld;
let tmp: string;
let electronPath: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'cb-doc-'));
  electronPath = createRequire(import.meta.url)('electron') as string;
  fx = await createFixture(inject('pgAdminUrl'));
  app = await fx.makeApp();
  tokens = await createRoleUsers(app, fx.orgId);
  w = await setupBillingWorld(fx);
}, 400_000);

afterAll(async () => {
  rmSync(tmp, { recursive: true, force: true });
  await fx?.close();
});

const post = async (lines: { productId: string; quantity: string }[]) => {
  const r = await previewAndPost(app, tokens['Administrator']!, body(w, {}, lines));
  expect(r.post.status).toBe(201);
};

describe('production-like Electron: the real screens, real IPC, real API and database', () => {
  it('sign in, open an invoice, Preview / Print, Save PDF and Print run end to end in the Electron renderer (native dialogs replaced, no printer)', async () => {
    // the shell loads the built bundles
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
    await post([{ productId: w.products.untracked, quantity: '2' }]);
    const saveDir = join(tmp, 'saved');
    mkdirSync(saveDir);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_DOC_SMOKE: '1',
      DATABASE_URL: fx.db.url,
      ELECTRON_SMOKE_USER: 'admin.user',
      ELECTRON_SMOKE_PASSWORD: PASSWORD, // the fictional test credential of this test database
      ELECTRON_SMOKE_SAVE_DIR: saveDir,
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
          rej(
            new Error(`doc smoke timed out
${stdout}
${stderr}`),
          );
        }, 150_000);
        c.on('close', (status) => {
          clearTimeout(t);
          res({ status, stdout, stderr });
        });
      },
    );
    expect(
      r.status,
      `${r.stdout}
${r.stderr}`,
    ).toBe(0);
    const line = r.stdout.split('\n').find((l) => l.startsWith('DOC_SMOKE_RESULT '));
    expect(line, r.stdout + r.stderr).toBeTruthy();
    const out = JSON.parse(line!.slice('DOC_SMOKE_RESULT '.length)) as Json;
    expect(out.listRows).toBeGreaterThan(0);
    expect(out.listDemoBadge).toBe(true);
    expect(out.detailHeading).toMatch(/^Invoice DEMO\//);
    expect(out.detailDemoAlert).toBe(true);
    expect(out.detailEditControls).toBe(0);
    expect(out.previewSandbox).toBe('');
    expect(out.previewWatermark).toBe(true);
    expect(out.previewHasNumber).toBe(true);
    expect(out.saveMessage).toBe('The PDF was saved.');
    expect(out.printMessage).toBe('The invoice was sent to the printer.');
    expect(out.nodeExposed).toBe(false);
    expect(out.bodyShowsPath).toBe(false);
    expect(out.savedFiles).toHaveLength(1);
    expect(out.savedFiles[0]).toMatch(/^DEMO-2026-27-\d{6}\.pdf$/);
    expect(out.savedIsPdf).toBe(true);
    expect(out.savedPages).toBe(1);
    // nothing but the PDF was written
    expect(readdirSync(saveDir)).toEqual(out.savedFiles);
    // the shell's output carries no invoice content
    expect(r.stdout.replace(line!, '') + r.stderr).not.toMatch(/Walk-in|Market Road|27ABCDE/);
  }, 400_000);
});
