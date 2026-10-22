/**
 * Electron-bound half of the installed runtime (Windows packaging). Coverage: this file uses Electron's safeStorage and native dialogs, so
 * it is verified by the installer smoke test and the manual laptop acceptance; its decisions live in runtime/*.ts, which are tested.
 */
import { writeFile } from 'node:fs/promises';
import { app, BrowserWindow, dialog, safeStorage, shell } from 'electron';
import type { RuntimePaths } from './runtime/paths.js';
import type { SecretCipher } from './runtime/secrets.js';
import type { StartupError } from './runtime/startup.js';

/** Windows protects the stored credentials for this Windows user (DPAPI behind safeStorage). */
export const electronCipher: SecretCipher = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (data) => safeStorage.decryptString(data),
};

export const localAppDataDir = (): string => process.env.LOCALAPPDATA ?? app.getPath('appData');

/** Verification hooks for the native dialogs (set only by the unpackaged end-to-end modes). */
export interface RuntimeDialogHooks {
  failureChoice?: (() => 'retry' | 'quit') | undefined;
}
let hooks: RuntimeDialogHooks = {};
export function setRuntimeDialogHooks(h: RuntimeDialogHooks): void {
  hooks = h;
}

/**
 * The start-up failure dialog: plain words, no console output, no raw database text. Returns what the person chose; "diagnostics" and
 * "logs" are handled here and the dialog is shown again.
 */
export async function showStartupFailure(
  err: StartupError | Error,
  diagnosticsText: () => Promise<string>,
  paths: RuntimePaths,
): Promise<'retry' | 'quit'> {
  if (hooks.failureChoice) return hooks.failureChoice();
  const message = 'userMessage' in err ? err.userMessage : "CommerceBill couldn't start.";
  const hint = 'hint' in err ? err.hint : 'Close CommerceBill and try again.';
  for (;;) {
    const r = await dialog.showMessageBox({
      type: 'error',
      title: 'CommerceBill',
      message,
      detail: `${hint}\n\nLog folder: ${paths.logsDir}`,
      buttons: ['Try again', 'Save diagnostics...', 'Open log folder', 'Quit'],
      defaultId: 0,
      cancelId: 3,
      noLink: true,
    });
    if (r.response === 0) return 'retry';
    if (r.response === 3) return 'quit';
    if (r.response === 2) {
      await shell.openPath(paths.logsDir);
      continue;
    }
    await saveDiagnosticsDialog(null, await diagnosticsText());
  }
}

export async function saveDiagnosticsDialog(
  parent: BrowserWindow | null,
  text: string,
): Promise<'saved' | 'cancelled' | 'failed'> {
  const options = {
    title: 'Save CommerceBill diagnostics',
    defaultPath: `CommerceBill-diagnostics-${new Date().toISOString().slice(0, 10)}.txt`,
    filters: [{ name: 'Text file', extensions: ['txt'] }],
  };
  const r = parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options);
  if (r.canceled || !r.filePath) return 'cancelled';
  try {
    await writeFile(r.filePath, text, 'utf8');
    return 'saved';
  } catch {
    return 'failed';
  }
}

export async function showSafetyPassphraseDialog(passphrase: string): Promise<void> {
  await dialog.showMessageBox({
    type: 'info',
    title: 'CommerceBill safety backup passphrase',
    message: 'Passphrase of the safety backups made before an update',
    detail: `${passphrase}\n\nPress Ctrl+C to copy this text. Keep it somewhere safe and separate from the backup files. It is needed only to restore a safety backup made before an update.`,
    buttons: ['Close'],
    noLink: true,
  });
}

/**
 * A small "starting" window shown while the local database starts (the first launch can take half a minute). It loads one fixed page
 * from a data: URL, has no preload, no Node, no navigation and no way for a page to open anything.
 */
export function showSplash(): BrowserWindow {
  const html =
    '<!doctype html><meta charset="utf-8"><title>CommerceBill</title><body style="margin:0;font-family:Segoe UI,sans-serif;background:#0f6f8f;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh">' +
    '<div style="font-size:26px;font-weight:600">CommerceBill</div><div style="margin-top:10px;font-size:14px;opacity:.9">Starting your local database...</div></body>';
  const win = new BrowserWindow({
    width: 420,
    height: 180,
    frame: false,
    resizable: false,
    movable: true,
    show: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    title: 'CommerceBill',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      webSecurity: true,
    },
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return win;
}
