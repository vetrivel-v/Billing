/**
 * One-command development startup (spec section 5): embedded PostgreSQL -> migrate -> API + web.
 * Electron is started separately with `npm run start -w @commercebill/desktop` (set
 * ELECTRON_RENDERER_URL=http://127.0.0.1:5173 to use the Vite dev server).
 *
 * Usage: npm run dev   (Ctrl+C stops everything)
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { DEV_DB, devDatabaseUrl, loadDotEnv, repoRoot } from './lib/env.js';

loadDotEnv();
const env = { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? devDatabaseUrl() };
const children: ChildProcess[] = [];

function run(command: string): ChildProcess {
  const child = spawn(command, { cwd: repoRoot, stdio: 'inherit', shell: true, env });
  children.push(child);
  return child;
}

function waitForPort(port: number, host: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = connect({ port, host }, () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`Timed out waiting for ${host}:${port}`));
        else setTimeout(attempt, 500);
      });
    };
    attempt();
  });
}

function stopAll(): void {
  for (const c of children) c.kill();
  process.exit(0);
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);

run('npm run db:start');
await waitForPort(DEV_DB.port, DEV_DB.host);
const migrate = spawnSync('npm run db:migrate', {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: true,
  env,
});
if (migrate.status !== 0) {
  console.error('Migration failed; not starting the API.');
  stopAll();
}
run('npm run dev -w @commercebill/api');
run('npm run dev -w @commercebill/web');
