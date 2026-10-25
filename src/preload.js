'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nakami', {
  state: () => ipcRenderer.invoke('state'),
  search: (q, opts) => ipcRenderer.invoke('search', q, opts),
  preview: (p, q, opts) => ipcRenderer.invoke('preview', p, q, opts),
  addFolder: () => ipcRenderer.invoke('add-folder'),
  removeFolder: (dir) => ipcRenderer.invoke('remove-folder', dir),
  rescan: () => ipcRenderer.invoke('rescan'),
  openFile: (p) => ipcRenderer.invoke('open-file', p),
  showInFolder: (p) => ipcRenderer.invoke('show-in-folder', p),
  copy: (t) => ipcRenderer.invoke('copy', t),
  onProgress: (fn) => ipcRenderer.on('progress', (_e, p) => fn(p)),
  onChanged: (fn) => ipcRenderer.on('index-changed', (_e, s) => fn(s)),
});
