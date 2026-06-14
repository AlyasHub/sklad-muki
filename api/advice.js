// «Совет на неделю» — ИИ-рекомендация по закупу на основе статистики отгрузок.
// Считает данные на сервере (секретный ключ) и просит Claude написать рекомендацию.
import { verifyToken, dbList, configured } from "./_lib.js";

const WD = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const fmt = n => Math.round(Number(n) || 0).toLocaleString("ru-RU");

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!configured()) return res.status(500).json({ error: "Сервер не настроен" });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "Нет ANTHROPIC_API_KEY" });

  const u = verifyToken((req.body || {}).token);
  if (!u || u.role !== "director") return res.status(403).json({ error: "Только для директора" });

  try {
    const [orders, stock] = await Promise.all([dbList("orders"), dbList("stock")]);
    const now = new Date();
    const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 56);
    const recent = orders.filter(o => o.status === "отгружена" && new Date(o.date) >= cutoff);
    const weeks = 8;

    // спрос по дню недели и продукту
    const demandWD = {};
    recent.forEach(o => { const wd = new Date(o.date).getDay(); const p = `${o.brand} ${o.grade}`; (demandWD[wd] = demandWD[wd] || {})[p] = (demandWD[wd][p] || 0) + o.bags * o.bag_kg; });
    // ожидаемый спрос на ближайшие 7 дней
    const expected = {};
    for (let i = 1; i <= 7; i++) { const d = new Date(now); d.setDate(d.getDate() + i); const m = demandWD[d.getDay()] || {}; Object.entries(m).forEach(([p, kg]) => { expected[p] = (expected[p] || 0) + kg / weeks; }); }
    // остатки по продукту (бренд+сорт)
    const stockByProduct = {};
    stock.forEach(s => { const p = `${s.brand} ${s.grade}`; stockByProduct[p] = (stockByProduct[p] || 0) + s.weight_kg; });
    // постоянные клиенты
    const byClientWD = {};
    recent.forEach(o => { const c = o.clientName || "?"; const wd = new Date(o.date).getDay(); const k = byClientWD[c] = byClientWD[c] || {}; const v = k[wd] = k[wd] || { kg: 0, days: new Set() }; v.kg += o.bags * o.bag_kg; v.days.add(o.date); });
    const regulars = [];
    Object.entries(byClientWD).forEach(([c, wds]) => { let best = null; Object.entries(wds).forEach(([wd, v]) => { if (!best || v.days.size > best.days.size) best = { wd: +wd, ...v }; }); if (best && best.days.size >= 2) regulars.push(`${c}: обычно ${WD[best.wd]}, ~${fmt(best.kg / best.days.size)} кг`); });

    if (recent.length === 0) return res.status(200).json({ advice: "Пока мало данных об отгрузках — рекомендация появится, когда накопится статистика за 2–4 недели." });

    const prompt = `Ты аналитик склада муки в Астане. На основе статистики дай КРАТКУЮ практичную рекомендацию на ближайшую неделю на русском языке. Маркированный список, без воды, без вступлений.
Сегодня ${now.toISOString().slice(0, 10)} (${WD[now.getDay()]}).

Постоянные клиенты:
${regulars.join("\n") || "не выявлены"}

Ожидаемый спрос на ближайшую неделю (продукт — кг):
${Object.entries(expected).map(([p, kg]) => `${p}: ~${fmt(kg)} кг`).join("\n") || "нет данных"}

Текущие остатки на складе (продукт — кг):
${Object.entries(stockByProduct).map(([p, kg]) => `${p}: ${fmt(kg)} кг`).join("\n") || "пусто"}

Дай рекомендацию: что и примерно сколько докупить (где остаток меньше ожидаемого спроса), и какие клиенты в какие дни вероятно закажут. 4-8 пунктов.`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 700, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data?.error?.message || "Ошибка Anthropic API" });
    const advice = (data.content || []).map(b => b.text || "").join("").trim();
    return res.status(200).json({ advice });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
