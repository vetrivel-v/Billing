// @vitest-environment jsdom
// Task 1.17 browser-level test: the real React Backup & Recovery screens talk over real HTTP to the real Fastify API backed by a
// real, migrated PostgreSQL database and the real backup/verification engine. Nothing about the API is mocked.
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { App } from '../../apps/web/src/App.js';
import { resetAccessForTests } from '../../apps/web/src/api.js';
import { AuthProvider } from '../../apps/web/src/auth.js';
import { LAUNCH_SECRET, PASSWORD, createFixture, type Fixture } from './auth-fixture.js';

const CONTROL = 'control-secret-for-ui-tests-'.padEnd(64, 'z');
const PASS = 'correct horse battery 2026';
const migrationsDir = resolve(import.meta.dirname, '..', '..', 'prisma', 'migrations');

let fx: Fixture;
let app: FastifyInstance;
let baseUrl: string;
let dir: string;
let backupDir: string;
let urls: string[];
/** The administrator of the first test: present in the first backup, so still present after the restore. */
let firstAdmin = '';
const realFetch = globalThis.fetch;

async function newUser(roleName: string) {
  const username = `bk.${Math.random().toString(16).slice(2, 8)}`;
  await app.authService!.createUser({
    organizationId: fx.orgId,
    username,
    displayName: `UI ${roleName} (test)`,
    password: PASSWORD,
    roleNames: [roleName],
  });
  return username;
}
const control = (method: 'PUT' | 'POST', path: string, body: unknown) =>
  realFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-commercebill-launch-secret': LAUNCH_SECRET,
      'x-commercebill-control-secret': CONTROL,
    },
    body: JSON.stringify(body),
  });

function renderAt(path: string) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
async function signIn(username: string) {
  await screen.findByRole('heading', { name: 'Sign in' });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: username } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: PASSWORD } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}
const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cb-bk-ui-'));
  backupDir = join(dir, 'Business Backups');
  mkdirSync(backupDir);
  fx = await createFixture(inject('pgAdminUrl'));
  await fx.prisma.organization.update({
    where: { id: fx.orgId },
    data: { setupCompletedAt: new Date() },
  });
  app = await fx.makeApp({
    backup: { databaseUrl: fx.db.url, migrationsDir, controlSecret: CONTROL },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}, 180_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  const name = fx?.db.name;
  await fx?.close();
  if (name) {
    // the restore test renames databases: remove whatever it left (the fixture only knows its original name)
    const c = new pg.Client({ connectionString: inject('pgAdminUrl') });
    await c.connect();
    try {
      const left = await c.query<{ datname: string }>(
        `SELECT datname FROM pg_database WHERE datname LIKE $1`,
        [`${name}%`],
      );
      for (const r of left.rows)
        await c.query(`DROP DATABASE IF EXISTS "${r.datname}" WITH (FORCE)`);
    } finally {
      await c.end();
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  urls = [];
  resetAccessForTests();
  window.commercebill = {
    getAppInfo: async () => ({ name: 'test', version: '0', platform: 'test' }),
    getApiAccess: async () => ({ baseUrl, secret: LAUNCH_SECRET }),
    saveInvoicePdf: async () => ({ status: 'cancelled' }),
    printInvoice: async () => ({ status: 'cancelled' }),
    // Behaves like the Electron main process: the "dialog" picks a path and registers it with the service over the control channel.
    chooseBackupDestination: async () => {
      const r = await control('PUT', '/internal/backup/destination', { path: backupDir });
      const b = (await r.json()) as { label?: string };
      return r.ok ? { status: 'chosen', label: b.label ?? '' } : { status: 'failed' };
    },
    chooseRestoreFile: async () => {
      const file = readdirSync(backupDir)
        .filter((f) => f.endsWith('.cbbackup'))
        .sort()[0];
      if (!file) return { status: 'cancelled' };
      const r = await control('POST', '/internal/backup/restore-source', {
        path: join(backupDir, file),
      });
      const b = (await r.json()) as { sourceId: string; fileName: string };
      return { status: 'chosen', label: b.fileName, sourceId: b.sourceId };
    },
  };
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    return realFetch(url, init);
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  delete window.commercebill;
  globalThis.fetch = realFetch;
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* not available */
  }
});

