# COMMERCEBILL DESKTOP
## MASTER DEVELOPMENT SPECIFICATION V2.0

Document type: Product Requirements and Software Delivery Specification
Target platform: Windows local desktop
Primary market: Small Indian e-commerce businesses
Default country: India
Default currency: INR
Default language: English
Deployment model: Local-first, offline-capable desktop application

======================================================================
0. ROLE AND OPERATING MODE
======================================================================

Act as a complete senior software delivery team consisting of:

1. Product architect
2. Business analyst
3. Indian billing and GST domain specialist
4. E-commerce operations specialist
5. Chartered-accounting software domain analyst
6. UX/UI designer
7. Senior TypeScript developer
8. React frontend engineer
9. Node.js backend engineer
10. PostgreSQL database architect
11. Application security engineer
12. QA automation engineer
13. Windows packaging engineer
14. Technical documentation writer
15. Release and migration engineer

Your task is to design, implement, test, package and document a
production-quality, local-first billing, inventory, accounting and
e-commerce order-management application.

Do not merely provide:

- Architecture recommendations
- Sample code
- Pseudocode
- Mock screens
- Partial modules
- Placeholder business logic
- Unverified claims
- A prototype presented as production-ready software

Create a complete, maintainable repository containing:

- Application source code
- Database schema
- Versioned migrations
- Automated tests
- Demo data
- Build scripts
- Installer configuration
- User documentation
- Administrator documentation
- Security documentation
- Backup and recovery procedures
- Release documentation

The full specification in this document defines the product vision.

Implementation must proceed through controlled MVP phases. Do not attempt
to implement all future phases simultaneously.

======================================================================
1. PRODUCT IDENTITY
======================================================================

Use the temporary product name:

CommerceBill Desktop

Keep the following configurable:

- Product name
- Business name
- Business logo
- Theme colours
- Invoice branding
- Document titles
- Document prefixes
- Email templates
- Terms and conditions
- Tax labels
- Currency and number formats

Do not hard-code CommerceBill Desktop into business documents where a
configured business or product name should be used.

======================================================================
2. PRODUCT VISION
======================================================================

Create an integrated system allowing a small e-commerce business to manage:

- Business configuration
- Customers
- Suppliers
- Products
- Services
- Product variants
- Warehouses
- Inventory
- Online and offline orders
- Quotations
- Proforma invoices
- Sales orders
- Delivery challans
- GST tax invoices
- Retail invoices
- Purchase orders
- Goods receipts
- Purchase bills
- Credit notes
- Debit notes
- Customer returns
- Supplier returns
- Refunds
- Customer payments
- Supplier payments
- Operating expenses
- Accounts receivable
- Accounts payable
- Bank transactions
- Marketplace settlements
- Payment-gateway reconciliation
- Basic double-entry accounting
- GST preparation reports
- Operational reports
- Financial reports
- Data import and export
- Audit logs
- Backup and restore

The application must be usable by a non-technical small-business owner.

The application must remain fully usable for core billing, inventory,
accounting and reporting functions without an internet connection.

Internet access may be used only for optional functions such as:

- E-commerce marketplace synchronization
- Email delivery
- Official WhatsApp Business integration
- E-invoice integration
- E-way bill integration
- Software updates
- Cloud or synced-folder backup
- Exchange-rate retrieval for future multi-currency support

======================================================================
3. PRIMARY PRODUCT PRINCIPLES
======================================================================

Follow these principles across the entire implementation:

1. Local-first operation
2. Financial accuracy
3. Transaction immutability
4. Complete traceability
5. Recoverability
6. Secure defaults
7. Modular architecture
8. Testable business logic
9. No silent data changes
10. No unsupported compliance claims
11. Graceful offline operation
12. Minimal vendor lock-in
13. Accessible user experience
14. Safe migration between versions
15. Separation of business logic from external integrations

Reliability, traceability and recoverability have higher priority than
unnecessary animations or visual effects.

======================================================================
4. ASSUMPTIONS AND COMPLIANCE BOUNDARIES
======================================================================

Assume:

- The primary user operates from a Windows computer.
- The business is located in India.
- The primary currency is INR.
- The business may be GST registered or unregistered.
- The business may sell through multiple channels.
- Most day-to-day use occurs on one local computer.
- Future multi-user LAN or cloud synchronization may be required.
- Core operations must not depend on a paid cloud service.
- Live marketplace and government integrations require external approval,
  credentials and contracts.

Do not claim that this application guarantees legal, accounting, GST or
statutory compliance.

Display appropriate notices explaining that:

- GST configurations must be reviewed by an authorized accountant or tax
  professional.
- GST return preparation reports are supporting reports and not a substitute
  for professional review.
- E-invoices are official only when an authorized Invoice Registration Portal
  or approved provider returns a valid IRN and signed QR code.
- E-way bills are official only when an authorized portal or provider confirms
  successful generation.
- Tax rates, thresholds, formats and applicability rules may change.
- Configurable business rules must be checked before production use.

Never create fabricated:

- GSTINs presented as real
- IRNs
- Government acknowledgement numbers
- Signed government QR codes
- E-way bill numbers
- Marketplace credentials
- Payment confirmations
- Shipping confirmations
- Live integration test results

Use unmistakably fictional information in demo environments.

======================================================================
5. REQUIRED TECHNICAL ARCHITECTURE
======================================================================

Use the following architecture unless repository evidence demonstrates a
material technical reason to change it.

Desktop shell:

- Electron
- Current supported stable release
- Electron Builder or Electron Forge
- Secure main/preload/renderer separation
- Windows installer packaging

Frontend:

- React
- TypeScript strict mode
- Vite
- Tailwind CSS
- shadcn/ui or an equivalent accessible component library
- React Hook Form
- Zod
- TanStack Query
- TanStack Table
- Recharts
- Accessible design system
- Centralized error boundary
- Internationalization-ready architecture

Backend:

- Node.js
- TypeScript strict mode
- Fastify or NestJS
- REST API
- OpenAPI specification
- Zod or equivalent server-side validation
- Structured logging
- Service and repository architecture
- Explicit transaction boundaries

Database:

- PostgreSQL
- Prisma ORM
- Version-controlled schema migrations
- Seed scripts
- Database constraints
- Explicit decimal fields for currency
- Appropriate indexes
- Optimistic concurrency where required

PDF and printing:

- HTML-based document templates
- PDF rendering
- A4 invoice
- A5 invoice
- 58 mm thermal receipt
- 80 mm thermal receipt
- Packing slip
- Shipping label
- Delivery challan
- Credit note
- Debit note
- Payment receipt
- Print preview
- Bulk download
- Bulk printing

Testing:

- Vitest or Jest
- Playwright
- Isolated PostgreSQL test database
- Integration tests
- End-to-end tests
- Database integrity tests
- Accounting balance tests
- Inventory reconciliation tests

Tooling:

- ESLint
- Prettier
- strict TypeScript
- pre-commit checks
- migration validation
- environment validation
- dependency vulnerability checks
- software bill of materials generation

Development deployment:

- One-command development startup
- Docker Compose as an optional developer setup
- Docker must not be mandatory for ordinary business users

Production deployment:

- Windows installer
- Desktop shortcut
- Start-menu entry
- Application data stored outside the installation directory
- Upgrade-safe user-data location
- Automated database migration
- Pre-upgrade backup
- Diagnostic log export

Do not require a paid library or service for core business functionality
when a suitable maintained open-source alternative exists.

======================================================================
6. REPOSITORY STRUCTURE
======================================================================

Use a monorepo structure similar to:

/
|-- apps/
|   |-- desktop/
|   |-- web/
|   `-- api/
|-- packages/
|   |-- database/
|   |-- domain/
|   |-- tax-engine/
|   |-- accounting-engine/
|   |-- inventory-engine/
|   |-- document-engine/
|   |-- integration-core/
|   |-- shared-types/
|   |-- validation/
|   |-- ui/
|   |-- reporting/
|   `-- test-utilities/
|-- prisma/
|   |-- schema.prisma
|   |-- migrations/
|   `-- seed/
|-- templates/
|   |-- invoices/
|   |-- receipts/
|   |-- packing-slips/
|   `-- shipping-labels/
|-- integrations/
|   |-- csv/
|   |-- shopify/
|   |-- woocommerce/
|   |-- amazon/
|   |-- flipkart/
|   |-- meesho/
|   |-- einvoice/
|   |-- ewaybill/
|   `-- payment-gateways/
|-- tests/
|   |-- unit/
|   |-- integration/
|   |-- e2e/
|   |-- security/
|   |-- migration/
|   `-- recovery/
|-- sample-data/
|-- sample-imports/
|-- scripts/
|-- docs/
|-- docker-compose.yml
|-- README.md
|-- CHANGELOG.md
`-- package.json

The exact structure may be refined, but domain logic must not be duplicated
across UI, API and integrations.

======================================================================
7. DEPENDENCY AND IMPLEMENTATION ORDER
======================================================================

Modules must be developed in this dependency order:

Foundation
  |
  |-- Configuration
  |-- Organization
  |-- Authentication
  |-- Authorization
  |-- Audit logging
  |-- Tax configuration
  |-- Document numbering
  |
Master Data
  |
  |-- Customers
  |-- Suppliers
  |-- Products
  |-- Warehouses
  |-- Units
  |-- Accounts
  |
Inventory Engine
  |
Sales and Billing Engine
  |
  |-- Quotations
  |-- Orders
  |-- Invoices
  |-- Payments
  |-- Returns
  |-- Credit notes
  |-- Refunds
  |
Purchasing Engine
  |
Accounting Engine
  |
Reporting
  |
E-commerce Integration
  |
Settlement Reconciliation
  |
Government Integration
  |
Production Hardening and Packaging

Do not implement marketplace connectors before the canonical internal order,
product, customer, tax, inventory and payment models are stable.

Do not implement financial reports before accounting postings are balanced,
tested and traceable.

Do not implement live government connectors before the tax-document model and
provider abstraction are stable.

======================================================================
8. PHASED MVP ROADMAP
======================================================================

The full product vision remains authoritative, but implementation must proceed
through the following gated phases.

----------------------------------------------------------------------
PHASE 0: ARCHITECTURE AND FOUNDATION
----------------------------------------------------------------------

Deliver:

- Requirements analysis
- Assumptions
- Compliance boundaries
- Architecture decision records
- Threat model
- Risk register
- Repository scaffold
- Database conventions
- Error-handling conventions
- Logging conventions
- Testing framework
- CI-capable commands
- Project-state tracking
- Requirements traceability matrix
- Initial Windows development startup
- Initial migration framework

Exit criteria:

- Repository installs successfully
- TypeScript compilation succeeds
- Linting succeeds
- Test runner executes
- Test database starts
- Initial migration succeeds
- Electron shell starts
- API health check succeeds
- Project documentation is initialized

----------------------------------------------------------------------
PHASE 1: BILLING FOUNDATION MVP
----------------------------------------------------------------------

Deliver:

- First-run business setup
- Administrator account
- User authentication
- Role-based authorization
- Business settings
- Tax-rate configuration
- Financial-year configuration
- Document-number sequences
- Customers
- Products
- Product variants
- Warehouses
- Opening stock
- Inventory movement ledger
- Manual sales orders
- GST invoices
- Invoice PDFs
- Print preview
- Customer payments
- Customer statements
- Basic sales dashboard
- Basic GST sales reports
- Audit logging
- Manual backup
- Scheduled backup
- Guided restore
- CSV import/export for customers and products

Phase 1 must support this complete workflow:

Create business
  -> Create customer
  -> Create product
  -> Receive/open stock
  -> Create order
  -> Create invoice
  -> Print invoice
  -> Record payment
  -> View updated stock
  -> View customer balance
  -> Back up data
  -> Restore backup into validation database

Exit criteria:

- All Phase 1 requirements implemented
- Invoice totals reconcile
- Inventory movements balance
- Payments update receivables correctly
- Posted invoices are immutable
- Duplicate invoice numbers are prevented
- Backup and restore test passes
- Phase 1 end-to-end workflow passes
- Windows development build succeeds
- Documentation is updated

----------------------------------------------------------------------
PHASE 2: PURCHASES AND ACCOUNTING
----------------------------------------------------------------------

Deliver:

- Suppliers
- Purchase orders
- Goods receipts
- Supplier bills
- Supplier payments
- Purchase returns
- Expenses
- Expense categories
- Chart of accounts
- Double-entry journal engine
- Accounts receivable
- Accounts payable
- Cash and bank ledgers
- Tax ledgers
- Trial balance
- General ledger
- Profit and loss
- Balance sheet
- Day book
- Financial-year locking
- Period locking
- Reversal transactions
- Opening balances

Exit criteria:

- Every posted financial transaction balances
- Debit total equals credit total
- Source documents trace to journal entries
- Posted journal entries cannot be edited
- Corrections use reversal entries
- Purchase receipt updates stock correctly
- Supplier balances reconcile
- Financial reports reconcile with ledgers
- Phase 1 regression tests still pass

----------------------------------------------------------------------
PHASE 3: E-COMMERCE OPERATIONS
----------------------------------------------------------------------

Deliver:

- Canonical e-commerce order model
- CSV order import
- Generic integration provider interface
- Shopify provider
- WooCommerce provider
- Amazon provider
- Flipkart provider
- Meesho provider
- Marketplace SKU mapping
- Order deduplication
- Idempotent imports
- Sync history
- Error queue
- Manual retries
- Pick lists
- Packing workflow
- Barcode-assisted packing
- Shipment records
- Tracking references
- Partial fulfilment
- Split shipments
- Cancellations
- Customer returns
- Return-to-origin
- Replacements
- Credit notes
- Partial refunds
- Full refunds

Integrations requiring credentials may use mocks and sandbox adapters until
real credentials are supplied.

Do not mark an integration as production verified unless it has been tested
against an authorized live or sandbox service.

Exit criteria:

- Duplicate orders are safely rejected or matched
- Integration retries are idempotent
- Shipment reduces stock exactly once
- Cancellation releases reservations
- Returns and refunds reconcile
- Credit notes post correct tax and accounting reversals
- Phase 1 and Phase 2 regression tests pass

----------------------------------------------------------------------
PHASE 4: SETTLEMENT AND RECONCILIATION
----------------------------------------------------------------------

Deliver:

- Marketplace settlement imports
- Payment-gateway settlement imports
- COD reconciliation
- Matching engine
- Suggested matches
- Partial matches
- Manual matches
- Fee categorization
- Commission
- Shipping fee
- Collection fee
- Advertising deduction
- TCS
- TDS
- GST on fees
- Refund deduction
- Penalties
- Other adjustments
- Net bank receipt
- Unmatched settlement report
- Difference report
- Channel profitability
- Order profitability
- Settlement audit trail

Exit criteria:

- Exact matching passes
- Suggested matching identifies documented candidates
- Partial matching works
- Unmatched lines are never discarded
- Settlement accounting balances
- Net bank receipt reconciles with deductions
- Reconciliation decisions are auditable

----------------------------------------------------------------------
PHASE 5: ADVANCED INDIA COMPLIANCE
----------------------------------------------------------------------

Deliver:

- E-invoice provider abstraction
- Authorized-provider credential storage
- E-invoice request records
- E-invoice response records
- IRN storage
- Acknowledgement storage
- Signed QR storage
- E-invoice cancellation state
- E-way bill provider abstraction
- Transporter details
- Vehicle details
- Distance details
- Transport-document details
- E-way bill request/response records
- GSTR-1 preparation report
- GSTR-3B preparation report
- HSN summary
- B2B/B2C classifications
- Nil/exempt/non-GST report
- Validation and exception reports
- Configurable export framework

Exit criteria:

- No fake government identifiers
- Provider responses are retained
- Failed requests are traceable
- Retry rules prevent accidental duplicates
- Manual status and provider-confirmed status are clearly distinguished
- Compliance exports pass internal schema validation
- Professional-review warnings are visible

----------------------------------------------------------------------
PHASE 6: PRODUCTION HARDENING
----------------------------------------------------------------------

Deliver:

- Windows installer
- Upgrade process
- Pre-upgrade backup
- Migration validation
- Installer smoke test
- Application diagnostics
- Log export
- Data export before uninstall
- Security review
- Dependency review
- Software bill of materials
- Performance tests
- Recovery tests
- Full documentation
- Release checklist
- Requirements traceability review
- Known-limitations register
- Production-readiness report

Exit criteria:

- Clean Windows installation succeeds
- Application starts from shortcut
- Upgrade from previous release succeeds
- Failed migration recovery is documented and tested
- Uninstall does not delete business data without explicit confirmation
- Full test suite passes
- Production build succeeds
- Installer smoke test passes
- Backup restoration succeeds
- No unresolved critical security defect exists

======================================================================
9. PHASE EXECUTION RULES
======================================================================

Work only within the current phase.

Do not implement future-phase functionality merely because an interface,
database field or placeholder exists.

Before changing code:

1. Read docs/PROJECT_STATE.md
2. Read docs/REQUIREMENTS_MATRIX.md
3. Read relevant architecture decisions
4. Read the current Prisma schema
5. Read relevant tests
6. Inspect existing code before creating replacements
7. Confirm the current phase
8. Check for open migration or security issues

At the end of every implementation batch, report:

- Current phase
- Requirements addressed
- Files created
- Files modified
- Migrations created
- Tests added
- Commands executed
- Actual test results
- Build result
- Known limitations
- Newly discovered risks
- Project-state updates
- Exact next implementation task

At every phase boundary:

1. Run type-check
2. Run lint
3. Run unit tests
4. Run integration tests
5. Run end-to-end tests
6. Run database integrity checks
7. Run accounting balance checks
8. Run inventory reconciliation
9. Run migration tests
10. Run backup and restore test
11. Build the application
12. Update PROJECT_STATE.md
13. Update REQUIREMENTS_MATRIX.md
14. Update RISK_REGISTER.md
15. Create PHASE_COMPLETION_REPORT.md

Do not automatically move to the next phase if mandatory exit criteria fail.

======================================================================
10. FIRST-RUN BUSINESS SETUP
======================================================================

On first start, display a guided setup wizard.

Collect:

- Legal business name
- Trade name
- Business type
- Registered address
- Billing address
- Shipping address
- Primary warehouse address
- State
- State code
- Country
- PIN code
- Phone
- Email
- Website
- PAN
- GST registration status
- GSTIN
- Default place of supply
- Financial-year start
- Invoice prefix
- Invoice starting number
- Credit-note prefix
- Debit-note prefix
- Purchase prefix
- Default payment terms
- Bank-account details
- UPI ID
- Optional UPI QR image
- Business logo
- Authorized signature
- Invoice template
- Inclusive/exclusive tax preference
- Rounding preference
- Decimal display
- Currency display
- Date format
- Time zone
- Backup destination
- Initial administrator credentials

Validate all required data.

Allow the setup wizard to be resumed after interruption.

Design the data model for multiple organizations, even if the first release
shows one active organization by default.

======================================================================
11. USER ACCOUNTS AND ACCESS CONTROL
======================================================================

Implement these predefined roles:

Administrator:

- Full access
- Business settings
- Users and permissions
- Tax settings
- Document sequences
- Integrations
- Backups and restores
- Audit logs
- Period unlock
- Sensitive exports

Accountant:

- Sales and purchases
- Payments
- Expenses
- Accounting
- Reconciliation
- GST reports
- Financial reports
- No security administration

Billing Operator:

- Customers
- Products
- Orders
- Invoices
- Payments
- Printing
- No period unlock
- No posted-document deletion
- No integration credentials

Warehouse Operator:

- Stock
- Picking
- Packing
- Shipping
- Transfers
- Counts
- Returns receiving
- No cost, margin or accounting access

Viewer/Auditor:

- Read-only documents
- Read-only reports
- Export only if separately permitted
- No changes

Support granular permissions in addition to role templates.

Security requirements:

- Argon2id or an appropriate current password-hashing method
- Configurable password policy
- Login rate limiting
- Failed-login auditing
- Secure administrator-assisted password reset
- Session timeout
- Inactivity lock
- Manual lock
- No plaintext credentials
- Sensitive-value redaction
- Permission checks on server operations
- Audit privilege changes
- Audit exports
- Audit backup and restore activity

======================================================================
12. CUSTOMER MANAGEMENT
======================================================================

Customer fields:

- Customer ID
- Customer code
- Customer type
- Legal name
- Display name
- Contact person
- Email
- Primary phone
- Alternate phone
- Billing address
- Multiple shipping addresses
- State
- State code
- Country
- PIN code
- GST registration status
- GSTIN
- PAN
- Place of supply
- Credit limit
- Payment terms
- Opening balance
- Price list
- Tax-exemption status
- Marketplace customer reference
- Notes
- Tags
- Active/inactive status
- Created timestamp
- Updated timestamp
- Version for concurrency control

Functions:

- Search
- Filtering
- Sorting
- Pagination
- Duplicate detection
- GSTIN format validation
- Customer statement
- Outstanding ageing
- Payment history
- Sales history
- Return history
- Credit-note balance
- Attachments
- CSV import/export
- XLSX import/export
- Controlled duplicate merge
- Soft deletion/inactivation
- Complete audit history

======================================================================
13. SUPPLIER MANAGEMENT
======================================================================

Provide supplier features comparable to customer management.

Support:

- Supplier profiles
- GST and PAN information
- Multiple addresses
- Payment terms
- Credit balances
- Purchase history
- Purchase orders
- Goods receipts
- Supplier bills
- Supplier returns
- Debit notes
- Advance payments
- Outstanding payables
- Supplier statements
- Input-tax tracking
- Supplier invoice attachments
- CSV/XLSX import/export
- Duplicate supplier detection
- Duplicate supplier invoice detection

Do not allow a duplicate supplier invoice number for the same supplier unless
an authorized user provides an override reason.

======================================================================
14. PRODUCT AND SERVICE CATALOG
======================================================================

Product fields:

- Product ID
- Internal SKU
- Product name
- Description
- Product type
- Parent product
- Variant attributes
- Barcode
- HSN or SAC
- GST rate
- Cess configuration
- Unit of measurement
- MRP
- Retail price
- Tax-inclusive/exclusive price
- Cost price
- Wholesale price
- Customer-specific price
- Marketplace-specific SKU
- Marketplace-specific price
- Preferred supplier
- Reorder level
- Reorder quantity
- Inventory tracking
- Batch tracking
- Serial-number tracking
- Expiry tracking
- Weight
- Dimensions
- Images
- Category
- Brand
- Tags
- Active/archived status
- Opening stock

Product types:

- Physical
- Service
- Digital
- Bundle/kit

Functions:

- Variant matrix
- Barcode generation
- Barcode printing
- Bulk price update
- Bulk GST/HSN update
- CSV/XLSX import/export
- Product bundles
- Alternate units where practical
- Price lists
- Stock availability
- Margin preview
- Low-stock warning
- SKU uniqueness
- Archived-product history preservation

Historical documents must retain snapshots of relevant product information.

Changing a product description, price, HSN or GST rate must not retroactively
alter a posted invoice.

======================================================================
15. INVENTORY ARCHITECTURE
======================================================================

Inventory must use an append-only stock-movement ledger.

Never implement inventory only as a mutable product quantity.

Every stock change must create a stock-movement record.

Supported movement types:

- Opening stock
- Purchase receipt
- Sale reservation
- Reservation release
- Sales dispatch
- Sale cancellation
- Customer return
- Supplier return
- Stock adjustment increase
- Stock adjustment decrease
- Damage
- Loss
- Found stock
- Warehouse transfer out
- Warehouse transfer in
- Bundle assembly
- Bundle disassembly
- Return-to-origin receiving
- Manual correction

Track:

- On-hand quantity
- Available quantity
- Reserved quantity
- Incoming quantity
- Committed quantity
- Damaged quantity
- In-transit quantity

Example behavior:

Purchase receipt:
+10 on-hand

Order reservation:
+2 reserved
No physical stock movement

Dispatch:
-2 on-hand
-2 reserved

Order cancellation before dispatch:
-2 reserved
No physical stock movement

Sellable customer return:
+1 on-hand

Damaged customer return:
+1 damaged
No increase to sellable quantity

Support:

- Multiple warehouses
- Stock transfers
- Stock counts
- Cycle counts
- Adjustment approvals
- Negative-stock policy
- Batch tracking
- Serial-number tracking
- Expiry date
- FIFO valuation
- Weighted-average valuation
- Stock ageing
- Stock ledger
- Stock valuation
- Low stock
- Dead stock
- Reorder recommendations
- Warehouse stock
- Adjustment report
- Inventory reconciliation

All stock changes must reference their originating document or approved manual
adjustment.

Do not permit silent stock edits.

Manual corrections require:

- Permission
- Reason
- Audit log
- Adjustment reference
- Before and after quantities

======================================================================
16. DOCUMENT ENGINE
======================================================================

Implement a reusable document engine supporting:

Quotation
  -> Sales order
  -> Delivery challan
  -> Tax invoice
  -> Payment
  -> Return
  -> Credit note
  -> Refund

Documents must retain links to their source and downstream documents.

Document types:

- Quotation
- Estimate
- Proforma invoice
- Sales order
- Tax invoice
- Bill of supply
- Retail invoice
- Delivery challan
- Credit note
- Debit note
- Payment receipt
- Purchase order
- Goods receipt
- Purchase bill
- Supplier debit note
- Packing slip
- Shipping label

Document states:

- Draft
- Pending approval
- Approved
- Posted
- Partially paid
- Paid
- Overdue
- Cancelled
- Reversed
- Closed

Rules:

- Drafts may be edited.
- Posted transactions must not be silently edited.
- Posted documents retain immutable snapshots.
- Corrections use controlled reversal or adjustment documents.
- Posted invoice numbers are never reused.
- State changes are audited.
- Source and destination documents remain linked.
- Partial invoicing is supported.
- Partial fulfilment is supported.
- Consolidation is supported where allowed.
- Copying a document creates a new draft without copying its number.
- Document totals are recalculated server-side before posting.
- Client-calculated totals are never trusted as authoritative.

======================================================================
17. DOCUMENT NUMBERING ENGINE
======================================================================

Create a transactional sequence engine.

Support formats such as:

- INV/2026-27/000001
- CN/2026-27/000001
- DN/2026-27/000001
- PO/2026-27/000001
- PAY/2026-27/000001

Support:

- Document type
- Business
- Location
- Financial year
- Prefix
- Suffix
- Numeric length
- Starting number
- Reset rules
- Preview
- Sequence locking
- Gap reporting

Number allocation must occur inside the same database transaction used to post
the document.

Prevent duplicate numbers under concurrent requests.

Do not allocate permanent numbers to drafts unless business settings explicitly
require it.

Do not reuse numbers released by failed or cancelled transactions without a
documented and legally appropriate sequence policy.

======================================================================
18. MONEY AND CALCULATION RULES
======================================================================

Never use binary floating-point arithmetic for monetary calculations.

Use:

- Decimal database types
- Decimal arithmetic library
- Explicit precision
- Explicit rounding mode
- Explicit currency scale
- Reproducible calculation order

Store monetary components separately:

- Quantity
- Unit price
- Gross line value
- Line discount
- Invoice discount
- Taxable value
- CGST
- SGST
- UTGST
- IGST
- Cess
- Shipping
- Packing
- Other charges
- TCS
- TDS
- Round-off
- Advance applied
- Credit-note applied
- Amount paid
- Balance due
- Final total

Never derive all historical amounts again from current configuration.

Store the posted calculation snapshot and the rules used.

Create unit tests for rounding boundaries and reconciliation.

======================================================================
19. TAX RULES ENGINE
======================================================================

Create a dedicated TaxEngine package.

Do not scatter GST logic across UI components or invoice services.

TaxEngine inputs:

- Seller location
- Seller GST status
- Customer location
- Customer GST status
- GSTIN
- Place of supply
- Product/service type
- HSN/SAC
- Tax category
- Tax rate
- Cess
- Transaction date
- Tax-inclusive/exclusive flag
- Transaction classification
- Export/SEZ indicators
- Reverse-charge indicator
- Exemption status
- Discount allocation
- Additional charges

TaxEngine outputs:

- Tax classification
- Taxable value
- CGST rate and amount
- SGST rate and amount
- UTGST rate and amount
- IGST rate and amount
- Cess
- Effective rate
- Rounding adjustment
- Validation messages
- Blocking errors
- Compliance warnings
- Calculation explanation

Support:

- Intra-state supply
- Inter-state supply
- Registered customer
- Unregistered customer
- B2B
- B2C
- CGST
- SGST
- UTGST
- IGST
- Cess
- Nil-rated
- Exempt
- Zero-rated
- Non-GST
- Reverse-charge indicator
- Export with payment of tax
- Export without payment of tax
- SEZ classifications
- Tax-inclusive pricing
- Tax-exclusive pricing
- Line discounts
- Invoice discounts
- Shipping and other charges
- Effective-dated tax rates

Rates and classification rules must be configurable and effective-dated.

Changing a tax rate must not modify historical documents.

======================================================================
20. INDIA GST DOCUMENT SUPPORT
======================================================================

GST-capable invoices must support:

- Supplier legal name
- Supplier address
- Supplier GSTIN
- Invoice number
- Invoice date
- Customer legal name
- Customer address
- Customer GSTIN for B2B
- Billing address
- Shipping address
- Place of supply
- State code
- HSN/SAC
- Item description
- Quantity
- Unit
- Taxable value
- Tax rate
- CGST
- SGST/UTGST
- IGST
- Cess
- Total value
- Reverse-charge indicator
- Bank details
- Payment information
- Authorized-signature area
- IRN field
- Acknowledgement field
- Signed QR field
- E-way bill reference

Do not generate an official-looking government QR code without an actual
authorized-provider response.

Clearly distinguish:

- Application-generated payment QR
- Application-generated document QR
- Official signed e-invoice QR

======================================================================
21. SALES AND BILLING
======================================================================

Support:

- Fast keyboard billing
- Product search
- Barcode scanning
- Customer search
- Ad-hoc customer
- B2B/B2C
- Tax inclusive/exclusive price
- Item discount
- Invoice discount
- Coupon
- Shipping
- Packing
- Other charges
- Multiple tax rates
- Notes
- Terms
- Salesperson/user
- Draft saving
- Approval
- Posting
- Payment at billing
- Partial payment
- Credit sale
- Print
- PDF
- Email integration
- WhatsApp click-to-chat
- Duplicate/copy
- Cancellation
- Credit note
- Debit note
- Return
- Refund

Optimize the billing interface for rapid keyboard entry.

Keyboard shortcuts should include:

- New invoice
- New order
- New customer
- New payment
- Search
- Save draft
- Post
- Save and print
- Product lookup
- Customer lookup

======================================================================
22. PAYMENTS AND RECEIVABLES
======================================================================

Payment methods:

- Cash
- Bank transfer
- UPI
- Credit card
- Debit card
- Payment gateway
- Wallet
- COD
- Cheque
- Marketplace settlement
- Other configurable method

Support:

- Full payment
- Partial payment
- Advance
- Unallocated receipt
- Customer credit
- Refund
- Reversal
- Multi-invoice allocation
- Payment reference
- Gateway transaction ID
- Bank account
- Cheque status
- Payment proof
- Cleared/pending/bounced states
- Receipt PDF

Receivables:

- Customer statements
- Outstanding invoices
- Ageing buckets
- Collection notes
- Promised-payment date
- Reminders
- CSV/XLSX export
- Printable statement
- Email reminder
- WhatsApp click-to-chat message

Do not automate personal WhatsApp sessions through unofficial browser or device
automation.

Support:

1. Secure click-to-chat link with prepared text
2. Official WhatsApp Business provider abstraction

======================================================================
23. PURCHASES, SUPPLIER BILLS AND EXPENSES
======================================================================

Support:

- Purchase requisition as an optional workflow
- Purchase order
- Purchase-order approval
- Goods receipt
- Partial receipt
- Supplier bill
- Bill-to-receipt matching
- Supplier debit note
- Purchase return
- Advance payment
- Final payment
- Landed cost
- Input tax
- Attachments
- Recurring expenses
- Cost centre
- Expense tags
- Approval workflow

Expense fields:

- Expense category
- Supplier/payee
- Date
- Amount
- Tax
- Payment account
- Reference
- Notes
- Attachment
- Recurring flag
- Approval status
- Cost centre
- Tags

======================================================================
24. ACCOUNTING ENGINE
======================================================================

Implement a basic double-entry accounting engine.

Account categories:

- Assets
- Liabilities
- Equity
- Income
- Cost of goods sold
- Expenses
- Accounts receivable
- Accounts payable
- Cash
- Bank
- Inventory
- Payment-gateway clearing
- Marketplace clearing
- Tax accounts
- Customer advances
- Supplier advances

Every posted financial transaction must create a balanced journal.

Example invoice:

Accounts Receivable        Debit  11,800
  Sales Revenue            Credit 10,000
  Output CGST              Credit    900
  Output SGST              Credit    900

Example customer payment:

Bank                       Debit  11,800
  Accounts Receivable      Credit 11,800

Rules:

- Debits must equal credits.
- Journal postings reference source documents.
- Posted journal lines are immutable.
- Corrections use reversal entries.
- Transaction date and posting date are stored separately.
- Financial periods may be locked.
- Unlock requires permission and reason.
- Unlock is audited.
- Opening balances use controlled journals.
- Draft operational documents do not post journals unless explicitly designed.
- Cancelled posted documents require reversal treatment.
- Accounting posting and source-document posting occur transactionally.

Reports:

- Trial balance
- General ledger
- Account ledger
- Day book
- Cash book
- Bank book
- Profit and loss
- Balance sheet
- Receivables
- Payables
- Tax ledgers
- Marketplace clearing
- Payment-gateway clearing

======================================================================
25. E-COMMERCE ORDER MANAGEMENT
======================================================================

Order sources:

- Manual
- Website
- Shopify
- WooCommerce
- Amazon
- Flipkart
- Meesho
- CSV
- Generic REST/webhook provider

Canonical internal order model must support:

- Channel
- External order ID
- External line ID
- Order date/time
- Customer
- Billing address
- Shipping address
- Product lines
- SKU
- Marketplace SKU
- Quantity
- Price
- Discounts
- Coupons
- Shipping
- Gift wrap
- Tax
- COD charge
- Marketplace fee
- Gateway fee
- TCS/TDS
- Round-off
- Total
- Payment method
- Payment status
- Fulfilment status
- Settlement reference
- Metadata

Order statuses:

- Draft
- Confirmed
- Payment pending
- Paid
- On hold
- Allocated
- Picking
- Packed
- Ready to ship
- Shipped
- Delivered
- Partially delivered
- Cancelled
- Return requested
- Return received
- Partially returned
- Refunded
- Partially refunded
- Closed

Fulfilment features:

- Bulk actions
- Bulk invoicing
- Pick list
- Packing slip
- Barcode verification
- Courier
- Tracking number
- Tracking link
- Partial fulfilment
- Split shipment
- Cancellation
- Replacement
- Return-to-origin
- Restock decision
- Return reason
- Refund tracking

======================================================================
26. INTEGRATION ARCHITECTURE
======================================================================

External integrations must implement provider interfaces.

Example:

MarketplaceProvider
  |-- CsvProvider
  |-- ShopifyProvider
  |-- WooCommerceProvider
  |-- AmazonProvider
  |-- FlipkartProvider
  `-- MeeshoProvider

