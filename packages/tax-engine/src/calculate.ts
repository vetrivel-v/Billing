/**
 * TaxEngine.calculate - the pure, deterministic GST calculation for the first usable billing scope.
 *
 * Ruleset FUB-GST-1 (provisional; implementation approval only, NOT professional tax approval - R-040):
 *  - all arithmetic is scaled BigInt; the only division is `roundDiv`, half-up, at four named rounding points:
 *      R1  line gross      = round2(quantity x unit price)
 *      R2  percent discount= round2(gross x percent / 100)
 *      R3  each component  = round2(taxable x rate / 100)   (CGST, SGST/UTGST each: taxable x rate / 200, ONE division)
 *      R4  inclusive base  = round2(inclusive amount x 100 / (100 + rate))
 *  - tax is calculated per line and the invoice sums the lines; there is no invoice-level re-rounding of tax
 *  - an inclusive line keeps the price the customer sees exactly; any paisa left over after R3/R4 is returned as an
 *    explicit per-line rounding adjustment (never hidden)
 *  - an optional whole-rupee round-off is a separate invoice line (default NONE)
 * Everything unsupported is REJECTED with a machine-readable code, never ignored. The engine returns codes only: wording is
 * the caller's business.
 */
import {
  formatPaise,
  formatPercent,
  formatQuantityUnits,
  parseScaled,
  roundDiv,
  type Scaled,
} from './decimal.js';
import { canonicalJson, sha256Hex } from './hash.js';
import { inWindow } from './configuration.js';
import { classifySupply, jurisdictionFor, type TaxComponentKind } from './jurisdictions.js';
import { ENGINE_VERSION, ROUNDING_POLICY_ID, RULESET_VERSION } from './version.js';

export interface TaxLineInput {
  lineRef: string;
  productRef: string;
  itemKind: 'GOODS' | 'SERVICE';
  hsnSac: { code: string; kind: 'HSN' | 'SAC' } | null;
  taxCategory: {
    id: string;
    code: string;
    classification: string;
    isActive: boolean;
    effectiveFrom: string | null;
    effectiveTo: string | null;
  };
  /** The effective-dated rate chosen by the caller's rate selector, or null when none was found. */
  rate: {
    id: string;
    categoryId: string;
    ratePercent: string;
    cessPercent: string;
    effectiveFrom: string;
    effectiveTo: string | null;
  } | null;
  quantity: string;
  unitPrice: string;
  discount:
    { type: 'NONE' } | { type: 'PERCENT'; percent: string } | { type: 'AMOUNT'; amount: string };
}

export interface TaxEngineInput {
  engineVersion: string;
  rulesetVersion: string;
  documentType: 'TAX_INVOICE';
  /** Invoice date for the first scope (time of supply other than the invoice date is not supported). */
  taxPointDate: string;
  supplyKind: 'DOMESTIC';
  reverseCharge: boolean;
  supplier: { gstStatus: string; gstin: string | null; stateCode: string };
  recipient: {
    gstStatus: string;
    gstin: string | null;
    billingStateCode: string;
    shippingStateCode: string | null;
  };
  placeOfSupply: { stateCode: string; source: 'SUGGESTED' | 'USER_CONFIRMED' | 'USER_OVERRIDE' };
  priceBasis: 'EXCLUSIVE' | 'INCLUSIVE';
  lines: TaxLineInput[];
  rounding: { invoiceRoundOff: 'NONE' | 'NEAREST_RUPEE' };
  requirements: { hsnSacRequired: boolean };
  /** Reserved. Anything other than undefined/null is rejected (not supported in this ruleset). */
  invoiceDiscount?: unknown;
  charges?: unknown;
  advances?: unknown;
  tcs?: unknown;
  tds?: unknown;
}

export interface EngineMessage {
  /** A stable machine-readable code. */
  code: string;
  lineRef?: string;
  /** The input field the message is about, for example "lines[1].quantity". */
  path?: string;
}

export interface ExplanationStep {
  step: string;
  formula: string;
  inputs: Record<string, string>;
  result: string;
}

