// Загрузка фото через сервер (сервисный ключ). Браузер шлёт сжатый jpeg в base64.
import { verifyToken, configured, SUPA_URL, SERVICE_KEY_RAW, dbGet, dbList } from "./_lib.js";

// Роль берём из СВЕЖЕЙ карточки, как api/data.js: в токене она может быть старой. (Так и сломалось: водителя
// перевели в бригадиры, а фото грузилось по старому токену «водитель» — до автопродления входа.)
// Бригадир — только к заявкам своей бригады (он + младшие водители; самовывоз, который грузила бригада),
// менеджер города — к заявкам своих городов. Так же, как им разрешено сохранять фото в заявке (api/data.js).
async function canPhoto(u, orderId) {
  const me = await dbGet("users", u.uid);
  if (!me) return false; // пользователя удалили в «Доступе»
  const role = me.role || u.role;
  if (role === "director" || role === "driver") return true;
  if (role !== "brigadir" && role !== "citymanager") return false;
  const o = await dbGet("orders", orderId);
  if (!o) return false;
  if (role === "brigadir") {
    const myDrv = me.driverId || u.driverId || "";
    if (!myDrv) return false;
    const brigade = new Set([myDrv, ...(await dbList("drivers")).filter(d => d.foremanId === myDrv).map(d => d.id)]);
    return brigade.has(o.driverId) || (!!o.pickup && brigade.has(o.loaderId));
  }
  const cities = (me && me.cities && me.cities.length) ? me.cities : [(me && me.city) || "astana"];
  const city = o.city || (o.clientId ? ((await dbGet("clients", o.clientId)) || {}).city : null) || "astana";
  return cities.includes(city);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!configured()) return res.status(500).json({ error: "Сервер не настроен" });

  const { token, orderId, dataUrl } = req.body || {};
  const u = verifyToken(token);
  if (!u) return res.status(401).json({ error: "Войдите заново" });
  if (!dataUrl || !orderId) return res.status(400).json({ error: "Нет файла" });

  try {
    if (!(await canPhoto(u, String(orderId)))) return res.status(403).json({ error: "Нет прав на фото к этой заявке" });
    const base64 = String(dataUrl).split(",").pop();
    const buf = Buffer.from(base64, "base64");
    const path = `${orderId}/${Date.now()}_${Math.random().toString(36).slice(2, 6)}.jpg`;
    const r = await fetch(`${SUPA_URL}/storage/v1/object/photos/${path}`, {
      method: "POST",
      headers: { apikey: SERVICE_KEY_RAW, Authorization: `Bearer ${SERVICE_KEY_RAW}`, "Content-Type": "image/jpeg", "x-upsert": "true" },
      body: buf,
    });
    if (!r.ok) return res.status(500).json({ error: await r.text() });
    return res.status(200).json({ url: `${SUPA_URL}/storage/v1/object/public/photos/${path}` });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
