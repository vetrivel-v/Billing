import { describe, expect, it } from 'vitest';
import { diffIds, rolesOutsideCeiling, withinCeiling } from './privileges.js';

const caller = new Set(['security.role.manage', 'customer.read', 'report.sales.read']);

describe('privilege ceiling', () => {
  it('allows roles whose permissions are all held by the caller', () => {
    expect(
      rolesOutsideCeiling(caller, [
        { id: 'r1', permissionKeys: ['customer.read'] },
        { id: 'r2', permissionKeys: ['customer.read', 'report.sales.read'] },
        { id: 'r3', permissionKeys: [] },
      ]),
    ).toEqual([]);
  });

  it('flags every role that contains even one permission the caller lacks', () => {
    expect(
      rolesOutsideCeiling(caller, [
        { id: 'ok', permissionKeys: ['customer.read'] },
        { id: 'admin', permissionKeys: ['customer.read', 'security.user.manage'] },
        { id: 'other', permissionKeys: ['accounting.period.unlock'] },
      ]),
    ).toEqual(['admin', 'other']);
  });

  it('is permission based: a role named "Administrator" is flagged only if it exceeds the caller', () => {
    expect(
      rolesOutsideCeiling(caller, [{ id: 'Administrator', permissionKeys: ['customer.read'] }]),
    ).toEqual([]);
    expect(
      rolesOutsideCeiling(new Set(), [{ id: 'x', permissionKeys: ['customer.read'] }]),
    ).toEqual(['x']);
  });

  it('withinCeiling compares permission sets', () => {
    expect(withinCeiling(caller, new Set(['customer.read']))).toBe(true);
    expect(withinCeiling(caller, new Set())).toBe(true);
    expect(withinCeiling(caller, new Set(['customer.read', 'security.user.manage']))).toBe(false);
    expect(withinCeiling(new Set(), new Set(['a.b']))).toBe(false);
  });

  it('diffIds returns what a replacement adds and removes, ignoring duplicates', () => {
    expect(diffIds(['a', 'b'], ['b', 'c', 'c'])).toEqual({ added: ['c'], removed: ['a'] });
    expect(diffIds([], ['a'])).toEqual({ added: ['a'], removed: [] });
    expect(diffIds(['a'], [])).toEqual({ added: [], removed: ['a'] });
    expect(diffIds(['a'], ['a'])).toEqual({ added: [], removed: [] });
  });
});
