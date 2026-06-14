// Общие серверные утилиты: подпись токенов и доступ к Supabase сервисным ключом.
// Файлы с _ в начале Vercel НЕ превращает в эндпоинты — это просто модуль.
import crypto from "crypto";

export const SUPA_URL = "https://lemcpwgmsvsvrrxpzjgx.supabase.co";
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
export async function dbList(table) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${table}?select=*`, { headers: svc() });
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
