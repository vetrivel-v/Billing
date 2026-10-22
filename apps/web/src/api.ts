import type {
  ApiAccess,
  BackupCreateResponse,
  BackupHistoryResponse,
  BackupReadinessResponse,
  BackupStatusResponse,
  BackupVerificationView,
  RestoreInspectResponse,
  RestoreResultResponse,
  ApiErrorBody,
  DatabaseHealthResponse,
  HealthResponse,
  LoginResponse,
  MeResponse,
  CustomerListResponse,
  CustomerView,
  HsnSacSearchResponse,
  ProductListResponse,
  HsnSacListResponse,
  HsnSacView,
  HsnPolicyView,
  TaxConfigurationResponse,
  TaxReviewListResponse,
  TaxReviewView,
  BillingMode,
  CustomerReceivableResponse,
  InvoiceListResponse,
  InvoicePostResponse,
  InvoicePreviewResponse,
  InvoiceView,
  PaymentListResponse,
  PaymentRecordResponse,
  PaymentView,
  ReceivablesResponse,
  StockListResponse,
  StockMovementListResponse,
  StockOperationResponse,
  ProductReferencesResponse,
  ProductView,
  SetupCompleteResponse,
  SetupStatusResponse,
} from '@commercebill/shared-types';

export const LAUNCH_SECRET_HEADER = 'x-commercebill-launch-secret';
/** Liveness is the only route the API serves without the launch secret. */
const UNAUTHENTICATED_PATHS = new Set(['/health']);

export class ApiRequestError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Request failed (${status})`);
    this.name = 'ApiRequestError';
    this.status = status;
  }
}

/**
 * An error answer from the API: HTTP status, stable error code and value-free field problems.
 * The server message is deliberately NOT kept: screens choose their own wording, so technical text never reaches users.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly problems: { field: string; rule: string }[];
  /** Structured, value-free details some answers carry (a stale calculation's fresh recalculation, unmet gate requirements). */
  readonly details: Record<string, unknown> | undefined;
  constructor(
    status: number,
    code?: string,
    problems: { field: string; rule: string }[] = [],
    details?: Record<string, unknown>,
  ) {
    super(`API error ${status}${code ? ` ${code}` : ''}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.problems = problems;
    this.details = details;
  }
}

/** The local service could not be reached at all (not started, still starting, crashed). */
export class ApiUnreachableError extends Error {
  constructor() {
    super('The local service is unreachable');
    this.name = 'ApiUnreachableError';
  }
}

interface Access {
  baseUrl: string;
  secret?: string;
}

let cachedAccess: Promise<Access> | undefined;

/**
 * Inside the Electron shell the preload bridge supplies the loopback URL and per-launch secret.
 * In a plain browser (web development) there is no bridge: use VITE_API_URL and no secret, which only
 * works against a development API that has no LAUNCH_SECRET configured.
 */
