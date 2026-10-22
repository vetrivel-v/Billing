/**
 * Stable error codes (spec section 48). Codes are grouped by category prefix and
 * must never be renamed once released; add new codes instead.
 */
export const ErrorCodes = {
  // User validation errors
  VALIDATION_FAILED: 'VAL_0001',
  // Business-rule errors
  BUSINESS_RULE_VIOLATION: 'BIZ_0001',
  // Authorization errors
  UNAUTHENTICATED: 'AUTH_0001',
  FORBIDDEN: 'AUTH_0002',
  RATE_LIMITED: 'AUTH_0003',
  /** Authenticated, but the account must change its password first (ADR-0017). */
  PASSWORD_CHANGE_REQUIRED: 'AUTH_0004',
  // Integration errors
  INTEGRATION_FAILED: 'INT_0001',
  // Database errors
  DATABASE_UNAVAILABLE: 'DB_0001',
  DATABASE_CONFLICT: 'DB_0002',
  // System errors
  NOT_FOUND: 'SYS_0404',
  INTERNAL: 'SYS_0500',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export type ErrorCategory =
  'validation' | 'business' | 'authorization' | 'integration' | 'database' | 'system';

/** Error body returned by the API. Never contains stack traces, SQL or secrets. */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /** Whether the requested operation persisted any data. */
    dataSaved: boolean;
    /** Correlation/reference ID that also appears in server logs. */
    correlationId: string;
    /** Optional field-level problems (field path + rule code only; never submitted values). */
    problems?: { field: string; rule: string }[];
    /** Optional structured, value-free details for a specific code (for example a fresh calculation after CALCULATION_STALE). */
    details?: Record<string, unknown>;
  };
}

export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface HealthResponse {
  status: HealthStatus;
  service: 'commercebill-api';
  version: string;
  time: string;
}

export interface DatabaseHealthResponse extends HealthResponse {
  database: { status: HealthStatus };
}

/** How the renderer reaches the local API. The secret is generated per launch by the Electron shell. */
export interface ApiAccess {
  baseUrl: string;
  secret: string;
}

/**
 * The outcome of a print or save request. Deliberately carries no file path: the renderer never learns where a file was written.
 * `failed` is generic on purpose (no content, no path, no internal message).
 */
export interface DocumentOutputResult {
  status: 'saved' | 'printed' | 'cancelled' | 'failed';
  /** The default file name suggested to the user for a save (never a path). */
  fileName?: string;
}

/**
 * Bridge exposed by the Electron preload script (kept minimal by design). The only methods with an argument take an already
 * posted invoice SNAPSHOT: the main process validates it strictly, renders it itself, and decides where anything is written
 * through the operating system's own dialogs. There is no file-system, shell or navigation access.
 */
export interface DesktopBridge {
  getAppInfo(): Promise<{ name: string; version: string; platform: string }>;
  getApiAccess(): Promise<ApiAccess>;
  /** Renders the invoice to an A4 PDF and asks the user where to save it (a save dialog). */
  saveInvoicePdf(invoice: InvoiceView): Promise<DocumentOutputResult>;
  /** Opens the operating system's print dialog for the invoice. Never prints silently. */
  printInvoice(invoice: InvoiceView): Promise<DocumentOutputResult>;
  /** Opens the operating system's folder chooser for backups. The folder is registered with the local service by the shell; the renderer only learns its display name. */
  chooseBackupDestination(): Promise<BackupChoiceResult>;
  /** Opens the operating system's file chooser for a backup to restore. The renderer receives an opaque id and the file name, never a path. */
  chooseRestoreFile(): Promise<BackupChoiceResult>;
  /** Safe facts for a support conversation (versions, database and service state, log folder). Never credentials or business data. */
  getDiagnostics(): Promise<Diagnostics>;
  /** Saves the diagnostics as a text file through a save dialog. */
  exportDiagnostics(): Promise<{ status: 'saved' | 'cancelled' | 'failed' }>;
  /** Opens the folder holding the diagnostic logs in Windows Explorer. */
  openLogFolder(): Promise<{ status: 'opened' | 'failed' }>;
  /** Shows, in a Windows message box (never in the page), the passphrase of the safety backups made before an update. */
  showSafetyPassphrase(): Promise<{ status: 'shown' | 'unavailable' }>;
}

