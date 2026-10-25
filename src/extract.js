'use strict';
// Reads a file and returns its searchable text. Runs in plain Node (no Electron APIs).
//
// Two speeds: extractText() is the quick pass used while indexing; ocrFile() is the slow
// pass (image text recognition) that the indexer runs afterwards in the background.
const fs = require('fs/promises');
const path = require('path');
const { IMAGE_EXT, recognize } = require('./ocr');

const TEXT_EXT = new Set(('txt md markdown csv tsv json jsonl xml html htm css scss js mjs cjs ts tsx jsx py rb go rs java kt swift c h cpp hpp cs php sh bash zsh ps1 bat cmd sql yml yaml toml ini cfg conf env log rtf tex vue svelte gradle properties srt vtt').split(' '));
const SHEET_EXT = new Set(['xlsx', 'xlsm', 'xls', 'ods']);
const MAX_TEXT_BYTES = 30 * 1024 * 1024;
const MAX_DOC_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
// A PDF page with fewer characters than this is treated as a scanned image.
const SCANNED_PAGE_CHARS = 10;

function extOf(name) { return path.extname(name).slice(1).toLowerCase(); }

/** Whether we try to read the content (every file is still searchable by name). */
function isContentType(ext) {
  return TEXT_EXT.has(ext) || ext === 'pdf' || ext === 'docx' || ext === 'pptx' || SHEET_EXT.has(ext) || IMAGE_EXT.has(ext);
}

function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { /* not UTF-8 */ }
  try { return new TextDecoder('shift_jis').decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}

