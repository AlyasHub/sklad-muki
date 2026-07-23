// Серверная функция Vercel: разбирает поставку (фуру) из сообщения WhatsApp через Claude.
// Ключ Anthropic — в переменной окружения ANTHROPIC_API_KEY (на сервере, не в браузере).
// Промпт строится здесь, поэтому endpoint умеет только разбирать состав фуры на муку.

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Только POST" });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "ANTHROPIC_API_KEY не настроен на сервере (добавь в Vercel → Settings → Environment Variables)" });

  const { text, today, tomorrow, weekday } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: "Пустое сообщение" });

  const prompt = `Ты помощник склада муки. Разбери сообщение о поставке (фура/машина с мукой от поставщика) и верни ТОЛЬКО JSON без markdown.
Сегодня ${today}, это ${weekday}. Завтра ${tomorrow}.
Бренды: ДАРАД, ДАЛА НАН. Сорта: Высший сорт, Первый сорт. Фасовки: 5, 10, 25, 50 кг.
Сообщение: "${text}"

Правила:
- Определи ПОЗИЦИИ (что и сколько едет): для каждой — бренд, сорт, фасовка (кг в мешке) и КОЛИЧЕСТВО В КИЛОГРАММАХ (kg).
- Если количество написано в ТОННАХ (т, тонн) — переведи в кг (1 т = 1000 кг). Если в мешках — умножь число мешков на фасовку и получи кг.
- Если бренд/сорт/фасовка не указаны явно — оставь пустую строку "" в этом поле (не выдумывай), но kg посчитай.
- Данные фуриста/машины (если есть в тексте): driver_name (имя фуриста/водителя), car_number (гос. номер машины), whatsapp (телефон фуриста, формат +7...), logist_phone (телефон логиста), price (цена за фуру в тенге, число).
- Дата прихода (date, формат YYYY-MM-DD): если указан день недели — ближайшая будущая дата с этим днём; "завтра"=${tomorrow}, "сегодня"=${today}; если не указана — ставь завтра (${tomorrow}).
- Чего в тексте нет — пустая строка "" (или 0 для price), НЕ придумывай.

Верни строго JSON:
{"date":"YYYY-MM-DD","driver_name":"","car_number":"","whatsapp":"","logist_phone":"","price":0,"items":[{"brand":"","grade":"","bag_kg":50,"kg":0}]}
Только JSON.`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 4000, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data?.error?.message || "Ошибка Anthropic API" });
    const raw = (data.content || []).map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
    if ((req.body || {}).debug) return res.status(200).json({ raw, model: data.model, stop_reason: data.stop_reason });
    return res.status(200).json({ raw });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
