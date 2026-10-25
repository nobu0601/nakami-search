'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu } = require('electron');
const path = require('path');
const chokidar = require('chokidar');
const { Index, isIgnored } = require('./indexer');

if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null;
let watcher = null;
const index = new Index(path.join(app.getPath('userData'), 'index.json.gz'));

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

let changedTimer = null;
function notifyChanged() {
  clearTimeout(changedTimer);
  changedTimer = setTimeout(() => send('index-changed', index.stats()), 400);
}

index.on('progress', (p) => { send('progress', p); if (p.phase === 'done') notifyChanged(); });
index.on('error', (e) => send('progress', { phase: 'error', message: e.message }));

// ---------- watching folders for changes ----------
function restartWatcher() {
  if (watcher) { watcher.close(); watcher = null; }
  if (!index.folders.length) return;
  const roots = new Set(index.folders);
  watcher = chokidar.watch(index.folders, {
    ignoreInitial: true,
    ignorePermissionErrors: true,
    awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 300 },
    ignored: (p) => !roots.has(p) && isIgnored(path.basename(p)),
  });
  const update = (p) => index.enqueue(() => index.indexFile(p)).then((changed) => changed && notifyChanged());
  watcher
    .on('add', update)
    .on('change', update)
    .on('unlink', (p) => index.enqueue(async () => index.removeFile(p)).then(notifyChanged))
    .on('unlinkDir', (dir) => index.enqueue(async () => {
      for (const p of [...index.files.keys()]) if (p.startsWith(dir + path.sep)) index.files.delete(p);
      index.scheduleSave();
    }).then(notifyChanged))
    .on('error', () => { /* folders that disappear are handled on the next scan */ });
}

// ---------- IPC ----------
ipcMain.handle('state', () => index.stats());
ipcMain.handle('search', (_e, query, opts) => index.search(query, opts));
ipcMain.handle('preview', (_e, p, query, opts) => index.preview(p, query, opts));

ipcMain.handle('add-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: '検索するフォルダを選ぶ', properties: ['openDirectory', 'multiSelections'] });
  if (r.canceled) return index.stats();
  for (const dir of r.filePaths) index.addFolder(dir);
  restartWatcher();
  return index.stats();
});
ipcMain.handle('remove-folder', async (_e, dir) => {
  await index.removeFolder(dir);
  restartWatcher();
  return index.stats();
});
ipcMain.handle('rescan', async () => {
  for (const dir of index.folders) index.syncFolder(dir);
  return index.stats();
});

// Only act on paths that are in the index, never on arbitrary paths from the page.
const known = (p) => typeof p === 'string' && index.files.has(p);
ipcMain.handle('open-file', async (_e, p) => (known(p) ? shell.openPath(p) : 'not indexed'));
ipcMain.handle('show-in-folder', (_e, p) => { if (known(p)) shell.showItemInFolder(p); });
ipcMain.handle('copy', (_e, text) => { clipboard.writeText(String(text)); });

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 800, minWidth: 420, minHeight: 400,
    title: 'なかみ検索',
    backgroundColor: '#f6f7f9',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  index.load();
  createWindow();
  // Catch up on whatever changed while the app was closed, then keep watching.
  win.webContents.once('did-finish-load', () => {
    for (const dir of index.folders) index.syncFolder(dir);
    restartWatcher();
  });
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  try { index.saveNow(); } catch { /* keep quitting even if saving fails */ }
  if (watcher) watcher.close();
});