export interface ComponentResult {
  kind: TaxComponentKind;
  ratePercent: string;
  amount: string;
}

export interface LineResult {
  lineRef: string;
  productRef: string;
  classification: string;
  hsnSac: { code: string; kind: string } | null;
  taxCategory: { id: string; code: string };
  rate: { id: string; ratePercent: string; effectiveFrom: string; effectiveTo: string | null };
  quantity: string;
  unitPrice: string;
  priceBasis: 'EXCLUSIVE' | 'INCLUSIVE';
  grossAmount: string;
  discountAmount: string;
  taxableValue: string;
  components: ComponentResult[];
  /** Implemented additional levies only (cess is not implemented in FUB-GST-1, so this is always empty). */
  levies: never[];
  /** Inclusive lines: the paisa left over after rounding, so that the line total equals the price shown. */
  roundingAdjustment: string;
  lineTotal: string;
  explanation: ExplanationStep[];
}

export interface InvoiceTotals {
  grossSubtotal: string;
  lineDiscountTotal: string;
  invoiceDiscount: null;
  taxableSubtotal: string;
  componentTotals: Record<TaxComponentKind, string>;
  levies: never[];
  charges: never[];
  roundingAdjustmentTotal: string;
  roundOff: string;
  grandTotal: string;
}

interface ResultBase {
  engineVersion: string;
  rulesetVersion: string;
  roundingPolicyId: string;
  inputHash: string;
  warnings: EngineMessage[];
}

export type TaxEngineResult =
  | (ResultBase & { ok: false; errors: EngineMessage[] })
  | (ResultBase & {
      ok: true;
      /** False while a blocking-for-posting condition remains (the place of supply is only a suggestion). */
      postable: boolean;
      supply: 'INTRA' | 'INTER';
      recipientClassification: 'B2B' | 'B2C';
      placeOfSupply: { stateCode: string; source: string; confirmed: boolean };
      priceBasis: 'EXCLUSIVE' | 'INCLUSIVE';
      taxPointDate: string;
      lines: LineResult[];
      totals: InvoiceTotals;
    });