// ---------- PDF ----------
let pdfjs;
function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
    pdfjs.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.js');
  }
  return pdfjs;
}
// cmaps are needed for Japanese PDFs.
function pdfAssetDir(name) {
  const dir = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), name);
  return dir.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`) + path.sep;
}
function openPdf(buf) {
  return loadPdfjs().getDocument({
    data: new Uint8Array(buf), isEvalSupported: false, verbosity: 0, isOffscreenCanvasSupported: false,
    cMapUrl: pdfAssetDir('cmaps'), cMapPacked: true, standardFontDataUrl: pdfAssetDir('standard_fonts'),
  }).promise;
}

async function pageText(page) {
  const tc = await page.getTextContent();
  const out = [];
  let line = '', lastY = null;
  for (const it of tc.items) {
    const y = it.transform ? Math.round(it.transform[5]) : lastY;
    if (lastY !== null && y !== lastY && line) { out.push(line); line = ''; }
    line += it.str || ''; lastY = y;
    if (it.hasEOL) { out.push(line); line = ''; }
  }
  if (line) out.push(line);
  return out;
}

const charCount = (lines) => lines.join('').replace(/\s/g, '').length;

/** Returns { text, scannedPages } — scannedPages lists pages that look like images. */
async function extractPdf(buf) {
  const doc = await openPdf(buf);
  const out = [];
  const scannedPages = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const lines = await pageText(await doc.getPage(p));
      if (charCount(lines) < SCANNED_PAGE_CHARS) scannedPages.push(p);
      out.push(`── ${p} ページ ──`, ...lines);
    }
  } finally { await doc.destroy(); }
  return { text: out.join('\n'), scannedPages };
}

/** Turn a pdf.js decoded image into a PNG buffer that tesseract can read. */
function pdfImageToPng(img) {
  const { PNG } = require('pngjs');
  const { width, height, data, kind } = img;
  const png = new PNG({ width, height });
  const px = width * height;
  if (kind === 3) png.data = Buffer.from(data.buffer, data.byteOffset, px * 4);
  else if (kind === 2) {
    for (let i = 0; i < px; i++) { png.data[i * 4] = data[i * 3]; png.data[i * 4 + 1] = data[i * 3 + 1]; png.data[i * 4 + 2] = data[i * 3 + 2]; png.data[i * 4 + 3] = 255; }
  } else { // 1 bit per pixel, rows padded to bytes
    const rowBytes = (width + 7) >> 3;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
      const v = bit ? 255 : 0; const o = (y * width + x) * 4;
      png.data[o] = png.data[o + 1] = png.data[o + 2] = v; png.data[o + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

async function pageImages(page) {
  const lib = loadPdfjs();
  const ops = await page.getOperatorList();
  const images = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (ops.fnArray[i] !== lib.OPS.paintImageXObject && ops.fnArray[i] !== lib.OPS.paintJpegXObject) continue;
    const name = ops.argsArray[i][0];
    const store = name.startsWith('g_') ? page.commonObjs : page.objs;
    const img = await new Promise((resolve) => { try { store.get(name, resolve); } catch { resolve(null); } });
    // Skip icons and decorations; scans are large.
    if (img && img.data && img.width >= 200 && img.height >= 200) images.push(img);
  }
  return images;
}

/** Re-read a PDF, recognising text on the scanned pages only. */
async function ocrPdf(buf, scannedPages) {
  const doc = await openPdf(buf);
  const out = [];
  try {
    const todo = new Set(scannedPages);
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      out.push(`── ${p} ページ ──`);
      if (!todo.has(p)) { out.push(...await pageText(page)); continue; }
      for (const img of await pageImages(page)) out.push(await recognize(pdfImageToPng(img)));
      page.cleanup();
    }
  } finally { await doc.destroy(); }
  return out.join('\n');
}

// ---------- Office ----------
async function extractPptx(buf) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buf);
  const num = (n) => Number((n.match(/(\d+)\.xml$/) || [])[1] || 0);
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => num(a) - num(b));
  const out = [];
  const xmlText = (xml) => xml
    .replace(/<\/a:p>/g, '\n').replace(/<a:br\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .split('\n').map((s) => s.trim()).filter(Boolean);
  for (const name of slides) {
    out.push(`── スライド ${num(name)} ──`, ...xmlText(await zip.file(name).async('string')));
    const notes = zip.file(`ppt/notesSlides/notesSlide${num(name)}.xml`);
    if (notes) {
      const lines = xmlText(await notes.async('string')).filter((l) => !/^\d+$/.test(l));
      if (lines.length) out.push('（ノート）', ...lines);
    }
  }
  return out.join('\n');
}

/**
 * Quick pass. Returns { text, needsOcr, scannedPages }.
 * needsOcr is true for images and for PDFs with pages that have no text layer.
 */
async function extractText(filePath, ext = extOf(filePath), size) {
  if (!isContentType(ext)) return { text: '', needsOcr: false };
  if (size == null) size = (await fs.stat(filePath)).size;
  if (IMAGE_EXT.has(ext)) {
    if (size > MAX_IMAGE_BYTES) throw new Error('大きすぎるため文字認識しません');
    return { text: '', needsOcr: true };
  }
  if (TEXT_EXT.has(ext)) {
    if (size > MAX_TEXT_BYTES) throw new Error('大きすぎるため中身は読みません');
    return { text: decodeText(await fs.readFile(filePath)), needsOcr: false };
  }
  if (size > MAX_DOC_BYTES) throw new Error('大きすぎるため中身は読みません');
  const buf = await fs.readFile(filePath);
  if (ext === 'pdf') {
    const r = await extractPdf(buf);
    return { text: r.text, needsOcr: r.scannedPages.length > 0, scannedPages: r.scannedPages };
  }
  if (ext === 'docx') {
    const mammoth = require('mammoth');
    return { text: (await mammoth.extractRawText({ buffer: buf })).value, needsOcr: false };
  }
  if (ext === 'pptx') return { text: await extractPptx(buf), needsOcr: false };
  const XLSX = require('xlsx');
  const wb = XLSX.read(buf, { type: 'buffer' });
  return { text: wb.SheetNames.map((n) => `── シート: ${n} ──\n` + XLSX.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false })).join('\n'), needsOcr: false };
}

/** Slow pass: text recognition for images and scanned PDF pages. */
async function ocrFile(filePath, ext = extOf(filePath), scannedPages = []) {
  const buf = await fs.readFile(filePath);
  if (ext === 'pdf') return ocrPdf(buf, scannedPages);
  return recognize(buf);
}

module.exports = { extractText, ocrFile, extOf, isContentType, decodeText, IMAGE_EXT };
