import type { BackupService } from '@commercebill/backup';
import type { PrismaClient } from '@commercebill/database';
import { businessDate } from '@commercebill/invoicing';
import type { DashboardSummaryResponse, DashboardTotals } from '@commercebill/shared-types';
import type { TaxConfigService } from '@commercebill/tax-config';
import type { FastifyInstance } from 'fastify';
import { requireAuthenticatedUser } from './auth-guard.js';

interface Deps {
  prisma: PrismaClient;
  taxConfig: TaxConfigService;
  backup?: BackupService | undefined;
  clock?: (() => Date) | undefined;
}

const money = (v: unknown): string => Number(v ?? 0).toFixed(2);
const totals = (r: { n: bigint; t: unknown } | undefined): DashboardTotals => ({
  count: Number(r?.n ?? 0n),
  total: money(r?.t),
});

/**
 * Dashboard summary (Task 1.18): one read-only, database-side aggregation per section, for the caller's own organization only. Each
 * section appears only for callers holding the permission its data needs. DEMO and PRODUCTION are reported separately, never summed.
 */
export async function registerDashboardRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { prisma } = deps;
  app.get(
    '/dashboard/summary',
    { preHandler: requireAuthenticatedUser },
    async (req): Promise<DashboardSummaryResponse> => {
      const auth = req.auth!;
      const org = auth.organizationId;
      const can = (k: string) => auth.permissions.has(k);
      const today = businessDate((deps.clock ?? (() => new Date()))());
      const monthStart = `${today.slice(0, 8)}01`;

      let sales: DashboardSummaryResponse['sales'] = null;
      let receivables: DashboardSummaryResponse['receivables'] = null;
      let recentInvoices: DashboardSummaryResponse['recentInvoices'] = null;
      if (can('sales.invoice.read')) {
        const rows = await prisma.$queryRaw<
          { is_demo: boolean; tn: bigint; tt: unknown; mn: bigint; mt: unknown }[]
        >`SELECT is_demo,
                 count(*) FILTER (WHERE invoice_date = ${today}::date) AS tn,
                 COALESCE(sum(grand_total) FILTER (WHERE invoice_date = ${today}::date), 0) AS tt,
                 count(*) FILTER (WHERE invoice_date >= ${monthStart}::date) AS mn,
                 COALESCE(sum(grand_total) FILTER (WHERE invoice_date >= ${monthStart}::date), 0) AS mt
            FROM sales_invoices WHERE organization_id = ${org}::uuid AND status = 'POSTED' GROUP BY is_demo`;
        const pick = (demo: boolean) => {
          const r = rows.find((x) => x.is_demo === demo);
          return {
            today: totals(r && { n: r.tn, t: r.tt }),
            month: totals(r && { n: r.mn, t: r.mt }),
          };
        };
        sales = { demo: pick(true), production: pick(false) };
        const open = await prisma.$queryRaw<{ is_demo: boolean; n: bigint; t: unknown }[]>`
          SELECT b.is_demo, count(*) AS n, COALESCE(sum(b.balance_due), 0) AS t
            FROM invoice_balances b JOIN sales_invoices i ON i.id = b.invoice_id
           WHERE b.organization_id = ${org}::uuid AND i.status = 'POSTED' AND b.balance_due > 0
           GROUP BY b.is_demo`;
        const ro = (demo: boolean) => {
          const r = open.find((x) => x.is_demo === demo);
          return { outstanding: money(r?.t), openInvoices: Number(r?.n ?? 0n) };
        };
        receivables = { demo: ro(true), production: ro(false) };
        const recent = await prisma.$queryRaw<
          {
            id: string;
            document_number: string;
            invoice_date: Date;
            customer_name: string;
            grand_total: unknown;
            balance_due: unknown;
            is_demo: boolean;
          }[]
        >`SELECT i.id, i.document_number, i.invoice_date, i.customer_name, i.grand_total, b.balance_due, i.is_demo
            FROM sales_invoices i JOIN invoice_balances b ON b.invoice_id = i.id
           WHERE i.organization_id = ${org}::uuid AND i.status = 'POSTED'
           ORDER BY i.created_at DESC LIMIT 5`;
        recentInvoices = recent.map((r) => ({
          id: r.id,
          documentNumber: r.document_number,
          invoiceDate: r.invoice_date.toISOString().slice(0, 10),
          customerName: r.customer_name,
          grandTotal: money(r.grand_total),
          balanceDue: money(r.balance_due),
          isDemo: r.is_demo,
        }));
      }

      let paymentsToday: DashboardSummaryResponse['paymentsToday'] = null;
      let recentPayments: DashboardSummaryResponse['recentPayments'] = null;
      if (can('sales.payment.read')) {
        const rows = await prisma.$queryRaw<{ is_demo: boolean; n: bigint; t: unknown }[]>`
          SELECT is_demo, count(*) AS n, COALESCE(sum(amount), 0) AS t FROM payments
           WHERE organization_id = ${org}::uuid AND payment_date = ${today}::date GROUP BY is_demo`;
        paymentsToday = {
          demo: totals(rows.find((x) => x.is_demo)),
          production: totals(rows.find((x) => !x.is_demo)),
        };
        const recent = await prisma.$queryRaw<
          {
            id: string;
            payment_number: string;
            payment_date: Date;
            customer_name: string;
            amount: unknown;
            is_demo: boolean;
          }[]
        >`SELECT p.id, p.payment_number, p.payment_date, COALESCE(c.display_name, c.legal_name) AS customer_name, p.amount, p.is_demo
            FROM payments p JOIN customers c ON c.id = p.customer_id
           WHERE p.organization_id = ${org}::uuid ORDER BY p.created_at DESC LIMIT 5`;
        recentPayments = recent.map((r) => ({
          id: r.id,
          paymentNumber: r.payment_number,
          paymentDate: r.payment_date.toISOString().slice(0, 10),
          customerName: r.customer_name,
          amount: money(r.amount),
          isDemo: r.is_demo,
        }));
      }

      let stock: DashboardSummaryResponse['stock'] = null;
      if (can('inventory.stock.read')) {
        const r = await prisma.$queryRaw<{ tracked: bigint; with_stock: bigint }[]>`
          SELECT count(*) AS tracked, count(*) FILTER (WHERE COALESCE(s.q, 0) > 0) AS with_stock
            FROM products p
            LEFT JOIN (SELECT product_id, sum(quantity_on_hand) AS q FROM stock_balances
                        WHERE organization_id = ${org}::uuid GROUP BY product_id) s ON s.product_id = p.id
           WHERE p.organization_id = ${org}::uuid AND p.track_inventory AND p.is_active`;
        const tracked = Number(r[0]?.tracked ?? 0n);
        const withStock = Number(r[0]?.with_stock ?? 0n);
        stock = { trackedProducts: tracked, withStock, outOfStock: tracked - withStock };
      }

      let recovery: DashboardSummaryResponse['recovery'] = null;
      if (can('backup.history.read') && deps.backup) {
        const s = await deps.backup.status(org);
        recovery = {
          gate: s.gate,
          lastBackupAt: s.lastBackup?.createdAt ?? null,
          lastVerifiedAt: s.lastVerifiedAt,
        };
      }

      let readiness: DashboardSummaryResponse['readiness'] = null;
      const ctx =
        can('tax.config.read') || can('backup.history.read')
          ? await deps.taxConfig.billingContext(prisma, org)
          : null;
      if (ctx) {
        readiness = {
          items: ctx.gate.requirements.map((r) => ({ code: r.code, met: r.met })),
          ready: ctx.gate.eligible,
        };
      }
      return {
        asOf: today,
        mode: ctx?.mode ?? 'DEMO',
        sales,
        receivables,
        paymentsToday,
        recentInvoices,
        recentPayments,
        stock,
        recovery,
        readiness,
      };
    },
  );
}
