import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import {
  APP_VERSION,
  type ApiAccess,
  type Diagnostics,
  type DocumentOutputResult,
} from '@commercebill/shared-types';
import { parseEnv } from '@commercebill/validation';
import { generateLaunchSecret, getFreePort, startApi, type RunningApi } from './api-supervisor.js';
import { resolveAppRequest } from './app-protocol.js';
import {
  DOCUMENT_CHANNELS,
  looksLikePdf,
  pdfPageCount,
  prepareDocumentRequest,
} from './document-ipc.js';
import { BACKUP_CHANNELS, registerChosenPath } from './backup-ipc.js';
import { chooseBackupFile, chooseFolder, setBackupDialogHooks } from './electron-backup.js';
import { printInvoice, renderPdf, saveInvoicePdf, setOutputHooks } from './electron-document.js';
import {
  electronCipher,
  localAppDataDir,
  saveDiagnosticsDialog,
  showSafetyPassphraseDialog,
  showSplash,
  showStartupFailure,
} from './electron-runtime.js';
import {
  collectDiagnostics,
  formatDiagnostics,
  writeRuntimeStatus,
} from './runtime/diagnostics.js';
import { AppLog } from './runtime/logger.js';
import {
  resolveDevResources,
  resolvePackagedResources,
  resolveRuntimePaths,
  type ResourceDirs,
  type RuntimePaths,
} from './runtime/paths.js';
import { loadSecrets } from './runtime/secrets.js';
import { StartupError, startRuntime, type RuntimeHandle } from './runtime/startup.js';
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
// Verification only: drive the real Billing screens in the real renderer (see runDocumentSmoke).
const docSmoke = process.env.ELECTRON_DOC_SMOKE === '1' && !app.isPackaged;
// Verification only: drive the real Backup & Recovery screens in the real renderer (see runBackupSmoke).
const backupSmoke = process.env.ELECTRON_BACKUP_SMOKE === '1' && !app.isPackaged;
// Verification only: the First Usable Billing end-to-end check (see runE2e).
// (an installed build honours it only when the packager added the e2e-enabled marker: the release installer never has it)
const e2e =
  process.env.ELECTRON_E2E === '1' &&
  (!app.isPackaged || existsSync(join(process.resourcesPath, 'e2e-enabled')));
// Verification only: render one invoice snapshot to PDF and exit (no window, no API). See runPdfSmoke.
const pdfSmoke = !app.isPackaged && Boolean(process.env.ELECTRON_PDF_FIXTURE);
// The installed application (or COMMERCEBILL_MANAGED_DB=1 in a build run from the project folder) owns a private local PostgreSQL: it
// starts it, finds or creates the data, upgrades it safely and stops it (ADR-0029). Otherwise DATABASE_URL names a database (development
// and the automated checks).
const managed = app.isPackaged || process.env.COMMERCEBILL_MANAGED_DB === '1';
// Installed layout: resources next to the executable. Development layout: apps/desktop/dist -> the repository root.
const resources: ResourceDirs = app.isPackaged
  ? resolvePackagedResources(process.resourcesPath)
  : resolveDevResources(join(__dirname, '..', '..', '..'));
