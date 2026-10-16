// 🔄 Частичное обновление данных (раз в минуту): сервер отдаёт только строки, изменённые с прошлого раза.
// Каждая запись в базе получает отметку _v (время записи на сервере, api/_lib.js dbUpsert).
//  • Клиент шлёт по каждой таблице: since — самую свежую _v у себя, ids — «отпечаток» набора своих id.
//  • Сервер шлёт строки с _v позже since (с запасом SYNC_OVERLAP на разницу часов серверов и долгие записи)
//    и, если набор id у него другой (удалили/добавили), — полный список id в нужном порядке.
//  • Страховки: ошибка чтения таблицы — оставляем то, что было; после слияния набор id не сходится с
//    сервером (у нас нет строки, которую он знает, или отпечаток другой) — needFull: сразу полная загрузка.
// Тот же idsHash — в api/_lib.js (должны совпадать символ в символ).

export const SYNC_TABLES = ["clients", "stock", "orders", "drivers", "trucks", "users", "expenses", "logins", "notes", "kgd_clients", "kgd_docs", "cashbox", "payments", "crm", "lab"];

// FNV-1a по отсортированным id + их количество
export function idsHash(ids) {
  const s = [...ids].map(String).sort().join(",");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36) + ":" + ids.length;
}

// Что знаем сейчас: по каждой таблице самая свежая отметка и отпечаток id
export function syncState(data) {
  const since = {}, ids = {};
  for (const t of SYNC_TABLES) {
    const rows = (data && data[t]) || [];
    let v = 0;
    for (const r of rows) { const x = Number(r && r._v) || 0; if (x > v) v = x; }
    since[t] = v;
    ids[t] = idsHash(rows.map(r => r && r.id));
  }
  return { since, ids };
}

const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
const ver = r => Number(r && r._v) || 0;
// Повтор id в ответе (чтение базы страницами, пока в ней удаляли) — оставляем одну строку (свежую), на первом месте.
// Сравнивать _v с тем, что на телефоне, НЕ будем: время ставят разные серверы, их часы чуть расходятся — свежая
// правка могла бы показаться «старой» и застрять. От устаревших ответов защищает App.jsx (verRef): ответ,
// запрошенный до сохранения на телефоне, не применяется.
function dedupe(rows) {
  const seen = new Map();
  for (const r of rows) { const k = r && r.id; seen.set(k, seen.has(k) && ver(seen.get(k)) > ver(r) ? seen.get(k) : r); }
  if (seen.size === rows.length) return rows;
  const out = [], put = new Set();
  for (const r of rows) { const k = r && r.id; if (!put.has(k)) { put.add(k); out.push(seen.get(k)); } }
  return out;
}

// Слить ответ сервера с тем, что есть. resp = { data, meta?, delta? }.
// Возвращает { next, changed, needFull }. Полный ответ (без delta) — таблица целиком, кроме тех, что сервер
// не смог прочитать (meta[t].err): их оставляем как были, чтобы временная ошибка не «стёрла» заявки.
export function mergeLoad(prev, resp) {
  const d = (resp && resp.data) || {}, meta = (resp && resp.meta) || {};
  const next = {};
  let changed = false, needFull = false;
  for (const t of SYNC_TABLES) {
    const old = (prev && prev[t]) || [];
    const m = meta[t];
    if (m && m.err) { next[t] = old; continue; }
    if (!resp || !resp.delta || !m) { // таблица целиком (набор и порядок — как на сервере)
      const rows = dedupe(d[t] || []);
      if (same(old, rows)) next[t] = old; else { next[t] = rows; changed = true; }
      continue;
    }
    // частично: заменить изменённые строки, добавить новые
    const incoming = dedupe(d[t] || []);
    let list = old;
    if (incoming.length) {
      const byId = new Map(incoming.map(r => [r.id, r]));
      let tChanged = false;
      list = old.map(r => { const n = byId.get(r.id); if (n && !same(n, r)) { tChanged = true; return n; } return r; });
      const have = new Set(old.map(r => r.id));
      for (const r of incoming) if (!have.has(r.id)) { list.push(r); tChanged = true; }
      if (tChanged) changed = true; else list = old;
    }
    if (m.ids) { // набор id у сервера другой — берём его (порядок тоже как на сервере)
      const byId = new Map(list.map(r => [r.id, r]));
      const ordered = [];
      for (const id of m.ids) { const r = byId.get(id); if (r) ordered.push(r); else needFull = true; }
      if (ordered.length !== list.length || ordered.some((r, i) => r !== list[i])) { list = ordered; changed = true; }
    }
    if (m.h && idsHash(list.map(r => r.id)) !== m.h) needFull = true; // не сошлось с сервером — перекачать
    next[t] = list;
  }
  return { next: changed ? next : prev, changed, needFull };
}
