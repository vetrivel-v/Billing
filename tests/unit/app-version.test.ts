import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '@commercebill/shared-types';

const repo = resolve(import.meta.dirname, '..', '..');
const json = (p: string) =>
  JSON.parse(readFileSync(resolve(repo, p), 'utf8')) as { version: string };

describe('application version (ADR-0029)', () => {
  it('is SemVer and equals the desktop package, which names the installer', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(json('apps/desktop/package.json').version).toBe(APP_VERSION);
  });
});
