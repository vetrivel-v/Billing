# ADR-0011: Argon2id via @node-rs/argon2

- Status: Accepted (library proven in Node and Electron; the auth service is a later Phase 1 task)
- Date: 2026-10-16
- Resolves: risk R-033 (load/ABI); residual packaging check R-038

## Context

Spec section 11 requires Argon2id or an equivalent current password hash. Native modules are a risk in
Electron because of ABI differences.

## Decision

Use **`@node-rs/argon2`**: a Rust implementation shipped as **prebuilt N-API binaries** (here
`@node-rs/argon2-win32-x64-msvc`), so no compiler toolchain is needed and N-API is ABI-stable across Node and
Electron versions. Parameters: Argon2id, memory 19456 KiB (19 MiB), time cost 2, parallelism 1 (the OWASP
minimum configuration), random per-hash salt, PHC string output stored in `users.password_hash`. Parameters are
encoded in the hash, so they can be raised later while old hashes still verify (rehash on login).

## Evidence

`tests/security/argon2.test.ts` (4 tests, Node) and `tests/security/argon2.electron.int.test.ts` (2 tests),
which execute `scripts/spikes/argon2-check.cjs` under plain Node 24.16.0 and under **Electron 44.8.0**
(`ELECTRON_RUN_AS_NODE=1`, Node 24.22.0 inside Electron). In both: Argon2id PHC prefix with the expected
parameters, correct password verifies, wrong password rejected, Unicode (Devanagari/Gujarati) password
verifies, malformed hash rejected. Measured hash time at these parameters: about 17 ms (Node) and 20 ms
(Electron) on this machine.

## Consequences

- 17-20 ms is far below a typical 100-250 ms interactive target. The authentication task must benchmark and
  raise the memory/time cost (and make it configurable) before release. The spike uses the OWASP floor.
- Packaging (Phase 6) must unpack the `.node` binary from any asar archive (`asarUnpack`), and the installer
  smoke test must perform a login (risk R-038). Only win32-x64 was exercised.
- Passwords are never logged or stored; the test passwords are throwaway literals.
