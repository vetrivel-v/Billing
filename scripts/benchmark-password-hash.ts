/**
 * Benchmarks Argon2id cost settings on THIS machine so the default can be chosen from measurements
 * (ADR-0014). Usage: npm run bench:password-hash
 * Uses throwaway passwords only. Median of N runs per setting.
 */
import { hash } from '@node-rs/argon2';

const RUNS = 9;
// 2 === Algorithm.Argon2id (const enum, not importable under isolatedModules).
const ARGON2ID = 2;

const candidates = [
  { memoryCost: 19456, timeCost: 2, parallelism: 1 }, // OWASP minimum
  { memoryCost: 32768, timeCost: 3, parallelism: 1 },
  { memoryCost: 49152, timeCost: 3, parallelism: 1 },
  { memoryCost: 65536, timeCost: 3, parallelism: 1 },
  { memoryCost: 65536, timeCost: 4, parallelism: 1 },
  { memoryCost: 98304, timeCost: 3, parallelism: 1 },
  { memoryCost: 131072, timeCost: 3, parallelism: 1 },
];

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

console.log(`Argon2id benchmark, ${RUNS} runs each (median / max ms)`);
for (const c of candidates) {
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    await hash(`benchmark-password-${i}`, { algorithm: ARGON2ID, ...c });
    times.push(performance.now() - t0);
  }
  console.log(
    `m=${String(c.memoryCost).padStart(6)} KiB  t=${c.timeCost}  p=${c.parallelism}  ` +
      `median ${median(times).toFixed(0).padStart(4)} ms   max ${Math.max(...times)
        .toFixed(0)
        .padStart(4)} ms`,
  );
}
