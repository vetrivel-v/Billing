/**
 * Electron security policy helpers (spec section 38). Pure functions so they are unit-testable
 * without launching Electron.
 */

/** Custom scheme that serves the built renderer. A real (non-null) origin lets the API enforce CORS. */
export const APP_SCHEME = 'app';
export const APP_HOST = 'commercebill';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/** `new URL('app://x').origin` is the opaque string "null" for custom schemes, so compare parts. */
function isAppUrl(u: URL): boolean {
  return u.protocol === `${APP_SCHEME}:` && u.host === APP_HOST;
}

function isDevServerUrl(u: URL, devServerUrl?: string): boolean {
  return Boolean(devServerUrl) && u.origin === new URL(devServerUrl as string).origin;
}

/** Origins that privileged windows may load. The dev server is allowed only when not packaged. */
export function isAllowedNavigation(url: string, devServerUrl?: string): boolean {
  try {
    const u = new URL(url);
    return isAppUrl(u) || isDevServerUrl(u, devServerUrl);
  } catch {
    return false;
  }
}

/**
 * Only the application's own pages may call privileged IPC channels (Electron security guidance:
 * validate the sender of every IPC message). Unknown or missing sender URLs are rejected.
 */
export function isTrustedSender(senderUrl: string | undefined, devServerUrl?: string): boolean {
  if (!senderUrl) return false;
  return isAllowedNavigation(senderUrl, devServerUrl);
}

/** The browser origin the API must allow through CORS for this run. */
export function rendererOrigin(devServerUrl?: string): string {
  return devServerUrl ? new URL(devServerUrl).origin : APP_ORIGIN;
}

const EXTERNAL_LINK_ALLOWLIST = new Set<string>(['https://wa.me']);

/** External links open in the system browser only if their origin is on the allow-list. */
export function isAllowedExternalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && EXTERNAL_LINK_ALLOWLIST.has(u.origin);
  } catch {
    return false;
  }
}

export const WEB_PREFERENCES = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
} as const;
