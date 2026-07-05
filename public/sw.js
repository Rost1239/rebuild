/**
 * REBUILD service worker — offline-first app shell.
 *
 * Strategy (no build-time precache manifest needed):
 *  - install: precache the shell (page, manifest, icons).
 *  - navigations: network-first so a deploy is picked up on next online load
 *    (fresh HTML names the new hashed assets); cached shell when offline.
 *  - same-origin assets + Google Fonts: cache-first, populated on first
 *    fetch. Vite hashes asset filenames, so a stale hit is impossible —
 *    new deploys reference new URLs and old entries just age out with the
 *    cache version.
 * Everything else (cross-origin, non-GET) passes through untouched.
 */
const CACHE = "rebuild-v1";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !FONT_HOSTS.includes(url.hostname)) return;

  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then(r => {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
          return r;
        })
        .catch(() => caches.match(req).then(r => r || caches.match("./index.html")))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(r => {
      // opaque = no-cors font CSS; cacheable even though status is unreadable
      if (r.ok || r.type === "opaque") {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return r;
    }))
  );
});
