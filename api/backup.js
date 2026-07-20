// Еженедельная резервная копия базы: сохраняется в базе и уходит файлом на почту.
// Запускается планировщиком Vercel по воскресеньям. Проверить вручную: /api/backup
import { configured } from "./_lib.js";
import { makeSnapshot, getSnapshot } from "./data.js";

const fmt = n => Number(n || 0).toLocaleString("ru-RU");
const TABLE_RU = { clients: "Клиенты", stock: "Движения склада", orders: "Заявки", drivers: "Рабочие", trucks: "Фуры", users: "Пользователи", expenses: "Расходы" };

export default async function handler(req, res) {
  if (!configured()) return res.status(500).json({ error: "Сервер не настроен" });
  try {
    const meta = await makeSnapshot("автоматически (еженедельно)");
    const apiKey = process.env.RESEND_API_KEY;
    const to = process.env.REPORT_EMAIL;
    const from = process.env.REPORT_FROM || "Склад Муки <onboarding@resend.dev>";
    if (!apiKey || !to) return res.status(200).json({ ok: true, ...meta, mail: "не настроена почта (RESEND_API_KEY / REPORT_EMAIL)" });

    // Берём снимок целиком и вычищаем хэши паролей — в письмо они не идут
    const snap = await getSnapshot(meta.id);
    const data = { ...snap.data, users: (snap.data.users || []).map(({ passhash, ...r }) => r) };
    const payload = { id: snap.id, at: snap.at, by: snap.by, counts: snap.counts, data };
    const dateStr = String(snap.at).slice(0, 10);
    const total = Object.values(meta.counts || {}).reduce((s, n) => s + n, 0);
    const lines = Object.entries(meta.counts || {}).map(([t, n]) => `• ${TABLE_RU[t] || t}: ${fmt(n)}`);

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: to.split(",").map(s => s.trim()).filter(Boolean),
        subject: `Резервная копия базы — ${dateStr.split("-").reverse().join(".")}`,
        text: [
          `Еженедельная резервная копия базы «Darad».`,
          ``,
          `Дата: ${dateStr.split("-").reverse().join(".")}`,
          `Всего записей: ${fmt(total)}`,
          ``,
          ...lines,
          ``,
          `Файл во вложении — сохрани его, этого достаточно для полного восстановления данных.`,
          `Пароли пользователей в копию не входят.`,
          ``,
          `Все копии также доступны в приложении: ⚙️ Доступ → «Копии базы и журнал изменений».`,
        ].join("\n"),
        attachments: [{ filename: `Kopiya_bazy_${dateStr}.json`, content: Buffer.from(JSON.stringify(payload, null, 2), "utf8").toString("base64") }],
      }),
    });
    const mail = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(200).json({ ok: true, ...meta, mail: "ошибка отправки: " + (mail?.message || JSON.stringify(mail)) });
    return res.status(200).json({ ok: true, ...meta, mail: "отправлено", mailId: mail.id });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