const webRoot = resources.webRoot;
const apiEntry = resources.apiEntry;

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
let mainWindow: BrowserWindow | undefined;
let runtimePaths: RuntimePaths | undefined;
let appLog: AppLog | undefined;
let runtimeHandle: RuntimeHandle | undefined;
let startupProblem: { code: string; message: string } | null = null;
/** The shell's own secret for the backup choosers; the renderer never receives it. */
let controlSecret: string | undefined;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    title: 'CommerceBill Desktop',
    // No developer tools in the installed application.
    webPreferences: {
      ...WEB_PREFERENCES,
      devTools: !app.isPackaged,
      preload: join(__dirname, 'preload.cjs'),
    },
  });
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = undefined;
  });
  // Windows is logging off or shutting down: the database is stopped cleanly if there is time (otherwise crash recovery runs next start).
  win.on('session-end', () => {
    try {
      runtimeHandle?.postgres.stopSync();
    } catch {
      // nothing more can be done
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, devServerUrl)) event.preventDefault();
  });
  win.once('ready-to-show', () => {
    if (!smoke && !docSmoke && !backupSmoke && !e2e) win.show();
  });

  if (smoke) runSmokeCheck(win);
  if (docSmoke) runDocumentSmoke(win);
  if (backupSmoke) runBackupSmoke(win);
  if (e2e) runE2e(win);

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
          // The first screen is chosen from the renderer's own call to the launch-secret-protected /setup/status.
          const screen = () => document.querySelector('h1')?.textContent ?? null;
          for (let i = 0; i < 60 && screen() === null; i++) {
            await new Promise((r) => setTimeout(r, 200));
          }
          return {
            origin: location.origin,
            title: document.title,
            bridge: await window.commercebill.getAppInfo(),
            bridgeKeys: Object.keys(window.commercebill).sort(),
            badSavePayload: await window.commercebill.saveInvoicePdf({ not: 'an invoice' }).then(() => 'resolved', () => 'rejected'),
            badPrintPayload: await window.commercebill.printInvoice('<script>').then(() => 'resolved', () => 'rejected'),
            nodeExposed: typeof require !== 'undefined' || typeof process !== 'undefined',
            secretLength: access.secret.length,
            baseUrlIsLoopback: access.baseUrl.startsWith('http://127.0.0.1:'),
            authorisedDb: await call('/health/db', true),
            unauthorisedDb: await call('/health/db', false),
            livenessWithoutSecret: await call('/health', false),
            ui: { screen: screen() },
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
        await shutdownAll();
        app.exit(r.nodeExposed || secretInApiOutput ? 2 : 0);
      })
      .catch(async (e: unknown) => {
        process.stderr.write(`SMOKE_FAILED ${String(e)}\n`);
        await shutdownAll();
        endProcess(1);
      });
  });
  win.webContents.once('did-fail-load', () => endProcess(1));
}

/**
 * Verification only (unpackaged + ELECTRON_DOC_SMOKE=1, test credentials in the environment): production-like check of the
 * Billing document flow in the REAL renderer served from app://, against the REAL API and database: sign in, open the invoice
 * list and an invoice, open Preview / Print, then Save PDF and Print through the real IPC. The two native dialogs cannot be
 * operated by automation, so they are replaced by hooks (save: a file in ELECTRON_SMOKE_SAVE_DIR; print: not shown). The saved
 * PDF is then checked. No physical printer is involved.
 */
