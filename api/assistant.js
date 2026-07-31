// 🤖 ИИ-помощник: одно поле «напиши задачу» → Claude понимает, к чему это относится,
// и возвращает СТРУКТУРНОЕ действие (или ответ/уточнение). Само действие НЕ выполняется здесь —
// сервер только распознаёт и подставляет id клиента/цену/дату из базы; выполняет клиент после
// подтверждения пользователем (через обычный /api/data, где работает роль-контроль).
// Доступ — только администратор (director).
import { verifyToken, dbList, dbGet } from "./_lib.js";

const BRANDS = ["ДАРАД", "ДАЛА НАН"];
const GRADES = ["Высший сорт", "Первый сорт"];
const EXPENSE_CATS = ["Фура/Поставка", "Водители", "Грузчики", "Склад", "Аренда", "Зарплата", "Прочее"];
const PAY_METHODS = ["Kaspi перевод", "Kaspi QR", "Наличные", "Безнал"];
const fmt = n => Number(n || 0).toLocaleString("ru-RU");

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Только POST" });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "ANTHROPIC_API_KEY не настроен на сервере" });

  const { token, message } = req.body || {};
  const u = verifyToken(token);
  if (!u) return res.status(401).json({ error: "Сессия истекла — войдите заново" });
  const me = await dbGet("users", u.uid);
  if (!me) return res.status(401).json({ error: "Доступ закрыт — войдите заново" });
  if (me.role !== "director") return res.status(403).json({ error: "Помощник доступен только администратору" });
  if (!message || !String(message).trim()) return res.status(400).json({ error: "Пустая задача" });

  try {
    const [clients, orders, drivers, payments, stock, cashbox] = await Promise.all([
      dbList("clients"), dbList("orders"), dbList("drivers"),
      dbList("payments").catch(() => []), dbList("stock"), dbList("cashbox").catch(() => []),
    ]);

    // Даты по Астане (UTC+5)
    const nowAstana = new Date(Date.now() + 5 * 3600 * 1000);
    const today = nowAstana.toISOString().slice(0, 10);
    const tomorrow = new Date(nowAstana.getTime() + 864e5).toISOString().slice(0, 10);
    const weekday = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"][nowAstana.getUTCDay()];

    // Клиенты + их прайс (для подстановки цены и определения по адресу/названию)
    const clientLines = clients.map(c => {
      const prices = (c.prices || []).map(p => `${p.brand} ${p.grade} ${p.bag_kg}кг=${p.price_per_kg}тг/кг`).join(", ");
      return `- id:${c.id} | ${c.name}${c.org_name ? ` (${c.org_name})` : ""}${c.address ? ` | адрес: ${c.address}` : ""}${c.default_brand || c.default_bag_kg ? ` | обычно: ${c.default_brand || "?"} ${c.default_bag_kg || "?"}кг` : ""}${prices ? ` | цены: ${prices}` : " | цен нет"}`;
    }).join("\n");

    // Остатки склада
    const bal = {};
    stock.forEach(s => { const k = `${s.brand}|${s.grade}|${s.bag_kg}`; if (!bal[k]) bal[k] = { brand: s.brand, grade: s.grade, bag_kg: s.bag_kg, bags: 0, kg: 0 }; bal[k].bags += Number(s.bags) || 0; bal[k].kg += Number(s.weight_kg) || 0; });
    const stockLines = Object.values(bal).filter(b => b.kg !== 0).map(b => `- ${b.brand} ${b.grade} ${b.bag_kg}кг: ${fmt(b.kg)} кг (${fmt(b.bags)} меш.)`).join("\n") || "склад пуст";

    // Долги: отгружено-неоплачено минус ручные оплаты, по клиенту
    const debt = {};
    orders.filter(o => o.status === "отгружена" && !o.paid).forEach(o => { const sum = o.bags * o.bag_kg * (o.price_per_kg || 0); if (sum > 0) { const k = o.clientId || ("nm:" + (o.clientName || "")); debt[k] = (debt[k] || 0) + sum; } });
    (payments || []).forEach(p => { const k = p.clientId || ("nm:" + (p.clientName || "")); if (debt[k] != null) debt[k] -= (p.amount || 0); });
    const debtLines = Object.entries(debt).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => {
      const c = clients.find(x => x.id === k); return `- ${c ? c.name : k.replace("nm:", "")}: ${fmt(v)} тг`;
    }).join("\n") || "долгов нет";

    const cashBal = (cashbox || []).reduce((s, x) => s + (x.dir === "in" ? 1 : -1) * (x.amount || 0), 0);
    const driverLines = drivers.map(d => `- id:${d.id} | ${d.name}`).join("\n") || "нет";

    const prompt = `Ты — ИИ-помощник склада муки «Darad». Пользователь пишет задачу простым языком, ты определяешь, к чему она относится, и возвращаешь СТРОГО ОДИН JSON-объект без markdown и без пояснений вокруг.

СЕГОДНЯ ${today} (${weekday}). ЗАВТРА ${tomorrow}.
Бренды: ${BRANDS.join(", ")}. Сорта: ${GRADES.join(", ")}. Фасовки мешков: 5, 10, 25, 50 кг.
Способы оплаты (method): ${PAY_METHODS.join(", ")}.
Категории расходов (category): ${EXPENSE_CATS.join(", ")}.

КЛИЕНТЫ (сопоставляй нечётко — по имени, организации, части адреса, с опечатками, латиница=кириллица):
${clientLines}

ОСТАТКИ СКЛАДА:
${stockLines}

ДОЛГИ КЛИЕНТОВ (уже с учётом внесённых оплат):
${debtLines}

ВОДИТЕЛИ/РАБОЧИЕ:
${driverLines}

Касса (подотчёт) сейчас: остаток ${fmt(cashBal)} тг.

ФОРМАТ ОТВЕТА — один JSON-объект:
{
  "kind": "action" | "answer" | "clarify",
  "text": "для answer или clarify — короткий ответ/уточняющий вопрос на русском",
  "action": "create_order | add_payment | cashbox | add_expense | add_truck | mark_paid",
  "params": { ... },
  "summary": "человекочитаемое описание того, ЧТО будет сделано (для карточки подтверждения), на русском",
  "warn": "предупреждение если что-то неточно (клиента нет в базе, цена не найдена и т.п.), иначе пустая строка"
}

ПРАВИЛА:
- Если это ВОПРОС (сколько долг, что на складе, остаток кассы, кто должен) — kind:"answer", ответь кратко по данным выше.
- Если данных не хватает для действия (не ясен клиент/сумма/что именно) — kind:"clarify" с конкретным вопросом.
- Иначе kind:"action" с одним из действий:

create_order (создать заявку): params { "clientId":"id или пустая строка", "clientName":"точное имя из списка", "date":"YYYY-MM-DD", "note":"", "trial":false, "positions":[{"brand":"","grade":"","bag_kg":50,"bags":10,"price_per_kg":0}] }
  • Дата: день недели → ближайшая будущая с этим днём; "завтра"=${tomorrow}; "сегодня"=${today}; не указана → завтра (${tomorrow}).
  • Если сорт/бренд/фасовка не названы — бери из «обычно»/прайса клиента. Цену бери из прайса клиента для этой позиции.
  • Если цена в прайсе не найдена и это НЕ проба — kind:"clarify", спроси цену.
  • "на пробу"/"бесплатно"/"тест" → trial:true, цены 0.
  • Клиента нет в списке → clientId:"" , warn:"клиента нет в базе — заявка создастся по имени".

add_payment (клиент внёс деньги в счёт долга): params { "clientId":"", "clientName":"", "amount":100000, "method":"Наличные", "date":"${today}", "note":"" }
  • Способ не указан → "Наличные". Дата не указана → сегодня.

cashbox (касса — приход/трата подотчётных денег): params { "dir":"in"|"out", "amount":5000, "date":"${today}", "note":"на что / от кого" }
  • "потратил/расход/купил" → dir:"out". "дали/приход/получил" → dir:"in". Дата не указана → сегодня.

add_expense (расход КОМПАНИИ, не касса): params { "category":"Прочее", "amount":50000, "date":"${today}", "note":"" }
  • Используй, если явно про расход компании (аренда, зарплата, грузчики, фура). «расход с кассы» — это НЕ сюда, это action cashbox с dir:"out".

add_truck (приедет фура/поставка муки на склад): params { "date":"YYYY-MM-DD", "driver_name":"", "car_number":"", "price":0, "note":"", "items":[{"brand":"","grade":"","bag_kg":50,"kg":20000}] }
  • Дата — когда приедет. items — что везёт (в КГ). Если позиции не названы — items:[] и warn:"состав фуры не указан".

mark_paid (отметить конкретную отгрузку клиента оплаченной за дату): params { "clientId":"", "clientName":"", "date":"YYYY-MM-DD", "method":"Наличные" }
  • Только если пользователь явно про оплату за конкретную дату отгрузки. Для «внёс сумму в счёт долга» используй add_payment.

summary всегда заполняй понятной фразой с ключевыми числами. Верни только JSON.

ЗАДАЧА ПОЛЬЗОВАТЕЛЯ: "${String(message).replace(/"/g, "'").slice(0, 800)}"`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 4000, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data?.error?.message || "Ошибка Anthropic API" });
    let raw = (data.content || []).map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
    // на всякий случай вытащим внешние фигурные скобки
    const first = raw.indexOf("{"), last = raw.lastIndexOf("}");
    if (first > 0 || last < raw.length - 1) raw = raw.slice(first, last + 1);
    let result;
    try { result = JSON.parse(raw); } catch { return res.status(200).json({ error: "Не смог разобрать задачу — переформулируй попроще.", raw: (req.body || {}).debug ? raw : undefined }); }
    return res.status(200).json({ result, raw: (req.body || {}).debug ? raw : undefined, stop_reason: data.stop_reason });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
