// Windows packaging: the REAL installer artifact, installed, run, closed, uninstalled and reinstalled on this computer (per-user, no
// elevation). The business data of the run lives in a throw-away folder (COMMERCEBILL_DATA_DIR), never in the user's own CommerceBill
// folder. Start Menu and Desktop shortcuts and the uninstall entry ARE created for the current user by the installer, and removed again by
// the uninstaller; a failed run is cleaned up in afterAll. A window appears on the desktop while the application runs, as for a person.
// What this cannot do: operate the native Windows dialogs, a printer or a removable drive, or run on another computer (see the manual
// laptop acceptance checklist).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  allProcesses,
  canConnect,
  closeGracefully,
  descendants,
  installSilently,
  killAllUnder,
  lanAddresses,
  launch,
  listeningAddresses,
  processesUnder,
  ps,
  readStatus,
  removeDir,
  shortcutTarget,
  sleep,
  uninstallEntries,
  uninstallSilently,
  visibleWindows,
  waitFor,
} from './winhelp.js';

const repo = resolve(import.meta.dirname, '..', '..');
const releaseDir = join(repo, 'release');
let work: string;
let installDir: string;
let dataDir: string;
let exe: string;
let installer: string;
let info: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let firstClusterId: string;
const status = () => readStatus(join(dataDir, 'config', 'runtime-status.json'));
/** What was happening when a wait ran out: log tails and the processes of this installation (the data folder is deleted afterwards). */
function evidence(): string {
  const tail = (f: string) => {
    try {
      return readFileSync(join(dataDir, 'logs', f), 'utf8')
        .split(String.fromCharCode(10))
        .slice(-25)
        .join(String.fromCharCode(10));
    } catch {
      return '(none)';
    }
  };
  const procs = processesUnder(installDir)
    .map((r) => `${String(r.pid)} ${r.name}`)
    .join(', ');
  return `status: ${JSON.stringify(status())}
processes: ${procs || '(none)'}
--- app.log
${tail('app.log')}
--- postgres.log
${tail('postgres.log')}`;
}
const waitDiag = <T>(what: string, fn: () => T | undefined | false, ms?: number) =>
  waitFor(what, fn, ms, 500, evidence);
const desktop = () => ps("[Environment]::GetFolderPath('Desktop')");
const startMenuLnk = () =>
  join(process.env.APPDATA!, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'CommerceBill.lnk');

beforeAll(() => {
  if (
    !existsSync(join(releaseDir, 'installer-info.json')) ||
    JSON.parse(readFileSync(join(releaseDir, 'installer-info.json'), 'utf8')).installer === null
  ) {
    execFileSync('npm', ['run', 'package:win'], { cwd: repo, stdio: 'inherit', shell: true });
  }
  info = JSON.parse(readFileSync(join(releaseDir, 'installer-info.json'), 'utf8'));
  installer = join(releaseDir, info.installer);
  work = mkdtempSync(join(tmpdir(), 'cb-installer-'));
  installDir = join(work, 'cbinstall'); // no spaces: the installer's /D= argument cannot be quoted
  dataDir = join(work, 'cbdata');
  exe = join(installDir, 'CommerceBill.exe');
  // a previous interrupted run may have left this user's shortcut or uninstall entry: refuse to continue over a real installation
  if (uninstallEntries().length > 0)
    throw new Error(
      'CommerceBill is already installed for this Windows user: uninstall it first, then run this check.',
    );
});

afterAll(async () => {
  killAllUnder(installDir);
  await uninstallSilently(installDir);
  removeDir(work);
  // the check must leave this computer as it found it
  expect(uninstallEntries()).toEqual([]);
  expect(existsSync(startMenuLnk())).toBe(false);
  expect(existsSync(join(desktop(), 'CommerceBill.lnk'))).toBe(false);
});