/**
 * What a support person needs when "CommerceBill isn't opening", and nothing more: it never contains a password, passphrase, token,
 * launch secret, customer or invoice data.
 */
export interface Diagnostics {
  generatedAt: string;
  application: { name: string; version: string };
  windows: { version: string; release: string; arch: string };
  database: { running: boolean; port: number | null; install: 'fresh' | 'existing' | 'unknown' };
  schema: { current: string | null; expected: string | null; state: string };
  api: { health: 'ok' | 'not running' | 'unknown' };
  backup: { lastVerificationResult: string | null; lastVerifiedAt: string | null };
  lastUpgrade: { from: string | null; to: string; at: string; safetyBackup: string | null } | null;
  storage: { dataFolder: string; logFolder: string; freeMegabytes: number | null };
  logs: { name: string; kilobytes: number }[];
  startupProblem: { code: string; message: string } | null;
  /** True when CommerceBill itself manages the local database (the installed application). */
  managedDatabase: boolean;
}

/** The outcome of a native backup folder/file chooser. Never carries a path. */
export interface BackupChoiceResult {
  status: 'chosen' | 'cancelled' | 'failed';
  /** Display name of the chosen folder, or file name of the chosen backup. */
  label?: string;
  /** For a restore file: an opaque id the local service understands. */
  sourceId?: string;
}

/**
 * The application version (SemVer). It is the single release number: the installer, the About screen and the health check all show it
 * (a test keeps it equal to apps/desktop/package.json). It is independent of the database structure version (the newest migration name)
 * and never feeds into any document number.
 */
export const APP_VERSION = '0.1.0';

/** POST /auth/login success body. The token goes in the Authorization header of later requests. */
export interface LoginResponse {
  token: string;
  expiresAt: string;
  idleTimeoutSeconds: number;
  mustChangePassword: boolean;
  user: { id: string; username: string; displayName: string; organizationId: string };
}

/** GET /auth/me body: who the server believes the caller is, and what they may do. */
export interface MeResponse {
  user: { id: string; username: string; displayName: string; organizationId: string };
  /** Display only: the organization's name and the user's role names. */
  organizationName: string;
  roles: string[];
  /** Stable permission keys (e.g. "sales.invoice.post"). Informational: the server enforces them. */
  permissions: string[];
  mustChangePassword: boolean;
  sessionExpiresAt: string;
  idleTimeoutSeconds: number;
}

/** GET /setup/status. Deliberately minimal: no business, administrator or financial information. */
export interface SetupStatusResponse {
  setupRequired: boolean;
  draftAvailable: boolean;
}

/** POST /setup/complete success body. No session token: the administrator must sign in explicitly. */
export interface SetupCompleteResponse {
  organizationId: string;
  administratorUsername: string;
  nextStep: 'login';
}

// ------------------------------------------------------------------------------------------------ customers

export type CustomerKind = 'INDIVIDUAL' | 'BUSINESS';
export type CustomerGstStatus = 'REGISTERED' | 'UNREGISTERED' | 'COMPOSITION';

