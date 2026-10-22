import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from '@commercebill/shared-types';

// Minimal bridge. The two backup methods take no argument: the main process opens the native chooser and tells the renderer only a display name.
// The two document methods take an already posted invoice snapshot; the main process validates every call's
// sender and payload and decides any destination through the operating system's own dialogs. No path, file-system, shell or
// navigation capability is exposed. (Channel names are repeated here because the preload is sandboxed and cannot import them.)
const bridge: DesktopBridge = {
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  getApiAccess: () => ipcRenderer.invoke('app:get-api-access'),
  saveInvoicePdf: (invoice) => ipcRenderer.invoke('document:save-invoice-pdf', invoice),
  printInvoice: (invoice) => ipcRenderer.invoke('document:print-invoice', invoice),
  chooseBackupDestination: () => ipcRenderer.invoke('backup:choose-destination'),
  chooseRestoreFile: () => ipcRenderer.invoke('backup:choose-restore-file'),
  getDiagnostics: () => ipcRenderer.invoke('app:get-diagnostics'),
  exportDiagnostics: () => ipcRenderer.invoke('app:export-diagnostics'),
  openLogFolder: () => ipcRenderer.invoke('app:open-log-folder'),
  showSafetyPassphrase: () => ipcRenderer.invoke('app:show-safety-passphrase'),
};

contextBridge.exposeInMainWorld('commercebill', bridge);
