import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { longInvoice, makeInvoice } from '@commercebill/test-utilities/invoice-snapshot';
import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_CHANNELS,
  htmlDataUrl,
  looksLikePdf,
  pdfPageCount,
  pdfSavePath,
  prepareDocumentRequest,
} from './document-ipc.js';

/** Source with comments removed, so the guard-rails look at code only. */
const src = (f: string) =>
  readFileSync(resolve(import.meta.dirname, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
const simple = () =>
  makeInvoice({ lines: [{ name: 'Gadget', qty: 2, pricePaise: 25_000, rate: 18 }] });

describe('the document IPC contract', () => {
  it('has exactly two document channels', () => {
    expect(DOCUMENT_CHANNELS).toEqual({
      savePdf: 'document:save-invoice-pdf',
      print: 'document:print-invoice',
    });
  });

  it('accepts a valid snapshot and derives the HTML and file name in the main process', () => {
    const r = prepareDocumentRequest(simple());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fileName).toBe('DEMO-2026-27-000001.pdf');
      expect(r.html).toContain('DEMO');
      expect(r.html).toContain('Gadget');
    }
  });

  it('rejects every invalid payload with a bare failure that echoes nothing', () => {
    const hostile = [
      null,
      undefined,
      'a string',
      42,
      [],
      {},
      { not: 'an invoice' },
      '<script>alert(1)</script>',
      { ...simple(), documentNumber: '../../etc/passwd' },
      { ...simple(), documentNumber: 'C:\\x\\y' },
      { ...simple(), lines: [] },
      { ...simple(), isDemo: false }, // demo flag must agree with the document type
      { ...simple(), currency: 'USD' },
      longInvoice(501),
    ];
    for (const payload of hostile) {
      const r = prepareDocumentRequest(payload);
      expect(r, String(JSON.stringify(payload)).slice(0, 40)).toEqual({ ok: false });
    }
  });

  it('a renderer-supplied html field is ignored: the HTML always comes from the validated snapshot', () => {
    const r = prepareDocumentRequest({
      ...simple(),
      html: '<script>steal()</script>',
      fileName: '../../evil.pdf',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.html).not.toContain('steal');
      expect(r.fileName).toBe('DEMO-2026-27-000001.pdf');
    }
  });

  it('forces a .pdf destination and refuses an empty or NUL-containing path', () => {
    expect(pdfSavePath('C:\\Users\\me\\Documents\\x.pdf')).toBe('C:\\Users\\me\\Documents\\x.pdf');
    expect(pdfSavePath('C:\\Users\\me\\x.PDF')).toBe('C:\\Users\\me\\x.PDF');
    expect(pdfSavePath('C:\\Users\\me\\x')).toBe('C:\\Users\\me\\x.pdf');
    expect(pdfSavePath('C:\\Users\\me\\x.exe')).toBe('C:\\Users\\me\\x.exe.pdf');
    expect(pdfSavePath(undefined)).toBeNull();
    expect(pdfSavePath('')).toBeNull();
    expect(pdfSavePath('x\u0000.pdf')).toBeNull();
  });

  it('only a real PDF is ever written', () => {
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      Buffer.alloc(200, 0x20),
      Buffer.from('\n%%EOF\n'),
    ]);
    expect(looksLikePdf(pdf)).toBe(true);
    expect(looksLikePdf(Buffer.from('<html>not a pdf</html>'.repeat(10)))).toBe(false);
    expect(looksLikePdf(Buffer.from('%PDF-'))).toBe(false);
    expect(looksLikePdf(Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.alloc(300, 0x20)]))).toBe(
      false,
    ); // no %%EOF
    expect(pdfPageCount(Buffer.from('/Type /Pages /Type /Page /Type/Page /Type /Pages'))).toBe(2);
  });

  it('loads HTML through a data: URL (no file on disk, no network)', () => {
    const url = htmlDataUrl('<p>\u20B9 caf\u00E9</p>');
    expect(url.startsWith('data:text/html;charset=utf-8;base64,')).toBe(true);
    expect(Buffer.from(url.split(',')[1]!, 'base64').toString('utf8')).toBe(
      '<p>\u20B9 caf\u00E9</p>',
    );
  });
});

