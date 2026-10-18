import type { PasswordPolicy } from './config.js';
import { normalizePassword } from './password.js';

export type PasswordProblem =
  | 'too_short'
  | 'too_long'
  | 'contains_username'
  | 'common_password'
  | 'repeated_character'
  | 'contains_product_name';

export interface PasswordCheck {
  ok: boolean;
  problems: PasswordProblem[];
}

/**
 * A short built-in list of very common passwords (compared after lower-casing and stripping separators).
 * It is a floor, not a breach database; the minimum length does most of the work (NIST SP 800-63B favours
 * length and a blocklist over composition rules, so none are imposed).
 */
const COMMON_PASSWORDS = new Set(
  [
    'password',
    'password1',
    'password12',
    'password123',
    'password1234',
    'passw0rd',
    'p@ssw0rd',
    'p@ssword',
    'qwerty',
    'qwerty123',
    'qwertyuiop',
    'qwerty123456',
    'asdfghjkl',
    'zxcvbnm',
    '1q2w3e4r',
    '1q2w3e4r5t',
    '123456',
    '1234567',
    '12345678',
    '123456789',
    '1234567890',
    '12345678910',
    '123456789012',
    '111111111111',
    '000000000000',
    'abcdef123456',
    'abc123456789',
    'iloveyou',
    'iloveyou123',
    'welcome',
    'welcome123',
    'welcome1234',
    'letmein',
    'letmein123',
    'admin',
    'admin123',
    'admin1234',
    'administrator',
    'administrator1',
    'changeme',
    'changeme123',
    'default',
    'defaultpassword',
    'trustno1',
    'monkey',
    'dragon',
    'sunshine',
    'princess',
    'football',
    'baseball',
    'superman',
    'batman',
    'master',
    'shadow',
    'michael',
    'jordan',
    'hello123',
    'hello1234',
    'india123',
    'india1234',
    'india@123',
    'bharat123',
    'krishna123',
    'ganesh123',
    'ramram123',
    'jaishreeram',
    'sairam123',
    'abcd1234',
    'abcd12345',
    'abcd@1234',
    'test1234',
    'test12345',
    'testing123',
    'guest123',
    'user1234',
    'login123',
    'secret123',
    'mypassword',
    'mypassword1',
    'newpassword',
    'billing123',
    'invoice123',
    'accounts123',
    'gst123456',
    'company123',
    'business123',
    'shop12345',
    'passwordpassword',
    'password@123',
    'password#123',
    'pass1234',
    'pass12345',
    'pass@1234',
    'q1w2e3r4t5y6',
  ].map((p) => p.replace(/[^a-z0-9@#]/g, '')),
);

// A common word followed only by digits/symbols ("password123456") is as weak as the word itself.
const COMMON_BASES = new Set(
  [...COMMON_PASSWORDS].map((p) => p.replace(/[0-9@#]+$/, '')).filter((b) => b.length >= 5),
);

const PRODUCT_NAMES = ['commercebill'];

const canon = (s: string) => s.toLowerCase().replace(/[\s_.-]/g, '');

export function checkPassword(
  password: string,
  context: { username?: string },
  policy: PasswordPolicy,
): PasswordCheck {
  const pw = normalizePassword(password);
  const problems: PasswordProblem[] = [];
  const length = [...pw].length; // count code points, not UTF-16 units
  if (length < policy.minLength) problems.push('too_short');
  if (length > policy.maxLength) problems.push('too_long');

  const c = canon(pw);
  const username = context.username ? canon(normalizePassword(context.username)) : '';
  if (username.length >= 3 && c.includes(username)) problems.push('contains_username');
  const base = c.replace(/[0-9@#!$]+$/, '');
  if (COMMON_PASSWORDS.has(c) || (base.length >= 5 && COMMON_BASES.has(base))) {
    problems.push('common_password');
  }
  if (PRODUCT_NAMES.some((n) => c.includes(n))) problems.push('contains_product_name');
  if (length > 0 && new Set([...pw]).size === 1) problems.push('repeated_character');

  return { ok: problems.length === 0, problems };
}
