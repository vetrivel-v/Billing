# Administrator Guide

For the person who runs CommerceBill Desktop for a business. Fictional examples only.

## Your responsibilities

- Create and verify backups, and keep them off this computer ([BACKUP_AND_RESTORE.md](BACKUP_AND_RESTORE.md)).
- Keep the backup passphrase safe and separate from the backup files.
- Decide who can sign in, and what each person may do. Roles are Administrator, Accountant, Billing Operator, Warehouse Operator and Viewer/Auditor.
- Keep the tax configuration reviewed. The tax rates shipped with the product are placeholders until a qualified professional has reviewed them; passing tests does not make them correct.

## Backup and recovery at a glance

| Who                                  | Can                                                                   |
| ------------------------------------ | --------------------------------------------------------------------- |
| Administrator                        | Choose the folder, create, verify, set retention, restore             |
| Accountant, Viewer/Auditor           | See the backup history, the status and the production readiness panel |
| Billing Operator, Warehouse Operator | Nothing in Backup & Recovery (the Settings entry may not even appear) |

The **Production readiness** panel (Settings, Backup & Recovery) lists the four things real billing needs: tax configuration reviewed and current, seller GST registration recorded and valid, HSN/SAC policy set, and backup and recovery verified. It only reports. Switching to real billing is a separate, deliberate step on the Tax page.

## Routine

| When                           | What                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Every working day you bill     | Make a backup at close of business, verified. Copy it to the external drive.                         |
| Weekly                         | Check the history shows a recent "Verified"; remove old copies from the drive you no longer need.    |
| After updating the application | Make and verify a new backup (the readiness panel turns "not verified" after an update, on purpose). |
| Monthly                        | Open one backup with **Choose backup file** and check the business and date, then Cancel.            |

## What the application records

Every backup, verification, retention change and restore writes an audit row with facts only (who, when, which file name, the outcome, the names of failed checks). The passphrase, any key and any business data are never written to the audit trail or to the logs.

## When something looks wrong

See [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md).

## Running the installed application (Windows)

- **Where things are.** Program: `%LOCALAPPDATA%\Programs\CommerceBill`. Business data, settings and logs: `%LOCALAPPDATA%\CommerceBill`. Never delete, move or edit the data folder by hand; uninstalling the program leaves it in place on purpose.
- **Start and stop.** Open from the shortcut; close with the window's X and wait for it to close. The database starts and stops with the program. Do not end `postgres.exe` in Task Manager while the program is open.
- **About & Diagnostics** (Settings): versions, whether the database and service are running, the data folder, and **Save diagnostics** (no passwords, no business data). Administrators can also show the passphrase of the safety backups.
- **Updating.** Run the newer installer over the old one. Before changing the database the program makes and verifies a safety backup in `backups\pre-upgrade`; if that fails it stops and changes nothing. Keep the passphrase of safety backups somewhere safe.
- **Moving to another computer.** Do not copy the data folder (its password is bound to the Windows user). Make a verified backup, install on the new computer, and restore.
- **If it will not start**, read TROUBLESHOOTING.md; never delete the data folder.
