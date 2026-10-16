import { describe, expect, it } from 'vitest';
import { WEB_PREFERENCES, isAllowedExternalUrl, isAllowedNavigation } from './security.js';

describe('Electron security policy', () => {
  it('enforces isolation, sandbox and no node integration', () => {
    expect(WEB_PREFERENCES.contextIsolation).toBe(true);
    expect(WEB_PREFERENCES.sandbox).toBe(true);
    expect(WEB_PREFERENCES.nodeIntegration).toBe(false);
    expect(WEB_PREFERENCES.webviewTag).toBe(false);
  });

  it('allows only file:// and the dev server for navigation', () => {
    expect(isAllowedNavigation('file:///app/index.html')).toBe(true);
    expect(isAllowedNavigation('https://evil.example')).toBe(false);
    expect(isAllowedNavigation('http://127.0.0.1:5173/x', 'http://127.0.0.1:5173')).toBe(true);
    expect(isAllowedNavigation('http://127.0.0.1:9999/', 'http://127.0.0.1:5173')).toBe(false);
    expect(isAllowedNavigation('not a url')).toBe(false);
  });

  it('opens external links only for allow-listed https origins', () => {
    expect(isAllowedExternalUrl('https://wa.me/919999900000?text=hi')).toBe(true);
    expect(isAllowedExternalUrl('http://wa.me/1')).toBe(false);
    expect(isAllowedExternalUrl('https://evil.example')).toBe(false);
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedExternalUrl('file:///c:/windows/system32/calc.exe')).toBe(false);
  });
});
