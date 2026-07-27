// Офлайн-режим: кэшируем приложение и генератор PDF, чтобы менеджеры Караганды
// могли формировать документы без интернета. Данные (api/*) — только по сети,
// но приложение открывается и работает на сохранённом справочнике клиентов.
const CACHE = "darad-v1";
const PDF_LIBS = [
  "https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.10/pdfmake.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.10/vfs_fonts.js",
];

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // Заранее кладём в кэш оболочку и генератор PDF (чтобы офлайн собирались накладные)
    try { await c.addAll(["/", "/manifest.webmanifest", "/icon-192.png"]); } catch {}
    for (const url of PDF_LIBS) { try { await c.add(new Request(url, { mode: "cors" })); } catch {} }
    self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return; // записи в базу офлайн не кэшируем
  const url = new URL(req.url);

  // Данные — всегда свежие с сервера, офлайн отдаём понятную ошибку (приложение покажет свой кэш)
  if (url.pathname.startsWith("/api/")) {
    e.respondWith(fetch(req).catch(() => new Response(JSON.stringify({ error: "offline" }), { status: 503, headers: { "Content-Type": "application/json" } })));
    return;
  }

  // Генератор PDF и статика — сначала из кэша (мгновенно и работает офлайн), обновляем в фоне
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: false });
    const net = fetch(req).then(res => {
      if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone()).catch(() => {});
      return res;
    }).catch(() => null);
    if (hit) { net; return hit; }
    const res = await net;
    if (res) return res;
    // Офлайн и нет в кэше: для переходов по страницам отдаём оболочку приложения
    if (req.mode === "navigate") {
      const shell = await cache.match("/");
      if (shell) return shell;
    }
    return new Response("Офлайн", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  })());
});
