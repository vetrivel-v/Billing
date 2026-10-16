import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const repoRoot = resolve(import.meta.dirname, '..', '..');

/** Development defaults - placeholder credentials for a local-only throwaway database. */
export const DEV_DB = {
  host: '127.0.0.1',
  port: 54329,
  user: 'commercebill',
  password: 'commercebill_dev',
  database: 'commercebill_dev',
} as const;

export function devDatabaseUrl(): string {
  const d = DEV_DB;
  return `postgresql://${d.user}:${d.password}@${d.host}:${d.port}/${d.database}?schema=public`;
}

/** Minimal .env loader (no dependency). Existing process.env values win. */
export function loadDotEnv(file = resolve(repoRoot, '.env')): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const [, key, raw] = m;
    if (key && process.env[key] === undefined)
      process.env[key] = (raw ?? '').replace(/^["']|["']$/g, '');
  }
}
