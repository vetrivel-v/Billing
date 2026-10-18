/**
 * Seed entry point (spec section 40).
 *
 *   tsx prisma/seed/seed.ts reference [--organization <uuid>]
 *       Inserts reference/master configuration (permissions, role templates, units, tax categories
 *       and rates) for an EXISTING organization, in one transaction, idempotently.
 *       Without --organization, the single existing organization is used; zero or several is an error.
 *   tsx prisma/seed/seed.ts demo
 *       Task 1.1: deliberate no-op. Fictional DEMO DATA arrives in a later task and is never mixed
 *       into production data automatically.
 *
 * Uses DATABASE_URL (or .env, or the development database URL).
 */
import { createPrismaClient } from '@commercebill/database';
import { devDatabaseUrl, loadDotEnv } from '../../scripts/lib/env.js';
import { ReferenceSeedError, seedReference } from './reference/index.js';

const args = process.argv.slice(2);
const mode = args[0] ?? 'reference';

if (mode === 'demo') {
  console.log('[seed:demo] No-op in Task 1.1: no demo data is inserted.');
  process.exit(0);
}
if (mode !== 'reference') {
  console.error(`Unknown seed mode "${mode}". Use "reference" or "demo".`);
  process.exit(1);
}

loadDotEnv();
const prisma = createPrismaClient(process.env.DATABASE_URL ?? devDatabaseUrl());
try {
  const flag = args.indexOf('--organization');
  let organizationId = flag >= 0 ? args[flag + 1] : undefined;
  if (flag >= 0 && !organizationId) throw new ReferenceSeedError('--organization requires a value');
  if (!organizationId) {
    const orgs = await prisma.organization.findMany({ select: { id: true }, take: 2 });
    if (orgs.length !== 1) {
      throw new ReferenceSeedError(
        orgs.length === 0
          ? 'No organization exists yet. Create one (setup wizard) before seeding reference data.'
          : 'Several organizations exist. Pass --organization <uuid>.',
      );
    }
    organizationId = orgs[0]!.id;
  }
  const report = await seedReference(prisma, { organizationId });
  console.log(`[seed:reference] organization ${report.organizationId}`);
  for (const [step, n] of Object.entries(report.created)) console.log(`  ${step}: ${n} inserted`);
  console.log(
    '[seed:reference] Tax rows are UNREVIEWED placeholders: an authorized accountant must review them before production use.',
  );
} catch (err) {
  console.error(
    `[seed:reference] FAILED, nothing was changed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
