import { existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { APP_HOST, APP_SCHEME } from './security.js';

/**
 * Maps an `app://commercebill/...` request URL to a file inside `webRoot`, or returns null.
 * Rejects other hosts/schemes, path traversal (including encoded and backslash forms) and anything
 * outside the web root. Unknown paths without an extension fall back to index.html (SPA routing).
 */
export function resolveAppRequest(requestUrl: string, webRoot: string): string | null {
  let u: URL;
  try {
    u = new URL(requestUrl);
  } catch {
    return null;
  }
  if (u.protocol !== `${APP_SCHEME}:` || u.host !== APP_HOST) return null;

  let pathname: string;
  try {
    pathname = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0') || pathname.includes('\\')) return null;

  const root = resolve(webRoot);
  const relative = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^[/\\]+/, '');
  const candidate = resolve(join(root, relative));
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;

  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  if (extname(candidate) === '') {
    const index = join(root, 'index.html');
    return existsSync(index) ? index : null;
  }
  return null;
}