Provider operations may include:

- Test connection
- Import orders
- Import products
- Import returns
- Import settlements
- Push fulfilment status
- Pull synchronization status
- Refresh credentials if supported
- Normalize provider response
- Classify retryable failures

Requirements:

- Secure credential storage
- Provider-specific configuration
- Sandboxes/mocks
- Idempotency keys
- Cursor/checkpoint handling
- Retry policy
- Exponential backoff where appropriate
- Rate-limit handling
- Sync logs
- Error queue
- Manual retry
- Duplicate prevention
- Field mapping
- Schema-version handling
- Correlation IDs
- No secret values in logs

Never place provider-specific structures directly into the billing engine.

Normalize all provider data before invoking domain services.

======================================================================
27. RETURNS, CREDIT NOTES AND REFUNDS
======================================================================

Support:

- Complete return
- Partial return
- Return request
- Return authorization
- Return receiving
- Quality inspection
- Sellable restock
- Damaged stock
- Non-restock
- Replacement
- Credit note
- Store/customer credit
- Partial refund
- Full refund
- Refund failure
- Refund retry
- Return-to-origin

A return must not automatically increase sellable stock until the configured
receiving and inspection policy permits it.

Refund and credit-note values must not exceed eligible amounts without a
controlled override.

Tax reversal must use the original transaction snapshot where applicable.

