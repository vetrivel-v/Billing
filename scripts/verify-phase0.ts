/**
 * Phase 0 verification: runs every gate command and prints an honest PASS/FAIL table.
 * Exit code is non-zero if any gate fails. Gates are never skipped or softened.
 *
 * Usage: npm run verify:phase0
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { repoRoot } from './lib/env.js';

interface Gate {
  name: string;
  command: string;
  /** Vitest JSON report written by this gate; cross-checked so a wrong exit code cannot hide failures. */
  report?: string;
}

const gates: Gate[] = [
  { name: 'Prisma schema valid', command: 'npm run db:validate' },
  { name: 'Prisma client generated', command: 'npm run db:generate' },
  { name: 'Type-check', command: 'npm run typecheck' },
  { name: 'Lint', command: 'npm run lint' },
  { name: 'Format check', command: 'npm run format:check' },
  {
    name: 'Unit tests',
    command:
      'npm test -- --reporter=default --reporter=json --outputFile.json=.data/report-unit.json',
    report: '.data/report-unit.json',
  },
  {
    name: 'Integration tests (isolated PostgreSQL + migration)',
    command:
      'npm run test:integration -- --reporter=default --reporter=json --outputFile.json=.data/report-integration.json',
    report: '.data/report-integration.json',
  },
  { name: 'Build (api, web, desktop)', command: 'npm run build' },
];

/** True only if the Vitest JSON report exists, ran at least one test and recorded no failures. */
function reportIsClean(file: string): boolean {
  const path = resolve(repoRoot, file);
  if (!existsSync(path)) {
    console.error(`Report ${file} missing - treating the gate as FAILED`);
    return false;
  }
  const r = JSON.parse(readFileSync(path, 'utf8')) as {
    numTotalTests: number;
    numFailedTests: number;
    success: boolean;
  };
  if (r.numTotalTests === 0 || r.numFailedTests > 0 || !r.success) {
    console.error(`Report ${file}: ${r.numFailedTests} failed of ${r.numTotalTests} - gate FAILED`);
    return false;
  }
  return true;
}

const results: { name: string; ok: boolean; seconds: number }[] = [];
for (const gate of gates) {
  console.log(`\n=== ${gate.name}: ${gate.command}`);
  const start = Date.now();
  // Fixed command strings from this file only - no untrusted input reaches the shell.
  if (gate.report) rmSync(resolve(repoRoot, gate.report), { force: true });
  const r = spawnSync(gate.command, { cwd: repoRoot, stdio: 'inherit', shell: true });
  let ok = r.status === 0;
  if (gate.report) ok = ok && reportIsClean(gate.report);
  results.push({ name: gate.name, ok, seconds: (Date.now() - start) / 1000 });
}

console.log('\n=== Phase 0 verification summary');
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} (${r.seconds.toFixed(1)}s)`);
}
const failed = results.filter((r) => !r.ok);
console.log(
  failed.length === 0 ? '\nAll Phase 0 gates passed.' : `\n${failed.length} gate(s) FAILED.`,
);
process.exit(failed.length === 0 ? 0 : 1);
