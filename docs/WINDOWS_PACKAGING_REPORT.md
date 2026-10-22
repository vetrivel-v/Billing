# Windows Desktop Packaging and Installation: Completion Report

Date: 2026-10-23. Follows Phase 1 Task 1.18 (commit 498a568). Decision record: [ADR-0029](adr/0029-windows-packaging-and-local-runtime.md). Not started and not to be started here: invoice cancellation, credit notes, returns, remote access, Phase 2, e-commerce, Task 1.19.

## 1. Result

An installer is produced: `npm run package:win` creates `release/CommerceBill-Setup-0.1.0.exe` (NSIS, per-user, no elevation). It is **UNSIGNED** (no certificate exists; none was faked). The exact size and SHA-256 of the build are written to `release/installer-info.json` (git-ignored, binaries are not committed) and are quoted in the hand-over message for the build verified on the final commit. Builds are reproducible in procedure, not bit-for-bit (timestamps differ), so the hash is specific to one build.

## 2. Architecture review (read-only first)

Found before any change: the application only ran from a checkout (Node, npm, a developer-started PostgreSQL via `db:start`, environment variables); the desktop shell assumed a dev API process; nothing started or stopped a database; no data location existed outside the repository. No destructive or data-loss decision needing approval was identified, so implementation proceeded. Choices (all in ADR-0029): private PostgreSQL 18 on 127.0.0.1 with generated credentials, data in `%LOCALAPPDATA%\CommerceBill`, DPAPI-protected secrets, verified pre-upgrade backup, per-user NSIS, app-local VC++ runtime, unsigned-but-signing-ready, SemVer.

## 3. What was built

- `apps/desktop/src/runtime/*` (paths, logger, secrets, postgres, upgrade, startup, diagnostics) and `electron-runtime.ts`: the managed database, start-up decision (fresh / existing / broken), plain-language failure dialog, splash, single instance, clean shutdown, orphan recovery, redacted rotating logs, diagnostics export.
- `packages/backup`: migration status and apply, pre-upgrade backup and verification (Task 1.17 engine reused).
- API: parent-process watchdog. Web: Settings, About & Diagnostics. Shared types: bridge methods and `APP_VERSION`.
- `scripts/package-win.ts`, `scripts/make-icon.ts`, `apps/desktop/build/*`: reproducible staging outside the repository, esbuild API bundle, vendored argon2, PostgreSQL and VC++ DLL staging, installer config, installer record.
- `scripts/verify-release.ts` and the `release` test project.

## 4. Automatically verified

On the development computer (Windows 11), on the final commit (results in the hand-over message): the whole Phase 0 gate (all unit and integration tests with coverage thresholds 80/70/80/80 unchanged), the packaged end-to-end journey with the application's own database, the real installer test (install, shortcuts, uninstall entry, first launch, no terminal window, loopback-only listeners, redacted logs, single instance, clean shutdown, reopen finds the same database, kill-and-recover, uninstall keeps data, reinstall finds it), `npm audit --omit=dev --audit-level=high`, no leftover processes. See [WINDOWS_LAPTOP_ACCEPTANCE.md](WINDOWS_LAPTOP_ACCEPTANCE.md) section A.

## 5. Not verified (do not read as PASS)

Installation on the target laptop; a real Windows reboot; a real power cut (only process-kill was simulated); Windows 10; native Save-as-PDF and Print dialogs (**R-093 stays open**); a physical printer; an external drive; an update over an older installed version (the logic is tested by integration tests with a real database, the installed path is not); SmartScreen and antivirus behaviour on the laptop. **R-040 stays open and production billing is not enabled.**

## 6. Test classification and the "18 tests" correction

An earlier note claimed 18 tests ran outside `verify:phase0`. That came from an arithmetic mistake of mine (a stale integration count, 667 instead of 685). Checked: all 92 test files are collected by the unit and integration projects, and the Task 1.18 gate counted 616 + 685 = 1301, equal to the full run. Nothing was outside the gate. `verify:release` runs the gate plus the new `release` project; every automated group is release-critical (see [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md)).

## 7. R-104 (load-sensitive intermittent failures)

Still monitored. In this milestone the installer test failed once in the 126-second uninstall step during a run that coincided with other heavy activity on the machine, and passed on the immediate re-run and again in the final gate; it was not "fixed" by adding time. No timeout was increased. No orphan process was left by the tests (the `verify:release` last step checks). If it recurs, treat it as an open defect and investigate the uninstall path.

## 8. Windows prerequisites

64-bit Windows 11 (Windows 10 untested); about 1 GB free disk; no administrator rights, internet, Node, npm, Docker or separately installed database; the Visual C++ runtime files are shipped inside the program.

## 9. Known install and recovery risks

R-108 (unsigned), R-109 (orphan or stale database after a crash), R-110 (credentials tied to the Windows user), R-111 (end-to-end marker), R-112 (no auto-update), R-113 (safety backups on the same computer), R-114 (target laptop untested), R-115 (antivirus), R-116 (beta PostgreSQL line, DLLs from the build computer), R-117 (size and first-start time). See RISK_REGISTER.md.

## 10. Development environment

Unchanged for developers: `npm run dev`, `db:start` and the existing tests work as before; the managed runtime is used only by the packaged application (and by tests that point `COMMERCEBILL_DATA_DIR` at a temporary folder). Old `db:start` PostgreSQL processes were not terminated (R-076).

## 11. Next recommended manual action

Copy the installer to the target laptop, verify the SHA-256, install it, and work through section B and C of WINDOWS_LAPTOP_ACCEPTANCE.md with fictional data (first the reboot test, the Save-as-PDF and Print dialogs, a real printer and an external-drive backup and restore), recording PASS/FAIL for each. Decide separately about obtaining a code-signing certificate.
