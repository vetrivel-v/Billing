/**
 * Pure validation for the tax configuration screens. The server runs it on every request; the UI runs the same functions
 * for early feedback. Problems carry only a field name and a stable rule code - never a submitted value.
 */
export interface Problem {
  field: string;
  rule: string;
}

export const REVIEW_NOTICE_VERSION = 'TAXREV-1';
/** What the reviewer acknowledges. Stored verbatim with every review. */
export const REVIEW_NOTICE_TEXT =
  'I confirm that I, or a tax professional acting for this business, have checked the tax categories, rates, effective dates ' +
  'and jurisdiction rules shown on this screen and consider them suitable for this business. This is a business confirmation ' +
  'recorded by CommerceBill. CommerceBill has not verified these values against any government source, and this confirmation ' +
  'is not a legal or tax certification.';

export const HSN_SAC_KINDS = ['HSN', 'SAC'] as const;
export const HSN_CODE = /^[0-9]{2,8}$/;
export const MAX_HSN_DESCRIPTION = 300;
export const MAX_CAPACITY = 120;
export const MAX_REVIEW_NOTE = 1000;
export const MAX_REASON = 300;

const text = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.normalize('NFC').trim();
  return t === '' ? null : t;
};

export interface NormalizedHsnSac {
  code: string;
  kind: 'HSN' | 'SAC';
  description: string | null;
  isActive: boolean;
}

/**
 * Validates an HSN/SAC entry. On creation `code` and `kind` are required; on an edit they may be repeated only if
 * unchanged (the service refuses a change), and only `description` and `isActive` are editable.
 */
export function validateHsnSac(
  raw: Record<string, unknown>,
  creating: boolean,
):
  | { ok: true; value: Partial<NormalizedHsnSac> & { code?: string; kind?: 'HSN' | 'SAC' } }
  | { ok: false; problems: Problem[] } {
  const problems: Problem[] = [];
  const add = (field: string, rule: string) => problems.push({ field, rule });
  const allowed = ['code', 'kind', 'description', 'isActive'];
  for (const k of Object.keys(raw)) if (!allowed.includes(k)) add(k, 'unknown_field');

  const value: Partial<NormalizedHsnSac> = {};
  if (creating || raw.code !== undefined) {
    const code = text(raw.code);
    if (code === null) add('code', 'required');
    else if (!HSN_CODE.test(code)) add('code', 'invalid_code');
    else value.code = code;
  }
  if (creating || raw.kind !== undefined) {
    if (raw.kind === undefined || raw.kind === null || raw.kind === '') add('kind', 'required');
    else if (raw.kind !== 'HSN' && raw.kind !== 'SAC') add('kind', 'invalid_value');
    else value.kind = raw.kind;
  }
  if (raw.description !== undefined) {
    if (raw.description !== null && typeof raw.description !== 'string')
      add('description', 'invalid_type');
    else {
      const d = text(raw.description);
      if (d !== null && [...d].length > MAX_HSN_DESCRIPTION) add('description', 'too_long');
      else value.description = d;
    }
  }
  if (raw.isActive !== undefined) {
    if (typeof raw.isActive !== 'boolean') add('isActive', 'invalid_type');
    else value.isActive = raw.isActive;
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value };
}

export interface NormalizedReview {
  capacity: string;
  note: string | null;
}

/** The reviewer's statement of capacity is required free text; the acknowledgement must be explicit. */
export function validateReviewRequest(
  raw: Record<string, unknown>,
):
  | { ok: true; value: NormalizedReview & { noticeVersion: string; expectedFingerprint: string } }
  | { ok: false; problems: Problem[] } {
  const problems: Problem[] = [];
  const add = (field: string, rule: string) => problems.push({ field, rule });
  for (const k of Object.keys(raw))
    if (!['capacity', 'note', 'acknowledged', 'noticeVersion', 'expectedFingerprint'].includes(k))
      add(k, 'unknown_field');
  const capacity = text(raw.capacity);
  if (capacity === null) add('capacity', 'required');
  else if (capacity.length < 2) add('capacity', 'too_short');
  else if ([...capacity].length > MAX_CAPACITY) add('capacity', 'too_long');
  let note: string | null = null;
  if (raw.note !== undefined && raw.note !== null) {
    if (typeof raw.note !== 'string') add('note', 'invalid_type');
    else {
      note = text(raw.note);
      if (note !== null && [...note].length > MAX_REVIEW_NOTE) add('note', 'too_long');
    }
  }
  if (raw.acknowledged !== true) add('acknowledged', 'acknowledgement_required');
  if (typeof raw.noticeVersion !== 'string' || raw.noticeVersion === '')
    add('noticeVersion', 'required');
  if (
    typeof raw.expectedFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(raw.expectedFingerprint)
  )
    add('expectedFingerprint', 'required');
  if (problems.length > 0 || capacity === null) return { ok: false, problems };
  return {
    ok: true,
    value: {
      capacity,
      note,
      noticeVersion: raw.noticeVersion as string,
      expectedFingerprint: raw.expectedFingerprint as string,
    },
  };
}

/** Turning the HSN/SAC requirement OFF needs an explicit acknowledgement and a reason; turning it on needs neither. */
export function validateHsnPolicy(
  raw: Record<string, unknown>,
):
  | { ok: true; value: { required: boolean; reason: string | null } }
  | { ok: false; problems: Problem[] } {
  const problems: Problem[] = [];
  const add = (field: string, rule: string) => problems.push({ field, rule });
  for (const k of Object.keys(raw))
    if (!['required', 'acknowledged', 'reason'].includes(k)) add(k, 'unknown_field');
  if (typeof raw.required !== 'boolean') add('required', 'invalid_type');
  let reason: string | null = null;
  if (raw.required === false) {
    if (raw.acknowledged !== true) add('acknowledged', 'acknowledgement_required');
    reason = text(raw.reason);
    if (reason === null) add('reason', 'required');
    else if (reason.length < 3) add('reason', 'too_short');
    else if ([...reason].length > MAX_REASON) add('reason', 'too_long');
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: { required: raw.required as boolean, reason } };
}
