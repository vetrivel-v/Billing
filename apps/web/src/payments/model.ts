import { validateRecordRequest, type Problem } from '@commercebill/payments/browser';
import type { PaymentDisplayStatus, PaymentMethod } from '@commercebill/shared-types';
import { ApiError, ApiUnreachableError } from '../api.js';
import { formatRupees } from '../invoices/model.js';

export const METHOD_OPTIONS: { value: PaymentMethod; label: string; hint: string }[] = [
  { value: 'CASH', label: 'Cash', hint: 'A reference is optional.' },
  { value: 'UPI', label: 'UPI', hint: 'Enter the UPI transaction reference (required).' },
  {
    value: 'BANK_TRANSFER',
    label: 'Bank transfer',
    hint: 'Enter the transfer reference or UTR (required).',
  },
  { value: 'CHEQUE', label: 'Cheque', hint: 'Enter the cheque number (required).' },
  {
    value: 'CARD',
    label: 'Card',
    hint: 'Never enter a card number. An approval or slip number is enough.',
  },
  { value: 'OTHER', label: 'Other', hint: 'A reference is optional.' },
];
export const methodLabel = (m: string): string =>
  METHOD_OPTIONS.find((o) => o.value === m)?.label ?? m;

export const STATUS_LABEL: Record<PaymentDisplayStatus, string> = {
  UNPAID: 'Unpaid',
  PARTIALLY_PAID: 'Partly paid',
  PAID: 'Paid',
};
export const STATUS_TONE: Record<PaymentDisplayStatus, 'neutral' | 'warning' | 'success'> = {
  UNPAID: 'neutral',
  PARTIALLY_PAID: 'warning',
  PAID: 'success',
};

export interface PaymentForm {
  amount: string;
  method: PaymentMethod;
  reference: string;
  notes: string;
}
export const emptyPaymentForm = (): PaymentForm => ({
  amount: '',
  method: 'CASH',
  reference: '',
  notes: '',
});

/** The request body. Only choices travel: no balance, customer or organization. Mode follows the invoice being paid. */
export function toPaymentRequest(
  invoiceId: string,
  isDemo: boolean,
  f: PaymentForm,
): Record<string, unknown> {
  return {
    mode: isDemo ? 'DEMO' : 'PRODUCTION',
    invoiceId,
    amount: f.amount.trim(),
    method: f.method,
    ...(f.reference.trim() ? { reference: f.reference.trim() } : {}),
    ...(f.notes.trim() ? { notes: f.notes.trim() } : {}),
  };
}

const RULE_TEXT: Record<string, string> = {
  required: 'This field is required.',
  invalid_amount: 'Enter a plain amount such as 2500 or 2500.50.',
  amount_must_be_positive: 'Enter an amount greater than zero.',
  too_many_decimals: 'Use at most two decimal places.',
  invalid_choice: 'Choose one of the listed options.',
  required_for_method: 'This payment method needs a reference.',
  looks_like_card_number:
    'This looks like a card number. Never enter card numbers; use an approval or slip number.',
  too_long: 'This is too long.',
  invalid_characters: 'This contains characters that are not allowed.',
  invalid_type: 'This value is not acceptable.',
};
export const ruleText = (rule: string): string =>
  RULE_TEXT[rule] ?? 'This value is not acceptable.';

export type FieldErrors = Partial<Record<'amount' | 'method' | 'reference' | 'notes', string>>;

/** Early feedback with the SAME validation as the server (which still decides everything, including the balance). */
export function validateForm(invoiceId: string, isDemo: boolean, f: PaymentForm): FieldErrors {
  const placeholder = '00000000-0000-4000-8000-000000000000';
  const r = validateRecordRequest({
    ...toPaymentRequest(invoiceId, isDemo, f),
    operationId: placeholder,
  });
  const errors: FieldErrors = {};
  if (!r.ok)
    for (const p of r.problems as Problem[]) {
      const k = p.field as keyof FieldErrors;
      if (['amount', 'method', 'reference', 'notes'].includes(k) && !errors[k])
        errors[k] = ruleText(p.rule);
    }
  return errors;
}

const CODE_TEXT: Record<string, string> = {
  INVOICE_FULLY_PAID: 'This invoice is already fully paid. Nothing was recorded.',
  INVOICE_NOT_FOUND: 'This invoice could not be found. Nothing was recorded.',
  INVOICE_MODE_MISMATCH:
    'This payment does not match the invoice type (demo or production). Nothing was recorded.',
  OPERATION_ID_REUSED:
    'This entry was already used for a different payment. Review the details and record it again.',
  PAYMENT_DATE_NOT_TODAY: 'Payments can only be dated today.',
  NO_OPEN_FINANCIAL_YEAR: 'There is no open financial year for today. Ask your administrator.',
  NUMBER_SEQUENCE_MISSING: 'Payment numbering is not set up. Ask your administrator.',
};

export type PaymentFailure =
  { kind: 'uncertain' } | { kind: 'rejected'; message: string; balanceDue?: string };

/** Turns a failed recording into the words the screen needs. Never raw codes or server text. */
export function classifyPaymentFailure(err: unknown): PaymentFailure {
  if (err instanceof ApiUnreachableError) return { kind: 'uncertain' };
  if (err instanceof ApiError) {
    if (err.status >= 500) return { kind: 'uncertain' };
    if (err.status === 403)
      return { kind: 'rejected', message: 'You do not have permission to record payments.' };
    const rule = err.problems[0]?.rule;
    const balanceDue =
      typeof err.details?.balanceDue === 'string' ? err.details.balanceDue : undefined;
    if (rule === 'AMOUNT_EXCEEDS_BALANCE')
      return {
        kind: 'rejected',
        message: `The amount is more than the balance due${balanceDue ? ` (${formatRupees(balanceDue)})` : ''}. Nothing was recorded.`,
        ...(balanceDue ? { balanceDue } : {}),
      };
    return {
      kind: 'rejected',
      message: (rule && CODE_TEXT[rule]) || 'The payment could not be recorded. Nothing was saved.',
    };
  }
  return { kind: 'uncertain' };
}
