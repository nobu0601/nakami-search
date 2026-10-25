'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => ipcRenderer.on(channel, (_e, v) => fn(v));

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
  getSettings: () => ipcRenderer.invoke('settings-get'),
  setSettings: (patch) => ipcRenderer.invoke('settings-set', patch),
  addHistory: (q) => ipcRenderer.invoke('history-add', q),
  removeHistory: (q) => ipcRenderer.invoke('history-remove', q),
  clearHistory: () => ipcRenderer.invoke('history-clear'),
  toggleFavorite: (q) => ipcRenderer.invoke('favorite-toggle', q),
  shortcutStatus: () => ipcRenderer.invoke('shortcut-status'),
  updateState: () => ipcRenderer.invoke('update-state'),
  checkUpdate: () => ipcRenderer.invoke('update-check'),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  onProgress: on('progress'),
  onChanged: on('index-changed'),
  onOcr: on('ocr'),
  onUpdate: on('update'),
  onFocusSearch: on('focus-search'),
  onShortcutStatus: on('shortcut-status'),
});
