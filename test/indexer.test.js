'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');
const { Index } = require('../src/indexer');

// Minimal one-page PDF with the text "Quarterly invoice".
function makePdf() {
  const content = 'BT /F1 24 Tf 72 720 Td (Quarterly invoice) Tj ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('index a folder, persist, and pick up changes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nakami-'));
  const dir = path.join(root, 'docs');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'memo.txt'), '会議のメモ\n予算は100万円');
  fs.writeFileSync(path.join(dir, 'sub', 'sjis.txt'), Buffer.from([0x93, 0xfa, 0x96, 0x7b])); // 「日本」 in Shift_JIS
  fs.writeFileSync(path.join(dir, 'node_modules', 'skip.txt'), '予算');
  fs.writeFileSync(path.join(dir, 'report.pdf'), makePdf());
  fs.writeFileSync(path.join(dir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['品名', '金額'], ['コーヒー豆', 3200]]), '仕入');
  XLSX.writeFile(wb, path.join(dir, 'cost.xlsx'));

  const store = path.join(root, 'store', 'index.json.gz');
  const idx = new Index(store);
  await idx.addFolder(dir);

  assert.strictEqual(idx.stats().files, 5);
  assert.deepStrictEqual(idx.search('予算').results.map((r) => r.name), ['memo.txt']);
  assert.strictEqual(idx.search('日本').results[0].name, 'sjis.txt');
  assert.strictEqual(idx.search('invoice').results[0].name, 'report.pdf');
  assert.strictEqual(idx.search('コーヒー豆').results[0].name, 'cost.xlsx');
  assert.strictEqual(idx.search('image').results[0].name, 'image.png');

  idx.saveNow();
  const again = new Index(store);
  assert.ok(again.load());
  assert.strictEqual(again.search('予算').total, 1);

  // edit one file, delete another, then sync
  fs.writeFileSync(path.join(dir, 'memo.txt'), '予算は200万円に変更');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, 'memo.txt'), later, later);
  fs.unlinkSync(path.join(dir, 'image.png'));
  const r = await again.syncFolder(dir);
  assert.strictEqual(r.changed, 1);
  assert.strictEqual(again.search('200万円').total, 1);
  assert.strictEqual(again.search('image').total, 0);

  await again.removeFolder(dir);
  assert.strictEqual(again.stats().files, 0);
  fs.rmSync(root, { recursive: true, force: true });
});
