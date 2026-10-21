import { canonicalJson, sha256Hex } from '@commercebill/tax-engine';
import type { RecordPaymentRequest } from './validate.js';

/** The canonical content of a payment request, stored on the immutable payment: a retry with the same operation id must match. */
export function paymentFingerprint(r: RecordPaymentRequest): string {
  return sha256Hex(
    canonicalJson({
      mode: r.mode,
      invoiceId: r.invoiceId,
      amount: r.amount,
      method: r.method,
      reference: r.reference,
      notes: r.notes,
      paymentDate: r.paymentDate,
    }),
  );
}
