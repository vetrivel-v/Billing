import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTH_CONFIG } from '@commercebill/auth';
import { setupDraftDataSchema, storedDraftSchema } from './schema.js';
import { validateSetupInput } from './validate-input.js';

const policy = DEFAULT_AUTH_CONFIG.password;
const PASSWORD = 'gentle river walks at dawn';

const valid = () => ({
  business: {
    legalName: 'DEMO Traders Pvt Ltd (fictional)',
    tradeName: 'Demo Traders',
    businessType: 'Retail',
    pan: 'AAPFU0939F',
    gstStatus: 'REGISTERED',
    gstin: '27AAPFU0939F1ZV',
    stateCode: '27',
  },
  location: { name: 'Head Office', addressLine1: '12 Demo Road', city: 'Pune', pinCode: '411001' },
  warehouse: { code: 'main', name: 'Main Warehouse' },
  financialYear: { startDate: '2026-04-01' },
  administrator: {
    username: 'Shop.Owner',
    displayName: 'Shop Owner',
    email: 'owner@example.test',
    password: PASSWORD,
  },
});

const check = (mutate: (v: ReturnType<typeof valid>) => unknown) => {
  const v = valid();
  return validateSetupInput(mutate(v) ?? v, policy);
};
const problems = (r: ReturnType<typeof validateSetupInput>) =>
  r.ok ? [] : r.problems.map((p) => `${p.field}:${p.rule}`);

