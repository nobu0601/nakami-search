'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, Tray, globalShortcut, nativeImage } = require('electron');
const path = require('path');
const chokidar = require('chokidar');
const { Index } = require('./indexer');
const { Settings } = require('./settings');
const ocr = require('./ocr');

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.setAppUserModelId('local.nakami-search');

const userData = app.getPath('userData');
const settings = new Settings(path.join(userData, 'settings.json'));
const index = new Index(path.join(userData, 'index.json.gz'));
ocr.setWorkDir(userData);

let win = null;
let tray = null;
let watcher = null;
let quitting = false;
let trayHintShown = false;
const startHidden = process.argv.includes('--hidden');

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
index.on('ocr', (o) => send('ocr', o));
index.on('ocr-done', notifyChanged);

// ---------- settings that affect the index ----------
function applySettings(prev) {
  const s = settings.data;
  index.setExclusions({ names: s.excludeNames, exts: s.excludeExts });
  if (!prev || prev.ocr !== s.ocr) index.setOcrEnabled(s.ocr);
  if (app.isPackaged && (!prev || prev.openAtLogin !== s.openAtLogin)) {
    app.setLoginItemSettings({ openAtLogin: s.openAtLogin, args: ['--hidden'] });
  }
  if (!prev || prev.shortcut !== s.shortcut) registerShortcut();
  const exclusionsChanged = prev && (String(prev.excludeNames) !== String(s.excludeNames) || String(prev.excludeExts) !== String(s.excludeExts));
  if (exclusionsChanged) {
    restartWatcher();
    for (const dir of index.folders) index.syncFolder(dir);
  }
}

// ---------- watching folders for changes ----------
function restartWatcher() {
  if (watcher) { watcher.close(); watcher = null; }
  if (!index.folders.length) return;
  const roots = new Set(index.folders);
  watcher = chokidar.watch(index.folders, {
    ignoreInitial: true,
    ignorePermissionErrors: true,
    awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 300 },
    ignored: (p) => !roots.has(p) && index.isExcludedName(path.basename(p)),
  });
  const update = (p) => index.enqueue(() => index.indexFile(p)).then((changed) => changed && notifyChanged());
  watcher
    .on('add', update)
    .on('change', update)
    .on('unlink', (p) => index.enqueue(async () => index.removeFile(p)).then(notifyChanged))
    .on('unlinkDir', (dir) => index.enqueue(async () => index.removeUnder(dir)).then(notifyChanged))
    .on('error', () => { /* folders that disappear are handled on the next scan */ });
}

// ---------- window, tray, shortcut ----------
function showWindow(focusSearch = true) {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (focusSearch) send('focus-search');
}

function toggleWindow() {
  if (win && win.isVisible() && win.isFocused()) win.hide();
  else showWindow();
}

function registerShortcut() {
  globalShortcut.unregisterAll();
  let ok = false;
  try { ok = globalShortcut.register(settings.data.shortcut, toggleWindow); } catch { ok = false; }
  send('shortcut-status', { shortcut: settings.data.shortcut, ok });
  return ok;
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(img);
  tray.setToolTip('なかみ検索');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '開く', click: () => showWindow() },
    { label: 'すべてのフォルダを読み直す', click: () => index.folders.forEach((d) => index.syncFolder(d)) },
    { type: 'separator' },
    { label: '終了', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => showWindow());
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 820, minWidth: 420, minHeight: 400,
    title: 'なかみ検索',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: '#f6f7f9',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    if (quitting || !settings.data.closeToTray) return;
    e.preventDefault();
    win.hide();
    if (!trayHintShown && tray && process.platform === 'win32') {
      trayHintShown = true;
      tray.displayBalloon({ title: 'なかみ検索', content: `タスクトレイで動いています。${settings.data.shortcut.replace('Control', 'Ctrl')} でいつでも呼び出せます。`, iconType: 'info' });
    }
  });
}

// ---------- auto update ----------
let updateState = { status: app.isPackaged ? 'idle' : 'dev' };
let autoUpdater = null;
function setUpdate(s) { updateState = { ...updateState, ...s }; send('update', updateState); }
function setupUpdater() {
  if (!app.isPackaged) return;
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => setUpdate({ status: 'checking' }));
  autoUpdater.on('update-available', (i) => setUpdate({ status: 'downloading', version: i.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => setUpdate({ status: 'latest', checkedAt: Date.now() }));
  autoUpdater.on('download-progress', (p) => setUpdate({ status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => setUpdate({ status: 'ready', version: i.version }));
  autoUpdater.on('error', (e) => setUpdate({ status: 'error', message: String(e && e.message || e).split('\n')[0] }));
  const check = () => autoUpdater.checkForUpdates().catch(() => { /* reported via the error event */ });
  setTimeout(check, 10 * 1000);
  setInterval(check, 6 * 60 * 60 * 1000);
}

// ---------- IPC ----------
ipcMain.handle('state', () => ({ ...index.stats(), version: app.getVersion() }));
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

ipcMain.handle('settings-get', () => settings.get());
ipcMain.handle('settings-set', (_e, patch) => {
  const prev = { ...settings.data };
  const next = settings.update(patch);
  applySettings(prev);
  return next;
});
ipcMain.handle('history-add', (_e, q) => settings.addHistory(q));
ipcMain.handle('history-remove', (_e, q) => settings.removeHistory(q));
ipcMain.handle('history-clear', () => settings.clearHistory());
ipcMain.handle('favorite-toggle', (_e, q) => settings.toggleFavorite(q));
ipcMain.handle('shortcut-status', () => ({ shortcut: settings.data.shortcut, ok: globalShortcut.isRegistered(settings.data.shortcut) }));

ipcMain.handle('update-state', () => updateState);
ipcMain.handle('update-check', () => { if (autoUpdater) autoUpdater.checkForUpdates().catch(() => {}); return updateState; });
ipcMain.handle('update-install', () => { if (autoUpdater && updateState.status === 'ready') { quitting = true; autoUpdater.quitAndInstall(); } });

// ---------- lifecycle ----------
app.on('second-instance', () => showWindow());

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  index.load();
  applySettings(null);
  createTray();
  createWindow();
  setupUpdater();
  // Catch up on whatever changed while the app was closed, then keep watching.
  win.webContents.once('did-finish-load', () => {
    for (const dir of index.folders) index.syncFolder(dir);
    restartWatcher();
  });
});

app.on('window-all-closed', () => { if (!settings.data.closeToTray) app.quit(); });
app.on('before-quit', () => {
  quitting = true;
  try { index.saveNow(); } catch { /* keep quitting even if saving fails */ }
  if (watcher) watcher.close();
  globalShortcut.unregisterAll();
  ocr.shutdown();
});
