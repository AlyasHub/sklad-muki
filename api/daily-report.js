// Авто-отчёт за день на почту (через Resend). Вызывается планировщиком (Vercel Cron) раз в день.
// Проверить вручную: /api/daily-report?date=YYYY-MM-DD
import { dbList } from "./_lib.js";

const fmt = n => Number(n || 0).toLocaleString("ru-RU");

// Нехватка муки: спрос неотгруженных заявок (новая + в пути) против остатка на складе
function buildShortages(orders, stock) {
  const bal = {};
  (stock || []).forEach(s => { const k = `${s.brand}|${s.grade}|${s.bag_kg}`; bal[k] = (bal[k] || 0) + Number(s.bags || 0); });
  const need = {};
  orders.filter(o => o.status === "новая" || o.status === "в пути").forEach(o => { const k = `${o.brand}|${o.grade}|${o.bag_kg}`; need[k] = (need[k] || 0) + Number(o.bags || 0); });
  const out = [];
  Object.entries(need).forEach(([k, n]) => { const have = Math.max(0, bal[k] || 0); if (n > have) { const [brand, grade, bag_kg] = k.split("|"); out.push({ brand, grade, bag_kg, need: n, have, lack: n - have }); } });
  return out.sort((a, b) => b.lack - a.lack);
}

function buildText(dateStr, day, clients, drivers, orders, stock) {
  const dDisplay = dateStr.split("-").reverse().join(".");
  const shortages = buildShortages(orders || [], stock);
  const shortBlock = shortages.length
    ? "\n\n⚠️ НЕ ХВАТАЕТ МУКИ ПОД ЗАЯВКИ:\n" + shortages.map(s => `• ${s.brand} ${s.grade} ${s.bag_kg}кг — нужно ${s.need} меш., на складе ${s.have} → не хватает ${s.lack} меш.`).join("\n") + "\nЗакажи приход или перенеси часть заявок."
    : "";
  if (!day.length) return `Отчёт за ${dDisplay}\n\nЗа день отгрузок нет.${shortBlock}`;
  const totalKg = day.reduce((s, o) => s + o.bags * o.bag_kg, 0);
  const totalSum = day.reduce((s, o) => s + o.bags * o.bag_kg * (o.price_per_kg || 0), 0);
  const groups = {};
  day.forEach(o => { const k = o.clientId || ("nm:" + (o.clientName || "")); (groups[k] = groups[k] || { name: o.clientName, clientId: o.clientId, orders: [] }).orders.push(o); });
  const L = [`Отчёт за ${dDisplay}`, "==============================", `Заявок: ${Object.keys(groups).length}  ·  Отгружено: ${fmt(totalKg)} кг  ·  Сумма: ${fmt(totalSum)} тг`, ""];
  Object.values(groups).forEach(g => {
    const client = clients.find(c => c.id === g.clientId);
    const statuses = [...new Set(g.orders.map(o => o.status))];
    const st = statuses.length === 1 ? statuses[0] : "частично";
    const drv = drivers.find(d => d.id === g.orders[0].driverId);
    const gKg = g.orders.reduce((s, o) => s + o.bags * o.bag_kg, 0);
    L.push(`• ${g.name}${client?.org_name ? ` (${client.org_name})` : ""} — ${st}${drv ? `, водитель: ${drv.name}` : ""} — ${fmt(gKg)} кг`);
    g.orders.forEach(o => L.push(`    - ${o.brand} ${o.grade} ${o.bag_kg}кг × ${o.bags} = ${fmt(o.bags * o.bag_kg)} кг`));
  });
  const byDrv = {};
  day.forEach(o => { if (!o.driverId) return; const dr = drivers.find(x => x.id === o.driverId); if (!dr) return; byDrv[o.driverId] = byDrv[o.driverId] || { name: dr.name, kg: 0, pay: 0 }; const kg = o.bags * o.bag_kg; byDrv[o.driverId].kg += kg; byDrv[o.driverId].pay += kg * (dr.rate_per_kg || 0); });
  if (Object.keys(byDrv).length) { L.push("", "Водители:"); Object.values(byDrv).forEach(v => L.push(`• ${v.name}: ${fmt(v.kg)} кг · к оплате ${fmt(v.pay)} тг`)); }
  return L.join("\n") + shortBlock;
}

function buildCsv(day, clients, drivers) {
  const headers = ["Дата", "Клиент", "Организация", "Бренд", "Сорт", "Фасовка кг", "Мешков", "Кг", "Цена тг/кг", "Сумма тг", "Статус", "Водитель", "Внёс"];
  const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = day.map(o => {
    const client = clients.find(c => c.id === o.clientId);
    const drv = drivers.find(d => d.id === o.driverId);
    const kg = o.bags * o.bag_kg;
    return [o.date, o.clientName, client?.org_name || "", o.brand, o.grade, o.bag_kg, o.bags, kg, o.price_per_kg || 0, kg * (o.price_per_kg || 0), o.status, drv?.name || "", o.created_by_name || ""];
  });
  return "﻿" + [headers, ...rows].map(r => r.map(esc).join(";")).join("\r\n");
}

export default async function handler(req, res) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.REPORT_EMAIL;
  const from = process.env.REPORT_FROM || "Склад Муки <onboarding@resend.dev>";
  if (!apiKey || !to) return res.status(500).json({ error: "Не настроены RESEND_API_KEY / REPORT_EMAIL в Vercel" });

  try {
    const dateStr = (req.query && req.query.date) || new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10); // дата по Астане (UTC+5)
    const [orders, clients, drivers, stock] = await Promise.all([dbList("orders"), dbList("clients"), dbList("drivers"), dbList("stock")]);
    const day = orders.filter(o => o.date === dateStr);
    const dDisplay = dateStr.split("-").reverse().join(".");

    const attachments = [];
    if (day.length) attachments.push({ filename: `Sklad_${dateStr}.csv`, content: Buffer.from(buildCsv(day, clients, drivers), "utf8").toString("base64") });

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: to.split(",").map(s => s.trim()).filter(Boolean),
        subject: `Отчёт склада за ${dDisplay}`,
        text: buildText(dateStr, day, clients, drivers, orders, stock),
        attachments,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: data?.message || JSON.stringify(data) });
    return res.status(200).json({ ok: true, date: dateStr, orders: day.length, id: data.id });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
