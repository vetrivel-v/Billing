import { describe, expect, it } from 'vitest';
import {
  APP_ORIGIN,
  WEB_PREFERENCES,
  isAllowedExternalUrl,
  isAllowedNavigation,
  isTrustedSender,
  rendererOrigin,
} from './security.js';

describe('Electron security policy', () => {
  it('enforces isolation, sandbox and no node integration', () => {
    expect(WEB_PREFERENCES.contextIsolation).toBe(true);
    expect(WEB_PREFERENCES.sandbox).toBe(true);
    expect(WEB_PREFERENCES.nodeIntegration).toBe(false);
    expect(WEB_PREFERENCES.webviewTag).toBe(false);
  });

  it('allows only the app:// origin and the dev server for navigation', () => {
    expect(isAllowedNavigation('app://commercebill/index.html')).toBe(true);
    expect(isAllowedNavigation('app://evil/index.html')).toBe(false);
    expect(isAllowedNavigation('file:///app/index.html')).toBe(false);
    expect(isAllowedNavigation('https://evil.example')).toBe(false);
    expect(isAllowedNavigation('http://127.0.0.1:5173/x', 'http://127.0.0.1:5173')).toBe(true);
    expect(isAllowedNavigation('http://127.0.0.1:9999/', 'http://127.0.0.1:5173')).toBe(false);
    expect(isAllowedNavigation('http://127.0.0.1:5173/x')).toBe(false); // dev server only when configured
    expect(isAllowedNavigation('not a url')).toBe(false);
  });

  it('opens external links only for allow-listed https origins', () => {
    expect(isAllowedExternalUrl('https://wa.me/919999900000?text=hi')).toBe(true);
    expect(isAllowedExternalUrl('http://wa.me/1')).toBe(false);
    expect(isAllowedExternalUrl('https://evil.example')).toBe(false);
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedExternalUrl('file:///c:/windows/system32/calc.exe')).toBe(false);
  });

  it('trusts IPC only from the application pages themselves', () => {
    expect(isTrustedSender('app://commercebill/index.html')).toBe(true);
    expect(isTrustedSender(undefined)).toBe(false);
    expect(isTrustedSender('')).toBe(false);
    expect(isTrustedSender('https://evil.example/')).toBe(false);
    expect(isTrustedSender('app://commercebill.evil.example/')).toBe(false);
    expect(isTrustedSender('file:///c:/x.html')).toBe(false);
    expect(isTrustedSender('http://127.0.0.1:5173/', 'http://127.0.0.1:5173')).toBe(true);
    expect(isTrustedSender('http://127.0.0.1:5173/')).toBe(false);
  });

  it('reports the renderer origin the API must allow', () => {
    expect(rendererOrigin()).toBe(APP_ORIGIN);
    expect(rendererOrigin('http://127.0.0.1:5173/some/path')).toBe('http://127.0.0.1:5173');
  });
});
