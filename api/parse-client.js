// Разбор данных клиента из свободного текста через Claude (для карточки клиента и договоров).
// Ключ Anthropic — в переменной окружения ANTHROPIC_API_KEY (на сервере, не в браузере).
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Только POST" });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "ANTHROPIC_API_KEY не настроен на сервере" });

  const { text } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: "Пустой текст" });

  const prompt = `Ты помощник склада муки в Казахстане. Извлеки данные клиента из текста и верни ТОЛЬКО JSON-объект без markdown.
Текст: "${text}"
Поля (если чего-то нет — пустая строка ""):
- name: короткое название заведения/торговой точки (как его называют в обиходе)
- org_name: полное юр. наименование (ИП «Фамилия» или ТОО «Название»)
- bin: БИН или ИИН (12 цифр)
- director: ФИО директора / в лице кого действует
- basis: на основании чего действует руководитель (напр. "Устава", "Свидетельства о гос. регистрации", "Доверенности №5"). Если в тексте об этом ничего нет — строго пустая строка "", НЕ выдумывай.
- contact_name: контактное лицо
- contact: телефон или WhatsApp (формат +7...)
- email: электронная почта
- address: фактический адрес доставки
- legal_address: юридический адрес (если отдельно указан; иначе пусто)
- bank: наименование банка (напр. Kaspi Bank, Halyk Bank)
- iik: ИИК / расчётный счёт (обычно начинается с KZ)
- bik: БИК банка
Верни строго JSON: {"name":"","org_name":"","bin":"","director":"","basis":"","contact_name":"","contact":"","email":"","address":"","legal_address":"","bank":"","iik":"","bik":""}
Только JSON.`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1024, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data?.error?.message || "Ошибка Anthropic API" });
    const raw = (data.content || []).map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
    return res.status(200).json({ raw });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
