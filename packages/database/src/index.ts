import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client.js';

export { PrismaClient } from './generated/client.js';
export type { Prisma } from './generated/client.js';

/** Create a PrismaClient bound to the given PostgreSQL connection string (Prisma 7 driver adapter). */
export function createPrismaClient(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

/** Cheap connectivity probe used by the health check. Returns true if `SELECT 1` succeeds. */
export async function pingDatabase(client: PrismaClient): Promise<boolean> {
  try {
    await client.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
