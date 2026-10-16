import { describe, expect, it } from 'vitest';
import { pingDatabase, type PrismaClient } from './index.js';

describe('pingDatabase', () => {
  it('returns true when the probe query succeeds', async () => {
    const client = { $queryRaw: async () => [{ '?column?': 1 }] } as unknown as PrismaClient;
    expect(await pingDatabase(client)).toBe(true);
  });

  it('returns false (and does not throw) when the database is unreachable', async () => {
    const client = {
      $queryRaw: async () => {
        throw new Error('connection refused');
      },
    } as unknown as PrismaClient;
    expect(await pingDatabase(client)).toBe(false);
  });
});
