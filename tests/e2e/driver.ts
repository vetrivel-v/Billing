/// <reference lib="dom" />
// First Usable Billing end-to-end driver. Bundled by the test (esbuild) and run INSIDE the real Electron renderer (served from app://, with
// the real preload bridge) by the main process, one stage per launch. It operates the real screens the way a person does (labels, buttons,
// links) with @testing-library/dom, and reports what it saw. Fictional data only. Not shipped.
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/dom';
import { gstinCheckCharacter } from '../../packages/setup/src/validators.js';

configure({ asyncUtilTimeout: 60_000 });

interface E2eEnv {
  username: string;
  password: string;
  passphrase: string;
}
declare global {
  interface Window {
    __E2E__: E2eEnv;
    __fub: Record<string, () => Promise<Record<string, unknown>>>;
  }
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const labelRe = (s: string) => new RegExp(`^${esc(s)}( \\((required|optional)\\))?$`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nodeExposed = (): boolean => {
  const g = globalThis as unknown as Record<string, unknown>;
  return (
    typeof g.require !== 'undefined' ||
    typeof g.process !== 'undefined' ||
    typeof g.module !== 'undefined'
  );
};
const text = () => document.body.textContent ?? '';
const squash = (s: string) => s.replace(/\s+/g, '');

const firstGst = '27ABCDE1234F1Z';
const ADMIN = {
  displayName: 'Priya Nair',
  email: 'priya@example.test',
};
const BUSINESS = {
  legalName: 'Sample Traders Private Limited',
  tradeName: 'Sample Traders',
  businessType: 'Private limited company',
  pan: 'ABCDE1234F',
  addressLine1: '12 Example Road',
  addressLine2: 'Test Nagar',
  city: 'Mumbai',
  stateCode: '27',
  pinCode: '400001',
  gstin: `${firstGst}${gstinCheckCharacter(firstGst)}`,
};
const CUSTOMER_PAN = 'AAACR5055K';
const CUSTOMER_GSTIN_BASE = `27${CUSTOMER_PAN}1Z`;
const CUSTOMER = {
  name: 'Riverside Traders Pvt Ltd',
  display: 'Riverside',
  gstin: `${CUSTOMER_GSTIN_BASE}${gstinCheckCharacter(CUSTOMER_GSTIN_BASE)}`,
};
const PRODUCT = { name: 'Riverside Widget', price: '1000', stock: '12', qty: '2' };

// A real browser applies React updates after the event handler returns (the jsdom tests wrap events in act), so every event waits a tick.
const tick = () => new Promise<void>((r) => setTimeout(r, 40));
const fire = {
  change: async (el: Element, init: { target: { value: string } }) => {
    fireEvent.change(el, init);
    await tick();
  },
  click: async (el: Element) => {
    fireEvent.click(el);
    await tick();
  },
  keyDown: async (el: Element, init: { key: string }) => {
    fireEvent.keyDown(el, init);
    await tick();
  },
};
const typeIn = (scope: ReturnType<typeof within> | typeof screen, label: string, value: string) =>
  fire.change(scope.getByLabelText(labelRe(label)), { target: { value } });
const click = (name: string | RegExp) => fire.click(screen.getByRole('button', { name }));
/** Pages (by link name) whose content was wider than the window: the layout check for the real 1280 px window. */
const overflowPages: string[] = [];
const link = async (name: string | RegExp) => {
  await fire.click(await screen.findByRole('link', { name }));
  await sleep(250);
  if (document.documentElement.scrollWidth > window.innerWidth + 1)
    overflowPages.push(`${String(name)} @${String(window.innerWidth)}`);
};
const section = (name: string) => within(screen.getByRole('region', { name }));
const heading = (name: string | RegExp) => screen.findByRole('heading', { name });

async function pick(label: string, term: string, option: RegExp) {
  const input = screen.getByRole('combobox', { name: label });
  await fire.change(input, { target: { value: term } });
  await screen.findByRole('option', { name: option });
  await fire.keyDown(input, { key: 'Enter' });
}

async function signIn(): Promise<void> {
  await heading('Sign in');
  await typeIn(screen, 'Username', window.__E2E__.username);
  await typeIn(screen, 'Password', window.__E2E__.password);
  await click('Sign in');
  await heading('Dashboard');
}

const figures = (name: string) => {
  const el = document.querySelector(`section[aria-label="${name}"]`);
  return el ? (el.textContent ?? '') : null;
};
const card = (name: string) => screen.getByRole('region', { name }).textContent ?? '';
const settled = async () => {
  await waitFor(() => {
    if (screen.queryByText(/Loading figures/)) throw new Error('figures still loading');
  });
};

/** The page text with a short explanation if a step fails, so a failed run says where it stopped. */
async function step<T>(name: string, o: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new Error(
      `step "${name}" failed: ${String(e).slice(0, 300)} | screen: ${text().replace(/\s+/g, ' ').slice(0, 500)} | so far: ${JSON.stringify(o).slice(0, 800)}`,
      { cause: e },
    );
  }
}

async function journey(): Promise<Record<string, unknown>> {
  const o: Record<string, unknown> = {};
  o.bridgeKeys = Object.keys((window as unknown as { commercebill: object }).commercebill).sort();
  o.nodeExposed = nodeExposed();

  await step('setup', o, async () => {
    await heading('CommerceBill setup');
    o.sawSetupWizard = true;
    await click('Start Setup');
    await heading('Business details');
    await typeIn(screen, 'Legal business name', BUSINESS.legalName);
    await typeIn(screen, 'Trade / display name', BUSINESS.tradeName);
    await typeIn(screen, 'Business type', BUSINESS.businessType);
    await typeIn(screen, 'PAN', BUSINESS.pan);
    await click('Continue');
    await heading('Address & location');
    await typeIn(screen, 'Address line 1', BUSINESS.addressLine1);
    await typeIn(screen, 'Address line 2', BUSINESS.addressLine2);
    await typeIn(screen, 'City', BUSINESS.city);
    await typeIn(screen, 'PIN code', BUSINESS.pinCode);
    await typeIn(screen, 'State / union territory', BUSINESS.stateCode);
    await click('Continue');
    await heading('GST registration');
    await fire.click(screen.getByRole('radio', { name: /^Registered/ }));
    await typeIn(screen, 'GSTIN', BUSINESS.gstin);
    await click('Continue');
    await heading('Financial year');
    await click('Continue');
    await heading('Invoice numbering');
    await click('Continue');
    await heading('Administrator');
    await typeIn(screen, 'Administrator name', ADMIN.displayName);
    await typeIn(screen, 'Username', window.__E2E__.username);
    await typeIn(screen, 'Email', ADMIN.email);
    await typeIn(screen, 'Password', window.__E2E__.password);
    await typeIn(screen, 'Confirm password', window.__E2E__.password);
    await click('Continue');
    await heading('Review & complete');
    await click('Complete Setup');
    await heading('Sign in');
    o.setupCompleteNotice = /Setup is complete/.test(text());
  });

  await step('sign in and empty dashboard', o, async () => {
    await signIn();
    await settled();
    o.dashboardEmpty = {
      demoFigures: figures('Demo figures'),
      realFigures: figures('Real figures'),
      readiness: card('Production readiness'),
      recent: text().includes('No invoices yet'),
    };
  });

  await step('customer', o, async () => {
    await link('Customers');
    await screen.findByText('No customers yet');
    await fire.click(screen.getAllByRole('button', { name: 'New customer' })[0]!);
    await heading('New customer');
    await typeIn(section('Basic details'), 'Customer name', CUSTOMER.name);
    await typeIn(section('Basic details'), 'Display name', CUSTOMER.display);
    await fire.change(section('Tax details').getByLabelText(labelRe('GST registration')), {
      target: { value: 'REGISTERED' },
    });
    await typeIn(section('Tax details'), 'GSTIN', CUSTOMER.gstin);
    await typeIn(section('Tax details'), 'PAN', CUSTOMER_PAN);
    await typeIn(section('Billing address'), 'Address line 1', '22 River Road');
    await typeIn(section('Billing address'), 'City', 'Pune');
    await typeIn(section('Billing address'), 'State / union territory', '27');
    await typeIn(section('Billing address'), 'PIN code', '411001');
    await click('Create customer');
    await screen.findByText(
      new RegExp(`Customer CUS-\\d+ \\(${esc(CUSTOMER.name)}\\) was created`),
    );
    o.customerCreated = true;
  });

  await step('hsn code', o, async () => {
    // a new installation bundles no HSN/SAC list: the business enters the codes it uses
    await link('Tax');
    await heading('Tax configuration');
    await fire.click((await screen.findAllByRole('link', { name: 'HSN/SAC codes' }))[0]!);
    await heading('HSN/SAC codes');
    await screen.findByText('No HSN/SAC codes yet');
    await click('Add a code');
    await typeIn(screen, 'Code', '8517');
    await typeIn(screen, 'Description', 'Telephone sets');
    await click('Add code');
    await screen.findByText('Code 8517 was added.');
    o.hsnCodeAdded = true;
  });

  await step('product', o, async () => {
    await link('Products');
    await screen.findByText('No products yet');
    await fire.click(screen.getAllByRole('button', { name: 'New product' })[0]!);
    await heading('New product');
    await typeIn(section('Basic details'), 'Product name', PRODUCT.name);
    await section('Classification').findByLabelText(labelRe('HSN code'));
    await typeIn(section('Classification'), 'HSN code', '85');
    await fire.click(await screen.findByRole('button', { name: /8517/ }));
    const unit = section('Classification').getByLabelText(
      labelRe('Unit of measure'),
    ) as HTMLSelectElement;
    const unitOpt = [...unit.options].find((x) => /PCS/.test(x.text));
    await fire.change(unit, { target: { value: unitOpt!.value } });
    const tax = section('Tax').getByLabelText(labelRe('Tax category')) as HTMLSelectElement;
    const taxOpt = [...tax.options].find((x) => /18/.test(x.text));
    await fire.change(tax, { target: { value: taxOpt!.value } });
    await typeIn(section('Pricing'), 'Selling price (INR)', PRODUCT.price);
    await fire.click(section('Inventory settings').getByLabelText(/^Track inventory/));
    await click('Create product');
    await screen.findByText(new RegExp(`Product PRD-\\d+ \\(${esc(PRODUCT.name)}\\) was created`));
    o.productCreated = true;
    o.taxOption = taxOpt!.text;
  });

  await step('opening stock', o, async () => {
    await link('Inventory');
    await link(`Add opening stock for ${PRODUCT.name}`);
    await heading('Opening stock');
    await typeIn(screen, 'Quantity (PCS)', PRODUCT.stock);
    await typeIn(screen, 'Reference', 'Count sheet 1');
    await click('Record opening stock');
    await screen.findByText(
      `Opening stock was recorded for ${PRODUCT.name}. Stock on hand is now ${PRODUCT.stock} PCS.`,
    );
    o.openingStockRecorded = true;
  });

  await step('tax review', o, async () => {
    await link('Tax');
    await heading('Tax configuration');
    o.taxBeforeReview = text().includes('Demo billing only');
    await screen.findByRole('form', { name: 'Confirm tax review' });
    await typeIn(screen, 'Your capacity', 'Accountant for Sample Traders');
    await typeIn(screen, 'Note', 'Checked against our own notes (fictional end-to-end test)');
    await fire.click(screen.getByLabelText('I have read and I confirm the statement above'));
    await click('Record my review');
    await screen.findByText('Your review was recorded for the configuration shown on this page.');
    o.taxReviewRecorded = true;
  });

  await step('invoice', o, async () => {
    await link('Billing');
    await heading('Billing');
    await link('New invoice');
    await pick('Customer', 'Riverside', /Riverside/i);
    await pick('Add item', 'Riverside Widget', /Riverside Widget/i);
    await fire.change(screen.getByLabelText(`Quantity for ${PRODUCT.name}`), {
      target: { value: PRODUCT.qty },
    });
    await click('Preview');
    await screen.findByText(
      'Confirm the place of supply for this transaction, then preview again.',
    );
    o.postDisabledBeforePlaceOfSupply = (
      screen.getByRole('button', { name: /Post demo invoice/ }) as HTMLButtonElement
    ).disabled;
    await fire.click(screen.getByRole('button', { name: /^Confirm / }));
    await screen.findByTestId('pos-confirmed');
    await click('Preview');
    await waitFor(() => {
      const t = within(screen.getByLabelText('Invoice totals')).getByText('Total').nextSibling;
      if (!t || !/₹/.test(t.textContent ?? '') || /out of date/.test(text()))
        throw new Error('no fresh totals');
    });
    const tot = within(screen.getByLabelText('Invoice totals'));
    o.previewTotal = tot.getByText('Total').nextSibling!.textContent;
    o.previewTaxable = tot.getByText('Taxable subtotal').nextSibling!.textContent;
    o.previewCgst = tot.getByText('CGST').nextSibling!.textContent;
    o.previewSgst = tot.getByText('SGST').nextSibling!.textContent;
    o.previewIgst = tot.getByText('IGST').nextSibling!.textContent;
    await waitFor(() => {
      if ((screen.getByRole('button', { name: /Post demo invoice/ }) as HTMLButtonElement).disabled)
        throw new Error('post still disabled');
    });
    await click('Post demo invoice');
    const h = await screen.findByRole('heading', { name: /^Invoice DEMO\// });
    o.invoiceNumber = (h.textContent ?? '').replace('Invoice ', '');
    o.invoicePostedNotice = /Demo invoice .* was posted\. Your stock was not changed\./.test(
      text(),
    );
    o.invoiceEditControls = screen.queryAllByRole('button', {
      name: /^(Edit|Delete|Cancel invoice)/,
    }).length;
    o.invoiceShowsCustomer = text().includes(CUSTOMER.name);
  });

  await step('preview and PDF', o, async () => {
    await click('Preview / Print');
    const frame = (await waitFor(() => {
      const f = document.querySelector('iframe[title="Invoice preview"]');
      if (!f) throw new Error('no preview');
      return f;
    })) as HTMLIFrameElement;
    const html = frame.getAttribute('srcdoc') ?? '';
    o.previewHtmlHasNumber = html.includes(String(o.invoiceNumber));
    o.previewHtmlHasCustomer = html.includes(CUSTOMER.name);
    o.previewHtmlDemo = html.includes('NOT A PRODUCTION TAX INVOICE');
    await click('Save PDF');
    await screen.findByText('The PDF was saved.');
    o.pdfSaved = true;
  });

  await step('payments', o, async () => {
    // back to the invoice, then pay part of it and then the rest
    const invoiceNumber = String(o.invoiceNumber);
    await link('Billing');
    await link(new RegExp(`Open invoice ${esc(invoiceNumber)}`));
    await heading(`Invoice ${invoiceNumber}`);
    const summary = () => within(screen.getByLabelText('Payment summary'));
    o.balanceBefore = summary().getByText('Demo balance').nextSibling!.textContent;
    await click('Record demo payment');
    await screen.findByText('DEMO PAYMENT');
    await fire.change(screen.getByLabelText(/^Amount received/), { target: { value: '1000' } });
    await click('Record demo payment');
    await screen.findByText(/Demo payment DPAY\/.* was recorded\. It is not real money\./);
    await waitFor(() => {
      if (summary().getByText('Demo paid').nextSibling!.textContent !== '₹1,000.00')
        throw new Error('paid not updated');
    });
    o.balanceAfterPartial = summary().getByText('Demo balance').nextSibling!.textContent;
    o.partlyPaidShown = text().includes('Partly paid');
    await click('Record demo payment');
    await screen.findByText('DEMO PAYMENT');
    const remaining = String(o.balanceAfterPartial).replace(/[₹,]/g, '');
    await fire.change(screen.getByLabelText(/^Amount received/), { target: { value: remaining } });
    await click('Record demo payment');
    await waitFor(() => {
      if (summary().getByText('Demo balance').nextSibling!.textContent !== '₹0.00')
        throw new Error('balance not zero');
    });
    o.balanceAfterFull = summary().getByText('Demo balance').nextSibling!.textContent;
    o.paidShown = screen.queryAllByText('Paid').length > 0;
  });

  await step('dashboard after billing', o, async () => {
    await link('Dashboard');
    await heading('Dashboard');
    await waitFor(() => {
      if (!figures('Demo figures')?.includes('₹2,360.00'))
        throw new Error('dashboard not refreshed');
    });
    await settled();
    o.dashboardAfter = {
      demoFigures: figures('Demo figures'),
      realFigures: figures('Real figures'),
      recentInvoices: card('Recent invoices'),
      recentPayments: card('Recent payments'),
      stock: card('Stock'),
      readiness: card('Production readiness'),
      recovery: card('Backup and recovery'),
    };
  });

  await step('backup', o, async () => {
    await link('Settings');
    await link('Open Backup & Recovery');
    await heading('Backup & Recovery');
    await click('Choose folder');
    await waitFor(() => {
      if (!/Folder:\s*backups/.test(text())) throw new Error('folder not chosen');
    });
    await typeIn(screen, 'Backup passphrase', window.__E2E__.passphrase);
    await typeIn(screen, 'Confirm passphrase', window.__E2E__.passphrase);
    await click('Create backup');
    await screen.findByText('Backup created');
    await screen.findByText(/restored into a separate test database and every check passed/);
    o.backupCreatedAndVerified = true;
    await waitFor(() => {
      const li = within(screen.getByRole('region', { name: 'Production readiness' })).getByText(
        'Backup and recovery verified',
      );
      if (!/Ready:/.test(li.textContent ?? '')) throw new Error('readiness not updated');
    });
    o.readinessBackupReady = true;
    o.pageShowsPassphrase = document.body.innerHTML.includes(window.__E2E__.passphrase);
    o.pageShowsPath = /[A-Z]:\\|\/Users\//.test(text());
  });

  o.sidebar = [...document.querySelectorAll('nav a, nav li')].map((e) =>
    (e.textContent ?? '').trim(),
  );
  o.comingSoon = squash(text()).includes('Comingsoon');
  o.overflowPages = overflowPages;
  o.windowWidth = window.innerWidth;
  return o;
}

async function restart(): Promise<Record<string, unknown>> {
  const o: Record<string, unknown> = {};
  o.nodeExposed = nodeExposed();
  await step('sign in after restart', o, async () => {
    await sleep(300);
    o.sawSetupWizard = text().includes('CommerceBill setup');
    await signIn();
    await settled();
    o.dashboard = {
      demoFigures: figures('Demo figures'),
      realFigures: figures('Real figures'),
      recentInvoices: card('Recent invoices'),
      recentPayments: card('Recent payments'),
      stock: card('Stock'),
      readiness: card('Production readiness'),
      recovery: card('Backup and recovery'),
    };
  });
  await step('customer', o, async () => {
    await link('Customers');
    await screen.findByText(CUSTOMER.name);
    o.customerPresent = true;
  });
  await step('product and stock', o, async () => {
    await link('Products');
    await screen.findByText(PRODUCT.name);
    o.productPresent = true;
    await link('Inventory');
    const row = (await screen.findByText(PRODUCT.name)).closest('tr')!;
    o.inventoryRow = row.textContent;
  });
  await step('invoice and payments', o, async () => {
    await link('Billing');
    const a = await screen.findByRole('link', { name: /^Open invoice DEMO\// });
    const number = (a.getAttribute('aria-label') ?? '').replace('Open invoice ', '');
    o.invoiceNumber = number;
    o.invoiceListRow = a.closest('tr')!.textContent;
    await fire.click(a);
    await heading(`Invoice ${number}`);
    await waitFor(() => {
      if ((text().match(/DPAY\//g) ?? []).length < 2) throw new Error('payments not loaded');
    });
    const summary = within(screen.getByLabelText('Payment summary'));
    o.demoPaid = summary.getByText('Demo paid').nextSibling!.textContent;
    o.demoBalance = summary.getByText('Demo balance').nextSibling!.textContent;
    o.paymentRows = (text().match(/DPAY\//g) ?? []).length;
    o.editControls = screen.queryAllByRole('button', {
      name: /^(Edit|Delete|Cancel invoice)/,
    }).length;
  });
  await step('receivables and payments', o, async () => {
    await link('Payments');
    await heading('Payments');
    await screen.findAllByText(/^DPAY\//);
    o.paymentsListed = document.querySelectorAll('tbody tr').length;
    await link('Receivables');
    await heading('Receivables');
    o.realReceivablesEmpty = !text().includes('Riverside');
    await fire.change(screen.getByLabelText(/^(View|Type|Show|Kind|Mode)/i), {
      target: { value: 'demo' },
    });
    await screen.findByText(/Riverside/);
    o.receivablesText = true;
  });
  await step('backup history', o, async () => {
    await link('Settings');
    await link('Open Backup & Recovery');
    await heading('Backup & Recovery');
    const history = screen.getByRole('region', { name: 'Backup history' });
    await within(history).findByText(/\.cbbackup/);
    o.backupHistory = history.textContent;
    await waitFor(() => {
      const li = within(screen.getByRole('region', { name: 'Production readiness' })).getByText(
        'Backup and recovery verified',
      );
      if (!/Ready:/.test(li.textContent ?? '')) throw new Error('readiness not loaded');
    });
    o.readinessBackupReady = true;
  });
  o.pageShowsPath = /[A-Z]:\\|\/Users\//.test(text());
  o.overflowPages = overflowPages;
  return o;
}

window.__fub = { journey, restart };