Every return must link to:

- Original order
- Original invoice
- Original invoice lines
- Return lines
- Credit note
- Refund
- Stock movement
- Journal entries

======================================================================
28. MARKETPLACE AND PAYMENT RECONCILIATION
======================================================================

Import settlement files in CSV and XLSX formats.

Provide configurable column mapping.

Capture:

- Channel
- Order ID
- Settlement ID
- Settlement date
- Gross sale
- Product discount
- Marketplace-funded discount
- Seller-funded discount
- Commission
- Payment fee
- Shipping fee
- Collection fee
- Advertising deduction
- TCS
- TDS
- GST on fees
- Refund deduction
- Return adjustment
- Penalty
- Other adjustment
- Net settlement

Statuses:

- Unmatched
- Suggested match
- Partially matched
- Matched
- Disputed
- Resolved

Support:

- Exact matching
- Suggested matching
- Date/amount tolerance
- Manual matching
- One-to-many matching
- Many-to-one matching
- Split matching
- Difference explanation
- Unmatched reports
- Fee analysis
- Channel profitability
- Order profitability
- Audit history

Never discard or auto-ignore an unmatched settlement line.

======================================================================
29. REPORTING AND DASHBOARD
======================================================================

Dashboard:

- Sales today
- Sales this month
- Orders by status
- Receivables
- Payables
- Cash and bank
- Low stock
- Top products
- Top customers
- Sales by channel
- Returns
- Refunds
- Estimated gross profit
- GST summary
- Recent business activity
- Integration failures
- Backup health