export function resolveAccess(): Promise<Access> {
  cachedAccess ??= (async (): Promise<Access> => {
    const bridge = typeof window === 'undefined' ? undefined : window.commercebill;
    if (bridge) {
      const a: ApiAccess = await bridge.getApiAccess();
      return { baseUrl: a.baseUrl, secret: a.secret };
    }
    return { baseUrl: import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:4310' };
  })();
  // Do not cache a failure (e.g. the service was not ready yet).
  cachedAccess.catch(() => {
    cachedAccess = undefined;
  });
  return cachedAccess;
}

export function resetAccessForTests(): void {
  cachedAccess = undefined;
}

async function getJson<T>(path: string): Promise<T> {
  const { baseUrl, secret } = await resolveAccess();
  const headers: Record<string, string> = {};
  if (secret && !UNAUTHENTICATED_PATHS.has(path)) headers[LAUNCH_SECRET_HEADER] = secret;
  const res = await fetch(`${baseUrl}${path}`, { headers });
  // /health/db answers 503 with a valid JSON body when the database is down.
  if (!res.ok && res.status !== 503) throw new ApiRequestError(res.status);
  return (await res.json()) as T;
}

export const fetchHealth = (): Promise<HealthResponse> => getJson('/health');
export const fetchDbHealth = (): Promise<DatabaseHealthResponse> => getJson('/health/db');

interface CallOptions {
  /** The application-user session token. It travels ONLY in the Authorization header, never in a URL or body. */
  token?: string;
  body?: unknown;
}

/**
 * Calls the local API. Sends the launch secret (separate control from the user session) on every call and the session
 * token only when one is passed. Returns undefined for 204. Throws ApiError for error answers and ApiUnreachableError
 * when the service cannot be reached.
 */
async function callApi<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  path: string,
  opts: CallOptions = {},
): Promise<T> {
  let res: Response;
  try {
    const { baseUrl, secret } = await resolveAccess();
    const headers: Record<string, string> = {};
    if (secret) headers[LAUNCH_SECRET_HEADER] = secret;
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  } catch {
    throw new ApiUnreachableError();
  }
  if (res.status === 204) return undefined as T;
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const err = (json as Partial<ApiErrorBody> | undefined)?.error;
    throw new ApiError(
      res.status,
      err?.code,
      Array.isArray(err?.problems) ? err.problems : [],
      err?.details && typeof err.details === 'object' ? err.details : undefined,
    );
  }
  return json as T;
}

export const getSetupStatus = (): Promise<SetupStatusResponse> => callApi('GET', '/setup/status');

export const login = (username: string, password: string): Promise<LoginResponse> =>
  callApi('POST', '/auth/login', { body: { username, password } });

export const getMe = (token: string): Promise<MeResponse> => callApi('GET', '/auth/me', { token });

export const logout = (token: string): Promise<void> => callApi('POST', '/auth/logout', { token });

