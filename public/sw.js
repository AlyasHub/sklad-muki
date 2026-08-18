// Офлайн-режим: кэшируем приложение и генератор PDF, чтобы менеджеры Караганды
// могли формировать документы без интернета. Данные (api/*) — только по сети,
// но приложение открывается и работает на сохранённом справочнике клиентов.
//
// ВАЖНО (2026-08-18): оболочку (index.html / переходы по страницам) берём СНАЧАЛА ИЗ СЕТИ.
// Раньше она бралась из кэша → после деплоя у пользователей (особенно установленной PWA)
// оставалась старая версия бандла. Это ломало функции, где фронт и бэк должны совпадать
// (например разбор заявок начал требовать токен, а старый фронт его не слал → «не удалось
// разобрать»). Хэшированные ассеты (/assets/index-*.js) неизменяемы — их кэшируем навсегда.
const CACHE = "darad-v2";
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

// HTML-оболочка: переход по страницам или явный запрос index.html / документа
function isShell(req, url) {
  return req.mode === "navigate" || (req.destination === "document") ||
    url.pathname === "/" || url.pathname.endsWith("/index.html");
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return; // записи в базу офлайн не кэшируем
  const url = new URL(req.url);

  // Данные — всегда свежие с сервера, офлайн отдаём понятную ошибку (приложение покажет свой кэш)
  if (url.pathname.startsWith("/api/")) {
    e.respondWith(fetch(req).catch(() => new Response(JSON.stringify({ error: "offline" }), { status: 503, headers: { "Content-Type": "application/json" } })));
    return;
  }

  // Оболочка приложения — СНАЧАЛА СЕТЬ (чтобы всегда грузился актуальный бандл),
  // офлайн — из кэша. Так после деплоя пользователь сразу получает новую версию.
  if (isShell(req, url)) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok) { const c = await caches.open(CACHE); c.put("/", res.clone()).catch(() => {}); }
        return res;
      } catch {
        const cache = await caches.open(CACHE);
        return (await cache.match(req)) || (await cache.match("/")) ||
          new Response("Офлайн", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
    })());
    return;
  }

  // Хэшированные ассеты и генератор PDF — сначала из кэша (мгновенно и офлайн), обновляем в фоне
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
    return new Response("Офлайн", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  })());
});
