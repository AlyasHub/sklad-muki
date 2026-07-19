// Клиентский заказник: страница /order.html?c=<id>&k=<подпись> зовёт сюда.
// Без верной подписи (HMAC от id клиента) нельзя ни увидеть прайс, ни отправить заявку.
// Заявка падает в базу со статусом «новая» и пометкой from_client — админ видит её сразу.
import { dbList, dbUpsert, configured, orderLinkSig } from "./_lib.js";

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!configured()) return res.status(500).json({ error: "Сервер не настроен" });

  const { action, c, k, items, date, note } = req.body || {};
  if (!c || !k || k !== orderLinkSig(c)) return res.status(403).json({ error: "Ссылка недействительна — попроси у поставщика новую" });

  try {
    const client = (await dbList("clients")).find(x => x.id === c);
    if (!client) return res.status(404).json({ error: "Клиент не найден — попроси у поставщика новую ссылку" });
    const prices = client.prices || [];

    if (action === "info") {
      return res.status(200).json({
        name: client.name,
        products: prices.map(p => ({ brand: p.brand, grade: p.grade, bag_kg: p.bag_kg, price_bag: Math.round((p.price_per_kg || 0) * (p.bag_kg || 0)) })),
      });
    }

    if (action === "submit") {
      if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "Выбери хотя бы одну позицию" });
      if (items.length > 10) return res.status(400).json({ error: "Слишком много позиций" });
      // дата: сегодня..+14 дней, иначе завтра
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const max = new Date(today); max.setDate(max.getDate() + 14);
      let d = new Date(String(date || "") + "T00:00:00");
      if (isNaN(d) || d < today || d > max) { d = new Date(today); d.setDate(d.getDate() + 1); }
      const dstr = d.toISOString().slice(0, 10);
      const cleanNote = String(note || "").slice(0, 300);
      let created = 0;
      for (const it of items) {
        // берём только позиции из прайса клиента; цена — серверная из прайса (подменить нельзя)
        const p = prices.find(x => x.brand === it.brand && x.grade === it.grade && Number(x.bag_kg) === Number(it.bag_kg));
        const bags = Math.round(Number(it.bags));
        if (!p || !(bags >= 1 && bags <= 2000)) continue;
        await dbUpsert("orders", {
          id: uid(), date: dstr, clientId: client.id, clientName: client.name,
          brand: p.brand, grade: p.grade, bag_kg: Number(p.bag_kg), bags,
          price_per_kg: p.price_per_kg || 0, status: "новая", driverId: "",
          from_client: true, note: cleanNote,
        });
        created++;
      }
      if (!created) return res.status(400).json({ error: "Не удалось принять заявку — проверь позиции" });
      return res.status(200).json({ ok: true, created, date: dstr });
    }

    return res.status(400).json({ error: "Неизвестное действие" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
