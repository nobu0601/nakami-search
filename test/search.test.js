'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseQuery, findRanges, snippet, searchDocs } = require('../src/search');

const doc = (p, text) => ({ path: p, name: p.split('/').pop(), ext: p.split('.').pop(), size: 1, mtimeMs: 0, lines: text == null ? null : text.normalize('NFKC').split('\n') });
const docs = [
  doc('/a/議事録.md', '見積書を再送する\n請求書は25日'),
  doc('/a/見積書_A社.txt', '金額 1,320,000円'),
  doc('/a/下書き.md', '見積書はまだ作成中'),
  doc('/a/経費.txt', 'ｲﾝﾎﾞｲｽ番号のない領収書'),
  doc('/a/photo.jpg', null),
];

test('parseQuery handles phrases and excludes', () => {
  assert.deepStrictEqual(parseQuery('見積 "請求 書" -下書き'), { terms: ['見積', '請求 書'], excludes: ['下書き'] });
});

test('AND search across name and body, excludes, ordering', () => {
  const r = searchDocs(docs, '見積書 -下書き');
  assert.deepStrictEqual(r.results.map((x) => x.name), ['見積書_A社.txt', '議事録.md']);
  assert.strictEqual(r.results[0].nameHit, true);
  assert.strictEqual(r.results[1].snippets[0].ln, 1);
});

test('half-width katakana matches full-width query', () => {
  const r = searchDocs(docs, 'インボイス');
  assert.strictEqual(r.total, 1);
  assert.deepStrictEqual(r.results[0].snippets[0].ranges, [[0, 5]]);
});

test('name-only files are found by name', () => {
  assert.strictEqual(searchDocs(docs, 'photo').total, 1);
  assert.strictEqual(searchDocs(docs, 'photo', { name: false }).total, 0);
});

test('bad regex reports an error instead of throwing', () => {
  assert.ok(searchDocs(docs, '(', { regex: true }).error);
});

test('ranges merge and snippets keep ranges aligned', () => {
  assert.deepStrictEqual(findRanges('abcabc', [/abc/gi, /bca/gi]), [[0, 6]]);
  const line = 'x'.repeat(300) + 'KEY' + 'y'.repeat(300);
  const s = snippet(line, [[300, 303]]);
  assert.strictEqual(s.text.slice(s.ranges[0][0], s.ranges[0][1]), 'KEY');
});
