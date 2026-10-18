import { PERMISSIONS } from './permissions.js';

/**
 * Predefined role templates (spec section 11). Grants are explicit key lists or simple, reviewable
 * rules over the catalogue. Roles are per organization; `isSystem` roles cannot be deleted.
 *
 * The seed only ever ADDS grants. It never removes a grant, so later administrator customisation of
 * a role is preserved across re-runs.
 */
export interface RoleTemplate {
  name: string;
  description: string;
  grants: readonly string[];
}

const all = PERMISSIONS.map((x) => x.key);
const has =
  (...prefixes: string[]) =>
  (k: string) =>
    prefixes.some((pre) => k.startsWith(pre));
const pick = (...preds: ((k: string) => boolean)[]) => all.filter((k) => preds.some((f) => f(k)));
const except = (keys: readonly string[], ...excluded: ((k: string) => boolean)[]) =>
  keys.filter((k) => !excluded.some((f) => f(k)));

const ADMINISTRATOR = [...all];

// Accountant: sales, purchases, payments, expenses, accounting, reconciliation, GST and financial
// reports. No security administration, no period unlock, no integration credentials, no backup/restore,
// no tax-configuration or numbering changes, no posted-document removal.
const ACCOUNTANT = except(
  pick(
    has('customer.read', 'customer.write', 'customer.import', 'customer.export'),
    has('product.read', 'product.cost.read', 'product.margin.read', 'product.export'),
    has('inventory.stock.read', 'inventory.valuation.read'),
    has('sales.', 'document.print'),
    has('purchase.', 'expense.', 'accounting.', 'report.', 'import.run'),
    has('org.settings.read', 'tax.config.read', 'sequence.read', 'warehouse.read'),
    has('integration.read', 'backup.history.read', 'security.audit.read'),
  ),
  has('security.'),
  (k) => k === 'accounting.period.unlock',
  (k) => k === 'sales.document.delete_posted',
);

// Billing Operator: customers, products (no cost/margin), orders, invoices, payments, printing.
// No period unlock, no posted-document deletion, no integration credentials, no accounting.
const BILLING_OPERATOR = [
  'customer.read',
  'customer.write',
  'product.read',
  'product.write',
  'inventory.stock.read',
  'warehouse.read',
  'sales.order.read',
  'sales.order.write',
  'sales.invoice.read',
  'sales.invoice.write',
  'sales.invoice.post',
  'sales.payment.read',
  'sales.payment.record',
  'document.print',
];

// Warehouse Operator: stock, picking, packing, shipping, transfers, counts, returns receiving.
// No cost, margin, valuation or accounting access.
const WAREHOUSE_OPERATOR = [
  'product.read',
  'warehouse.read',
  'inventory.stock.read',
  'inventory.adjustment.create',
  'inventory.transfer.manage',
  'inventory.count.manage',
  'inventory.pick',
  'inventory.pack',
  'inventory.ship',
  'inventory.return.receive',
  'sales.order.read',
  'report.inventory.read',
];

// Viewer/Auditor: read-only documents and reports. Export permissions are NOT granted by default;
// an administrator must grant them explicitly.
const VIEWER_AUDITOR = pick((k) => PERMISSIONS.find((x) => x.key === k)?.kind === 'read').filter(
  (k) => k !== 'security.user.read' && k !== 'security.role.read',
);

export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  { name: 'Administrator', description: 'Full access', grants: ADMINISTRATOR },
  {
    name: 'Accountant',
    description:
      'Sales, purchases, payments, expenses, accounting and reports; no security administration',
    grants: ACCOUNTANT,
  },
  {
    name: 'Billing Operator',
    description: 'Customers, products, orders, invoices, payments and printing',
    grants: BILLING_OPERATOR,
  },
  {
    name: 'Warehouse Operator',
    description:
      'Stock, picking, packing, shipping, transfers, counts and returns receiving; no cost or accounting access',
    grants: WAREHOUSE_OPERATOR,
  },
  {
    name: 'Viewer/Auditor',
    description: 'Read-only documents and reports; export only if separately permitted',
    grants: VIEWER_AUDITOR,
  },
];