export const changePassword = (
  token: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> =>
  callApi('POST', '/auth/change-password', { token, body: { currentPassword, newPassword } });

/** The saved first-run draft: non-secret fields only (the server rejects any password field). */
export interface SetupDraftResponse {
  draft: { data: Record<string, Record<string, unknown>>; version: number; savedAt: string } | null;
  discarded: boolean;
}

export const getSetupDraft = (): Promise<SetupDraftResponse> => callApi('GET', '/setup/draft');

export const saveSetupDraft = (
  data: unknown,
  expectedVersion: number,
): Promise<{ version: number; savedAt: string }> =>
  callApi('PUT', '/setup/draft', { body: { data, expectedVersion } });

/** Atomic first-run completion. Creates NO session: the administrator signs in afterwards. */
export const completeSetup = (body: unknown): Promise<SetupCompleteResponse> =>
  callApi('POST', '/setup/complete', { body });

// --------------------------------------------------------------------------------------------- customers

export interface CustomerQuery {
  search?: string;
  isActive?: boolean;
  kind?: 'INDIVIDUAL' | 'BUSINESS';
  limit: number;
  offset: number;
}

/** Search terms travel in the query string of a GET to the loopback API (the server never logs query strings). */
export function listCustomers(token: string, q: CustomerQuery): Promise<CustomerListResponse> {
  const params = new URLSearchParams();
  if (q.search) params.set('search', q.search);
  if (q.isActive !== undefined) params.set('isActive', String(q.isActive));
  if (q.kind) params.set('kind', q.kind);
  params.set('limit', String(q.limit));
  params.set('offset', String(q.offset));
  return callApi('GET', `/customers?${params.toString()}`, { token });
}

export const getCustomer = (token: string, id: string): Promise<{ customer: CustomerView }> =>
  callApi('GET', `/customers/${encodeURIComponent(id)}`, { token });

export const createCustomer = (
  token: string,
  body: Record<string, unknown>,
): Promise<{ customer: CustomerView }> => callApi('POST', '/customers', { token, body });

export const updateCustomer = (
  token: string,
  id: string,
  body: Record<string, unknown>,
): Promise<{ customer: CustomerView }> =>
  callApi('PATCH', `/customers/${encodeURIComponent(id)}`, { token, body });

export const setCustomerActive = (
  token: string,
  id: string,
  active: boolean,
  expectedVersion: number,
): Promise<{ customer: CustomerView }> =>
  callApi('POST', `/customers/${encodeURIComponent(id)}/${active ? 'activate' : 'deactivate'}`, {
    token,
    body: { expectedVersion },
  });

// ---------------------------------------------------------------------------------------------- products

export interface ProductQuery {
  search?: string;
  isActive?: boolean;
  kind?: 'GOODS' | 'SERVICE';
  tracked?: boolean;
  limit: number;
  offset: number;
}

export function listProducts(token: string, q: ProductQuery): Promise<ProductListResponse> {
  const params = new URLSearchParams();
  if (q.search) params.set('search', q.search);
  if (q.isActive !== undefined) params.set('isActive', String(q.isActive));
  if (q.kind) params.set('kind', q.kind);
  if (q.tracked !== undefined) params.set('tracked', String(q.tracked));
  params.set('limit', String(q.limit));
  params.set('offset', String(q.offset));
  return callApi('GET', `/products?${params.toString()}`, { token });
}

export const getProduct = (token: string, id: string): Promise<{ product: ProductView }> =>
  callApi('GET', `/products/${encodeURIComponent(id)}`, { token });

export const createProduct = (
  token: string,
  body: Record<string, unknown>,
): Promise<{ product: ProductView }> => callApi('POST', '/products', { token, body });

export const updateProduct = (
  token: string,
  id: string,
  body: Record<string, unknown>,
): Promise<{ product: ProductView }> =>
  callApi('PATCH', `/products/${encodeURIComponent(id)}`, { token, body });

export const setProductActive = (
  token: string,
  id: string,
  active: boolean,
  expectedVersion: number,
): Promise<{ product: ProductView }> =>
  callApi('POST', `/products/${encodeURIComponent(id)}/${active ? 'activate' : 'deactivate'}`, {
    token,
    body: { expectedVersion },
  });

export const getProductReferences = (token: string): Promise<ProductReferencesResponse> =>
  callApi('GET', '/products/references', { token });

export function searchHsnSac(
  token: string,
  q: { kind: 'HSN' | 'SAC'; search?: string; limit?: number },
): Promise<HsnSacSearchResponse> {
  const params = new URLSearchParams({ kind: q.kind, limit: String(q.limit ?? 20) });
  if (q.search) params.set('search', q.search);
  return callApi('GET', `/products/references/hsn-sac?${params.toString()}`, { token });
}

// ---------------------------------------------------------------------------------------------- inventory

export interface StockQuery {
  search?: string;
  isActive?: boolean;
  productId?: string;
  limit: number;
  offset: number;
}

export function listStock(token: string, q: StockQuery): Promise<StockListResponse> {
  const params = new URLSearchParams();
  if (q.search) params.set('search', q.search);
  if (q.isActive !== undefined) params.set('isActive', String(q.isActive));
  if (q.productId) params.set('productId', q.productId);
  params.set('limit', String(q.limit));
  params.set('offset', String(q.offset));
  return callApi('GET', `/inventory/stock?${params.toString()}`, { token });
}

export function listStockMovements(
  token: string,
  q: { productId?: string; limit: number; offset: number },
): Promise<StockMovementListResponse> {
  const params = new URLSearchParams();
  if (q.productId) params.set('productId', q.productId);
  params.set('limit', String(q.limit));
  params.set('offset', String(q.offset));
  return callApi('GET', `/inventory/movements?${params.toString()}`, { token });
}

export type StockOperation = 'opening' | 'receive' | 'adjust';
const OPERATION_PATH: Record<StockOperation, string> = {
  opening: '/inventory/opening-stock',
  receive: '/inventory/receipts',
  adjust: '/inventory/adjustments',
};

export const postStockOperation = (
  token: string,
  operation: StockOperation,
  body: Record<string, unknown>,
): Promise<StockOperationResponse> => callApi('POST', OPERATION_PATH[operation], { token, body });

// ---------------------------------------------------------------------------------------------- tax configuration

export const getTaxConfiguration = (token: string): Promise<TaxConfigurationResponse> =>
  callApi('GET', '/tax/configuration', { token });

export const listTaxReviews = (
  token: string,
  q: { limit: number; offset: number },
): Promise<TaxReviewListResponse> =>
  callApi('GET', `/tax/configuration/reviews?limit=${q.limit}&offset=${q.offset}`, { token });

export const postTaxReview = (
  token: string,
  body: Record<string, unknown>,
): Promise<{ review: TaxReviewView }> =>
  callApi('POST', '/tax/configuration/reviews', { token, body });

export const postBillingMode = (token: string, mode: BillingMode): Promise<{ mode: BillingMode }> =>
  callApi('POST', '/tax/billing-mode', { token, body: { mode } });

export const putHsnRequirement = (
  token: string,
  body: Record<string, unknown>,
): Promise<{ hsnPolicy: HsnPolicyView }> => callApi('PUT', '/tax/hsn-requirement', { token, body });

export interface HsnQuery {
  search?: string;
  kind?: 'HSN' | 'SAC';
  isActive?: boolean;
  limit: number;
  offset: number;
}

export function listHsnEntries(token: string, q: HsnQuery): Promise<HsnSacListResponse> {
  const params = new URLSearchParams();
  if (q.search) params.set('search', q.search);
  if (q.kind) params.set('kind', q.kind);
  if (q.isActive !== undefined) params.set('isActive', String(q.isActive));
  params.set('limit', String(q.limit));
  params.set('offset', String(q.offset));
  return callApi('GET', `/tax/hsn-sac?${params.toString()}`, { token });
}

export const createHsnEntry = (
  token: string,
  body: Record<string, unknown>,
): Promise<{ entry: HsnSacView }> => callApi('POST', '/tax/hsn-sac', { token, body });

export const updateHsnEntry = (
  token: string,
  id: string,
  body: Record<string, unknown>,
): Promise<{ entry: HsnSacView }> =>
  callApi('PATCH', `/tax/hsn-sac/${encodeURIComponent(id)}`, { token, body });

export const reviewHsnEntry = (
  token: string,
  id: string,
  expectedVersion: number,
): Promise<{ entry: HsnSacView }> =>
  callApi('POST', `/tax/hsn-sac/${encodeURIComponent(id)}/review`, {
    token,
    body: { expectedVersion },
  });

// ---------------------------------------------------------------------------------------------- invoices

export interface InvoiceQuery {
  search?: string;
  isDemo?: boolean;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

export function listInvoices(token: string, q: InvoiceQuery): Promise<InvoiceListResponse> {
  const params = new URLSearchParams();
  if (q.search) params.set('search', q.search);
  if (q.isDemo !== undefined) params.set('isDemo', String(q.isDemo));
  if (q.from) params.set('from', q.from);
  if (q.to) params.set('to', q.to);
  params.set('limit', String(q.limit));
  params.set('offset', String(q.offset));
  return callApi('GET', `/invoices?${params.toString()}`, { token });
}

export const getInvoice = (token: string, id: string): Promise<{ invoice: InvoiceView }> =>
  callApi('GET', `/invoices/${encodeURIComponent(id)}`, { token });

/** Writes nothing: the server recalculates from its own facts. */
export const previewInvoice = (
  token: string,
  body: Record<string, unknown>,
): Promise<InvoicePreviewResponse> => callApi('POST', '/invoices/preview', { token, body });

export const postInvoice = (
  token: string,
  body: Record<string, unknown>,
): Promise<InvoicePostResponse> => callApi('POST', '/invoices', { token, body });

// ---------------------------------------------------------------------------------------------- payments and receivables

export interface PaymentQuery {
  search?: string;
  method?: string;
  isDemo?: boolean;
  from?: string;
  to?: string;
  invoiceId?: string;
  limit: number;
  offset: number;
}

export function listPayments(token: string, q: PaymentQuery): Promise<PaymentListResponse> {
  const params = new URLSearchParams();
  if (q.search) params.set('search', q.search);
  if (q.method) params.set('method', q.method);
  if (q.isDemo !== undefined) params.set('isDemo', String(q.isDemo));
  if (q.from) params.set('from', q.from);
  if (q.to) params.set('to', q.to);
  if (q.invoiceId) params.set('invoiceId', q.invoiceId);
  params.set('limit', String(q.limit));
  params.set('offset', String(q.offset));
  return callApi('GET', `/payments?${params.toString()}`, { token });
}

export const getPayment = (token: string, id: string): Promise<{ payment: PaymentView }> =>
  callApi('GET', `/payments/${encodeURIComponent(id)}`, { token });

export const recordPayment = (
  token: string,
  body: Record<string, unknown>,
): Promise<PaymentRecordResponse> => callApi('POST', '/payments', { token, body });

export function getReceivables(
  token: string,
  q: { isDemo: boolean; search?: string; limit: number; offset: number },
): Promise<ReceivablesResponse> {
  const params = new URLSearchParams({ isDemo: String(q.isDemo) });
  if (q.search) params.set('search', q.search);
  params.set('limit', String(q.limit));
  params.set('offset', String(q.offset));
  return callApi('GET', `/receivables?${params.toString()}`, { token });
}

export const getCustomerReceivable = (
  token: string,
  customerId: string,
  isDemo: boolean,
): Promise<CustomerReceivableResponse> =>
  callApi(
    'GET',
    `/receivables/customers/${encodeURIComponent(customerId)}?isDemo=${String(isDemo)}`,
    { token },
  );

// ---- Backup and recovery -------------------------------------------------------------------------------------------

export const getBackupStatus = (token: string): Promise<BackupStatusResponse> =>
  callApi('GET', '/backup/status', { token });

export const getBackupReadiness = (token: string): Promise<BackupReadinessResponse> =>
  callApi('GET', '/backup/readiness', { token });

export const listBackups = (
  token: string,
  q: { limit: number; offset: number },
): Promise<BackupHistoryResponse> =>
  callApi('GET', `/backup/history?limit=${String(q.limit)}&offset=${String(q.offset)}`, { token });

/** The passphrase travels only in this request body, over the loopback connection; it is never put in a URL. */
export const createBackup = (
  token: string,
  body: { passphrase: string; passphraseConfirm: string; verifyNow: boolean },
): Promise<BackupCreateResponse> => callApi('POST', '/backup', { token, body });

export const verifyBackup = (
  token: string,
  id: string,
  body: { passphrase: string },
): Promise<{ verification: BackupVerificationView }> =>
  callApi('POST', `/backup/${encodeURIComponent(id)}/verify`, { token, body });

export const putBackupRetention = (
  token: string,
  retentionKeep: number | null,
): Promise<{ retentionKeep: number | null }> =>
  callApi('PUT', '/backup/retention', { token, body: { retentionKeep } });

export const inspectRestore = (
  token: string,
  body: { sourceId: string; passphrase: string },
): Promise<RestoreInspectResponse> => callApi('POST', '/backup/restore/inspect', { token, body });

export const restoreBackup = (
  token: string,
  body: { sourceId: string; passphrase: string; confirmation: string },
): Promise<RestoreResultResponse> => callApi('POST', '/backup/restore', { token, body });
