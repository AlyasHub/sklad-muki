// Серверная функция Vercel: разбирает заявку из WhatsApp через Claude.
// Ключ Anthropic хранится в переменной окружения ANTHROPIC_API_KEY (настраивается в Vercel),
// чтобы он никогда не попадал в браузерный код. Промпт строится здесь, на сервере,
// поэтому этот endpoint умеет только разбирать заявки на муку — его нельзя использовать для чего-то ещё.

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Только POST" });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "ANTHROPIC_API_KEY не настроен на сервере (добавь в Vercel → Settings → Environment Variables)" });

  const { text, clients = [], today, tomorrow, weekday } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: "Пустая заявка" });

  const clientInfo = clients.map(c => {
    const prods = (c.products || []).map(p => `${p.grade} ${p.brand} ${p.bag_kg}кг`);
    return `- ${c.name}${c.org_name ? ` (${c.org_name})` : ""}${c.address ? `; адрес: ${c.address}` : ""}${c.contact_name ? `; контакт: ${c.contact_name}` : ""}: фасовка по умолч. ${c.default_bag_kg || "?"} кг, бренд по умолч. ${c.default_brand || "?"}${prods.length ? `; ОБЫЧНО БЕРЁТ: ${prods.join(", ")}` : ""}`;
  }).join("\n");

  const prompt = `Ты помощник на складе муки. Разбери заявку и верни ТОЛЬКО JSON без markdown.
Сегодня ${today}, это ${weekday}. Завтра ${tomorrow}.
Клиенты и их настройки:
${clientInfo}
Бренды: ДАРАД, ДАЛА НАН. Сорта: Высший сорт, Первый сорт. Фасовки: 5,10,25,50 кг.
Заявка: "${text}"
Определение клиента (ВАЖНО):
- Клиента могут назвать по имени, по названию организации, по имени контакта ИЛИ ПРОСТО ПО АДРЕСУ доставки (например «абая 10 мука 500 кг» — найди в списке клиента с адресом, где есть «Абая 10»).
- Сопоставляй нечётко: опечатки, сокращения, часть адреса, латиница/кириллица («сегафредо» = «Segafredo»).
- В "clientName" ВСЕГДА возвращай ТОЧНОЕ название клиента из списка выше (не адрес и не то, как написали в заявке). Только если совпадения в списке правда нет — верни как написано в заявке.
Правила определения даты (всегда возвращай реальную дату в формате YYYY-MM-DD):
- Если указан день недели (понедельник, вторник, среда и т.д.) — найди БЛИЖАЙШУЮ будущую дату с этим днём недели, считая от сегодня (${today}, ${weekday}). Если этот день недели сегодня — бери сегодня.
- "завтра" = ${tomorrow}. "сегодня" = ${today}.
- Если дата вообще не указана — ставь завтра (${tomorrow}).
Правила количества:
- Если клиент упомянул только кг — используй его фасовку по умолчанию и раздели кг на фасовку чтобы получить число мешков.
ВАЖНО — сорт и бренд:
- Если сорт или бренд НЕ указаны явно в заявке — бери те, что этот клиент ОБЫЧНО БЕРЁТ (из списка выше). Если у него там один сорт — используй именно его. НЕ ставь наугад «Высший сорт», если клиент обычно берёт «Первый сорт».
- Бренд аналогично: если не указан — бренд по умолчанию клиента или тот, что он обычно берёт.
Правило «на пробу»:
- Если в заявке есть слова «на пробу», «пробу», «проба», «пробную», «бесплатно», «бесплатная», «тест», «тестовую», «попробовать» — это бесплатная проба клиенту: поставь "trial": true. Иначе "trial": false.
Заметка ("note"):
- Любые особые пожелания/пометки из сообщения, не относящиеся к товару/количеству/дате (например «с отлёжкой», «оставить у охраны», «позвонить перед приездом», «занести на второй этаж»). Если таких нет — пустая строка "".
Верни JSON массив: [{"clientName":"...","brand":"...","grade":"...","bag_kg":25,"bags":40,"date":"YYYY-MM-DD","trial":false,"note":""}]
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
        model: "claude-sonnet-5",
        max_tokens: 4000,
        messages: [{ role: "user", content: prompt }],
      }),
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
