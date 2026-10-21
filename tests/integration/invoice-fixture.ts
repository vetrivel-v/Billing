// Test-only helpers: a complete billing world (seller, location, warehouse, financial year, numbering sequences, customers,
// products with HSN codes) for one organization, using fictional data. Not shipped.
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@commercebill/database';
import { businessDate } from '@commercebill/invoicing';
import type { FastifyInstance } from 'fastify';
import { call, type Fixture } from './auth-fixture.js';

export const SELLER_GSTIN = '27ABCDE1234F1Z5';

export interface BillingWorld {
  orgId: string;
  today: string;
  locationId: string;
  warehouseId: string;
  financialYearId: string;
  financialYearLabel: string;
  hsnId: string;
  taxId: Record<
    'GST_5' | 'GST_12' | 'GST_18' | 'GST_28' | 'GST_0_NIL' | 'GST_EXEMPT' | 'NON_GST',
    string
  >;
  unit: { pcs: string; kg: string };
  customers: { b2c: string; b2b: string; interState: string; split: string };
  products: {
    /** tracked goods, PCS, 100.00 excl. of GST, GST 18% */
    tracked: string;
    /** untracked goods, PCS, 250.00 excl., GST 18% */
    untracked: string;
    /** tracked goods in KG (3 decimals), 40.00 excl., GST 5% */
    kg: string;
    /** untracked, price includes GST, 1180.00, GST 18% */
    inclusive: string;
    nil: string;
    exempt: string;
    nonGst: string;
    gst5: string;
    gst12: string;
    service: string;
  };
}

const cust = (prisma: PrismaClient, orgId: string, over: Record<string, unknown>) =>
  prisma.customer
    .create({
      data: {
        organizationId: orgId,
        code: `C-${randomUUID().slice(0, 8).toUpperCase()}`,
        customerKind: 'BUSINESS',
        legalName: 'Fictional Buyer',
        gstStatus: 'UNREGISTERED',
        billingAddressLine1: '1 Buyer Lane',
        billingCity: 'Pune',
        billingStateCode: '27',
        placeOfSupplyStateCode: '27',
        ...over,
      } as never,
    })
    .then((c) => c.id);

