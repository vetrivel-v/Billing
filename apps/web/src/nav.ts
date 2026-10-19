import type { SidebarItemModel } from '@commercebill/ui';

export interface NavModule extends SidebarItemModel {
  path: string;
  /** Permission needed to see the entry. Dashboard needs none (any signed-in user). */
  permission?: string;
}

/**
 * The application modules. Access is derived ONLY from the signed-in user's permission set (never from a role name),
 * and the server remains authoritative. `available` is false until the module is built: such entries are shown as
 * "Coming soon" and are not links.
 */
export const MODULES: readonly NavModule[] = [
  { key: 'dashboard', label: 'Dashboard', path: '/', available: true },
  {
    key: 'customers',
    label: 'Customers',
    path: '/customers',
    permission: 'customer.read',
    available: true,
  },
  {
    key: 'products',
    label: 'Products',
    path: '/products',
    permission: 'product.read',
    available: false,
  },
  {
    key: 'inventory',
    label: 'Inventory',
    path: '/inventory',
    permission: 'inventory.stock.read',
    available: false,
  },
  {
    key: 'billing',
    label: 'Billing',
    path: '/billing',
    permission: 'sales.invoice.read',
    available: false,
  },
  {
    key: 'settings',
    label: 'Settings',
    path: '/settings',
    permission: 'org.settings.read',
    available: false,
  },
];

/** Entries the user may see: no permission required, or the permission is held. */
export function visibleModules(can: (permission: string) => boolean): NavModule[] {
  return MODULES.filter((m) => !m.permission || can(m.permission));
}
