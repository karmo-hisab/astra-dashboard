/* Service worker: makes the site installable and quick to open.
   Pages: asks GitHub for the newest version, but waits at most ~1 second;
   if GitHub is slow, the saved copy is shown (the newer one is saved for next time).
   Claims and application data are never stored here (they come from the secure data service). */
const CACHE = "hisab-kitab-v3";
const FILES = ["./", "./index.html", "./teams.html", "./structure.html", "./apps.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];
const WAIT_MS = 1000;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(FILES.map(f => c.add(f).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;   // Google sign-in and data are left alone
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const network = fetch(e.request, {cache: "no-cache"}).then(res => {
      if (res && res.ok) cache.put(e.request, res.clone());
      return res;
    });
    const saved = await cache.match(e.request, {ignoreSearch: true});
    if (!saved) return network.catch(() => caches.match("./index.html"));
    // Newest page if GitHub answers within ~1 second, otherwise the saved copy
    const timeout = new Promise(resolve => setTimeout(() => resolve(saved), WAIT_MS));
    return Promise.race([network.catch(() => saved), timeout]);
  })());
});
