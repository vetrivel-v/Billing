import { validateHsnSac, validateReviewRequest } from '@commercebill/tax-config/browser';

export const CLASSIFICATION_LABEL: Record<string, string> = {
  STANDARD: 'Standard rate',
  NIL_RATED: 'Nil rated',
  EXEMPT: 'Exempt',
  ZERO_RATED: 'Zero rated (not supported yet)',
  NON_GST: 'Non-GST',
};

export const JURISDICTION_KIND_LABEL: Record<string, string> = {
  STATE: 'State (CGST + SGST)',
  UT_WITH_LEGISLATURE: 'Union territory with legislature (CGST + SGST)',
  UT_WITHOUT_LEGISLATURE: 'Union territory without legislature (CGST + UTGST)',
  OTHER_TERRITORY: 'Other territory (IGST)',
  CENTRE_JURISDICTION: 'Centre jurisdiction (IGST)',
};

export const REQUIREMENT_LABEL: Record<string, string> = {
  TAX_REVIEW_CURRENT: 'The tax configuration has been reviewed and has not changed since',
  SELLER_REGISTERED_VALID: 'The business is a regular GST-registered seller with a valid GSTIN',
  HSN_SAC_POLICY: 'An HSN/SAC policy is in force',
  BACKUP_RESTORE_VERIFIED: 'A backup has been restored and verified (within the last 30 days)',
};

export const SELLER_PROBLEM_LABEL: Record<string, string> = {
  SELLER_NOT_SUPPORTED:
    'Only regular GST-registered sellers can issue tax invoices in this version (composition and unregistered sellers are not supported).',
  SELLER_GSTIN_MISSING: 'The business GSTIN is missing or not in a valid format.',
  SELLER_GSTIN_STATE_MISMATCH: 'The business GSTIN does not start with the business state code.',
};

const RULE_TEXT: Record<string, string> = {
  required: 'This field is required.',
  too_short: 'This is too short.',
  too_long: 'This is too long.',
  invalid_type: 'This value is not acceptable.',
  invalid_value: 'Choose one of the listed options.',
  invalid_code: 'Use 2 to 8 digits only.',
  duplicate_code: 'This code is already in your list.',
  immutable_field: 'The code and type cannot be changed after the entry is created.',
  acknowledgement_required: 'Please tick the box to confirm.',
  notice_outdated: 'The confirmation text has changed. Reload the page and try again.',
  configuration_changed:
    'The tax configuration changed after it was shown. Reload and review it again.',
  requirement_not_met: 'This requirement is not met.',
  unknown_field: 'This value is not accepted.',
};
export const ruleText = (rule: string): string =>
  RULE_TEXT[rule] ?? 'This value is not acceptable.';

export type FieldErrors = Record<string, string>;

export const errorsFromProblems = (problems: { field: string; rule: string }[]): FieldErrors => {
  const out: FieldErrors = {};
  for (const p of problems) if (!out[p.field]) out[p.field] = ruleText(p.rule);
  return out;
};

const FIELD_LABEL: Record<string, string> = {
  capacity: 'Your capacity',
  note: 'Note',
  acknowledged: 'Confirmation',
  reason: 'Reason',
  code: 'Code',
  kind: 'Type',
  description: 'Description',
  expectedFingerprint: 'Configuration',
};
export const describeErrors = (errors: FieldErrors): string[] =>
  Object.entries(errors).map(([f, t]) => (FIELD_LABEL[f] ? `${FIELD_LABEL[f]}: ${t}` : t));

/** Early feedback with the SAME rules as the server. */
export function validateReviewForm(f: {
  capacity: string;
  note: string;
  acknowledged: boolean;
}): FieldErrors {
  const r = validateReviewRequest({
    capacity: f.capacity,
    note: f.note,
    acknowledged: f.acknowledged,
    noticeVersion: 'x',
    expectedFingerprint: '0'.repeat(64),
  });
  return r.ok ? {} : errorsFromProblems(r.problems);
}

export function validateHsnForm(
  f: { code: string; kind: string; description: string },
  creating: boolean,
): FieldErrors {
  const body: Record<string, unknown> = { description: f.description };
  if (creating) {
    body.code = f.code;
    body.kind = f.kind;
  }
  const r = validateHsnSac(body, creating);
  return r.ok ? {} : errorsFromProblems(r.problems);
}

export const shortFingerprint = (fp: string): string => fp.slice(0, 12);

export const formatDate = (iso: string | null): string => {
  if (!iso) return 'open';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}-${m}-${y}`;
};

export const formatDateTime = (iso: string): string => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
