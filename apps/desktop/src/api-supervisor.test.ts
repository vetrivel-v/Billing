import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApiStartError,
  buildApiSpawn,
  generateLaunchSecret,
  getFreePort,
  startApi,
} from './api-supervisor.js';

let dir: string;
let fakeApi: string;
let crashingApi: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cb-sup-'));
  // A stand-in API: serves /health and /env (reports what the child received) and logs one line.
  fakeApi = join(dir, 'fake-api.cjs');
  writeFileSync(
    fakeApi,
    [
      "const http = require('http');",
      'const port = Number(process.env.API_PORT);',
      'http.createServer((req, res) => {',
      "  if (req.url === '/health') { res.end(JSON.stringify({ status: 'ok' })); return; }",
      "  if (req.url === '/env') {",
      '    res.end(JSON.stringify({',
      "      secretLen: (process.env.LAUNCH_SECRET || '').length,",
      '      argv: process.argv.slice(2),',
      '      host: process.env.API_HOST,',
      '      origin: process.env.WEB_ORIGIN,',
      '      leaked: process.env.PARENT_ONLY_SECRET ?? null,',
      '    }));',
      '    return;',
      '  }',
      "  res.statusCode = 404; res.end('{}');",
      "}).listen(port, '127.0.0.1', () => console.log('fake api listening'));",
    ].join('\n'),
  );
  crashingApi = join(dir, 'crash.cjs');
  writeFileSync(
    crashingApi,
    "console.error('boom ' + process.env.LAUNCH_SECRET); process.exit(3);",
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const baseConfig = {
  webOrigin: 'app://commercebill',
  databaseUrl: 'postgresql://u:p@127.0.0.1:5432/db',
};

describe('generateLaunchSecret', () => {
  it('returns 64 hex chars (32 random bytes) and differs on every launch', () => {
    const a = generateLaunchSecret();
    const b = generateLaunchSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe('buildApiSpawn', () => {
  const config = { ...baseConfig, entry: 'C:/app/api/main.js', port: 4999, secret: 'f'.repeat(64) };

  it('passes the secret only through the environment, never argv', () => {
    const spec = buildApiSpawn(config, {});
    expect(spec.env.LAUNCH_SECRET).toBe(config.secret);
    expect(spec.args).toEqual([config.entry]);
    expect(JSON.stringify(spec.args)).not.toContain(config.secret);
    expect(spec.command).not.toContain(config.secret);
  });

  it('binds loopback, sets the renderer origin and runs Electron as plain Node', () => {
    const { env } = buildApiSpawn(config, {});
    expect(env).toMatchObject({
      API_HOST: '127.0.0.1',
      API_PORT: '4999',
      WEB_ORIGIN: 'app://commercebill',
      NODE_ENV: 'production',
      ELECTRON_RUN_AS_NODE: '1',
    });
  });

  it('does not forward unrelated parent environment variables', () => {
    const { env } = buildApiSpawn(config, {
      PATH: 'C:/bin',
      SystemRoot: 'C:/Windows',
      AWS_SECRET_ACCESS_KEY: 'do-not-forward',
      DATABASE_URL: 'postgresql://other',
      LAUNCH_SECRET: 'parent-value',
    });
    expect(env.PATH).toBe('C:/bin');
    expect(env.SystemRoot).toBe('C:/Windows');
    expect(Object.keys(env)).not.toContain('AWS_SECRET_ACCESS_KEY');
    expect(env.DATABASE_URL).toBe(config.databaseUrl); // from config, not the parent
    expect(env.LAUNCH_SECRET).toBe(config.secret);
  });
});

describe('startApi', () => {
  it('starts the child, waits for health, supplies the secret by env, and stops it', async () => {
    process.env.PARENT_ONLY_SECRET = 'must-not-leak';
    const port = await getFreePort();
    const secret = generateLaunchSecret();
    const api = await startApi({
      ...baseConfig,
      entry: fakeApi,
      port,
      secret,
      execPath: process.execPath,
    });
    try {
      expect(api.baseUrl).toBe(`http://127.0.0.1:${port}`);
      const info = (await (await fetch(`${api.baseUrl}/env`)).json()) as Record<string, unknown>;
      expect(info).toMatchObject({
        secretLen: 64,
        argv: [],
        host: '127.0.0.1',
        origin: 'app://commercebill',
        leaked: null,
      });
      expect(api.output()).toContain('fake api listening');
      expect(api.output()).not.toContain(secret);
      expect(api.hasExited()).toBe(false);
    } finally {
      await api.stop();
      delete process.env.PARENT_ONLY_SECRET;
    }
    expect(api.hasExited()).toBe(true);
    await expect(fetch(`${api.baseUrl}/health`)).rejects.toThrow();
  });

  it('fails clearly, and redacts the secret from the diagnostic tail, if the child dies', async () => {
    const secret = generateLaunchSecret();
    const err = await startApi({
      ...baseConfig,
      entry: crashingApi,
      port: await getFreePort(),
      secret,
      execPath: process.execPath,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiStartError);
    const message = (err as Error).message;
    expect(message).toMatch(/exited early/);
    expect(message).toContain('boom');
    expect(message).not.toContain(secret);
    expect(message).toContain('[REDACTED]');
  });

  it('times out when the child never becomes healthy', async () => {
    const idle = join(dir, 'idle.cjs');
    writeFileSync(idle, 'setInterval(() => {}, 1000);');
    await expect(
      startApi(
        {
          ...baseConfig,
          entry: idle,
          port: await getFreePort(),
          secret: generateLaunchSecret(),
          execPath: process.execPath,
        },
        700,
      ),
    ).rejects.toThrow(/did not become healthy/);
  });
});
