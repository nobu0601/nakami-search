'use strict';
(() => {
  const api = window.nakami;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const fmtSize = (b) => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(2) + ' GB';
  const fmtDate = (ms) => new Date(ms).toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const keyLabel = (k) => k.replace('Control', 'Ctrl').replace(/\+/g, ' + ');

  let state = null;
  let prefs = null;
  let indexing = false;
  let ocrPending = 0;
  let statusLine = '';

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

  function sinceValue() {
    const days = Number($('optSince').value);
    if (!days) return 0;
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime() - (days - 1) * 86400000;
  }

  function opts() {
    return {
      name: $('optName').checked, body: $('optBody').checked, caseSensitive: $('optCase').checked, regex: $('optRegex').checked,
      ext: $('optType').value, folder: $('optFolder').value, since: sinceValue(), sort: $('optSort').value,
    };
  }

  // ---------- status / folders ----------
  function renderStatus() {
    if (!state) return;
    const st = $('status');
    st.replaceChildren();
    const count = el('span'); count.append('索引 '); count.append(el('b', null, state.files.toLocaleString())); count.append(` ファイル（${fmtSize(state.size)}）`);
    st.append(count);
    if (state.folders.length) st.append(el('span', 'chip live', indexing ? '読み込み中' : '変更を監視中'));
    if (ocrPending) st.append(el('span', 'chip ocr', `文字認識 残り ${ocrPending.toLocaleString()} 件`));
    if (state.unreadable) st.append(el('span', 'chip warn', `中身を読めなかったファイル ${state.unreadable} 件`));
    if (statusLine) st.append(el('span', null, statusLine));
  }

  function setSelect(sel, items, keepValue) {
    const cur = sel.value;
    sel.replaceChildren(new Option('すべて', ''));
    for (const [value, label] of items) sel.append(new Option(label, value));
    if (keepValue && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
  }

  function renderState(s) {
    state = s;
    ocrPending = s.ocrQueued || 0;
    renderStatus();
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
    setSelect($('optFolder'), s.folders.map((d) => [d, d.split(/[\\/]/).filter(Boolean).pop() || d]), true);
    setSelect($('optType'), Object.keys(s.types).sort().map((e) => [e, `${e}（${s.types[e]}）`]), true);
  }

  api.onProgress((p) => {
    const bar = $('progress');
    if (p.phase === 'listing') { indexing = true; bar.hidden = false; bar.firstElementChild.style.width = '0'; statusLine = 'ファイルを数えています…'; }
    else if (p.phase === 'indexing') { indexing = true; bar.hidden = false; bar.firstElementChild.style.width = (p.done / Math.max(1, p.total) * 100) + '%'; statusLine = `読み込み中 ${p.done.toLocaleString()} / ${p.total.toLocaleString()}`; }
    else if (p.phase === 'done') { indexing = false; bar.hidden = true; statusLine = ''; }
    else if (p.phase === 'error') { statusLine = '索引の保存に失敗しました: ' + p.message; }
    renderStatus();
  });
  api.onOcr((o) => { ocrPending = o.pending; renderStatus(); });
  api.onChanged((s) => { renderState(s); if ($('q').value.trim()) run(); });

  // ---------- search ----------
  let seq = 0;
  let recordTimer = null;
  async function run() {
    const q = $('q').value.trim();
    updateStar();
    const out = $('results');
    clearTimeout(recordTimer);
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
    // Keep the query in history once the user has paused on a search that found something.
    recordTimer = setTimeout(() => remember(q), 2500);
    out.append(el('div', 'summary', `${r.total.toLocaleString()} ファイル・${r.totalLines.toLocaleString()} 行で一致${r.total > r.results.length ? `（上位 ${r.results.length} 件を表示）` : ''}`));
    for (const h of r.results) out.append(renderHit(h, q));
  }

  async function remember(q) {
    clearTimeout(recordTimer);
    if (q) prefs = await api.addHistory(q);
  }

  function renderHit(h, q) {
    const art = el('article', 'hit');
    const head = el('div', 'hit-head');
    const name = el('button', 'hit-name'); name.type = 'button'; name.title = 'クリックで中身を表示 / ダブルクリックで開く';
    fillHighlighted(name, h.name, h.nameRanges);
    name.onclick = () => openPreview(h.path, q);
    name.ondblclick = () => { remember(q); api.openFile(h.path); };
    head.append(name);
    if (h.nameHit) head.append(el('span', 'chip', 'ファイル名に一致'));
    if (h.ocr) head.append(el('span', 'chip ocr', '文字認識'));
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
    mk('開く', () => { remember(q); api.openFile(h.path); });
    mk('フォルダで表示', () => { remember(q); api.showInFolder(h.path); });
    const cp = mk('パスをコピー', async () => { await api.copy(h.path); cp.textContent = 'コピーしました'; setTimeout(() => (cp.textContent = 'パスをコピー'), 1500); });
    art.append(actions);
    return art;
  }

  // ---------- history & favourites ----------
  let sgActive = -1;
  function updateStar() {
    const q = $('q').value.trim();
    const on = !!(prefs && q && prefs.favorites.includes(q));
    $('star').setAttribute('aria-pressed', String(on));
    $('star').textContent = on ? '★' : '☆';
    $('star').title = on ? 'お気に入りから外す' : 'この検索をお気に入りに保存';
  }

  function suggestions() {
    if (!prefs) return [];
    const q = $('q').value.trim();
    const match = (s) => !q || (s !== q && s.toLowerCase().includes(q.toLowerCase()));
    const favs = prefs.favorites.filter(match).map((s) => ({ s, fav: true }));
    const hist = prefs.history.filter((s) => match(s) && !prefs.favorites.includes(s)).slice(0, 10).map((s) => ({ s, fav: false }));
    return [...favs, ...hist];
  }

  function renderSuggest() {
    const box = $('suggest');
    const items = suggestions();
    if (!items.length || document.activeElement !== $('q')) { box.hidden = true; sgActive = -1; return; }
    box.replaceChildren();
    let lastFav = null;
    items.forEach((it, i) => {
      if (it.fav !== lastFav) { box.append(el('h3', null, it.fav ? 'お気に入り' : '最近の検索')); lastFav = it.fav; }
      const row = el('div', 'sg-item' + (i === sgActive ? ' active' : ''));
      const pick = el('button', null, (it.fav ? '★ ' : '') + it.s); pick.type = 'button'; pick.tabIndex = -1;
      pick.onmousedown = (e) => { e.preventDefault(); choose(it.s); };
      const x = el('button', 'x', '削除'); x.type = 'button'; x.tabIndex = -1;
      x.title = it.fav ? 'お気に入りから外す' : '履歴から消す';
      x.onmousedown = async (e) => {
        e.preventDefault();
        prefs = it.fav ? await api.toggleFavorite(it.s) : await api.removeHistory(it.s);
        renderSuggest(); updateStar();
      };
      row.append(pick, x);
      box.append(row);
    });
    box.hidden = false;
  }

  function choose(s) {
    $('q').value = s;
    $('suggest').hidden = true;
    sgActive = -1;
    run();
  }

  // ---------- preview ----------
  let dlgHits = [], dlgPos = 0, dlgPath = null;
  async function openPreview(p, q) {
    remember(q);
    const r = await api.preview(p, q, opts());
    if (!r) return;
    dlgPath = p;
    $('dlgTitle').textContent = r.path;
    const body = $('dlgBody');
    body.replaceChildren();
    if (r.error) body.append(el('div', 'notice', `中身を読めませんでした（${r.error}）。「開く」で元のアプリから確認できます。`));
    else if (!r.lines.length || (r.lines.length === 1 && !r.lines[0])) body.append(el('div', 'notice', '中身の文字がありません（ファイル名だけで検索しています。画像は文字認識が終わると中身も検索できます）。「開く」で元のアプリから確認できます。'));
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

  // ---------- settings ----------
  async function openSettings() {
    prefs = await api.getSettings();
    const sel = $('setShortcut');
    sel.replaceChildren(...prefs.shortcuts.map((k) => new Option(keyLabel(k), k)));
    sel.value = prefs.shortcut;
    $('setCloseToTray').checked = prefs.closeToTray;
    $('setOpenAtLogin').checked = prefs.openAtLogin;
    $('setOcr').checked = prefs.ocr;
    $('setExcludeNames').value = prefs.excludeNames.join('\n');
    $('setExcludeExts').value = prefs.excludeExts.join(', ');
    renderShortcutHint(await api.shortcutStatus());
    renderUpdate(await api.updateState());
    $('settings').showModal();
  }
  function renderShortcutHint(s) {
    const hint = $('shortcutHint');
    hint.className = s.ok ? 'hint' : 'hint bad';
    hint.textContent = s.ok
      ? `どの画面からでも ${keyLabel(s.shortcut)} でこの画面を呼び出せます（もう一度押すと隠れます）。`
      : `${keyLabel(s.shortcut)} はほかのアプリが使っているため登録できませんでした。別のキーを選んでください。`;
  }
  $('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    prefs = await api.setSettings({
      shortcut: $('setShortcut').value,
      closeToTray: $('setCloseToTray').checked,
      openAtLogin: $('setOpenAtLogin').checked,
      ocr: $('setOcr').checked,
      excludeNames: $('setExcludeNames').value.split('\n'),
      excludeExts: $('setExcludeExts').value.split(/[,、\s]+/),
    });
    $('settings').close();
  });
  $('settingsCancel').onclick = () => $('settings').close();
  $('clearHistory').onclick = async () => { prefs = await api.clearHistory(); $('clearHistory').textContent = '消しました'; setTimeout(() => ($('clearHistory').textContent = '検索履歴を消す'), 1500); };
  $('checkUpdate').onclick = async () => renderUpdate(await api.checkUpdate());
  api.onShortcutStatus((s) => { if ($('settings').open) renderShortcutHint(s); });

  // ---------- updates ----------
  function renderUpdate(u) {
    const text = {
      dev: '開発版のため自動アップデートは使いません。',
      idle: 'まもなく新しい版を確認します。',
      checking: '新しい版を確認しています…',
      latest: `最新の版です（v${state ? state.version : ''}）。`,
      downloading: `新しい版 v${u.version || ''} をダウンロードしています… ${u.percent || 0}%`,
      ready: `新しい版 v${u.version} の準備ができました。次に終了したとき、または「再起動して更新」で入れ替わります。`,
      error: `新しい版を確認できませんでした（${u.message || '通信エラー'}）。`,
    }[u.status] || '';
    $('updateStatus').textContent = text;
    $('updateBanner').hidden = u.status !== 'ready';
    $('updateText').textContent = u.status === 'ready' ? `新しい版 v${u.version} をダウンロードしました。` : '';
  }
  api.onUpdate(renderUpdate);
  $('installUpdate').onclick = () => api.installUpdate();

  // ---------- events ----------
  $('openSettings').onclick = openSettings;
  $('addFolder').onclick = async () => renderState(await api.addFolder());
  $('rescan').onclick = async () => renderState(await api.rescan());
  $('star').onclick = async () => {
    const q = $('q').value.trim();
    if (!q) { $('q').focus(); return; }
    prefs = await api.toggleFavorite(q);
    updateStar();
  };
  let timer;
  const q = $('q');
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 200); sgActive = -1; renderSuggest(); updateStar(); });
  q.addEventListener('focus', renderSuggest);
  q.addEventListener('blur', () => setTimeout(() => ($('suggest').hidden = true), 120));
  q.addEventListener('keydown', (e) => {
    const items = $('suggest').hidden ? [] : suggestions();
    if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); sgActive = (sgActive + 1) % items.length; renderSuggest(); }
    else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); sgActive = (sgActive - 1 + items.length) % items.length; renderSuggest(); }
    else if (e.key === 'Enter') {
      if (sgActive >= 0 && items[sgActive]) { e.preventDefault(); choose(items[sgActive].s); }
      else { $('suggest').hidden = true; clearTimeout(timer); run().then(() => remember(q.value.trim())); }
    } else if (e.key === 'Escape') { $('suggest').hidden = true; sgActive = -1; }
  });
  ['optName', 'optBody', 'optCase', 'optRegex', 'optType', 'optFolder', 'optSince', 'optSort'].forEach((id) => $(id).addEventListener('change', run));
  $('dlgClose').onclick = () => $('dlg').close();
  $('dlgOpen').onclick = () => dlgPath && api.openFile(dlgPath);
  $('dlgPrev').onclick = () => jump(-1);
  $('dlgNext').onclick = () => jump(1);
  $('dlg').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'F3') { e.preventDefault(); jump(e.shiftKey ? -1 : 1); } });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey && e.key.toLowerCase() === 'f') || (e.key === '/' && document.activeElement !== q)) {
      if ($('dlg').open || $('settings').open) return;
      e.preventDefault(); q.focus(); q.select();
    }
  });
  api.onFocusSearch(() => { if (!$('dlg').open && !$('settings').open) { q.focus(); q.select(); } });

  Promise.all([api.state(), api.getSettings(), api.updateState()]).then(([s, p, u]) => {
    prefs = p;
    renderState(s);
    renderUpdate(u);
    run();
  });
})();
