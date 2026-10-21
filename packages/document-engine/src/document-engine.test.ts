import { longInvoice, makeInvoice } from '@commercebill/test-utilities/invoice-snapshot';
import { describe, expect, it } from 'vitest';
import {
  DEMO_NOTICE,
  amountInWords,
  buildInvoiceDocument,
  formatMoney,
  formatRate,
  formatRupees,
  invoiceFileName,
  parseInvoiceSnapshot,
  renderInvoiceHtml,
} from './index.js';

const simple = (
  over: Parameters<typeof makeInvoice>[0] extends infer T ? Partial<T> : never = {},
) =>
  makeInvoice({
    lines: [{ name: 'Untracked Gadget', qty: 2, pricePaise: 25_000, rate: 18 }],
    ...over,
  });
const html = (inv = simple()) => renderInvoiceHtml(buildInvoiceDocument(inv));
const big = (s: string) => BigInt(s.replace('.', ''));

describe('money display (strings only)', () => {
  it('groups in the Indian style', () => {
    expect(formatMoney('0')).toBe('0.00');
    expect(formatMoney('1234567.5')).toBe('12,34,567.50');
    expect(formatMoney('-100000')).toBe('-1,00,000.00');
    expect(formatMoney(null)).toBe('-');
    expect(formatMoney('x')).toBe('x');
    expect(formatRupees('10')).toBe('\u20B910.00');
    expect(formatRupees(null)).toBe('-');
    expect(formatRate('18.0000')).toBe('18%');
    expect(formatRate('2.5000')).toBe('2.5%');
    expect(formatRate('18')).toBe('18%');
    expect(formatRate(null)).toBe('');
  });
});

describe('amount in words (Indian terms, deterministic)', () => {
  it.each([
    ['0', 'Rupees Zero Only'],
    ['0.50', 'Rupees Zero and Fifty Paise Only'],
    ['1', 'Rupees One Only'],
    ['19.01', 'Rupees Nineteen and One Paise Only'],
    ['100', 'Rupees One Hundred Only'],
    ['590.00', 'Rupees Five Hundred Ninety Only'],
    ['1000', 'Rupees One Thousand Only'],
    ['99999.99', 'Rupees Ninety Nine Thousand Nine Hundred Ninety Nine and Ninety Nine Paise Only'],
    ['100000', 'Rupees One Lakh Only'],
    [
      '1234567.8',
      'Rupees Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven and Eighty Paise Only',
    ],
    ['10000000', 'Rupees One Crore Only'],
    ['1000000000', 'Rupees One Hundred Crore Only'],
    [
      '123456789012',
      'Rupees Twelve Thousand Three Hundred Forty Five Crore Sixty Seven Lakh Eighty Nine Thousand Twelve Only',
    ],
  ])('%s', (v, words) => expect(amountInWords(v)).toBe(words));
  it('refuses anything that is not a plain INR amount', () => {
    for (const bad of ['-1', '1.234', 'abc', '', '1e5', '1,000'])
      expect(amountInWords(bad), bad).toBeNull();
  });
});

describe('snapshot validation', () => {
  it('accepts a posted snapshot and refuses malformed or inconsistent ones without echoing values', () => {
    expect(parseInvoiceSnapshot(simple()).ok).toBe(true);
    const r = parseInvoiceSnapshot({ ...simple(), documentNumber: '../../etc/passwd' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.problems)).not.toContain('passwd');
    expect(parseInvoiceSnapshot(null).ok).toBe(false);
    expect(parseInvoiceSnapshot({ ...simple(), lines: [] }).ok).toBe(false);
    expect(parseInvoiceSnapshot({ ...simple(), isDemo: false }).ok).toBe(false); // demo flag and type must agree
    const bad = simple();
    bad.totals.grandTotal = '1e9';
    expect(parseInvoiceSnapshot(bad).ok).toBe(false);
    expect(parseInvoiceSnapshot({ ...simple(), currency: 'USD' }).ok).toBe(false);
  });
});

