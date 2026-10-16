/**
 * Seed entry point. Phase 0 provides the structure only (spec section 40):
 *   - reference/ : production-safe reference data (permission catalogue, units, tax categories) - Phase 1.
 *   - demo/      : clearly marked fictional DEMO DATA - never run automatically against production data.
 *
 * No data is inserted in Phase 0. Running this script is a safe no-op that prints what is pending.
 */
const mode = process.argv[2] ?? 'reference';

if (mode !== 'reference' && mode !== 'demo') {
  console.error(`Unknown seed mode "${mode}". Use "reference" or "demo".`);
  process.exit(1);
}

console.log(
  `[seed:${mode}] Phase 0: seed structure only; no rows inserted. ` +
    `Implementation is scheduled for Phase 1 (see docs/PROJECT_STATE.md).`,
);
