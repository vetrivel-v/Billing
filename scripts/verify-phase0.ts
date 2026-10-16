/**
 * Phase 0 verification: runs every gate command and prints an honest PASS/FAIL table.
 * Exit code is non-zero if any gate fails. Gates are never skipped or softened.
 *
 * Usage: npm run verify:phase0
 */
import { spawnSync } from 'node:child_process';
import { repoRoot } from './lib/env.js';

interface Gate {
  name: string;
  command: string;
}

const gates: Gate[] = [
  { name: 'Prisma schema valid', command: 'npm run db:validate' },
  { name: 'Prisma client generated', command: 'npm run db:generate' },
  { name: 'Type-check', command: 'npm run typecheck' },
  { name: 'Lint', command: 'npm run lint' },
  { name: 'Format check', command: 'npm run format:check' },
  { name: 'Unit tests', command: 'npm test' },
  {
    name: 'Integration tests (isolated PostgreSQL + migration)',
    command: 'npm run test:integration',
  },
  { name: 'Build (api, web, desktop)', command: 'npm run build' },
];

const results: { name: string; ok: boolean; seconds: number }[] = [];
for (const gate of gates) {
  console.log(`\n=== ${gate.name}: ${gate.command}`);
  const start = Date.now();
  // Fixed command strings from this file only - no untrusted input reaches the shell.
  const r = spawnSync(gate.command, { cwd: repoRoot, stdio: 'inherit', shell: true });
  results.push({ name: gate.name, ok: r.status === 0, seconds: (Date.now() - start) / 1000 });
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