describe('the renderer has no unrestricted capability (source guard-rails)', () => {
  const ALLOWED = new Set([
    'app:get-info',
    'app:get-api-access',
    'document:save-invoice-pdf',
    'document:print-invoice',
    'backup:choose-destination',
    'backup:choose-restore-file',
  ]);

  it('the preload exposes exactly six bridge methods, only through the six allowed channels', () => {
    const p = src('preload.ts');
    const channels = [...p.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]!);
    expect(channels.sort()).toEqual([...ALLOWED].sort());
    expect(p.match(/exposeInMainWorld\(/g)).toHaveLength(1);
    expect(p).toContain("exposeInMainWorld('commercebill', bridge)");
    for (const forbidden of [
      'require(',
      "from 'node:",
      "from 'fs",
      'child_process',
      'shell',
      'ipcRenderer.send',
      'ipcRenderer.on(',
      'sendSync',
      'webFrame',
    ])
      expect(p, forbidden).not.toContain(forbidden);
    for (const key of [
      'getAppInfo',
      'getApiAccess',
      'saveInvoicePdf',
      'printInvoice',
      'chooseBackupDestination',
      'chooseRestoreFile',
    ])
      expect(p).toContain(`${key}:`);
  });

  it('every ipcMain handler checks the sender, and the document handlers validate the payload first', () => {
    const m = src('main.ts');
    const registrations = [...m.matchAll(/ipcMain\.handle\(\s*([^,]+),/g)].map((x) => x[1]!.trim());
    expect(registrations).toEqual([
      "'app:get-info'",
      "'app:get-api-access'",
      'BACKUP_CHANNELS.chooseDestination',
      'BACKUP_CHANNELS.chooseRestoreFile',
      'DOCUMENT_CHANNELS.savePdf',
      'DOCUMENT_CHANNELS.print',
    ]);
    const handler = m.slice(
      m.indexOf('function documentHandler'),
      m.indexOf('ipcMain.handle(\n  DOCUMENT_CHANNELS.savePdf'),
    );
    expect(handler.indexOf('assertTrusted(event)')).toBeGreaterThan(-1);
    expect(handler.indexOf('assertTrusted(event)')).toBeLessThan(
      handler.indexOf('prepareDocumentRequest(payload)'),
    );
    expect(handler.indexOf('prepareDocumentRequest(payload)')).toBeLessThan(
      handler.indexOf('run(req, event)'),
    );
    expect(handler).toContain('if (!req.ok) throw');
    expect(m.match(/ipcMain\.on\(/g)).toBeNull(); // no fire-and-forget channels
  });

  it('the backup choosers take no renderer argument and check the sender before opening any dialog', () => {
    const m = src('main.ts');
    const fn = m.slice(
      m.indexOf('function backupChooser'),
      m.indexOf('ipcMain.handle(BACKUP_CHANNELS.chooseDestination'),
    );
    expect(fn).toContain('assertTrusted(event)');
    expect(fn.indexOf('assertTrusted(event)')).toBeLessThan(fn.indexOf('chooseFolder('));
    expect(fn.indexOf('assertTrusted(event)')).toBeLessThan(fn.indexOf('chooseBackupFile('));
    expect(fn).not.toMatch(/payload|\.\.\.args|(?<![a-z])arg(?![a-z])/); // nothing from the renderer is used
    expect(fn).toContain('controlSecret');
    // the control secret is generated here and never handed to the renderer
    const access = m.slice(
      m.indexOf("ipcMain.handle('app:get-api-access'"),
      m.indexOf("ipcMain.handle('app:get-api-access'") + 400,
    );
    expect(access).not.toContain('controlSecret');
    const e = src('electron-backup.ts');
    expect(e).toContain("'openDirectory'");
    expect(e).not.toMatch(/writeFile|unlink|rm\(|readFile|child_process|shell\./);
  });

  it('the hidden render window is locked down: no JavaScript, sandboxed, every non-data request cancelled', () => {
    const e = src('electron-document.ts');
    for (const must of [
      'javascript: false',
      'sandbox: true',
      'nodeIntegration: false',
      'contextIsolation: true',
      "startsWith('data:')",
      'cancel:',
      "action: 'deny'",
      'preventDefault',
      'silent: false',
    ])
      expect(e, must).toContain(must);
    expect(e).not.toMatch(/silent:\s*true/);
    expect(e).not.toMatch(/shell\.|child_process|exec\(|spawn\(/);
    expect(e.match(/writeFile\(/g)).toHaveLength(1); // the only write is the validated PDF to the user-chosen path
  });

  it('the bridge reveals no path: results carry a status and a file name only', () => {
    const t = readFileSync(
      resolve(import.meta.dirname, '..', '..', '..', 'packages', 'shared-types', 'src', 'index.ts'),
      'utf8',
    );
    const block = t.slice(
      t.indexOf('export interface DocumentOutputResult'),
      t.indexOf('export interface DesktopBridge'),
    );
    expect(block).toContain("status: 'saved' | 'printed' | 'cancelled' | 'failed'");
    expect(block).toContain('fileName?: string');
    expect(block).not.toMatch(/bfilePathb|bpath\??:/);
  });
});
