// Загрузка фото через сервер (сервисный ключ). Браузер шлёт сжатый jpeg в base64.
import { verifyToken, configured, SUPA_URL, SERVICE_KEY_RAW } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!configured()) return res.status(500).json({ error: "Сервер не настроен" });

  const { token, orderId, dataUrl } = req.body || {};
  const u = verifyToken(token);
  if (!u) return res.status(401).json({ error: "Войдите заново" });
  if (!(u.role === "director" || u.role === "driver")) return res.status(403).json({ error: "Нет прав" });
  if (!dataUrl || !orderId) return res.status(400).json({ error: "Нет файла" });

  try {
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
