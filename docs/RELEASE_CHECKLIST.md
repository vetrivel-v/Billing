# Release Checklist

Use before handing any installer to a person. Run on Windows from a clean, committed tree.

## 1. Automated (all of it is release-critical)

`npm run verify:release` runs, in order, and fails if any step fails:

1. `verify:phase0`: Prisma validate/generate, type-check, lint, format check, **all unit tests and all integration tests** (these include the Electron shell, Electron end-to-end, First Usable Billing journey, backup/restore, managed-runtime and migration tests) with the coverage thresholds 80/70/80/80 unchanged, and the build.
2. `npm run test:release` (project `release`): the packaged application end-to-end journey with its own managed database, and the real-installer test (install, run, close, uninstall keeps data, reinstall).
3. `npm audit --omit=dev --audit-level=high`.
4. No process left running from the build or from a test install.

Test classification: there are no "optional" automated groups. Unit, integration, Electron, FUB E2E, backup, runtime and release tests are all release-critical. (Correction recorded in the packaging report: an earlier note that 18 tests ran "outside verify:phase0" was an arithmetic slip; all 92 test files are collected and the Task 1.18 gate counted 616 + 685 = 1301 tests, equal to the full run.) R-104 (load-sensitive intermittent failures) is still monitored: a failure is investigated, never "fixed" by raising timeouts or weakening a test.

## 2. Build

- [ ] `npm run package:win` (full build, then installer) completes.
- [ ] `release/installer-info.json` shows the expected version, size, SHA-256 and `signed` flag. Record them in the packaging report.
- [ ] No installer, database, log, backup or secret is staged for git.
- [ ] If a certificate exists: build with `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`, then `Get-AuthenticodeSignature` must say `Valid` for the installer and `CommerceBill.exe`. Without one the build is, and is described as, UNSIGNED.

## 3. Manual (see WINDOWS_LAPTOP_ACCEPTANCE.md; each is NOT TESTED until a person does it)

- [ ] Install on the target laptop; SmartScreen, shortcuts, first launch.
- [ ] Real reboot test; unclean power-off test.
- [ ] Native Save-as-PDF and Print dialogs (closes R-093 only when done); physical printer.
- [ ] External drive backup, verify and restore.
- [ ] Update over a previous version (pre-upgrade backup appears).
- [ ] Uninstall keeps data; reinstall finds it.

## 4. Not to be changed by a release

R-040 stays open; production billing is not enabled by installing. Fictional data only in testing. Thresholds and the production gate unchanged.
