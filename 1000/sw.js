/* Iqrab service worker: offline cache for the single-page app + its CDN assets. */
const CACHE = "iqrab-1000-v2";   // bump to force refresh after edits
const CORE = ["./", "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png", "./icon-180.png", "/assets/lead.js", "/assets/copy.js"];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  if (new URL(req.url).pathname.startsWith("/api/")) return;   // never cache the lead API
  if (req.mode === "navigate") {   // network-first for the page itself, cached copy when offline
    e.respondWith(fetch(req).then(r => { if (r.ok && !r.redirected) { const cp = r.clone(); caches.open(CACHE).then(c => c.put("./", cp)); } return r; })
      .catch(() => caches.match("./")));
    return;
  }
  // stale-while-revalidate for everything else (incl. Tailwind CDN + Google Fonts)
  e.respondWith(caches.open(CACHE).then(c => c.match(req).then(hit => {
    const net = fetch(req).then(r => { if (r && (r.ok || r.type === "opaque")) c.put(req, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  })));
});
