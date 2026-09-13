// Pocket Player game shim — injected into the imported game's index.html by the
// service worker. Jobs:
//  1. Provide a harmless `require` so desktop-only (NW.js/Steam) plugin code
//     dissolves into no-ops instead of crashing the game in a browser.
//  2. Fix the mobile viewport: RPG Maker's stock page lacks width=device-width,
//     so iOS renders it at desktop width — the game overflows the screen and
//     touch coordinates land in the wrong place.
//  3. Show real, readable error messages (deduped, top-anchored so the game
//     stays reachable) instead of a frozen screen.
//  4. Never let a failed audio decode kill the game (iOS may lack the OGG
//     codec) — hand back silence instead.
//  5. Add an on-screen gamepad (D-pad + A/B/X) that drives RPG Maker's Input
//     directly, so the game is playable even when touch-to-move misfires.
//  6. Namespace each library game's localStorage by its id, so games sharing
//     this origin can't overwrite each other's saves.
(function(){
  'use strict';

  // The app-shell root (…/pocket-player/): this shim is loaded from there as
  // <script src="{root}pp-shim.js">, so its own URL's directory IS the root.
  // We load the OGG decoder bundle from the same place (the service worker
  // serves it from the app-shell cache, so it works offline).
  var ROOT = '';
  try { ROOT = ((document.currentScript && document.currentScript.src) || '').replace(/[^\/]*$/, ''); } catch(e){}

  // ---- Player-wide UI options (set on the launcher home screen) ----
  // These live under GLOBAL (un-namespaced) localStorage keys shared with the
  // launcher. §0 below rewrites Storage.prototype to prefix every key with the
  // game's id — so we capture the RAW methods now and always read/write these
  // options through them, bypassing the per-game namespace.
  var _rawGet = null, _rawSet = null;
  try { _rawGet = Storage.prototype.getItem; _rawSet = Storage.prototype.setItem; } catch(e){}
  function optGet(k){ try { return _rawGet ? _rawGet.call(window.localStorage, k) : localStorage.getItem(k); } catch(e){ return null; } }
  var OPT_PAD  = function(){ return optGet('pp-onscreen-controls') !== '0'; };  // default ON
  var OPT_DIAG = function(){ return optGet('pp-diagonal-move') === '1'; };      // default OFF

  // ---- 0. Per-game save isolation ----
  // Several games share one origin, so their localStorage saves would collide.
  // A library game runs under g/<id>/ — namespace its localStorage keys by that
  // id. The legacy single-slot game (under game/) stays UNPREFIXED so its
  // existing saves keep working untouched.
  try {
    var gm = location.pathname.match(/\/g\/([^\/]+)\//);
    if (gm && window.localStorage && window.Storage){
      var pfx = 'pp:' + gm[1] + ':';
      var SP = Storage.prototype, _g = SP.getItem, _s = SP.setItem, _r = SP.removeItem;
      SP.getItem    = function(k){ return _g.call(this, this === localStorage ? pfx + k : k); };
      SP.setItem    = function(k, v){ return _s.call(this, this === localStorage ? pfx + k : k, v); };
      SP.removeItem = function(k){ return _r.call(this, this === localStorage ? pfx + k : k); };
    }
  } catch(e){}

  // ---- 1. NW.js black hole ----
  // `process` stays undefined, so Utils.isNwjs() is still false and the engine
  // keeps using browser storage; only stray direct require() calls fall in here.
  if (typeof window.require === 'undefined' && typeof window.Proxy === 'function'){
    var hole = new Proxy(function(){}, {
      get: function(t, p){
        if (p === Symbol.toPrimitive || p === 'toString') return function(){ return ''; };
        if (p === 'valueOf') return function(){ return 0; };
        if (p === 'then') return undefined;   // not a thenable — keeps await/promise chains sane
        return hole;
      },
      apply: function(){ return hole; },
      construct: function(){ return hole; },
      set: function(){ return true; },
      has: function(){ return true; },
    });
    window.require = function(){ return hole; };
  }

  // ---- 3. error overlay (top-anchored, deduped) ----
  var seen = {};
  function overlay(msg){
    try {
      if (seen[msg]) return;              // each unique error once per session
      if (Object.keys(seen).length >= 5) return;
      seen[msg] = true;
      var d = document.createElement('div');
      d.id = 'pp-err';
      d.style.cssText = 'position:fixed;top:0;left:0;right:0;max-height:45%;background:rgba(8,7,12,.94);' +
        'color:#e0b0c0;font:12px/1.5 monospace;padding:14px 16px;z-index:2147483647;overflow:auto;' +
        'white-space:pre-wrap;border-bottom:1px solid #5a2f3e;-webkit-user-select:text';
      d.textContent = '⚠ Pocket Player caught a game error:\n\n' + msg + '\n\nTap this message to dismiss it.';
      d.addEventListener('click', function(){ d.remove(); });
      d.addEventListener('touchend', function(e){ e.preventDefault(); d.remove(); });
      (document.body || document.documentElement).appendChild(d);
      setTimeout(function(){ if (d.parentNode) d.remove(); }, 12000);
    } catch(e){}
  }
  // buggy MV plugins do eval(String(pluginParamsObject)) → eval("[object Object]"),
  // a SyntaxError that aborts only that one plugin (a cosmetic loss) while the
  // game boots on. Safari blames the plugin file, other engines blame index.html —
  // mute the signature wherever it lands. Real game syntax errors never say this.
  function benign(msg){
    return /Unexpected identifier ['"]?Object/.test(msg) || /\[object Object\]/.test(msg);
  }
  window.addEventListener('error', function(e){
    var msg = e.message || '', file = e.filename || '';
    if (benign(msg)) return;
    overlay((msg || 'unknown error') + '\n' + (file || '?') + ':' + (e.lineno || '?'));
  });
  window.addEventListener('unhandledrejection', function(e){
    var r = e && e.reason;
    overlay('Unhandled rejection: ' + (r && (r.message || r.stack || r) || 'unknown'));
  });

  // ---- 3c. save-existence fix ----
  // Saves for this game exist in localStorage (RPG File1/2/3), but RPG Global —
  // the summary the title screen's "Continue" checks — is stale/empty, so
  // isAnySavefileExists() returns false and the saves look gone. Rebuild the
  // global summary from the real save files, and (belt-and-suspenders) make the
  // existence/ownership checks fall back to the actual files. Then Continue shows
  // and every save is selectable and loadable.
  (function(){
    var tries = 0;
    var iv = setInterval(function(){
      if (typeof DataManager === 'undefined' || typeof StorageManager === 'undefined' || !window.$dataSystem){ if (++tries > 200) clearInterval(iv); return; }
      clearInterval(iv);
      setTimeout(function(){
        try {
          var maxOf = function(){ try { return DataManager.maxSavefiles(); } catch(e){ return 99; } };
          var fileExists = function(id){ try { return StorageManager.exists(id); } catch(e){ return false; } };
          // 1) rebuild RPG Global from the actual save files (fill any gaps)
          var info; try { info = DataManager.loadGlobalInfo() || []; } catch(e){ info = []; }
          if (!Array.isArray(info)) info = [];
          var changed = false, m = maxOf();
          for (var id = 1; id <= m; id++){
            if (fileExists(id) && !info[id]){
              info[id] = { globalId: DataManager._globalId, title: $dataSystem.gameTitle, characters: [], faces: [], playtime: '', timestamp: Date.now() };
              changed = true;
            }
          }
          if (changed){
            DataManager._globalInfo = info;
            try { DataManager.saveGlobalInfo(info); } catch(e){ try { DataManager.saveGlobalInfo(); } catch(e2){} }
          }
          // 2) fall back to the real files for existence/ownership, so nothing hides them
          if (!DataManager.__ppSaveFix){
            var oa = DataManager.isAnySavefileExists.bind(DataManager);
            DataManager.isAnySavefileExists = function(){ try { if (oa()) return true; } catch(e){} for (var i = 1, mm = maxOf(); i <= mm; i++){ if (fileExists(i)) return true; } return false; };
            var ot = DataManager.isThisGameFile.bind(DataManager);
            DataManager.isThisGameFile = function(sid){ try { if (ot(sid)) return true; } catch(e){} return fileExists(sid); };
            DataManager.__ppSaveFix = true;
          }
          if (changed){
            var n = 0; for (var j = 1; j <= m; j++){ if (fileExists(j)) n++; }
            overlay('✓ Save fix: ' + n + ' save(s) restored to the menu.\nRestart the game once — "Continue" should now work.');
          }
        } catch(e){ overlay('save-fix error: ' + e); }
      }, 1500);
    }, 300);
    setTimeout(function(){ clearInterval(iv); }, 40000);
  })();

  // ---- 4. audio decode rescue + OGG Vorbis fallback ----
  // iOS Safari can't natively decode OGG Vorbis (RPG Maker MV's default audio
  // format), so BGM/BGS/ME/SE would all come back silent. We wrap decodeAudioData:
  // try the native decoder first (desktop Chrome, and iOS m4a/wav, go straight
  // through); if it fails on an 'OggS' stream, decode it ourselves with a WASM
  // Vorbis decoder (a web worker, off the main thread) and hand back a real
  // AudioBuffer. Only if THAT also fails do we return silence — the original
  // behaviour — so a genuinely broken file still never crashes the game.

  // Lazily load the decoder bundle (added to the app shell) and spin up ONE
  // shared MAIN-THREAD decoder. We deliberately do NOT use the bundle's web
  // worker: inside an iOS standalone PWA a blob-URL worker is unreliable — it
  // can abort mid-decode and the library then emits an uncatchable
  // "operation was aborted" promise rejection (and no sound). The main-thread
  // decoder is synchronous (it blocks briefly per sound) but rock-solid.
  // decodeFile() resets itself after each call, so one instance handles every
  // sound; calls are serialised through _decChain below to avoid reentrancy.
  // Nothing loads until the first OGG actually needs us.
  var _vorbis = null;
  function loadScript(src){
    return new Promise(function(res, rej){
      var s = document.createElement('script');
      s.src = src; s.charset = 'UTF-8'; s.async = true;
      s.onload = function(){ res(); };
      s.onerror = function(){ rej(new Error('failed to load ' + src)); };
      (document.head || document.documentElement).appendChild(s);
    });
  }
  function vorbisDecoder(){
    if (_vorbis) return _vorbis;
    _vorbis = loadScript(ROOT + 'ogg-vorbis-decoder.min.js').then(function(){
      var ns = window['ogg-vorbis-decoder'];
      if (!ns || !ns.OggVorbisDecoder) throw new Error('OGG decoder unavailable');
      var d = new ns.OggVorbisDecoder();
      return Promise.resolve(d.ready).then(function(){ return d; });
    });
    return _vorbis;
  }
  // Serialise decode calls: the shared main-thread decoder has one WASM heap, so
  // overlapping decodeFile() calls (several sounds loading at once) must queue.
  // CRITICAL: bound every decode with a timeout. If one decodeFile() ever wedges
  // (a bad/edge-case OGG), an un-timed serialised chain would stall FOREVER, and
  // every later sound would hang behind it — which, if the game preloads/awaits a
  // map's audio, shows up as an endless "Loading…" screen (Termina). On timeout we
  // give up on that sound (→ silence) AND drop the shared decoder so the next call
  // starts a fresh instance instead of inheriting a wedged WASM heap.
  var _decChain = Promise.resolve();
  var DECODE_TIMEOUT = 7000;
  function decodeOgg(bytes){
    var run = _decChain.then(function(){
      return vorbisDecoder().then(function(dec){
        return new Promise(function(resolve, reject){
          var settled = false;
          var t = setTimeout(function(){
            if (settled) return; settled = true;
            _vorbis = null;                       // wedged decoder — force a fresh one next time
            reject(new Error('decode timeout'));
          }, DECODE_TIMEOUT);
          Promise.resolve(dec.decodeFile(bytes)).then(function(res){
            if (settled) return; settled = true; clearTimeout(t); resolve(res);
          }, function(err){
            if (settled) return; settled = true; clearTimeout(t); _vorbis = null; reject(err);
          });
        });
      });
    });
    _decChain = run.then(function(){}, function(){});   // keep the chain alive past failures
    return run;
  }

  var AC = window.AudioContext || window.webkitAudioContext;
  if (AC && AC.prototype && AC.prototype.decodeAudioData){
    var orig = AC.prototype.decodeAudioData;

    function silenceBuffer(ctx){
      try { return ctx.createBuffer(1, Math.max(1, Math.round(ctx.sampleRate * 0.05)), ctx.sampleRate); }
      catch(e){ return null; }
    }
    function isOgg(u8){ return u8.length >= 4 && u8[0] === 0x4F && u8[1] === 0x67 && u8[2] === 0x67 && u8[3] === 0x53; }
    function toAudioBuffer(ctx, res){
      var ch = res && res.channelData, n = res && res.samplesDecoded, sr = (res && res.sampleRate) || ctx.sampleRate;
      if (!n || !ch || !ch.length) throw new Error('empty decode');
      var ab = ctx.createBuffer(ch.length, n, sr);
      for (var i = 0; i < ch.length; i++){
        if (ab.copyToChannel) ab.copyToChannel(ch[i], i);
        else ab.getChannelData(i).set(ch[i]);
      }
      return ab;
    }

    AC.prototype.decodeAudioData = function(buf, onOk, onErr){
      var ctx = this;
      // Peek at the 'OggS' magic without copying; keep a byte copy for OGG since
      // we hand it to the worker decoder (and a native attempt could detach it).
      var ogg = false, bytes = null;
      try {
        var head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength || 0));
        ogg = isOgg(head);
        if (ogg) bytes = new Uint8Array(buf.slice(0));
      } catch(e){}

      return new Promise(function(resolve, reject){
        var done = false;
        function ok(b){ if (done) return; done = true; if (onOk){ try { onOk(b); } catch(e){} } resolve(b); }
        function fail(err){ if (done) return; done = true; if (onErr){ try { onErr(err); } catch(e){} } reject(err); }
        function silence(){ var s = silenceBuffer(ctx); if (s) ok(s); else fail(new Error('decode failed')); }

        if (ogg && bytes){
          // Decode OGG Vorbis ourselves, UNCONDITIONALLY. We can't lean on the
          // native decoder here: iOS Safari not only can't decode OGG, in some
          // WebKit builds decodeAudioData never calls back at all for it (no
          // success, no error) — so waiting for it to "fail" would hang the sound
          // forever. Desktop gives up native speed but stays correct.
          decodeOgg(bytes)
            .then(function(res){ ok(toAudioBuffer(ctx, res)); })
            .catch(function(e){ overlay('OGG audio could not be decoded:\n' + (e && (e.message || e))); silence(); });
          return;
        }
        // non-OGG (m4a / wav / mp3): the platform decodes these fine; on failure
        // fall back to silence so the game never crashes.
        var p;
        try {
          p = orig.call(ctx, buf, function(b){ ok(b); }, function(){ silence(); });
        } catch(e){ silence(); return; }
        if (p && p.then) p.then(function(b){ ok(b); }, function(){ silence(); });
      });
    };
  }

  // ---- 2. mobile viewport & touch fit ----
  function fixViewport(){
    try {
      var metas = document.querySelectorAll('meta[name="viewport"]');
      for (var i = 0; i < metas.length; i++) metas[i].parentNode.removeChild(metas[i]);
      var m = document.createElement('meta');
      m.name = 'viewport';
      m.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover';
      document.head.appendChild(m);
      var h = document.documentElement.style;
      h.margin = '0'; h.padding = '0'; h.overflow = 'hidden'; h.height = '100%'; h.background = '#000';
      if (document.body){
        var b = document.body.style;
        b.margin = '0'; b.padding = '0'; b.overflow = 'hidden'; b.height = '100%'; b.background = '#000';
        b.touchAction = 'none'; b.overscrollBehavior = 'none';
      }
      // nudge the engine to re-measure at the corrected size (iOS applies async)
      window.dispatchEvent(new Event('resize'));
      setTimeout(function(){ window.dispatchEvent(new Event('resize')); }, 400);
    } catch(e){}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fixViewport);
  else fixViewport();
  window.addEventListener('orientationchange', function(){ setTimeout(fixViewport, 300); });

  // stop iOS rubber-band scrolling from stealing touches (the overlay may still scroll)
  document.addEventListener('touchmove', function(e){
    var t = e.target;
    while (t && t !== document.body){ if (t.id === 'pp-err' || t.id === 'pp-pad') return; t = t.parentNode; }
    e.preventDefault();
  }, { passive: false });

  // ---- 5. On-screen gamepad for RPG Maker MV/MZ ----
  // Touch-to-move misfires in an iOS standalone webapp; these buttons drive the
  // engine's Input state directly, sidestepping touch coordinates entirely.
  //   D-pad → up/down/left/right   A → ok (confirm)   B → escape (cancel/menu)
  //   X → shift (dash/run — held down while pressed, like the keyboard Shift)
  function inputState(){ return (window.Input && window.Input._currentState) || null; }
  function setKey(name, on){ var s = inputState(); if (s) s[name] = on; }

  // wire a button for touch + mouse; onDown/onUp fire once per press, and the
  // touch handler swallows the event so the game's canvas doesn't also see it
  function wire(el, onDown, onUp){
    var down = function(e){ if (e){ e.preventDefault(); e.stopPropagation(); } el.classList.add('on'); onDown(); };
    var up   = function(e){ if (e){ e.preventDefault(); e.stopPropagation(); } el.classList.remove('on'); onUp(); };
    el.addEventListener('touchstart', down, { passive:false });
    el.addEventListener('touchend', up);
    el.addEventListener('touchcancel', up);
    el.addEventListener('mousedown', down);
    el.addEventListener('mouseup', up);
    el.addEventListener('mouseleave', function(e){ if (el.classList.contains('on')) up(e); });
  }
  // directions are held down while pressed
  function wireHold(el, name){ wire(el, function(){ setKey(name, true); }, function(){ setKey(name, false); }); }
  // a diagonal button holds TWO directions at once (up+right, …) so the engine
  // reads Input.dir8 as a diagonal
  function wireHoldN(el, names){
    wire(el,
      function(){ names.forEach(function(n){ setKey(n, true); }); },
      function(){ names.forEach(function(n){ setKey(n, false); }); });
  }
  // actions are momentary, but held true for a minimum so a fast tap still registers a frame
  function wirePress(el, name){
    var downAt = 0, t = null;
    wire(el,
      function(){ downAt = Date.now(); if (t){ clearTimeout(t); t = null; } setKey(name, true); },
      function(){ var wait = Math.max(0, 80 - (Date.now() - downAt)); t = setTimeout(function(){ setKey(name, false); }, wait); });
  }

  function buildPad(){
    if (document.getElementById('pp-pad')) return;
    if (!inputState()) return;

    var css = document.createElement('style');
    css.textContent =
      '#pp-pad{position:fixed;inset:0;z-index:2147483000;pointer-events:none;' +
        '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;' +
        'font-family:-apple-system,Segoe UI,sans-serif;}' +
      '#pp-pad .b{position:absolute;pointer-events:auto;touch-action:none;display:flex;' +
        'align-items:center;justify-content:center;font-weight:bold;text-shadow:0 1px 2px #000;' +
        'background:rgba(24,20,36,.32);border:2px solid rgba(255,255,255,.28);border-radius:50%;' +
        'transition:background .05s,transform .05s;}' +
      '#pp-pad .b.on{background:rgba(208,168,78,.7);transform:scale(.9);}' +
      '#pp-pad .d{width:56px;height:56px;font-size:22px;color:#fff;}' +
      '#pp-pad .d.diag{width:52px;height:52px;font-size:18px;color:#d7cdea;' +
        'background:rgba(24,20,36,.24);border-color:rgba(255,255,255,.18);}' +
      '#pp-pad .a{width:64px;height:64px;font-size:24px;}' +
      // the ⛶ toggle stays visible; it hides/shows only the direction & action buttons
      '#pp-pad .tog{width:38px;height:38px;font-size:17px;border-radius:9px;color:#d0a84e;' +
        'background:rgba(18,13,28,.5);border:1px solid rgba(208,168,78,.5);}' +
      '#pp-pad.hidden .b:not(.tog){display:none;}';
    document.head.appendChild(css);

    var pad = document.createElement('div');
    pad.id = 'pp-pad';
    var SB = 'env(safe-area-inset-bottom)', SL = 'env(safe-area-inset-left)', SR = 'env(safe-area-inset-right)';

    // D-pad, bottom-left. A 3×3 grid (60px steps): edges are the 4 straight
    // directions; when diagonal movement is on we also fill the 4 corners with
    // two-direction buttons, giving a full 8-way pad.
    var dirs = [
      ['up','▲',62,124], ['left','◀',2,62], ['right','▶',122,62], ['down','▼',62,2],
    ];
    if (OPT_DIAG()){
      dirs.push(
        ['up-left','↖',2,124,['up','left']],   ['up-right','↗',122,124,['up','right']],
        ['down-left','↙',2,2,['down','left']], ['down-right','↘',122,2,['down','right']]
      );
    }
    dirs.forEach(function(d){
      var b = document.createElement('div');
      b.className = 'b d' + (d[4] ? ' diag' : ''); b.textContent = d[1];
      b.style.left = 'calc(18px + ' + SL + ' + ' + d[2] + 'px)';
      b.style.bottom = 'calc(22px + ' + SB + ' + ' + d[3] + 'px)';
      if (d[4]) wireHoldN(b, d[4]); else wireHold(b, d[0]);
      pad.appendChild(b);
    });

    // A / B / X cluster, bottom-right (X top · A middle · B bottom, per the sketch).
    // The 5th field picks the binding: 'hold' keeps the key down while pressed
    // (X = shift/dash needs this), 'press' is a momentary tap (A/B).
    var acts = [
      ['X','shift', '#7fb0d0',30,150,'hold'],
      ['A','ok',    '#6fbf6a',66,80, 'press'],
      ['B','escape','#c05070',30,10, 'press'],
    ];
    acts.forEach(function(a){
      var b = document.createElement('div');
      b.className = 'b a'; b.textContent = a[0]; b.style.color = a[2];
      b.style.right = 'calc(20px + ' + SR + ' + ' + a[3] + 'px)';
      b.style.bottom = 'calc(24px + ' + SB + ' + ' + a[4] + 'px)';
      (a[5] === 'hold' ? wireHold : wirePress)(b, a[1]); pad.appendChild(b);
    });

    // ⛶ quick-hide toggle (top-left, above the D-pad) — like the Diablo pad. It
    // only shows/hides the buttons for this session (e.g. to see a cutscene); the
    // persistent on/off switch lives on the launcher home screen.
    var tog = document.createElement('div');
    tog.className = 'b tog'; tog.textContent = '⛶'; tog.title = 'Hide / show controls';
    tog.style.left = 'calc(18px + ' + SL + ' + 2px)';
    tog.style.bottom = 'calc(22px + ' + SB + ' + 190px)';
    var toggle = function(e){ if (e){ e.preventDefault(); e.stopPropagation(); } pad.classList.toggle('hidden'); };
    tog.addEventListener('touchstart', toggle, { passive:false });
    tog.addEventListener('click', toggle);
    pad.appendChild(tog);

    (document.body || document.documentElement).appendChild(pad);
  }
  window.__ppBuildPad = buildPad;   // exposed for forcing/testing

  // show only where it helps: a touch/coarse pointer, an installed app, or ?pad
  // — unless the launcher's "On-screen controls" switch is explicitly OFF.
  function padWanted(){
    try {
      if (!OPT_PAD()) return false;
      return (window.matchMedia && matchMedia('(pointer: coarse)').matches) ||
        navigator.maxTouchPoints > 0 || 'ontouchstart' in window ||
        window.navigator.standalone === true || location.search.indexOf('pad') >= 0;
    } catch(e){ return false; }
  }
  var padPoll = setInterval(function(){
    if (!inputState()) return;              // wait for the engine's Input to exist
    clearInterval(padPoll);
    if (padWanted()) buildPad();
  }, 400);
  setTimeout(function(){ clearInterval(padPoll); }, 40000);

  // ---- 6. Optional diagonal (8-way) movement ----
  // RPG Maker walks 4-directionally by default (Game_Player.getInputDirection →
  // Input.dir4). When the launcher's "Diagonal movement" switch is on, read the
  // 8-way Input.dir8 and take a real diagonal step (moveDiagonally) — with a
  // wall-slide so a blocked corner still slides along the open axis. Followers
  // are advanced exactly as Game_Player.moveStraight does, so the party keeps up.
  function applyDiagonal(){
    if (typeof Game_Player === 'undefined' || typeof Game_CharacterBase === 'undefined') return false;
    if (Game_Player.__ppDiag) return true;
    Game_Player.__ppDiag = true;
    Game_Player.prototype.getInputDirection = function(){ return Input.dir8; };
    var _execMove = Game_Player.prototype.executeMove;
    Game_Player.prototype.executeMove = function(direction){
      if (direction === 1 || direction === 3 || direction === 7 || direction === 9){
        var horz = (direction === 1 || direction === 7) ? 4 : 6;
        var vert = (direction === 1 || direction === 3) ? 2 : 8;
        this.moveDiagonally(horz, vert);
      } else {
        _execMove.call(this, direction);
      }
    };
    Game_Player.prototype.moveDiagonally = function(horz, vert){
      if (this.canPassDiagonally(this._x, this._y, horz, vert)) this._followers.updateMove();
      Game_CharacterBase.prototype.moveDiagonally.call(this, horz, vert);
      if (!this.isMovementSucceeded()){            // corner blocked → slide along the open axis
        if (this.canPass(this._x, this._y, horz)) this.moveStraight(horz);
        else if (this.canPass(this._x, this._y, vert)) this.moveStraight(vert);
      }
    };
    return true;
  }
  if (OPT_DIAG()){
    var diagPoll = setInterval(function(){ if (applyDiagonal()) clearInterval(diagPoll); }, 300);
    setTimeout(function(){ clearInterval(diagPoll); }, 40000);
  }
})();
