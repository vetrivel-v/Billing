/**
 * Stable machine-readable document-type codes. The CODE is the identifier stored in the database and used by
 * business logic; the label is for display only and may change freely. Never rename a released code.
 *
 * A code here only means "a numbering sequence can exist for it". It does NOT create the document workflow:
 * invoices, credit notes and so on arrive in later tasks.
 */
export interface DocumentTypeDef {
  code: string;
  /** Display label (not an identifier). */
  label: string;
  /** Default format template for new installations. `{FY}` expands to the financial-year label. */
  defaultPrefix: string;
}

export const DOCUMENT_TYPES = {
  INVOICE: { code: 'INVOICE', label: 'Tax invoice', defaultPrefix: 'INV/{FY}/' },
  /**
   * Demo invoices (Task 1.13): a separate sequence with a visibly different prefix, so a demo invoice never consumes the
   * production INVOICE sequence and can never be mistaken for a tax invoice.
   */
  DEMO_INVOICE: {
    code: 'DEMO_INVOICE',
    label: 'Demo invoice (not a tax invoice)',
    defaultPrefix: 'DEMO/{FY}/',
  },
  CREDIT_NOTE: { code: 'CREDIT_NOTE', label: 'Credit note', defaultPrefix: 'CN/{FY}/' },
  DEBIT_NOTE: { code: 'DEBIT_NOTE', label: 'Debit note', defaultPrefix: 'DN/{FY}/' },
  PURCHASE_ORDER: { code: 'PURCHASE_ORDER', label: 'Purchase order', defaultPrefix: 'PO/{FY}/' },
  PAYMENT_RECEIPT: {
    code: 'PAYMENT_RECEIPT',
    label: 'Payment receipt',
    defaultPrefix: 'PAY/{FY}/',
  },
} as const satisfies Record<string, DocumentTypeDef>;

export type DocumentTypeCode = keyof typeof DOCUMENT_TYPES;

export const DOCUMENT_TYPE_CODES = Object.keys(DOCUMENT_TYPES) as DocumentTypeCode[];

export function isDocumentTypeCode(value: unknown): value is DocumentTypeCode {
  return typeof value === 'string' && Object.hasOwn(DOCUMENT_TYPES, value);
}