function runDocumentSmoke(win: BrowserWindow): void {
  const saveDir = process.env.ELECTRON_SMOKE_SAVE_DIR ?? '';
  setOutputHooks({
    chooseSavePath: async (fileName) => join(saveDir, fileName),
    skipPrintDialog: true,
  });
  win.webContents.once('did-finish-load', () => {
    void win.webContents
      .executeJavaScript(
        String.raw`(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const until = async (fn, what) => {
            for (let i = 0; i < 300; i++) { const v = fn(); if (v) return v; await sleep(150); }
            throw new Error('timed out waiting for ' + what + ' | screen: ' + (document.body.innerText || '').slice(0, 160).replace(/\s+/g, ' '));
          };
          const byText = (sel, re) => [...document.querySelectorAll(sel)].find((e) => re.test(e.textContent || ''));
          const setValue = (el, v) => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
            el.dispatchEvent(new Event('input', { bubbles: true }));
          };
          const out = {};
          await until(() => document.querySelector('h1')?.textContent === 'Sign in', 'the sign-in screen');
          setValue(document.querySelector('input[autocomplete="username"], input[name="username"], input[type="text"]'), ${JSON.stringify(process.env.ELECTRON_SMOKE_USER ?? '')});
          setValue(document.querySelector('input[type="password"]'), ${JSON.stringify(process.env.ELECTRON_SMOKE_PASSWORD ?? '')});
          byText('button', /^Sign in$/).click();
          const nav = await until(() => byText('nav a', /^Billing$/), 'the Billing link');
          nav.click();
          const open = await until(() => document.querySelector('a[aria-label^="Open invoice"]'), 'the invoice list');
          out.listRows = document.querySelectorAll('tbody tr').length;
          out.listDemoBadge = /DEMO/.test(document.querySelector('tbody tr')?.textContent || '');
          open.click();
          await until(() => /^Invoice /.test(document.querySelector('h1')?.textContent || ''), 'the invoice');
          out.detailHeading = document.querySelector('h1').textContent;
          out.detailDemoAlert = /DEMO INVOICE/.test(document.body.textContent || '');
          out.detailEditControls = [...document.querySelectorAll('button')].filter((b) => /^(Edit|Delete|Cancel invoice)/.test(b.textContent || '')).length;
          byText('button', /^Preview \/ Print$/).click();
          const frame = await until(() => document.querySelector('iframe[title="Invoice preview"]'), 'the print preview');
          const html = frame.getAttribute('srcdoc') || '';
          out.previewSandbox = frame.getAttribute('sandbox');
          out.previewWatermark = html.includes('class="wm"') && html.includes('NOT A PRODUCTION TAX INVOICE');
          out.previewHasNumber = html.includes(out.detailHeading.replace('Invoice ', '').replace('Print preview: ', ''));
          byText('button', /^Save PDF$/).click();
          await until(() => /The PDF was saved\.|could not be created|cancelled/.test(document.body.textContent || ''), 'the save result');
          out.saveMessage = (document.body.textContent || '').match(/The PDF was saved\.|The PDF could not be created[^.]*\.|Saving was cancelled[^.]*\./)?.[0] ?? null;
          byText('button', /^Print/).click();
          await until(() => /sent to the printer|could not be printed|Printing was cancelled/.test(document.body.textContent || ''), 'the print result');
          out.printMessage = (document.body.textContent || '').match(/The invoice was sent to the printer\.|The invoice could not be printed\.[^.]*|Printing was cancelled\./)?.[0] ?? null;
          out.nodeExposed = typeof require !== 'undefined' || typeof process !== 'undefined';
          out.bodyShowsPath = /[A-Z]:\\|\/Users\//.test(document.body.textContent || '');
          return out;
        })()`,
      )
      .then(async (r: Record<string, unknown>) => {
        const files = readdirSync(saveDir).filter((f) => f.endsWith('.pdf'));
        const first = files[0] ? readFileSync(join(saveDir, files[0])) : undefined;
        process.stdout.write(
          `DOC_SMOKE_RESULT ${JSON.stringify({
            ...r,
            savedFiles: files,
            savedIsPdf: first ? looksLikePdf(first) : false,
            savedPages: first ? pdfPageCount(first) : 0,
          })}\n`,
        );
        await shutdownAll();
        app.exit(0);
      })
      .catch(async (e: unknown) => {
        process.stderr.write(`DOC_SMOKE_FAILED ${String(e)}\n`);
        await shutdownAll();
        endProcess(1);
      });
  });
  win.webContents.once('did-fail-load', () => endProcess(1));
}

/**
 * Verification only (unpackaged + ELECTRON_BACKUP_SMOKE=1, test credentials and a throwaway folder in the environment): production-like
 * check of Backup & Recovery in the REAL renderer served from app://, against the REAL API and database: sign in, open Settings, choose
 * the backup folder and a restore file through the real IPC and control channel, create an encrypted backup with verification, and open it
 * for restore (without restoring). The two native dialogs cannot be operated by automation, so they are replaced by hooks that answer with
 * the throwaway folder and the file it now holds. No external drive is involved.
 */
