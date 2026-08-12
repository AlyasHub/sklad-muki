// Разбор лабораторного анализа муки из свободного текста/протокола через Claude.
// Ключ Anthropic — в переменной окружения ANTHROPIC_API_KEY (на сервере, не в браузере).
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Только POST" });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "ANTHROPIC_API_KEY не настроен на сервере" });

  const { text, today } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: "Пустой текст анализа" });

  const prompt = `Ты — лаборант мукомольного производства в Казахстане. Извлеки показатели анализа муки из текста/протокола и верни ТОЛЬКО JSON-объект без markdown.
Сегодня ${today || ""}.
Текст анализа: "${text}"
Поля (если показателя в тексте нет — верни пустую строку "", НЕ выдумывай значения):
- brand: марка/бренд муки. Обычно «ДАРАД» или «ДАЛА НАН». Если написано иначе — верни как в тексте.
- grade: сорт. Обычно «Высший сорт» или «Первый сорт». «в/с», «высш» = «Высший сорт»; «1 с», «первый» = «Первый сорт».
- prod_date: дата производства в формате YYYY-MM-DD (переведи из дд.мм.гггг). Если не указана — пусто.
- moisture: влажность, % — только число (например «14.2»). Запятую замени на точку.
- whiteness: белизна — только число (условные единицы прибора).
- gluten: массовая доля сырой клейковины, % — только число.
- idk_group: группа ИДК (например «I», «II», «III» — римскими). «2 группа» → «II».
- idk: показатель ИДК, ед. прибора — только число (например «75»).
- falling_number: число падения (ЧП), секунд — только число (например «320»).
- extra: доп. показатель — любой дополнительный показатель с его названием и значением, как в тексте (например «зольность 0.55%»). Если нет — пусто.
Верни строго JSON: {"brand":"","grade":"","prod_date":"","moisture":"","whiteness":"","gluten":"","idk_group":"","idk":"","falling_number":"","extra":""}
Только JSON.`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 2000, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data?.error?.message || "Ошибка Anthropic API" });
    const raw = (data.content || []).map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
    return res.status(200).json({ raw });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
