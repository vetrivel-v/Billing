import type { InvoiceDocument } from './model.js';
import { DEMO_MARK } from './model.js';

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

/** A CSS string literal for the page margin boxes. Only characters that are safe inside a CSS string survive. */
const cssText = (s: string): string => `"${s.replace(/[^A-Za-z0-9 /._()-]/g, '')}"`;

// The demo marking (the .wm rule below) is outlined letters - a word, not only a colour - repeated on EVERY printed page because a
// fixed element is painted on each page. Outline-only, so the figures underneath stay readable.
const STYLE = `
@page { size: A4; margin: 14mm 12mm 18mm 12mm; __MARGIN_BOXES__ }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: "Segoe UI", Arial, Helvetica, sans-serif; font-size: 9pt; line-height: 1.35; color: #111827; background: #fff; }
.sheet { position: relative; }
@media screen { body { background: #e5e7eb; } .sheet { background: #fff; width: 210mm; min-height: 297mm; margin: 12px auto; padding: 14mm 12mm 18mm; box-shadow: 0 1px 4px rgba(0,0,0,.25); } }
.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.muted { color: #4b5563; }
.small { font-size: 7.5pt; }
h1 { font-size: 16pt; letter-spacing: .06em; margin: 0; text-align: right; }
.top { display: flex; justify-content: space-between; align-items: flex-start; gap: 8mm; border-bottom: 1.5px solid #111827; padding-bottom: 3mm; }
.seller-name { font-size: 13pt; font-weight: 700; }
.meta { border-collapse: collapse; margin-top: 2mm; margin-left: auto; }
.meta td { padding: 0.5mm 0 0.5mm 4mm; }
.meta td:first-child { color: #4b5563; text-align: right; }
.banner { margin: 3mm 0; padding: 2mm 3mm; border: 2px solid #92400e; background: #fffbeb; color: #78350f; font-weight: 700; text-align: center; letter-spacing: .04em; }
.notice { margin: 3mm 0; padding: 2mm 3mm; border: 1px solid #9ca3af; background: #f3f4f6; }
.parties { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4mm; margin: 3mm 0; }
.box { border: 1px solid #d1d5db; padding: 2mm 3mm; break-inside: avoid; }
.box h2 { font-size: 7.5pt; text-transform: uppercase; letter-spacing: .05em; color: #4b5563; margin: 0 0 1mm; }
.box .name { font-weight: 700; }
table.items { width: 100%; border-collapse: collapse; margin-top: 2mm; }
table.items thead { display: table-header-group; }
table.items th { background: #f3f4f6; border-top: 1px solid #111827; border-bottom: 1px solid #111827; padding: 1.5mm 1.2mm; font-size: 7pt; text-transform: uppercase; letter-spacing: .03em; text-align: left; }
table.items th.num { text-align: right; }
table.items td { font-size: 8.5pt; padding: 1.3mm 1.2mm; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
table.items tr { break-inside: avoid; page-break-inside: avoid; }
.desc { overflow-wrap: anywhere; }
.totals { break-inside: avoid; page-break-inside: avoid; margin-top: 3mm; display: flex; justify-content: space-between; gap: 8mm; align-items: flex-start; }
.words { flex: 1; }
.summary { width: 78mm; border-collapse: collapse; }
.summary td { padding: 0.8mm 1.5mm; }
.summary tr.strong td { font-weight: 700; border-top: 1px solid #9ca3af; }
.summary tr.grand td { font-size: 12pt; font-weight: 800; border-top: 2px solid #111827; border-bottom: 2px solid #111827; padding: 1.8mm 1.5mm; }
.footer { margin-top: 5mm; }
.wm { position: fixed; top: 38%; left: 0; right: 0; text-align: center; transform: rotate(-28deg); pointer-events: none; z-index: 0; color: transparent; -webkit-text-stroke: 1.3px #b45309; opacity: .38; font-family: Arial, Helvetica, sans-serif; font-weight: 900; }
.wm .big { display: block; font-size: 120pt; letter-spacing: .08em; line-height: 1; }
.wm .sub { display: block; font-size: 22pt; letter-spacing: .06em; margin-top: 4mm; }
.content { position: relative; z-index: 1; }
`;

function addressBlock(a: { lines: string[]; state: string }): string {
  return `${a.lines.map((l) => `<div>${esc(l)}</div>`).join('')}<div>${esc(a.state)}</div>`;
}

/**
 * Renders the self-contained A4 HTML (no scripts, no external resources, no network). There is deliberately NO option to leave the
 * DEMO marking out: for a demo document the watermark, the banner and the page-margin text are always produced.
 */