/** Builds the world. `withSequences: false` leaves numbering unconfigured (to prove a clean refusal). */
export async function setupBillingWorld(
  fx: Fixture,
  orgId: string = fx.orgId,
  opts: { withSequences?: boolean; sellerName?: string } = {},
): Promise<BillingWorld> {
  const prisma = fx.prisma;
  const today = businessDate(fx.clock.now);
  const [y, m] = today.split('-').map((x) => Number(x)) as [number, number];
  const fyStart = m >= 4 ? y : y - 1;
  const label = `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`;

  await prisma.organization.update({
    where: { id: orgId },
    data: {
      legalName: opts.sellerName ?? 'Sample Traders Private Limited',
      tradeName: 'Sample Traders',
      gstStatus: 'REGISTERED',
      gstin: SELLER_GSTIN,
      stateCode: '27',
      setupCompletedAt: new Date(),
    },
  });
  const location = await prisma.businessLocation.create({
    data: {
      organizationId: orgId,
      name: 'Head Office',
      addressLine1: '12 Market Road',
      city: 'Mumbai',
      state: 'Maharashtra',
      stateCode: '27',
      pinCode: '400001',
      gstin: SELLER_GSTIN,
      isPrimary: true,
    },
  });
  const warehouse = await prisma.warehouse.create({
    data: { organizationId: orgId, code: 'MAIN', name: 'Main Warehouse', isPrimary: true },
  });
  const fy = await prisma.financialYear.create({
    data: {
      organizationId: orgId,
      label,
      startDate: new Date(`${fyStart}-04-01T00:00:00Z`),
      endDate: new Date(`${fyStart + 1}-03-31T00:00:00Z`),
    },
  });
  if (opts.withSequences !== false) {
    for (const [documentType, prefix] of [
      ['INVOICE', 'INV/{FY}/'],
      ['DEMO_INVOICE', 'DEMO/{FY}/'],
      ['PAYMENT_RECEIPT', 'PAY/{FY}/'],
      ['DEMO_PAYMENT_RECEIPT', 'DPAY/{FY}/'],
    ] as const) {
      await prisma.documentSequence.create({
        data: {
          organizationId: orgId,
          financialYearId: fy.id,
          documentType,
          prefix,
          numericLength: 6,
          startNumber: 1n,
        },
      });
    }
  }

  const cats = await prisma.taxCategory.findMany({ where: { organizationId: orgId } });
  const taxId = Object.fromEntries(cats.map((c) => [c.code, c.id])) as BillingWorld['taxId'];
  const units = await prisma.unit.findMany({ where: { organizationId: orgId } });
  const unit = {
    pcs: units.find((u) => u.code === 'PCS')!.id,
    kg: units.find((u) => u.code === 'KG')!.id,
  };
  const hsn = await prisma.hsnSacCode.create({
    data: { organizationId: orgId, code: '8517', kind: 'HSN', description: 'Telephone sets' },
  });

  let n = 0;
  const product = (over: Record<string, unknown>) =>
    prisma.product
      .create({
        data: {
          organizationId: orgId,
          sku: `WLD-${++n}-${randomUUID().slice(0, 4).toUpperCase()}`,
          name: `Fictional Item ${n}`,
          kind: 'GOODS',
          unitId: unit.pcs,
          taxCategoryId: taxId.GST_18,
          hsnSacCodeId: hsn.id,
          sellingPrice: '100.00',
          trackInventory: false,
          ...over,
        } as never,
      })
      .then((p) => p.id);

  return {
    orgId,
    today,
    locationId: location.id,
    warehouseId: warehouse.id,
    financialYearId: fy.id,
    financialYearLabel: label,
    hsnId: hsn.id,
    taxId,
    unit,
    customers: {
      b2c: await cust(prisma, orgId, { customerKind: 'INDIVIDUAL', legalName: 'Walk-in Buyer' }),
      b2b: await cust(prisma, orgId, {
        legalName: 'Registered Buyer Pvt Ltd',
        gstStatus: 'REGISTERED',
        gstin: '27AAAAA0000A1Z5',
      }),
      interState: await cust(prisma, orgId, {
        legalName: 'Bengaluru Buyer',
        billingStateCode: '29',
        placeOfSupplyStateCode: '29',
        billingCity: 'Bengaluru',
      }),
      split: await cust(prisma, orgId, {
        legalName: 'Split Address Buyer',
        shippingSameAsBilling: false,
        shippingAddressLine1: '9 Dock Road',
        shippingCity: 'Bengaluru',
        shippingStateCode: '29',
        placeOfSupplyStateCode: '29',
      }),
    },
    products: {
      tracked: await product({ trackInventory: true, name: 'Tracked Widget' }),
      untracked: await product({ sellingPrice: '250.00', name: 'Untracked Gadget' }),
      kg: await product({
        trackInventory: true,
        unitId: unit.kg,
        sellingPrice: '40.00',
        taxCategoryId: taxId.GST_5,
        name: 'Loose Rice',
      }),
      inclusive: await product({
        sellingPrice: '1180.00',
        priceIncludesTax: true,
        name: 'Inclusive Gizmo',
      }),
      nil: await product({ taxCategoryId: taxId.GST_0_NIL, name: 'Nil Rated Item' }),
      exempt: await product({ taxCategoryId: taxId.GST_EXEMPT, name: 'Exempt Item' }),
      nonGst: await product({ taxCategoryId: taxId.NON_GST, name: 'Non-GST Item' }),
      gst5: await product({
        taxCategoryId: taxId.GST_5,
        sellingPrice: '200.00',
        name: 'Five Percent Item',
      }),
      gst12: await product({
        taxCategoryId: taxId.GST_12,
        sellingPrice: '300.00',
        name: 'Twelve Percent Item',
      }),
      service: await product({
        kind: 'SERVICE',
        unitId: null,
        hsnSacCodeId: null,
        name: 'Consulting',
      }),
    },
  };
}

/** The request body for preview/post (D9: no prices, rates or totals ever travel from the browser). */
export interface Line {
  productId: string;
  quantity: string;
  discount?: Record<string, unknown>;
}
export const body = (
  w: BillingWorld,
  over: Record<string, unknown> = {},
  lines: Line[] = [{ productId: w.products.untracked, quantity: '2' }],
) => ({
  mode: 'DEMO',
  customerId: w.customers.b2c,
  lines,
  placeOfSupply: { stateCode: '27', choice: 'CONFIRMED' },
  ...over,
});

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Preview, then post with the previewed identity and a fresh operation id (unless given). */
export async function previewAndPost(
  app: FastifyInstance,
  token: string,
  request: Record<string, unknown>,
  operationId: string = randomUUID(),
) {
  const pr = await call(app, 'POST', '/invoices/preview', { token, body: request });
  const preview = pr.json as unknown as Json;
  const identity = preview.identity as Json | null;
  const post = await call(app, 'POST', '/invoices', {
    token,
    body: { ...request, operationId, ...(identity ? { calculation: identity } : {}) },
  });
  return { preview, post, operationId };
}
