'use strict';
// Keeps the searchable index: which folders, and the text of every file in them.
// Saved to disk (gzip JSON) so the next start can search immediately.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const { extractText, extOf, isContentType } = require('./extract');
const { norm, searchDocs, previewDoc } = require('./search');

const STORE_VERSION = 1;
const IGNORE_DIRS = new Set(['node_modules', '$RECYCLE.BIN', 'System Volume Information', '__pycache__']);

function isIgnored(name) {
  return name.startsWith('.') || name.startsWith('~$') || IGNORE_DIRS.has(name);
}

class Index extends EventEmitter {
  constructor(storePath) {
    super();
    this.storePath = storePath;
    this.folders = [];
    this.files = new Map();
    this._queue = Promise.resolve();
    this._saveTimer = null;
  }

  /** Run jobs one at a time so two scans never index the same file at once. */
  enqueue(job) {
    const run = this._queue.then(job);
    this._queue = run.catch(() => {});
    return run;
  }

  load() {
    try {
      const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(this.storePath)).toString('utf8'));
      if (data.version !== STORE_VERSION) return false;
      this.folders = data.folders || [];
      for (const f of data.files || []) {
        this.files.set(f.path, { ...f, lines: f.text == null ? null : f.text.split('\n'), text: undefined });
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

  inFolders(p) {
    return this.folders.some((dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep));
  }

  async walk(dir, out) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      if (isIgnored(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await this.walk(full, out);
      else if (e.isFile()) out.push(full);
    }
    return out;
  }

  /** Read one file into the index. Unchanged files (same size and time) are skipped. */
  async indexFile(p, st) {
    try { st = st || await fsp.stat(p); } catch { this.removeFile(p); return false; }
    const prev = this.files.get(p);
    if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) return false;
    const name = path.basename(p);
    const ext = extOf(name);
    const doc = { path: p, name, ext: ext || '(なし)', size: st.size, mtimeMs: st.mtimeMs, lines: null, error: null };
    if (isContentType(ext)) {
      try { doc.lines = norm(await extractText(p, ext, st.size)).split(/\r\n|\r|\n/); }
      catch (e) { doc.error = e.message || '読み取れません'; }
    }
    this.files.set(p, doc);
    this.scheduleSave();
    return true;
  }

  removeFile(p) {
    if (this.files.delete(p)) { this.scheduleSave(); return true; }
    return false;
  }

  /** Bring a folder's entries in line with the disk: add new, update changed, drop deleted. */
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
      for (const p of [...this.files.keys()]) if (!this.inFolders(p)) this.files.delete(p);
      this.scheduleSave();
    });
  }

  search(query, opts) { return searchDocs(this.files.values(), query, opts); }

  preview(p, query, opts) {
    const d = this.files.get(p);
    return d ? previewDoc(d, query, opts) : null;
  }

  stats() {
    let size = 0, unreadable = 0, withText = 0;
    const types = {};
    for (const d of this.files.values()) {
      size += d.size;
      if (d.error) unreadable++;
      if (d.lines) withText++;
      types[d.ext] = (types[d.ext] || 0) + 1;
    }
    return { folders: this.folders, files: this.files.size, withText, unreadable, size, types };
  }
}

module.exports = { Index, isIgnored };
