import {
  MAX_AFFIX_LENGTH,
  MAX_NUMERIC_LENGTH,
  containsFyToken,
  formatDocumentNumber,
  isValidAffix,
} from './format.js';

export const RESET_POLICIES = ['FINANCIAL_YEAR', 'NEVER'] as const;
export type ResetPolicy = (typeof RESET_POLICIES)[number];

export interface SequenceConfig {
  prefix: string;
  suffix: string;
  numericLength: number;
  startNumber: bigint;
  resetPolicy: ResetPolicy;
}

export interface Problem {
  /** Field path, e.g. "prefix". Never contains submitted values. */
  field: string;
  /** Stable rule code. */
  rule: string;
}

/**
 * Validates a sequence configuration. Rules:
 * - prefix/suffix: letters, digits and / . _ - plus the {FY} token, at most 40 characters each;
 * - width 1-18; start number >= 1 and it must fit the width;
 * - with reset policy FINANCIAL_YEAR the numbers restart every year, so the printed text must contain {FY} or
 *   two years would issue the same text (e.g. INV/000001 twice). NEVER-reset sequences keep counting and need no token.
 */
export function validateSequenceConfig(cfg: SequenceConfig): Problem[] {
  const problems: Problem[] = [];
  const add = (field: string, rule: string) => problems.push({ field, rule });

  if (typeof cfg.prefix !== 'string' || !isValidAffix(cfg.prefix)) add('prefix', 'invalid_prefix');
  if (typeof cfg.suffix !== 'string' || !isValidAffix(cfg.suffix)) add('suffix', 'invalid_suffix');
  if (
    !Number.isInteger(cfg.numericLength) ||
    cfg.numericLength < 1 ||
    cfg.numericLength > MAX_NUMERIC_LENGTH
  ) {
    add('numericLength', 'invalid_width');
  }
  if (typeof cfg.startNumber !== 'bigint' || cfg.startNumber < 1n) {
    add('startNumber', 'invalid_start_number');
  } else if (
    Number.isInteger(cfg.numericLength) &&
    cfg.startNumber.toString().length > cfg.numericLength
  ) {
    add('startNumber', 'start_number_exceeds_width');
  }
  if (!RESET_POLICIES.includes(cfg.resetPolicy)) add('resetPolicy', 'invalid_reset_policy');
  if (
    cfg.resetPolicy === 'FINANCIAL_YEAR' &&
    typeof cfg.prefix === 'string' &&
    typeof cfg.suffix === 'string' &&
    isValidAffix(cfg.prefix) &&
    isValidAffix(cfg.suffix) &&
    !containsFyToken(cfg.prefix) &&
    !containsFyToken(cfg.suffix)
  ) {
    add('prefix', 'format_not_unique_across_years');
  }
  return problems;
}

/** Shows what a number would look like without touching the database (spec section 17: preview). */
export function previewNumber(
  cfg: Pick<SequenceConfig, 'prefix' | 'suffix' | 'numericLength' | 'startNumber'>,
  financialYearLabel: string,
  number: bigint = cfg.startNumber,
): string {
  return formatDocumentNumber({
    prefix: cfg.prefix,
    suffix: cfg.suffix,
    numericLength: cfg.numericLength,
    number,
    financialYearLabel,
  });
}

export { MAX_AFFIX_LENGTH };