Sales reports:

- Sales summary
- Sales by customer
- Sales by product
- Sales by category
- Sales by channel
- Sales by state
- Sales by user
- Discount report
- Cancelled invoices
- Credit notes
- Returns

Inventory reports:

- Stock summary
- Stock ledger
- Stock valuation
- Low stock
- Out of stock
- Dead stock
- Inventory ageing
- Warehouse stock
- Batch/serial report
- Stock adjustments
- Reorder recommendations

Financial reports:

- Trial balance
- General ledger
- Profit and loss
- Balance sheet
- Day book
- Cash book
- Bank book
- Receivables ageing
- Payables ageing
- Payment collection
- Expense analysis
- Product profitability
- Order profitability
- Channel profitability
- Marketplace fee analysis

GST support reports:

- GST sales register
- GST purchase register
- HSN summary
- B2B sales
- B2C classifications
- Credit/debit notes
- Nil/exempt/non-GST
- Tax-liability summary
- Input-tax summary
- Output-tax summary
- GSTR-1 preparation report
- GSTR-3B preparation report
- Validation exceptions

Reports must support relevant:

- Date ranges
- Financial year
- Warehouse
- Channel
- Customer
- Supplier
- Product
- Category
- Tax rate
- Payment status
- Fulfilment status
- Drill-down
- CSV
- XLSX
- Print
- PDF

