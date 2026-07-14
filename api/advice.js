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
  if (!u || !["director", "viewer"].includes(u.role)) return res.status(403).json({ error: "Только для администратора и директора" });

  try {
    const [orders, stock] = await Promise.all([dbList("orders"), dbList("stock")]);
    const now = new Date();
    const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 56);
    const recent = orders.filter(o => o.status === "отгружена" && !o.fromKaraganda && new Date(o.date) >= cutoff);
    const weeks = 8;

    // ВАЖНО: считаем по ПОЗИЦИЯМ (бренд + сорт + фасовка), а не только по продукту —
    // иначе нехватка «Высший сорт 25 кг» прячется за большим остатком «Высший сорт 50 кг».
    const pos = o => `${o.brand} ${o.grade}, мешки ${o.bag_kg} кг`;

    // спрос по дню недели и позиции
    const demandWD = {};
    recent.forEach(o => { const wd = new Date(o.date).getDay(); const p = pos(o); (demandWD[wd] = demandWD[wd] || {})[p] = (demandWD[wd][p] || 0) + o.bags * o.bag_kg; });
    // ожидаемый спрос на ближайшие 7 дней по позициям
    const expected = {};
    for (let i = 1; i <= 7; i++) { const d = new Date(now); d.setDate(d.getDate() + i); const m = demandWD[d.getDay()] || {}; Object.entries(m).forEach(([p, kg]) => { expected[p] = (expected[p] || 0) + kg / weeks; }); }
    // средние недельные продажи по позициям (для позиций, у которых есть история)
    const soldTotal = {};
    recent.forEach(o => { soldTotal[pos(o)] = (soldTotal[pos(o)] || 0) + o.bags * o.bag_kg; });
    // остатки по позициям: кг и мешки + фасовка для пересчёта
    const stockPos = {};
    stock.forEach(s => { const p = `${s.brand} ${s.grade}, мешки ${s.bag_kg} кг`; const v = stockPos[p] = stockPos[p] || { kg: 0, bags: 0, bag_kg: Number(s.bag_kg) || 0 }; v.kg += s.weight_kg; v.bags += Number(s.bags) || 0; });
    // уже запланированные заявки (новая/в пути) — этот объём тоже уйдёт со склада
    const reservedPos = {};
    orders.filter(o => (o.status === "новая" || o.status === "в пути") && !o.fromKaraganda).forEach(o => { reservedPos[pos(o)] = (reservedPos[pos(o)] || 0) + o.bags * o.bag_kg; });

    // Критичные позиции считаем ДЕТЕРМИНИРОВАННО (не доверяем это ИИ):
    // позиция продаётся (есть история), а свободного остатка меньше ожидаемого спроса на неделю
    const critical = [];
    const allPos = new Set([...Object.keys(soldTotal), ...Object.keys(stockPos)]);
    allPos.forEach(p => {
      const weekly = (soldTotal[p] || 0) / weeks;
      if (weekly <= 0) return; // не продаётся — не советуем закупать
      const st = stockPos[p] || { kg: 0, bags: 0, bag_kg: 0 };
      const free = Math.max(0, st.kg) - (reservedPos[p] || 0);
      const need = Math.max(expected[p] || 0, weekly);
      if (free < need) {
        const lackKg = need - free;
        const bagKg = st.bag_kg || Number((p.match(/мешки (\d+) кг/) || [])[1]) || 0;
        const bags = bagKg > 0 ? Math.ceil(lackKg / bagKg) : 0;
        critical.push({ p, free: Math.round(free), weekly: Math.round(weekly), lackKg: Math.round(lackKg), bags, cover: weekly > 0 ? Math.max(0, free) / (weekly / 7) : 99 });
      }
    });
    critical.sort((a, b) => a.cover - b.cover);

    // постоянные клиенты
    const byClientWD = {};
    recent.forEach(o => { const c = o.clientName || "?"; const wd = new Date(o.date).getDay(); const k = byClientWD[c] = byClientWD[c] || {}; const v = k[wd] = k[wd] || { kg: 0, days: new Set() }; v.kg += o.bags * o.bag_kg; v.days.add(o.date); });
    const regulars = [];
    Object.entries(byClientWD).forEach(([c, wds]) => { let best = null; Object.entries(wds).forEach(([wd, v]) => { if (!best || v.days.size > best.days.size) best = { wd: +wd, ...v }; }); if (best && best.days.size >= 2) regulars.push(`${c}: обычно ${WD[best.wd]}, ~${fmt(best.kg / best.days.size)} кг`); });

    if (recent.length === 0) return res.status(200).json({ advice: "Пока мало данных об отгрузках — рекомендация появится, когда накопится статистика за 2–4 недели." });

    // Таблица по позициям для ИИ: остаток, в заявках, продажи/нед, покрытие в днях
    const posTable = [...allPos].sort().map(p => {
      const st = stockPos[p] || { kg: 0, bags: 0 };
      const weekly = (soldTotal[p] || 0) / weeks;
      const cover = weekly > 0 ? (Math.max(0, st.kg) - (reservedPos[p] || 0)) / (weekly / 7) : null;
      return `${p}: остаток ${fmt(Math.max(0, st.kg))} кг (${Math.max(0, st.bags)} меш.), в заявках ${fmt(reservedPos[p] || 0)} кг, продажи ~${fmt(weekly)} кг/нед${cover !== null ? `, хватит на ~${Math.max(0, Math.round(cover))} дн.` : ", продаж не было"}`;
    });

    const prompt = `Ты аналитик склада муки в Астане. На основе статистики дай КРАТКУЮ практичную рекомендацию на ближайшую неделю на русском языке. Маркированный список, без воды, без вступлений.
Сегодня ${now.toISOString().slice(0, 10)} (${WD[now.getDay()]}).

ПОЗИЦИИ СКЛАДА (бренд, сорт, фасовка — каждая фасовка отдельно!):
${posTable.join("\n") || "пусто"}

Ожидаемый спрос на ближайшие 7 дней (по дням недели за 8 недель):
${Object.entries(expected).map(([p, kg]) => `${p}: ~${fmt(kg)} кг`).join("\n") || "нет данных"}

Постоянные клиенты:
${regulars.join("\n") || "не выявлены"}

ПРАВИЛА:
- ОБЯЗАТЕЛЬНО перечисли КАЖДУЮ позицию, где покрытие меньше 7 дней — с конкретным числом мешков к закупке (округляй вверх до целых мешков).
- Каждая фасовка — отдельная позиция: если «Высший сорт 50 кг» много, а «Высший сорт 25 кг» мало — 25 кг всё равно нужно докупать.
- Учитывай, что объём «в заявках» тоже уйдёт со склада.
- Потом 2-3 пункта: какие клиенты в какие дни вероятно закажут.
Всего 4-8 пунктов.`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 3000, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data?.error?.message || "Ошибка Anthropic API" });
    let advice = (data.content || []).map(b => b.text || "").join("").trim();
    // Гарантированный блок «срочно докупить» — считается сервером, ИИ его пропустить не может
    if (critical.length) {
      const urgent = critical.map(c => `• ${c.p}: свободно ${fmt(c.free)} кг, продажи ~${fmt(c.weekly)} кг/нед → докупить ~${c.bags} меш.`).join("\n");
      advice = `⚠️ МАЛО НА СКЛАДЕ (докупить в первую очередь):\n${urgent}\n\n${advice}`;
    }
    return res.status(200).json({ advice });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
