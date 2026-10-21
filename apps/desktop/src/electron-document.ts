/**
 * Electron-bound half of invoice output (Task 1.15). Coverage: this file talks to Electron windows and dialogs, so it is
 * verified by the Electron smoke/integration check (a real PDF is rendered) rather than by unit tests; its decisions live in
 * document-ipc.ts, which is unit-tested.
 */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, session } from 'electron';
import type { DocumentOutputResult } from '@commercebill/shared-types';
import { htmlDataUrl, looksLikePdf, pdfSavePath } from './document-ipc.js';

/**
 * Verification hooks (set only by the unpackaged ELECTRON_DOC_SMOKE check, see main.ts): they replace the two NATIVE dialogs
 * (the save dialog and the print dialog), which an automated check cannot operate. Everything else - validation, rendering,
 * PDF creation and the file write - runs the real code. They are never set in a normal launch.
 */
export interface OutputHooks {
  chooseSavePath?: (fileName: string) => Promise<string | undefined>;
  skipPrintDialog?: boolean;
}
let hooks: OutputHooks = {};
export function setOutputHooks(h: OutputHooks): void {
  hooks = h;
}

/** One output job at a time: a runaway renderer cannot queue up windows. */
let busy = false;

/**
 * A hidden, locked-down window for rendering one document: no JavaScript, no Node, sandboxed, a throw-away in-memory session
 * that cancels EVERY request except the data: URL it was given, and no navigation or new windows.
 */
async function withRenderWindow<T>(
  html: string,
  use: (win: BrowserWindow) => Promise<T>,
): Promise<T> {
  const ses = session.fromPartition(`invoice-render-${randomUUID()}`); // no "persist:" prefix: nothing is stored
  ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !details.url.startsWith('data:') }));
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  try {
    await win.loadURL(htmlDataUrl(html));
    return await use(win);
  } finally {
    win.destroy();
    await ses.clearStorageData().catch(() => undefined);
  }
}

/** Renders HTML to an A4 PDF (page size and margins come from the document's own @page rule). */
export function renderPdf(html: string): Promise<Buffer> {
  return withRenderWindow(html, (win) =>
    win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
    }),
  );
}

async function guarded<T>(fn: () => Promise<T>): Promise<T | { status: 'failed' }> {
  if (busy) return { status: 'failed' };
  busy = true;
  try {
    return await fn();
  } catch {
    return { status: 'failed' }; // generic on purpose: never a path, a message or any content
  } finally {
    busy = false;
  }
}

/** Renders the PDF, then lets the USER choose the destination in the system save dialog. Writes only that PDF. */
export function saveInvoicePdf(
  html: string,
  fileName: string,
  parent: BrowserWindow | null,
): Promise<DocumentOutputResult> {
  return guarded(async (): Promise<DocumentOutputResult> => {
    const pdf = await renderPdf(html);
    if (!looksLikePdf(pdf)) return { status: 'failed' };
    const options = {
      title: 'Save invoice as PDF',
      defaultPath: join(app.getPath('documents'), fileName),
      filters: [{ name: 'PDF document', extensions: ['pdf'] }],
    };
    let chosen: string | undefined;
    if (hooks.chooseSavePath) chosen = await hooks.chooseSavePath(fileName);
    else {
      const result = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options);
      chosen = result.canceled ? undefined : result.filePath;
    }
    const target = pdfSavePath(chosen);
    if (!target) return { status: 'cancelled', fileName };
    await writeFile(target, pdf);
    return { status: 'saved', fileName };
  });
}

/** Opens the operating system print dialog (never silent) for the document. */
export function printInvoice(html: string): Promise<DocumentOutputResult> {
  return guarded(() =>
    withRenderWindow(
      html,
      (win) =>
        new Promise<DocumentOutputResult>((resolve) => {
          if (hooks.skipPrintDialog) {
            // verification only: the document was rendered; the native print dialog is not operated
            resolve({ status: 'printed' });
            return;
          }
          win.webContents.print({ silent: false, printBackground: true }, (success, reason) => {
            resolve({
              status: success ? 'printed' : reason === 'cancelled' ? 'cancelled' : 'failed',
            });
          });
        }),
    ),
  );
}