describe('validateSetupInput - accepted input', () => {
  it('accepts a complete valid submission and normalises it', () => {
    const r = validateSetupInput(valid(), policy);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.business.gstin).toBe('27AAPFU0939F1ZV');
    expect(r.value.business.stateName).toBe('Maharashtra');
    expect(r.value.warehouse.code).toBe('MAIN'); // upper-cased
    expect(r.value.administrator.username).toBe('shop.owner'); // canonical lower case
    expect(r.value.financialYearStart.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('accepts an unregistered business with no GSTIN and applies defaults', () => {
    const r = check((v) => {
      v.business.gstStatus = 'UNREGISTERED';
      delete (v.business as { gstin?: string }).gstin;
      delete (v.business as { pan?: string }).pan;
      delete (v as { warehouse?: unknown }).warehouse;
      delete (v.location as { name?: string }).name;
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.warehouse).toEqual({ code: 'MAIN', name: 'Main Warehouse' });
    expect(r.value.location.name).toBe('Head Office');
  });

  it('trims, upper-cases identifiers and keeps Devanagari text intact', () => {
    const r = check((v) => {
      v.business.legalName = '  डेमो व्यापार प्रा. लि. (काल्पनिक)  ';
      v.business.pan = ' aapfu0939f ';
      v.business.gstin = ' 27aapfu0939f1zv ';
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.business.legalName).toBe('डेमो व्यापार प्रा. लि. (काल्पनिक)');
    expect(r.value.business.pan).toBe('AAPFU0939F');
    expect(r.value.business.gstin).toBe('27AAPFU0939F1ZV');
  });

  it('allows a composition taxpayer with or without a GSTIN (no rule invented beyond the approved ones)', () => {
    expect(
      check((v) => {
        v.business.gstStatus = 'COMPOSITION';
      }).ok,
    ).toBe(true);
    expect(
      check((v) => {
        v.business.gstStatus = 'COMPOSITION';
        delete (v.business as { gstin?: string }).gstin;
      }).ok,
    ).toBe(true);
  });
});

describe('validateSetupInput - rejected input (value-free problem codes)', () => {
  it.each([
    [
      'missing legal name',
      (v: ReturnType<typeof valid>) => {
        v.business.legalName = '   ';
      },
      'business.legalName:too_small',
    ],
    [
      'bad PAN format',
      (v: ReturnType<typeof valid>) => {
        v.business.pan = 'AAPFU0939';
      },
      'business.pan:invalid_pan_format',
    ],
    [
      'registered without GSTIN',
      (v: ReturnType<typeof valid>) => {
        delete (v.business as { gstin?: string }).gstin;
      },
      'business.gstin:gstin_required',
    ],
    [
      'unregistered with GSTIN',
      (v: ReturnType<typeof valid>) => {
        v.business.gstStatus = 'UNREGISTERED';
      },
      'business.gstin:gstin_not_allowed',
    ],
    [
      'GSTIN bad format',
      (v: ReturnType<typeof valid>) => {
        v.business.gstin = '27AAPFU0939F1XV';
      },
      'business.gstin:invalid_gstin_format',
    ],
    [
      'GSTIN bad checksum',
      (v: ReturnType<typeof valid>) => {
        v.business.gstin = '27AAPFU0939F1ZW';
      },
      'business.gstin:invalid_gstin_checksum',
    ],
    [
      'unknown state code',
      (v: ReturnType<typeof valid>) => {
        v.business.stateCode = '39';
        v.business.gstin = '27AAPFU0939F1ZV';
      },
      'business.stateCode:unknown_state_code',
    ],
    [
      'GSTIN state differs from state code',
      (v: ReturnType<typeof valid>) => {
        v.business.stateCode = '07';
      },
      'business.gstin:gstin_state_mismatch',
    ],
    [
      'GSTIN embeds a different PAN',
      (v: ReturnType<typeof valid>) => {
        v.business.pan = 'ABCDE1234F';
      },
      'business.gstin:gstin_pan_mismatch',
    ],
    [
      'missing address',
      (v: ReturnType<typeof valid>) => {
        v.location.addressLine1 = ' ';
      },
      'location.addressLine1:too_small',
    ],
    [
      'bad PIN',
      (v: ReturnType<typeof valid>) => {
        v.location.pinCode = '012345';
      },
      'location.pinCode:invalid_pin_code',
    ],
    [
      'bad warehouse code',
      (v: ReturnType<typeof valid>) => {
        v.warehouse.code = 'has space';
      },
      'warehouse.code:invalid_warehouse_code',
    ],
    [
      'bad FY date',
      (v: ReturnType<typeof valid>) => {
        v.financialYear.startDate = '2027-02-29';
      },
      'financialYear.startDate:invalid_date',
    ],
    [
      'FY out of range',
      (v: ReturnType<typeof valid>) => {
        v.financialYear.startDate = '1999-04-01';
      },
      'financialYear.startDate:date_out_of_range',
    ],
    [
      'bad username',
      (v: ReturnType<typeof valid>) => {
        v.administrator.username = 'a b';
      },
      'administrator.username:invalid_username',
    ],
    [
      'missing display name',
      (v: ReturnType<typeof valid>) => {
        v.administrator.displayName = '';
      },
      'administrator.displayName:too_small',
    ],
    [
      'bad e-mail',
      (v: ReturnType<typeof valid>) => {
        v.administrator.email = 'not-an-email';
      },
      'administrator.email:invalid_email',
    ],
    [
      'short password',
      (v: ReturnType<typeof valid>) => {
        v.administrator.password = 'short';
      },
      'administrator.password:too_short',
    ],
    [
      'common password',
      (v: ReturnType<typeof valid>) => {
        v.administrator.password = 'password123456';
      },
      'administrator.password:common_password',
    ],
    [
      'password contains username',
      (v: ReturnType<typeof valid>) => {
        v.administrator.password = 'my shop.owner login!';
      },
      'administrator.password:contains_username',
    ],
  ])('%s', (_name, mutate, expected) => {
    const r = check((v) => {
      mutate(v);
    });
    expect(r.ok).toBe(false);
    expect(problems(r)).toContain(expected);
  });

  it('reports all problems together, never echoing submitted values', () => {
    const r = check((v) => {
      v.business.pan = 'SECRETPAN1';
      v.business.gstin = 'LEAKYGSTIN';
      v.administrator.password = 'Sup3r-Secret-Value-123';
      v.administrator.username = 'bad name';
    });
    expect(r.ok).toBe(false);
    const text = JSON.stringify(r);
    for (const secret of ['SECRETPAN1', 'LEAKYGSTIN', 'Sup3r-Secret-Value-123', 'bad name']) {
      expect(text).not.toContain(secret);
    }
    expect(problems(r).length).toBeGreaterThan(2);
  });

  it.each([
    [
      'unknown top-level key',
      (v: Record<string, unknown>) => {
        v.token = 'x';
      },
    ],
    [
      'password hash smuggled in',
      (v: Record<string, unknown>) => {
        (v.administrator as Record<string, unknown>).passwordHash = '$argon2id$x';
      },
    ],
    [
      'unknown business key',
      (v: Record<string, unknown>) => {
        (v.business as Record<string, unknown>).extra = 1;
      },
    ],
    [
      'wrong type',
      (v: Record<string, unknown>) => {
        (v.business as Record<string, unknown>).legalName = 42;
      },
    ],
    [
      'over-long field',
      (v: Record<string, unknown>) => {
        (v.business as Record<string, unknown>).legalName = 'x'.repeat(201);
      },
    ],
  ])('rejects structurally invalid input: %s', (_n, mutate) => {
    const v = valid() as unknown as Record<string, unknown>;
    mutate(v);
    expect(validateSetupInput(v, policy).ok).toBe(false);
  });

  it.each([null, undefined, 'string', 42, [], {}])('rejects a non-object body %j', (body) => {
    expect(validateSetupInput(body, policy).ok).toBe(false);
  });
});

describe('draft schemas never accept secrets', () => {
  it('accepts partial and empty drafts (shape only)', () => {
    expect(setupDraftDataSchema.safeParse({}).success).toBe(true);
    expect(
      setupDraftDataSchema.safeParse({ business: { legalName: 'Half done', pan: 'NOT-VALID' } })
        .success,
    ).toBe(true);
    expect(
      setupDraftDataSchema.safeParse({ administrator: { username: 'owner', displayName: 'Owner' } })
        .success,
    ).toBe(true);
  });

  it.each([
    ['password', { administrator: { username: 'owner', password: 'x' } }],
    ['passwordHash', { administrator: { passwordHash: '$argon2id$v=19$' } }],
    ['session token', { token: 'abc' }],
    ['launch secret', { launchSecret: 'abc' }],
    ['integration credential', { integration: { apiKey: 'abc' } }],
    ['encryption key', { business: { encryptionKey: 'abc' } }],
    ['top-level password', { password: 'x' }],
  ])('rejects a draft containing a %s', (_name, draft) => {
    const r = setupDraftDataSchema.safeParse(draft);
    expect(r.success).toBe(false);
  });

  it('the stored form is strictly versioned', () => {
    expect(storedDraftSchema.safeParse({ formatVersion: 1, data: {} }).success).toBe(true);
    expect(storedDraftSchema.safeParse({ formatVersion: 2, data: {} }).success).toBe(false);
    expect(storedDraftSchema.safeParse({ data: {} }).success).toBe(false);
    expect(storedDraftSchema.safeParse({ formatVersion: 1, data: {}, extra: 1 }).success).toBe(
      false,
    );
    expect(storedDraftSchema.safeParse('garbage').success).toBe(false);
    expect(storedDraftSchema.safeParse(null).success).toBe(false);
  });
});

describe('whitespace handling', () => {
  it('trims identifiers but never the password', () => {
    const v = valid();
    v.administrator.password = '  spaces are part of this passphrase  ';
    const r = validateSetupInput(v, policy);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.administrator.password).toBe('  spaces are part of this passphrase  ');
  });
});
