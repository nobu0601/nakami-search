'use strict';
// Reads a file and returns its searchable text. Runs in plain Node (no Electron APIs).
const fs = require('fs/promises');
const path = require('path');

const TEXT_EXT = new Set(('txt md markdown csv tsv json jsonl xml html htm css scss js mjs cjs ts tsx jsx py rb go rs java kt swift c h cpp hpp cs php sh bash zsh ps1 bat cmd sql yml yaml toml ini cfg conf env log rtf tex vue svelte gradle properties srt vtt').split(' '));
const SHEET_EXT = new Set(['xlsx', 'xlsm', 'xls', 'ods']);
const MAX_TEXT_BYTES = 30 * 1024 * 1024;
const MAX_DOC_BYTES = 100 * 1024 * 1024;

function extOf(name) {
  const e = path.extname(name).slice(1).toLowerCase();
  return e;
}

/** Whether we try to read the content (every file is still searchable by name). */
function isContentType(ext) {
  return TEXT_EXT.has(ext) || ext === 'pdf' || ext === 'docx' || SHEET_EXT.has(ext);
}

function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { /* not UTF-8 */ }
  try { return new TextDecoder('shift_jis').decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}

let pdfjs;
function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
    pdfjs.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.js');
  }
  return pdfjs;
}
// cmaps are needed for Japanese PDFs. In a packaged app they live in app.asar.unpacked.
function pdfAssetDir(name) {
  const dir = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), name);
  return dir.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`) + path.sep;
}

async function extractPdf(buf) {
  const lib = loadPdfjs();
  const doc = await lib.getDocument({
    data: new Uint8Array(buf), isEvalSupported: false, verbosity: 0,
    cMapUrl: pdfAssetDir('cmaps'), cMapPacked: true, standardFontDataUrl: pdfAssetDir('standard_fonts'),
  }).promise;
  const out = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const tc = await (await doc.getPage(p)).getTextContent();
      let line = '', lastY = null;
      out.push(`── ${p} ページ ──`);
      for (const it of tc.items) {
        const y = it.transform ? Math.round(it.transform[5]) : lastY;
        if (lastY !== null && y !== lastY && line) { out.push(line); line = ''; }
        line += it.str || ''; lastY = y;
        if (it.hasEOL) { out.push(line); line = ''; }
      }
      if (line) out.push(line);
    }
  } finally { await doc.destroy(); }
  return out.join('\n');
}

async function extractText(filePath, ext = extOf(filePath), size) {
  if (!isContentType(ext)) return '';
  if (size == null) size = (await fs.stat(filePath)).size;
  if (TEXT_EXT.has(ext)) {
    if (size > MAX_TEXT_BYTES) throw new Error('大きすぎるため中身は読みません');
    return decodeText(await fs.readFile(filePath));
  }
  if (size > MAX_DOC_BYTES) throw new Error('大きすぎるため中身は読みません');
  const buf = await fs.readFile(filePath);
  if (ext === 'pdf') return extractPdf(buf);
  if (ext === 'docx') {
    const mammoth = require('mammoth');
    return (await mammoth.extractRawText({ buffer: buf })).value;
  }
  const XLSX = require('xlsx');
  const wb = XLSX.read(buf, { type: 'buffer' });
  return wb.SheetNames.map((n) => `── シート: ${n} ──\n` + XLSX.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false })).join('\n');
}

module.exports = { extractText, extOf, isContentType, decodeText };