function runBackupSmoke(win: BrowserWindow): void {
  const dir = process.env.ELECTRON_SMOKE_BACKUP_DIR ?? '';
  const firstBackup = (): string | undefined => {
    const name = readdirSync(dir).find((f) => f.endsWith('.cbbackup'));
    return name ? join(dir, name) : undefined;
  };
  setBackupDialogHooks({ folder: dir, file: firstBackup });
  win.webContents.once('did-finish-load', () => {
    void win.webContents
      .executeJavaScript(
        String.raw`(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const until = async (fn, what, tries = 300) => {
            for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; await sleep(150); }
            throw new Error('timed out waiting for ' + what + ' | screen: ' + (document.body.innerText || '').slice(0, 200).replace(/\s+/g, ' '));
          };
          const byText = (sel, re) => [...document.querySelectorAll(sel)].find((e) => re.test(e.textContent || ''));
          const setValue = (el, v) => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
            el.dispatchEvent(new Event('input', { bubbles: true }));
          };
          const byLabel = (re) => {
            const l = [...document.querySelectorAll('label')].find((x) => re.test(x.textContent || ''));
            return l && document.getElementById(l.getAttribute('for'));
          };
          const PASS = ${JSON.stringify(process.env.ELECTRON_SMOKE_BACKUP_PASSPHRASE ?? '')};
          const out = {};
          await until(() => document.querySelector('h1')?.textContent === 'Sign in', 'the sign-in screen');
          setValue(document.querySelector('input[autocomplete="username"], input[name="username"], input[type="text"]'), ${JSON.stringify(process.env.ELECTRON_SMOKE_USER ?? '')});
          setValue(document.querySelector('input[type="password"]'), ${JSON.stringify(process.env.ELECTRON_SMOKE_PASSWORD ?? '')});
          byText('button', /^Sign in$/).click();
          (await until(() => byText('nav a', /^Settings$/), 'the Settings link')).click();
          (await until(() => byText('a', /^Open Backup & Recovery$/), 'the Backup & Recovery link')).click();
          await until(() => document.querySelector('h1')?.textContent === 'Backup & Recovery', 'the backup screen');
          out.bridgeKeys = Object.keys(window.commercebill).sort();
          out.noFolderYet = /Not chosen yet/.test(document.body.textContent || '');
          (await until(() => byText('button', /^Choose folder$/), 'the choose folder button')).click();
          await until(() => /Folder:\s*Business Backups/.test(document.body.textContent || ''), 'the chosen folder');
          out.folderLabelShown = true;
          out.bodyShowsPath = /[A-Z]:\\|\/Users\//.test(document.body.textContent || '');
          setValue(byLabel(/^Backup passphrase/), PASS);
          setValue(byLabel(/^Confirm passphrase/), PASS);
          await sleep(200);
          byText('button', /^Create backup$/).click();
          await until(() => /Backup created/.test(document.body.textContent || ''), 'the backup result', 600);
          out.created = true;
          await until(() => /restored into a separate test database and every check passed/.test(document.body.textContent || ''), 'the verification result', 600);
          out.verified = true;
          out.passphraseFieldCleared = byLabel(/^Backup passphrase/).value === '';
          out.passphraseInPage = (document.body.innerHTML || '').includes(PASS);
          (await until(() => byText('button', /^Choose backup file$/), 'the restore chooser')).click();
          await until(() => /Backup file:/.test(document.body.textContent || ''), 'the chosen restore file');
          out.restoreFileShown = (document.body.textContent || '').match(/Backup file:\s*(\S+?\.cbbackup)/)?.[1] ?? null;
          setValue(byLabel(/^Passphrase of this backup/), PASS);
          byText('button', /^Open backup$/).click();
          await until(() => /This replaces your current data/.test(document.body.textContent || ''), 'the restore details', 600);
          out.restoreOpened = true;
          out.restoreButtonDisabled = byText('button', /^Restore now$/).disabled;
          out.nodeExposed = typeof require !== 'undefined' || typeof process !== 'undefined';
          out.bodyShowsPathAfter = /[A-Z]:\\|\/Users\//.test(document.body.textContent || '');
          return out;
        })()`,
      )
      .then(async (r: Record<string, unknown>) => {
        await new Promise((resolve) => setTimeout(resolve, 500)); // let the API flush its request logs
        const files = readdirSync(dir).filter((f) => f.endsWith('.cbbackup'));
        const apiOutput = api ? api.output() : '';
        const passphrase = process.env.ELECTRON_SMOKE_BACKUP_PASSPHRASE;
        process.stdout.write(
          `BACKUP_SMOKE_RESULT ${JSON.stringify({
            ...r,
            files,
            passphraseInApiOutput: Boolean(passphrase && apiOutput.includes(passphrase)),
            controlSecretInApiOutput: Boolean(controlSecret && apiOutput.includes(controlSecret)),
          })}\n`,
        );
        await shutdownAll();
        app.exit(0);
      })
      .catch(async (e: unknown) => {
        process.stderr.write(`BACKUP_SMOKE_FAILED ${String(e)}\n`);
        await shutdownAll();
        endProcess(1);
      });
  });
  win.webContents.once('did-fail-load', () => endProcess(1));
}

