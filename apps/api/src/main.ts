import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrismaClient } from '@commercebill/database';
import { EnvValidationError, parseEnv } from '@commercebill/validation';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  let env;
  try {
    env = parseEnv(process.env);
  } catch (err) {
    if (err instanceof EnvValidationError) {
      // Startup failure message lists variable names and rules only, never values.
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const prisma = createPrismaClient(env.DATABASE_URL);
  // Dev layout: apps/api/dist/main.js -> <repo>/prisma/migrations. The packaged layout is Phase 6 work (MIGRATIONS_DIR overrides it).
  const migrationsDir =
    process.env.MIGRATIONS_DIR ??
    resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'prisma', 'migrations');
  const app = await buildApp({
    env,
    prisma,
    launchSecret: env.LAUNCH_SECRET,
    backup: {
      databaseUrl: env.DATABASE_URL,
      migrationsDir,
      // The desktop shell's own secret (never sent to the renderer). Absent = the shell cannot choose folders or files.
      controlSecret: process.env.CONTROL_SECRET || undefined,
    },
  });

  const shutdown = async (): Promise<void> => {
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // When the desktop shell that started this service disappears without stopping it (a crash, a forced end), the service ends too instead
  // of lingering with its database connections. Only a process id is passed: no secret.
  const parent = Number(process.env.COMMERCEBILL_PARENT_PID);
  if (Number.isInteger(parent) && parent > 0)
    setInterval(() => {
      try {
        process.kill(parent, 0);
      } catch {
        void shutdown();
      }
    }, 4000).unref();

  // Loopback only: env validation rejects any non-loopback API_HOST (spec section 38).
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
}

main().catch((err: unknown) => {
  process.stderr.write(
    `API failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
