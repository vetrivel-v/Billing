import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppLog, pruneLogs, redactText, rotateIfLarge, DEFAULT_LOG_POLICY } from './logger.js';
import {
  PathError,
  resolveDevResources,
  resolvePackagedResources,
  resolveRuntimePaths,
  validateDataDirOverride,
} from './paths.js';
import {
  SecretsError,
  generatePassword,
  loadSecrets,
  saveSecrets,
  type SecretCipher,
} from './secrets.js';
import { formatDiagnostics, type Diagnostics } from './diagnostics.js';
import { pruneSafetyBackups } from './upgrade.js';

const dir = mkdtempSync(join(tmpdir(), 'cb-rt-unit-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const cipher = (available = true): SecretCipher => ({
  available: () => available,
  encrypt: (p) => Buffer.from(`X${Buffer.from(p).toString('hex')}`),
  decrypt: (d) => {
    const s = d.toString();
    if (!s.startsWith('X')) throw new Error('not ours');
    return Buffer.from(s.slice(1), 'hex').toString();
  },
});

describe('data layout', () => {
  it('keeps every mutable thing under one data root outside the installation', () => {
    const p = resolveRuntimePaths({ env: {}, localAppData: 'C:\\Users\\Asha\\AppData\\Local' });
    expect(p.dataRoot).toBe('C:\\Users\\Asha\\AppData\\Local\\CommerceBill');
    for (const f of [
      p.pgData,
      p.configDir,
      p.logsDir,
      p.tmpDir,
      p.backupsDir,
      p.preUpgradeDir,
      p.runtimeJson,
      p.secretsFile,
      p.statusFile,
    ])
      expect(f.startsWith(p.dataRoot), f).toBe(true);
    expect(p.preUpgradeDir.startsWith(p.backupsDir)).toBe(true);
    // nothing mutable is ever placed in the application's own folders
    expect(p.dataRoot).not.toMatch(/Program Files|Programs\\CommerceBill|resources/i);
  });

  it('accepts only an absolute, local, clean override', () => {
    expect(
      resolveRuntimePaths({
        env: { COMMERCEBILL_DATA_DIR: 'D:\\CommerceBillData\\' },
        localAppData: 'C:\\x',
      }).dataRoot,
    ).toBe('D:\\CommerceBillData');
    for (const bad of [
      'relative\\dir',
      '..\\up',
      'C:\\a\\..\\b',
      '\\\\server\\share\\cb',
      '//server/share',
    ])
      expect(() => validateDataDirOverride(bad), bad).toThrow(PathError);
  });

  it('knows where the installed program and the repository keep the shipped pieces', () => {
    const r = resolvePackagedResources(
      'C:\\Users\\Asha\\AppData\\Local\\Programs\\CommerceBill\\resources',
    );
    expect(r.pgBin.endsWith('resources\\postgres\\bin')).toBe(true);
    expect(r.apiEntry.endsWith('resources\\api\\main.mjs')).toBe(true);
    expect(resolveDevResources('C:\\repo').migrationsDir).toBe('C:\\repo\\prisma\\migrations');
  });
});

describe('protected credentials', () => {
  it('round-trips, is not plain text on disk, and refuses unreadable or unavailable protection', () => {
    const file = join(dir, 'secrets.bin');
    const pw = generatePassword();
    expect(pw.length).toBeGreaterThanOrEqual(40);
    expect(pw).toMatch(/^[A-Za-z0-9_-]+$/); // safe inside a connection string
    expect(generatePassword()).not.toBe(pw);
    saveSecrets(file, { dbPassword: pw, safetyPassphrase: 'a-b-c' }, cipher());
    expect(readFileSync(file, 'latin1')).not.toContain(pw);
    expect(loadSecrets(file, cipher())).toEqual({ dbPassword: pw, safetyPassphrase: 'a-b-c' });
    expect(() => loadSecrets(join(dir, 'missing.bin'), cipher())).toThrow(SecretsError);
    expect(() => saveSecrets(file, { dbPassword: pw }, cipher(false))).toThrow(/protect/);
    writeFileSync(file, 'garbage');
    expect(() => loadSecrets(file, cipher())).toThrow(
      /different Windows account|could not be read/,
    );
    writeFileSync(file, cipher().encrypt(JSON.stringify({ dbPassword: 'short' })));
    expect(() => loadSecrets(file, cipher())).toThrow(SecretsError);
  });
});

