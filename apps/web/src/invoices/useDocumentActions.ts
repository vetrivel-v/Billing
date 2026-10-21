import type { InvoiceView } from '@commercebill/shared-types';
import { parseInvoiceSnapshot } from '@commercebill/document-engine';
import { useRef, useState } from 'react';
import { outputMessage } from './model.js';

const UNAVAILABLE = 'Saving and printing are available in the CommerceBill desktop app.';

/**
 * Save-as-PDF and print for a posted invoice, through the desktop bridge. The invoice passed in is the snapshot read from the
 * API (never master data); the main process validates it again. Only one request runs at a time.
 */
export function useDocumentActions(invoice: InvoiceView | undefined) {
  const bridge = typeof window === 'undefined' ? undefined : window.commercebill;
  const available = Boolean(
    invoice &&
    typeof bridge?.saveInvoicePdf === 'function' &&
    typeof bridge.printInvoice === 'function',
  );
  const [busy, setBusy] = useState<'save' | 'print' | null>(null);
  const [message, setMessage] = useState<{
    tone: 'success' | 'info' | 'error';
    text: string;
  } | null>(null);
  const running = useRef(false);

  async function run(kind: 'save' | 'print') {
    if (!bridge || !invoice || running.current) return;
    running.current = true;
    setBusy(kind);
    setMessage(null);
    try {
      if (!parseInvoiceSnapshot(invoice).ok) {
        setMessage(outputMessage(kind, { status: 'failed' }));
        return;
      }
      const result = await (kind === 'save'
        ? bridge.saveInvoicePdf(invoice)
        : bridge.printInvoice(invoice));
      setMessage(outputMessage(kind, result));
    } catch {
      setMessage(outputMessage(kind, { status: 'failed' }));
    } finally {
      running.current = false;
      setBusy(null);
    }
  }

  return {
    available,
    unavailableReason: UNAVAILABLE,
    busy,
    message,
    save: () => run('save'),
    print: () => run('print'),
  };
}
