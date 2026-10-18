/** Token replaced by the financial-year label (e.g. "2026-27") when a number is formatted. */
export const FY_TOKEN = '{FY}';

export const MAX_AFFIX_LENGTH = 40;
export const MAX_NUMERIC_LENGTH = 18;

/** Letters, digits and / . _ - plus the {FY} token. Anything else (spaces, other braces, quotes) is rejected. */
const AFFIX_BODY = /^[A-Za-z0-9/._-]*$/;

export function isValidAffix(template: string): boolean {
  if (template.length > MAX_AFFIX_LENGTH) return false;
  return AFFIX_BODY.test(template.split(FY_TOKEN).join(''));
}

export function containsFyToken(template: string): boolean {
  return template.includes(FY_TOKEN);
}

export function expandTemplate(template: string, financialYearLabel: string): string {
  return template.split(FY_TOKEN).join(financialYearLabel);
}

export interface FormatInput {
  prefix: string;
  suffix: string;
  numericLength: number;
  number: bigint;
  financialYearLabel: string;
}

/**
 * The single place where a printed document number is built. The configured prefix/suffix/width decide the
 * output; nothing about "INV/2026-27/000001" is hard-coded. Throws if the number does not fit the width, so a
 * number is never silently truncated or widened.
 */
export function formatDocumentNumber(input: FormatInput): string {
  if (input.number < 1n) throw new RangeError('Document numbers start at 1');
  const digits = input.number.toString();
  if (digits.length > input.numericLength) {
    throw new RangeError(`Number ${digits} does not fit a width of ${input.numericLength}`);
  }
  return (
    expandTemplate(input.prefix, input.financialYearLabel) +
    digits.padStart(input.numericLength, '0') +
    expandTemplate(input.suffix, input.financialYearLabel)
  );
}
