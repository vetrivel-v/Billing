import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveAppRequest } from './app-protocol.js';

let root: string;
let outside: string;

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'cb-proto-'));
  root = join(base, 'web');
  outside = join(base, 'secret.txt');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<html></html>');
  writeFileSync(join(root, 'assets', 'app.js'), '//js');
  writeFileSync(outside, 'top secret');
});
afterAll(() => rmSync(join(root, '..'), { recursive: true, force: true }));

describe('resolveAppRequest', () => {
  it('serves index.html for / and existing assets', () => {
    expect(resolveAppRequest('app://commercebill/', root)).toBe(join(root, 'index.html'));
    expect(resolveAppRequest('app://commercebill/index.html', root)).toBe(join(root, 'index.html'));
    expect(resolveAppRequest('app://commercebill/assets/app.js', root)).toBe(
      join(root, 'assets', 'app.js'),
    );
  });

  it('falls back to index.html for extension-less routes but 404s missing files', () => {
    expect(resolveAppRequest('app://commercebill/customers/42', root)).toBe(
      join(root, 'index.html'),
    );
    expect(resolveAppRequest('app://commercebill/assets/missing.js', root)).toBeNull();
  });

  it('rejects other hosts and schemes', () => {
    expect(resolveAppRequest('app://evil/index.html', root)).toBeNull();
    expect(resolveAppRequest('https://commercebill/index.html', root)).toBeNull();
    expect(resolveAppRequest('file:///c:/windows/win.ini', root)).toBeNull();
    expect(resolveAppRequest('garbage', root)).toBeNull();
  });

  it.each([
    'app://commercebill/../secret.txt',
    'app://commercebill/%2e%2e/secret.txt',
    'app://commercebill/%2e%2e%2fsecret.txt',
    'app://commercebill/assets/..%2f..%2fsecret.txt',
    'app://commercebill/assets/..%5c..%5csecret.txt',
    'app://commercebill/index.html%00.png',
  ])('blocks path traversal: %s', (url) => {
    const r = resolveAppRequest(url, root);
    expect(r === null || r.startsWith(root)).toBe(true);
    expect(r).not.toBe(outside);
  });
});
