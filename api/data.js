// Привратник базы. Все чтения/записи идут сюда. Проверяет токен и роль,
// отдаёт только то, что роли положено. Водитель НЕ может прочитать клиентов/цены/чужие отгрузки.
import { verifyToken, signToken, dbList, dbUpsert, dbDelete, configured, orderLinkSig } from "./_lib.js";

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// Журнал изменений. Удаления пишем ВСЕГДА и вместе с самой записью — чтобы можно было откатить.
// Правки пишем только по важным справочникам (заявки/склад слишком «шумные», у них своя сверка).
const LOGGED = new Set(["clients", "users", "drivers", "trucks"]);
const NEVER_LOG = new Set(["changes", "backups", "logins"]);
const titleOf = r => (r && (r.name || r.clientName || r.username || r.note || r.category || r.id)) || "";
async function logChange(u, action, table, record) {
  if (NEVER_LOG.has(table)) return;
  try {
    await dbUpsert("changes", {
      id: uid(), at: new Date().toISOString(), action, table,
      userId: u.uid, userName: u.name, role: u.role,
      recordId: (record && record.id) || "",
      title: String(titleOf(record)).slice(0, 120),
      data: action === "delete" ? record : null, // полная копия удалённой записи для восстановления
    });
  } catch {}
}

// Снимок всей базы (для резервной копии)
export async function makeSnapshot(by) {
  const tables = ["clients", "stock", "orders", "drivers", "trucks", "users", "expenses"];
  const data = {}, counts = {};
  for (const t of tables) { const rows = await dbList(t); data[t] = rows; counts[t] = rows.length; }
  const snap = { id: uid(), at: new Date().toISOString(), by: by || "автоматически", counts, data };
  await dbUpsert("backups", snap);
  // держим последние 14 копий, старые чистим
  try {
    const all = (await dbList("backups")).sort((a, b) => String(b.at).localeCompare(String(a.at)));
    for (const old of all.slice(14)) await dbDelete("backups", old.id);
  } catch {}
  return { id: snap.id, at: snap.at, counts };
}
// Снимок целиком (для скачивания и отправки на почту)
export async function getSnapshot(id) {
  return (await dbList("backups")).find(x => x.id === id) || null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!configured()) return res.status(500).json({ error: "Сервер не настроен" });

  const { token, op, table, item, id } = req.body || {};
  const u = verifyToken(token);
  if (!u) return res.status(401).json({ error: "Сессия истекла — войдите заново" });

  try {
    // Пользователь удалён в «Доступе» → доступ закрыт сразу (при ближайшем запросе выкинет на вход)
    const allUsers = await dbList("users");
    const me = allUsers.find(x => x.id === u.uid);
    if (!me) return res.status(401).json({ error: "Доступ закрыт администратором — войдите заново" });
    // Последняя активность (не чаще раза в 5 минут).
    // ВАЖНО: пишем с await — Vercel замораживает функцию после ответа, и «фоновые» записи погибают.
    if (!me.last_seen || Date.now() - Date.parse(me.last_seen) > 5 * 60000) {
      // Если не был активен больше 30 минут — это новый «заход», пишем в журнал.
      // Вход по паролю бывает редко (токен живёт 30 дней), поэтому журнал ведём по заходам в приложение.
      if (!me.last_seen || Date.now() - Date.parse(me.last_seen) > 30 * 60000) {
        try { await dbUpsert("logins", { id: uid(), userId: me.id, name: me.name, username: me.username, role: me.role, at: new Date().toISOString(), kind: "open" }); } catch {}
      }
      try { await dbUpsert("users", { ...me, last_seen: new Date().toISOString() }); } catch {}
    }
    if (op === "loadAll") {
      // Все таблицы за один запрос — быстрее, чем 7 отдельных вызовов
      const tables = ["clients", "stock", "orders", "drivers", "trucks", "users", "expenses", "logins"];
      const out = {};
      await Promise.all(tables.map(async t => { try { out[t] = await listFor(u, t); } catch { out[t] = []; } }));
      // Автопродление входа: токену осталось меньше 7 дней — выдаём свежий, клиент тихо подхватит.
      // Пока человек пользуется приложением, его больше не выкинет на вход.
      const fresh_token = (u.exp && u.exp - Date.now() < 7 * 864e5) ? signToken({ uid: u.uid, role: u.role, driverId: u.driverId || "", name: u.name, exp: Date.now() + 30 * 864e5 }) : null;
      return res.status(200).json(fresh_token ? { data: out, fresh_token } : { data: out });
    }
    // Журнал изменений и резервные копии — только администратор
    if (op === "changes" || op === "restoreChange" || op === "backupNow" || op === "backupList" || op === "backupGet") {
      if (u.role !== "director") return res.status(403).json({ error: "Только для администратора" });
      if (op === "changes") {
        let all = []; try { all = await dbList("changes"); } catch { return res.status(200).json({ rows: [], needTable: "changes" }); }
        const rows = all.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 200);
        // саму запись наружу не отдаём (там могут быть хэши паролей) — только пометку, что откат возможен
        return res.status(200).json({ rows: rows.map(({ data, ...r }) => ({ ...r, canRestore: !!data })) });
      }
      if (op === "restoreChange") {
        const ch = (await dbList("changes")).find(x => x.id === id);
        if (!ch || !ch.data) return res.status(400).json({ error: "Эту запись восстановить нельзя" });
        const exists = (await dbList(ch.table)).some(r => r.id === ch.data.id);
        if (exists) return res.status(400).json({ error: "Такая запись уже есть — восстанавливать не нужно" });
        await dbUpsert(ch.table, ch.data);
        await logChange(u, "restore", ch.table, ch.data);
        return res.status(200).json({ ok: true, table: ch.table, title: ch.title });
      }
      if (op === "backupNow") return res.status(200).json({ backup: await makeSnapshot(u.name) });
      if (op === "backupList") {
        let all = []; try { all = await dbList("backups"); } catch { return res.status(200).json({ rows: [], needTable: "backups" }); }
        const rows = all.sort((a, b) => String(b.at).localeCompare(String(a.at)));
        return res.status(200).json({ rows: rows.map(({ data, ...r }) => r) }); // без содержимого — только список
      }
      if (op === "backupGet") {
        const b = (await dbList("backups")).find(x => x.id === id);
        if (!b) return res.status(404).json({ error: "Копия не найдена" });
        const data = { ...b.data, users: (b.data.users || []).map(({ passhash, ...r }) => r) }; // пароли не выгружаем
        return res.status(200).json({ backup: { id: b.id, at: b.at, by: b.by, counts: b.counts, data } });
      }
    }
    // Подпись клиентской заказ-ссылки (только администратор)
    if (op === "orderLink") {
      if (u.role !== "director") return res.status(403).json({ error: "Только для администратора" });
      const cid = (req.body || {}).clientId;
      if (!cid) return res.status(400).json({ error: "Нет клиента" });
      return res.status(200).json({ sig: orderLinkSig(cid) });
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
    if (table === "logins") return (await dbList("logins")).sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))).slice(0, 300); // только свежие — не гоняем весь журнал
    return await dbList(table);
  }
  if (u.role === "viewer") {
    // Директор-просмотрщик: видит все данные, но НЕ логины/пароли и НЕ журнал входов
    if (table === "users" || table === "logins") return [];
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
      const photo_at = { ...(existing.photo_at || {}), ...(item.photo_at || {}) }; // время загрузки каждого документа
      item = { ...item, delivered_by_driver: !!existing.delivered_by_driver || !!item.delivered_by_driver, delivered_at: item.delivered_at || existing.delivered_at, photos, photo_at };
    }
    const out = await dbUpsert(table, item);
    if (LOGGED.has(table)) await logChange(u, existing ? "update" : "create", table, item);
    return out;
  }
  if (u.role === "driver" && table === "orders") {
    const existing = (await dbList("orders")).find(o => o.id === item.id);
    if (!existing || existing.driverId !== u.driverId) throw new Error("Нет доступа к этой отгрузке");
    // водителю можно менять только отметку доставки, отметку загрузки в машину и фото
    const merged = {
      ...existing,
      delivered_by_driver: !!item.delivered_by_driver,
      delivered_at: item.delivered_at ?? existing.delivered_at,
      loaded: typeof item.loaded === "boolean" ? item.loaded : existing.loaded,
      photos: Array.isArray(item.photos) ? item.photos : existing.photos,
      photo_at: (item.photo_at && typeof item.photo_at === "object") ? { ...(existing.photo_at || {}), ...item.photo_at } : existing.photo_at, // время загрузки документов
    };
    return dbUpsert("orders", merged);
  }
  throw new Error("Нет прав на изменение");
}

async function deleteFor(u, table, id) {
  if (u.role !== "director") throw new Error("Нет прав на удаление");
  // Сохраняем удаляемую запись целиком — чтобы удаление можно было откатить одной кнопкой
  const existing = (await dbList(table)).find(r => r.id === id);
  if (existing) await logChange(u, "delete", table, existing);
  return dbDelete(table, id);
}
