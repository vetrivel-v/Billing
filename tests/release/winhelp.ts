// Helpers for the Windows packaging checks: install, run, inspect and remove the REAL installed application. Windows only.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { createConnection } from 'node:net';
import { join } from 'node:path';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Runs a PowerShell command and returns its text (no profile, no window). */
export function ps(command: string): string {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1 << 24,
  }).trim();
}

export interface ProcRow {
  pid: number;
  parent: number;
  name: string;
  path: string | null;
}

export function allProcesses(): ProcRow[] {
  const out = ps(
    'Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath | ConvertTo-Json -Compress',
  );
  const rows = JSON.parse(out) as {
    ProcessId: number;
    ParentProcessId: number;
    Name: string;
    ExecutablePath: string | null;
  }[];
  return rows.map((r) => ({
    pid: r.ProcessId,
    parent: r.ParentProcessId,
    name: r.Name,
    path: r.ExecutablePath,
  }));
}

/** Every process started (directly or not) by `rootPid`. */
export function descendants(rootPid: number, rows = allProcesses()): ProcRow[] {
  const out: ProcRow[] = [];
  const queue = [rootPid];
  while (queue.length) {
    const p = queue.shift()!;
    for (const r of rows)
      if (r.parent === p && !out.some((x) => x.pid === r.pid)) {
        out.push(r);
        queue.push(r.pid);
      }
  }
  return out;
}

/** Processes whose executable lives under `dir` (the installed program folder or the PostgreSQL folder inside it). */
export function processesUnder(dir: string): ProcRow[] {
  const d = dir.toLowerCase();
  return allProcesses().filter((r) => r.path && r.path.toLowerCase().startsWith(d));
}

export function listeningAddresses(
  pids: number[],
): { address: string; port: number; pid: number }[] {
  if (pids.length === 0) return [];
  const out = ps(
    `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { @(${pids.join(',')}) -contains $_.OwningProcess } | Select-Object LocalAddress, LocalPort, OwningProcess | ConvertTo-Json -Compress`,
  );
  if (!out) return [];
  const j = JSON.parse(out) as unknown;
  const rows = (Array.isArray(j) ? j : [j]) as {
    LocalAddress: string;
    LocalPort: number;
    OwningProcess: number;
  }[];
  return rows.map((r) => ({ address: r.LocalAddress, port: r.LocalPort, pid: r.OwningProcess }));
}

/** True if a TCP connection to host:port succeeds within the time. */
export function canConnect(host: string, port: number, ms = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ host, port, timeout: ms });
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('timeout', () => {
      s.destroy();
      resolve(false);
    });
    s.once('error', () => resolve(false));
  });
}

/** This computer's own non-loopback IPv4 addresses (what another device on the network would use). */
export const lanAddresses = (): string[] =>
  Object.values(networkInterfaces())
    .flat()
    .filter((i): i is NonNullable<typeof i> => Boolean(i) && i!.family === 'IPv4' && !i!.internal)
    .map((i) => i.address);

export async function waitFor<T>(
  what: string,
  fn: () => T | undefined | false,
  ms = 120_000,
  step = 500,
  evidence?: () => string,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end)
      throw new Error(
        `timed out waiting for ${what}${
          evidence
            ? `
${evidence()}`
            : ''
        }`,
      );
    await sleep(step);
  }
}

export function readStatus(statusFile: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(statusFile, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Starts the installed program. A new window appears on the desktop, as it would for a person. */
export function launch(exe: string, env: Record<string, string>): ChildProcess {
  const e: NodeJS.ProcessEnv = { ...process.env, ...env };
  delete e.ELECTRON_RUN_AS_NODE;
  return spawn(exe, [], { env: e, detached: true, stdio: 'ignore' });
}

/** Closes the main window the way the close button does, and waits for the program to end. */
export async function closeGracefully(mainPid: number, ms = 90_000): Promise<void> {
  ps(
    `$p = Get-Process -Id ${mainPid} -ErrorAction SilentlyContinue; if ($p) { [void]$p.CloseMainWindow() }`,
  );
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!allProcesses().some((r) => r.pid === mainPid)) return;
    await sleep(500);
  }
  throw new Error('the application did not close');
}

export function killTree(pid: number): void {
  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch {
    // already gone
  }
}

/** Kills everything still running from `dir` (cleanup after a failed check only). */
export function killAllUnder(dir: string): void {
  for (const p of processesUnder(dir)) killTree(p.pid);
}

export function installSilently(installer: string, installDir: string): void {
  // NSIS: /S is silent, /D= (last, unquoted) is the folder. Per-user: no elevation prompt.
  execFileSync(installer, ['/S', `/D=${installDir}`], { windowsHide: true, timeout: 600_000 });
}

export async function uninstallSilently(installDir: string): Promise<void> {
  const un = join(installDir, 'Uninstall CommerceBill.exe');
  if (!existsSync(un)) return;
  spawn(un, ['/S'], { detached: true, stdio: 'ignore' }).unref();
  const end = Date.now() + 120_000;
  while (Date.now() < end && existsSync(join(installDir, 'CommerceBill.exe'))) await sleep(1000);
  // the uninstaller removes its own folder a moment after the program files
  await sleep(3000);
}

export function shortcutTarget(lnk: string): { target: string; args: string } | null {
  if (!existsSync(lnk)) return null;
  const out = ps(
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}'); "$($s.TargetPath)|$($s.Arguments)"`,
  );
  const [target, args] = out.split('|');
  return { target: target ?? '', args: args ?? '' };
}

/** Top-level windows that are visible on screen and belong to the given processes: "class:pid" for each. */
export function visibleWindows(pids: number[]): string[] {
  if (pids.length === 0) return [];
  const out = ps(`
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic;
public class Win { public delegate bool EP(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EP e, IntPtr l);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
 [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
 public static string[] Find(uint[] pids){ var set = new HashSet<uint>(pids); var r = new List<string>();
  EnumWindows((h,l)=>{ uint p; GetWindowThreadProcessId(h, out p); if (set.Contains(p) && IsWindowVisible(h) && GetWindowTextLength(h) > 0) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); r.Add(sb.ToString() + ":" + p); } return true; }, IntPtr.Zero); return r.ToArray(); } }
"@
[Win]::Find([uint32[]]@(${pids.join(',')})) | ConvertTo-Json -Compress`);
  if (!out) return [];
  const j = JSON.parse(out) as unknown;
  return (Array.isArray(j) ? j : [j]) as string[];
}

export function uninstallEntries(): { name: string; location: string }[] {
  const out = ps(
    "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'CommerceBill' } | Select-Object DisplayName, UninstallString | ConvertTo-Json -Compress",
  );
  if (!out) return [];
  const j = JSON.parse(out) as unknown;
  return ((Array.isArray(j) ? j : [j]) as { DisplayName: string; UninstallString: string }[]).map(
    (r) => ({
      name: r.DisplayName,
      location: r.UninstallString,
    }),
  );
}

export const removeDir = (dir: string) =>
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
