// Pocket Player — N64 player page (n64.html?id=<library id>).
// Runs an imported N64 ROM in the vendored EmulatorJS 4.2.3 (emu/ejs-4.2.3/,
// mupen64plus_next core: GLideN64 + HLE audio), fully offline:
//  1. One tap starts everything. That gesture unlocks iOS audio: the emulator
//     creates its AudioContext much later (after the core and ROM load), outside
//     any gesture, so we hand it a context we unlocked in the tap.
//  2. The ROM is read straight from this game's Cache Storage and passed to
//     EmulatorJS as an ArrayBuffer — no network, no HEAD request, no extra
//     IndexedDB copy of 64 MB.
//  3. The emulator's core archives are unzipped on the main thread with fflate
//     instead of in EmulatorJS's blob-URL web worker.
//  4. In-game saves (cartridge EEPROM/SRAM) live in EmulatorJS's IndexedDB as
//     /data/saves/<ROM key>.srm. EmulatorJS only flushes them on a timer and on
//     beforeunload (unreliable on iOS), so we also flush whenever the app is
//     hidden and before going back to the library.
(function(){
  'use strict';

  const EJS_PATH = 'emu/ejs-4.2.3/';
  const GAMES_KEY = 'pp-games-v1';
  // without these the emulator cannot start (the rest are optional fallbacks)
  const REQUIRED = /loader\.js|emulator\.min\.|reports\/mupen64plus_next\.json|mupen64plus_next-wasm\.data/;
  const $ = id => document.getElementById(id);

  // ---- which game ----
  const id = new URLSearchParams(location.search).get('id') || '';
  let rec = null;
  try { rec = (JSON.parse(localStorage.getItem(GAMES_KEY)) || []).find(g => g && g.id === id && g.type === 'n64') || null; } catch(e){}
  if (!rec){ location.replace('./?nogame=1'); return; }
  // names the save file (/data/saves/<key>.srm), the settings and the save state;
  // derived from the ROM header, so a re-imported ROM finds its saves again
  const gameName = rec.key + '.' + rec.ext;
  document.title = rec.name + ' — Pocket Player';
  $('pp-name').textContent = rec.name;
  if (window.matchMedia && matchMedia('(orientation: portrait)').matches && navigator.maxTouchPoints > 0)
    $('pp-hint').textContent = 'Tap to start · turn the phone sideways for the full controller';

  // ---- messages ----
  function status(text, bad){ const s = $('pp-status'); s.textContent = text || ''; s.classList.toggle('bad', !!bad); }
  let toastTimer = null;
  function toast(text, ms){
    const t = $('pp-toast'); t.textContent = text; t.classList.add('on');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), ms || 3500);
  }
  function fail(text){
    const tap = $('pp-tap');
    tap.style.display = ''; tap.disabled = true;
    $('pp-play').style.display = 'none'; $('pp-hint').textContent = '';
    status(text, true);
  }

  // ---- audio (iOS) ----
  // Wrap the AudioContext constructor: the first context the emulator asks for
  // is the one we created and unlocked inside the tap. Every later tap / key
  // also resumes any context that isn't running (iOS suspends or "interrupts"
  // audio after calls, Siri, or a trip to the home screen).
  const RealAC = window.AudioContext || window.webkitAudioContext;
  const contexts = [];
  let unlocked = null;
  if (RealAC){
    const Wrapped = function(opts){
      if (unlocked && !(opts && opts.sampleRate && opts.sampleRate !== unlocked.sampleRate)){
        const ctx = unlocked; unlocked = null;
        return ctx;
      }
      const ctx = opts ? new RealAC(opts) : new RealAC();
      contexts.push(ctx);
      return ctx;
    };
    Wrapped.prototype = RealAC.prototype;
    window.AudioContext = Wrapped;
    if (window.webkitAudioContext) window.webkitAudioContext = Wrapped;
  }
  function unlockAudio(){
    // 'playback': play even with the ring/silent switch on, like a game should
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch(e){}
    if (!RealAC || unlocked) return;
    try {
      const ctx = new RealAC();
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      src.connect(ctx.destination);
      src.start(0);
      if (ctx.resume) ctx.resume().catch(() => {});
      unlocked = ctx; contexts.push(ctx);
    } catch(e){}
  }
  function stalled(ctx){ return ctx.state !== 'running' && ctx.state !== 'closed'; }
  function resumeAudio(){
    for (const ctx of contexts) if (stalled(ctx)){ try { ctx.resume().catch(() => {}); } catch(e){} }
  }
  for (const type of ['touchend', 'click', 'keydown', 'pointerup'])
    document.addEventListener(type, resumeAudio, true);

  // ---- keep the screen on while playing ----
  let wakeLock = null;
  async function keepAwake(){
    try {
      if (navigator.wakeLock && !wakeLock){
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch(e){}
  }

  // ---- saves ----
  function emulator(){ const e = window.EJS_emulator; return e && e.started && e.gameManager ? e : null; }
  // core → /data/saves/<key>.srm → IndexedDB, now. done() runs once, at most ~1.5 s later.
  function flushSaves(done){
    let finished = false;
    const finish = () => { if (finished) return; finished = true; if (done) done(); };
    const emu = emulator();
    if (!emu) return finish();
    try {
      emu.gameManager.saveSaveFiles();
      emu.gameManager.FS.syncfs(false, finish);
      setTimeout(finish, 1500);
    } catch(e){ finish(); }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden'){ flushSaves(); return; }
    keepAwake();
    resumeAudio();
    setTimeout(() => { if (emulator() && contexts.some(stalled)) toast('Tap the screen to turn the sound back on'); }, 1200);
  });
  window.addEventListener('pagehide', () => flushSaves());

  // EmulatorJS's "Export Save File" → the iOS share sheet (Save to Files …)
  // instead of a download link, which an installed web app handles poorly.
  async function exportSave(d){
    const bytes = d && d.save;
    if (!bytes || !bytes.length){ toast('There is no save file yet.'); return; }
    const fname = (rec.name.replace(/[\\/:*?"<>|]+/g, '').trim() || rec.key) + '.srm';
    const file = new File([bytes], fname, { type: 'application/octet-stream' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })){ await navigator.share({ files: [file] }); return; }
    } catch(e){ if (e && e.name === 'AbortError') return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = fname;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
  }

  // ---- back to the library ----
  $('pp-back').addEventListener('click', () => {
    if (emulator() && !confirm('Back to the library? Your in-game saves are kept.')) return;
    $('pp-back').disabled = true;
    flushSaves(() => { location.href = './'; });
  });

  // ---- core archives: unzip on the main thread ----
  // emulator.min.js publishes its decompressor as window.EJS_COMPRESSION. Our
  // vendored cores are plain ZIPs (see emu/ejs-4.2.3/SOURCES.md), so we catch
  // that assignment and unzip ZIPs synchronously with fflate. Anything else —
  // or any failure — still goes through the stock worker.
  let Compression;
  Object.defineProperty(window, 'EJS_COMPRESSION', {
    configurable: true, enumerable: true,
    get(){ return Compression; },
    set(C){
      try {
        const stock = C.prototype.decompressFile;
        C.prototype.decompressFile = function(method, data, updateMsg, fileCb){
          if (method === 'zip' && window.fflate){
            try {
              const files = fflate.unzipSync(data);
              const out = {};
              for (const name in files){
                if (typeof fileCb === 'function'){ fileCb(name, files[name]); out[name] = true; }
                else out[name] = files[name];
              }
              return Promise.resolve(out);
            } catch(e){ console.warn('[Pocket Player] main-thread unzip failed, using the worker', e); }
          }
          return stock.call(this, method, data, updateMsg, fileCb);
        };
      } catch(e){}
      Compression = C;
    },
  });

  // ---- EmulatorJS hooks ----
  function onReady(){
    const emu = window.EJS_emulator;
    // EmulatorJS has its own reference now; don't pin another 64 MB on window
    try { delete window.EJS_gameUrl; } catch(e){ window.EJS_gameUrl = undefined; }
    // the file system is up and the ROM is about to be written into it: let it
    // take ownership of EmulatorJS's private copy instead of making a third one
    emu.on('saveDatabaseLoaded', FS => {
      const write = FS.writeFile;
      FS.writeFile = function(path, data, opts){
        if (opts === undefined && data instanceof Uint8Array && String(path).split('/').pop() === gameName){
          FS.writeFile = write;
          try { return write.call(FS, path, data, { canOwn: true }); } catch(e){}
        }
        return write.apply(FS, arguments);
      };
    });
  }
  function onStart(){
    started = true;
    try { console.log('[Pocket Player] in-game saves:', window.EJS_emulator.gameManager.getSaveFilePath()); } catch(e){}
  }

  // ---- boot ----
  // Ask the service worker to have the whole emulator cached (downloading what's
  // missing). Resolves { ready, missing } — or { ready: true } when no worker
  // controls this page (EmulatorJS then fetches the files itself).
  function emulatorFiles(){
    return new Promise(resolve => {
      if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return resolve({ ready: true });
      const t = setTimeout(() => resolve({ ready: true, slow: true }), 90000);
      navigator.serviceWorker.ready.then(reg => {
        const ch = new MessageChannel();
        ch.port1.onmessage = e => { clearTimeout(t); resolve(e.data || { ready: true }); };
        reg.active.postMessage({ type: 'pp-emu' }, [ch.port2]);
      }, () => { clearTimeout(t); resolve({ ready: true }); });
    });
  }
  async function readRom(){
    const res = await (await caches.open('pp-game-' + rec.id)).match('g/' + rec.id + '/' + rec.rom);
    if (!res) return null;
    return res.arrayBuffer();
  }

  let booting = false, started = false;
  // until the game runs, surface script errors on the start screen
  window.addEventListener('error', e => {
    if (!booting || started) return;
    status('Error: ' + (e.message || 'unknown'), true);
    toast('Error: ' + (e.message || 'unknown'), 8000);
  });

  async function boot(){
    booting = true;
    status('Preparing the emulator…');
    const files = await emulatorFiles();
    if (!files.ready && (files.missing || []).some(f => REQUIRED.test(f)))
      return fail('The N64 emulator is not on this device yet.\nConnect to the internet once and start the game again —\nafter that it works offline.');
    status('Loading the ROM…');
    const rom = await readRom();
    if (!rom) return fail('This game\'s ROM is missing from this device. Remove it and import it again.');

    // EmulatorJS configuration (see emu/ejs-4.2.3/loader.js for the mapping)
    window.EJS_player = '#game';
    window.EJS_core = 'mupen64plus_next';    // never the generic 'n64': on iOS that picks parallel_n64
    window.EJS_gameName = gameName;
    window.EJS_gameUrl = rom;                 // bytes, not a URL
    window.EJS_pathtodata = EJS_PATH;
    window.EJS_startOnLoaded = true;          // our tap already was the "start" gesture
    window.EJS_disableDatabases = true;       // no IndexedDB copies of the core or the ROM
    window.EJS_disableAutoLang = false;       // (inverted in 4.2.3) → no localization download
    window.EJS_threads = false;
    window.EJS_volume = 1;
    window.EJS_color = '#d0a84e';
    window.EJS_backgroundColor = '#000';
    window.EJS_Buttons = {
      netplay: false, screenRecord: false, cacheManager: false,
      exitEmulation: false,                   // our ✕ saves first, then leaves
      fullscreen: !!(document.fullscreenEnabled || document.webkitFullscreenEnabled),
    };
    window.EJS_defaultOptions = {
      'save-save-interval': '30',             // seconds (EmulatorJS default: 5 minutes)
      'save-state-location': 'browser',       // save states in IndexedDB, not a download
    };
    // the launcher's "On-screen controls" switch (off → e.g. a Bluetooth controller)
    try { if (localStorage.getItem('pp-onscreen-controls') === '0') window.EJS_defaultOptions['virtual-gamepad'] = 'disabled'; } catch(e){}
    window.EJS_ready = onReady;
    window.EJS_onGameStart = onStart;
    window.EJS_onSaveSave = exportSave;

    $('pp-tap').style.display = 'none';
    const s = document.createElement('script');
    s.src = EJS_PATH + 'loader.js';
    s.onerror = () => fail('Could not load the emulator (' + EJS_PATH + 'loader.js).');
    document.body.appendChild(s);
  }

  $('pp-tap').addEventListener('click', () => {
    if (booting) return;
    unlockAudio();          // synchronously, inside the gesture
    keepAwake();
    $('pp-tap').disabled = true;
    $('pp-play').style.opacity = '.35';
    boot().catch(err => fail('Could not start: ' + (err && err.message || err)));
  });
})();
