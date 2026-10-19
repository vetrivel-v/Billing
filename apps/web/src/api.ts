import type {
  ApiAccess,
  ApiErrorBody,
  DatabaseHealthResponse,
  HealthResponse,
  LoginResponse,
  MeResponse,
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
  constructor(status: number, code?: string, problems: { field: string; rule: string }[] = []) {
    super(`API error ${status}${code ? ` ${code}` : ''}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.problems = problems;
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
  method: 'GET' | 'POST',
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
    throw new ApiError(res.status, err?.code, Array.isArray(err?.problems) ? err.problems : []);
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
