'use strict';
// User settings, search history and favourites, stored as JSON next to the index.
const fs = require('fs');
const path = require('path');
const { DEFAULT_EXCLUDE_NAMES } = require('./indexer');

const HISTORY_MAX = 30;
const SHORTCUTS = ['Control+Shift+Space', 'Control+Alt+F', 'Alt+Space', 'Control+Shift+F'];

const DEFAULTS = {
  history: [],
  favorites: [],
  excludeNames: DEFAULT_EXCLUDE_NAMES,
  excludeExts: [],
  ocr: true,
  shortcut: SHORTCUTS[0],
  closeToTray: true,
  openAtLogin: false,
};

class Settings {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULTS };
    try { Object.assign(this.data, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* first run */ }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get() { return { ...this.data, shortcuts: SHORTCUTS }; }

  /** Only known keys with the right type are accepted from the screen. */
  update(patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in DEFAULTS) || k === 'history' || k === 'favorites') continue;
      if (Array.isArray(DEFAULTS[k])) { if (Array.isArray(v)) this.data[k] = v.map(String).map((s) => s.trim()).filter(Boolean); }
      else if (k === 'shortcut') { if (SHORTCUTS.includes(v)) this.data[k] = v; }
      else if (typeof v === typeof DEFAULTS[k]) this.data[k] = v;
    }
    this.save();
    return this.get();
  }

  addHistory(q) {
    q = String(q || '').trim();
    if (!q) return this.get();
    this.data.history = [q, ...this.data.history.filter((h) => h !== q)].slice(0, HISTORY_MAX);
    this.save();
    return this.get();
  }

  removeHistory(q) { this.data.history = this.data.history.filter((h) => h !== q); this.save(); return this.get(); }
  clearHistory() { this.data.history = []; this.save(); return this.get(); }

  toggleFavorite(q) {
    q = String(q || '').trim();
    if (!q) return this.get();
    const has = this.data.favorites.includes(q);
    this.data.favorites = has ? this.data.favorites.filter((f) => f !== q) : [...this.data.favorites, q];
    this.save();
    return this.get();
  }
}

module.exports = { Settings, SHORTCUTS };