describe('logs', () => {
  it('redacts registered secrets and connection-string passwords', () => {
    expect(redactText('token abcdef123456 and abcdef123456', ['abcdef123456'])).toBe(
      'token [REDACTED] and [REDACTED]',
    );
    expect(
      redactText('postgresql://commercebill_app:SuperSecretValue@127.0.0.1:5432/commercebill', []),
    ).toBe('postgresql://commercebill_app:[REDACTED]@127.0.0.1:5432/commercebill');
    const log = new AppLog(join(dir, 'logs-a'));
    log.addSecret('launch-secret-value-1234');
    log.info('started with launch-secret-value-1234');
    const text = readFileSync(join(dir, 'logs-a', 'app.log'), 'utf8');
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('launch-secret-value-1234');
  });

  it('rotates a large file, keeps a fixed number, and prunes old and surplus files so logs cannot grow without limit', () => {
    const d = join(dir, 'logs-b');
    const policy = {
      ...DEFAULT_LOG_POLICY,
      maxBytes: 100,
      keep: 2,
      maxAgeDays: 1,
      maxTotalBytes: 250,
    };
    new AppLog(d, 'app', policy);
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(d, 'app.log'), 'x'.repeat(150));
      rotateIfLarge(d, 'app', policy);
    }
    expect(readdirSync(d).sort()).toEqual(['app.1.log', 'app.2.log']); // never more than `keep` rotated files
    const old = new Date(Date.now() - 3 * 86_400_000);
    utimesSync(join(d, 'app.2.log'), old, old);
    expect(pruneLogs(d, policy)).toBe(1);
    expect(existsSync(join(d, 'app.2.log'))).toBe(false);
    writeFileSync(join(d, 'big.log'), 'y'.repeat(400));
    pruneLogs(d, policy);
    expect(statSync(d).isDirectory()).toBe(true);
    expect(readdirSync(d).reduce((n, f) => n + statSync(join(d, f)).size, 0)).toBeLessThanOrEqual(
      250,
    );
  });
});

describe('diagnostics text and safety backups', () => {
  const diag: Diagnostics = {
    generatedAt: '2026-10-22T10:00:00.000Z',
    application: { name: 'CommerceBill Desktop', version: '0.1.0' },
    windows: { version: 'Windows 11', release: '10.0.26200', arch: 'x64' },
    database: { running: true, port: 54321, install: 'existing' },
    schema: { current: '20261028000000_x', expected: '20261028000000_x', state: 'current' },
    api: { health: 'ok' },
    backup: { lastVerificationResult: 'PASS', lastVerifiedAt: '2026-10-21T10:00:00.000Z' },
    lastUpgrade: null,
    storage: {
      dataFolder: 'C:\\Users\\A\\AppData\\Local\\CommerceBill',
      logFolder: 'C:\\Users\\A\\AppData\\Local\\CommerceBill\\logs',
      freeMegabytes: 9000,
    },
    logs: [{ name: 'app.log', kilobytes: 3 }],
    startupProblem: null,
    managedDatabase: true,
  };
  it('reads like a support note and says what it leaves out', () => {
    const t = formatDiagnostics(diag);
    expect(t).toContain('CommerceBill Desktop 0.1.0');
    expect(t).toContain('127.0.0.1:54321 (this computer only)');
    expect(t).toContain('no passwords, passphrases, tokens or business data');
    expect(
      formatDiagnostics({
        ...diag,
        database: { running: false, port: null, install: 'unknown' },
        startupProblem: { code: 'DB_START_FAILED', message: 'x' },
      }),
    ).toContain('NOT running');
  });

  it('keeps only the newest safety backups', () => {
    const d = join(dir, 'pre');
    mkdtempSync(join(dir, 'pre-x'));
    for (let i = 0; i < 7; i++) {
      const f = join(dir, `pre-${String(i)}.cbbackup`);
      writeFileSync(f, 'x');
      const t = new Date(Date.now() - (10 - i) * 1000);
      utimesSync(f, t, t);
    }
    expect(pruneSafetyBackups(d, 5)).toBe(0); // a missing folder is not an error
    expect(pruneSafetyBackups(dir, 5)).toBe(2);
    expect(readdirSync(dir).filter((f) => f.endsWith('.cbbackup'))).toHaveLength(5);
    expect(existsSync(join(dir, 'pre-0.cbbackup'))).toBe(false);
  });
});
