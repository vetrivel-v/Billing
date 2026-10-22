# Windows Laptop Acceptance

Build under test: CommerceBill 0.1.0, `CommerceBill-Setup-0.1.0.exe` (unsigned acceptance build). Exact size and SHA-256 are in `release/installer-info.json` and the packaging report.

Status values: **PASS** (a person or an automated test did it and it worked), **FAIL**, **NOT TESTED**. Nothing below is marked PASS unless it really happened. "Automated" means done by `npm run verify:release` on the development computer (Windows 11), **not** on the target laptop.

## A. Verified automatically on the development computer (Windows 11)

| #   | Check                                                                                                                                                                                                               | Status              | Evidence                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------- |
| A1  | Real installer installs silently to a folder, no elevation                                                                                                                                                          | PASS (automated)    | `tests/release/installer.rel.test.ts`    |
| A2  | Program files, bundled PostgreSQL, service, web UI, migrations present                                                                                                                                              | PASS (automated)    | same                                     |
| A3  | Desktop and Start-menu shortcuts exist and point at `CommerceBill.exe`; uninstall entry registered                                                                                                                  | PASS (automated)    | same                                     |
| A4  | First launch from empty data creates the private database; the window opens                                                                                                                                         | PASS (automated)    | same                                     |
| A5  | No terminal window (only the application's own window; the database's console host is hidden)                                                                                                                       | PASS (automated)    | same                                     |
| A6  | Database and service listen on 127.0.0.1 only; not reachable on this computer's LAN addresses                                                                                                                       | PASS (automated)    | same                                     |
| A7  | Logs are written and carry no connection password                                                                                                                                                                   | PASS (automated)    | same                                     |
| A8  | A second launch does not start a second copy                                                                                                                                                                        | PASS (automated)    | same                                     |
| A9  | Closing the window stops service and database cleanly; no process left                                                                                                                                              | PASS (automated)    | same                                     |
| A10 | Reopening finds the same database (not a new one)                                                                                                                                                                   | PASS (automated)    | same                                     |
| A11 | Killing the application: the service ends by itself; the next launch recovers the same database                                                                                                                     | PASS (automated)    | same                                     |
| A12 | Uninstall removes program, shortcuts and entry and keeps the data; reinstall finds the data, setup not re-run                                                                                                       | PASS (automated)    | same                                     |
| A13 | First Usable Billing journey in the packaged application with its own database: setup, customer, product, stock, tax review, DEMO invoice, PDF, payments, dashboard, verified backup; second launch sees everything | PASS (automated)    | `tests/release/packaged-e2e.rel.test.ts` |
| A14 | Pre-upgrade verified backup, migration failure blocks start, never recreates a missing database                                                                                                                     | PASS (automated)    | `tests/integration/runtime.int.test.ts`  |
| A15 | Installer is NOT signed (honest state)                                                                                                                                                                              | PASS (as described) | `Get-AuthenticodeSignature` = NotSigned  |

## B. Must be performed on the wife's laptop (and where stated, by a person)

| #   | Check                                                                                               | Status     | Notes                                  |
| --- | --------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------- |
| B1  | Copy installer to the laptop; SHA-256 matches                                                       | NOT TESTED |                                        |
| B2  | SmartScreen behaviour as described; installs without an administrator prompt                        | NOT TESTED |                                        |
| B3  | Shortcuts start the app; first launch completes (record the time)                                   | NOT TESTED |                                        |
| B4  | No firewall prompt; antivirus does not quarantine or block                                          | NOT TESTED |                                        |
| B5  | First-run setup with fictional data; sign out and in                                                | NOT TESTED |                                        |
| B6  | Invoice journey (customer, product, stock, DEMO invoice, payment, dashboard)                        | NOT TESTED |                                        |
| B7  | **Real reboot test**: leave the app closed normally, restart Windows, open again, data present      | NOT TESTED | Not performed by the developer.        |
| B8  | **Real unclean power-off / crash** of Windows while the app is open; next start recovers            | NOT TESTED | Only process-kill was simulated (A11). |
| B9  | Close with the X, then confirm in Task Manager that no `postgres.exe` or `CommerceBill.exe` remains | NOT TESTED |                                        |
| B10 | Update: install a later version over this one; safety backup appears in the data folder             | NOT TESTED | Needs a second version.                |
| B11 | Uninstall from Settings; data folder kept; reinstall finds it                                       | NOT TESTED | A12 covered the silent path only.      |
| B12 | Windows 10 (if relevant)                                                                            | NOT TESTED |                                        |

## C. Manual checks that automation cannot perform

| #   | Check                                                                                                                                  | Status     | Notes                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------- |
| C1  | **Native Save-as-PDF dialog** (R-093): choose a name and folder, file is written, opens in a PDF viewer                                | NOT TESTED | R-093 stays open until done. |
| C2  | **Native Print dialog** (R-093)                                                                                                        | NOT TESTED |                              |
| C3  | **Physical printer**: A4 print, margins, text readable, DEMO marking visible                                                           | NOT TESTED | No printer PASS is claimed.  |
| C4  | **External drive**: choose the drive in the backup folder chooser, make and verify a backup, unplug and replug, restore test on a copy | NOT TESTED |                              |
| C5  | Backup, then restore on the laptop, into the real installed application                                                                | NOT TESTED |                              |
| C6  | Screen sizes and display scaling of the laptop (125 %, 150 %)                                                                          | NOT TESTED |                              |
| C7  | Safety passphrase dialog (administrator) and diagnostics export open and save through native dialogs                                   | NOT TESTED |                              |

## Sign-off

Tested by: ____________ Date: ____________ Laptop / Windows version: ____________

Open obligations that no test here closes: R-040 (tax data review), R-093, R-097, R-105, R-108.
