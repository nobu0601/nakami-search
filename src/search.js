'use strict';
// Query parsing and matching. Pure functions so they can be unit-tested.

const norm = (s) => s.normalize('NFKC');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `見積 "請求 書" -下書き` → terms ["見積","請求 書"], excludes ["下書き"] */
function parseQuery(q) {
  const terms = [], excludes = [];
  const re = /(-?)"([^"]+)"|(-?)(\S+)/g;
  let m;
  while ((m = re.exec(norm(q || '')))) {
    const neg = m[1] || m[3];
    const t = m[2] ?? m[4];
    if (!t || t === '-') continue;
    (neg ? excludes : terms).push(t);
  }
  return { terms, excludes };
}

function makeMatchers(list, opts) {
  return list.map((t) => new RegExp(opts.regex ? t : escapeRe(t), opts.caseSensitive ? 'g' : 'gi'));
}

function test(re, s) { re.lastIndex = 0; return re.test(s); }

/** Merged [start,end) ranges of every match of every matcher. */
function findRanges(text, matchers) {
  const ranges = [];
  for (const re of matchers) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (!m[0].length) { re.lastIndex++; continue; }
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push(r.slice());
  }
  return merged;
}

/** Cut a long line around the first match, keeping ranges aligned. */
function snippet(line, ranges, max = 160) {
  if (line.length <= max) return { text: line, ranges };
  const first = ranges.length ? ranges[0][0] : 0;
  const start = Math.max(0, first - 50);
  const end = Math.min(line.length, start + max);
  const pre = start > 0 ? '…' : '';
  const shift = pre.length - start;
  return {
    text: pre + line.slice(start, end) + (end < line.length ? '…' : ''),
    ranges: ranges.filter(([s, e]) => e > start && s < end).map(([s, e]) => [Math.max(s, start) + shift, Math.min(e, end) + shift]),
  };
}

const byPath = (a, b) => a.d.path.localeCompare(b.d.path, 'ja');
const SORTERS = {
  relevance: (a, b) => (b.nameHit - a.nameHit) || (b.lineHits.length - a.lineHits.length) || byPath(a, b),
  newest: (a, b) => (b.d.mtimeMs - a.d.mtimeMs) || byPath(a, b),
  oldest: (a, b) => (a.d.mtimeMs - b.d.mtimeMs) || byPath(a, b),
  name: (a, b) => a.d.name.localeCompare(b.d.name, 'ja', { numeric: true }) || byPath(a, b),
  size: (a, b) => (b.d.size - a.d.size) || byPath(a, b),
};

/**
 * docs: iterable of { path, name, ext, size, mtimeMs, lines }
 * opts: { name, body, caseSensitive, regex, ext, limit,
 *         since (ms, only files modified after), folder (path prefix),
 *         sort: 'relevance' | 'newest' | 'oldest' | 'name' | 'size' }
 */
function searchDocs(docs, query, opts = {}) {
  const o = { name: true, body: true, caseSensitive: false, regex: false, ext: '', limit: 300, since: 0, folder: '', sort: 'relevance', ...opts };
  const { terms, excludes } = parseQuery(query);
  if (!terms.length) return { total: 0, totalLines: 0, results: [] };
  let mk, ex;
  try { mk = makeMatchers(terms, o); ex = makeMatchers(excludes, o); }
  catch { return { error: '正規表現の書き方に誤りがあります。', total: 0, totalLines: 0, results: [] }; }

  const hits = [];
  for (const d of docs) {
    if (o.ext && d.ext !== o.ext) continue;
    if (o.since && d.mtimeMs < o.since) continue;
    if (o.folder && !d.path.startsWith(o.folder)) continue;
    const searchPath = norm(d.path);
    if (ex.some((re) => test(re, searchPath))) continue;
    const seen = mk.map((re) => o.name && test(re, searchPath));
    const nameHit = seen.every(Boolean);
    const lineHits = [];
    let excluded = false;
    if (o.body && d.lines) {
      for (let i = 0; i < d.lines.length; i++) {
        const ln = d.lines[i];
        if (ex.length && ex.some((re) => test(re, ln))) { excluded = true; break; }
        let any = false;
        for (let k = 0; k < mk.length; k++) if (test(mk[k], ln)) { seen[k] = true; any = true; }
        if (any) lineHits.push(i);
      }
    }
    if (excluded || !seen.every(Boolean)) continue;
    if (!nameHit && !lineHits.length) continue;
    hits.push({ d, nameHit, lineHits });
  }
  hits.sort(SORTERS[o.sort] || SORTERS.relevance);

  const results = hits.slice(0, o.limit).map(({ d, nameHit, lineHits }) => ({
    path: d.path, name: d.name, ext: d.ext, size: d.size, mtimeMs: d.mtimeMs, nameHit, ocr: !!d.ocr,
    nameRanges: findRanges(norm(d.name), mk),
    pathRanges: findRanges(norm(d.path), mk),
    lineCount: lineHits.length,
    snippets: lineHits.slice(0, 4).map((i) => ({ ln: i + 1, ...snippet(d.lines[i], findRanges(d.lines[i], mk)) })),
  }));
  return { total: hits.length, totalLines: hits.reduce((s, h) => s + h.lineHits.length, 0), results };
}

/** Full text of one doc with the matching lines and their ranges. */
function previewDoc(d, query, opts = {}, maxLines = 20000) {
  const o = { caseSensitive: false, regex: false, ...opts };
  let mk = [];
  try { mk = makeMatchers(parseQuery(query).terms, o); } catch { /* show without highlight */ }
  const lines = (d.lines || []).slice(0, maxLines);
  const hits = [];
  if (mk.length) lines.forEach((l, i) => { const r = findRanges(l, mk); if (r.length) hits.push({ i, ranges: r }); });
  return { path: d.path, lines, hits, truncated: Math.max(0, (d.lines || []).length - maxLines), error: d.error || null };
}

module.exports = { norm, parseQuery, findRanges, snippet, searchDocs, previewDoc };
