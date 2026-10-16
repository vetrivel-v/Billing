import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { APP_VERSION } from '@commercebill/shared-types';
import { WEB_PREFERENCES, isAllowedExternalUrl, isAllowedNavigation } from './security.js';

const devServerUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    title: 'CommerceBill Desktop',
    webPreferences: { ...WEB_PREFERENCES, preload: join(__dirname, 'preload.cjs') },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, devServerUrl)) event.preventDefault();
  });
  win.once('ready-to-show', () => win.show());

  if (process.env.ELECTRON_SMOKE === '1' && !app.isPackaged) runSmokeCheck(win);

  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(join(__dirname, '..', '..', 'web', 'dist', 'index.html'));
  }
  return win;
}

/** Phase 0 verification only: confirms the page loads, the preload bridge works, and Node is not exposed. */
function runSmokeCheck(win: BrowserWindow): void {
  win.webContents.once('did-finish-load', () => {
    void win.webContents
      .executeJavaScript(
        `(async () => ({
          bridge: await window.commercebill.getAppInfo(),
          nodeExposed: typeof require !== 'undefined' || typeof process !== 'undefined',
          title: document.title,
        }))()`,
      )
      .then((r: { nodeExposed: boolean }) => {
        process.stdout.write(`SMOKE_RESULT ${JSON.stringify(r)}\n`);
        app.exit(r.nodeExposed ? 2 : 0);
      })
      .catch((e: unknown) => {
        process.stderr.write(`SMOKE_FAILED ${String(e)}\n`);
        app.exit(1);
      });
  });
  win.webContents.once('did-fail-load', () => app.exit(1));
}

// IPC: single, argument-free, read-only channel. No arbitrary renderer input is accepted.
ipcMain.handle('app:get-info', () => ({
  name: 'CommerceBill Desktop',
  version: APP_VERSION,
  platform: process.platform,
}));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  // Deny every permission request (camera, geolocation, ...) until a feature needs one.
  app.on('web-contents-created', (_e, contents) => {
    contents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  });
}
