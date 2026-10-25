'use strict';
// Japanese + English OCR with tesseract.js. Language data ships with the app (no download).
const fs = require('fs');
const path = require('path');

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff']);

let workerPromise = null;
let workDir = null;

function setWorkDir(dir) { workDir = dir; }

/**
 * Put the bundled language data where tesseract.js looks for its cache.
 * Inside Electron tesseract.js treats langPath as a web address and tries to download it,
 * but it always checks `${cachePath}/${lang}.traineddata` first, so a pre-filled cache keeps
 * everything offline. The files stay gzipped; tesseract.js unpacks them itself.
 */
function prepareCacheDir() {
  const dir = path.join(workDir || require('os').tmpdir(), 'tessdata');
  fs.mkdirSync(dir, { recursive: true });
  for (const lang of ['jpn', 'eng']) {
    const dest = path.join(dir, `${lang}.traineddata`);
    const src = path.join(path.dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`)), '4.0.0_best_int', `${lang}.traineddata.gz`);
    if (fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(src).size) continue;
    fs.copyFileSync(src, dest);
  }
  return dir;
}

function getWorker() {
  if (!workerPromise) {
    const { createWorker } = require('tesseract.js');
    const cachePath = prepareCacheDir();
    // errorHandler: without it tesseract.js also throws unreadable images as an uncaught
    // exception (the promise still rejects, which is all we need).
    workerPromise = createWorker('jpn+eng', 1, { langPath: cachePath, cachePath, cacheMethod: 'readOnly', gzip: true, errorHandler: () => {} })
      .catch((e) => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

const CJK = '\\u3000-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';
// Also join digits to Japanese text (「12,800 円」→「12,800円」, 「第 1 条」→「第1条」).
const CJK_GAP = new RegExp(`(?<=[${CJK}])[ \\t]+(?=[${CJK}0-9])|(?<=[${CJK}0-9])[ \\t]+(?=[${CJK}])`, 'g');

/** Tesseract puts spaces between Japanese characters; remove them so words can be found. */
function cleanOcrText(text) {
  return text.replace(CJK_GAP, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Formats tesseract can decode, checked by their first bytes. */
function isReadableImage(buf) {
  if (!buf || buf.length < 16) return false;
  const b = buf;
  return (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) // PNG
    || (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) // JPEG
    || (b[0] === 0x42 && b[1] === 0x4d) // BMP
    || (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a); // TIFF
}

const TIMEOUT_MS = 3 * 60 * 1000;

async function recognize(imageBuffer) {
  if (!isReadableImage(imageBuffer)) throw new Error('画像として読み取れません');
  const worker = await getWorker();
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('文字認識に時間がかかりすぎたため中止しました')), TIMEOUT_MS); });
  try {
    const { data } = await Promise.race([worker.recognize(imageBuffer), timeout]);
    return cleanOcrText(data.text || '');
  } catch (e) {
    if (/時間がかかりすぎ/.test(e.message)) await shutdown(); // start a fresh worker next time
    throw e;
  } finally { clearTimeout(timer); }
}

async function shutdown() {
  if (!workerPromise) return;
  try { (await workerPromise).terminate(); } catch { /* already gone */ }
  workerPromise = null;
}

module.exports = { IMAGE_EXT, setWorkDir, recognize, cleanOcrText, isReadableImage, shutdown };
