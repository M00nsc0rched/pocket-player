// Pocket Player — imports an RPG Maker MV (or any static web) game from a .zip
// into the browser's Cache Storage, then serves it offline via the service worker.
// The game's files live only on this device; this tool ships no game content.
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
  const GAME_CACHE = 'pp-game-v1';
  const META_KEY = 'pp-meta-v1';
  // displayed on the page; keep in step with SHELL in sw.js — the page is served
  // from that cache, so what you see is what is actually running
  const PP_VERSION = 5;

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
  function meta(){ try { return JSON.parse(localStorage.getItem(META_KEY)); } catch(e){ return null; } }
  function setMeta(m){ if (m) localStorage.setItem(META_KEY, JSON.stringify(m)); else localStorage.removeItem(META_KEY); }

  async function importZip(file, onProgress){
    if (!('serviceWorker' in navigator)) throw new Error('Service workers are unavailable in this browser.');
    await navigator.serviceWorker.ready;
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(()=>{});
    // keep the screen awake through a long import (best effort)
    let wake = null;
    try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch(e){}
    try { return await doImport(file, onProgress); }
    finally { try { if (wake) wake.release(); } catch(e){} }
  }

  async function doImport(file, onProgress){

    await caches.delete(GAME_CACHE);
    const cache = await caches.open(GAME_CACHE);

    const done = [];              // finished entries awaiting cache.put
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
        await cache.put(new Request('game/' + name.split('/').map(encodeURIComponent).join('/')),
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

    if (!filesStored) { await caches.delete(GAME_CACHE); throw new Error('The zip contained no usable files.'); }
    if (!indexPath) { await caches.delete(GAME_CACHE); throw new Error('No index.html found in the zip — is this a web/RPG Maker MV game?'); }

    const m = { name: file.name.replace(/\.zip$/i, ''), files: filesStored, bytes: bytesStored,
      index: indexPath.split('/').map(encodeURIComponent).join('/'), date: Date.now() };
    setMeta(m);
    return m;
  }

  async function deleteGame(){
    await caches.delete(GAME_CACHE);
    setMeta(null);
  }

  function play(){
    const m = meta();
    if (m) window.location.href = 'game/' + m.index;
  }

  // ---------------- UI ----------------
  async function refresh(){
    const m = meta();
    $('no-game').style.display = m ? 'none' : '';
    $('has-game').style.display = m ? '' : 'none';
    if (m){
      $('game-name').textContent = m.name;
      $('game-info').textContent = `${m.files.toLocaleString()} files · ${fmtMB(m.bytes)} · imported ${new Date(m.date).toLocaleDateString()}`;
    }
    if (navigator.storage && navigator.storage.estimate){
      try {
        const est = await navigator.storage.estimate();
        $('quota').textContent = `Storage: ${fmtMB(est.usage||0)} used of ${fmtMB(est.quota||0)} available`;
      } catch(e){}
    }
  }

  function setBusy(b){
    $('btn-import').disabled = b;
    $('btn-play').disabled = b;
    $('btn-delete').disabled = b;
    $('progress-wrap').style.display = b ? '' : 'none';
  }

  async function onPick(file){
    if (!file) return;
    setBusy(true);
    $('status').textContent = 'Importing ' + file.name + '…';
    try {
      const m = await importZip(file, p => {
        const pct = Math.round(p.read / p.total * 100);
        $('progress-fill').style.width = pct + '%';
        $('status').textContent = `Importing… ${pct}% · ${p.files.toLocaleString()} files · ${fmtMB(p.bytes)}`;
      });
      $('status').textContent = `Done — ${m.name} is installed. ${m.files.toLocaleString()} files, ${fmtMB(m.bytes)}.`;
    } catch(err){
      $('status').textContent = 'Import failed: ' + (err && err.message || err);
    }
    setBusy(false);
    refresh();
  }

  window.PP = { importZip, deleteGame, play, meta, refresh, onPick };

  window.addEventListener('load', () => {
    $('ver').textContent = 'Pocket Player v' + PP_VERSION;
    if ('serviceWorker' in navigator && window.isSecureContext)
      navigator.serviceWorker.register('sw.js').catch(()=>{});
    // arrived here from a game URL with nothing imported in THIS browser/app copy
    if (new URLSearchParams(location.search).has('nogame')){
      $('status').textContent = 'No game is imported in THIS copy of the player. ' +
        'Safari and the Home Screen app have separate storage — import the zip here, inside this app.';
    } else if (navigator.standalone === true && !meta()){
      $('status').textContent = 'Installed as an app. Note: the app has its own storage — ' +
        'import the zip HERE (a Safari import does not carry over).';
    }
    $('file').addEventListener('change', e => onPick(e.target.files[0]));
    $('btn-import').addEventListener('click', () => $('file').click());
    $('btn-play').addEventListener('click', play);
    $('btn-delete').addEventListener('click', async () => {
      if (!confirm('Remove the imported game from this device? (In-game saves are kept.)')) return;
      await deleteGame(); $('status').textContent = 'Game removed.'; refresh();
    });
    refresh();
  });
})();
