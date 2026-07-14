// «Что взять в фуру» — ИИ распределяет заданную вместимость фуры (кг) по сортам/фасовкам
// на основе спроса и текущих остатков. Считает данные на сервере, ключ Anthropic — там же.
import { verifyToken, dbList, configured } from "./_lib.js";

const fmt = n => Math.round(Number(n) || 0).toLocaleString("ru-RU");

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!configured()) return res.status(500).json({ error: "Сервер не настроен" });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "Нет ANTHROPIC_API_KEY" });

  const body = req.body || {};
  const u = verifyToken(body.token);
  if (!u || u.role !== "director") return res.status(403).json({ error: "Только для директора" });
  const capacity = Math.round(Number(body.capacity_kg) || 0);
  if (capacity <= 0) return res.status(400).json({ error: "Укажи вместимость фуры в кг" });

  try {
    const [orders, stock] = await Promise.all([dbList("orders"), dbList("stock")]);
    const now = new Date();
    const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 56);
    const weeks = 8;
    // только свой склад (карагандинские прямые отгрузки не с нашего склада)
    const recent = orders.filter(o => o.status === "отгружена" && !o.fromKaraganda && new Date(o.date) >= cutoff);

    // спрос за период по продукту (бренд+сорт) и по фасовке
    const soldProduct = {}, soldByPack = {};
    recent.forEach(o => {
      const kg = o.bags * o.bag_kg;
      const p = `${o.brand} ${o.grade}`;
      soldProduct[p] = (soldProduct[p] || 0) + kg;
      const pk = `${o.brand} ${o.grade} ${o.bag_kg}кг`;
      soldByPack[pk] = (soldByPack[pk] || 0) + kg;
    });
    // ожидаемый спрос на неделю по продукту (по дням недели)
    const demandWD = {};
    recent.forEach(o => { const wd = new Date(o.date).getDay(); const p = `${o.brand} ${o.grade}`; (demandWD[wd] = demandWD[wd] || {})[p] = (demandWD[wd][p] || 0) + o.bags * o.bag_kg; });
    const expected = {};
    for (let i = 1; i <= 7; i++) { const d = new Date(now); d.setDate(d.getDate() + i); const m = demandWD[d.getDay()] || {}; Object.entries(m).forEach(([p, kg]) => { expected[p] = (expected[p] || 0) + kg / weeks; }); }
    // остатки по продукту
    const stockByProduct = {};
    stock.forEach(s => { const p = `${s.brand} ${s.grade}`; stockByProduct[p] = (stockByProduct[p] || 0) + s.weight_kg; });

    if (recent.length === 0) return res.status(200).json({ advice: "Пока мало данных о продажах — рекомендация появится, когда накопится статистика за 2–4 недели." });

    const prompt = `Ты аналитик склада муки в Астане. Нужно загрузить фуру вместимостью ${fmt(capacity)} кг. Распредели ВЕСЬ этот объём по сортам/брендам и фасовкам так, чтобы покрыть спрос и не было дефицита. Сумма по позициям должна примерно равняться ${fmt(capacity)} кг.
Бренды: ДАРАД, ДАЛА НАН. Сорта: Высший сорт, Первый сорт. Фасовки: 5,10,25,50 кг.
Приоритет: сначала то, чего на складе меньше ожидаемого спроса; затем — самое ходовое.

Продажи за 8 недель (продукт — кг):
${Object.entries(soldProduct).sort((a, b) => b[1] - a[1]).map(([p, kg]) => `${p}: ${fmt(kg)} кг`).join("\n") || "нет данных"}

Ходовые фасовки (за 8 недель):
${Object.entries(soldByPack).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([p, kg]) => `${p}: ${fmt(kg)} кг`).join("\n") || "нет данных"}

Ожидаемый спрос на ближайшую неделю (продукт — кг):
${Object.entries(expected).map(([p, kg]) => `${p}: ~${fmt(kg)} кг`).join("\n") || "нет данных"}

Текущие остатки (продукт — кг):
${Object.entries(stockByProduct).map(([p, kg]) => `${p}: ${fmt(kg)} кг`).join("\n") || "пусто"}

ВАЖНО — формат ответа (на русском, простым текстом):
- НЕ используй markdown: никаких таблиц, символов *, #, | и линий ---.
- Первая строка: «Что взять (всего ${fmt(capacity)} кг):»
- Затем каждая позиция с новой строки ровно так: «Бренд Сорт, фасовка N кг — X кг (Y мешков)».
- Предпоследняя строка: «Итого: ${fmt(capacity)} кг».
- Последняя строка: одно короткое предложение — что в приоритете и почему.
- Без вступлений, без таблиц анализа.
- В САМОМ конце с новой строки выведи «===ITEMS===» и сразу JSON-массив тех же позиций (без markdown): [{"brand":"ДАЛА НАН","grade":"Высший сорт","bag_kg":25,"kg":2750}]. brand только ДАРАД или ДАЛА НАН; grade только «Высший сорт» или «Первый сорт»; bag_kg одно из 5,10,25,50; kg — число.`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 3000, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data?.error?.message || "Ошибка Anthropic API" });
    let advice = (data.content || []).map(b => b.text || "").join("").trim();
    // Отделяем структурированные позиции для кнопки «Запланировать фуру»
    let items = [];
    const idx = advice.indexOf("===ITEMS===");
    if (idx >= 0) {
      const jsonPart = advice.slice(idx + 11).replace(/```json|```/g, "").trim();
      advice = advice.slice(0, idx).trim();
      try {
        const arr = JSON.parse(jsonPart);
        if (Array.isArray(arr)) items = arr.filter(x => x && x.brand && x.grade && x.bag_kg && x.kg).map(x => ({ brand: String(x.brand), grade: String(x.grade), bag_kg: Number(x.bag_kg), kg: Math.round(Number(x.kg)) }));
      } catch {}
    }
    return res.status(200).json({ advice, items });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
