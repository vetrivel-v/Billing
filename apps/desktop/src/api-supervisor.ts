import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

/**
 * Starts and supervises the local API process for the Electron shell (ADR-0010, requirement P1-SEC-01).
 * No Electron imports, so everything here is unit-testable under plain Node.
 */

/** 32 random bytes, hex-encoded (64 characters). A new secret is generated for every launch. */
export function generateLaunchSecret(): string {
  return randomBytes(32).toString('hex');
}

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no port')),
      );
    });
  });
}

export interface ApiLaunchConfig {
  /** Absolute path of the built API bundle (apps/api/dist/main.js). */
  entry: string;
  port: number;
  secret: string;
  /** Browser origin the API must allow through CORS (the renderer). */
  webOrigin: string;
  databaseUrl: string;
  logLevel?: string;
  nodeEnv?: string;
  /** Executable used to run the entry. In Electron this is process.execPath with ELECTRON_RUN_AS_NODE. */
  execPath?: string;
}

/** Variables the child genuinely needs from the parent on Windows; nothing else is inherited. */
const INHERITED_ENV = ['SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'PATH', 'Path'] as const;

/**
 * Builds the exact command, arguments and environment for the API child. The secret travels ONLY in the
 * environment (never argv, disk or logs) and the child receives an allow-listed environment, so unrelated
 * secrets in the parent's environment are not forwarded.
 */
export function buildApiSpawn(
  config: ApiLaunchConfig,
  parentEnv: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[]; env: Record<string, string> } {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV) {
    const value = parentEnv[key];
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, {
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: config.nodeEnv ?? 'production',
    LOG_LEVEL: config.logLevel ?? 'info',
    API_HOST: '127.0.0.1',
    API_PORT: String(config.port),
    WEB_ORIGIN: config.webOrigin,
    DATABASE_URL: config.databaseUrl,
    LAUNCH_SECRET: config.secret,
  });
  return { command: config.execPath ?? process.execPath, args: [config.entry], env };
}

export interface RunningApi {
  baseUrl: string;
  /** Combined stdout/stderr captured so far (capped); used to prove the secret is never logged. */
  output(): string;
  hasExited(): boolean;
  stop(): Promise<void>;
}

export class ApiStartError extends Error {}

const OUTPUT_CAP = 256 * 1024;

function childGone(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export async function waitForHealth(
  baseUrl: string,
  child: ChildProcess,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (childGone(child)) throw new ApiStartError(`API exited early (code ${child.exitCode})`);
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new ApiStartError('API did not become healthy in time');
}

export async function startApi(
  config: ApiLaunchConfig,
  healthTimeoutMs?: number,
): Promise<RunningApi> {
  const { command, args, env } = buildApiSpawn(config);
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  const collect = (chunk: Buffer) => {
    output = (output + chunk.toString('utf8')).slice(-OUTPUT_CAP);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  const baseUrl = `http://127.0.0.1:${config.port}`;
  const stop = async (): Promise<void> => {
    if (childGone(child)) return;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill();
    });
  };

  try {
    await waitForHealth(baseUrl, child, healthTimeoutMs);
  } catch (err) {
    await stop();
    // Include a short, already-redacted tail of the child's output to aid diagnosis.
    const tail = output.slice(-1500).replaceAll(config.secret, '[REDACTED]');
    throw new ApiStartError(`${err instanceof Error ? err.message : String(err)}\n${tail}`);
  }
  return { baseUrl, output: () => output, hasExited: () => childGone(child), stop };
}
