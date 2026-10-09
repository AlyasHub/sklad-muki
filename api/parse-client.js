// Разбор данных клиента из свободного текста через Claude (для карточки клиента и договоров).
// Ключ Anthropic — в переменной окружения ANTHROPIC_API_KEY (на сервере, не в браузере).
import { verifyToken, claudeJson } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Только POST" });
  if (!verifyToken((req.body || {}).token)) return res.status(401).json({ error: "Войдите заново" });
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
    // Haiku; если ответ не объект клиента — повтор на Sonnet
    const out = await claudeJson(key, prompt, { max_tokens: 4000, check: o => o && typeof o === "object" && !Array.isArray(o) && ("name" in o || "org_name" in o) });
    if (out.error) return res.status(out.status || 500).json({ error: out.error });
    return res.status(200).json({ raw: out.raw });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
