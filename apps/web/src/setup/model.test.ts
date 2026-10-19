import { describe, expect, it } from 'vitest';
import { gstinCheckCharacter } from '../../../../packages/setup/src/validators.js';
import {
  buildDraftData,
  buildSubmitBody,
  defaultFyStart,
  emptyForm,
  errorsForStep,
  financialYearSummary,
  firstStepWithProblems,
  formFromDraft,
  hasContent,
  invoicePreview,
  ruleText,
  stepForField,
  validateForm,
  type WizardForm,
} from './model.js';

const g14 = '27ABCDE1234F1Z';
const GSTIN = `${g14}${gstinCheckCharacter(g14)}`;

function valid(): WizardForm {
  const f = emptyForm(new Date(2026, 5, 10));
  f.business.legalName = 'Sample Traders';
  f.business.pan = 'ABCDE1234F';
  f.address.addressLine1 = '1 Road';
  f.address.stateCode = '27';
  f.gst = { status: 'REGISTERED', gstin: GSTIN };
  f.admin = {
    displayName: 'Priya',
    username: 'priya.admin',
    email: '',
    password: 'Velvet anchor orbit 7731',
    confirmPassword: 'Velvet anchor orbit 7731',
  };
  return f;
}

describe('defaults', () => {
  it('proposes the Indian financial year containing today', () => {
    expect(defaultFyStart(new Date(2026, 9, 19))).toBe('2026-04-01'); // October 2026
    expect(defaultFyStart(new Date(2027, 1, 5))).toBe('2026-04-01'); // February 2027
    expect(defaultFyStart(new Date(2026, 3, 1))).toBe('2026-04-01'); // 1 April itself
    expect(defaultFyStart(new Date(2026, 2, 31))).toBe('2025-04-01'); // 31 March
  });
});