describe('the document shows the stored snapshot', () => {
  it('uses the seller, customer, product and price exactly as posted', () => {
    const inv = simple({
      customerName: 'Walk-in Buyer',
      sellerName: 'Sample Traders Private Limited',
    });
    const doc = buildInvoiceDocument(inv);
    expect(doc.seller).toMatchObject({
      name: 'Sample Traders Private Limited',
      gstin: '27ABCDE1234F1Z5',
    });
    expect(doc.customer.name).toBe('Walk-in Buyer');
    expect(doc.lines[0]).toMatchObject({
      description: 'Untracked Gadget',
      rate: '250.00',
      quantity: '2',
      unit: 'PCS',
      taxable: '500.00',
      total: '590.00',
    });
    expect(doc.documentNumber).toBe('DEMO/2026-27/000001');
    expect(doc.invoiceDate).toBe('20-10-2026');
    // the engine has no way to look at current master data: the only input is the snapshot, so a later edit cannot reach it
    expect(buildInvoiceDocument(inv)).toEqual(doc);
  });

  it('shows intra-state CGST and SGST with stored rates and amounts, and no IGST', () => {
    const doc = buildInvoiceDocument(simple());
    expect(doc.lines[0]!.tax).toEqual([
      { label: 'CGST 9%', amount: '45.00' },
      { label: 'SGST 9%', amount: '45.00' },
    ]);
    expect(doc.summary.map((r) => r.label)).toEqual([
      'Gross amount',
      'Taxable value',
      'CGST',
      'SGST',
    ]);
    expect(doc.supply).toBe('INTRA');
    expect(doc.placeOfSupply.text).toBe('Maharashtra (27)');
  });

  it('shows inter-state IGST and the place of supply state', () => {
    const doc = buildInvoiceDocument(simple({ supply: 'INTER' }));
    expect(doc.lines[0]!.tax).toEqual([{ label: 'IGST 18%', amount: '90.00' }]);
    expect(doc.summary.map((r) => r.label)).toEqual(['Gross amount', 'Taxable value', 'IGST']);
    expect(doc.placeOfSupply.text).toBe('Karnataka (29)');
    expect(doc.notes).toContain('Inter-state supply: IGST applies.');
  });

  it('shows discounts (percent and amount), different shipping address and fractional quantity', () => {
    const doc = buildInvoiceDocument(
      makeInvoice({
        shippingDifferent: true,
        lines: [
          { name: 'A', qty: 2, pricePaise: 25_000, rate: 18, discountPercent: 10 },
          { name: 'B', qty: 1, qtyText: '1.5', pricePaise: 10_000, rate: 18, discountPaise: 500 },
        ],
      }),
    );
    expect(doc.lines[0]!.discount).toEqual(['10%', '-50.00']);
    expect(doc.lines[1]!.discount).toEqual(['-5.00']);
    expect(doc.lines[1]!.quantity).toBe('1.5');
    expect(doc.summary.find((r) => r.label === 'Discounts')!.value).toBe('-55.00');
    expect(doc.customer.shipping).not.toBeNull();
    expect(doc.customer.shipping!.state).toBe('Karnataka (29)');
    const h = renderInvoiceHtml(doc);
    expect(h).toContain('9 Dock Road');
    expect(h).toContain('1 Buyer Lane');
  });

  it('shows a stored rounding adjustment and round off, and the displayed figures reconcile to the grand total', () => {
    const inv = makeInvoice({
      roundOffPaise: -3,
      lines: [{ name: 'A', qty: 3, pricePaise: 33_333, rate: 12 }],
    });
    inv.totals.roundingAdjustmentTotal = '0.02';
    inv.totals.grandTotal = (big(inv.totals.grandTotal) + 2n)
      .toString()
      .replace(/^(-?\d+)(\d{2})$/, '$1.$2');
    const doc = buildInvoiceDocument(inv);
    const row = (label: string) => doc.summary.find((r) => r.label === label)?.value;
    expect(row('Rounding adjustment')).toBe('0.02');
    expect(row('Round off')).toBe('-0.03');
    // taxable + components + rounding adjustment + round off == grand total (BigInt paise, test-side only)
    const t = inv.totals;
    const sum =
      big(t.taxableSubtotal) +
      big(t.cgst) +
      big(t.sgst) +
      big(t.igst) +
      big(t.roundingAdjustmentTotal) +
      big(t.roundOff);
    expect(sum).toBe(big(t.grandTotal));
    expect(doc.grandTotal).toBe(formatMoney(t.grandTotal));
  });

  it('every line of a normal invoice reconciles: taxable + components = line total', () => {
    const inv = makeInvoice({
      lines: [
        { name: 'A', qty: 3, pricePaise: 12_345, rate: 5 },
        { name: 'B', qty: 7, pricePaise: 99_999, rate: 28, discountPercent: 12.5 },
      ],
    });
    for (const l of inv.lines)
      expect(big(l.taxableValue) + big(l.cgstAmount) + big(l.sgstAmount) + big(l.igstAmount)).toBe(
        big(l.lineTotal),
      );
    const t = inv.totals;
    expect(big(t.taxableSubtotal) + big(t.cgst) + big(t.sgst) + big(t.igst) + big(t.roundOff)).toBe(
      big(t.grandTotal),
    );
  });

  it('labels an invoice with no taxed line as not a Tax Invoice (no invented Bill of Supply)', () => {
    const doc = buildInvoiceDocument(
      makeInvoice({
        isDemo: false,
        lines: [{ name: 'Exempt thing', pricePaise: 10_000, rate: null, classification: 'EXEMPT' }],
      }),
    );
    expect(doc.titleKind).toBe('NO_TAX_NOT_TAX_INVOICE');
    expect(doc.title).toBe('INVOICE');
    expect(doc.notTaxInvoiceNotice).toMatch(/not labelled a Tax Invoice/);
    expect(doc.lines[0]!.tax).toEqual([{ label: 'Exempt', amount: null }]);
    expect(doc.summary.find((r) => r.label === 'GST')!.value).toBe('No tax charged');
    expect(doc.supply).toBeNull();
    expect(doc.notes.join(' ')).not.toMatch(/CGST|IGST/);
    expect(renderInvoiceHtml(doc)).not.toContain('>TAX INVOICE<');
  });

  it('production invoices are titled TAX INVOICE and never carry the DEMO marking', () => {
    const h = html(simple({ isDemo: false }));
    expect(h).toContain('TAX INVOICE');
    expect(h).not.toContain('DEMO');
    expect(h).not.toContain(DEMO_NOTICE);
    expect(h).not.toContain('class="wm"');
  });

  it('indicates amount in words and the poster', () => {
    const h = html();
    expect(h).toContain('Rupees Five Hundred Ninety Only');
    expect(h).toContain('Posted by Administrator (test)');
  });
});

