/**
 * The IPC contract for invoice documents (Task 1.15), kept free of Electron imports so it is unit-testable.
 *
 * The renderer can ask for exactly two things, each carrying one posted-invoice SNAPSHOT:
 *   document:save-invoice-pdf   render the invoice to A4 PDF and let the USER choose where to save it
 *   document:print-invoice      open the operating system print dialog for the invoice
 *
 * The main process validates the payload strictly (parseInvoiceSnapshot), builds the HTML itself from the validated snapshot
 * (never from renderer-supplied HTML), loads it into a hidden window with JavaScript and network disabled, and chooses the
 * destination only through the operating system save dialog. Nothing about a path ever crosses back to the renderer.
 */
import {
  buildInvoiceDocument,
  invoiceFileName,
  parseInvoiceSnapshot,
  renderInvoiceHtml,
} from '@commercebill/document-engine';
import type { InvoiceView } from '@commercebill/shared-types';

export const DOCUMENT_CHANNELS = {
  savePdf: 'document:save-invoice-pdf',
  print: 'document:print-invoice',
} as const;

export type DocumentRequest =
  { ok: true; invoice: InvoiceView; html: string; fileName: string } | { ok: false };

/**
 * Validates an untrusted IPC payload and derives everything the main process needs from the validated snapshot only. A bad
 * payload yields a bare `{ ok: false }`: no value from the payload is ever echoed, logged or returned.
 */
export function prepareDocumentRequest(payload: unknown): DocumentRequest {
  const parsed = parseInvoiceSnapshot(payload);
  if (!parsed.ok) return { ok: false };
  const doc = buildInvoiceDocument(parsed.invoice);
  return {
    ok: true,
    invoice: parsed.invoice,
    html: renderInvoiceHtml(doc),
    fileName: invoiceFileName(doc),
  };
}

/** A path chosen in the save dialog, forced to end in .pdf so only a PDF is ever written. Null when nothing was chosen. */
export function pdfSavePath(chosen: string | undefined): string | null {
  if (!chosen || chosen.includes('\u0000')) return null;
  return /\.pdf$/i.test(chosen) ? chosen : `${chosen}.pdf`;
}

/** The data: URL the hidden render window loads. The HTML never touches the file system. */
export function htmlDataUrl(html: string): string {
  return `data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`;
}

/** A PDF starts with %PDF- and ends with %%EOF; anything else is not written. */
export function looksLikePdf(buf: Uint8Array): boolean {
  if (buf.length < 100) return false;
  const head = Buffer.from(buf.subarray(0, 5)).toString('latin1');
  const tail = Buffer.from(buf.subarray(Math.max(0, buf.length - 32))).toString('latin1');
  return head === '%PDF-' && tail.includes('%%EOF');
}

/** Count of pages in a Chromium-produced PDF (Type /Page objects, not /Pages). Used by checks, not by the app flow. */
export function pdfPageCount(buf: Uint8Array): number {
  return (
    Buffer.from(buf)
      .toString('latin1')
      .match(/\/Type\s*\/Page(?![s\w])/g) ?? []
  ).length;
}
