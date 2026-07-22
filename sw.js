// Pocket Player service worker.
// Caches: the app shell (this tool) + one cache per imported game.
//   legacy single-slot game → cache 'pp-game-v1', served under 'game/…'
//   new library games        → cache 'pp-game-<id>', served under 'g/<id>/…'
// Game requests are served entirely from cache — the game never touches the
// network, so it runs fully offline. Each game keeps its own cache and its own
// URL base, so several games coexist without clobbering each other.
const SHELL = 'pp-shell-v9';
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

async function serveGame(cacheName, request, url, scope, isIndex) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(url.pathname, { ignoreSearch: true });
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
