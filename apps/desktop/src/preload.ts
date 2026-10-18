import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from '@commercebill/shared-types';

// Minimal bridge: argument-free methods only. The main process validates the sender of every call.
const bridge: DesktopBridge = {
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  getApiAccess: () => ipcRenderer.invoke('app:get-api-access'),
};

contextBridge.exposeInMainWorld('commercebill', bridge);
