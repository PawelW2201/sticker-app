// sw.js — offline copy of the StickerTracker app's own files.
// Requests to GitHub's API are never touched here (the app keeps its own copy
// of the last data it downloaded).
//  - app code (html, js, manifest): network first, saved copy when offline,
//    so an update is picked up on the next open
//  - fonts and icons: saved copy first (they never change)
const VERSION = "st-app-1.0.9";
const SHELL = [
  "./", "index.html", "app.js", "charts.js", "manifest.webmanifest", "vendor/qrcode.mjs",
  "icons/icon.svg", "icons/icon-192.png", "icons/apple-touch-icon.png",
  "fonts/barlow-latin-400-normal.woff2", "fonts/barlow-latin-500-normal.woff2", "fonts/barlow-latin-600-normal.woff2",
  "fonts/barlow-semi-condensed-latin-600-normal.woff2", "fonts/barlow-semi-condensed-latin-700-normal.woff2",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("st-app-") && k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function save(req, res) {
  if (res.ok && res.type === "basic") {
    const copy = res.clone();
    caches.open(VERSION).then((c) => c.put(req, copy));
  }
  return res;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.includes("/__data/")) return;
  if (req.mode === "navigate") {
    e.respondWith(fetch(req, { cache: "no-cache" }).then((res) => save(new Request("index.html"), res))
      .catch(() => caches.match("index.html")));
    return;
  }
  if (/\/(fonts|icons)\//.test(url.pathname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => save(req, res))));
    return;
  }
  e.respondWith(fetch(req, { cache: "no-cache" }).then((res) => save(req, res))
    .catch(() => caches.match(req, { ignoreSearch: true })));
});
