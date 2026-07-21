// Pocket Player service worker.
// Two caches: the app shell (this tool), and the imported game's files.
// Game requests are served entirely from the game cache — the game itself
// never touches the network, so it runs fully offline.
const SHELL = 'pp-shell-v4';
const GAME = 'pp-game-v1';
const SHELL_ASSETS = [
  './',
  './index.html',
  './app.js',
  './pp-shim.js',
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
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== GAME).map(k => caches.delete(k))))
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

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin === scope.origin && url.pathname.startsWith(scope.pathname + 'game/')) {
    // imported game content — cache only, never network
    e.respondWith((async () => {
      const cache = await caches.open(GAME);
      const hit = await cache.match(url.pathname, { ignoreSearch: true });
      if (!hit) {
        // opening a game that isn't imported in THIS browser/app copy →
        // send the person back to the player with an explanation
        if (e.request.mode === 'navigate') return Response.redirect(scope.pathname + '?nogame=1', 302);
        return new Response('not in the imported game: ' + url.pathname, { status: 404 });
      }
      // inject the shim (readable errors + audio-decode rescue) into the game's entry page
      if (url.pathname.endsWith('/index.html')) {
        const text = await hit.text();
        const tag = '<script src="' + scope.pathname + 'pp-shim.js"></' + 'script>';
        const out = /<head[^>]*>/i.test(text) ? text.replace(/<head[^>]*>/i, m => m + tag) : tag + text;
        return new Response(out, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      const range = e.request.headers.get('Range');
      if (range) return rangeResponse(hit, range);
      return hit;
    })());
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
