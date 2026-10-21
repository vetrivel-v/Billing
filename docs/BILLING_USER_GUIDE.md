# Billing: user guide (demo mode)

Billing is in **demo mode** until backup and restore have been verified. Demo invoices are for testing: they have their own numbers (`DEMO/...`), do not change your stock and are **not tax invoices**.

## Create a demo invoice

1. Billing > **New invoice**. Search and choose a customer.
2. Search for items (SKU, name or barcode) and press Enter. Enter quantities; add a percent or fixed discount if needed. Prices come from the product and cannot be changed here. Services cannot be invoiced yet.
3. **Confirm the place of supply.** CommerceBill only suggests it; you decide. If billing and shipping are in different states you must choose one.
4. **Preview** shows the GST and totals calculated by the server. Change anything and the preview is out of date: preview again.
5. **Post demo invoice.** If the connection drops, choose **Retry posting**: it will not create a second invoice.

## Read, print and save

- Open an invoice from the list. It is read-only and shows exactly what was posted, whatever happened to the customer or product since.
- **Preview / Print** shows the A4 document. **Print...** opens your system print dialog; you choose the printer. **Save PDF** asks where to save the file.
- Every demo document is marked DEMO on every page and cannot be printed without it.
- Printing and saving need the CommerceBill desktop app.

## Record a payment

1. Open an invoice and choose **Record payment** (**Record demo payment** on a demo invoice). The page shows the invoice total, what has been paid and the balance, all worked out by the server.
2. Enter the **amount received**, the **payment method** and a **reference** (required for UPI, bank transfer and cheque). Never enter a card number. Notes are optional. The payment is dated today.
3. **Record payment.** If the connection drops, choose **Retry**: it will not record the payment twice. If the amount is more than the balance, nothing is recorded and you are told the balance due.

A recorded payment cannot be edited or deleted, and correcting one is not supported yet.

## Demo payments

Until backup and restore are verified, only demo invoices exist, so payments are **demo payments**: they have their own numbers (`DPAY/...`), are marked DEMO everywhere, are **not real receipts** and never count as money received or in production receivables.

## Payments and receivables

- **Payments** lists recorded payments (search, method, type and date filters).
- **Receivables** shows, per customer, what was invoiced, paid and is outstanding; open a customer to see each invoice and whether it is unpaid, partly paid or paid. Choose **Demo (not real)** to see demo figures, which are kept apart from production.
