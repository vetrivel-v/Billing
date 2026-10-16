import type { DatabaseHealthResponse, HealthResponse } from '@commercebill/shared-types';

const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:4310';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`);
  // /health/db answers 503 with a valid JSON body when the database is down.
  if (!res.ok && res.status !== 503) throw new Error(`Request failed (${res.status})`);
  return (await res.json()) as T;
}

export const fetchHealth = (): Promise<HealthResponse> => getJson('/health');
export const fetchDbHealth = (): Promise<DatabaseHealthResponse> => getJson('/health/db');
