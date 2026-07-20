// Автоматическая резервная копия базы. Запускается планировщиком Vercel раз в сутки.
// Проверить вручную: /api/backup
import { configured } from "./_lib.js";
import { makeSnapshot } from "./data.js";

export default async function handler(req, res) {
  if (!configured()) return res.status(500).json({ error: "Сервер не настроен" });
  try {
    const b = await makeSnapshot("автоматически");
    return res.status(200).json({ ok: true, ...b });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
