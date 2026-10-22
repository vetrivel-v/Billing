/**
 * Release verification: every automated check that must pass before an installer is handed to a person.
 *   1. verify:phase0  - schema, type-check, lint, format, ALL unit and integration tests (including the Electron end-to-end journeys,
 *                       backup/restore and the managed-database tests), and the build
 *   2. the packaged-application checks (project "release"): the installed-layout end-to-end journey with its own managed database,
 *      and the REAL installer (install, run, close, uninstall keeps data, reinstall finds it)
 *   3. npm audit (production dependencies must have no high or critical findings)
 *   4. no process left running from this repository's build or from a test install
 * Nothing is skipped or softened; the exit code is non-zero if any step fails. Windows only (the installer is a Windows program).
 *
 * Usage: npm run verify:release
 */
import { spawnSync } from 'node:child_process';
import { repoRoot } from './lib/env.js';

interface Step {
  name: string;
  run: () => { ok: boolean; detail: string };
}

const sh = (command: string): number =>
  spawnSync(command, { cwd: repoRoot, stdio: 'inherit', shell: true }).status ?? 1;

const leftovers = (): string[] => {
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -like '*\\release\\win-unpacked\\*' -or $_.ExecutablePath -like '*\\cb-pkg-e2e-*' -or $_.ExecutablePath -like '*\\cbinstall\\*') } | ForEach-Object { \"$($_.ProcessId) $($_.Name)\" }",
    ],
    { encoding: 'utf8' },
  );
  return r.stdout.split(/\r?\n/).filter(Boolean);
};

const steps: Step[] = [
  {
    name: 'Phase 0 gate (schema, types, lint, format, all unit + integration tests, build)',
    run: () => ({ ok: sh('npm run verify:phase0') === 0, detail: 'npm run verify:phase0' }),
  },
  {
    name: 'Packaged application + real installer (install, run, close, uninstall keeps data, reinstall)',
    run: () => ({ ok: sh('npm run test:release') === 0, detail: 'npm run test:release' }),
  },
  {
    name: 'Dependency audit (production, high or above)',
    run: () => ({
      ok: sh('npm audit --omit=dev --audit-level=high') === 0,
      detail: 'npm audit --omit=dev --audit-level=high',
    }),
  },
  {
    name: 'No process left running from the build or a test install',
    run: () => {
      const l = leftovers();
      return { ok: l.length === 0, detail: l.length ? `still running: ${l.join(', ')}` : 'none' };
    },
  },
];

if (process.platform !== 'win32') {
  console.error('verify:release checks the Windows installer and must run on Windows.');
  process.exit(2);
}

const results = steps.map((s) => {
  console.log(`\n=== ${s.name} ===`);
  const t = Date.now();
  const r = s.run();
  return { name: s.name, ...r, seconds: Math.round((Date.now() - t) / 1000) };
});

console.log('\nRelease verification');
console.log('--------------------');
for (const r of results)
  console.log(
    `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${String(r.seconds)}s)${r.ok ? '' : `  -> ${r.detail}`}`,
  );
console.log(
  '\nNot covered by automation (see docs/RELEASE_CHECKLIST.md): native Windows dialogs, a physical printer, an external drive,\nand installation on the target laptop. These are listed as NOT TESTED in docs/WINDOWS_LAPTOP_ACCEPTANCE.md.',
);
const failed = results.filter((r) => !r.ok);
console.log(
  failed.length
    ? `\nRELEASE VERIFICATION FAILED (${String(failed.length)} step(s))`
    : '\nRELEASE VERIFICATION PASSED (automated part)',
);
process.exit(failed.length ? 1 : 0);
