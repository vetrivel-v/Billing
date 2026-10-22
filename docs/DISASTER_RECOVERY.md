# Disaster Recovery

What to do when the data is damaged, the computer is lost or a backup must be used. Read [BACKUP_AND_RESTORE.md](BACKUP_AND_RESTORE.md) first for the concepts. Fictional examples only.

## Before anything goes wrong (do this now)

- [ ] A backup folder is chosen and a backup has been made and **verified** this month.
- [ ] Backup files are copied to an external drive or another place that is not this computer, at least weekly.
- [ ] The passphrase is stored away from the backup files.
- [ ] You know who the administrator is. Only an administrator can restore.

## Scenario 1: the data looks wrong but the computer works

1. Stop entering data. Do not restore yet.
2. Make a new backup now (it may be needed to compare), and verify it.
3. Decide which backup is the last good one (by date, in the history).
4. Restore it (BACKUP_AND_RESTORE.md, "Restoring"). A safety backup of the current state is made first, so the restore itself is reversible by restoring that safety backup.
5. Re-enter what was done after that backup's date. Invoice and payment numbers continue from the restored state, so a number issued after the backup (on paper or to a customer) will be issued again: check any printed or sent documents from that period before issuing new ones.

## Scenario 2: the computer is lost, stolen or broken

1. Install CommerceBill Desktop on the new computer and complete first-run setup (the business name must be the same business). Create the administrator.
2. Copy the newest `.cbbackup` file from your external drive or other safe place to the new computer.
3. In Settings, Backup & Recovery choose **Choose backup file**, enter the passphrase, **Open backup**. Confirm it is the right business and date. Type `RESTORE`.
4. Sign in again with the users from the backup. Verify a fresh backup before relying on the new installation.

## Scenario 3: the passphrase is lost

The backup cannot be opened and nobody can open it. Use an older backup whose passphrase you still have. Record the loss, then make a new backup with a passphrase you will keep.

## Scenario 4: verification failed

Do not rely on that backup. Create a new backup and verify it. If verification fails again, the live data may have a problem: stop issuing real documents, keep the failed backup file and the application's logs, and ask whoever supports your installation. The failing check names tell them where to look; no business data is in them.

## Scenario 5: a restore did not complete

Your data before the restore is unchanged (the application reports "Your current data was kept"). A safety backup exists in the history if the failure happened late. Close and reopen CommerceBill and check the history before trying again. If the application will not start, see Scenario 6.

## Scenario 6: the application will not start after a restore attempt

The previous database is renamed, not deleted (a name ending `_pre_restore_<date>_<id>`). A support person with access to the database server can rename it back. Until then, restore the safety backup on a fresh installation (Scenario 2).

## After a restore

- Everyone signs in again (sessions are not restored).
- Real billing is unavailable until a new backup is verified.
- Remove the kept previous database only when you are sure it is no longer needed (it holds the data as it was before the restore). Its removal is a support task; the application never deletes it on its own.

## What this cannot do

It cannot recover data that was never backed up, a backup whose passphrase is lost, or a backup kept only on a computer that is gone. It does not restore to a point in time between backups.
