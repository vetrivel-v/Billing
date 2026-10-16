/**
 * Electron security policy helpers (spec section 38). Pure functions so they are unit-testable
 * without launching Electron.
 */

/** Origins that privileged windows may load. The dev server is allowed only when not packaged. */
export function isAllowedNavigation(url: string, devServerUrl?: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return true;
    if (devServerUrl) return u.origin === new URL(devServerUrl).origin;
    return false;
  } catch {
    return false;
  }
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
