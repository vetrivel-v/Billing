/**
 * Electron-bound half of the backup choosers (Task 1.17). Coverage: this file opens native dialogs, so it is verified by the Electron
 * smoke check (with the dialogs replaced by hooks); its decisions live in backup-ipc.ts, which is unit-tested.
 */
import { dialog, type BrowserWindow } from 'electron';

/** Verification only (set by the unpackaged ELECTRON_BACKUP_SMOKE check): the answers the native dialogs would give. */
export interface BackupDialogHooks {
  folder?: string | undefined;
  /** Evaluated when the restore-file chooser opens, because the backup file does not exist until the smoke has created it. */
  file?: (() => string | undefined) | undefined;
}
let hooks: BackupDialogHooks = {};
export function setBackupDialogHooks(h: BackupDialogHooks): void {
  hooks = h;
}

export async function chooseFolder(parent: BrowserWindow | null): Promise<string | undefined> {
  if (hooks.folder !== undefined) return hooks.folder;
  const options = {
    title: 'Choose a folder for CommerceBill backups',
    properties: ['openDirectory' as const, 'createDirectory' as const],
  };
  const r = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  return r.canceled ? undefined : r.filePaths[0];
}

export async function chooseBackupFile(parent: BrowserWindow | null): Promise<string | undefined> {
  if (hooks.file !== undefined) return hooks.file();
  const options = {
    title: 'Choose a CommerceBill backup to restore',
    properties: ['openFile' as const],
    filters: [{ name: 'CommerceBill backup', extensions: ['cbbackup'] }],
  };
  const r = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  return r.canceled ? undefined : r.filePaths[0];
}
