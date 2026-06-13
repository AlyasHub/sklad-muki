// Серверная функция Vercel: разбирает заявку из WhatsApp через Claude.
// Ключ Anthropic хранится в переменной окружения ANTHROPIC_API_KEY (настраивается в Vercel),
// чтобы он никогда не попадал в браузерный код. Промпт строится здесь, на сервере,
// поэтому этот endpoint умеет только разбирать заявки на муку — его нельзя использовать для чего-то ещё.

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Только POST" });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "ANTHROPIC_API_KEY не настроен на сервере (добавь в Vercel → Settings → Environment Variables)" });

  const { text, clients = [], tomorrow } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: "Пустая заявка" });

  const clientInfo = clients.map(c =>
    `- ${c.name}${c.org_name ? ` (${c.org_name})` : ""}: фасовка ${c.default_bag_kg || "не указана"} кг, бренд ${c.default_brand || "не указан"}`
  ).join("\n");

  const prompt = `Ты помощник на складе муки. Разбери заявку и верни ТОЛЬКО JSON без markdown.
Клиенты и их настройки по умолчанию:
${clientInfo}
Бренды: ДАРАД, ДАЛА НАН. Сорта: Высший сорт, Первый сорт. Фасовки: 5,10,25,50 кг.
Заявка: "${text}"
Правила:
- Если клиент упомянул только кг — используй его фасовку по умолчанию и раздели кг на фасовку чтобы получить количество мешков
- Если у клиента есть бренд по умолчанию — используй его
- Если дата не указана — завтра (${tomorrow})
Верни JSON массив: [{"clientName":"...","brand":"...","grade":"...","bag_kg":25,"bags":40,"date":"YYYY-MM-DD"}]
Только JSON.`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data?.error?.message || "Ошибка Anthropic API" });
    const raw = (data.content || []).map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
    return res.status(200).json({ raw });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
