// Серверная функция Vercel: разбирает поставку (фуру) из сообщения WhatsApp через Claude.
// Ключ Anthropic — в переменной окружения ANTHROPIC_API_KEY (на сервере, не в браузере).
// Промпт строится здесь, поэтому endpoint умеет только разбирать состав фуры на муку.

import { verifyToken, claudeJson } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Только POST" });

  // Требуем вход: без валидного токена не тратим Anthropic-ключ (защита от анонимной накрутки).
  if (!verifyToken((req.body || {}).token)) return res.status(401).json({ error: "Войдите заново" });

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
    // Haiku; если ответ не фура с датой и списком позиций — повтор на Sonnet
    const check = o => o && !Array.isArray(o) && Array.isArray(o.items) && /^\d{4}-\d{2}-\d{2}$/.test(String(o.date || "")) && o.items.every(i => Number(i && i.kg) >= 0);
    const out = await claudeJson(key, prompt, { max_tokens: 4000, check });
    if (out.error) return res.status(out.status || 500).json({ error: out.error });
    if ((req.body || {}).debug) return res.status(200).json({ raw: out.raw, model: out.model, stop_reason: out.stop_reason, fallback: !!out.fallback });
    return res.status(200).json({ raw: out.raw });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
