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

/** Bridge exposed by the Electron preload script (kept minimal by design; argument-free methods only). */
export interface DesktopBridge {
  getAppInfo(): Promise<{ name: string; version: string; platform: string }>;
  getApiAccess(): Promise<ApiAccess>;
}

/** Application version reported by health checks until release tooling injects it (Phase 6). */
export const APP_VERSION = '0.0.1';

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

export type CustomerType = 'B2C' | 'B2B';
export type CustomerGstStatus = 'REGISTERED' | 'UNREGISTERED' | 'COMPOSITION';

/** A customer as the API returns it. State names are derived from the reference list; dates are ISO strings. */
export interface CustomerView {
  id: string;
  code: string;
  customerType: CustomerType;
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