describe('validateForm', () => {
  it('accepts a complete, consistent form', () => {
    expect(validateForm(valid())).toEqual({});
  });

  it('requires the mandatory fields', () => {
    const e = validateForm(emptyForm());
    for (const f of [
      'business.legalName',
      'location.addressLine1',
      'business.stateCode',
      'business.gstStatus',
      'administrator.displayName',
      'administrator.username',
      'administrator.password',
    ]) {
      expect(e[f], f).toBeTruthy();
    }
    expect(e['business.pan']).toBeUndefined(); // optional
    expect(e['business.gstin']).toBeUndefined(); // no status chosen yet
  });

  it('GST: registered needs a GSTIN, unregistered must not have one, composition may', () => {
    const f = valid();
    f.gst = { status: 'REGISTERED', gstin: '' };
    expect(validateForm(f)['business.gstin']).toBe(ruleText('business.gstin', 'gstin_required'));
    f.gst = { status: 'UNREGISTERED', gstin: GSTIN };
    expect(validateForm(f)['business.gstin']).toBe(ruleText('business.gstin', 'gstin_not_allowed'));
    f.gst = { status: 'UNREGISTERED', gstin: '' };
    expect(validateForm(f)['business.gstin']).toBeUndefined();
    f.gst = { status: 'COMPOSITION', gstin: '' };
    expect(validateForm(f)['business.gstin']).toBeUndefined();
    f.gst = { status: 'COMPOSITION', gstin: GSTIN };
    expect(validateForm(f)['business.gstin']).toBeUndefined();
  });

  it('GST: checks format, check character, state and PAN consistency', () => {
    const f = valid();
    f.gst.gstin = 'NOT-A-GSTIN';
    expect(validateForm(f)['business.gstin']).toContain('format');
    f.gst.gstin = `${g14}${gstinCheckCharacter(g14) === 'A' ? 'B' : 'A'}`;
    expect(validateForm(f)['business.gstin']).toContain('check character');
    f.gst.gstin = GSTIN;
    f.address.stateCode = '29';
    expect(validateForm(f)['business.gstin']).toContain('state');
    f.address.stateCode = '27';
    f.business.pan = 'ZZZZZ9999Z';
    expect(validateForm(f)['business.gstin']).toContain('PAN');
  });

  it('validates PAN, PIN, warehouse code, state and username shapes', () => {
    const f = valid();
    f.business.pan = 'abc';
    f.address.pinCode = '012345';
    f.warehouse.code = 'bad code!';
    f.admin.username = 'A B';
    f.admin.email = 'no-at-sign';
    const e = validateForm(f);
    expect(e['business.pan']).toBeTruthy();
    expect(e['location.pinCode']).toBeTruthy();
    expect(e['warehouse.code']).toBeTruthy();
    expect(e['administrator.username']).toBeTruthy();
    expect(e['administrator.email']).toBeTruthy();
    f.address.stateCode = '98';
    expect(validateForm(f)['business.stateCode']).toBe(ruleText('x', 'unknown_state_code'));
  });

  it('validates the financial-year date', () => {
    const f = valid();
    f.fy.startDate = '2026-02-30';
    expect(validateForm(f)['financialYear.startDate']).toBeTruthy();
    f.fy.startDate = '1999-04-01';
    expect(validateForm(f)['financialYear.startDate']).toContain('between');
    f.fy.startDate = '';
    expect(validateForm(f)['financialYear.startDate']).toBeTruthy();
  });

  it('validates numbering with the numbering engine rules', () => {
    const f = valid();
    f.numbering.invoicePrefix = 'INV/';
    expect(validateForm(f)['numbering.invoicePrefix']).toContain('{FY}');
    f.numbering.invoicePrefix = 'INV $/{FY}/';
    expect(validateForm(f)['numbering.invoicePrefix']).toBeTruthy();
    f.numbering.invoicePrefix = 'INV/{FY}/';
    f.numbering.invoiceStartNumber = '0';
    expect(validateForm(f)['numbering.invoiceStartNumber']).toBeTruthy();
    f.numbering.invoiceStartNumber = '1234567';
    f.numbering.numericWidth = '6';
    expect(validateForm(f)['numbering.invoiceStartNumber']).toContain('width');
    f.numbering.numericWidth = '0';
    expect(validateForm(f)['numbering.numericWidth']).toBeTruthy();
  });

  it('checks password length and confirmation (the server enforces the full policy)', () => {
    const f = valid();
    f.admin.password = 'short';
    f.admin.confirmPassword = 'short';
    expect(validateForm(f)['administrator.password']).toContain('12');
    f.admin.password = 'a-long-enough-password';
    f.admin.confirmPassword = 'something else entirely';
    expect(validateForm(f).confirmPassword).toBeTruthy();
    f.admin.confirmPassword = f.admin.password;
    expect(validateForm(f).confirmPassword).toBeUndefined();
  });
});

describe('step helpers', () => {
  it('maps field paths to steps and finds the first step with a problem', () => {
    expect(stepForField('business.gstin')).toBe('gst');
    expect(stepForField('business.stateCode')).toBe('address');
    expect(stepForField('warehouse.code')).toBe('address');
    expect(stepForField('numbering.invoicePrefix')).toBe('numbering');
    expect(stepForField('administrator.password')).toBe('admin');
    expect(stepForField('(root)')).toBeNull();
    const e = validateForm(emptyForm());
    expect(firstStepWithProblems(e)).toBe('business');
    expect(Object.keys(errorsForStep(e, 'admin')).every((k) => stepForField(k) === 'admin')).toBe(
      true,
    );
    expect(firstStepWithProblems({})).toBeNull();
  });

  it('turns server rule codes into plain wording without echoing anything', () => {
    expect(ruleText('administrator.password', 'common_password')).toContain('too common');
    expect(ruleText('x', 'totally_unknown_rule')).toBe('This value is not acceptable.');
    expect(ruleText('business.pan', 'invalid_pan_format')).toContain('ABCDE1234F');
  });
});

