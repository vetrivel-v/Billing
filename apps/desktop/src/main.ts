import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import { APP_VERSION, type ApiAccess } from '@commercebill/shared-types';
import { parseEnv } from '@commercebill/validation';
import { generateLaunchSecret, getFreePort, startApi, type RunningApi } from './api-supervisor.js';
import { resolveAppRequest } from './app-protocol.js';
import {
  APP_ORIGIN,
  APP_SCHEME,
  WEB_PREFERENCES,
  isAllowedExternalUrl,
  isAllowedNavigation,
  isTrustedSender,
  rendererOrigin,
} from './security.js';

const devServerUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
const smoke = process.env.ELECTRON_SMOKE === '1' && !app.isPackaged;
// Dev layout: apps/desktop/dist -> apps/web/dist and apps/api/dist. Packaged layout is Phase 6 work.
const webRoot = join(__dirname, '..', '..', 'web', 'dist');
const apiEntry = join(__dirname, '..', '..', 'api', 'dist', 'main.js');

// Must run before the app is ready. A standard, secure scheme gives the renderer a real origin so the
// API's CORS allow-list can be enforced (a file:// page would send the opaque origin "null").
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

let api: RunningApi | undefined;
let launchSecret: string | undefined;

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
  win.once('ready-to-show', () => {
    if (!smoke) win.show();
  });

  if (smoke) runSmokeCheck(win);

  void win.loadURL(devServerUrl ?? `${APP_ORIGIN}/index.html`);
  return win;
}

/**
 * Verification only (unpackaged + ELECTRON_SMOKE=1): proves, from inside the real renderer, that the page
 * loads from app://, the preload bridge works, Node is not exposed, the shell-supplied secret authorises
 * API calls, calls without it get 401 AUTH_0001, and the secret never appears in the API's output.
 * The secret value itself is never returned or printed.
 */
function runSmokeCheck(win: BrowserWindow): void {
  win.webContents.once('did-finish-load', () => {
    void win.webContents
      .executeJavaScript(
        `(async () => {
          const access = await window.commercebill.getApiAccess();
          const call = async (path, withSecret) => {
            const r = await fetch(access.baseUrl + path, {
              headers: withSecret ? { 'x-commercebill-launch-secret': access.secret } : {},
            });
            let body = null;
            try { body = await r.json(); } catch { body = null; }
            return { status: r.status, code: body?.error?.code ?? null, db: body?.database?.status ?? null };
          };
          const text = (id) => document.querySelector('[data-testid="' + id + '"]')?.textContent ?? null;
          for (let i = 0; i < 60 && text('db-status') !== 'ok'; i++) {
            await new Promise((r) => setTimeout(r, 200));
          }
          return {
            origin: location.origin,
            title: document.title,
            bridge: await window.commercebill.getAppInfo(),
            nodeExposed: typeof require !== 'undefined' || typeof process !== 'undefined',
            secretLength: access.secret.length,
            baseUrlIsLoopback: access.baseUrl.startsWith('http://127.0.0.1:'),
            authorisedDb: await call('/health/db', true),
            unauthorisedDb: await call('/health/db', false),
            livenessWithoutSecret: await call('/health', false),
            ui: { api: text('api-status'), db: text('db-status') },
          };
        })()`,
      )
      .then(async (r: { nodeExposed: boolean }) => {
        await new Promise((resolve) => setTimeout(resolve, 500)); // let the API flush its request logs
        const secretInApiOutput = Boolean(
          launchSecret && api && api.output().includes(launchSecret),
        );
        // A short one-way fingerprint lets tests prove a different secret is used per launch without
        // ever printing the secret itself.
        const secretFingerprint = launchSecret
          ? createHash('sha256').update(launchSecret).digest('hex').slice(0, 16)
          : null;
        process.stdout.write(
          `SMOKE_RESULT ${JSON.stringify({ ...r, secretInApiOutput, secretFingerprint })}\n`,
        );
        await api?.stop();
        app.exit(r.nodeExposed || secretInApiOutput ? 2 : 0);
      })
      .catch(async (e: unknown) => {
        process.stderr.write(`SMOKE_FAILED ${String(e)}\n`);
        await api?.stop();
        app.exit(1);
      });
  });
  win.webContents.once('did-fail-load', () => app.exit(1));
}

function assertTrusted(event: IpcMainInvokeEvent): void {
  if (!isTrustedSender(event.senderFrame?.url, devServerUrl)) {
    throw new Error('IPC call from an untrusted sender was rejected');
  }
}

// IPC: argument-free, read-only channels; every call validates the sender frame's URL.
ipcMain.handle('app:get-info', (event) => {
  assertTrusted(event);
  return { name: 'CommerceBill Desktop', version: APP_VERSION, platform: process.platform };
});

ipcMain.handle('app:get-api-access', (event): ApiAccess => {
  assertTrusted(event);
  if (!api || !launchSecret) throw new Error('The local service is not running');
  return { baseUrl: api.baseUrl, secret: launchSecret };
});

async function startLocalApi(): Promise<void> {
  const secret = generateLaunchSecret();
  const port = await getFreePort();
  // Validate with the same schema the API uses, so a bad configuration fails here with a clear message
  // (variable names and rules only - never values).
  const env = parseEnv({
    NODE_ENV: 'production',
    API_HOST: '127.0.0.1',
    API_PORT: String(port),
    WEB_ORIGIN: rendererOrigin(devServerUrl),
    DATABASE_URL: process.env.DATABASE_URL,
    LAUNCH_SECRET: secret,
  });
  launchSecret = secret;
  api = await startApi({
    entry: apiEntry,
    port: env.API_PORT,
    secret,
    webOrigin: rendererOrigin(devServerUrl),
    databaseUrl: env.DATABASE_URL,
    logLevel: process.env.LOG_LEVEL ?? 'info',
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app.whenReady().then(async () => {
    protocol.handle(APP_SCHEME, (request) => {
      const file = resolveAppRequest(request.url, webRoot);
      if (!file) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });

    try {
      await startLocalApi();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (smoke) {
        process.stderr.write(`SMOKE_FAILED could not start the local service: ${message}\n`);
        app.exit(1);
        return;
      }
      dialog.showErrorBox(
        'CommerceBill Desktop could not start',
        `The local service failed to start. No data was changed.\n\n${message}`,
      );
      app.exit(1);
      return;
    }

    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('will-quit', () => {
    void api?.stop();
  });
  // Deny every permission request (camera, geolocation, ...) until a feature needs one.
  app.on('web-contents-created', (_e, contents) => {
    contents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  });
}
