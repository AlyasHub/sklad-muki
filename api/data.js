// Привратник базы. Все чтения/записи идут сюда. Проверяет токен и роль,
// отдаёт только то, что роли положено. Водитель НЕ может прочитать клиентов/цены/чужие отгрузки.
import { verifyToken, dbList, dbUpsert, dbDelete, configured } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!configured()) return res.status(500).json({ error: "Сервер не настроен" });

  const { token, op, table, item, id } = req.body || {};
  const u = verifyToken(token);
  if (!u) return res.status(401).json({ error: "Сессия истекла — войдите заново" });

  try {
    if (op === "loadAll") {
      // Все таблицы за один запрос — быстрее, чем 7 отдельных вызовов
      const tables = ["clients", "stock", "orders", "drivers", "trucks", "users", "expenses"];
      const out = {};
      await Promise.all(tables.map(async t => { try { out[t] = await listFor(u, t); } catch { out[t] = []; } }));
      return res.status(200).json({ data: out });
    }
    if (op === "list") return res.status(200).json({ rows: await listFor(u, table) });
    if (op === "upsert") { await upsertFor(u, table, item); return res.status(200).json({ ok: true }); }
    if (op === "delete") { await deleteFor(u, table, id); return res.status(200).json({ ok: true }); }
    return res.status(400).json({ error: "Неизвестная операция" });
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
}

async function listFor(u, table) {
  if (u.role === "director") {
    if (table === "users") return (await dbList("users")).map(({ passhash, ...rest }) => rest); // не отдаём хэши в браузер
    return await dbList(table);
  }
  if (u.role === "accountant") {
    return ["orders", "clients", "drivers"].includes(table) ? await dbList(table) : [];
  }
  if (u.role === "driver") {
    const myOrders = () => dbList("orders").then(rows => rows.filter(o => o.driverId === u.driverId));
    if (table === "orders") return await myOrders();
    if (table === "drivers") return (await dbList("drivers")).filter(d => d.id === u.driverId);
    if (table === "clients") {
      const ids = new Set((await myOrders()).map(o => o.clientId).filter(Boolean));
      return (await dbList("clients")).filter(c => ids.has(c.id)); // только клиенты его доставок
    }
    return [];
  }
  return [];
}

async function upsertFor(u, table, item) {
  if (!item || !item.id) throw new Error("Нет данных");
  if (u.role === "director") {
    const existing = (await dbList(table)).find(r => r.id === item.id);
    if (table === "users" && !item.passhash) item = { ...item, passhash: existing?.passhash }; // без нового пароля — старый хэш
    // Авторство: проставляем «кто добавил» только на новой записи; у существующей сохраняем оригинального автора
    if (existing?.created_by_name) {
      item = { ...item, created_by: existing.created_by, created_by_name: existing.created_by_name, created_at: existing.created_at };
    } else if (!existing) {
      item = { ...item, created_by: u.uid, created_by_name: u.name, created_at: new Date().toISOString() };
    }
    // Поля водителя (отметка доставки и фото) защищаем от случайной потери при директорских записях.
    // Фото объединяем (не теряем, можно перенести на другую позицию), отметку доставки не сбрасываем.
    if (table === "orders" && existing) {
      const photos = [...new Set([...(Array.isArray(existing.photos) ? existing.photos : []), ...(Array.isArray(item.photos) ? item.photos : [])])];
      item = { ...item, delivered_by_driver: !!existing.delivered_by_driver || !!item.delivered_by_driver, delivered_at: item.delivered_at || existing.delivered_at, photos };
    }
    return dbUpsert(table, item);
  }
  if (u.role === "driver" && table === "orders") {
    const existing = (await dbList("orders")).find(o => o.id === item.id);
    if (!existing || existing.driverId !== u.driverId) throw new Error("Нет доступа к этой отгрузке");
    // водителю можно менять только отметку доставки и фото
    const merged = {
      ...existing,
      delivered_by_driver: !!item.delivered_by_driver,
      delivered_at: item.delivered_at ?? existing.delivered_at,
      photos: Array.isArray(item.photos) ? item.photos : existing.photos,
    };
    return dbUpsert("orders", merged);
  }
  throw new Error("Нет прав на изменение");
}

async function deleteFor(u, table, id) {
  if (u.role === "director") return dbDelete(table, id);
  throw new Error("Нет прав на удаление");
}