describe('the installer artifact', () => {
  it('is the file the packager recorded: name, version, size, checksum, and honestly unsigned without a certificate', () => {
    const desktopVersion = JSON.parse(
      readFileSync(join(repo, 'apps', 'desktop', 'package.json'), 'utf8'),
    ).version as string;
    expect(info.version).toBe(desktopVersion);
    expect(info.installer).toBe(`CommerceBill-Setup-${desktopVersion}.exe`);
    expect(statSync(installer).size).toBe(info.sizeBytes);
    expect(createHash('sha256').update(readFileSync(installer)).digest('hex')).toBe(info.sha256);
    expect(statSync(installer).size).toBeGreaterThan(50 * 1024 * 1024);
    const sig = ps(`(Get-AuthenticodeSignature -LiteralPath '${installer}').Status`);
    expect(info.signed).toBe(false);
    expect(sig).toBe('NotSigned'); // no certificate was provided, and none was faked
    const version = ps(`(Get-Item -LiteralPath '${installer}').VersionInfo.FileVersion`);
    expect(version).toContain(desktopVersion);
  });
});

describe('install, run, close, uninstall, reinstall (real installer)', () => {
  it('installs for the current user without elevation: program files, shortcuts and an uninstall entry; no business data in the program folder', () => {
    const elevated = ps(
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    );
    expect(elevated).toBe('False'); // the installer ran with the rights of an ordinary user and still succeeded
    installSilently(installer, installDir);
    for (const f of [
      'CommerceBill.exe',
      'Uninstall CommerceBill.exe',
      'resources/app.asar',
      'resources/postgres/bin/postgres.exe',
      'resources/postgres/bin/initdb.exe',
      'resources/postgres/bin/pg_ctl.exe',
      'resources/postgres/bin/vcruntime140.dll',
      'resources/postgres/bin/vcruntime140_1.dll',
      'resources/postgres/bin/msvcp140.dll',
      'resources/api/main.mjs',
      'resources/web/index.html',
      'resources/licenses/THIRD_PARTY_NOTICES.txt',
    ])
      expect(existsSync(join(installDir, f)), f).toBe(true);
    expect(
      readdirSync(join(installDir, 'resources', 'migrations')).filter((n) => /^\d{14}_/.test(n))
        .length,
    ).toBeGreaterThan(10);
    // nothing a person or a developer should not find in an installation
    const all = readdirSync(installDir, { recursive: true, encoding: 'utf8' });
    expect(
      all.filter((f) => /\.(map|env|cbbackup|dump|ts|tsx)$|schema\.prisma$|^\.git/.test(f)),
    ).toEqual([]);
    expect(all.some((f) => /(^|[\\/])(data|pg-dev|\.data)[\\/]/i.test(f))).toBe(false); // no database inside the installation
    // the program is in an archive that holds only the shell
    const asar = ps(
      `& '${join(repo, 'node_modules', '.bin', 'asar.cmd')}' list '${join(installDir, 'resources', 'app.asar')}' 2>$null`,
    ).split(/\r?\n/);
    expect(
      asar.filter((l) => l && !/main\.cjs|preload\.cjs|package\.json|node_modules/.test(l)),
    ).toEqual([]);
    // shortcuts launch the program directly: no terminal, no Node, no npm, no PowerShell
    for (const lnk of [startMenuLnk(), join(desktop(), 'CommerceBill.lnk')]) {
      const t = shortcutTarget(lnk);
      expect(t, lnk).not.toBeNull();
      expect(t!.target.toLowerCase()).toBe(exe.toLowerCase());
      expect(t!.args).toBe('');
    }
    expect(uninstallEntries()).toHaveLength(1);
    expect(uninstallEntries()[0]!.location.toLowerCase()).toContain('cbinstall');
    // no Windows Firewall rule for CommerceBill was created: nothing needs an inbound exception
    const rules = ps(
      `Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -like '${installDir.replace(/'/g, "''")}*' } | Measure-Object | Select-Object -ExpandProperty Count`,
    );
    expect(Number(rules || '0')).toBe(0);
  }, 600_000);

  it('first launch: private database created on this computer only, service up, no console window, second launch brings the first forward', async () => {
    const child = launch(exe, { COMMERCEBILL_DATA_DIR: dataDir });
    const st = await waitDiag(
      'the application to be running',
      () => {
        const s = status();
        return s && s.state === 'running' ? s : undefined;
      },
      180_000,
    );
    expect(st.install).toBe('fresh');
    expect(st.appVersion).toBe(info.version);
    firstClusterId = st.clusterId as string;
    expect(firstClusterId).toMatch(/^[0-9a-f-]{36}$/);
    const mainPid = st.mainPid as number;
    expect(child.pid).toBeDefined();
    // data layout outside the installation
    for (const d of [
      'data/pg/PG_VERSION',
      'config/runtime.json',
      'config/secrets.bin',
      'config/runtime-status.json',
      'logs/app.log',
      'logs/postgres.log',
      'logs/api.log',
      'backups',
    ])
      expect(existsSync(join(dataDir, d)), d).toBe(true);
    expect(readFileSync(join(dataDir, 'config', 'secrets.bin')).toString('latin1')).not.toMatch(
      /postgresql:|password/i,
    ); // protected, not plain text
    // what is running: only the application and its private PostgreSQL; no terminal of any kind
    const rows = allProcesses();
    const tree = descendants(mainPid, rows);
    const names = new Set(tree.map((r) => r.name.toLowerCase()));
    // (a windowless console host for the database is the only helper Windows adds; there is no cmd, PowerShell, node or npm)
    expect(
      [...names].filter((n) => !['commercebill.exe', 'postgres.exe', 'conhost.exe'].includes(n)),
    ).toEqual([]);
    for (const r of tree.filter((x) => x.name.toLowerCase() === 'conhost.exe'))
      expect(tree.find((x) => x.pid === r.parent)?.name.toLowerCase()).toBe('postgres.exe');
    // the only visible window is CommerceBill's own: nothing from the database, nothing console-like
    const windows = visibleWindows([mainPid, ...tree.map((r) => r.pid)]);
    expect(windows.filter((w) => !/^Chrome_WidgetWin/.test(w))).toEqual([]);
    expect(windows.length).toBeGreaterThanOrEqual(1);
    expect(tree.some((r) => r.name.toLowerCase() === 'postgres.exe')).toBe(true);
    // the database and the service listen on 127.0.0.1 only; another device on the network cannot connect
    const pids = [mainPid, ...tree.map((r) => r.pid)];
    const listeners = listeningAddresses(pids);
    expect(listeners.length).toBeGreaterThanOrEqual(2);
    for (const l of listeners)
      expect(l.address, `pid ${String(l.pid)} port ${String(l.port)}`).toBe('127.0.0.1');
    const pgPort = st.databasePort as number;
    expect(await canConnect('127.0.0.1', pgPort)).toBe(true);
    for (const ip of lanAddresses()) {
      expect(await canConnect(ip, pgPort), `database via ${ip}`).toBe(false);
      expect(await canConnect(ip, st.apiPort as number), `service via ${ip}`).toBe(false);
    }
    // logs: written, and never carrying a connection password
    const logText = ['app', 'api', 'postgres']
      .map((n) => readFileSync(join(dataDir, 'logs', `${n}.log`), 'utf8'))
      .join('\n');
    expect(logText).not.toMatch(/postgresql:\/\/[^:\s]+:(?!\[REDACTED\])[^@\s]+@/);
    // a second launch does not start a second copy: it ends, and the first keeps running
    const second = launch(exe, { COMMERCEBILL_DATA_DIR: dataDir });
    await waitDiag(
      'the second launch to end',
      () =>
        second.exitCode !== null || !allProcesses().some((r) => r.pid === second.pid)
          ? true
          : undefined,
      60_000,
    );
    expect(allProcesses().some((r) => r.pid === mainPid)).toBe(true);
    expect(
      allProcesses().filter(
        (r) =>
          r.path &&
          r.path.toLowerCase() === exe.toLowerCase() &&
          r.parent !== mainPid &&
          r.pid !== mainPid &&
          /commercebill\.exe/i.test(r.name) &&
          !descendants(mainPid, allProcesses()).some((d) => d.pid === r.pid),
      ),
    ).toEqual([]);
    expect(status()!.mainPid).toBe(mainPid);
  }, 400_000);

  it('closing the window stops the service and the database cleanly and leaves nothing running', async () => {
    const mainPid = status()!.mainPid as number;
    await closeGracefully(mainPid, 90_000, evidence);
    await waitDiag(
      'every process to end',
      () => (processesUnder(installDir).length === 0 ? true : undefined),
      60_000,
    );
    expect(status()!.state).toBe('stopped');
    expect(existsSync(join(dataDir, 'data', 'pg', 'postmaster.pid'))).toBe(false); // PostgreSQL removes it only on a clean shutdown
    expect(readFileSync(join(dataDir, 'logs', 'postgres.log'), 'utf8')).toMatch(
      /database system is shut down/,
    );
    expect(readFileSync(join(dataDir, 'logs', 'app.log'), 'utf8')).toMatch(
      /database stopped cleanly/,
    );
  }, 200_000);

  it('opens again on the same data: the same database is found, not a new one', async () => {
    launch(exe, { COMMERCEBILL_DATA_DIR: dataDir });
    const st = await waitDiag(
      'the application to be running again',
      () => {
        const s = status();
        return s && s.state === 'running' && s.install === 'existing' ? s : undefined;
      },
      180_000,
    );
    expect(st.clusterId).toBe(firstClusterId);
    await closeGracefully(st.mainPid as number, 90_000, evidence);
    await waitDiag(
      'every process to end',
      () => (processesUnder(installDir).length === 0 ? true : undefined),
      60_000,
    );
  }, 400_000);

  it('after the application is killed (no clean shutdown): its service ends by itself, and the next launch recovers the database', async () => {
    launch(exe, { COMMERCEBILL_DATA_DIR: dataDir });
    const st = await waitDiag(
      'running',
      () => {
        const s = status();
        return s && s.state === 'running' && s.startedAt !== undefined ? s : undefined;
      },
      180_000,
    );
    const before = new Set(
      descendants(st.mainPid as number)
        .filter((r) => /commercebill\.exe/i.test(r.name))
        .map((r) => r.pid),
    );
    expect(before.size).toBeGreaterThan(0);
    execFileSync('taskkill', ['/F', '/PID', String(st.mainPid)], { windowsHide: true }); // the main process only: the service and the database are left behind
    await waitDiag(
      'the orphaned service to end by itself',
      () => ([...before].every((p) => !allProcesses().some((r) => r.pid === p)) ? true : undefined),
      60_000,
    );
    await sleep(1000);
    launch(exe, { COMMERCEBILL_DATA_DIR: dataDir });
    const again = await waitDiag(
      'the application to be running after the kill',
      () => {
        const s = status();
        return s && s.state === 'running' && s.mainPid !== st.mainPid ? s : undefined;
      },
      180_000,
    );
    expect(again.clusterId).toBe(firstClusterId);
    expect(again.install).toBe('existing');
    await closeGracefully(again.mainPid as number, 90_000, evidence);
    await waitDiag(
      'every process to end',
      () => (processesUnder(installDir).length === 0 ? true : undefined),
      60_000,
    );
  }, 600_000);

  it('uninstall removes the program, its shortcuts and its entry, and KEEPS the business data', async () => {
    const before = readdirSync(join(dataDir, 'data', 'pg')).sort();
    await uninstallSilently(installDir);
    expect(existsSync(exe)).toBe(false);
    expect(existsSync(startMenuLnk())).toBe(false);
    expect(existsSync(join(desktop(), 'CommerceBill.lnk'))).toBe(false);
    expect(uninstallEntries()).toEqual([]);
    expect(existsSync(join(dataDir, 'config', 'secrets.bin'))).toBe(true);
    expect(readdirSync(join(dataDir, 'data', 'pg')).sort()).toEqual(before);
  }, 300_000);

  it('reinstall finds the retained data: the same database opens, setup is not run again', async () => {
    mkdirSync(installDir, { recursive: true });
    installSilently(installer, installDir);
    launch(exe, { COMMERCEBILL_DATA_DIR: dataDir });
    const st = await waitDiag(
      'the reinstalled application to be running',
      () => {
        const s = status();
        return s && s.state === 'running' && s.install === 'existing' && s.updatedAt
          ? s
          : undefined;
      },
      180_000,
    );
    expect(st.clusterId).toBe(firstClusterId);
    expect(st.upgraded).toBe(false);
    await closeGracefully(st.mainPid as number, 90_000, evidence);
    await waitDiag(
      'every process to end',
      () => (processesUnder(installDir).length === 0 ? true : undefined),
      60_000,
    );
    expect(processesUnder(installDir)).toEqual([]);
  }, 600_000);
});
