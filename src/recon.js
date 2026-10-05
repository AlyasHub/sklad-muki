// 🧾 Сверка долга по месяцам. Сверка = «долг клиента на начало дня D равен A».
//  • «Долг на начало сентября» = точка 01.09; «на конец сентября» = точка 01.10 (то же, что «на начало октября»).
//  • Записываем корректировку (оплата adjust:true, способ «Сверка») последним днём перед D на разницу между
//    долгом в приложении и сверкой — как «Выставить долг по акту сверки», только на дату. После этого «Долги»,
//    история клиента и Excel-отчёт показывают ровно сверенные цифры.
//  • id детерминированный (rc_<клиент>_<D>): повторная сверка той же даты пересчитывает ту же запись.
//  • Более поздние сверки клиента после правки пересчитываются, чтобы каждая держала свою цифру.
// Долг считаем как раздел «Долги»: неоплаченные отгрузки − все оплаты и корректировки.

export const reconId = (clientId, D) => `rc_${clientId}_${D}`;
const pad = n => String(n).padStart(2, "0");
export const dayBefore = D => { const d = new Date(D + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
export const monthFirst = ym => `${ym}-01`;
export const nextMonthFirst = ym => { let [y, m] = ym.split("-").map(Number); if (++m > 12) { m = 1; y++; } return `${y}-${pad(m)}-01`; };
export const monthLast = ym => dayBefore(nextMonthFirst(ym));
const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
export const monthLabel = ym => { const [y, m] = ym.split("-").map(Number); return `${MONTHS[m - 1]} ${y}`; };
// Последние n месяцев (новые сверху), формат "2026-09"
export function recentMonths(today, n = 18) {
  let [y, m] = today.slice(0, 7).split("-").map(Number);
  const out = [];
  for (let i = 0; i < n; i++) { out.push(`${y}-${pad(m)}`); if (--m < 1) { m = 12; y--; } }
  return out;
}
const dmy = s => String(s || "").split("-").reverse().join(".");
const money = n => Math.round(Number(n) || 0).toLocaleString("ru-RU");
const r2 = x => Math.round((Number(x) || 0) * 100) / 100;

// Долг клиента на начало дня D (без записи exceptId — чтобы пересчитать саму сверку)
export function debtAt(clientId, D, orders, payments, exceptId = "") {
  let s = 0;
  for (const o of orders || []) {
    if (o.clientId !== clientId || o.status !== "отгружена" || o.paid || !(o.date < D)) continue;
    s += (Number(o.bags) || 0) * (Number(o.bag_kg) || 0) * (Number(o.price_per_kg) || 0);
  }
  for (const p of payments || []) if (p.clientId === clientId && p.id !== exceptId && (p.date || "") < D) s -= Number(p.amount) || 0;
  return r2(s);
}
// Сверки клиента (новые сверху)
export const clientCheckpoints = (clientId, payments) => (payments || []).filter(p => p.clientId === clientId && p.recon).sort((a, b) => b.recon.localeCompare(a.recon));
// Разошлась ли сверка (задним числом внесли отгрузку/оплату): долг в приложении на эту дату ≠ сверенному
export const checkpointDrift = (p, orders, payments) => r2(debtAt(p.clientId, p.recon, orders, payments) - (Number(p.recon_amount) || 0));

function checkpointRecord(client, D, A, orders, payments) {
  const id = reconId(client.id, D);
  const cur = debtAt(client.id, D, orders, payments, id);
  return {
    id, clientId: client.id, clientName: client.name, date: dayBefore(D),
    amount: r2(cur - A), method: "Сверка", adjust: true, recon: D, recon_amount: r2(A),
    note: `Сверка: долг на ${dmy(D)} = ${money(A)} тг (в приложении было ${money(cur)} тг)`,
  };
}

// Сохранить сверки клиента: entries = [{ D, A }] (A = null — удалить эту сверку). Потом пересчитать все более
// поздние сверки клиента, чтобы каждая держала свою цифру. Возвращает число записанных изменений.
export async function saveCheckpoints({ client, entries, orders, payments, dbUpsert, dbDelete }) {
  let pays = [...(payments || [])];
  let changed = 0;
  const list = [...entries].sort((a, b) => a.D.localeCompare(b.D));
  if (!list.length) return 0;
  for (const { D, A } of list) {
    const id = reconId(client.id, D);
    if (A === null || A === undefined || A === "") {
      if (pays.some(p => p.id === id)) { await dbDelete("payments", id); pays = pays.filter(p => p.id !== id); changed++; }
      continue;
    }
    const rec = checkpointRecord(client, D, Number(A), orders, pays);
    await dbUpsert("payments", rec);
    pays = pays.filter(p => p.id !== id).concat(rec);
    changed++;
  }
  // более поздние сверки этого клиента — пересчитать (корректировка зависит от всего, что раньше)
  const fromD = list[0].D;
  const later = pays.filter(p => p.clientId === client.id && p.recon && p.recon > fromD && !list.some(e => e.D === p.recon)).sort((a, b) => a.recon.localeCompare(b.recon));
  for (const p of later) {
    const rec = checkpointRecord(client, p.recon, Number(p.recon_amount) || 0, orders, pays);
    if (Math.abs(rec.amount - (Number(p.amount) || 0)) >= 0.01) {
      await dbUpsert("payments", rec);
      pays = pays.filter(x => x.id !== rec.id).concat(rec);
      changed++;
    }
  }
  return changed;
}

// Пересчитать все сверки клиента (если «разошлись» после правок задним числом)
export async function resyncCheckpoints({ client, orders, payments, dbUpsert }) {
  let pays = [...(payments || [])];
  let changed = 0;
  for (const p of clientCheckpoints(client.id, pays).reverse()) { // от старых к новым
    const rec = checkpointRecord(client, p.recon, Number(p.recon_amount) || 0, orders, pays);
    if (Math.abs(rec.amount - (Number(p.amount) || 0)) < 0.01) continue;
    await dbUpsert("payments", rec);
    pays = pays.filter(x => x.id !== rec.id).concat(rec);
    changed++;
  }
  return changed;
}
