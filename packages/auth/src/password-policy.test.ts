import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTH_CONFIG } from './config.js';
import { checkPassword } from './password-policy.js';

const policy = DEFAULT_AUTH_CONFIG.password;
const check = (pw: string, username?: string) => checkPassword(pw, { username }, policy);

describe('password policy', () => {
  it('accepts a long passphrase without composition rules', () => {
    expect(check('plain words make a good passphrase')).toEqual({ ok: true, problems: [] });
    expect(check('correct-horse-battery-staple')).toMatchObject({ ok: true });
  });

  it('rejects passwords shorter than the minimum, counting code points', () => {
    expect(check('short1!')).toMatchObject({
      ok: false,
      problems: expect.arrayContaining(['too_short']),
    });
    expect(check('a'.repeat(11) + 'b').ok).toBe(true); // exactly 12
    expect(check('अ'.repeat(11) + 'ब').ok).toBe(true); // 12 code points, more UTF-16 units
    expect(check('अ'.repeat(10) + 'ब').problems).toContain('too_short');
  });

  it('rejects passwords above the maximum length', () => {
    expect(check('x1'.repeat(65)).problems).toContain('too_long'); // 130
    expect(check('xy'.repeat(64)).problems).not.toContain('too_long'); // 128
  });

  it('rejects passwords containing the username (case and separator insensitive)', () => {
    expect(check('Billing-Clerk-2026-xyz', 'billing.clerk').problems).toContain(
      'contains_username',
    );
    expect(check('MyNameIsPriya-Sharma!', 'priya_sharma').problems).toContain('contains_username');
    expect(check('unrelated passphrase here', 'billing.clerk').ok).toBe(true);
  });

  it('ignores very short usernames when matching (avoids rejecting nearly everything)', () => {
    expect(check('a-perfectly-fine-passphrase', 'ab').ok).toBe(true);
  });

  it.each([
    'password123456',
    'Password@123',
    'QWERTY123456',
    'administrator1',
    'p@ssw0rd',
    'iloveyou123',
  ])('rejects the common password %s when it meets the length rule or not', (pw) => {
    expect(check(pw).problems).toContain('common_password');
  });

  it('rejects a single repeated character and the product name', () => {
    expect(check('aaaaaaaaaaaaaaaa').problems).toContain('repeated_character');
    expect(check('CommerceBill-is-great-2026').problems).toContain('contains_product_name');
  });

  it('honours a custom policy', () => {
    const strict = { minLength: 16, maxLength: 20 };
    expect(checkPassword('exactly sixteen!!', {}, strict).ok).toBe(true);
    expect(checkPassword('too short here', {}, strict).problems).toContain('too_short');
    expect(checkPassword('this one is definitely too long', {}, strict).problems).toContain(
      'too_long',
    );
  });

  it('reports every problem at once', () => {
    const r = check('aaa', 'aaa');
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(
      expect.arrayContaining(['too_short', 'contains_username', 'repeated_character']),
    );
  });
});