describe('invoice preview and financial year', () => {
  it('formats the first invoice number without any server contact', () => {
    const f = valid();
    f.fy.startDate = '2026-04-01';
    expect(invoicePreview(f)).toEqual({ text: 'INV/2026-27/000001' });
    f.numbering = { invoicePrefix: 'TX-{FY}-', invoiceStartNumber: '42', numericWidth: '4' };
    expect(invoicePreview(f)).toEqual({ text: 'TX-2026-27-0042' });
  });

  it('explains instead of guessing when inputs are invalid', () => {
    const f = valid();
    f.numbering.invoicePrefix = 'INV/';
    expect(invoicePreview(f)).toHaveProperty('error');
    f.numbering.invoicePrefix = 'INV/{FY}/';
    f.fy.startDate = 'nope';
    expect(invoicePreview(f)).toHaveProperty('error');
  });

  it('describes the financial year', () => {
    expect(financialYearSummary('2026-04-01')).toMatchObject({ label: '2026-27' });
    expect(financialYearSummary('2026-01-01')).toMatchObject({ label: '2026' });
    expect(financialYearSummary('bad')).toBeNull();
  });
});

describe('draft and submission shapes', () => {
  it('the draft never contains a password and omits blank values', () => {
    const f = valid();
    const draft = buildDraftData(f);
    expect(JSON.stringify(draft)).not.toContain(f.admin.password);
    expect(JSON.stringify(draft).toLowerCase()).not.toContain('password');
    const d = draft as Record<string, Record<string, unknown>>;
    expect(d.business).toMatchObject({
      legalName: 'Sample Traders',
      gstStatus: 'REGISTERED',
      stateCode: '27',
    });
    expect(d.business).not.toHaveProperty('tradeName');
    expect(d.administrator).toEqual({ displayName: 'Priya', username: 'priya.admin' });
    expect(d.numbering).toEqual({
      invoicePrefix: 'INV/{FY}/',
      invoiceStartNumber: 1,
      numericWidth: 6,
    });
  });

  it('the submission carries the password only inside administrator', () => {
    const f = valid();
    const body = buildSubmitBody(f) as { administrator: Record<string, unknown> };
    expect(body.administrator.password).toBe(f.admin.password);
    expect(
      JSON.stringify({ ...body, administrator: { ...body.administrator, password: '' } }),
    ).not.toContain(f.admin.password);
    expect(JSON.stringify(body)).not.toContain('confirm');
  });

  it('restoring a draft never restores the password', () => {
    const restored = formFromDraft(
      buildDraftData(valid()) as Record<string, Record<string, unknown>>,
    );
    expect(restored.admin.password).toBe('');
    expect(restored.admin.confirmPassword).toBe('');
    expect(restored.admin.username).toBe('priya.admin');
    expect(restored.gst).toEqual({ status: 'REGISTERED', gstin: GSTIN });
    expect(restored.address.stateCode).toBe('27');
  });

  it('never restores a password even from a hostile or old draft that contains one', () => {
    const restored = formFromDraft({
      administrator: {
        username: 'x.admin',
        password: 'leaked-secret-1',
        confirmPassword: 'leaked-secret-1',
      },
    });
    expect(restored.admin.username).toBe('x.admin');
    expect(restored.admin.password).toBe('');
    expect(restored.admin.confirmPassword).toBe('');
  });

  it('copes with a missing or odd draft', () => {
    expect(formFromDraft(undefined).business.legalName).toBe('');
    const odd = formFromDraft({
      business: { gstStatus: 'BOGUS', legalName: 5 as unknown as string },
    });
    expect(odd.gst.status).toBe('');
    expect(odd.business.legalName).toBe('');
  });

  it('knows whether anything has been typed', () => {
    expect(hasContent(emptyForm())).toBe(false);
    const f = emptyForm();
    f.business.legalName = 'x';
    expect(hasContent(f)).toBe(true);
  });
});
