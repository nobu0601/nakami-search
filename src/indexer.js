'use strict';
// Keeps the searchable index: which folders, and the text of every file in them.
// Saved to disk (gzip JSON) so the next start can search immediately.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const { extractText, ocrFile, extOf, isContentType } = require('./extract');
const { norm, searchDocs, previewDoc } = require('./search');

const STORE_VERSION = 1;
const DEFAULT_EXCLUDE_NAMES = ['node_modules', '$RECYCLE.BIN', 'System Volume Information', '__pycache__'];

/** "*.tmp" / "backup*" style pattern → RegExp (case-insensitive, whole name). */
function wildcard(pattern) {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${re}$`, 'i');
}

class Index extends EventEmitter {
  constructor(storePath) {
    super();
    this.storePath = storePath;
    this.folders = [];
    this.files = new Map();
    this._queue = Promise.resolve();
    this._saveTimer = null;
    this.ocrEnabled = true;
    this.ocrQueue = [];
    this._ocrRunning = false;
    this.setExclusions({ names: DEFAULT_EXCLUDE_NAMES, exts: [] });
  }

  // ---------- exclusions ----------
  setExclusions({ names = [], exts = [] }) {
    this.excludeNames = names.map((n) => n.trim()).filter(Boolean);
    this._nameRes = this.excludeNames.map(wildcard);
    this.excludeExts = new Set(exts.map((e) => e.trim().replace(/^\*?\./, '').toLowerCase()).filter(Boolean));
  }

  /** Hidden files, Office lock files (~$) and the user's excluded names. */
  isExcludedName(name) {
    return name.startsWith('.') || name.startsWith('~$') || this._nameRes.some((re) => re.test(name));
  }

  /** Checks the file name, its extension, and every folder between the registered folder and the file. */
  isExcludedFile(p) {
    const name = path.basename(p);
    if (this.excludeExts.has(extOf(name))) return true;
    const root = this.folders.find((d) => p.startsWith(d.endsWith(path.sep) ? d : d + path.sep));
    const rel = root ? path.relative(root, p) : name;
    return rel.split(path.sep).some((seg) => this.isExcludedName(seg));
  }

  /** Run jobs one at a time so two scans never index the same file at once. */
  enqueue(job) {
    const run = this._queue.then(job);
    this._queue = run.catch(() => {});
    return run;
  }

  // ---------- persistence ----------
  load() {
    try {
      const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(this.storePath)).toString('utf8'));
      if (data.version !== STORE_VERSION) return false;
      this.folders = data.folders || [];
      for (const f of data.files || []) {
        const { text, ...rest } = f;
        this.files.set(f.path, { ...rest, lines: text == null ? null : text.split('\n') });
      }
      return true;
    } catch { return false; }
  }

  saveNow() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    const files = [...this.files.values()].map(({ lines, ...rest }) => ({ ...rest, text: lines ? lines.join('\n') : null }));
    const buf = zlib.gzipSync(JSON.stringify({ version: STORE_VERSION, folders: this.folders, files }));
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    const tmp = this.storePath + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, this.storePath);
  }

  scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => { try { this.saveNow(); } catch (e) { this.emit('error', e); } }, 3000);
  }

  // ---------- indexing ----------
  async walk(dir, out) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      if (this.isExcludedName(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await this.walk(full, out);
      else if (e.isFile() && !this.excludeExts.has(extOf(e.name))) out.push(full);
    }
    return out;
  }

  /** Read one file into the index. Unchanged files (same size and time) are skipped. */
  async indexFile(p, st) {
    if (this.isExcludedFile(p)) { this.removeFile(p); return false; }
    try { st = st || await fsp.stat(p); } catch { this.removeFile(p); return false; }
    const prev = this.files.get(p);
    if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) return false;
    const name = path.basename(p);
    const ext = extOf(name);
    const doc = { path: p, name, ext: ext || '(なし)', size: st.size, mtimeMs: st.mtimeMs, lines: null, error: null };
    if (isContentType(ext)) {
      try {
        const r = await extractText(p, ext, st.size);
        doc.lines = norm(r.text).split(/\r\n|\r|\n/);
        if (r.needsOcr) { doc.ocrPending = true; doc.scannedPages = r.scannedPages || []; }
      } catch (e) { doc.error = e.message || '読み取れません'; }
    }
    this.files.set(p, doc);
    if (doc.ocrPending) this.queueOcr(p);
    this.scheduleSave();
    return true;
  }

  removeFile(p) {
    if (this.files.delete(p)) { this.scheduleSave(); return true; }
    return false;
  }

  removeUnder(dir) {
    const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
    for (const p of [...this.files.keys()]) if (p.startsWith(prefix)) this.files.delete(p);
    this.scheduleSave();
  }

  /** Bring a folder's entries in line with the disk: add new, update changed, drop deleted or excluded. */
  syncFolder(dir) {
    return this.enqueue(async () => {
      this.emit('progress', { phase: 'listing', dir, done: 0, total: 0 });
      const found = await this.walk(dir, []);
      const foundSet = new Set(found);
      const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
      for (const p of [...this.files.keys()]) {
        if (p.startsWith(prefix) && !foundSet.has(p)) this.files.delete(p);
      }
      let done = 0, changed = 0;
      for (const p of found) {
        if (await this.indexFile(p)) changed++;
        done++;
        if (done % 25 === 0 || done === found.length) {
          this.emit('progress', { phase: 'indexing', dir, done, total: found.length, current: p });
          await new Promise((r) => setImmediate(r));
        }
      }
      this.scheduleSave();
      this.emit('progress', { phase: 'done', dir, done, total: found.length, changed });
      return { total: found.length, changed };
    });
  }

  addFolder(dir) {
    dir = path.resolve(dir);
    if (!this.folders.includes(dir)) this.folders.push(dir);
    this.scheduleSave();
    return this.syncFolder(dir);
  }

  removeFolder(dir) {
    return this.enqueue(async () => {
      this.folders = this.folders.filter((f) => f !== dir);
      const inFolders = (p) => this.folders.some((d) => p.startsWith(d.endsWith(path.sep) ? d : d + path.sep));
      for (const p of [...this.files.keys()]) if (!inFolders(p)) this.files.delete(p);
      this.ocrQueue = this.ocrQueue.filter((p) => this.files.has(p));
      this.scheduleSave();
    });
  }

  // ---------- text recognition (slow, runs in the background) ----------
  queueOcr(p) {
    if (!this.ocrEnabled || this.ocrQueue.includes(p)) return;
    this.ocrQueue.push(p);
    this.emit('ocr', { pending: this.ocrQueue.length });
    this._runOcr();
  }

  setOcrEnabled(on) {
    this.ocrEnabled = on;
    if (!on) { this.ocrQueue = []; this.emit('ocr', { pending: 0 }); return; }
    for (const d of this.files.values()) if (d.ocrPending) this.queueOcr(d.path);
  }

  async _runOcr() {
    if (this._ocrRunning) return;
    this._ocrRunning = true;
    try {
      while (this.ocrQueue.length && this.ocrEnabled) {
        const p = this.ocrQueue[0];
        const doc = this.files.get(p);
        if (doc && doc.ocrPending) {
          this.emit('ocr', { pending: this.ocrQueue.length, current: p });
          let text = null, error = null;
          try { text = await ocrFile(p, doc.ext, doc.scannedPages); } catch (e) { error = e.message || '文字認識に失敗しました'; }
          // The file may have been changed or removed while we were reading it.
          if (this.files.get(p) === doc) {
            if (text != null) { doc.lines = norm(text).split(/\r\n|\r|\n/); doc.ocr = true; } else doc.error = error;
            doc.ocrPending = false;
            delete doc.scannedPages;
            this.scheduleSave();
            this.emit('ocr-done', { path: p });
          }
        }
        this.ocrQueue.shift();
      }
    } finally {
      this._ocrRunning = false;
      this.emit('ocr', { pending: this.ocrQueue.length });
    }
  }

  /** Resolves when the background recognition queue is empty (used by tests). */
  async ocrIdle() {
    while (this._ocrRunning || this.ocrQueue.length) await new Promise((r) => setTimeout(r, 50));
  }

  // ---------- queries ----------
  search(query, opts) { return searchDocs(this.files.values(), query, opts); }

  preview(p, query, opts) {
    const d = this.files.get(p);
    return d ? previewDoc(d, query, opts) : null;
  }

  stats() {
    let size = 0, unreadable = 0, withText = 0, ocrDone = 0, ocrPending = 0;
    const types = {};
    for (const d of this.files.values()) {
      size += d.size;
      if (d.error) unreadable++;
      if (d.lines) withText++;
      if (d.ocr) ocrDone++;
      if (d.ocrPending) ocrPending++;
      types[d.ext] = (types[d.ext] || 0) + 1;
    }
    return { folders: this.folders, files: this.files.size, withText, unreadable, size, types, ocrDone, ocrPending, ocrQueued: this.ocrQueue.length };
  }
}

module.exports = { Index, DEFAULT_EXCLUDE_NAMES, wildcard };
