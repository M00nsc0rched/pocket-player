// Pocket Player — imports RPG Maker MV (or any static web) games from .zip files
// into the browser's Cache Storage, then serves them offline via the service worker.
// Games live only on this device; this tool ships no game content.
//
// Library model: several games coexist. Each new game gets its own id, its own
// cache (pp-game-<id>) and its own URL base (g/<id>/). The original single-slot
// install (cache pp-game-v1, base game/, meta pp-meta-v1) is preserved as-is so
// updating the tool never disturbs an already-installed game or its saves.
//
// N64: a zip holding a .z64/.n64/.v64 ROM (and no index.html), or a bare ROM
// file, becomes a library entry of type 'n64'. Its ROM is stored the same way
// (pp-game-<id>, g/<id>/…) and ▶ opens n64.html, which runs it in the vendored
// emulator (emu/). N64 saves are keyed by the ROM header, not by the import id,
// so removing and re-importing the same ROM keeps them.
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
  const PP_VERSION = 22;
  const ROM_EXT = /\.(z64|n64|v64)$/i;

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
  // N64 ROM header (first 64 bytes, any of the three byte orders) → its byte
  // order, CRCs, internal title and 4-char game code; null if not an N64 ROM.
  //   z64 = big-endian (native) · v64 = 16-bit byte-swapped · n64 = 32-bit little-endian
  function n64Header(u8){
    if (!u8 || u8.length < 64) return null;
    const magic = ((u8[0] << 24) | (u8[1] << 16) | (u8[2] << 8) | u8[3]) >>> 0;
    const ext = magic === 0x80371240 ? 'z64' : magic === 0x37804012 ? 'v64' : magic === 0x40123780 ? 'n64' : null;
    if (!ext) return null;
    const b = new Uint8Array(64);
    for (let i = 0; i < 64; i++)
      b[i] = u8[ext === 'v64' ? i ^ 1 : ext === 'n64' ? (i & ~3) | (3 - (i & 3)) : i];
    const hex = o => Array.from(b.subarray(o, o + 4), x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
    const ascii = (s, e) => String.fromCharCode.apply(null, b.subarray(s, e)).replace(/[^\x20-\x7e]/g, '').trim();
    const code = ascii(0x3b, 0x3f).replace(/[^A-Za-z0-9]/g, '');
    const crc1 = hex(0x10), crc2 = hex(0x14);
    // stable per ROM: names the emulator's save file and settings
    return { ext, crc1, crc2, code, title: ascii(0x20, 0x34), key: 'N64-' + (code || 'ROM') + '-' + crc1 };
  }
  async function readHeader(blob){ return n64Header(new Uint8Array(await blob.slice(0, 64).arrayBuffer())); }
  function n64Record(id, name, files, bytes, romPath, hdr){
    return { id, type: 'n64', name, files, bytes, date: Date.now(),
      rom: romPath.split('/').map(encodeURIComponent).join('/'),
      key: hdr.key, ext: hdr.ext, title: hdr.title };
  }
  function newId(){ return 'g' + Date.now().toString(36) + Math.floor(Math.random()*1296).toString(36); }

  // Ask the service worker to cache the whole N64 emulator for offline play.
  // Resolves { ready, missing } — never rejects (a missing worker counts as
  // "unknown", reported as not ready).
  function ensureEmulator(){
    return new Promise(resolve => {
      if (!('serviceWorker' in navigator)) return resolve({ ready: false, missing: ['service worker'] });
      const t = setTimeout(() => resolve({ ready: false, missing: ['timeout'] }), 120000);
      navigator.serviceWorker.ready.then(reg => {
        const ch = new MessageChannel();
        ch.port1.onmessage = e => { clearTimeout(t); resolve(e.data || { ready: false, missing: [] }); };
        reg.active.postMessage({ type: 'pp-emu' }, [ch.port2]);
      }, () => { clearTimeout(t); resolve({ ready: false, missing: ['service worker'] }); });
    });
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
    try {
      // a bare N64 ROM (recognised by its header, whatever the extension)
      if (await readHeader(file)) return await doImportRom(file, onProgress);
      if (ROM_EXT.test(file.name)) throw new Error('This file is not a valid N64 ROM (unknown header).');
      return await doImport(file, onProgress);
    }
    finally { try { if (wake) wake.release(); } catch(e){} }
  }

  async function doImportRom(file, onProgress){
    const id = newId();
    const cacheName = 'pp-game-' + id, base = 'g/' + id + '/';
    const cache = await caches.open(cacheName);
    const hdr = await readHeader(file);
    const name = normalizeName(file.name).split('/').pop() || ('rom.' + hdr.ext);
    await cache.put(new Request(base + encodeURIComponent(name)),
      new Response(file, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size) } }));
    if (onProgress) onProgress({ read: file.size, total: file.size, files: 1, bytes: file.size });
    const rec = n64Record(id, name.replace(ROM_EXT, ''), 1, file.size, name, hdr);
    const list = newGames(); list.push(rec); saveGames(list);
    return rec;
  }

  async function doImport(file, onProgress){
    // a fresh id, cache and URL base — never touches other installed games
    const id = newId();
    const cacheName = 'pp-game-' + id, base = 'g/' + id + '/';
    const cache = await caches.open(cacheName);

    const done = [];
    let filesStored = 0, bytesStored = 0, indexPath = null, aborted = null;
    let romPath = null, romHeader = null;   // the shallowest valid N64 ROM in the zip

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
        if (ROM_EXT.test(name) && (!romPath || name.split('/').length < romPath.split('/').length)){
          const hdr = await readHeader(blob);
          if (hdr){ romPath = name; romHeader = hdr; }
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
    const name = file.name.replace(/\.zip$/i, '');
    let rec;
    if (indexPath){
      // a web game (RPG Maker MV …) — an index.html wins over any ROM next to it
      rec = { id, name, files: filesStored, bytes: bytesStored,
        index: indexPath.split('/').map(encodeURIComponent).join('/'), date: Date.now() };
    } else if (romPath){
      rec = n64Record(id, name, filesStored, bytesStored, romPath, romHeader);
    } else {
      await caches.delete(cacheName);
      throw new Error('No index.html or N64 ROM (.z64 / .n64 / .v64) found in the zip.');
    }
    const list = newGames(); list.push(rec); saveGames(list);
    return rec;
  }

  async function deleteGame(game){
    await caches.delete(game.cache);
    if (game.legacy){ writeJSON(LEGACY_META, null); }
    else { saveGames(newGames().filter(g => g.id !== game.id)); }
  }

  function play(game){
    window.location.href = game.type === 'n64' ? 'n64.html?id=' + encodeURIComponent(game.id) : game.base + game.index;
  }

  // ---------------- UI ----------------
  async function refresh(){
    const games = allGames();
    const list = $('games'); list.innerHTML = '';
    $('empty').style.display = games.length ? 'none' : '';
    for (const g of games){
      const row = U('div', 'game');
      const info = U('div', 'ginfo');
      info.appendChild(U('div', 'gname', g.name));
      const kind = g.type === 'n64' ? 'N64' : `${g.files.toLocaleString()} files`;
      info.appendChild(U('div', 'gmeta', `${kind} · ${fmtMB(g.bytes)} · ${new Date(g.date).toLocaleDateString()}`));
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
      if (m.type === 'n64'){
        // the emulator itself must be on the device too, or the game can't start offline
        status(`${m.name} added (N64, ${fmtMB(m.bytes)}). Preparing the N64 emulator for offline play…`);
        const emu = await ensureEmulator();
        status(emu.ready
          ? `Done — ${m.name} added (N64, ${fmtMB(m.bytes)}). The emulator is ready offline.`
          : `${m.name} added, but the N64 emulator could not be downloaded yet — start the game once while online, then it works offline.`);
      } else {
        status(`Done — ${m.name} added. ${m.files.toLocaleString()} files, ${fmtMB(m.bytes)}.`);
      }
    } catch(err){
      status('Import failed: ' + (err && err.message || err));
    }
    $('progress-fill').style.width = '0%';
    setBusy(false);
    refresh();
  }

  // ---- on-screen control settings ----
  // Global (un-namespaced) prefs the in-game shim reads: whether to show the
  // touch gamepad, and whether it's 8-way with diagonal walking. Defaults:
  // controls ON (unset ≠ '0'), diagonal OFF (only when '1').
  function initOpts(){
    const pad = $('opt-pad'), diag = $('opt-diag');
    if (!pad || !diag) return;
    pad.checked  = localStorage.getItem('pp-onscreen-controls') !== '0';
    diag.checked = localStorage.getItem('pp-diagonal-move') === '1';
    pad.addEventListener('change', () => { localStorage.setItem('pp-onscreen-controls', pad.checked ? '1' : '0'); });
    diag.addEventListener('change', () => { localStorage.setItem('pp-diagonal-move', diag.checked ? '1' : '0'); });
  }

  window.PP = { importZip, deleteGame, play, allGames, refresh, onPick, ensureEmulator, n64Header };

  window.addEventListener('load', () => {
    initOpts();
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
