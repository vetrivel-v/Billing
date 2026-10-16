/**
 * SPIKE (Task 1.0, ADR-0011): proves @node-rs/argon2 loads and works in plain Node AND under the Electron
 * runtime (run with ELECTRON_RUN_AS_NODE=1 electron scripts/spikes/argon2-check.cjs).
 * Prints one JSON line. Uses throwaway test passwords only.
 */
const { hash, verify } = require('@node-rs/argon2');

// OWASP-recommended minimum for Argon2id: m=19 MiB, t=2, p=1. 2 === Algorithm.Argon2id (const enum).
const PARAMS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 };

(async () => {
  const started = Date.now();
  const h = await hash('correct horse battery staple (test only)', PARAMS);
  const hashMs = Date.now() - started;
  const ok = await verify(h, 'correct horse battery staple (test only)');
  const bad = await verify(h, 'wrong password');
  const unicode = await verify(await hash('पासवर्ड-ટેસ્ટ', PARAMS), 'पासवर्ड-ટેસ્ટ');
  process.stdout.write(
    JSON.stringify({
      isArgon2id: h.startsWith('$argon2id$v=19$m=19456,t=2,p=1$'),
      verifyCorrect: ok,
      verifyWrong: bad,
      verifyUnicode: unicode,
      hashMs,
      node: process.versions.node,
      electron: process.versions.electron ?? null,
    }) + '\n',
  );
})().catch((e) => {
  process.stderr.write(String(e) + '\n');
  process.exit(1);
});
