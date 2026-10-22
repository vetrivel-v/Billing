# Troubleshooting

First try the plain things: wait one minute, press **Try again** in the message, close and reopen the program. **Never delete the folder `%LOCALAPPDATA%\CommerceBill`** to "fix" a problem: it holds your business. If a message offers **Save diagnostics**, save the file and send it to the support person; it contains no passwords and no business data.

## Messages on start-up

The program shows a window with the buttons **Try again**, **Save diagnostics...**, **Open log folder**, **Quit**. The log folder is `%LOCALAPPDATA%\CommerceBill\logs` (`app.log`, `postgres.log`, `api.log`).

| What you see (code)                                                                                      | Meaning                                                                                                                          | What to do                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The database could not be started (`DB_START_FAILED` / `DB_START_TIMEOUT`)                               | The private database did not come up in time (slow disk, antivirus scanning, a leftover process)                                 | Try again. If it repeats, restart the computer, then try again. Send diagnostics.                                                                                                                                                                     |
| Credentials cannot be read (`SECRETS_UNAVAILABLE`, `CREDENTIALS_MISSING`)                                | Windows could not unlock the stored database password: a different Windows user or a reset Windows profile                       | Sign in to Windows as the same user who installed it. If the profile was reset, your data can only be recovered by **restoring a backup** (see below). Do not reinstall over it yet; send diagnostics.                                                |
| Data is missing (`DATA_MISSING`, `DB_MISSING`, `CONFIG_MISSING`)                                         | The program recorded a database before but it is not there now. It deliberately does **not** create a new empty one over the top | Do not delete anything. Check whether `%LOCALAPPDATA%\CommerceBill\data\pg` exists and whether a cleaning tool or a backup/restore of the Windows profile removed it. Restore your latest backup into a fresh installation if the data is truly gone. |
| The database is newer than this program (`DB_NEWER`)                                                     | An older version was installed over a newer one                                                                                  | Install the newer version again. Never use an older version on newer data.                                                                                                                                                                            |
| The update could not be completed (`PRE_UPGRADE_BACKUP_FAILED`, `MIGRATION_FAILED`, `VALIDATION_FAILED`) | The safety backup or the structure update failed; nothing was changed or lost, and the program refuses to start normally         | Send diagnostics. Keep the safety backups in `backups\pre-upgrade`. Go back to the previous version's installer if told to.                                                                                                                           |
| Program files are missing (`BINARIES_MISSING`)                                                           | The installation is damaged (often antivirus quarantine)                                                                         | Run the installer again (data is kept).                                                                                                                                                                                                               |

## Other situations

- **"CommerceBill is already running"**: it is open (maybe minimised, or still closing). Look in the taskbar. After a crash, wait 30 seconds and open it again; it recovers the database by itself.
- **A black window appears**: it should not. Report it with the diagnostics file.
- **SmartScreen "Windows protected your PC"**: expected for the unsigned acceptance build; see WINDOWS_INSTALLATION.md.
- **The save/print window does not appear**: see the manual checks in WINDOWS_LAPTOP_ACCEPTANCE.md; report what you see.
- **Backup or verification fails**: read the message; check free disk space and that the external drive is connected. The previous good backups remain valid.
- **Restoring data**: Settings, Backup & Recovery (administrators). See BACKUP_AND_RESTORE.md.

## For the support person

- Logs are redacted; `postgres.log` shows database messages; `app.log` shows the start-up decision (`database ready (fresh|existing ...)`).
- `config\runtime-status.json` shows the state, the loopback port numbers and process ids (no secrets).
- A database left running after a crash: `postmaster.pid` in `data\pg`; the program cleans it up on the next start. Do not end `postgres.exe` by hand unless the program is closed.
- To check what listens on the network: only `127.0.0.1` ports belonging to `postgres.exe` and `CommerceBill.exe` should appear (`Get-NetTCPConnection -State Listen`).
