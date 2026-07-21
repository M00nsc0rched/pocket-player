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
(function(){
  'use strict';

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

  // ---- 4. audio decode rescue ----
  var AC = window.AudioContext || window.webkitAudioContext;
  if (AC && AC.prototype && AC.prototype.decodeAudioData){
    var orig = AC.prototype.decodeAudioData;
    AC.prototype.decodeAudioData = function(buf, onOk, onErr){
      var ctx = this;
      function silence(){
        try { return ctx.createBuffer(1, Math.max(1, Math.round(ctx.sampleRate * 0.05)), ctx.sampleRate); }
        catch(e){ return null; }
      }
      function rescue(){ var s = silence(); if (s && onOk) onOk(s); return s; }
      try {
        var p = orig.call(ctx, buf, onOk ? function(d){ onOk(d); } : undefined, function(){ rescue(); });
        if (p && p.catch) return p.catch(function(){ return rescue() || Promise.reject(new Error('decode failed')); });
        return p;
      } catch(ex){
        var s = rescue();
        return s ? Promise.resolve(s) : Promise.reject(ex);
      }
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
  //   D-pad → up/down/left/right   A → ok (confirm)   B → escape (cancel)
  //   X → escape (opens the menu on the map, where cancel == menu in MV)
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

    // A / B / X cluster, bottom-right (X top · A middle · B bottom, per the sketch)
    var acts = [
      ['X','escape','#7fb0d0',30,150],
      ['A','ok',    '#6fbf6a',66,80],
      ['B','escape','#c05070',30,10],
    ];
    acts.forEach(function(a){
      var b = document.createElement('div');
      b.className = 'b a'; b.textContent = a[0]; b.style.color = a[2];
      b.style.right = 'calc(20px + ' + SR + ' + ' + a[3] + 'px)';
      b.style.bottom = 'calc(24px + ' + SB + ' + ' + a[4] + 'px)';
      wirePress(b, a[1]); pad.appendChild(b);
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
