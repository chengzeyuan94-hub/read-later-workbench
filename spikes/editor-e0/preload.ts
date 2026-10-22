import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('e0', {
  list: () => ipcRenderer.invoke('e0:list'), load: (id: string) => ipcRenderer.invoke('e0:load', id),
  save: (request: unknown) => ipcRenderer.invoke('e0:save', request), saveAtomic: (requests: unknown) => ipcRenderer.invoke('e0:saveAtomic', requests),
  resolveReference: (ref: unknown) => ipcRenderer.invoke('e0:resolveReference', ref), poll: () => ipcRenderer.invoke('e0:poll'),
  setFault: (fault: unknown) => ipcRenderer.invoke('e0:setFault', fault), exportXmind: (id: string) => ipcRenderer.invoke('e0:exportXmind', id),
  assetUrl: (id: string, version: string) => `e0-asset://local/${encodeURIComponent(id)}?version=${encodeURIComponent(version)}`,
  requestClose: (action?: string) => ipcRenderer.invoke('e0:requestClose', action),
  onCloseRequest: (callback: () => void) => { const listener = () => callback(); ipcRenderer.on('e0:close-request', listener); return () => ipcRenderer.removeListener('e0:close-request', listener); },
});
