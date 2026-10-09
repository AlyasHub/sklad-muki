// Общие серверные утилиты: подпись токенов и доступ к Supabase сервисным ключом.
// Файлы с _ в начале Vercel НЕ превращает в эндпоинты — это просто модуль.
import crypto from "crypto";

// Адрес базы можно переопределить переменной окружения (полигон/стейджинг смотрит на свою базу).
// Без переменной — рабочая (боевая) база, как было: живой сайт ведёт себя без изменений.
export const SUPA_URL = process.env.SUPABASE_URL || "https://lemcpwgmsvsvrrxpzjgx.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const AUTH_SECRET = process.env.AUTH_SECRET;

export function configured() { return !!SERVICE_KEY && !!AUTH_SECRET; }

function svc() {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
}

export function sha256(str) {
  return crypto.createHash("sha256").update(String(str), "utf8").digest("hex");
}

export function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", AUTH_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expect = crypto.createHmac("sha256", AUTH_SECRET).update(body).digest("base64url");
  // сравнение постоянного времени
  const a = Buffer.from(sig); const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

// Доступ к таблицам сервисным ключом (обходит RLS — поэтому только на сервере)
// ВАЖНО: PostgREST/Supabase отдаёт максимум 1000 строк за один ответ. Раньше запрос был без
// постраничности — большие таблицы (журнал входов, склад, заявки) молча ОБРЕЗАЛИСЬ до 1000,
// причём в порядке вставки (сначала старые) → терялись свежие данные и «плыл» баланс склада.
// Теперь тянем ВСЕ строки постранично (по 1000), по стабильному порядку id.
export async function dbList(table) {
  const PAGE = 1000;
  let out = [], from = 0;
  for (;;) {
    const r = await fetch(`${SUPA_URL}/rest/v1/${table}?select=data&order=id.asc&limit=${PAGE}&offset=${from}`, { headers: svc() });
    if (!r.ok) throw new Error(await r.text());
    const rows = await r.json();
    for (const row of rows) out.push(row.data);
    if (rows.length < PAGE) break;
    from += PAGE;
    if (from > 500000) break; // предохранитель от бесконечного цикла
  }
  return out;
}
// Выборка по готовому запросу (сортировка/лимит) — чтобы не тянуть всю таблицу, когда нужны
// только свежие N записей (например, последние 200 входов). Возвращает сырые строки.
export async function dbSelect(table, query) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${table}?${query}`, { headers: svc() });
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}
// Удаление по условию (не по одному id) — например, подчистить старые записи журнала одним запросом.
export async function dbDeleteWhere(table, filter) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${table}?${filter}`, { method: "DELETE", headers: { ...svc(), Prefer: "return=minimal" } });
  if (!r.ok) throw new Error(await r.text());
}
// Одна запись по id — вместо «скачать всю таблицу и найти». Быстро (индекс по первичному ключу).
export async function dbGet(table, id) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}&select=data&limit=1`, { headers: svc() });
  if (!r.ok) throw new Error(await r.text());
  const rows = await r.json();
  return rows.length ? rows[0].data : null;
}
// Записи по значению поля внутри data (jsonb) — фильтрует сервер БД, а не мы в памяти.
export async function dbFindBy(table, field, value) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${table}?data->>${encodeURIComponent(field)}=eq.${encodeURIComponent(value)}&select=data`, { headers: svc() });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()).map(row => row.data);
}
export async function dbUpsert(table, item) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...svc(), Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ id: item.id, data: item }),
  });
  if (!r.ok) throw new Error(await r.text());
}
export async function dbDelete(table, id) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${table}?id=eq.${id}`, { method: "DELETE", headers: svc() });
  if (!r.ok) throw new Error(await r.text());
}

export const SERVICE_KEY_RAW = SERVICE_KEY; // для загрузки фото

// Подпись для клиентской заказ-ссылки: без неё чужой не сможет ни увидеть прайс, ни отправить заявку
export function orderLinkSig(clientId) {
  return crypto.createHmac("sha256", AUTH_SECRET).update("order-link:" + clientId).digest("base64url").slice(0, 20);
}

// 🤖 Claude для простого разбора текста в JSON (заявки, клиенты, фуры, анализы).
// Сначала быстрая и дешёвая Haiku; если её ответ не JSON, не прошёл проверку check (клиент не из
// списка и т.п.), обрезан или она недоступна — тот же запрос повторяем на Sonnet.
// Возвращает { raw, model, stop_reason } (raw — чистый JSON-текст) или { error, status }.
export const FAST_MODEL = "claude-haiku-4-5-20251001";
export const SMART_MODEL = "claude-sonnet-5";

async function claudeCall(key, model, prompt, max_tokens) {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { error: data?.error?.message || "Ошибка Anthropic API", status: r.status };
    let raw = (data.content || []).map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
    // модель иногда добавляет фразу до/после JSON — оставляем только сам JSON
    const a = raw.search(/[[{]/), b = Math.max(raw.lastIndexOf("}"), raw.lastIndexOf("]"));
    if (a > 0 || (b >= 0 && b < raw.length - 1)) raw = raw.slice(Math.max(a, 0), b + 1);
    return { raw, model: data.model || model, stop_reason: data.stop_reason };
  } catch (e) {
    return { error: String(e.message || e), status: 500 };
  }
}

export async function claudeJson(key, prompt, { max_tokens = 4000, check } = {}) {
  const fast = await claudeCall(key, FAST_MODEL, prompt, max_tokens);
  if (!fast.error && fast.stop_reason !== "max_tokens") {
    try { if (!check || check(JSON.parse(fast.raw))) return fast; } catch { /* не JSON — повторим на Sonnet */ }
  }
  return { ...(await claudeCall(key, SMART_MODEL, prompt, max_tokens)), fallback: true };
}
