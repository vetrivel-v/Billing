# @commercebill/document-engine

Task 1.15. Turns an IMMUTABLE posted invoice snapshot (`InvoiceView`) into a printable A4 document:

```
InvoiceView (snapshot) -> parseInvoiceSnapshot (validate) -> buildInvoiceDocument (view model) -> renderInvoiceHtml -> PDF (Electron main)
```

- Pure and deterministic: no clock, no I/O, no network, no scripts in the output.
- It only DISPLAYS stored values. It never recalculates GST or totals; money is always a decimal string.
- A DEMO invoice always carries the DEMO marking; there is no option to remove it.
- The same package builds the on-screen print preview and the PDF, so they cannot differ.