/**
 * Verification only (unpackaged + ELECTRON_E2E=1): the First Usable Billing end-to-end check. The real Electron main process, real preload,
 * real renderer served from app://, real API and a real PostgreSQL database; a driver script (ELECTRON_E2E_SCRIPT, built by the test)
 * operates the real screens like a person, one stage per launch (ELECTRON_E2E_STAGE). Only the native save, print and folder/file dialogs
 * are replaced by hooks that use the throwaway folder ELECTRON_E2E_DIR. Nothing about the security settings is relaxed.
 */
function runE2e(win: BrowserWindow): void {
  const dir = process.env.ELECTRON_E2E_DIR ?? '';
  const stage = process.env.ELECTRON_E2E_STAGE ?? '';
  const firstBackup = (): string | undefined => {
    const folder = join(dir, 'backups');
    const name = readdirSync(folder).find((f) => f.endsWith('.cbbackup'));
    return name ? join(folder, name) : undefined;
  };
  setOutputHooks({
    chooseSavePath: async (fileName) => join(dir, 'pdf', fileName),
    skipPrintDialog: true,
  });
  setBackupDialogHooks({ folder: join(dir, 'backups'), file: firstBackup });
  win.webContents.once('did-finish-load', () => {
    const bundle = readFileSync(process.env.ELECTRON_E2E_SCRIPT ?? '', 'utf8');
    const code = `${bundle}\n;window.__E2E__ = ${process.env.ELECTRON_E2E_ENV ?? '{}'};\nwindow.__fub[${JSON.stringify(stage)}]()`;
    void win.webContents
      .executeJavaScript(code)
      .then(async (r: Record<string, unknown>) => {
        await new Promise((resolve) => setTimeout(resolve, 500)); // let the API flush its request logs
        const apiOutput = api ? api.output() : '';
        process.stdout.write(
          `E2E_RESULT ${JSON.stringify({
            stage,
            ...r,
            controlSecretInApiOutput: Boolean(controlSecret && apiOutput.includes(controlSecret)),
            launchSecretInApiOutput: Boolean(launchSecret && apiOutput.includes(launchSecret)),
          })}\n`,
        );
        await shutdownAll();
        app.exit(0);
      })
      .catch(async (e: unknown) => {
        process.stderr.write(`E2E_FAILED ${String(e)}\n`);
        await shutdownAll();
        endProcess(1);
      });
  });
  win.webContents.once('did-fail-load', () => endProcess(1));
}

/**
 * Ends the process with a non-zero code a moment later. Calling app.exit(code) while the browser process is still starting up
 * intermittently crashed Electron on Windows (access violation 0xC0000005 or a breakpoint) in about 1 of 100 isolated runs, which turned a
 * deliberate refusal into a crash exit code (risk R-104). With this short delay, 600 consecutive isolated runs of the same refusal
 * all exited with code 1 (before: 5 of 400 crashed). It is a mitigation for a start-up race inside Electron, not a documented guarantee.
 */