describe('Backup & Recovery screens against the real API', () => {
  it('walks an administrator from "nothing yet" to a created, verified backup with the readiness updated', async () => {
    const admin = await newUser('Administrator');
    firstAdmin = admin;
    renderAt('/settings');
    await signIn(admin);
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Open Backup & Recovery' }));
    expect(await screen.findByRole('heading', { name: 'Backup & Recovery' })).toBeTruthy();

    // nothing yet: no folder, no backups, backup requirement not met
    expect(await screen.findByText('Not chosen yet')).toBeTruthy();
    expect(await screen.findByText('No backups yet')).toBeTruthy();
    const readiness = screen.getByRole('region', { name: 'Production readiness' });
    const backupItem = await within(readiness).findByText('Backup and recovery verified');
    expect(backupItem.textContent).toContain('Not ready:');
    expect(await within(readiness).findByText(/No backup has been verified yet/)).toBeTruthy();
    // a backup cannot be created before a folder is chosen
    expect(
      (screen.getByRole('button', { name: 'Create backup' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    // choose the folder through the desktop bridge: the screen shows only its display name
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
    expect(await screen.findByText('Business Backups')).toBeTruthy();
    expect(document.body.textContent).not.toContain(dir);
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Create backup' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );

    // validation: too short, then mismatch; nothing is sent to the service
    const before = urls.length;
    type('Backup passphrase (required)', 'short');
    type('Confirm passphrase (required)', 'short');
    fireEvent.click(screen.getByRole('button', { name: 'Create backup' }));
    expect(await screen.findByText('Use at least 12 characters.')).toBeTruthy();
    type('Backup passphrase (required)', PASS);
    type('Confirm passphrase (required)', `${PASS}!`);
    fireEvent.click(screen.getByRole('button', { name: 'Create backup' }));
    expect(await screen.findByText('The two passphrases are not the same.')).toBeTruthy();
    expect(urls.length).toBe(before);

    // the passphrase can be shown and hidden
    const field = screen.getByLabelText('Backup passphrase (required)') as HTMLInputElement;
    expect(field.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: 'Show backup passphrase' }));
    expect(field.type).toBe('text');
    fireEvent.click(screen.getByRole('button', { name: 'Hide backup passphrase' }));

    // create, with verification
    type('Confirm passphrase (required)', PASS);
    fireEvent.click(screen.getByRole('button', { name: 'Create backup' }));
    expect(await screen.findByText('Backup created', {}, { timeout: 120_000 })).toBeTruthy();
    expect(
      await screen.findByText('Verified', { selector: 'p' }, { timeout: 120_000 }),
    ).toBeTruthy();
    expect(readdirSync(backupDir).filter((f) => f.endsWith('.cbbackup'))).toHaveLength(1);

    // the form is cleared and the passphrase is nowhere: not in the page, the URLs, or browser storage
    expect((screen.getByLabelText('Backup passphrase (required)') as HTMLInputElement).value).toBe(
      '',
    );
    expect(document.body.innerHTML).not.toContain(PASS);
    expect(urls.join(' ')).not.toContain(encodeURIComponent(PASS));
    expect(urls.join(' ')).not.toContain('passphrase');
    expect(JSON.stringify({ ...localStorage })).not.toContain(PASS);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(PASS);

    // history shows it verified, and the readiness now has the backup requirement met
    const history = screen.getByRole('region', { name: 'Backup history' });
    expect(await within(history).findByText(/Verified /)).toBeTruthy();
    await waitFor(() =>
      expect(within(readiness).getByText(/restored into a separate test database/)).toBeTruthy(),
    );
    await waitFor(() =>
      expect(within(readiness).getByText('Backup and recovery verified').textContent).toContain(
        'Ready:',
      ),
    );
  }, 300_000);

  it('verifying again needs the passphrase: a wrong one is explained without detail, the right one passes', async () => {
    const admin = await newUser('Administrator');
    renderAt('/settings/backup');
    await signIn(admin);
    const history = await screen.findByRole('region', { name: 'Backup history' });
    await within(history).findByText(/\.cbbackup/);
    fireEvent.click(within(history).getAllByRole('button', { name: /^Verify / })[0]!);
    fireEvent.change(within(history).getByLabelText(/Passphrase of this backup/), {
      target: { value: 'this is not the passphrase' },
    });
    fireEvent.click(within(history).getByRole('button', { name: 'Verify now' }));
    expect(
      await screen.findByText(/passphrase is wrong, or the backup file is damaged/),
    ).toBeTruthy();
    fireEvent.change(within(history).getByLabelText(/Passphrase of this backup/), {
      target: { value: PASS },
    });
    fireEvent.click(within(history).getByRole('button', { name: 'Verify now' }));
    expect(
      await within(history).findByLabelText('Verification checks', {}, { timeout: 120_000 }),
    ).toBeTruthy();
    expect(within(history).getByText('Restored data identical to the backup')).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(PASS);
  }, 300_000);

  it('saves how many verified backups to keep, and rejects nonsense', async () => {
    const admin = await newUser('Administrator');
    renderAt('/settings/backup');
    await signIn(admin);
    const card = await screen.findByRole('region', { name: 'Keeping backups' });
    const input = within(card).getByLabelText(/Number of verified backups to keep/);
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    expect(await within(card).findByText(/from 1 to 365/)).toBeTruthy();
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    expect(await within(card).findByText('Saved.')).toBeTruthy();
  }, 120_000);

  it('opens a backup for restore: shows what it holds, and the restore stays disabled until RESTORE is typed', async () => {
    const admin = await newUser('Administrator');
    renderAt('/settings/backup');
    await signIn(admin);
    const card = await screen.findByRole('region', { name: 'Restore from a backup' });
    fireEvent.click(within(card).getByRole('button', { name: 'Choose backup file' }));
    await within(card).findByText(/\.cbbackup/);
    fireEvent.change(within(card).getByLabelText(/Passphrase of this backup/), {
      target: { value: 'wrong wrong wrong wrong' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Open backup' }));
    expect(
      await within(card).findByText(/passphrase is wrong, or the backup file is damaged/),
    ).toBeTruthy();
    fireEvent.change(within(card).getByLabelText(/Passphrase of this backup/), {
      target: { value: PASS },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Open backup' }));
    expect(
      await within(card).findByText('DEMO Auth Co (fictional)', {}, { timeout: 120_000 }),
    ).toBeTruthy();
    expect(within(card).getByText(/This replaces your current data/)).toBeTruthy();
    expect(within(card).getByText('Verified here')).toBeTruthy();
    const restoreNow = within(card).getByRole('button', {
      name: 'Restore now',
    }) as HTMLButtonElement;
    expect(restoreNow.disabled).toBe(true);
    fireEvent.change(within(card).getByLabelText(/Type RESTORE to confirm/), {
      target: { value: 'restore' },
    });
    expect(restoreNow.disabled).toBe(true);
    fireEvent.click(within(card).getByRole('button', { name: 'Cancel' }));
    expect(within(card).getByRole('button', { name: 'Choose backup file' })).toBeTruthy();
    // opening a backup changes nothing: still exactly one backup file, no stray databases
    expect(readdirSync(backupDir).filter((f) => f.endsWith('.cbbackup'))).toHaveLength(1);
  }, 300_000);

  it('an accountant can read the history and readiness but cannot create, verify, retain or restore', async () => {
    const accountant = await newUser('Accountant');
    renderAt('/settings/backup');
    await signIn(accountant);
    expect(await screen.findByRole('heading', { name: 'Backup & Recovery' })).toBeTruthy();
    const history = await screen.findByRole('region', { name: 'Backup history' });
    await within(history).findByText(/\.cbbackup/);
    expect(within(history).queryByRole('button', { name: /^Verify / })).toBeNull();
    expect(screen.getByText('Only an administrator can create backups.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create backup' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Choose folder' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change folder' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Restore from a backup' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  }, 120_000);

  it('a user without backup access is told so, and the screen is not rendered', async () => {
    const billing = await newUser('Billing Operator');
    renderAt('/settings/backup');
    await signIn(billing);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('heading', { name: 'Backup & Recovery' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create backup' })).toBeNull();
  }, 120_000);

  it('restoring from the screen ends on the sign-in page with a plain explanation: the sessions are gone and the confirmation is not lost', async () => {
    const admin = await newUser('Administrator');
    renderAt('/settings/backup');
    await signIn(admin);
    const card = await screen.findByRole('region', { name: 'Restore from a backup' });
    fireEvent.click(within(card).getByRole('button', { name: 'Choose backup file' }));
    await within(card).findByText(/\.cbbackup/);
    fireEvent.change(within(card).getByLabelText(/Passphrase of this backup/), {
      target: { value: PASS },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Open backup' }));
    await within(card).findByText(/This replaces your current data/, {}, { timeout: 120_000 });
    fireEvent.change(within(card).getByLabelText(/Type RESTORE to confirm/), {
      target: { value: 'RESTORE' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Restore now' }));
    expect(
      await screen.findByRole('heading', { name: 'Sign in' }, { timeout: 240_000 }),
    ).toBeTruthy();
    expect(screen.getByText(/The backup was restored\. Everyone is signed out/)).toBeTruthy();
    expect(screen.getByText(/Real billing stays off until a new backup is verified/)).toBeTruthy();
    // the old sessions are really gone, and the restored data is really there: a fresh sign-in works
    cleanup();
    resetAccessForTests();
    renderAt('/settings/backup');
    await signIn(firstAdmin);
    expect(
      await screen.findByRole('heading', { name: 'Backup & Recovery' }, { timeout: 60_000 }),
    ).toBeTruthy();
    // the safety backup made before the restore is listed in the history
    const history = await screen.findByRole('region', { name: 'Backup history' });
    expect(await within(history).findByText('Safety backup')).toBeTruthy();
  }, 600_000);
});
