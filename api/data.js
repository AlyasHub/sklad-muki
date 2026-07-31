// Привратник базы. Все чтения/записи идут сюда. Проверяет токен и роль,
// отдаёт только то, что роли положено. Водитель НЕ может прочитать клиентов/цены/чужие отгрузки.
import { verifyToken, signToken, dbList, dbGet, dbFindBy, dbUpsert, dbDelete, configured, orderLinkSig } from "./_lib.js";

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
  return await dbGet("backups", id);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!configured()) return res.status(500).json({ error: "Сервер не настроен" });

  const { token, op, table, item, id } = req.body || {};
  const u = verifyToken(token);
  if (!u) return res.status(401).json({ error: "Сессия истекла — войдите заново" });

  try {
    // Пользователь удалён в «Доступе» → доступ закрыт сразу (при ближайшем запросе выкинет на вход)
    const me = await dbGet("users", u.uid); // точечно по id, не грузим всех пользователей
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
      const tables = ["clients", "stock", "orders", "drivers", "trucks", "users", "expenses", "logins", "notes", "kgd_clients", "kgd_docs", "cashbox", "payments"];
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
        const ch = await dbGet("changes", id);
        if (!ch || !ch.data) return res.status(400).json({ error: "Эту запись восстановить нельзя" });
        const exists = await dbGet(ch.table, ch.data.id);
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
        const b = await dbGet("backups", id);
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
    // 🤖 ИИ-помощник: свободный текст → распознанное действие (только администратор). Выполняет клиент через обычный upsert.
    if (op === "assistant") {
      if (u.role !== "director") return res.status(403).json({ error: "Помощник доступен только администратору" });
      return res.status(200).json(await runAssistant((req.body || {}).message, (req.body || {}).debug));
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
  if (u.role === "kgdmanager") {
    // Младший менеджер Караганда: справочник клиентов + СВОЯ история документов
    if (table === "kgd_clients") return await dbList(table);
    if (table === "kgd_docs") return await dbFindBy("kgd_docs", "byId", u.uid); // фильтр на сервере БД
    return [];
  }
  if (u.role === "kgdsenior") {
    // Старший менеджер Караганда: справочник + история ВСЕХ менеджеров
    if (table === "kgd_clients" || table === "kgd_docs") return await dbList(table);
    return [];
  }
  if (u.role === "viewer") {
    // Директор-просмотрщик: видит все данные, но НЕ пароли и НЕ журнал входов
    if (table === "logins") return [];
    if (table === "users") return (await dbList("users")).map(({ passhash, ...rest }) => rest); // без хэшей — нужно для названий групп клиентов
    return await dbList(table);
  }
  if (u.role === "accountant") {
    return ["orders", "clients", "drivers"].includes(table) ? await dbList(table) : [];
  }
  if (u.role === "driver") {
    // Заявки водителя — фильтром на сервере БД (не тянем всю таблицу заявок)
    const myOrders = () => dbFindBy("orders", "driverId", u.driverId);
    if (table === "orders") return await myOrders();
    if (table === "drivers") { const d = await dbGet("drivers", u.driverId); return d ? [d] : []; }
    if (table === "clients") {
      const ids = new Set((await myOrders()).map(o => o.clientId).filter(Boolean));
      if (!ids.size) return [];
      // клиенты его доставок — точечно по id (обычно их немного)
      const list = await Promise.all([...ids].map(cid => dbGet("clients", cid).catch(() => null)));
      return list.filter(Boolean);
    }
    return [];
  }
  if (u.role === "brigadir") {
    // Бригадир: заявки всей бригады (он + младшие водители с foremanId === его driverId)
    if (!["orders", "drivers", "clients", "notes"].includes(table)) return [];
    const allDrivers = await dbList("drivers");
    const brigade = new Set([u.driverId, ...allDrivers.filter(d => d.foremanId === u.driverId).map(d => d.id)]);
    if (table === "drivers") return allDrivers.filter(d => brigade.has(d.id)).map(({ rate_per_kg, load_rate_per_kg, base_salary, base_included_kg, tier1_to_kg, tier1_rate, tier2_rate, ...d }) => d); // без ставок/оклада
    if (table === "notes") return (await dbList("notes")).filter(n => n.id === "warehouse");
    const myOrders = (await dbList("orders")).filter(o => brigade.has(o.driverId));
    if (table === "orders") return myOrders;
    if (table === "clients") {
      const ids = new Set(myOrders.map(o => o.clientId).filter(Boolean));
      if (!ids.size) return [];
      const list = await Promise.all([...ids].map(cid => dbGet("clients", cid).catch(() => null)));
      return list.filter(Boolean);
    }
    return [];
  }
  if (u.role === "rep") {
    // Торговый представитель: СВОИ клиенты (по ownerId), свои оплаты, общий склад (без цен закупа),
    // водители (без ставок) и ВСЕ заявки как расписание — но чужие обезличены и без цен.
    if (!["clients", "orders", "stock", "drivers", "payments", "notes"].includes(table)) return [];
    if (table === "stock") return (await dbList("stock")).map(({ price_per_kg, ...s }) => s); // без закупочных цен
    if (table === "drivers") return (await dbList("drivers")).map(({ rate_per_kg, load_rate_per_kg, ...d }) => d); // без ставок
    if (table === "notes") return (await dbList("notes")).filter(n => n.id === "warehouse"); // адрес склада для маршрута
    const myClients = await dbFindBy("clients", "ownerId", u.uid);
    const myIds = new Set(myClients.map(c => c.id));
    if (table === "clients") return myClients;
    if (table === "orders") {
      const all = await dbList("orders");
      const cmap = new Map((await dbList("clients")).map(c => [c.id, c]));
      // Чужая заявка = расписание для координации с водителем: КТО (имя), КУДА (адрес/маршрут), ЧТО, кто везёт.
      // БЕЗ наших цен, БЕЗ ИП/ТОО и реквизитов, БЕЗ возможности менять (foreign:true).
      return all.map(o => {
        if (myIds.has(o.clientId)) return o;
        const c = cmap.get(o.clientId) || {};
        return {
          id: o.id, date: o.date, brand: o.brand, grade: o.grade, bag_kg: o.bag_kg, bags: o.bags,
          status: o.status, driverId: o.driverId, loaderId: o.loaderId, loaded: o.loaded,
          trial: o.trial, isSample: o.isSample, fromKaraganda: o.fromKaraganda, pickup: o.pickup, oneOff: o.oneOff,
          clientName: o.clientName || c.name || "Клиент", clientId: o.clientId, // кому — настоящее имя (без ИП/ТОО)
          price_per_kg: 0, // без наших цен
          gis_link: c.gis_link || o.gis_link || "", coords: c.coords || o.coords || null, // для маршрута
          address: c.address || o.oneOffAddress || "", oneOffAddress: o.oneOffAddress || "",
          delivery_time: c.delivery_time || "", delivery_from: c.delivery_from || "", delivery_to: c.delivery_to || "",
          foreign: true,
        };
      });
    }
    if (table === "payments") return (await dbList("payments")).filter(p => myIds.has(p.clientId));
    return [];
  }
  return [];
}

async function upsertFor(u, table, item) {
  if (!item || !item.id) throw new Error("Нет данных");
  if (u.role === "director") {
    const existing = await dbGet(table, item.id); // точечно по id, не грузим всю таблицу
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
  if ((u.role === "kgdmanager" || u.role === "kgdsenior") && (table === "kgd_clients" || table === "kgd_docs")) {
    // Справочник клиентов ведут оба; документ в историю подписываем автором на сервере
    if (table === "kgd_docs") return dbUpsert("kgd_docs", { ...item, byId: u.uid, by: u.name });
    return dbUpsert("kgd_clients", item);
  }
  if (u.role === "driver" && table === "orders") {
    const existing = await dbGet("orders", item.id); // точечно по id
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
  if (u.role === "brigadir") {
    // Бригадир меняет только заявки своей бригады: переназначить водителя ВНУТРИ бригады + отметки доставки/загрузки/фото
    if (table !== "orders") throw new Error("Нет прав на изменение");
    const existing = await dbGet("orders", item.id);
    if (!existing) throw new Error("Заявка не найдена");
    const allDrivers = await dbList("drivers");
    const brigade = new Set([u.driverId, ...allDrivers.filter(d => d.foremanId === u.driverId).map(d => d.id)]);
    if (!brigade.has(existing.driverId)) throw new Error("Эта заявка не в вашей бригаде");
    const newDriver = typeof item.driverId === "string" ? item.driverId : existing.driverId;
    if (newDriver && !brigade.has(newDriver)) throw new Error("Передать можно только своему водителю");
    return dbUpsert("orders", {
      ...existing,
      driverId: newDriver,
      delivered_by_driver: typeof item.delivered_by_driver === "boolean" ? item.delivered_by_driver : existing.delivered_by_driver,
      delivered_at: item.delivered_at ?? existing.delivered_at,
      loaded: typeof item.loaded === "boolean" ? item.loaded : existing.loaded,
      photos: Array.isArray(item.photos) ? item.photos : existing.photos,
      photo_at: (item.photo_at && typeof item.photo_at === "object") ? { ...(existing.photo_at || {}), ...item.photo_at } : existing.photo_at,
    });
  }
  if (u.role === "rep") {
    // Торгпред меняет ТОЛЬКО своё: клиентов своей группы, заявки и оплаты своих клиентов.
    if (table === "clients") {
      const existing = await dbGet("clients", item.id);
      if (existing && existing.ownerId !== u.uid) throw new Error("Это не ваш клиент");
      return dbUpsert("clients", { ...item, ownerId: u.uid }); // всегда в его группу — чужую нельзя
    }
    if (table === "orders") {
      const cli = await dbGet("clients", item.clientId);
      if (!cli || cli.ownerId !== u.uid) throw new Error("Заявку можно создавать только для своих клиентов");
      const existing = await dbGet("orders", item.id);
      if (existing) { const exCli = await dbGet("clients", existing.clientId); if (!exCli || exCli.ownerId !== u.uid) throw new Error("Это не ваша заявка"); }
      return dbUpsert("orders", item);
    }
    if (table === "payments") {
      const cli = await dbGet("clients", item.clientId);
      if (!cli || cli.ownerId !== u.uid) throw new Error("Оплату можно вносить только своим клиентам");
      return dbUpsert("payments", item);
    }
    throw new Error("Нет прав на изменение");
  }
  throw new Error("Нет прав на изменение");
}

async function deleteFor(u, table, id) {
  if ((u.role === "kgdmanager" || u.role === "kgdsenior") && table === "kgd_clients") {
    const ex = await dbGet("kgd_clients", id);
    if (ex) await logChange(u, "delete", "kgd_clients", ex);
    return dbDelete("kgd_clients", id);
  }
  if (u.role === "kgdsenior" && table === "kgd_docs") { // историю чистит только старший
    const ex = await dbGet("kgd_docs", id);
    if (ex) await logChange(u, "delete", "kgd_docs", ex);
    return dbDelete("kgd_docs", id);
  }
  if (u.role === "rep") {
    // Торгпред удаляет только своё
    if (table === "clients") { const ex = await dbGet("clients", id); if (!ex || ex.ownerId !== u.uid) throw new Error("Это не ваш клиент"); return dbDelete("clients", id); }
    if (table === "orders") { const ex = await dbGet("orders", id); if (!ex) return; const cli = await dbGet("clients", ex.clientId); if (!cli || cli.ownerId !== u.uid) throw new Error("Это не ваша заявка"); try { await dbDelete("stock", "mv_" + id); } catch {} return dbDelete("orders", id); }
    if (table === "payments") { const ex = await dbGet("payments", id); const cli = ex && await dbGet("clients", ex.clientId); if (!ex || !cli || cli.ownerId !== u.uid) throw new Error("Это не ваша оплата"); return dbDelete("payments", id); }
    throw new Error("Нет прав на удаление");
  }
  if (u.role !== "director") throw new Error("Нет прав на удаление");
  // Сохраняем удаляемую запись целиком — чтобы удаление можно было откатить одной кнопкой
  const existing = await dbGet(table, id); // точечно по id
  if (existing) await logChange(u, "delete", table, existing);

  // КАСКАД: удаляя заявку/фуру, отменяем и её движения по складу/расходы,
  // чтобы не оставалось «висячих» приходов и расходов. Движения привязаны к записи по id.
  if (table === "orders") {
    // списание отгрузки этой заявки (если было отгружено)
    try { await dbDelete("stock", "mv_" + id); } catch {}
  }
  if (table === "trucks") {
    // приходы фуры (tin_<id>_0..N) и расход за фуру (texp_<id>)
    try {
      const st = await dbList("stock");
      for (const s of st) if (typeof s.id === "string" && s.id.startsWith("tin_" + id + "_")) await dbDelete("stock", s.id);
    } catch {}
    try { await dbDelete("expenses", "texp_" + id); } catch {}
  }

  return dbDelete(table, id);
}

// 🤖 ИИ-помощник: свободный текст → СТРОГО один JSON (действие/ответ/уточнение).
// Само действие НЕ выполняется здесь — сервер только распознаёт и подставляет id клиента/цену/дату;
// запись делает клиент через обычный upsert (там работает роль-контроль).
const AI_BRANDS = ["ДАРАД", "ДАЛА НАН"];
const AI_GRADES = ["Высший сорт", "Первый сорт"];
const AI_EXPENSE_CATS = ["Фура/Поставка", "Водители", "Грузчики", "Склад", "Аренда", "Зарплата", "Прочее"];
const AI_PAY_METHODS = ["Kaspi перевод", "Kaspi QR", "Наличные", "Безнал"];
const aiFmt = n => Number(n || 0).toLocaleString("ru-RU");

async function runAssistant(message, debug) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { error: "ANTHROPIC_API_KEY не настроен на сервере" };
  if (!message || !String(message).trim()) return { error: "Пустая задача" };

  const [clients, orders, drivers, payments, stock, cashbox] = await Promise.all([
    dbList("clients"), dbList("orders"), dbList("drivers"),
    dbList("payments").catch(() => []), dbList("stock"), dbList("cashbox").catch(() => []),
  ]);

  const nowAstana = new Date(Date.now() + 5 * 3600 * 1000);
  const today = nowAstana.toISOString().slice(0, 10);
  const tomorrow = new Date(nowAstana.getTime() + 864e5).toISOString().slice(0, 10);
  const weekday = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"][nowAstana.getUTCDay()];

  const clientLines = clients.map(c => {
    const prices = (c.prices || []).map(p => `${p.brand} ${p.grade} ${p.bag_kg}кг=${p.price_per_kg}тг/кг`).join(", ");
    return `- id:${c.id} | ${c.name}${c.org_name ? ` (${c.org_name})` : ""}${c.address ? ` | адрес: ${c.address}` : ""}${c.default_brand || c.default_bag_kg ? ` | обычно: ${c.default_brand || "?"} ${c.default_bag_kg || "?"}кг` : ""}${prices ? ` | цены: ${prices}` : " | цен нет"}`;
  }).join("\n");

  const bal = {};
  stock.forEach(s => { const k = `${s.brand}|${s.grade}|${s.bag_kg}`; if (!bal[k]) bal[k] = { brand: s.brand, grade: s.grade, bag_kg: s.bag_kg, bags: 0, kg: 0 }; bal[k].bags += Number(s.bags) || 0; bal[k].kg += Number(s.weight_kg) || 0; });
  const stockLines = Object.values(bal).filter(b => b.kg !== 0).map(b => `- ${b.brand} ${b.grade} ${b.bag_kg}кг: ${aiFmt(b.kg)} кг (${aiFmt(b.bags)} меш.)`).join("\n") || "склад пуст";

  const debt = {};
  orders.filter(o => o.status === "отгружена" && !o.paid).forEach(o => { const sum = o.bags * o.bag_kg * (o.price_per_kg || 0); if (sum > 0) { const k = o.clientId || ("nm:" + (o.clientName || "")); debt[k] = (debt[k] || 0) + sum; } });
  (payments || []).forEach(p => { const k = p.clientId || ("nm:" + (p.clientName || "")); if (debt[k] != null) debt[k] -= (p.amount || 0); });
  const debtLines = Object.entries(debt).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => { const c = clients.find(x => x.id === k); return `- ${c ? c.name : k.replace("nm:", "")}: ${aiFmt(v)} тг`; }).join("\n") || "долгов нет";

  const cashBal = (cashbox || []).reduce((s, x) => s + (x.dir === "in" ? 1 : -1) * (x.amount || 0), 0);
  const driverLines = drivers.map(d => `- id:${d.id} | ${d.name}`).join("\n") || "нет";

  const prompt = `Ты — ИИ-помощник склада муки «Darad». Пользователь пишет задачу простым языком, ты определяешь, к чему она относится, и возвращаешь СТРОГО ОДИН JSON-объект без markdown и без пояснений вокруг.

СЕГОДНЯ ${today} (${weekday}). ЗАВТРА ${tomorrow}.
Бренды: ${AI_BRANDS.join(", ")}. Сорта: ${AI_GRADES.join(", ")}. Фасовки мешков: 5, 10, 25, 50 кг.
Способы оплаты (method): ${AI_PAY_METHODS.join(", ")}.
Категории расходов (category): ${AI_EXPENSE_CATS.join(", ")}.

КЛИЕНТЫ (сопоставляй нечётко — по имени, организации, части адреса, с опечатками, латиница=кириллица):
${clientLines}

ОСТАТКИ СКЛАДА:
${stockLines}

ДОЛГИ КЛИЕНТОВ (уже с учётом внесённых оплат):
${debtLines}

ВОДИТЕЛИ/РАБОЧИЕ:
${driverLines}

Касса (подотчёт) сейчас: остаток ${aiFmt(cashBal)} тг.

ФОРМАТ ОТВЕТА — один JSON-объект:
{
  "kind": "action" | "answer" | "clarify",
  "text": "для answer или clarify — короткий ответ/уточняющий вопрос на русском",
  "action": "create_order | add_payment | cashbox | add_expense | add_truck | mark_paid",
  "params": { ... },
  "summary": "человекочитаемое описание того, ЧТО будет сделано (для карточки подтверждения), на русском",
  "warn": "предупреждение если что-то неточно (клиента нет в базе, цена не найдена и т.п.), иначе пустая строка"
}

ПРАВИЛА:
- Если это ВОПРОС (сколько долг, что на складе, остаток кассы, кто должен) — kind:"answer", ответь кратко по данным выше.
- Если данных не хватает для действия (не ясен клиент/сумма/что именно) — kind:"clarify" с конкретным вопросом.
- Иначе kind:"action" с одним из действий:

create_order (создать заявку): params { "clientId":"id или пустая строка", "clientName":"точное имя из списка", "date":"YYYY-MM-DD", "note":"", "trial":false, "positions":[{"brand":"","grade":"","bag_kg":50,"bags":10,"price_per_kg":0}] }
  • Дата: день недели → ближайшая будущая с этим днём; "завтра"=${tomorrow}; "сегодня"=${today}; не указана → завтра (${tomorrow}).
  • Если сорт/бренд/фасовка не названы — бери из «обычно»/прайса клиента. Цену бери из прайса клиента для этой позиции.
  • Если цена в прайсе не найдена и это НЕ проба — kind:"clarify", спроси цену.
  • "на пробу"/"бесплатно"/"тест" → trial:true, цены 0.
  • Клиента нет в списке → clientId:"" , warn:"клиента нет в базе — заявка создастся по имени".

add_payment (клиент внёс деньги в счёт долга): params { "clientId":"", "clientName":"", "amount":100000, "method":"Наличные", "date":"${today}", "note":"" }
  • Способ не указан → "Наличные". Дата не указана → сегодня.

cashbox (касса — приход/трата подотчётных денег): params { "dir":"in"|"out", "amount":5000, "date":"${today}", "note":"на что / от кого" }
  • "потратил/расход/купил" → dir:"out". "дали/приход/получил" → dir:"in". Дата не указана → сегодня.

add_expense (расход КОМПАНИИ, не касса): params { "category":"Прочее", "amount":50000, "date":"${today}", "note":"" }
  • Используй, если явно про расход компании (аренда, зарплата, грузчики, фура). «расход с кассы» — это НЕ сюда, это action cashbox с dir:"out".

add_truck (приедет фура/поставка муки на склад): params { "date":"YYYY-MM-DD", "driver_name":"", "car_number":"", "price":0, "note":"", "items":[{"brand":"","grade":"","bag_kg":50,"kg":20000}] }
  • Дата — когда приедет. items — что везёт (в КГ). Если позиции не названы — items:[] и warn:"состав фуры не указан".

mark_paid (отметить конкретную отгрузку клиента оплаченной за дату): params { "clientId":"", "clientName":"", "date":"YYYY-MM-DD", "method":"Наличные" }
  • Только если пользователь явно про оплату за конкретную дату отгрузки. Для «внёс сумму в счёт долга» используй add_payment.

summary всегда заполняй понятной фразой с ключевыми числами. Верни только JSON.

ЗАДАЧА ПОЛЬЗОВАТЕЛЯ: "${String(message).replace(/"/g, "'").slice(0, 800)}"`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 4000, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await r.json();
  if (!r.ok) return { error: data?.error?.message || "Ошибка Anthropic API" };
  let raw = (data.content || []).map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
  const first = raw.indexOf("{"), last = raw.lastIndexOf("}");
  if (first > 0 || last < raw.length - 1) raw = raw.slice(first, last + 1);
  let result;
  try { result = JSON.parse(raw); } catch { return { error: "Не смог разобрать задачу — переформулируй попроще.", raw: debug ? raw : undefined }; }
  return { result, raw: debug ? raw : undefined, stop_reason: data.stop_reason };
}
