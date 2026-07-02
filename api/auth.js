// Вход / создание первого директора. Проверяет пароль на сервере и выдаёт подписанный токен.
import { sha256, signToken, dbList, dbUpsert, configured } from "./_lib.js";

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const makeToken = u => signToken({ uid: u.id, role: u.role, driverId: u.driverId || "", name: u.name, exp: Date.now() + 30 * 864e5 });
const pub = u => ({ id: u.id, name: u.name, username: u.username, role: u.role, driverId: u.driverId || "" });

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!configured()) return res.status(500).json({ error: "Сервер не настроен: добавь SUPABASE_SERVICE_KEY и AUTH_SECRET в Vercel" });

  const { action, username, password, name } = req.body || {};

  try {
    // Проверка: нужен ли первый пользователь (для экрана входа). Без пароля.
    if (action === "status") {
      const users = await dbList("users");
      return res.status(200).json({ bootstrap: users.length === 0 });
    }

    if (!username || !password) return res.status(400).json({ error: "Введи логин и пароль" });
    const users = await dbList("users");
    const hash = sha256(password);

    if (action === "bootstrap") {
      if (users.length > 0) return res.status(400).json({ error: "Пользователь уже создан — войдите" });
      const u = { id: uid(), name: (name || "").trim(), username: username.trim(), passhash: hash, role: "director", driverId: "" };
      await dbUpsert("users", u);
      return res.status(200).json({ token: makeToken(u), user: pub(u) });
    }

    const u = users.find(x => (x.username || "").toLowerCase() === username.trim().toLowerCase() && x.passhash === hash);
    if (!u) return res.status(401).json({ error: "Неверный логин или пароль" });
    // Журнал входов (для админа: кто и когда заходил)
    try { await dbUpsert("logins", { id: uid(), userId: u.id, name: u.name, username: u.username, role: u.role, at: new Date().toISOString() }); } catch {}
    return res.status(200).json({ token: makeToken(u), user: pub(u) });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
