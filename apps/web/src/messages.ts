import { ApiError, ApiUnreachableError } from './api.js';

/** Wording for password-policy and change-password rule codes returned (value-free) by the API. */
const PASSWORD_RULES: Record<string, string> = {
  too_short: 'Use at least 12 characters.',
  too_long: 'Use at most 128 characters.',
  contains_username: 'Do not include your username.',
  common_password: 'This password is too common. Choose a less predictable one.',
  repeated_character: 'Avoid long runs of the same character.',
  contains_product_name: 'Do not include the product name.',
  same_as_current: 'Choose a password that is different from the current one.',
};

export const SERVICE_UNREACHABLE =
  'CommerceBill could not reach its local service. Wait a moment and try again.';
export const RATE_LIMITED = 'Too many attempts. Wait a minute and try again.';
export const UNEXPECTED = 'Something went wrong. Nothing was changed. Try again.';

/** Generic on purpose: identical for an unknown user, a wrong password, a locked and a disabled account. */
export const LOGIN_FAILED = 'Sign-in failed. Check your username and password and try again.';
export const LOGIN_LOCKOUT_NOTICE =
  'Too many unsuccessful attempts. For security, further sign-in attempts may be blocked for about 15 minutes. ' +
  'Try again later, or ask your administrator for help.';

export function passwordRuleText(rule: string): string {
  return PASSWORD_RULES[rule] ?? 'This password is not acceptable.';
}

/** Maps a failed call to user-facing text. Never includes server messages, codes or correlation details. */
export function describeFailure(err: unknown): string {
  if (err instanceof ApiUnreachableError) return SERVICE_UNREACHABLE;
  if (err instanceof ApiError && (err.status === 429 || err.code === 'AUTH_0003'))
    return RATE_LIMITED;
  return UNEXPECTED;
}
