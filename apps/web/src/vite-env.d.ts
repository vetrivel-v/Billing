/// <reference types="vite/client" />
import type { DesktopBridge } from '@commercebill/shared-types';

declare global {
  interface Window {
    /** Present only inside the Electron shell (preload bridge). */
    commercebill?: DesktopBridge;
  }
}
