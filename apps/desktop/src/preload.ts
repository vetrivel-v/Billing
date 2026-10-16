import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from '@commercebill/shared-types';

const bridge: DesktopBridge = {
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
};

contextBridge.exposeInMainWorld('commercebill', bridge);
