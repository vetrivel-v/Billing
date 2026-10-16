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

/** Bridge exposed by the Electron preload script (kept minimal by design). */
export interface DesktopBridge {
  getAppInfo(): Promise<{ name: string; version: string; platform: string }>;
}

/** Application version reported by health checks until release tooling injects it (Phase 6). */
export const APP_VERSION = '0.0.1';
