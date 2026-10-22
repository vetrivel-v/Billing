import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

/** Removes the given secrets from text, so a log line can never carry a password, passphrase, token or launch secret. */
export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 6) out = out.split(s).join('[REDACTED]');
  // a connection string may carry the password even if the password itself was not registered
  return out.replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s]+@/gi, '$1[REDACTED]@');
}

export interface LogPolicy {
  /** A file is rotated when it grows past this size. */
  maxBytes: number;
  /** How many rotated files are kept per log. */
  keep: number;
  /** Files older than this are deleted at start-up. */
  maxAgeDays: number;
  /** The whole log folder may not exceed this size after clean-up (oldest files go first). */
  maxTotalBytes: number;
}

export const DEFAULT_LOG_POLICY: LogPolicy = {
  maxBytes: 5 * 1024 * 1024,
  keep: 4,
  maxAgeDays: 30,
  maxTotalBytes: 60 * 1024 * 1024,
};

/** Rotates `<name>.log` -> `<name>.1.log` -> ... keeping `keep` files. */
export function rotateIfLarge(dir: string, name: string, policy: LogPolicy): void {
  const file = join(dir, `${name}.log`);
  if (!existsSync(file) || statSync(file).size < policy.maxBytes) return;
  for (let i = policy.keep; i >= 1; i--) {
    const from = i === 1 ? file : join(dir, `${name}.${i - 1}.log`);
    const to = join(dir, `${name}.${i}.log`);
    if (existsSync(to)) rmSync(to, { force: true });
    if (existsSync(from)) renameSync(from, to);
  }
}

/** Deletes old and surplus log files. Called at every start-up, so logs cannot grow without limit. */
export function pruneLogs(dir: string, policy: LogPolicy, now = Date.now()): number {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => ({ f, p: join(dir, f), s: statSync(join(dir, f)) }))
    .sort((a, b) => a.s.mtimeMs - b.s.mtimeMs);
  for (const x of files)
    if (now - x.s.mtimeMs > policy.maxAgeDays * 86_400_000) {
      rmSync(x.p, { force: true });
      removed++;
    }
  const left = files.filter((x) => existsSync(x.p));
  let total = left.reduce((n, x) => n + x.s.size, 0);
  for (const x of left) {
    if (total <= policy.maxTotalBytes) break;
    rmSync(x.p, { force: true });
    total -= x.s.size;
    removed++;
  }
  return removed;
}

/** A small append-only log for the application's own messages: timestamped, redacted, size-capped. No console output. */
export class AppLog {
  private secrets: string[] = [];
  constructor(
    private readonly dir: string,
    private readonly name = 'app',
    private readonly policy: LogPolicy = DEFAULT_LOG_POLICY,
  ) {
    mkdirSync(dir, { recursive: true });
    pruneLogs(dir, policy);
    rotateIfLarge(dir, name, policy);
  }
  addSecret(secret: string): void {
    if (secret) this.secrets.push(secret);
  }
  write(level: 'info' | 'warn' | 'error', message: string): void {
    try {
      rotateIfLarge(this.dir, this.name, this.policy);
      appendFileSync(
        join(this.dir, `${this.name}.log`),
        `${new Date().toISOString()} ${level.toUpperCase()} ${redactText(message, this.secrets)}\n`,
        { mode: 0o600 },
      );
    } catch {
      // logging must never break the application
    }
  }
  info = (m: string): void => this.write('info', m);
  warn = (m: string): void => this.write('warn', m);
  error = (m: string): void => this.write('error', m);
}
