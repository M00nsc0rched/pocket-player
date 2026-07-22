// Pocket Player — imports RPG Maker MV (or any static web) games from .zip files
// into the browser's Cache Storage, then serves them offline via the service worker.
// Games live only on this device; this tool ships no game content.
//
// Library model: several games coexist. Each new game gets its own id, its own
// cache (pp-game-<id>) and its own URL base (g/<id>/). The original single-slot
// install (cache pp-game-v1, base game/, meta pp-meta-v1) is preserved as-is so
// updating the tool never disturbs an already-installed game or its saves.
(function(){
  'use strict';

  const MIME = {
    '.html':'text/html; charset=utf-8', '.htm':'text/html; charset=utf-8',
    '.js':'application/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
    '.json':'application/json; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
    '.gif':'image/gif', '.svg':'image/svg+xml', '.ico':'image/x-icon', '.txt':'text/plain',
    '.ogg':'audio/ogg', '.m4a':'audio/mp4', '.wav':'audio/wav', '.mp3':'audio/mpeg',
    '.webm':'video/webm', '.mp4':'video/mp4',
    '.ttf':'font/ttf', '.otf':'font/otf', '.woff':'font/woff', '.woff2':'font/woff2',
  };
  const LEGACY_META = 'pp-meta-v1';      // the original single-slot game's record
  const LEGACY_CACHE = 'pp-game-v1';
  const GAMES_KEY = 'pp-games-v1';       // the library: array of new games
  // displayed on the page; keep in step with SHELL in sw.js
  const PP_VERSION = 10;

  const $ = id => document.getElementById(id);
  const fmtMB = b => (b / 1048576).toFixed(1) + ' MB';

  function mimeOf(path){
    const i = path.lastIndexOf('.');
    return (i >= 0 && MIME[path.slice(i).toLowerCase()]) || 'application/octet-stream';
  }
  function normalizeName(name){
    let n = name.replace(/\\/g, '/');
    while (n.startsWith('./')) n = n.slice(2);
    while (n.startsWith('/')) n = n.slice(1);
    return n;
  }
  function isJunk(n){
    return n === '' || n.endsWith('/') || n.startsWith('__MACOSX/') ||
      n.split('/').pop() === '.DS_Store' || n.split('/').pop() === 'Thumbs.db';
  }
  function readJSON(key){ try { return JSON.parse(localStorage.getItem(key)); } catch(e){ return null; } }
  function writeJSON(key, v){ try { if (v) localStorage.setItem(key, JSON.stringify(v)); else localStorage.removeItem(key); } catch(e){} }

  // ---- the library ----
  function newGames(){ return readJSON(GAMES_KEY) || []; }
  function saveGames(list){ writeJSON(GAMES_KEY, list); }
  function legacyGame(){
    const m = readJSON(LEGACY_META);
    if (!m) return null;
    return { id:'legacy', name:m.name, files:m.files, bytes:m.bytes, index:m.index,
      date:m.date, base:'game/', cache:LEGACY_CACHE, legacy:true };
  }
  // every installed game, legacy first
  function allGames(){
    const list = [];
    const lg = legacyGame(); if (lg) list.push(lg);
    for (const g of newGames()) list.push(Object.assign({ base:'g/'+g.id+'/', cache:'pp-game-'+g.id }, g));
    return list;
  }

  async function importZip(file, onProgress){
    if (!('serviceWorker' in navigator)) throw new Error('Service workers are unavailable in this browser.');
    await navigator.serviceWorker.ready;
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(()=>{});
    let wake = null;
    try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch(e){}
    try { return await doImport(file, onProgress); }
    finally { try { if (wake) wake.release(); } catch(e){} }
  }

  async function doImport(file, onProgress){
    // a fresh id, cache and URL base — never touches other installed games
    const id = 'g' + Date.now().toString(36) + Math.floor(Math.random()*1296).toString(36);
    const cacheName = 'pp-game-' + id, base = 'g/' + id + '/';
    const cache = await caches.open(cacheName);

    const done = [];
    let filesStored = 0, bytesStored = 0, indexPath = null, aborted = null;

    const unzipper = new fflate.Unzip();
    unzipper.register(fflate.UnzipInflate);
    unzipper.onfile = (f) => {
      const name = normalizeName(f.name);
      if (isJunk(name)) return;
      const chunks = [];
      f.ondata = (err, chunk, final) => {
        if (err){ aborted = err; return; }
        if (chunk && chunk.length) chunks.push(chunk);
        if (final) done.push({ name, blob: new Blob(chunks, { type: mimeOf(name) }) });
      };
      f.start();
    };

    const flush = async () => {
      while (done.length){
        const { name, blob } = done.shift();
        const key = base + name.split('/').map(encodeURIComponent).join('/');
        await cache.put(new Request(key),
          new Response(blob, { headers: { 'Content-Type': blob.type, 'Content-Length': String(blob.size) } }));
        filesStored++; bytesStored += blob.size;
        if (name.split('/').pop() === 'index.html'){
          const depth = name.split('/').length;
          if (!indexPath || depth < indexPath.split('/').length) indexPath = name;
        }
      }
    };

    const SLICE = 8 * 1048576;
    for (let off = 0; off < file.size; off += SLICE){
      const buf = new Uint8Array(await file.slice(off, Math.min(off + SLICE, file.size)).arrayBuffer());
      const final = off + SLICE >= file.size;
      unzipper.push(buf, final);
      if (aborted) throw aborted;
      await flush();
      if (onProgress) onProgress({ read: Math.min(off + SLICE, file.size), total: file.size, files: filesStored, bytes: bytesStored });
    }
    await flush();

    if (!filesStored) { await caches.delete(cacheName); throw new Error('The zip contained no usable files.'); }
    if (!indexPath) { await caches.delete(cacheName); throw new Error('No index.html found in the zip — is this a web/RPG Maker MV game?'); }

    const rec = { id, name: file.name.replace(/\.zip$/i, ''), files: filesStored, bytes: bytesStored,
      index: indexPath.split('/').map(encodeURIComponent).join('/'), date: Date.now() };
    const list = newGames(); list.push(rec); saveGames(list);
    return rec;
  }

  async function deleteGame(game){
    await caches.delete(game.cache);
    if (game.legacy){ writeJSON(LEGACY_META, null); }
    else { saveGames(newGames().filter(g => g.id !== game.id)); }
  }

  function play(game){ window.location.href = game.base + game.index; }

  // ---------------- UI ----------------
  async function refresh(){
    const games = allGames();
    const list = $('games'); list.innerHTML = '';
    $('empty').style.display = games.length ? 'none' : '';
    for (const g of games){
      const row = U('div', 'game');
      const info = U('div', 'ginfo');
      info.appendChild(U('div', 'gname', g.name));
      info.appendChild(U('div', 'gmeta', `${g.files.toLocaleString()} files · ${fmtMB(g.bytes)} · ${new Date(g.date).toLocaleDateString()}`));
      row.appendChild(info);
      const playBtn = U('button', 'gplay', '▶');
      playBtn.title = 'Play'; playBtn.onclick = () => play(g);
      row.appendChild(playBtn);
      const del = U('button', 'gdel', '✕');
      del.title = 'Remove'; del.onclick = async () => {
        if (!confirm(`Remove “${g.name}” from this device? Its saves are kept.`)) return;
        await deleteGame(g); status(`Removed ${g.name}.`); refresh();
      };
      row.appendChild(del);
      list.appendChild(row);
    }
    if (navigator.storage && navigator.storage.estimate){
      try { const est = await navigator.storage.estimate();
        $('quota').textContent = `Storage: ${fmtMB(est.usage||0)} used of ${fmtMB(est.quota||0)} available`;
      } catch(e){}
    }
  }
  function U(tag, cls, text){ const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function status(t){ $('status').textContent = t; }

  function setBusy(b){
    $('btn-import').disabled = b;
    $('progress-wrap').style.display = b ? '' : 'none';
    for (const el of document.querySelectorAll('.gplay,.gdel')) el.disabled = b;
  }

  async function onPick(file){
    if (!file) return;
    setBusy(true);
    status('Importing ' + file.name + '… keep this screen open.');
    try {
      const m = await importZip(file, p => {
        const pct = Math.round(p.read / p.total * 100);
        $('progress-fill').style.width = pct + '%';
        status(`Importing… ${pct}% · ${p.files.toLocaleString()} files · ${fmtMB(p.bytes)}`);
      });
      status(`Done — ${m.name} added. ${m.files.toLocaleString()} files, ${fmtMB(m.bytes)}.`);
    } catch(err){
      status('Import failed: ' + (err && err.message || err));
    }
    $('progress-fill').style.width = '0%';
    setBusy(false);
    refresh();
  }

  window.PP = { importZip, deleteGame, play, allGames, refresh, onPick };

  window.addEventListener('load', () => {
    $('ver').textContent = 'Pocket Player v' + PP_VERSION;
    if ('serviceWorker' in navigator && window.isSecureContext)
      navigator.serviceWorker.register('sw.js').catch(()=>{});
    if (new URLSearchParams(location.search).has('nogame')){
      status('That game is not imported in THIS copy of the player. Safari and the Home Screen app have separate storage — import the zip here, inside this app.');
    } else if (navigator.standalone === true && !allGames().length){
      status('Installed as an app. Note: the app has its own storage — import your zip HERE (a Safari import does not carry over).');
    }
    $('file').addEventListener('change', e => { onPick(e.target.files[0]); e.target.value = ''; });
    $('btn-import').addEventListener('click', () => $('file').click());
    refresh();
  });
})();