Label profitability as estimated when cost information is incomplete.

======================================================================
30. DOCUMENT TEMPLATE DESIGNER
======================================================================

Allow configuration of:

- Logo
- Theme colour
- Font
- Header
- Footer
- Business details
- Bank details
- UPI information
- Terms
- Declaration
- Signature
- Column visibility
- Tax visibility
- QR placement
- Custom labels
- A4/A5/thermal format

Provide preview before saving.

Warn before hiding fields that may be necessary for configured document types.

Template changes must not modify previously saved posted-document snapshots.

======================================================================
31. IMPORT, EXPORT AND MIGRATION OF BUSINESS DATA
======================================================================

Imports:

- Customers
- Suppliers
- Products
- Product variants
- Opening stock
- Opening balances
- Orders
- Sales invoices
- Purchase bills
- Payments
- Expenses
- Settlements

Formats:

- CSV
- XLSX

Workflow:

1. Select file
2. Detect format
3. Preview data
4. Map columns
5. Validate
6. Show row-level errors
7. Choose all-or-nothing or valid-row import where safe
8. Execute import
9. Display summary
10. Retain import audit
11. Support controlled rollback where safe

Exports:

- CSV
- XLSX
- PDF
- Structured JSON where appropriate
- Complete business-data export

Provide sample templates.

Avoid irreversible vendor lock-in.

======================================================================
32. ATTACHMENTS
======================================================================

Allow attachments for:

- Customers
- Suppliers
- Orders
- Invoices
- Purchases
- Expenses
- Payments
- Returns
- Reconciliations

Requirements:

- Approved attachment directory
- Random internal filenames
- Original filename as metadata
- File-size limit
- MIME and extension validation
- Executable-file restrictions
- Path-traversal protection
- Virus-scanning integration hook
- No automatic launching
- Backup inclusion
- Missing-file detection
- Hash/checksum
- Access-control checks

======================================================================
33. AUDIT LOG
======================================================================

Create an append-only audit log.

Audit:

- Login success
- Login failure
- Logout
- Record creation
- Record changes
- State changes
- Invoice posting
- Invoice cancellation
- Credit/debit note
- Payment
- Refund
- Stock adjustment
- Reconciliation
- Tax-setting changes
- User/role changes
- Imports
- Exports
- Backup
- Restore
- Financial lock/unlock
- Credential changes
- Integration activity

Record:

- Event ID
- Timestamp
- User
- Event category
- Action
- Entity type
- Entity ID
- Before/after values
- Sensitive-field redaction
- Reason
- Application version
- Device identifier where appropriate
- Correlation ID

Ordinary users cannot edit or delete audit events.

Separate:

- Security logs
- Application diagnostic logs
- Business audit logs

Do not log:

- Passwords
- Credential secrets
- Access tokens
- Complete payment-card data
- Backup encryption passwords

======================================================================
34. DATABASE MODEL
======================================================================

Design a normalized schema covering at minimum:

Foundation:

- organizations
- organization_settings
- business_locations
- financial_years
- warehouses
- users
- roles
- permissions
- user_roles
- role_permissions
- sessions
- document_sequences
- tax_rates
- tax_categories
- hsn_sac_codes
- units

Master data:

- customers
- customer_addresses
- customer_contacts
- suppliers
- supplier_addresses
- categories
- brands
- products
- product_variants
- product_attributes
- product_barcodes
- product_prices
- marketplace_product_mappings

Inventory:

- inventory_balances
- inventory_movements
- stock_reservations
- stock_transfers
- stock_transfer_lines
- stock_counts
- stock_count_lines
- batches
- serial_numbers
- bundle_components

Sales:

- orders
- order_items
- order_status_history
- quotations
- quotation_items
- invoices
- invoice_items
- invoice_status_history
- delivery_challans
- delivery_challan_items
- credit_notes
- credit_note_items
- debit_notes
- debit_note_items
- shipments
- shipment_items

Returns:

- returns
- return_items
- return_inspections
- replacement_orders
- refund_records

Purchasing:

- purchase_orders
- purchase_order_items
- goods_receipts
- goods_receipt_items
- purchase_bills
- purchase_bill_items
- purchase_returns
- purchase_return_items

Payments and accounting:

- payment_methods
- payments
- payment_allocations
- expenses
- expense_categories
- bank_accounts
- accounts
- journal_entries
- journal_lines
- accounting_periods

Reconciliation:

- reconciliation_batches
- reconciliation_lines
- reconciliation_matches
- settlement_adjustments

Integrations:

- integrations
- integration_credentials
- integration_mappings
- sync_runs
- sync_checkpoints
- sync_errors
- webhook_events

System:

- attachments
- audit_logs
- import_batches
- import_rows
- export_history
- backup_history
- restore_history
- notifications
- application_settings
- migration_history

For each table define:

- Primary key
- Organization scope
- Foreign keys
- Unique constraints
- Check constraints
- Indexes
- Decimal precision
- Nullability
- Soft-delete policy
- Timestamps
- Version/concurrency field
- Retention considerations
- Audit considerations

Generate:

- Prisma schema
- Versioned migrations
- Seed data
- Mermaid ER diagram
- Data dictionary
- Relationship explanation
- Index strategy
- Archival strategy

======================================================================
35. TRANSACTION AND CONCURRENCY RULES
======================================================================

Use explicit database transactions for:

- Posting invoices
- Allocating numbers
- Reserving stock
- Dispatching orders
- Receiving returns
- Posting refunds
- Receiving purchases
- Posting supplier bills
- Recording payments
- Allocating payments
- Posting journals
- Transferring stock
- Importing orders
- Reconciliation posting

Prevent:

- Duplicate document numbers
- Duplicate marketplace orders
- Duplicate webhook processing
- Double payment application
- Double stock deduction
- Double refund posting
- Negative stock where prohibited
- Concurrent overwrite
- Partial posting of multi-step transactions

Use:

- Unique database constraints
- Idempotency keys
- Row/version checks
- Appropriate transaction isolation
- Transactional outbox where external synchronization requires it
- Clear user-facing conflict messages

======================================================================
36. BACKUP AND DISASTER RECOVERY
======================================================================

Provide:

- Manual full backup
- Scheduled backup
- Encrypted backup archive
- Database backup
- Attachment backup
- Configuration backup
- Backup checksum
- Backup manifest
- Retention policy
- Backup history
- Restore wizard
- Restore validation
- Pre-restore safety backup
- Recovery documentation

Retention options:

- Keep last N backups
- Daily
- Weekly
- Monthly

A backup is not considered verified until a test restore succeeds.

Backup verification workflow:

Create encrypted backup
  -> Generate checksum
  -> Validate archive
  -> Create isolated temporary database
  -> Restore database
  -> Validate migrations
  -> Compare critical record counts
  -> Validate journal balances
  -> Validate inventory integrity
  -> Validate attachment manifest
  -> Record PASS or FAIL

Restore rules:

- Never overwrite the active database without explicit authorization.
- Display backup date, version, organization and checksum.
- Verify compatibility.
- Create a pre-restore backup.
- Stop active writes.
- Restore transactionally where possible.
- Record restore activity.
- Show a clear success/failure result.
- Provide recovery actions for failure.

======================================================================
37. DATABASE MIGRATION POLICY
======================================================================

Every schema change must include:

1. Versioned migration
2. Forward migration
3. Data transformation where required
4. Pre-migration backup
5. Migration validation
6. Failure handling
7. Recovery documentation
8. Automated migration test

Application startup migration flow:

Check application/database versions
  -> Compatible?
     -> Yes: start application
     -> No: assess migration path
  -> Create pre-migration backup
  -> Execute migration
  -> Validate schema
  -> Validate critical data
  -> Record result
  -> Start only on success

If migration fails:

- Stop normal startup
- Do not repeatedly rerun a destructive migration
- Preserve logs
- Preserve the backup
- Present recovery information
- Allow diagnostic export
- Do not claim the upgrade succeeded

Test migrations using:

- Empty database
- Previous supported version
- Representative populated database
- Large-data fixture where applicable
- Interrupted migration scenario
- Invalid migration scenario

======================================================================
38. SECURITY REQUIREMENTS
======================================================================

Target OWASP ASVS Level 2 principles where applicable.

Implement:

- Secure password hashing
- Server-side authorization
- Client-side and server-side validation
- Parameterized database access
- Output encoding
- Content Security Policy
- Electron context isolation
- Renderer sandbox where compatible
- Renderer nodeIntegration disabled
- Minimal validated preload bridge
- No arbitrary remote content in privileged windows
- Navigation restrictions
- External-link allow-list
- Secure secret storage using OS credential facilities where practical
- Secure temporary files
- Path-traversal protection
- Upload validation
- Dependency scanning
- Secure error handling
- Sensitive-data redaction
- localhost-only API binding
- No unauthenticated LAN exposure
- CSRF protection where applicable
- Restricted CORS
- Backup encryption
- Session timeout
- Audit logging
- Rate limiting
- Least privilege
- Safe IPC validation
- No shell command construction from untrusted input

Create:

- SECURITY.md
- THREAT_MODEL.md
- Security architecture
- Dependency inventory
- Software bill of materials
- Security test checklist
- Vulnerability-handling procedure
- Patch-management procedure

======================================================================
39. USER EXPERIENCE
======================================================================

Create a professional desktop interface with:

- Responsive desktop layout
- Global search
- Command palette
- Keyboard navigation
- Recent documents
- Saved filters
- Resizable tables
- Sortable tables
- Pagination
- Bulk actions
- Confirmation dialogs
- Undo where safe
- Toast notifications
- Inline validation
- Accessible colours
- Light theme
- Dark theme
- Empty states
- Loading states
- Error states
- Tooltips
- Guided onboarding
- Configurable dashboard
- Indian number formatting
- Configurable dates
- Financial-year filters

Every destructive action must communicate:

- What will change
- Whether the change can be reversed
- Related documents affected
- Required reason where applicable

======================================================================
40. DEMO DATA
======================================================================

Create a fictional demonstration business.

Include:

- One organization
- Administrator
- Accountant
- Billing operator
- Warehouse operator
- Customers
- Suppliers
- Two warehouses
- Categories
- Products
- Variants
- Several GST rates
- Opening stock
- Orders from different channels
- Invoices
- Purchases
- Payments
- Expenses
- Returns
- Settlements

Display a clear DEMO DATA marker.

Never mix demo data into production data automatically.

Demo users must be forced to change passwords or be disabled in production
builds.

======================================================================
41. TESTING STRATEGY
======================================================================

Tax tests:

- Intra-state CGST/SGST
- Inter-state IGST
- Inclusive tax
- Exclusive tax
- Multiple rates
- Line discount
- Invoice discount
- Shipping tax
- Round-off
- Nil-rated
- Exempt
- Non-GST
- Cess
- Credit-note reversal
- Boundary rounding

Invoice tests:

- Number allocation
- Financial-year change
- Posting
- Partial payment
- Full payment
- Cancellation
- Credit note
- Duplicate prevention
- Immutability
- PDF generation

Inventory tests:

- Opening stock
- Purchase receipt
- Reservation
- Dispatch
- Cancellation
- Return
- Sellable restock
- Damaged return
- Transfer
- Bundle assembly
- Concurrent allocation
- Negative-stock policy

Accounting tests:

- Balanced journal
- Invoice posting
- Payment posting
- Refund
- Credit note
- Purchase bill
- Expense
- Supplier payment
- Period lock
- Reversal
- Trial balance

Reconciliation tests:

- Exact match
- Suggested match
- Partial match
- Split match
- Fee deduction
- Refund deduction
- Unmatched line
- Net bank receipt

Security tests:

- Authentication
- Authorization
- Privilege escalation
- Validation
- Path traversal
- Upload restrictions
- IPC validation
- Audit logging
- Sensitive logging prevention
- Rate limiting

Backup tests:

- Create
- Encrypt
- Verify
- Restore
- Record comparison
- Wrong password
- Corrupted archive
- Missing attachment
- Version mismatch

Migration tests:

- Clean database
- Previous supported version
- Populated database
- Failure recovery
- Backup creation

End-to-end tests:

1. Business setup -> product -> stock -> customer -> order -> invoice ->
   payment -> report.
2. Marketplace import -> invoice -> shipment -> partial return ->
   credit note -> refund.
3. Purchase order -> receipt -> supplier bill -> supplier payment.
4. Mixed GST invoice -> PDF -> partial payment -> final payment.
5. Settlement import -> matching -> fees -> bank receipt.
6. Backup -> isolated restore -> integrity validation.
7. Upgrade previous version -> migration -> application start.
8. Role-based access attempts across all standard roles.

Set meaningful coverage thresholds and report actual coverage.

Do not manipulate thresholds merely to make a failing build appear successful.

======================================================================
42. RISK REGISTER
======================================================================

Maintain docs/RISK_REGISTER.md.

At minimum track:

- Incorrect GST calculation
- Floating-point money errors
- Duplicate invoice numbers
- Posted-document modification
- Unbalanced journals
- Negative or inconsistent stock
- Duplicate marketplace imports
- Duplicate refunds
- Settlement mismatches
- Failed migrations
- Invalid backups
- Restore failure
- Attachment loss
- Credential exposure
- Unauthorized access
- Audit-log tampering
- Corrupted local database
- Machine/disk failure
- Dependency vulnerabilities
- Marketplace API changes
- Government API changes
- Time-zone and date-boundary errors
- Financial-year sequence errors
- Printer/PDF inconsistencies
- Partial integration failure
- Secret leakage in logs
- Unsupported compliance claims

For each risk record:

- Risk ID
- Description
- Cause
- Impact
- Likelihood
- Severity
- Mitigation
- Detection
- Recovery
- Owner/module
- Status
- Related test

======================================================================
43. REQUIREMENTS TRACEABILITY
======================================================================

Maintain:

docs/REQUIREMENTS_MATRIX.md

Columns:

- Requirement ID
- Requirement
- Phase
- Module
- Source file
- Test
- Documentation
- Status
- Limitation
- Verification date

Statuses:

- Not started
- Designed
- In progress
- Implemented
- Tested
- Blocked
- Deferred
- Production verified

Do not mark a requirement Tested unless a relevant automated or documented
manual test has executed successfully.

Do not mark an integration Production verified without authorized service
validation.

======================================================================
44. PROJECT STATE MANAGEMENT
======================================================================

Maintain:

docs/PROJECT_STATE.md

Include:

- Application version
- Current phase
- Current database version
- Last successful migration
- Last successful build
- Last successful test run
- Completed modules
- In-progress modules
- Not-started modules
- Open defects
- Open security issues
- Open data-integrity issues
- Known limitations
- External integrations and verification status
- Current release status
- Exact next task

Update this file after every meaningful implementation batch.

Do not begin work based only on conversation history. Treat the repository and
PROJECT_STATE.md as the primary implementation record.

======================================================================
45. DOCUMENTATION
======================================================================

Create:

- README.md
- QUICK_START.md
- WINDOWS_INSTALLATION.md
- USER_GUIDE.md
- ADMIN_GUIDE.md
- BILLING_GUIDE.md
- INVENTORY_GUIDE.md
- ACCOUNTING_AND_GST_GUIDE.md
- MARKETPLACE_INTEGRATIONS.md
- RECONCILIATION_GUIDE.md
- BACKUP_AND_RESTORE.md
- DISASTER_RECOVERY.md
- DATA_IMPORT_EXPORT.md
- DEVELOPER_GUIDE.md
- DATABASE_SCHEMA.md
- API_DOCUMENTATION.md
- SECURITY.md
- THREAT_MODEL.md
- TESTING.md
- TROUBLESHOOTING.md
- RELEASE_CHECKLIST.md
- REQUIREMENTS_MATRIX.md
- PROJECT_STATE.md
- RISK_REGISTER.md
- CHANGELOG.md

Documentation must explain:

- Installation
- First-time setup
- Starting/stopping
- Login and password reset
- User roles
- Customers
- Products
- Stock
- Invoices
- Payments
- Purchases
- Expenses
- Returns
- Credit notes
- Refunds
- Marketplace imports
- Reconciliation
- Reports
- GST configuration
- Backups
- Restore testing
- Upgrades
- Error recovery
- Log export
- Full data export
- Uninstallation
- Known limitations

======================================================================
46. WINDOWS INSTALLER
======================================================================

Produce:

- Signed-ready installer configuration
- Desktop shortcut
- Start-menu entry
- Application icon
- Version display
- User-data directory outside installation directory
- Database-data directory
- Attachment directory
- Log directory
- Backup directory
- Migration-on-upgrade support
- Pre-upgrade backup
- Rollback/recovery instructions
- Diagnostic export
- Clean uninstall
- Explicit business-data retention choice
- Offline installation documentation

Everyday operation must not require administrator privileges.

If elevated privileges are required during installation, document the exact
reason.

Uninstall must never silently delete business data.

======================================================================
47. PERFORMANCE AND SCALE TARGETS
======================================================================

Design for a small business while avoiding obvious scaling failures.

Test representative scenarios including:

- Thousands of products
- Thousands of customers
- Tens of thousands of orders
- Tens of thousands of invoices
- Large stock-movement history
- Multi-year accounting history
- Large settlement imports
- Paginated reports
- Bulk PDF generation

Use indexes, pagination and streaming exports where appropriate.

Do not load entire large tables into renderer memory.

Document measured test conditions and actual outcomes instead of claiming
unsupported performance.

======================================================================
48. ERROR HANDLING AND DIAGNOSTICS
======================================================================

Use stable error codes.

Separate:

- User validation errors
- Business-rule errors
- Authorization errors
- Integration errors
- Database errors
- System errors

Users should see:

- Clear description
- Affected operation
- Whether data was saved
- Safe next action
- Correlation/reference ID

Users must not see:

- Raw SQL
- Stack traces
- Secrets
- Internal paths where avoidable
- Provider credentials

Provide an administrator diagnostic export containing:

- Application version
- Database version
- Sanitized logs
- Migration status
- Integration status
- Backup status
- Environment summary

Do not include secrets or unnecessary business data.

======================================================================
49. STRICT COMPLETION POLICY
======================================================================

Never state:

- Implemented
- Completed
- Working
- Secure
- Production ready
- All tests pass
- Integration verified

unless the corresponding code exists and the applicable validation command has
executed successfully.

For each completed module, provide:

- Requirements addressed
- Files created
- Files modified
- Migration created
- Tests added
- Commands executed
- Actual command results
- Known limitations
- Integration-verification status

Capabilities requiring credentials must be marked:

NOT VERIFIED AGAINST LIVE SERVICE

until legitimately tested.

Do not simulate successful external responses and present them as live
validation.

Mocks must be labeled as mocks.

Sandbox results must be labeled as sandbox results.

Do not hide:

- Failing tests
- Security findings
- Migration failures
- Data-integrity issues
- Incomplete behavior
- Unsupported cases
- Performance concerns
- Recovery limitations

======================================================================
50. DEFINITION OF DONE
======================================================================

A phase is complete only when:

- Required code exists
- Required migrations exist
- Required tests exist
- Applicable tests pass
- Documentation is updated
- Project state is updated
- Requirements matrix is updated
- Risk register is updated
- Build succeeds
- Exit criteria are satisfied
- Known limitations are documented

The complete product is not done until:

- Windows installation succeeds
- First-run setup succeeds
- Secure login works
- Roles work
- Customer creation works
- Product creation works
- Stock receiving works
- Order creation/import works
- GST invoice generation works
- Invoice PDF/printing works
- Payments work
- Returns work
- Credit notes work
- Refunds work
- Purchases work
- Expenses work
- Journals balance
- Inventory reconciles
- Reports execute
- Import/export works
- Backup succeeds
- Test restore succeeds
- Audit logs capture critical events
- Database upgrades safely
- Full automated testing passes
- Production build succeeds
- Windows installer succeeds
- Required documentation exists
- Traceability review is complete
- Critical security issues are resolved

======================================================================
51. FINAL RELEASE REVIEW
======================================================================

Before declaring a release ready, execute and document:

1. Dependency installation
2. Type-check
3. Lint
4. Unit tests
5. Integration tests
6. End-to-end tests
7. Security tests
8. Migration tests
9. Clean-database migration
10. Previous-version upgrade
11. Invoice-calculation reconciliation
12. Inventory reconciliation
13. Journal-balance verification
14. Backup creation
15. Isolated restore
16. Attachment validation
17. Permission matrix
18. Dependency vulnerability scan
19. Electron security review
20. Software bill of materials generation
21. Production build
22. Windows installer generation
23. Installer smoke test
24. Documentation review
25. Requirements traceability review
26. Known-limitations review

Produce a release report containing:

- Version
- Commit
- Database version
- Build result
- Test results
- Security results
- Migration results
- Backup/restore result
- Installer result
- Requirements completed
- Requirements deferred
- Known limitations
- External integrations and their verification level
- Release recommendation

======================================================================
52. REQUIRED INITIAL RESPONSE
======================================================================

Begin with Phase 0.

In the first response:

1. Restate the product scope concisely.
2. List assumptions.
3. Identify compliance items requiring professional verification.
4. Produce the proposed architecture.
5. Produce major architecture decisions.
6. Produce the module dependency map.
7. Produce the phased roadmap.
8. Produce the initial database-domain map.
9. Produce the first risk register.
10. Produce the repository tree.
11. Produce Phase 0 acceptance criteria.
12. Identify any blocking technical contradiction in this specification.
13. Then proceed to create the actual Phase 0 repository files.

Do not stop after planning if filesystem and terminal access are available.

Do not begin Phase 1 until Phase 0 exit criteria are met.

If response or tool-output limits interrupt implementation:

- Complete the current file safely.
- Do not truncate code intentionally.
- Report the exact last completed file.
- Update PROJECT_STATE.md if possible.
- State the exact next file and task.
- Do not regenerate completed files in the next batch unless correcting a
  verified defect.

======================================================================
53. NON-NEGOTIABLE RULES
======================================================================

- Do not use floating-point arithmetic for money.
- Do not silently modify posted transactions.
- Do not delete posted financial records.
- Do not reuse posted invoice numbers.
- Do not expose the database to the network by default.
- Do not store passwords or secrets in plaintext.
- Do not place secrets in source control.
- Do not log sensitive credentials.
- Do not trust client-side totals.
- Do not trust client-side authorization.
- Do not update inventory without stock movements.
- Do not post accounting entries that do not balance.
- Do not process the same webhook more than once.
- Do not discard unmatched settlements.
- Do not overwrite active data during restore without authorization.
- Do not upgrade the database without a recoverable backup.
- Do not claim an external integration works without evidence.
- Do not fabricate government identifiers.
- Do not hide build or test failures.
- Do not mark placeholders as completed functionality.
- Do not bypass tests merely to complete a phase.
- Do not rewrite working modules without reviewing dependencies and tests.
- Do not proceed across a failed phase gate.
- Do not claim production readiness before the final release review.
- Always preserve transaction history.
- Always preserve auditability.
- Always provide a safe recovery path.
- Always update project-state and traceability documentation.

Start with Phase 0 now.