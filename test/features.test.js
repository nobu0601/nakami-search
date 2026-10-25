'use strict';
// v1.1 features: PowerPoint, text recognition, exclusions, filters and sorting, settings.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const { Index } = require('../src/indexer');
const { Settings } = require('../src/settings');
const ocr = require('../src/ocr');

const FIX = path.join(__dirname, 'fixtures');

async function makePptx(file) {
  const zip = new JSZip();
  const slide = (t) => `<p:sld xmlns:a="a" xmlns:p="p"><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sld>`;
  zip.file('ppt/slides/slide1.xml', slide('2026年度 売上計画'));
  zip.file('ppt/slides/slide2.xml', slide('新店舗 &amp; 改装の予定'));
  zip.file('ppt/notesSlides/notesSlide2.xml', slide('説明は3分以内'));
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nakami-f-'));
  const dir = path.join(root, 'docs');
  fs.mkdirSync(path.join(dir, 'old'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'backup_2024'));
  ocr.setWorkDir(path.join(root, 'ocrwork'));
  return { root, dir };
}

test('PowerPoint slides and notes are searchable', async () => {
  const { root, dir } = setup();
  await makePptx(path.join(dir, 'plan.pptx'));
  const idx = new Index(path.join(root, 'i.gz'));
  await idx.addFolder(dir);
  assert.strictEqual(idx.search('売上計画').results[0].name, 'plan.pptx');
  assert.strictEqual(idx.search('新店舗 & 改装').total, 1);
  assert.strictEqual(idx.search('3分以内').total, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('images and scanned PDFs are read in the background', async () => {
  const { root, dir } = setup();
  fs.copyFileSync(path.join(FIX, 'receipt.png'), path.join(dir, 'receipt.png'));
  fs.copyFileSync(path.join(FIX, 'scan.pdf'), path.join(dir, 'scan.pdf'));
  const idx = new Index(path.join(root, 'i.gz'));
  await idx.addFolder(dir);
  assert.strictEqual(idx.search('12,800円').total, 0, 'not read yet right after indexing');
  await idx.ocrIdle();
  const r = idx.search('12,800円');
  assert.strictEqual(r.results[0].name, 'receipt.png');
  assert.strictEqual(r.results[0].ocr, true);
  assert.strictEqual(idx.search('業務委託契約書').results[0].name, 'scan.pdf');
  assert.strictEqual(idx.stats().ocrPending, 0);

  // results survive a restart without reading again
  idx.saveNow();
  const again = new Index(path.join(root, 'i.gz'));
  again.load();
  assert.strictEqual(again.search('打合せ').total, 1);
  await ocr.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test('text recognition can be turned off', async () => {
  const { root, dir } = setup();
  fs.copyFileSync(path.join(FIX, 'receipt.png'), path.join(dir, 'receipt.png'));
  const idx = new Index(path.join(root, 'i.gz'));
  idx.setOcrEnabled(false);
  await idx.addFolder(dir);
  await idx.ocrIdle();
  assert.strictEqual(idx.search('領収書').total, 0);
  assert.strictEqual(idx.search('receipt').total, 1, 'still found by name');
  assert.strictEqual(idx.stats().ocrPending, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('excluded folders, names and extensions are skipped and dropped', async () => {
  const { root, dir } = setup();
  fs.writeFileSync(path.join(dir, 'a.txt'), '予算');
  fs.writeFileSync(path.join(dir, 'old', 'b.txt'), '予算');
  fs.writeFileSync(path.join(dir, 'backup_2024', 'c.txt'), '予算');
  fs.writeFileSync(path.join(dir, 'movie.mp4'), Buffer.alloc(10));
  const idx = new Index(path.join(root, 'i.gz'));
  await idx.addFolder(dir);
  assert.strictEqual(idx.search('予算').total, 3);
  assert.strictEqual(idx.search('movie').total, 1, 'videos are found by name');

  idx.setExclusions({ names: ['old', 'backup*'], exts: ['.MP4'] });
  await idx.syncFolder(dir);
  assert.deepStrictEqual(idx.search('予算').results.map((r) => r.name), ['a.txt']);
  assert.strictEqual(idx.search('movie').total, 0);
  assert.strictEqual(await idx.indexFile(path.join(dir, 'old', 'b.txt')), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('filters by date and folder, and sorts', async () => {
  const { root, dir } = setup();
  const files = { 'b.txt': 10, 'a.txt': 100, 'old/c.txt': 400 };
  for (const [f, daysAgo] of Object.entries(files)) {
    const p = path.join(dir, f);
    fs.writeFileSync(p, '報告書'.repeat(daysAgo === 10 ? 3 : 1));
    const t = new Date(Date.now() - daysAgo * 86400000);
    fs.utimesSync(p, t, t);
  }
  const idx = new Index(path.join(root, 'i.gz'));
  await idx.addFolder(dir);
  const names = (o) => idx.search('報告書', o).results.map((r) => r.name);
  assert.deepStrictEqual(names({ sort: 'newest' }), ['b.txt', 'a.txt', 'c.txt']);
  assert.deepStrictEqual(names({ sort: 'oldest' }), ['c.txt', 'a.txt', 'b.txt']);
  assert.deepStrictEqual(names({ sort: 'name' }), ['a.txt', 'b.txt', 'c.txt']);
  assert.deepStrictEqual(names({ since: Date.now() - 30 * 86400000 }), ['b.txt']);
  assert.deepStrictEqual(names({ folder: path.join(dir, 'old') }), ['c.txt']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('settings keep history, favourites and validated options', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nakami-s-'));
  const file = path.join(root, 'settings.json');
  const s = new Settings(file);
  s.addHistory('見積書'); s.addHistory('請求書'); s.addHistory('見積書');
  assert.deepStrictEqual(s.get().history, ['見積書', '請求書']);
  s.toggleFavorite('請求書 -下書き');
  s.update({ ocr: false, shortcut: 'Nope+X', excludeExts: [' mp4 ', ''], history: ['x'] });
  const again = new Settings(file).get();
  assert.deepStrictEqual(again.favorites, ['請求書 -下書き']);
  assert.strictEqual(again.ocr, false);
  assert.strictEqual(again.shortcut, 'Control+Shift+Space');
  assert.deepStrictEqual(again.excludeExts, ['mp4']);
  assert.deepStrictEqual(again.history, ['見積書', '請求書']);
  s.toggleFavorite('請求書 -下書き');
  assert.deepStrictEqual(new Settings(file).get().favorites, []);
  fs.rmSync(root, { recursive: true, force: true });
});
