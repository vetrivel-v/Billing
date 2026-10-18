import type { ApiAccess, DatabaseHealthResponse, HealthResponse } from '@commercebill/shared-types';

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
