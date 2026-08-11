// Pocket Player service worker.
// Caches: the app shell (this tool) + one cache per imported game.
//   legacy single-slot game → cache 'pp-game-v1', served under 'game/…'
//   new library games        → cache 'pp-game-<id>', served under 'g/<id>/…'
// Game requests are served entirely from cache — the game never touches the
// network, so it runs fully offline. Each game keeps its own cache and its own
// URL base, so several games coexist without clobbering each other.
const SHELL = 'pp-shell-v19';
const LEGACY_GAME_CACHE = 'pp-game-v1';
const SHELL_ASSETS = [
  './',
  './index.html',
  './app.js',
  './pp-shim.js',
  './ogg-vorbis-decoder.min.js',
  './fflate.min.js',
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  // only sweep away stale SHELL caches — every pp-game-* cache is a user's
  // installed game and must survive tool updates
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('pp-shell-') && k !== SHELL).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// iOS media elements demand Range responses; Cache API ignores Range headers,
// so slice the cached body ourselves and answer 206.
async function rangeResponse(res, rangeHeader) {
  const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  if (!m) return res;
  const blob = await res.blob();
  const size = blob.size;
  const start = m[1] ? parseInt(m[1], 10) : 0;
  const end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
  if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}

// A missing image makes RPG Maker's (or a plugin's) preloader wait forever — an
// endless "Loading…". Instead of 404, hand back a 1x1 transparent image so the
// scene proceeds (the missing layer/graphic just doesn't show). RPG Maker MV
// encrypts images as .rpgmvp, so for those we must return the SAME dummy PNG
// wrapped in MV's encryption (16-byte fake header + first 16 bytes XOR the game's
// key) — otherwise the engine's decrypt step corrupts it back into an error.
const TRANSPARENT_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const MV_ENC_HEADER = new Uint8Array([0x52,0x50,0x47,0x4d,0x56,0x00,0x00,0x00,0x00,0x03,0x01,0x00,0x00,0x00,0x00,0x00]);
function b64ToBytes(b64) {
  const bin = atob(b64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
const _encKeyCache = new Map();  // gameRoot -> Uint8Array key | null
async function getEncryptionKey(cache, gameRoot) {
  if (_encKeyCache.has(gameRoot)) return _encKeyCache.get(gameRoot);
  let key = null;
  try {
    const sys = await cache.match(gameRoot + 'data/System.json', { ignoreSearch: true });
    if (sys) {
      const hex = (await sys.json()).encryptionKey;
      if (hex && /^[0-9a-f]+$/i.test(hex) && hex.length >= 2) {
        key = new Uint8Array(hex.length / 2);
        for (let i = 0; i < key.length; i++) key[i] = parseInt(hex.substr(i * 2, 2), 16);
      }
    }
  } catch (e) {}
  _encKeyCache.set(gameRoot, key);
  return key;
}
function mvEncrypt(png, key) {
  const out = new Uint8Array(MV_ENC_HEADER.length + png.length);
  out.set(MV_ENC_HEADER, 0);
  out.set(png, MV_ENC_HEADER.length);
  for (let i = 0; i < 16 && i < png.length; i++) out[MV_ENC_HEADER.length + i] ^= key[i % key.length];
  return out;
}
async function dummyImageResponse(cache, url, scope) {
  const png = b64ToBytes(TRANSPARENT_PNG_B64);
  if (/\.rpgmvp$/i.test(url.pathname)) {
    const afterScope = url.pathname.slice(scope.pathname.length);
    const gm = afterScope.match(/^(g\/[^/]+\/|game\/)/);
    const gameRoot = scope.pathname + (gm ? gm[1] : '');
    const key = await getEncryptionKey(cache, gameRoot);
    if (key) return new Response(mvEncrypt(png, key), { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
  }
  return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } });
}

async function serveGame(cacheName, request, url, scope, isIndex) {
  const cache = await caches.open(cacheName);
  let hit = await cache.match(url.pathname, { ignoreSearch: true });
  if (!hit) {
    // RPG Maker MV on iOS ALWAYS asks for .m4a audio (Utils.isMobileDevice()
    // forces audioFileExt() to '.m4a'), but most games ship only .ogg — so the
    // .m4a 404s and every sound is silent. Serve the OGG twin when the M4A is
    // missing (same for encrypted .rpgmvm → .rpgmvo). Safe because the audio is
    // decoded by content: the WebAudio path hits our decodeAudioData shim, which
    // recognises the 'OggS' bytes regardless of the extension in the URL.
    const alt = url.pathname.replace(/\.m4a$/i, '.ogg').replace(/\.rpgmvm$/i, '.rpgmvo');
    if (alt !== url.pathname) hit = await cache.match(alt, { ignoreSearch: true });
  }
  if (!hit && /\.(rpgmvp|png|jpe?g)$/i.test(url.pathname)) {
    // Missing image → transparent dummy instead of 404, so a preloader that awaits
    // it proceeds rather than hanging on an endless "Loading…" screen.
    return dummyImageResponse(cache, url, scope);
  }
  if (!hit) {
    // opening a game not imported in THIS browser/app copy → back to the player
    if (request.mode === 'navigate') return Response.redirect(scope.pathname + '?nogame=1', 302);
    return new Response('not in the imported game: ' + url.pathname, { status: 404 });
  }
  // inject the shim (readable errors, audio rescue, gamepad, save isolation)
  if (isIndex) {
    const text = await hit.text();
    const tag = '<script src="' + scope.pathname + 'pp-shim.js"></' + 'script>';
    const out = /<head[^>]*>/i.test(text) ? text.replace(/<head[^>]*>/i, m => m + tag) : tag + text;
    return new Response(out, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  const range = request.headers.get('Range');
  if (range) return rangeResponse(hit, range);
  return hit;
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin) return;
  const rel = url.pathname.slice(scope.pathname.length);   // path under the app scope

  // legacy single-slot game (the original install)
  if (rel.startsWith('game/')) {
    e.respondWith(serveGame(LEGACY_GAME_CACHE, e.request, url, scope, rel.endsWith('/index.html')));
    return;
  }
  // library game: g/<id>/…  → its own cache pp-game-<id>
  if (rel.startsWith('g/')) {
    const id = rel.split('/')[1] || '';
    e.respondWith(serveGame('pp-game-' + id, e.request, url, scope, rel.endsWith('/index.html')));
    return;
  }
  // app shell — cache-first, fill from network
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit =>
      hit || fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(SHELL).then(c => c.put(e.request, copy));
        return res;
      })
    )
  );
});
