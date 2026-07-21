// Pocket Player game shim — injected into the imported game's index.html by the
// service worker. Two jobs:
//  1. Show real, readable error messages instead of a frozen screen / "Script error".
//  2. Never let a failed audio decode kill the game (iOS may lack the OGG codec) —
//     hand back a moment of silence instead, so the game plays on without sound.
(function(){
  'use strict';
  var shown = false;
  function overlay(msg){
    if (shown) return; shown = true;
    try {
      var d = document.createElement('div');
      d.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(8,7,12,.94);color:#e0b0c0;' +
        'font:13px/1.5 monospace;padding:24px;z-index:2147483647;overflow:auto;white-space:pre-wrap;-webkit-user-select:text';
      d.textContent = '⚠ Pocket Player caught a game error:\n\n' + msg +
        '\n\nTap this message to dismiss it and try to continue.';
      d.addEventListener('click', function(){ d.remove(); shown = false; });
      (document.body || document.documentElement).appendChild(d);
    } catch(e){}
  }
  window.addEventListener('error', function(e){
    overlay((e.message || 'unknown error') + '\n' + (e.filename || '?') + ':' + (e.lineno || '?'));
  });
  window.addEventListener('unhandledrejection', function(e){
    var r = e && e.reason;
    overlay('Unhandled rejection: ' + (r && (r.message || r.stack || r) || 'unknown'));
  });

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
})();
