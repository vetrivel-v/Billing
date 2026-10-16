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
  const app = await buildApp({ env, prisma });

  const shutdown = async (): Promise<void> => {
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Loopback only: env validation rejects any non-loopback API_HOST (spec section 38).
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
}

main().catch((err: unknown) => {
  process.stderr.write(
    `API failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
