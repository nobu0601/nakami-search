'use strict';
(() => {
  const api = window.nakami;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const fmtSize = (b) => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(2) + ' GB';
  const fmtDate = (ms) => new Date(ms).toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

  let state = null;
  let indexing = false;

  /** Put text into a node with <mark> around the given [start,end) ranges. */
  function fillHighlighted(node, text, ranges) {
    let cur = 0;
    for (const [s, e] of ranges || []) {
      if (s > cur) node.append(text.slice(cur, s));
      node.append(el('mark', null, text.slice(s, e)));
      cur = e;
    }
    node.append(text.slice(cur));
    return node;
  }

  function opts() {
    return { name: $('optName').checked, body: $('optBody').checked, caseSensitive: $('optCase').checked, regex: $('optRegex').checked, ext: $('optType').value };
  }

  // ---------- status / folders ----------
  function renderState(s) {
    state = s;
    const st = $('status');
    st.replaceChildren();
    const count = el('span'); count.append('索引 '); count.append(el('b', null, s.files.toLocaleString())); count.append(` ファイル（${fmtSize(s.size)}）`);
    st.append(count);
    if (s.folders.length) st.append(el('span', 'chip live', indexing ? '読み込み中' : '変更を監視中'));
    if (s.unreadable) st.append(el('span', 'chip warn', `中身を読めなかったファイル ${s.unreadable} 件`));

    const list = $('folderList');
    list.replaceChildren();
    if (!s.folders.length) list.append(el('li', 'none', 'まだフォルダがありません。「フォルダを追加」から選んでください。選んだフォルダは保存され、次回からすぐ検索できます。'));
    for (const dir of s.folders) {
      const li = el('li');
      li.append(el('span', null, dir));
      const rm = el('button', 'mini', '外す');
      rm.type = 'button';
      rm.title = '検索対象から外します（ファイル自体は消えません）';
      rm.onclick = async () => { renderState(await api.removeFolder(dir)); run(); };
      li.append(rm);
      list.append(li);
    }

    const sel = $('optType'), cur = sel.value;
    sel.replaceChildren(new Option('すべて', ''));
    for (const ext of Object.keys(s.types).sort()) sel.append(new Option(`${ext}（${s.types[ext]}）`, ext));
    if (s.types[cur]) sel.value = cur;
  }

  api.onProgress((p) => {
    const bar = $('progress');
    if (p.phase === 'listing') { indexing = true; bar.hidden = false; bar.firstElementChild.style.width = '0'; setStatusLine(`ファイルを数えています… ${p.dir}`); }
    else if (p.phase === 'indexing') { indexing = true; bar.hidden = false; bar.firstElementChild.style.width = (p.done / Math.max(1, p.total) * 100) + '%'; setStatusLine(`読み込み中 ${p.done.toLocaleString()} / ${p.total.toLocaleString()}`); }
    else if (p.phase === 'done') { indexing = false; bar.hidden = true; }
    else if (p.phase === 'error') { setStatusLine('索引の保存に失敗しました: ' + p.message); }
  });
  function setStatusLine(text) {
    let n = document.querySelector('#status .live-text');
    if (!n) { n = el('span', 'live-text'); $('status').append(n); }
    n.textContent = text;
  }
  api.onChanged((s) => { renderState(s); if ($('q').value.trim()) run(); });

  // ---------- search ----------
  let seq = 0;
  async function run() {
    const q = $('q').value.trim();
    const out = $('results');
    if (!q) {
      out.replaceChildren(el('div', 'empty', state && state.files
        ? `${state.files.toLocaleString()} 件のファイルを検索できます。上の欄にキーワードを入力してください。`
        : 'フォルダを追加すると、ファイル名と中身を検索できるようになります。'));
      return;
    }
    const my = ++seq;
    const r = await api.search(q, opts());
    if (my !== seq) return; // a newer search already started
    out.replaceChildren();
    if (r.error) { out.append(el('div', 'empty', r.error)); return; }
    if (!r.total) { out.append(el('div', 'empty', `「${q}」に一致するファイルは見つかりませんでした。`)); return; }
    out.append(el('div', 'summary', `${r.total.toLocaleString()} ファイル・${r.totalLines.toLocaleString()} 行で一致${r.total > r.results.length ? `（上位 ${r.results.length} 件を表示）` : ''}`));
    for (const h of r.results) out.append(renderHit(h, q));
  }

  function renderHit(h, q) {
    const art = el('article', 'hit');
    const head = el('div', 'hit-head');
    const name = el('button', 'hit-name'); name.type = 'button'; name.title = 'クリックで中身を表示 / ダブルクリックで開く';
    fillHighlighted(name, h.name, h.nameRanges);
    name.onclick = () => openPreview(h.path, q);
    name.ondblclick = () => api.openFile(h.path);
    head.append(name);
    if (h.nameHit) head.append(el('span', 'chip', 'ファイル名に一致'));
    head.append(el('span', 'hit-meta', `${h.lineCount ? h.lineCount + ' 行　' : ''}${h.ext}・${fmtSize(h.size)}・${fmtDate(h.mtimeMs)}`));
    art.append(head);
    art.append(fillHighlighted(el('div', 'hit-path'), h.path, h.pathRanges));

    if (h.snippets.length) {
      const ul = el('ul', 'lines');
      for (const s of h.snippets) {
        const li = el('li');
        li.append(el('span', 'ln', String(s.ln)));
        li.append(fillHighlighted(el('span', 'tx'), s.text, s.ranges));
        ul.append(li);
      }
      art.append(ul);
    }
    if (h.lineCount > h.snippets.length) {
      const more = el('button', 'more', `ほか ${h.lineCount - h.snippets.length} 行を見る`); more.type = 'button';
      more.onclick = () => openPreview(h.path, q);
      art.append(more);
    }
    const actions = el('div', 'hit-actions');
    const mk = (label, fn) => { const b = el('button', 'mini', label); b.type = 'button'; b.onclick = fn; actions.append(b); return b; };
    mk('開く', () => api.openFile(h.path));
    mk('フォルダで表示', () => api.showInFolder(h.path));
    const cp = mk('パスをコピー', async () => { await api.copy(h.path); cp.textContent = 'コピーしました'; setTimeout(() => (cp.textContent = 'パスをコピー'), 1500); });
    art.append(actions);
    return art;
  }

  // ---------- preview ----------
  let dlgHits = [], dlgPos = 0, dlgPath = null;
  async function openPreview(p, q) {
    const r = await api.preview(p, q, opts());
    if (!r) return;
    dlgPath = p;
    $('dlgTitle').textContent = r.path;
    const body = $('dlgBody');
    body.replaceChildren();
    if (r.error) body.append(el('div', 'notice', `中身を読めませんでした（${r.error}）。「開く」で元のアプリから確認できます。`));
    else if (!r.lines.length || (r.lines.length === 1 && !r.lines[0])) body.append(el('div', 'notice', 'このファイルは中身を検索しない種類です（ファイル名だけで検索しています）。「開く」で元のアプリから確認できます。'));
    const hitMap = new Map(r.hits.map((h) => [h.i, h.ranges]));
    const frag = document.createDocumentFragment();
    r.lines.forEach((line, i) => {
      const row = el('div', hitMap.has(i) ? 'row on' : 'row');
      row.id = 'L' + i;
      row.append(el('span', 'ln', String(i + 1)));
      row.append(fillHighlighted(el('span', 'tx'), line || ' ', hitMap.get(i)));
      frag.append(row);
    });
    if (r.truncated) frag.append(el('div', 'notice', `…以降 ${r.truncated.toLocaleString()} 行は省略しています`));
    body.append(frag);
    dlgHits = r.hits.map((h) => h.i); dlgPos = 0;
    $('dlg').showModal();
    jump(0);
  }
  function jump(delta) {
    document.querySelectorAll('#dlgBody .row.cur').forEach((n) => n.classList.remove('cur'));
    if (!dlgHits.length) { $('dlgPos').textContent = ''; return; }
    dlgPos = (dlgPos + delta + dlgHits.length) % dlgHits.length;
    $('dlgPos').textContent = `${dlgPos + 1} / ${dlgHits.length}`;
    const row = document.getElementById('L' + dlgHits[dlgPos]);
    if (row) { row.classList.add('cur'); row.scrollIntoView({ block: 'center' }); }
  }

  // ---------- events ----------
  $('addFolder').onclick = async () => renderState(await api.addFolder());
  $('rescan').onclick = async () => renderState(await api.rescan());
  let timer;
  $('q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 200); });
  ['optName', 'optBody', 'optCase', 'optRegex', 'optType'].forEach((id) => $(id).addEventListener('change', run));
  $('dlgClose').onclick = () => $('dlg').close();
  $('dlgOpen').onclick = () => dlgPath && api.openFile(dlgPath);
  $('dlgPrev').onclick = () => jump(-1);
  $('dlgNext').onclick = () => jump(1);
  $('dlg').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'F3') { e.preventDefault(); jump(e.shiftKey ? -1 : 1); } });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey && e.key.toLowerCase() === 'f') || (e.key === '/' && document.activeElement !== $('q'))) {
      if ($('dlg').open) return;
      e.preventDefault(); $('q').focus(); $('q').select();
    }
  });

  api.state().then((s) => { renderState(s); run(); });
})();
