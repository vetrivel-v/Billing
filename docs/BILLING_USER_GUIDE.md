# CommerceBill Desktop: user guide for First Usable Billing

This guide follows the real application, in the order a new business uses it. Every example uses fictional names. **Read "Demo and real billing" and "What this version cannot do" before you rely on it for a real business.**

## 1. Starting CommerceBill

There is **no installer yet**. The application is started from the project folder by a person who can use a command line (see [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md)): `npm install`, `npm run build`, then start the desktop app. It keeps its data in a PostgreSQL database on the same computer, and nothing is sent anywhere. If you see "CommerceBill is not ready", wait a moment and choose **Try again**.

## 2. First setup

The first time the database is empty, so CommerceBill opens the **setup wizard**. It asks, one step at a time, for:

1. Your business: legal name, trade name, business type and PAN.
2. The business address, city, PIN code and state.
3. GST registration: registered (with GSTIN) or not.
4. The financial year (April to March) and the invoice numbering.
5. The first **administrator**: name, username, email and a password (at least 12 characters; it is never saved by the wizard).
6. A review page, then **Complete Setup**.

You are then taken to the sign-in page. Setup can only be completed once.

## 3. Signing in

Sign in with the administrator you just created. After repeated wrong passwords sign-in is blocked for a short time. A session ends after a period of inactivity (the Dashboard shows when). Use **Sign out** when you leave.

## 4. The Dashboard

The Dashboard shows facts from your own records and nothing estimated: sales today and this month, receivables outstanding, payments received today, the latest invoices and payments, how many tracked products have stock, the backup and recovery status and the **production readiness** checklist. Each person sees only the parts their role allows.

**Demo figures are marked DEMO** and are never added to real figures. There is no profit, cost or accounting figure anywhere.

## 5. Customers

**Customers > New customer.** Enter the name, GST registration (and GSTIN if registered), billing address and state. The state matters: it decides whether GST is split into CGST and SGST (same state) or charged as IGST (different state). Customers are never deleted; use **Deactivate**.

## 6. Products and HSN/SAC codes

A new installation has **no HSN/SAC list**: CommerceBill does not include an official list and does not check codes. Under **Tax > HSN/SAC codes > Add a code**, enter the codes you use (for example 8517, Telephone sets) and have a person confirm each one.

**Products > New product.** Choose Goods or Service, the name, the HSN/SAC code, the unit, the **tax category** (the GST rate) and the selling price (whether it includes GST). Tick **Track inventory** for goods whose stock you count.

## 7. Opening stock

**Inventory**, then **Add opening stock** beside a tracked product: enter the quantity you have now and a reference (for example "Count sheet 1"). Later use **Receive** and **Adjust**; every change is recorded as a stock movement and nothing is overwritten. **Movements** shows the history.

## 8. Tax configuration and review

**Tax** shows the GST categories and rates CommerceBill uses and whether a person has reviewed them. **The rates installed with CommerceBill are placeholders, not verified against any government source.** A review you record here is **your business's confirmation**, not a GST audit, a legal opinion or government verification. Record it with **Record my review** (your capacity, a note and the confirmation tick). If the configuration changes later, the review becomes out of date.

## 9. Creating an invoice (demo)

1. **Billing > New invoice.** Search and choose a customer.
2. Search for items (SKU, name or barcode) and press Enter. Enter quantities; add a percent or fixed discount if needed. Prices come from the product and cannot be changed here. Services cannot be invoiced yet.
3. **Confirm the place of supply.** CommerceBill only suggests it; you decide. Posting stays disabled until you do.
4. **Preview** shows the GST and totals calculated by the server. Change anything and the preview is out of date: preview again.
5. **Post demo invoice.** If the connection drops, choose **Retry posting**: it will not create a second invoice. The invoice receives a permanent number (`DEMO/2026-27/000001`) and cannot be edited or deleted.

## 10. Reading, printing and saving an invoice

Open an invoice from **Billing**. It is read-only and shows exactly what was posted, whatever happened to the customer or product since. **Preview / Print** shows the A4 document; **Print...** opens the system print dialog; **Save PDF** asks where to save the file. Every demo document is marked DEMO on every page and cannot be printed without it.

## 11. Payments and receivables

On an invoice choose **Record demo payment**. The page shows the total, what has been paid and the balance, all worked out by the server. Enter the amount, the method and a reference (required for UPI, bank transfer and cheque; never a card number). The payment is dated today. You may pay in parts; a payment larger than the balance is refused.

**Payments** lists recorded payments. **Receivables** shows, per customer, what was invoiced, paid and is outstanding. A recorded payment cannot be edited or deleted.

## 12. Backups and verification

Under **Settings > Backup & Recovery**: choose a folder, enter a passphrase twice, **Create backup**, and leave **Verify after creating** ticked. The passphrase is never stored and nobody can recover it. A backup is **verified** only when CommerceBill has restored it into a separate test database and checked it. **Copy backups to an external drive or another place that is not this computer.** Full detail: [BACKUP_AND_RESTORE.md](BACKUP_AND_RESTORE.md).

**Restore** (administrator only) replaces your current data with a backup after a safety backup is made. Read the warning on the screen first; the recovery guide is [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md).

## 13. Demo and real billing

- Until real billing is switched on, **every invoice and payment is a demo**: numbered `DEMO/...` and `DPAY/...`, marked DEMO everywhere, **not tax invoices, not real receipts, not real money**, and demo invoices do not change your real stock.
- Real (production) billing needs the **production readiness** checklist met: tax configuration reviewed, a valid seller GST registration, an HSN/SAC policy, and a backup verified in the last 30 days. Even then it is switched on only by a deliberate step on the Tax page, and **the tax rates have not been independently reviewed by a professional (risk R-040)**. Do not issue real tax invoices from this version without that review.

## 14. What this version cannot do

Read [FIRST_USABLE_BILLING_REPORT.md](FIRST_USABLE_BILLING_REPORT.md), "Known limitations". The main ones: no cancellation, credit notes, returns or refunds; no payment reversal; invoices and payments are dated today; invoices are not saved as drafts; no services on invoices, no shipping charges, no invoice-level discount; no purchasing or accounting; no marketplace integrations; no installer; the native printer and file dialogs and a real external drive have not been tested.
