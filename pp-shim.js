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

  // ---- 3b. loading watchdog (diagnostic) ----
  // When the game hangs on a "Loading…" screen we need to know WHAT it's waiting
  // for. Track every XHR and image load; if one stays pending too long, surface
  // its URL in the overlay so we can see the exact stuck resource (or that
  // nothing is stuck — pointing at memory instead).
  (function(){
    var pending = Object.create(null), seq = 0;
    function shortUrl(u){ u = String(u || ''); return u.length > 80 ? '…' + u.slice(-78) : u; }
    setInterval(function(){
      var now = Date.now(), stuck = [];
      for (var k in pending){ if (now - pending[k].t > 9000) stuck.push(shortUrl(pending[k].u)); }
      if (stuck.length) overlay('⏳ Stuck loading (>9s):\n' + stuck.slice(0, 5).join('\n'));
    }, 4000);
    try {
      var OX = XMLHttpRequest.prototype.open, SX = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(m, url){ try { this.__u = url; } catch(e){} return OX.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function(){
        var xhr = this, id = ++seq; pending[id] = { u: xhr.__u, t: Date.now() };
        xhr.addEventListener('loadend', function(){
          delete pending[id];
          var st = 0; try { st = xhr.status; } catch(e){}
          if (st === 0 || st >= 400) overlay('⚠ request failed (' + (st || 'net') + '):\n' + shortUrl(xhr.__u));
        });
        return SX.apply(this, arguments);
      };
    } catch(e){}
    try {
      var desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
      if (desc && desc.set){
        Object.defineProperty(HTMLImageElement.prototype, 'src', {
          configurable: true, enumerable: desc.enumerable, get: desc.get,
          set: function(v){
            if (v){ var id = ++seq; pending[id] = { u: 'img ' + v, t: Date.now() };
              this.addEventListener('load', function(){ delete pending[id]; });
              this.addEventListener('error', function(){ delete pending[id]; overlay('⚠ image failed:\n' + shortUrl(v)); }); }
            return desc.set.call(this, v);
          }
        });
      }
    } catch(e){}
    // <video> problems (iOS Safari can't play WebM movies — a classic scene-hang cause)
    try {
      document.addEventListener('error', function(e){
        var t = e && e.target;
        if (t && t.tagName === 'VIDEO') overlay('⚠ video failed (iOS can’t play it?):\n' + shortUrl(t.currentSrc || t.src));
      }, true);
    } catch(e){}
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
  // Diagnostic status line (persistent, top-left). The setInterval watchdog can't
  // fire while the main thread is blocked by a synchronous WASM decode, so instead
  // we paint "decoding <size>" BEFORE each decode: if the game freezes showing it,
  // that decode is the culprit (and its size identifies the file).
  function audioDbg(msg){
    try {
      var el = document.getElementById('pp-adbg');
      if (!el){ el = document.createElement('div'); el.id = 'pp-adbg';
        el.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;background:rgba(0,0,0,.72);color:#8ff;font:11px/1.4 monospace;padding:2px 6px;pointer-events:none;white-space:pre;';
        (document.body || document.documentElement).appendChild(el); }
      el.textContent = msg;
    } catch(e){}
  }
  function yieldPaint(){ return new Promise(function(r){ setTimeout(r, 0); }); }

  var _decChain = Promise.resolve();
  var DECODE_TIMEOUT = 7000;
  function decodeOgg(bytes){
    var mb = (bytes.length / 1048576).toFixed(2);
    var run = _decChain.then(function(){
      return vorbisDecoder().then(function(dec){
        audioDbg('audio: decoding ' + mb + ' MB…');
        return yieldPaint().then(function(){   // let the status paint before a (possibly blocking) decode
          var t0 = Date.now();
          return new Promise(function(resolve, reject){
            var settled = false;
            var t = setTimeout(function(){
              if (settled) return; settled = true;
              _vorbis = null;                       // wedged decoder — force a fresh one next time
              audioDbg('audio: ' + mb + ' MB TIMEOUT');
              reject(new Error('decode timeout'));
            }, DECODE_TIMEOUT);
            Promise.resolve(dec.decodeFile(bytes)).then(function(res){
              if (settled) return; settled = true; clearTimeout(t);
              audioDbg('audio: ' + mb + ' MB ok ' + (Date.now() - t0) + 'ms');
              resolve(res);
            }, function(err){
              if (settled) return; settled = true; clearTimeout(t); _vorbis = null;
              audioDbg('audio: ' + mb + ' MB err');
              reject(err);
            });
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
      '#pp-pad .a{width:64px;height:64px;font-size:24px;}';
    document.head.appendChild(css);

    var pad = document.createElement('div');
    pad.id = 'pp-pad';
    var SB = 'env(safe-area-inset-bottom)', SL = 'env(safe-area-inset-left)', SR = 'env(safe-area-inset-right)';

    // D-pad, bottom-left
    var dirs = [
      ['up','▲',62,124], ['left','◀',2,62], ['right','▶',122,62], ['down','▼',62,2],
    ];
    dirs.forEach(function(d){
      var b = document.createElement('div');
      b.className = 'b d'; b.textContent = d[1];
      b.style.left = 'calc(18px + ' + SL + ' + ' + d[2] + 'px)';
      b.style.bottom = 'calc(22px + ' + SB + ' + ' + d[3] + 'px)';
      wireHold(b, d[0]); pad.appendChild(b);
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

    (document.body || document.documentElement).appendChild(pad);
  }
  window.__ppBuildPad = buildPad;   // exposed for forcing/testing

  // show only where it helps: a touch/coarse pointer, an installed app, or ?pad
  function padWanted(){
    try {
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
})();