const TOP_KEYS = new Set([
  'engineVersion',
  'rulesetVersion',
  'documentType',
  'taxPointDate',
  'supplyKind',
  'reverseCharge',
  'supplier',
  'recipient',
  'placeOfSupply',
  'priceBasis',
  'lines',
  'rounding',
  'requirements',
  'invoiceDiscount',
  'charges',
  'advances',
  'tcs',
  'tds',
]);
const LINE_KEYS = new Set([
  'lineRef',
  'productRef',
  'itemKind',
  'hsnSac',
  'taxCategory',
  'rate',
  'quantity',
  'unitPrice',
  'discount',
]);
const NO_TAX = new Set(['NIL_RATED', 'EXEMPT', 'NON_GST']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isRealDate = (s: unknown): s is string => {
  if (typeof s !== 'string' || !DATE.test(s)) return false;
  try {
    return new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
  } catch {
    return false; // an invalid Date throws on toISOString
  }
};
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const present = (v: unknown) => v !== undefined && v !== null;

const ONE_E4 = 10_000n;
const ONE_E6 = 1_000_000n;
const TWO_E6 = 2_000_000n;
const RATE_MAX = 100n * ONE_E4;

/** The calculation. Never throws for bad input: problems come back as `errors`. */
export function calculate(input: TaxEngineInput): TaxEngineResult {
  let inputHash = '';
  try {
    inputHash = sha256Hex(canonicalJson(input));
  } catch {
    inputHash = 'unhashable-input';
  }
  const warnings: EngineMessage[] = [];
  const errors: EngineMessage[] = [];
  const base = (): ResultBase => ({
    engineVersion: ENGINE_VERSION,
    rulesetVersion: RULESET_VERSION,
    roundingPolicyId: ROUNDING_POLICY_ID,
    inputHash,
    warnings,
  });
  const err = (code: string, path?: string, lineRef?: string) =>
    errors.push({ code, ...(path ? { path } : {}), ...(lineRef ? { lineRef } : {}) });
  const warn = (code: string, lineRef?: string) =>
    warnings.push({ code, ...(lineRef ? { lineRef } : {}) });
  const fail = (): TaxEngineResult => ({ ok: false, errors, ...base() });

  if (!isObj(input)) {
    err('INVALID_INPUT');
    return fail();
  }
  const raw = input as unknown as Record<string, unknown>;
  for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k)) err('UNKNOWN_INPUT_FIELD', k);

  // ---- explicitly unsupported scope (rejected, never ignored) ----
  if (raw.rulesetVersion !== RULESET_VERSION) err('RULESET_UNSUPPORTED', 'rulesetVersion');
  if (raw.documentType !== 'TAX_INVOICE') err('DOCUMENT_TYPE_UNSUPPORTED', 'documentType');
  if (raw.supplyKind !== 'DOMESTIC') err('EXPORT_UNSUPPORTED', 'supplyKind');
  if (raw.reverseCharge !== false) err('REVERSE_CHARGE_UNSUPPORTED', 'reverseCharge');
  if (present(raw.invoiceDiscount)) err('INVOICE_DISCOUNT_UNSUPPORTED', 'invoiceDiscount');
  if (present(raw.charges) && !(Array.isArray(raw.charges) && raw.charges.length === 0))
    err('CHARGES_UNSUPPORTED', 'charges');
  if (present(raw.advances)) err('ADVANCES_UNSUPPORTED', 'advances');
  if (present(raw.tcs) || present(raw.tds)) err('TCS_TDS_UNSUPPORTED', 'tcs');

  if (!isRealDate(raw.taxPointDate)) err('INVALID_DATE', 'taxPointDate');
  const date = isRealDate(raw.taxPointDate) ? raw.taxPointDate : '';

  const priceBasis = raw.priceBasis;
  if (priceBasis !== 'EXCLUSIVE' && priceBasis !== 'INCLUSIVE') err('INVALID_INPUT', 'priceBasis');
  const rounding = raw.rounding;
  const roundOffMode = isObj(rounding) ? rounding.invoiceRoundOff : undefined;
  if (roundOffMode !== 'NONE' && roundOffMode !== 'NEAREST_RUPEE')
    err('ROUNDING_OPTION_INVALID', 'rounding.invoiceRoundOff');
  const requirements = raw.requirements;
  const hsnRequired = isObj(requirements) && requirements.hsnSacRequired === true;
  if (!isObj(requirements) || typeof requirements.hsnSacRequired !== 'boolean')
    err('INVALID_INPUT', 'requirements.hsnSacRequired');

  // ---- seller ----
  const supplier = raw.supplier;
  let supplierState = '';
  if (!isObj(supplier)) err('INVALID_INPUT', 'supplier');
  else {
    if (supplier.gstStatus !== 'REGISTERED') err('SELLER_NOT_SUPPORTED', 'supplier.gstStatus');
    if (typeof supplier.gstin !== 'string' || supplier.gstin === '')
      err('SELLER_GSTIN_MISSING', 'supplier.gstin');
    if (typeof supplier.stateCode !== 'string' || !jurisdictionFor(supplier.stateCode))
      err('SELLER_STATE_INVALID', 'supplier.stateCode');
    else {
      supplierState = supplier.stateCode;
      if (
        typeof supplier.gstin === 'string' &&
        supplier.gstin !== '' &&
        supplier.gstin.slice(0, 2) !== supplierState
      )
        err('SELLER_GSTIN_STATE_MISMATCH', 'supplier.gstin');
    }
  }

  // ---- recipient ----
  const recipient = raw.recipient;
  let recipientClass: 'B2B' | 'B2C' = 'B2C';
  let billingState = '';
  let shippingState: string | null = null;
  if (!isObj(recipient)) err('INVALID_INPUT', 'recipient');
  else {
    const st = recipient.gstStatus;
    const gstin = recipient.gstin;
    const hasGstin = typeof gstin === 'string' && gstin !== '';
    if (st !== 'REGISTERED' && st !== 'COMPOSITION' && st !== 'UNREGISTERED')
      err('INVALID_INPUT', 'recipient.gstStatus');
    else if ((st === 'REGISTERED' || st === 'COMPOSITION') && !hasGstin)
      err('RECIPIENT_GSTIN_REQUIRED', 'recipient.gstin');
    else if (st === 'UNREGISTERED' && hasGstin)
      err('RECIPIENT_GSTIN_NOT_ALLOWED', 'recipient.gstin');
    // B2B/B2C is a property of THIS document: B2B exactly when a recipient GSTIN is supplied.
    recipientClass = hasGstin ? 'B2B' : 'B2C';
    if (
      typeof recipient.billingStateCode !== 'string' ||
      !jurisdictionFor(recipient.billingStateCode)
    )
      err('RECIPIENT_STATE_INVALID', 'recipient.billingStateCode');
    else billingState = recipient.billingStateCode;
    if (present(recipient.shippingStateCode)) {
      if (
        typeof recipient.shippingStateCode !== 'string' ||
        !jurisdictionFor(recipient.shippingStateCode)
      )
        err('RECIPIENT_STATE_INVALID', 'recipient.shippingStateCode');
      else shippingState = recipient.shippingStateCode;
    }
  }

  // ---- place of supply: a FACT supplied by the caller; the engine validates it and never derives it ----
  const pos = raw.placeOfSupply;
  let posState = '';
  let posSource = '';
  if (!isObj(pos) || !present(pos.stateCode) || pos.stateCode === '')
    err('PLACE_OF_SUPPLY_MISSING', 'placeOfSupply.stateCode');
  else if (typeof pos.stateCode !== 'string' || !jurisdictionFor(pos.stateCode))
    err('PLACE_OF_SUPPLY_INVALID', 'placeOfSupply.stateCode');
  else posState = pos.stateCode;
  if (isObj(pos)) {
    if (
      pos.source !== 'SUGGESTED' &&
      pos.source !== 'USER_CONFIRMED' &&
      pos.source !== 'USER_OVERRIDE'
    )
      err('INVALID_INPUT', 'placeOfSupply.source');
    else posSource = pos.source;
  }
  // Billing and delivery states differ: the user must have chosen the place of supply explicitly.
  if (
    shippingState &&
    billingState &&
    shippingState !== billingState &&
    posSource !== 'USER_OVERRIDE' &&
    posSource !== ''
  )
    err('PLACE_OF_SUPPLY_SELECTION_REQUIRED', 'placeOfSupply.source');
  if (posSource === 'SUGGESTED') warn('PLACE_OF_SUPPLY_NOT_CONFIRMED');
  if (posSource === 'USER_OVERRIDE') warn('PLACE_OF_SUPPLY_OVERRIDDEN');

  const supply = supplierState && posState ? classifySupply(supplierState, posState) : undefined;

  // ---- lines ----
  const rawLines = raw.lines;
  if (!Array.isArray(rawLines) || rawLines.length === 0) err('INVALID_INPUT', 'lines');
  const seen = new Set<string>();
  const out: LineResult[] = [];
  let sumGross = 0n;
  let sumDisc = 0n;
  let sumTaxable = 0n;
  let sumResidual = 0n;
  let sumTotal = 0n;
  const compTotals: Record<TaxComponentKind, bigint> = { CGST: 0n, SGST: 0n, UTGST: 0n, IGST: 0n };
  let anyStandard = false;

  (Array.isArray(rawLines) ? rawLines : []).forEach((l: unknown, i) => {
    const p = `lines[${i}]`;
    if (!isObj(l)) {
      err('INVALID_INPUT', p);
      return;
    }
    const ref = typeof l.lineRef === 'string' && l.lineRef !== '' ? l.lineRef : undefined;
    if (!ref) err('INVALID_INPUT', `${p}.lineRef`);
    else if (seen.has(ref)) err('DUPLICATE_LINE_REF', `${p}.lineRef`, ref);
    else seen.add(ref);
    for (const k of Object.keys(l))
      if (!LINE_KEYS.has(k)) err('UNKNOWN_INPUT_FIELD', `${p}.${k}`, ref);

    if (l.itemKind !== 'GOODS') err('ITEM_KIND_UNSUPPORTED', `${p}.itemKind`, ref);

    // HSN/SAC
    const h = l.hsnSac;
    if (!present(h)) {
      if (hsnRequired) err('HSN_SAC_REQUIRED', `${p}.hsnSac`, ref);
      else warn('HSN_SAC_MISSING', ref);
    } else if (
      !isObj(h) ||
      typeof h.code !== 'string' ||
      h.code === '' ||
      (h.kind !== 'HSN' && h.kind !== 'SAC')
    )
      err('INVALID_INPUT', `${p}.hsnSac`, ref);
    else if (l.itemKind === 'GOODS' && h.kind !== 'HSN')
      err('HSN_SAC_KIND_MISMATCH', `${p}.hsnSac`, ref);

    // tax category + rate
    const cat = l.taxCategory;
    const rate = l.rate;
    let classification = '';
    let rateUnits: Scaled | null = null;
    if (!isObj(cat) || typeof cat.code !== 'string' || typeof cat.id !== 'string') {
      err('INVALID_INPUT', `${p}.taxCategory`, ref);
    } else {
      classification = typeof cat.classification === 'string' ? cat.classification : '';
      if (cat.isActive !== true) err('TAX_CATEGORY_INACTIVE', `${p}.taxCategory`, ref);
      if (
        date &&
        !inWindow(
          date,
          (cat.effectiveFrom as string | null) ?? null,
          (cat.effectiveTo as string | null) ?? null,
        )
      )
        err('TAX_CATEGORY_NOT_EFFECTIVE', `${p}.taxCategory`, ref);
      if (classification === 'ZERO_RATED')
        err('CLASSIFICATION_UNSUPPORTED', `${p}.taxCategory`, ref);
      else if (classification !== 'STANDARD' && !NO_TAX.has(classification))
        err('CLASSIFICATION_UNKNOWN', `${p}.taxCategory`, ref);
      if (!isObj(rate)) {
        err('NO_EFFECTIVE_RATE', `${p}.rate`, ref);
      } else {
        if (rate.categoryId !== cat.id) err('RATE_CATEGORY_MISMATCH', `${p}.rate`, ref);
        if (
          date &&
          !inWindow(date, rate.effectiveFrom as string, (rate.effectiveTo as string | null) ?? null)
        )
          err('RATE_OUTSIDE_EFFECTIVE_WINDOW', `${p}.rate`, ref);
        rateUnits = parseScaled(rate.ratePercent, 4, 3);
        const cess = parseScaled(rate.cessPercent, 4, 3);
        if (!rateUnits || rateUnits.units > RATE_MAX || !cess) {
          err('INVALID_DECIMAL', `${p}.rate`, ref);
          rateUnits = null;
        } else {
          if (cess.units > 0n) err('CESS_UNSUPPORTED', `${p}.rate.cessPercent`, ref);
          if (classification === 'STANDARD' && rateUnits.units === 0n)
            err('CLASSIFICATION_RATE_MISMATCH', `${p}.rate`, ref);
          if (NO_TAX.has(classification) && rateUnits.units !== 0n)
            err('CLASSIFICATION_RATE_MISMATCH', `${p}.rate`, ref);
        }
      }
    }

    // quantity and price
    const q = parseScaled(l.quantity, 4, 12);
    const price = parseScaled(l.unitPrice, 2, 14);
    if (!q || q.units === 0n) err('INVALID_DECIMAL', `${p}.quantity`, ref);
    if (!price) err('INVALID_DECIMAL', `${p}.unitPrice`, ref);
    if (!q || q.units === 0n || !price) return;

    // R1: line gross
    const gross = roundDiv(q.units * price.units, ONE_E4);

    // discount (R2 for percent)
    let discount = 0n;
    const d = l.discount;
    const explanation: ExplanationStep[] = [
      {
        step: 'GROSS',
        formula: 'round2(quantity x unitPrice)',
        inputs: { quantity: formatQuantityUnits(q.units), unitPrice: formatPaise(price.units) },
        result: formatPaise(gross),
      },
    ];
    if (!isObj(d) || (d.type !== 'NONE' && d.type !== 'PERCENT' && d.type !== 'AMOUNT'))
      err('DISCOUNT_TYPE_UNSUPPORTED', `${p}.discount`, ref);
    else if (d.type === 'PERCENT') {
      const pc = parseScaled(d.percent, 4, 3);
      if (!pc || pc.units > RATE_MAX) err('DISCOUNT_RANGE_INVALID', `${p}.discount.percent`, ref);
      else {
        discount = roundDiv(gross * pc.units, ONE_E6);
        explanation.push({
          step: 'DISCOUNT_PERCENT',
          formula: 'round2(gross x percent / 100)',
          inputs: { gross: formatPaise(gross), percent: formatPercent(pc.units, 4) },
          result: formatPaise(discount),
        });
      }
    } else if (d.type === 'AMOUNT') {
      const a = parseScaled(d.amount, 2, 14);
      if (!a) err('DISCOUNT_RANGE_INVALID', `${p}.discount.amount`, ref);
      else if (a.units > gross) err('DISCOUNT_EXCEEDS_GROSS', `${p}.discount.amount`, ref);
      else {
        discount = a.units;
        explanation.push({
          step: 'DISCOUNT_AMOUNT',
          formula: 'fixed amount',
          inputs: { gross: formatPaise(gross) },
          result: formatPaise(discount),
        });
      }
    }
    if (!rateUnits || !supply || (priceBasis !== 'EXCLUSIVE' && priceBasis !== 'INCLUSIVE')) return;
    if (!isObj(cat) || !isObj(rate) || !ref) return;

    const net = gross - discount; // exclusive: the taxable value; inclusive: the price the customer sees
    const standard = classification === 'STANDARD';
    let taxable = net;
    if (standard && priceBasis === 'INCLUSIVE') {
      // R4
      taxable = roundDiv(net * ONE_E6, ONE_E6 + rateUnits.units);
      explanation.push({
        step: 'TAXABLE_FROM_INCLUSIVE',
        formula: 'round2(inclusiveAmount x 100 / (100 + ratePercent))',
        inputs: {
          inclusiveAmount: formatPaise(net),
          ratePercent: formatPercent(rateUnits.units, 4),
        },
        result: formatPaise(taxable),
      });
    } else {
      explanation.push({
        step: 'TAXABLE',
        formula: 'gross - discount',
        inputs: { gross: formatPaise(gross), discount: formatPaise(discount) },
        result: formatPaise(taxable),
      });
    }

    const components: ComponentResult[] = [];
    let taxSum = 0n;
    if (standard) {
      anyStandard = true;
      const intra = supply.supply === 'INTRA';
      for (const kind of supply.components) {
        // R3: one division per component; the half rate is never rounded or pre-divided.
        const amount = intra
          ? roundDiv(taxable * rateUnits.units, TWO_E6)
          : roundDiv(taxable * rateUnits.units, ONE_E6);
        const compRate = intra
          ? formatPercent(rateUnits.units * 5n, 5)
          : formatPercent(rateUnits.units, 4);
        components.push({ kind, ratePercent: compRate, amount: formatPaise(amount) });
        compTotals[kind] += amount;
        taxSum += amount;
        explanation.push({
          step: `COMPONENT_${kind}`,
          formula: intra
            ? 'round2(taxable x ratePercent / 200)'
            : 'round2(taxable x ratePercent / 100)',
          inputs: { taxable: formatPaise(taxable), ratePercent: formatPercent(rateUnits.units, 4) },
          result: formatPaise(amount),
        });
      }
      if (intra) {
        const totalRateTax = roundDiv(taxable * rateUnits.units, ONE_E6);
        if (totalRateTax !== taxSum) warn('COMPONENT_ROUNDING_DIFFERS_FROM_TOTAL_RATE', ref);
      }
    }

    let residual = 0n;
    let lineTotal = taxable + taxSum;
    if (priceBasis === 'INCLUSIVE') {
      residual = net - lineTotal;
      lineTotal = net;
      if (residual !== 0n)
        explanation.push({
          step: 'ROUNDING_ADJUSTMENT',
          formula: 'inclusiveAmount - (taxable + components)',
          inputs: {
            inclusiveAmount: formatPaise(net),
            taxableAndComponents: formatPaise(taxable + taxSum),
          },
          result: formatPaise(residual),
        });
    }
    explanation.push({
      step: 'LINE_TOTAL',
      formula: priceBasis === 'INCLUSIVE' ? 'inclusiveAmount' : 'taxable + components',
      inputs: { taxable: formatPaise(taxable), components: formatPaise(taxSum) },
      result: formatPaise(lineTotal),
    });
    if (taxable === 0n) warn('ZERO_TAXABLE_VALUE', ref);

    sumGross += gross;
    sumDisc += discount;
    sumTaxable += taxable;
    sumResidual += residual;
    sumTotal += lineTotal;
    out.push({
      lineRef: ref,
      productRef: String(l.productRef ?? ''),
      classification,
      hsnSac: isObj(l.hsnSac) ? { code: String(l.hsnSac.code), kind: String(l.hsnSac.kind) } : null,
      taxCategory: { id: String(cat.id), code: String(cat.code) },
      rate: {
        id: String(rate.id),
        ratePercent: formatPercent(rateUnits.units, 4),
        effectiveFrom: String(rate.effectiveFrom),
        effectiveTo: (rate.effectiveTo as string | null) ?? null,
      },
      quantity: formatQuantityUnits(q.units),
      unitPrice: formatPaise(price.units),
      priceBasis,
      grossAmount: formatPaise(gross),
      discountAmount: formatPaise(discount),
      taxableValue: formatPaise(taxable),
      components,
      levies: [],
      roundingAdjustment: formatPaise(residual),
      lineTotal: formatPaise(lineTotal),
      explanation,
    });
  });

  if (errors.length > 0) return fail();
  if (!supply) {
    err('PLACE_OF_SUPPLY_INVALID', 'placeOfSupply.stateCode');
    return fail();
  }
  if (!anyStandard) warn('NO_TAX_ON_ANY_LINE');

  let roundOff = 0n;
  if (roundOffMode === 'NEAREST_RUPEE') roundOff = roundDiv(sumTotal, 100n) * 100n - sumTotal;
  const grand = sumTotal + roundOff;
  return {
    ok: true,
    postable: posSource !== 'SUGGESTED',
    supply: supply.supply,
    recipientClassification: recipientClass,
    placeOfSupply: {
      stateCode: posState,
      source: posSource,
      confirmed: posSource === 'USER_CONFIRMED' || posSource === 'USER_OVERRIDE',
    },
    priceBasis: priceBasis as 'EXCLUSIVE' | 'INCLUSIVE',
    taxPointDate: date,
    lines: out,
    totals: {
      grossSubtotal: formatPaise(sumGross),
      lineDiscountTotal: formatPaise(sumDisc),
      invoiceDiscount: null,
      taxableSubtotal: formatPaise(sumTaxable),
      componentTotals: {
        CGST: formatPaise(compTotals.CGST),
        SGST: formatPaise(compTotals.SGST),
        UTGST: formatPaise(compTotals.UTGST),
        IGST: formatPaise(compTotals.IGST),
      },
      levies: [],
      charges: [],
      roundingAdjustmentTotal: formatPaise(sumResidual),
      roundOff: formatPaise(roundOff),
      grandTotal: formatPaise(grand),
    },
    ...base(),
  };
}