/** A customer as the API returns it. State names are derived from the reference list; dates are ISO strings. */
export interface CustomerView {
  id: string;
  code: string;
  customerKind: CustomerKind;
  legalName: string;
  displayName: string | null;
  contactPerson: string | null;
  email: string | null;
  phone: string | null;
  alternatePhone: string | null;
  gstStatus: CustomerGstStatus;
  gstin: string | null;
  pan: string | null;
  billingAddressLine1: string;
  billingAddressLine2: string | null;
  billingCity: string | null;
  billingStateCode: string;
  billingStateName: string | null;
  billingPinCode: string | null;
  country: string;
  shippingSameAsBilling: boolean;
  shippingAddressLine1: string | null;
  shippingAddressLine2: string | null;
  shippingCity: string | null;
  shippingStateCode: string | null;
  shippingStateName: string | null;
  shippingPinCode: string | null;
  placeOfSupplyStateCode: string;
  placeOfSupplyStateName: string | null;
  /** Decimal string with two places, or null. */
  creditLimit: string | null;
  paymentTermsDays: number | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface CustomerListResponse {
  customers: CustomerView[];
  total: number;
  limit: number;
  offset: number;
}

// -------------------------------------------------------------------------------------------------- products

export type ProductKind = 'GOODS' | 'SERVICE';

/** A product as the API returns it. Money is an exact decimal STRING with two places (never a JSON number). */
export interface ProductView {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  kind: ProductKind;
  hsnSacCodeId: string | null;
  hsnSacCode: { code: string; kind: 'HSN' | 'SAC'; description: string | null } | null;
  unitId: string | null;
  unit: { code: string; name: string; decimalPlaces: number } | null;
  taxCategoryId: string;
  taxCategory: { code: string; name: string; classification: string };
  mrp: string | null;
  sellingPrice: string;
  /** true: the selling price already includes GST; false: GST is added on top. Configuration only. */
  priceIncludesTax: boolean;
  trackInventory: boolean;
  barcode: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface ProductListResponse {
  products: ProductView[];
  total: number;
  limit: number;
  offset: number;
}

/** Reference lists the product form selects from (organization-scoped, active entries only). */
export interface ProductReferencesResponse {
  units: { id: string; code: string; name: string; decimalPlaces: number }[];
  taxCategories: { id: string; code: string; name: string; classification: string }[];
  /** How many HSN/SAC codes exist in the reference list (0 = the list has not been loaded). */
  hsnSacTotal: number;
}

export interface HsnSacSearchResponse {
  codes: { id: string; code: string; kind: 'HSN' | 'SAC'; description: string | null }[];
  total: number;
}

// -------------------------------------------------------------------------------------------------- inventory

export type StockMovementType =
  | 'OPENING_STOCK'
  | 'STOCK_RECEIPT'
  | 'ADJUSTMENT_INCREASE'
  | 'ADJUSTMENT_DECREASE'
  | 'SALES_DISPATCH';
export type AdjustmentReasonCode = 'COUNT_CORRECTION' | 'FOUND' | 'DAMAGE' | 'LOSS' | 'OTHER';

/** Quantities are exact decimal STRINGS ("2.5", "10") - never JSON numbers. There is no cost or value anywhere here. */
export interface WarehouseView {
  id: string;
  code: string;
  name: string;
  isPrimary: boolean;
  isActive: boolean;
}

export interface StockRowView {
  productId: string;
  sku: string;
  name: string;
  isActive: boolean;
  unit: { code: string; name: string; decimalPlaces: number };
  /** Stock on hand in the listed warehouse ("0" when nothing was ever recorded). */
  onHand: string;
  /** Whether any movement exists: opening stock is only possible while this is false. */
  hasMovements: boolean;
}

export interface StockListResponse {
  warehouse: { id: string; code: string; name: string } | null;
  stock: StockRowView[];
  total: number;
  limit: number;
  offset: number;
}

export interface StockMovementView {
  id: string;
  productId: string;
  productSku: string;
  productName: string;
  unit: { code: string; decimalPlaces: number };
  warehouseId: string;
  warehouseName: string;
  movementType: StockMovementType;
  /** Signed: positive adds stock, negative removes it. */
  quantityDelta: string;
  businessDate: string;
  reasonCode: AdjustmentReasonCode | null;
  reference: string | null;
  note: string | null;
  createdAt: string;
  createdByName: string;
}

export interface StockMovementListResponse {
  movements: StockMovementView[];
  total: number;
  limit: number;
  offset: number;
}

/** Result of a stock operation. `replayed` means the same operation had already been recorded and nothing changed. */
export interface StockOperationResponse {
  movement: StockMovementView;
  onHand: string;
  replayed: boolean;
}

// -------------------------------------------------------------------------------------------------- tax configuration

export type BillingMode = 'DEMO' | 'PRODUCTION';
export type TaxReviewState = 'NONE' | 'CURRENT' | 'STALE';

export interface TaxRateView {
  id: string;
  /** Exact decimal text. */
  ratePercent: string;
  cessPercent: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  origin: string;
  reviewStatus: 'UNREVIEWED' | 'REVIEWED';
}

export interface TaxCategoryView {
  id: string;
  code: string;
  name: string;
  classification: string;
  isActive: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  origin: string;
  reviewStatus: 'UNREVIEWED' | 'REVIEWED';
  rates: TaxRateView[];
}

export interface TaxReviewView {
  id: string;
  fingerprint: string;
  reviewedByName: string;
  reviewerCapacity: string;
  reviewedAt: string;
  noticeVersion: string;
  noticeText: string;
  note: string | null;
  engineVersion: string;
  rulesetVersion: string;
  jurisdictionRulesetVersion: string;
}

export interface HsnPolicyView {
  /** true = every invoice line needs an HSN/SAC code (the default). */
  required: boolean;
  reason: string | null;
  changedAt: string | null;
}

export interface TaxConfigurationResponse {
  engine: { engineVersion: string; rulesetVersion: string; roundingPolicyId: string };
  jurisdictions: {
    id: string;
    version: string;
    reviewStatus: 'UNREVIEWED';
    entries: { code: string; name: string; kind: string }[];
  };
  categories: TaxCategoryView[];
  fingerprint: string;
  review: { state: TaxReviewState; latest: TaxReviewView | null };
  notice: { version: string; text: string };
  seller: { gstStatus: string; gstin: string | null; stateCode: string | null };
  hsnPolicy: HsnPolicyView;
  gate: {
    mode: BillingMode;
    eligible: boolean;
    requirements: { code: string; met: boolean }[];
    sellerProblems: string[];
  };
}

export interface TaxReviewListResponse {
  reviews: TaxReviewView[];
  total: number;
  limit: number;
  offset: number;
}

export interface HsnSacView {
  id: string;
  code: string;
  kind: 'HSN' | 'SAC';
  description: string | null;
  isActive: boolean;
  origin: string;
  reviewStatus: 'UNREVIEWED' | 'REVIEWED';
  reviewedAt: string | null;
  reviewedByName: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface HsnSacListResponse {
  entries: HsnSacView[];
  total: number;
  limit: number;
  offset: number;
}

// -------------------------------------------------------------------------------------------------- invoices

export type InvoiceMode = 'DEMO' | 'PRODUCTION';
export type InvoiceDiscountInput =
  { type: 'NONE' } | { type: 'PERCENT'; percent: string } | { type: 'AMOUNT'; amount: string };

/** The calculation a user was shown. Posting carries it back so the server can refuse a calculation that changed. */
export interface InvoiceCalculationIdentity {
  inputHash: string;
  configurationFingerprint: string;
  grandTotal: string;
}

export interface InvoiceProblem {
  code: string;
  path?: string;
  lineRef?: string;
}

export interface InvoiceStockWarning {
  lineRefs: string[];
  productId: string;
  sku: string;
  required: string;
  onHand: string;
  sufficient: boolean;
  /** true for a DEMO invoice: what the real stock impact WOULD have been (a demo invoice never changes stock). */
  advisoryOnly: boolean;
}

export interface InvoicePreviewResponse {
  ok: boolean;
  /** True only when the calculation succeeded and nothing (such as an unconfirmed place of supply) blocks posting. */
  postable: boolean;
  mode: InvoiceMode;
  errors: InvoiceProblem[];
  warnings: InvoiceProblem[];
  /** The TaxEngine result (lines, totals, explanations). Null when the request could not be calculated at all. */
  calculation: Record<string, unknown> | null;
  identity: InvoiceCalculationIdentity | null;
  placeOfSupply: {
    suggestedStateCode: string | null;
    /** Billing and delivery states differ: the user must choose explicitly (OVERRIDE). */
    requiresExplicitChoice: boolean;
  };
  stockWarnings: InvoiceStockWarning[];
}

export interface InvoiceLineView {
  id: string;
  lineNo: number;
  productId: string;
  sku: string;
  productName: string;
  itemKind: string;
  hsnSacCode: string | null;
  hsnSacKind: string | null;
  unitCode: string;
  unitName: string;
  taxCategoryCode: string;
  taxCategoryName: string;
  classification: string;
  ratePercent: string;
  rateEffectiveFrom: string;
  rateEffectiveTo: string | null;
  quantity: string;
  unitPrice: string;
  priceBasis: string;
  grossAmount: string;
  discountType: string;
  discountPercent: string | null;
  discountAmount: string;
  taxableValue: string;
  cgstRate: string | null;
  cgstAmount: string;
  sgstRate: string | null;
  sgstAmount: string;
  utgstRate: string | null;
  utgstAmount: string;
  igstRate: string | null;
  igstAmount: string;
  roundingAdjustment: string;
  lineTotal: string;
  stockEffect: 'DISPATCH' | 'NONE';
}

/** Derived display state of an invoice's payments. The invoice itself stays immutable; nothing stores this. */
export type PaymentDisplayStatus = 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';

/**
 * What has been allocated to an invoice and what remains: grand total minus the persisted allocations, derived by the server.
 * For a DEMO invoice these are DEMO figures: not money received.
 */
export interface InvoicePaymentSummary {
  isDemo: boolean;
  grandTotal: string;
  allocated: string;
  balanceDue: string;
  status: PaymentDisplayStatus;
}

export interface InvoiceReceivableView {
  allocated: string;
  balanceDue: string;
}

export interface InvoiceView {
  id: string;
  status: 'POSTED';
  documentType: 'INVOICE' | 'DEMO_INVOICE';
  documentNumber: string;
  isDemo: boolean;
  invoiceDate: string;
  financialYearLabel: string;
  currency: string;
  warehouseName: string;
  seller: {
    legalName: string;
    tradeName: string | null;
    gstin: string;
    gstStatus: string;
    stateCode: string;
    addressLine1: string;
    addressLine2: string | null;
    city: string | null;
    pinCode: string | null;
  };
  customer: {
    id: string;
    code: string;
    name: string;
    gstStatus: string;
    gstin: string | null;
    billing: {
      addressLine1: string;
      addressLine2: string | null;
      city: string | null;
      stateCode: string;
      pinCode: string | null;
    };
    shipping: {
      addressLine1: string;
      addressLine2: string | null;
      city: string | null;
      stateCode: string;
      pinCode: string | null;
    };
    recipientClass: 'B2B' | 'B2C';
  };
  placeOfSupply: {
    stateCode: string;
    source: 'USER_CONFIRMED' | 'USER_OVERRIDE';
    confirmedByName: string;
    confirmedAt: string;
  };
  priceBasis: string;
  tax: {
    engineVersion: string;
    rulesetVersion: string;
    roundingPolicyId: string;
    inputHash: string;
    configurationFingerprint: string;
    taxReviewId: string | null;
    calculation: Record<string, unknown>;
  };
  totals: {
    grossSubtotal: string;
    lineDiscountTotal: string;
    taxableSubtotal: string;
    cgst: string;
    sgst: string;
    utgst: string;
    igst: string;
    roundingAdjustmentTotal: string;
    roundOff: string;
    grandTotal: string;
  };
  /** Production invoices: balance due = grand total (no payments before Task 1.16). Demo invoices: null. */
  receivable: InvoiceReceivableView | null;
  /** Derived paid / balance / status (DEMO figures for a demo invoice). */
  payment: InvoicePaymentSummary;
  lines: InvoiceLineView[];
  createdAt: string;
  createdByName: string;
}

export interface InvoiceSummaryView {
  id: string;
  documentNumber: string;
  isDemo: boolean;
  invoiceDate: string;
  customerId: string;
  customerCode: string;
  customerName: string;
  taxableSubtotal: string;
  /** CGST + SGST + UTGST + IGST. */
  taxTotal: string;
  grandTotal: string;
  receivable: InvoiceReceivableView | null;
  payment: InvoicePaymentSummary;
  createdAt: string;
}

export interface InvoiceListResponse {
  invoices: InvoiceSummaryView[];
  total: number;
  limit: number;
  offset: number;
}

export interface InvoicePostResponse {
  invoice: InvoiceView;
  /** True when this exact operation had already been posted: the original invoice is returned and nothing changed. */
  replayed: boolean;
}

// ------------------------------------------------------------------------------------------------ payments (Task 1.16)

export type PaymentMethod = 'CASH' | 'BANK_TRANSFER' | 'UPI' | 'CARD' | 'CHEQUE' | 'OTHER';

export interface PaymentView {
  id: string;
  paymentNumber: string;
  documentType: 'PAYMENT_RECEIPT' | 'DEMO_PAYMENT_RECEIPT';
  /** A DEMO payment is NOT money received. */
  isDemo: boolean;
  paymentDate: string;
  amount: string;
  method: PaymentMethod;
  reference: string | null;
  notes: string | null;
  customer: { id: string; code: string; name: string };
  allocations: { invoiceId: string; invoiceNumber: string; amount: string }[];
  createdAt: string;
  createdByName: string;
}

export interface PaymentListResponse {
  payments: PaymentView[];
  total: number;
  limit: number;
  offset: number;
}

export interface PaymentRecordResponse {
  payment: PaymentView;
  /** True when this exact operation had already been recorded: the original payment is returned and nothing changed. */
  replayed: boolean;
  invoice: { id: string; documentNumber: string } & InvoicePaymentSummary;
}

export interface ReceivableCustomerRow {
  customerId: string;
  customerCode: string;
  customerName: string;
  invoiceCount: number;
  totalInvoiced: string;
  totalPaid: string;
  outstanding: string;
}

export interface ReceivablesResponse {
  isDemo: boolean;
  customers: ReceivableCustomerRow[];
  totals: { invoiced: string; paid: string; outstanding: string };
  total: number;
  limit: number;
  offset: number;
}

export interface ReceivableInvoiceRow {
  invoiceId: string;
  documentNumber: string;
  invoiceDate: string;
  grandTotal: string;
  paid: string;
  balanceDue: string;
  status: PaymentDisplayStatus;
}

export interface CustomerReceivableResponse {
  isDemo: boolean;
  customer: { id: string; code: string; name: string };
  totals: { invoiced: string; paid: string; outstanding: string };
  invoices: ReceivableInvoiceRow[];
}

// ------------------------------------------------------------------------------------------------ backup and recovery (Task 1.17)

export interface BackupVerificationView {
  id: string;
  result: 'PASS' | 'FAIL';
  verifiedAt: string;
  engineVersion: string;
  /** Names and pass/fail only: never data. */
  checks: { name: string; ok: boolean }[];
}

export interface BackupView {
  id: string;
  kind: 'MANUAL' | 'PRE_RESTORE';
  /** The file name only: never the folder path. */
  fileName: string;
  destinationLabel: string | null;
  sizeBytes: number;
  createdAt: string;
  appVersion: string;
  schemaVersion: string;
  backupFormat: number;
  /** False once retention removed the file. */
  fileAvailable: boolean;
  /** The latest verified-restore result, or null when the backup has never been verified. */
  verification: BackupVerificationView | null;
}

export type RecoveryGateReason =
  | 'CURRENT'
  | 'NO_VERIFIED_BACKUP'
  | 'LATEST_VERIFICATION_FAILED'
  | 'VERIFICATION_ENGINE_CHANGED'
  | 'SCHEMA_CHANGED'
  | 'DATABASE_CHANGED'
  | 'VERIFICATION_TOO_OLD';

/** Whether a CURRENT verified-recovery record exists (the backup/restore requirement of the production gate). */
export interface BackupRecoveryGate {
  met: boolean;
  reason: RecoveryGateReason;
  verifiedAt: string | null;
  expiresAt: string | null;
}

export interface BackupStatusResponse {
  destination: { label: string } | null;
  retentionKeep: number | null;
  lastBackup: BackupView | null;
  lastVerifiedAt: string | null;
  gate: BackupRecoveryGate;
  schemaVersion: string;
  appVersion: string;
  maxVerificationAgeDays: number;
}

export interface BackupHistoryResponse {
  backups: BackupView[];
  total: number;
  limit: number;
  offset: number;
}

export interface BackupCreateResponse {
  backup: BackupView;
  verification: BackupVerificationView | null;
}

export interface RestoreInspectResponse {
  fileName: string;
  createdAt: string;
  organizationName: string;
  sameOrganization: boolean;
  appVersion: string;
  schemaVersion: string;
  schemaCompatible: boolean;
  sameDatabase: boolean;
  kind: 'MANUAL' | 'PRE_RESTORE' | 'PRE_UPGRADE';
  tables: number;
  rows: number;
  verificationStatus: 'PASS' | 'FAIL' | 'NOT_VERIFIED';
}

export interface RestoreResultResponse {
  status: 'RESTORED';
  restoredBackupId: string;
  restoredFromCreatedAt: string;
  safetyBackupId: string;
  productionGateMet: boolean;
  /** False if the backup history could not be copied into the restored database (the restore itself succeeded). */
  historyCarried: boolean;
}

/** One line of the production readiness summary. */
export interface ReadinessItem {
  code: string;
  met: boolean;
}

export interface BackupReadinessResponse {
  mode: BillingMode;
  eligible: boolean;
  items: ReadinessItem[];
}

// ---- Dashboard (Task 1.18) ---------------------------------------------------------------------------------------------

/** Totals for one kind of document. DEMO and PRODUCTION are always reported separately, never added together. */
export interface DashboardTotals {
  count: number;
  /** Money as a decimal string with two places. */
  total: string;
}
export interface DashboardByMode<T> {
  demo: T;
  production: T;
}
export interface DashboardRecentInvoice {
  id: string;
  documentNumber: string;
  invoiceDate: string;
  customerName: string;
  grandTotal: string;
  balanceDue: string;
  isDemo: boolean;
}
export interface DashboardRecentPayment {
  id: string;
  paymentNumber: string;
  paymentDate: string;
  customerName: string;
  amount: string;
  isDemo: boolean;
}
/** Every section is null when the caller lacks the permission its data needs. Nothing here is estimated or invented. */
export interface DashboardSummaryResponse {
  /** Business date (India) the figures are for. */
  asOf: string;
  mode: BillingMode;
  sales: DashboardByMode<{ today: DashboardTotals; month: DashboardTotals }> | null;
  receivables: DashboardByMode<{ outstanding: string; openInvoices: number }> | null;
  paymentsToday: DashboardByMode<DashboardTotals> | null;
  recentInvoices: DashboardRecentInvoice[] | null;
  recentPayments: DashboardRecentPayment[] | null;
  /** Tracked products only. No reorder levels exist yet, so only "nothing on hand" is reported. */
  stock: { trackedProducts: number; withStock: number; outOfStock: number } | null;
  recovery: {
    gate: BackupRecoveryGate;
    lastBackupAt: string | null;
    lastVerifiedAt: string | null;
  } | null;
  readiness: { items: ReadinessItem[]; ready: boolean } | null;
}
