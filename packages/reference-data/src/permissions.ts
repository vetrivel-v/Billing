/**
 * Permission catalogue (spec section 11). Keys are stable machine identifiers
 * `<area>.<resource>.<verb>`; never rename a released key - add a new one.
 *
 * `kind` drives role templates and tests but is NOT stored in the database:
 *   read   - view only
 *   write  - create/change/post/cancel/record
 *   export - extract data out of the application (separately grantable)
 *   admin  - security, configuration, backup, period control
 */
export type PermissionKind = 'read' | 'write' | 'export' | 'admin';

export interface PermissionDef {
  key: string;
  kind: PermissionKind;
  description: string;
}

const p = (key: string, kind: PermissionKind, description: string): PermissionDef => ({
  key,
  kind,
  description,
});

export const PERMISSIONS: readonly PermissionDef[] = [
  // Organization and configuration
  p('org.settings.read', 'read', 'View business settings'),
  p('org.settings.update', 'admin', 'Change business settings'),
  p('tax.config.read', 'read', 'View tax categories and rates'),
  p('tax.config.update', 'admin', 'Change tax categories and rates'),
  p('tax.config.review', 'admin', 'Confirm the tax configuration review and switch billing mode'),
  p('sequence.read', 'read', 'View document number sequences'),
  p('sequence.update', 'admin', 'Change document number sequences'),

  // Security administration
  p('security.user.read', 'read', 'View users'),
  p('security.user.manage', 'admin', 'Create, change and deactivate users'),
  p('security.user.reset_password', 'admin', 'Administrator-assisted password reset'),
  p('security.role.read', 'read', 'View roles and permissions'),
  p('security.role.manage', 'admin', 'Change roles, permissions and user-role assignments'),
  p('security.audit.read', 'read', 'View the audit log'),
  p('security.audit.export', 'export', 'Export the audit log'),

  // Master data
  p('customer.read', 'read', 'View customers'),
  p('customer.write', 'write', 'Create and change customers'),
  p('customer.import', 'write', 'Import customers'),
  p('customer.export', 'export', 'Export customers'),
  p('product.read', 'read', 'View products and stock-keeping data (no cost or margin)'),
  p('product.write', 'write', 'Create and change products and variants'),
  p('product.import', 'write', 'Import products'),
  p('product.export', 'export', 'Export products'),
  p('product.cost.read', 'read', 'View product cost prices'),
  p('product.margin.read', 'read', 'View margin and profitability on products'),
  p('warehouse.read', 'read', 'View warehouses'),
  p('warehouse.manage', 'admin', 'Create and change warehouses'),

  // Inventory
  p('inventory.stock.read', 'read', 'View stock levels and the stock ledger'),
  p('inventory.valuation.read', 'read', 'View stock valuation (cost based)'),
  p('inventory.adjustment.create', 'write', 'Request a stock adjustment'),
  p('inventory.adjustment.approve', 'write', 'Approve a stock adjustment'),
  p('inventory.transfer.manage', 'write', 'Create and receive stock transfers'),
  p('inventory.count.manage', 'write', 'Run stock counts'),
  p('inventory.pick', 'write', 'Pick orders'),
  p('inventory.pack', 'write', 'Pack orders'),
  p('inventory.ship', 'write', 'Ship orders'),
  p('inventory.return.receive', 'write', 'Receive customer returns'),

  // Sales and billing
  p('sales.order.read', 'read', 'View sales orders'),
  p('sales.order.write', 'write', 'Create, change and cancel sales orders'),
  p('sales.invoice.read', 'read', 'View invoices'),
  p('sales.invoice.write', 'write', 'Create and change draft invoices'),
  p('sales.invoice.post', 'write', 'Post invoices'),
  p('sales.invoice.cancel', 'write', 'Cancel posted invoices through a controlled reversal'),
  p('sales.credit_note.write', 'write', 'Create credit and debit notes'),
  p(
    'sales.document.delete_posted',
    'admin',
    'Reserved: gates administrative removal of posted documents. Posted financial records are never hard-deleted (spec section 53); no feature uses this key yet',
  ),
  p('sales.payment.read', 'read', 'View customer payments and statements'),
  p('sales.payment.record', 'write', 'Record customer payments'),
  p('sales.payment.reverse', 'write', 'Reverse customer payments'),
  p('document.print', 'read', 'Print and preview documents'),

  // Purchasing and expenses
  p('purchase.read', 'read', 'View purchase documents'),
  p('purchase.write', 'write', 'Create and post purchase orders, receipts and bills'),
  p('purchase.payment.record', 'write', 'Record supplier payments'),
  p('expense.read', 'read', 'View expenses'),
  p('expense.write', 'write', 'Record expenses'),

  // Accounting
  p('accounting.ledger.read', 'read', 'View chart of accounts, ledgers and journals'),
  p('accounting.journal.post', 'write', 'Post manual journals and reversals'),
  p('accounting.period.lock', 'admin', 'Lock a financial period or year'),
  p('accounting.period.unlock', 'admin', 'Unlock a financial period or year (reason required)'),
  p(
    'accounting.reconciliation.manage',
    'write',
    'Reconcile bank, marketplace and gateway settlements',
  ),

  // Reports
  p('report.sales.read', 'read', 'Run sales reports'),
  p('report.inventory.read', 'read', 'Run inventory reports (no cost)'),
  p('report.gst.read', 'read', 'Run GST supporting reports'),
  p('report.financial.read', 'read', 'Run financial and profitability reports'),
  p('report.export', 'export', 'Export or download report results'),

  // Integrations
  p('integration.read', 'read', 'View integrations and sync history'),
  p('integration.manage', 'admin', 'Configure integrations and run synchronisation'),
  p('integration.credentials.manage', 'admin', 'View or change integration credentials'),

  // Data movement and recovery
  p('import.run', 'write', 'Run data imports'),
  p('data.export.full', 'export', 'Export the complete business data set'),
  p('backup.history.read', 'read', 'View backup history'),
  p('backup.create', 'admin', 'Create backups'),
  p('backup.restore', 'admin', 'Restore backups'),
];

export const PERMISSION_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/;
