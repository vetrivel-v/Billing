# Backup and Restore

How CommerceBill Desktop backs up the business data and proves a backup can be restored. Design and reasoning: [ADR-0027](adr/0027-backup-format-and-verified-recovery.md). If something has gone wrong, go to [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md).

**A backup protects you only if two things are true: it has been verified, and it is kept somewhere other than this computer.** A copy on the same disk does not survive a stolen, burnt or dead computer.

## What a backup is

- One file ending in `.cbbackup`, named `CommerceBill-<date>-<time>-<id>.cbbackup`, in the folder you choose.
- It holds every business record: customers, products, stock history, tax configuration, invoices, payments, document numbers, the audit history and the settings. It does **not** hold sign-in sessions, so nobody stays signed in after a restore.
- It is encrypted with a passphrase **you** type. Without the passphrase it cannot be read, by anyone.
- It is made from a consistent snapshot while the application keeps running. Invoices posted while a backup runs are simply not in that backup.
- Nothing is uploaded anywhere.

## The passphrase

- At least 12 characters (spaces are fine; a sentence is a good passphrase). You type it twice.
- It is never stored, logged or shown again. **Nobody can recover it, including the makers of CommerceBill.** If you lose it, that backup is lost for ever.
- Keep it somewhere other than the backup (a password manager, a sealed note in a safe). Using a different passphrase for each backup makes recovery harder, not safer, for a small business: choose one strong passphrase and keep it safe.

## Making a backup (Settings, Backup & Recovery)

1. Choose the backup folder once (**Choose folder**). The screen shows the folder's name only.
2. Enter and confirm the passphrase. Leave **Verify after creating** ticked.
3. **Create backup**. Billing keeps working. When it finishes you see "Backup created" and, if you verified, whether every check passed.
4. Copy the file to an external drive or another safe place, regularly. The application does this for you in no way.

## Verifying (the important part)

A backup is **verified** only when CommerceBill has restored it into a separate, temporary database and checked it: the structure version, the records, every link between records, the safety rules, that stock balances agree with the stock history, that invoice and payment numbers were all issued, that invoice totals equal their lines, that payments add up, that demo and real data are kept apart, and that the restored data is identical to the backup. The temporary database is then removed. Your live data is never touched.

- **Verify now** on any backup in the history repeats this (you need that backup's passphrase).
- A wrong passphrase or a damaged or changed file is reported as such and is not recorded as a result.
- A failed check records **Verification failed**. Do not rely on that backup; create a new one and investigate.

### How verification relates to real billing

The production readiness panel lists what must be true before real invoices can be issued, including "Backup and recovery verified". That requirement is met only while the latest verification passed, was made for the current database structure and this database, and is at most 30 days old. A later update of the application, a restore, a failed verification or simply the passing of time makes it unmet again. Verifying a backup **does not switch on real billing**. That is a separate step on the Tax page, and it also needs the tax configuration review (the tax rates in the product are placeholders until a qualified professional has reviewed them).

## Keeping backups

You may set how many verified backups to keep. Older backup files are then removed from the folder, but never the most recent verified backup, never a backup that was not verified, and never any file the application did not create. Leave the field empty to keep everything.

## Restoring (administrator only)

Restore is for recovering data, for example after a computer problem. It **replaces** the current data with the backup: everything entered after the backup was made is replaced.

1. **Choose backup file**, enter that backup's passphrase, **Open backup**. You see which business, when it was made, how much it holds and whether it was verified here.
2. A backup of a different business, or made by a different version of CommerceBill, is refused.
3. Type `RESTORE` and press **Restore now**. Billing pauses. CommerceBill first saves and checks a **safety backup** of your current data (with the same passphrase), then restores. If anything fails, your current data is untouched.
4. When it completes everyone is signed out and signs in again. Real billing stays unavailable until a new backup is verified, because the restored database is a different database.
5. The previous database is kept on disk, renamed, until you remove it (see the disaster recovery guide).

## Limits

Scheduled and automatic backups, cloud storage, point-in-time recovery and recovering a lost passphrase do not exist. Attachments are not part of backups yet (none exist). The folder and file choosers and the printer are operating-system dialogs; automated checks replace them with stand-ins, and no external drive has been tested (R-093, R-103).

## Safety backups before an update (installed application)

When a newer version of CommerceBill needs to change the database structure, it first writes a backup of its own into `%LOCALAPPDATA%\CommerceBill\backups\pre-upgrade` and verifies it by restoring it into a throw-away database. Only then is the database updated. The newest five are kept. Their passphrase is generated by the program and is shown to an administrator under Settings, About & Diagnostics. These are an extra safety net, not a replacement for your own backups on an external drive: they live on the same computer (R-113). They can be restored with the normal restore function using that passphrase.

If the computer, the Windows profile or the data folder is lost, only a backup kept elsewhere can bring the business back: install CommerceBill on the new computer, then restore (R-097, R-110).
