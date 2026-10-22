import type { RecoveryGateReason } from '@commercebill/shared-types';
import { ApiError, ApiUnreachableError } from '../api.js';
import { describeFailure } from '../messages.js';

export { passphraseProblem } from '@commercebill/backup/browser';

export const PASSPHRASE_TEXT: Record<string, string> = {
  required: 'Enter a passphrase.',
  blank: 'The passphrase cannot be only spaces.',
  too_short: 'Use at least 12 characters.',
  too_long: 'Use at most 200 characters.',
  mismatch: 'The two passphrases are not the same.',
};

export const GATE_TEXT: Record<RecoveryGateReason, string> = {
  CURRENT: 'A recent backup was restored into a separate test database and checked successfully.',
  NO_VERIFIED_BACKUP: 'No backup has been verified yet. Create a backup and verify it.',
  LATEST_VERIFICATION_FAILED:
    'The latest verification failed. Create a new backup and verify it before relying on any backup.',
  VERIFICATION_ENGINE_CHANGED:
    'The verification method changed since the last check. Verify a backup again.',
  SCHEMA_CHANGED:
    'The database structure changed after the last verification. Create and verify a new backup.',
  DATABASE_CHANGED:
    'This is a different database from the one that was verified (for example after a restore). Create and verify a new backup.',
  VERIFICATION_TOO_OLD: 'The last successful verification is too old. Verify a recent backup.',
};

export const READINESS_LABEL: Record<string, string> = {
  TAX_REVIEW_CURRENT: 'Tax configuration reviewed and current',
  SELLER_REGISTERED_VALID: 'Seller GST registration recorded and valid',
  HSN_SAC_POLICY: 'HSN/SAC policy set',
  BACKUP_RESTORE_VERIFIED: 'Backup and recovery verified',
};

export const CHECK_LABEL: Record<string, string> = {
  archive_authenticated: 'Backup file is authentic and unchanged',
  archive_readable: 'Backup file can be opened',
  manifest_valid: 'Backup description is valid',
  checksums_match: 'Backup contents match their checksums',
  restore_load: 'Backup loads into a test database',
  schema_version: 'Database structure version',
  organization_present: 'Business record present',
  administrator_present: 'Administrator present',
  permissions_present: 'Roles and permissions present',
  foreign_keys: 'Records point at records that exist',
  product_references: 'Product references intact',
  protective_triggers_present: 'Safety rules present',
  stock_balance_reconciles_to_ledger: 'Stock balances agree with stock history',
  stock_projection_matches_backup: 'Stock balances match the backup',
  tax_configuration_present: 'Tax configuration present',
  tax_review_integrity: 'Tax review history intact',
  document_sequences_consistent: 'Document numbering consistent',
  invoice_numbers_issued_by_ledger: 'Invoice numbers all issued',
  payment_numbers_issued_by_ledger: 'Payment numbers all issued',
  invoice_totals_equal_lines: 'Invoice totals equal their lines',
  invoice_dispatch_links: 'Stock dispatches linked to invoices',
  payments_fully_allocated: 'Payments fully allocated',
  payment_allocation_links: 'Payment allocations linked',
  allocations_within_invoice_totals: 'Payments within invoice totals',
  demo_production_separation: 'Demo and real data kept apart',
  audit_history_present: 'Audit history present',
  restored_content_identical: 'Restored data identical to the backup',
};
export const checkLabel = (name: string): string => CHECK_LABEL[name] ?? name;

const RULE_TEXT: Record<string, string> = {
  wrong_passphrase_or_damaged:
    'The passphrase is wrong, or the backup file is damaged or has been changed. Check the passphrase and try again.',
  unreadable_backup: 'This file is not a CommerceBill backup that can be opened.',
  busy: 'Another backup or restore is running. Wait for it to finish and try again.',
  no_destination: 'Choose a backup folder first.',
  file_missing: 'The backup file is no longer in the backup folder.',
  schema_mismatch:
    'This backup was made by a different version of CommerceBill and cannot be restored here.',
  organization_mismatch: 'This backup belongs to a different business and cannot be restored here.',
  safety_backup_failed:
    'The safety backup of your current data could not be completed, so nothing was restored. Your data is unchanged.',
  restore_failed:
    'The restore did not complete. Your current data was kept and is unchanged. See the verification details and try again.',
  confirmation_required: 'Type RESTORE to confirm.',
  out_of_range: 'Enter a number from 1 to 365, or leave it empty to keep every backup.',
};

/** Value-free, plain wording for a failed backup call. Never shows server text, paths or codes. */
export function describeBackupFailure(err: unknown): string {
  if (err instanceof ApiError) {
    const rule = err.problems[0]?.rule;
    if (rule && RULE_TEXT[rule]) return RULE_TEXT[rule];
    if (err.status === 403) return 'You do not have permission to do this.';
  }
  if (err instanceof ApiUnreachableError) return describeFailure(err);
  return describeFailure(err);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const DATE = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
export const formatWhen = (iso: string): string => DATE.format(new Date(iso));
