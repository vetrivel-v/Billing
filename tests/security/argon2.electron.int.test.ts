import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const script = resolve(repoRoot, 'scripts', 'spikes', 'argon2-check.cjs');

function run(command: string) {
  // Fixed argv, no shell: the Electron binary is run as plain Node via ELECTRON_RUN_AS_NODE.
  const r = spawnSync(command, [script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: command === process.execPath ? '' : '1' },
    timeout: 60_000,
  });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout.trim()) as Record<string, unknown>;
}

describe('Argon2id native module in both runtimes (R-033 spike)', () => {
  it('works in plain Node', () => {
    const r = run(process.execPath);
    expect(r).toMatchObject({
      isArgon2id: true,
      verifyCorrect: true,
      verifyWrong: false,
      verifyUnicode: true,
    });
    expect(r.electron).toBeNull();
  });

  it('works under the Electron runtime (Electron ABI)', async () => {
    const electronPath = (await import('electron')).default as unknown as string;
    const r = run(electronPath);
    expect(r).toMatchObject({
      isArgon2id: true,
      verifyCorrect: true,
      verifyWrong: false,
      verifyUnicode: true,
    });
    expect(typeof r.electron).toBe('string');
  });
});
