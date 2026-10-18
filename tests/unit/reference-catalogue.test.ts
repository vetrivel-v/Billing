import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  ROLE_TEMPLATES,
  TAX_CATEGORIES,
  UNITS,
} from '../../prisma/seed/reference/index.js';
import { PERMISSION_KEY_PATTERN } from '../../prisma/seed/reference/permissions.js';

describe('reference catalogue (static checks)', () => {
  it('has unique, well-formed permission keys', () => {
    const keys = PERMISSIONS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(PERMISSION_KEY_PATTERN);
    for (const p of PERMISSIONS) expect(p.description.length).toBeGreaterThan(5);
  });

  it('defines exactly the five predefined roles with unique names', () => {
    expect(ROLE_TEMPLATES.map((r) => r.name)).toEqual([
      'Administrator',
      'Accountant',
      'Billing Operator',
      'Warehouse Operator',
      'Viewer/Auditor',
    ]);
  });

  it('only grants keys that exist in the catalogue, without duplicates', () => {
    const known = new Set(PERMISSIONS.map((p) => p.key));
    for (const r of ROLE_TEMPLATES) {
      expect(new Set(r.grants).size, `${r.name} has duplicate grants`).toBe(r.grants.length);
      for (const g of r.grants) expect(known.has(g), `${r.name}: unknown ${g}`).toBe(true);
    }
  });

  it('has stable unique upper-case unit codes with valid decimal places', () => {
    expect(new Set(UNITS.map((u) => u.code)).size).toBe(UNITS.length);
    for (const u of UNITS) {
      expect(u.code).toMatch(/^[A-Z0-9]{1,10}$/);
      expect(u.decimalPlaces).toBeGreaterThanOrEqual(0);
      expect(u.decimalPlaces).toBeLessThanOrEqual(4);
    }
  });

  it('expresses tax values as exact decimal strings, never JavaScript numbers', () => {
    expect(new Set(TAX_CATEGORIES.map((c) => c.code)).size).toBe(TAX_CATEGORIES.length);
    for (const c of TAX_CATEGORIES) {
      expect(typeof c.ratePercent).toBe('string');
      expect(c.ratePercent).toMatch(/^\d{1,3}\.\d{4}$/);
      expect(c.cessPercent).toMatch(/^\d{1,3}\.\d{4}$/);
      if (c.classification !== 'STANDARD') expect(c.ratePercent).toBe('0.0000');
    }
  });
});