export function renderInvoiceHtml(doc: InvoiceDocument): string {
  const marginBoxes = [
    doc.isDemo
      ? `@top-center { content: ${cssText(`${DEMO_MARK} - ${doc.demoNotice ?? ''}`)}; font: 700 8.5pt Arial, sans-serif; color: #78350f; }`
      : '',
    `@bottom-left { content: ${cssText(`${doc.title} ${doc.documentNumber}`)}; font: 7.5pt Arial, sans-serif; color: #4b5563; }`,
    `@bottom-right { content: "Page " counter(page) " of " counter(pages); font: 7.5pt Arial, sans-serif; color: #4b5563; }`,
  ].join(' ');

  const watermark = doc.isDemo
    ? `<div class="wm" aria-hidden="true"><span class="big">${DEMO_MARK}</span><span class="sub">${esc(doc.demoNotice ?? '')}</span></div>`
    : '';
  const banner = doc.isDemo
    ? `<div class="banner" role="note">${DEMO_MARK} &mdash; ${esc(doc.demoNotice ?? '')}</div>`
    : '';
  const notTax = doc.notTaxInvoiceNotice
    ? `<div class="notice">${esc(doc.notTaxInvoiceNotice)}</div>`
    : '';

  const rows = doc.lines
    .map(
      (l) => `<tr>
<td class="num">${esc(l.no)}</td>
<td class="desc"><div><strong>${esc(l.description)}</strong></div><div class="muted small">${esc(l.sku)}${l.taxCategory ? ` &middot; ${esc(l.taxCategory)}` : ''}</div></td>
<td style="white-space:nowrap">${esc(l.hsn)}</td>
<td class="num">${esc(l.quantity)} ${esc(l.unit)}</td>
<td class="num">${esc(l.rate)}${l.rateNote ? `<div class="muted small">${esc(l.rateNote)}</div>` : ''}</td>
<td class="num">${l.discount.map((d) => `<div>${esc(d)}</div>`).join('')}</td>
<td class="num">${esc(l.taxable)}</td>
<td class="num">${l.tax.map((t) => `<div>${esc(t.label)}${t.amount !== null ? ` ${esc(t.amount)}` : ''}</div>`).join('')}</td>
<td class="num"><strong>${esc(l.total)}</strong></td>
</tr>`,
    )
    .join('\n');

  const summary = doc.summary
    .map(
      (r) =>
        `<tr${r.strong ? ' class="strong"' : ''}><td>${esc(r.label)}</td><td class="num">${esc(r.value)}</td></tr>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${esc(doc.title)} ${esc(doc.documentNumber)}</title>
<style>${STYLE.replace('__MARGIN_BOXES__', marginBoxes)}</style>
</head>
<body>
${watermark}
<div class="sheet"><div class="content">
${banner}
<div class="top">
  <div>
    <div class="seller-name">${esc(doc.seller.name)}</div>
    ${doc.seller.tradeName ? `<div class="muted">Trading as ${esc(doc.seller.tradeName)}</div>` : ''}
    ${doc.seller.address.map((l) => `<div>${esc(l)}</div>`).join('')}
    <div><strong>GSTIN:</strong> ${esc(doc.seller.gstin)}</div>
  </div>
  <div>
    <h1>${esc(doc.title)}</h1>
    <table class="meta">
      <tr><td>Invoice no.</td><td><strong>${esc(doc.documentNumber)}</strong></td></tr>
      <tr><td>Date</td><td>${esc(doc.invoiceDate)}</td></tr>
      <tr><td>Financial year</td><td>${esc(doc.financialYear)}</td></tr>
    </table>
  </div>
</div>
${notTax}
<div class="parties">
  <div class="box"><h2>Bill to</h2><div class="name">${esc(doc.customer.name)}</div><div class="muted small">Customer ${esc(doc.customer.code)}</div>
    ${addressBlock(doc.customer.billing)}
    <div>${doc.customer.gstin ? `<strong>GSTIN:</strong> ${esc(doc.customer.gstin)}` : 'GSTIN: not registered'}</div></div>
  <div class="box"><h2>Ship to</h2>${doc.customer.shipping ? addressBlock(doc.customer.shipping) : '<div>Same as billing address</div>'}</div>
  <div class="box"><h2>Place of supply</h2><div class="name">${esc(doc.placeOfSupply.text)}</div>
    <div class="muted small">${doc.supply === 'INTER' ? 'Inter-state supply' : doc.supply === 'INTRA' ? 'Intra-state supply' : ''}</div></div>
</div>
<table class="items">
<thead><tr>
<th class="num" style="width:5mm">#</th><th>Item</th><th style="width:17mm">HSN/SAC</th><th class="num" style="width:15mm">Qty</th>
<th class="num" style="width:17mm">Rate</th><th class="num" style="width:15mm">Discount</th><th class="num" style="width:19mm">Taxable</th>
<th class="num" style="width:29mm">Tax</th><th class="num" style="width:20mm">Total</th>
</tr></thead>
<tbody>
${rows}
</tbody>
</table>
<div class="totals">
  <div class="words">
    ${doc.amountInWords ? `<div class="small muted">Amount in words</div><div><strong>${esc(doc.amountInWords)}</strong></div>` : ''}
    ${doc.notes.map((n) => `<div class="muted small">${esc(n)}</div>`).join('')}
  </div>
  <table class="summary">
${summary}
<tr class="grand"><td>Grand total</td><td class="num">&#8377;${esc(doc.grandTotal)}</td></tr>
  </table>
</div>
<div class="footer small muted">This is a computer-generated document. Posted by ${esc(doc.postedBy)}.</div>
</div></div>
</body>
</html>
`;
}
