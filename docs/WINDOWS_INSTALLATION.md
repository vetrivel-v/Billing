# Windows Installation Guide

Applies to CommerceBill 0.1.0 (acceptance build). Windows 11 is the primary target; Windows 10 (64-bit) is expected to work but has NOT been tested.

CommerceBill runs entirely on this one computer. It needs **no internet, no Node, no npm, no Docker, no database server you install yourself, and no administrator rights.**

## Before you install

- A 64-bit Windows computer with about 1 GB free (the program is about 0.45 GB installed; your data grows with use).
- The installer file `CommerceBill-Setup-0.1.0.exe`. Check its fingerprint against the one you were given (see "Check the installer").
- Close any older copy of CommerceBill.

## Check the installer

In PowerShell: `Get-FileHash .\CommerceBill-Setup-0.1.0.exe -Algorithm SHA256` and compare with the value in `release\installer-info.json` (or the one the person who built it gave you). If it differs, do not install.

## Install

1. Double-click `CommerceBill-Setup-0.1.0.exe`.
2. **This build is not code-signed.** Windows SmartScreen may show "Windows protected your PC". If you got the file from the person you trust and the fingerprint matches, choose **More info**, then **Run anyway**. (A signed build shows the publisher instead; see RELEASE_CHECKLIST.md.)
3. Choose the install folder (the default is fine) and press **Install**. No administrator prompt appears.
4. Leave "Run CommerceBill" ticked and press **Finish**. The first start takes up to about half a minute while the private local database is created; a small "starting" window is shown.
5. Follow the first-run setup in the application (business name, administrator account, ...). Use your own real business details only once you have been told production billing may be enabled; until then use fictional data (R-040).

You get a **CommerceBill** shortcut on the Desktop and in the Start menu. They start the program directly; no black window appears.

## Where things are

| What                                              | Where                                                            |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| Program                                           | `%LOCALAPPDATA%\Programs\CommerceBill` (or the folder you chose) |
| Business database, settings, logs, safety backups | `%LOCALAPPDATA%\CommerceBill`                                    |
| Your own backups                                  | a folder you choose (ideally an external drive)                  |

Paste `%LOCALAPPDATA%\CommerceBill` into the File Explorer address bar to open the data folder. Do not edit or delete files in it.

## Updating to a newer version

Run the newer `CommerceBill-Setup-x.y.z.exe`. Your data is kept. On the first start the program makes a **verified safety backup** of your data and only then updates the database structure. If that fails it stops with a message and changes nothing; see TROUBLESHOOTING.md. The passphrase of safety backups is shown in Settings, About & Diagnostics (administrators).

## Uninstall

Settings, Apps, Installed apps, CommerceBill, Uninstall. This removes the program and its shortcuts. **Your business data is NOT deleted** and is found again if you reinstall. To delete the data for good, first make a backup if you may need it, close CommerceBill, then delete the folder `%LOCALAPPDATA%\CommerceBill` yourself.

## Windows requirements the installer handles

- The Visual C++ runtime files PostgreSQL needs are shipped inside the program; you do not install a Redistributable.
- The database listens only on this computer (127.0.0.1). No Windows Firewall rule is added and none is needed. If Windows asks to allow CommerceBill through the firewall, choose **Cancel / Don't allow**: it needs no network access (report it, because it should not happen).
- Antivirus: some products are slow to scan the first start of an unsigned program. Wait for it; do not disable protection.

## Not supported in this build

Network or shared-drive data folders, more than one computer using the same data, remote access, automatic updates, and running as a Windows service.