function endProcess(code: number): void {
  setTimeout(() => app.exit(code), 500);
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

// Backup choosers (Task 1.17, ADR-0027). No argument crosses from the renderer: the main process opens the native dialog, registers the
// chosen path with the local service using its own control secret, and returns only a display name (and an opaque id for a restore file).
function backupChooser(kind: 'destination' | 'restore-source') {
  return async (event: IpcMainInvokeEvent) => {
    assertTrusted(event);
    if (!api || !launchSecret || !controlSecret) return { status: 'failed' as const };
    const parent = BrowserWindow.fromWebContents(event.sender);
    const chosen =
      kind === 'destination' ? await chooseFolder(parent) : await chooseBackupFile(parent);
    if (!chosen) return { status: 'cancelled' as const };
    return registerChosenPath(
      net.fetch as unknown as typeof fetch,
      { baseUrl: api.baseUrl, launchSecret, controlSecret },
      kind,
      chosen,
    );
  };
}
ipcMain.handle(BACKUP_CHANNELS.chooseDestination, backupChooser('destination'));
ipcMain.handle(BACKUP_CHANNELS.chooseRestoreFile, backupChooser('restore-source'));

// Invoice documents (Task 1.15). The payload is an already posted invoice SNAPSHOT; it is validated strictly and the HTML is
// built here from the validated snapshot, never taken from the renderer. See document-ipc.ts for the contract.
function documentHandler(
  run: (
    req: { html: string; fileName: string },
    event: IpcMainInvokeEvent,
  ) => Promise<DocumentOutputResult>,
) {
  return async (event: IpcMainInvokeEvent, payload: unknown): Promise<DocumentOutputResult> => {
    assertTrusted(event);
    const req = prepareDocumentRequest(payload);
    if (!req.ok) throw new Error('The document request was rejected');
    return run(req, event);
  };
}
ipcMain.handle(
  DOCUMENT_CHANNELS.savePdf,
  documentHandler((req, event) =>
    saveInvoicePdf(req.html, req.fileName, BrowserWindow.fromWebContents(event.sender)),
  ),
);
ipcMain.handle(
  DOCUMENT_CHANNELS.print,
  documentHandler((req) => printInvoice(req.html)),
);

/**
 * Verification only (unpackaged + ELECTRON_PDF_FIXTURE): renders the posted-invoice snapshot in the given JSON file through the
 * SAME code path as Save PDF (without the save dialog) and writes the PDF where ELECTRON_PDF_OUT says.
 */
async function runPdfSmoke(): Promise<void> {
  try {
    const req = prepareDocumentRequest(
      JSON.parse(readFileSync(process.env.ELECTRON_PDF_FIXTURE!, 'utf8')),
    );
    if (!req.ok) throw new Error('fixture rejected');
    const pdf = await renderPdf(req.html);
    writeFileSync(process.env.ELECTRON_PDF_OUT!, pdf);
    process.stdout.write(
      `PDF_RESULT ${JSON.stringify({ bytes: pdf.length, pages: pdfPageCount(pdf), fileName: req.fileName })}
`,
    );
    app.exit(0);
  } catch (e) {
    process.stderr.write(`PDF_FAILED ${String(e)}
`);
    endProcess(1);
  }
}

/** Stops what this process started: the local service first, then (when CommerceBill owns it) the database. Safe to call twice. */
async function shutdownAll(): Promise<void> {
  const a = api;
  api = undefined;
  await a?.stop();
  const r = runtimeHandle;
  runtimeHandle = undefined;
  if (r) {
    try {
      await r.stop();
    } catch (e) {
      appLog?.error(
        `the database did not stop cleanly: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  if (managed && runtimePaths)
    writeRuntimeStatus(runtimePaths, {
      state: 'stopped',
      appVersion: APP_VERSION,
      mainPid: process.pid,
    });
}

/** Managed: start (or create, or upgrade) CommerceBill's own database. Otherwise the database named by DATABASE_URL. */
async function prepareDatabase(): Promise<string | undefined> {
  if (!managed) return process.env.DATABASE_URL;
  runtimePaths ??= resolveRuntimePaths({ env: process.env, localAppData: localAppDataDir() });
  appLog ??= new AppLog(runtimePaths.logsDir);
  appLog.info(`starting CommerceBill ${APP_VERSION}`);
  runtimeHandle = await startRuntime({
    paths: runtimePaths,
    resources,
    cipher: electronCipher,
    appVersion: APP_VERSION,
    log: appLog,
  });
  return runtimeHandle.databaseUrl;
}

async function startLocalApi(databaseUrl: string | undefined): Promise<void> {
  const secret = generateLaunchSecret();
  controlSecret = generateLaunchSecret();
  const port = await getFreePort();
  // Validate with the same schema the API uses, so a bad configuration fails here with a clear message
  // (variable names and rules only - never values).
  const env = parseEnv({
    NODE_ENV: 'production',
    API_HOST: '127.0.0.1',
    API_PORT: String(port),
    WEB_ORIGIN: rendererOrigin(devServerUrl),
    DATABASE_URL: databaseUrl,
    LAUNCH_SECRET: secret,
  });
  launchSecret = secret;
  const apiLog = managed && runtimePaths ? new AppLog(runtimePaths.logsDir, 'api') : undefined;
  apiLog?.addSecret(secret);
  apiLog?.addSecret(controlSecret);
  if (runtimeHandle) apiLog?.addSecret(decodeURIComponent(new URL(env.DATABASE_URL).password));
  api = await startApi({
    entry: apiEntry,
    port: env.API_PORT,
    secret,
    controlSecret,
    webOrigin: rendererOrigin(devServerUrl),
    databaseUrl: env.DATABASE_URL,
    migrationsDir: resources.migrationsDir,
    ...(apiLog ? { onOutput: (t: string) => apiLog.info(t.trimEnd()) } : {}),
    logLevel: process.env.LOG_LEVEL ?? 'info',
  });
  if (managed && runtimePaths && runtimeHandle)
    writeRuntimeStatus(runtimePaths, {
      state: 'running',
      appVersion: APP_VERSION,
      mainPid: process.pid,
      databasePort: runtimeHandle.port,
      databasePid: (await runtimeHandle.postgres.status()).pid,
      apiPort: env.API_PORT,
      schemaVersion: runtimeHandle.migration.current,
      install: runtimeHandle.install,
      upgraded: Boolean(runtimeHandle.upgrade),
      reusedDatabase: runtimeHandle.reusedRunningDatabase,
      clusterId: readClusterId(),
      startedAt: new Date().toISOString(),
    });
}

/** The installation's own id (not a secret): lets a support person or a test tell one data folder from another. */
function readClusterId(): string | null {
  try {
    return (
      (JSON.parse(readFileSync(runtimePaths!.runtimeJson, 'utf8')) as { clusterId?: string })
        .clusterId ?? null
    );
  } catch {
    return null;
  }
}

async function currentDiagnostics(): Promise<Diagnostics> {
  runtimePaths ??= resolveRuntimePaths({ env: process.env, localAppData: localAppDataDir() });
  let apiHealthy: boolean | null = false;
  if (api) {
    try {
      apiHealthy = (await net.fetch(`${api.baseUrl}/health`)).ok;
    } catch {
      apiHealthy = false;
    }
  }
  return collectDiagnostics({
    paths: runtimePaths,
    resources,
    appVersion: APP_VERSION,
    databaseUrl:
      runtimeHandle?.databaseUrl ?? (managed ? null : (process.env.DATABASE_URL ?? null)),
    databasePort: runtimeHandle?.port ?? null,
    install: runtimeHandle?.install ?? 'unknown',
    apiHealthy,
    startupProblem,
    managedDatabase: managed,
  });
}

const interactive = !(smoke || docSmoke || backupSmoke || e2e);

ipcMain.handle('app:get-diagnostics', async (event): Promise<Diagnostics> => {
  assertTrusted(event);
  return currentDiagnostics();
});
ipcMain.handle('app:export-diagnostics', async (event) => {
  assertTrusted(event);
  const text = formatDiagnostics(await currentDiagnostics());
  return { status: await saveDiagnosticsDialog(BrowserWindow.fromWebContents(event.sender), text) };
});
ipcMain.handle('app:open-log-folder', async (event) => {
  assertTrusted(event);
  runtimePaths ??= resolveRuntimePaths({ env: process.env, localAppData: localAppDataDir() });
  return {
    status:
      (await shell.openPath(runtimePaths.logsDir)) === ''
        ? ('opened' as const)
        : ('failed' as const),
  };
});
ipcMain.handle('app:show-safety-passphrase', async (event) => {
  assertTrusted(event);
  if (!managed || !runtimePaths) return { status: 'unavailable' as const };
  try {
    const p = loadSecrets(runtimePaths.secretsFile, electronCipher).safetyPassphrase;
    if (!p) return { status: 'unavailable' as const };
    await showSafetyPassphraseDialog(p);
    return { status: 'shown' as const };
  } catch {
    return { status: 'unavailable' as const };
  }
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app.whenReady().then(async () => {
    if (pdfSmoke) {
      await runPdfSmoke();
      return;
    }
    protocol.handle(APP_SCHEME, (request) => {
      const file = resolveAppRequest(request.url, webRoot);
      if (!file) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });

    const interactiveStart = !(smoke || docSmoke || backupSmoke || e2e);
    const splash = interactiveStart && managed ? showSplash() : undefined;
    for (;;) {
      try {
        await startLocalApi(await prepareDatabase());
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof StartupError)
          startupProblem = { code: err.code, message: err.userMessage };
        appLog?.error(`start-up failed: ${err instanceof StartupError ? err.code : message}`);
        await shutdownAll(); // stop whatever did start (never delete or re-create any data)
        if (!interactive) {
          if (smoke)
            process.stderr.write(`SMOKE_FAILED could not start the local service: ${message}\n`);
          else process.stderr.write(`START_FAILED ${message}\n`);
          endProcess(1);
          return;
        }
        splash?.destroy();
        const choice = await showStartupFailure(
          err instanceof Error ? err : new Error(message),
          async () => formatDiagnostics(await currentDiagnostics()),
          (runtimePaths ??= resolveRuntimePaths({
            env: process.env,
            localAppData: localAppDataDir(),
          })),
        );
        if (choice === 'quit') {
          endProcess(1);
          return;
        }
      }
    }

    if (app.isPackaged) Menu.setApplicationMenu(null);
    createWindow();
    splash?.destroy();
    if (interactive && runtimeHandle?.upgrade?.safetyBackup)
      void dialog.showMessageBox({
        type: 'info',
        title: 'CommerceBill',
        message: 'CommerceBill was updated.',
        detail: `Your data was updated for this version. A verified safety backup of the data from before the update was saved (${runtimeHandle.upgrade.safetyBackup}) in the backups\\pre-upgrade folder of your CommerceBill data folder.`,
        buttons: ['OK'],
      });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    // (the PDF check has no main window: closing its hidden render window must not end the process early)
    if (process.platform !== 'darwin' && !pdfSmoke) app.quit();
  });
  // A second launch brings the running application forward instead of starting a second copy.
  app.on('second-instance', () => {
    const w = mainWindow;
    if (!w) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  });
  // Closing the application stops the local service and then the database it owns, cleanly, before the process ends.
  let shutDown = false;
  let shuttingDown = false;
  app.on('will-quit', (event) => {
    if (shutDown) return;
    event.preventDefault();
    if (shuttingDown) return;
    shuttingDown = true;
    void shutdownAll().finally(() => {
      shutDown = true;
      app.quit();
    });
  });
  // Deny every permission request (camera, geolocation, ...) until a feature needs one.
  app.on('web-contents-created', (_e, contents) => {
    contents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  });
}