describe('the DEMO marking cannot be removed', () => {
  it('is present in every demo rendering: watermark word, warning text, page margin text, banner', () => {
    for (const inv of [
      simple(),
      simple({ supply: 'INTER' }),
      longInvoice(60),
      makeInvoice({ lines: [{ name: 'x', pricePaise: 100, rate: null }] }),
    ]) {
      const h = html(inv);
      expect(h).toContain('<div class="wm" aria-hidden="true"><span class="big">DEMO</span>');
      expect(h).toContain(DEMO_NOTICE);
      expect(h).toContain('@top-center');
      expect(h).toContain('DEMO - NOT A PRODUCTION TAX INVOICE');
      expect(h).toContain('class="banner"');
      expect(h).toContain('DEMO INVOICE');
    }
  });
  it('the renderer takes no options at all, so there is nothing that could disable it', () => {
    expect(renderInvoiceHtml.length).toBe(1);
    expect(buildInvoiceDocument.length).toBe(1);
  });
  it('is not only a colour: the watermark is the word DEMO and the warning is text', () => {
    const h = html();
    expect(h).toMatch(/-webkit-text-stroke/);
    expect(h).toContain('>DEMO<');
  });
});

describe('the HTML is safe, self-contained and deterministic', () => {
  it('escapes every stored value and contains no script or external resource', () => {
    const inv = simple({
      customerName: '<img src=x onerror=alert(1)> & "Co"',
      sellerName: "Evil'<script>alert(1)</script>",
    });
    const h = html(inv);
    expect(h).not.toMatch(/<script|<imgb|javascript:/i);
    expect(h).not.toMatch(/(?<!&lt;img src=x )onerror=/);
    expect(h).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co&quot;');
    expect(h).toContain('Content-Security-Policy');
    expect(h).not.toMatch(/https?:\/\//);
    expect(h).not.toMatch(/<link|<iframe|<object|<embed|<source|ssrc="/i);
  });
  it('produces identical output for the same invoice (no clock, no randomness)', () => {
    expect(html()).toBe(html());
    expect(html(longInvoice(30))).toBe(html(longInvoice(30)));
  });
  it('keeps rows together, repeats the table header and keeps totals together (page-break rules)', () => {
    const h = html();
    expect(h).toContain('table.items thead { display: table-header-group; }');
    expect(h).toContain('table.items tr { break-inside: avoid; page-break-inside: avoid; }');
    expect(h).toContain('.totals { break-inside: avoid;');
    expect(h).toContain('@bottom-right { content: "Page " counter(page) " of " counter(pages)');
    expect(h).toContain('size: A4');
  });
  it('renders every line of a long invoice (nothing dropped) with the document number in the page margin', () => {
    const inv = longInvoice(150);
    const h = html(inv);
    expect((h.match(/<tr>\n<td class="num">\d+<\/td>/g) ?? []).length).toBe(150);
    for (const l of inv.lines) expect(h).toContain(l.sku);
    expect(h).toContain('@bottom-left { content: "DEMO INVOICE DEMO/2026-27/000001"');
  });
  it('contains no recalculation: the document module imports no calculation code', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    for (const f of ['model.ts', 'html.ts', 'money.ts', 'schema.ts']) {
      const src = readFileSync(resolve(import.meta.dirname, f), 'utf8');
      expect(src, f).not.toMatch(/tax-engine|calculate\(|parseFloat|Number\(\s*(l|t|inv|v)\./);
    }
  });
});

describe('file names', () => {
  const name = (documentNumber: string, isDemo = false) =>
    invoiceFileName({ documentNumber, isDemo });
  it('derives a safe name from the document number', () => {
    expect(name('INV/2026-27/000123')).toBe('INV-2026-27-000123.pdf');
    expect(name('DEMO/2026-27/000123', true)).toBe('DEMO-2026-27-000123.pdf');
    expect(name('2026/000001', true)).toBe('DEMO-2026-000001.pdf');
  });
  it('sanitizes invalid characters, traversal, absolute paths and control characters', () => {
    for (const hostile of [
      '../../Windows/System32/x',
      'a/../b',
      'x..y',
      '..\\..\\evil',
      'C:\\temp\\x',
      '/etc/passwd',
      'a\u0000b\nc\td',
      'a<b>c:d"e|f?g*h',
      '....',
      '.',
      '',
      '   ',
      'CON',
      'nul.txt',
    ]) {
      const n = name(hostile);
      expect(n, hostile).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*\.pdf$/);
      expect(n).not.toMatch(/\.\.|[/\\:*?"<>|]/);
      expect([...n].every((ch) => ch.charCodeAt(0) > 31)).toBe(true);
      expect(n.length).toBeLessThanOrEqual(84);
      expect(n.endsWith('.pdf')).toBe(true);
    }
    expect(name('CON')).toBe('invoice-CON.pdf');
    expect(name('x'.repeat(500)).length).toBe(84);
  });
});
