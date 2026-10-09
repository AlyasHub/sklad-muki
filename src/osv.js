// 📒 Оборотно-сальдовая ведомость (ОСВ) → долги клиентов на начало и конец периода.
// Чистые функции без React — их легко проверить отдельно. Разбор фото/PDF делает сервер (op "parseOsv"),
// сохранение — обычные сверки из recon.js (долг на начало дня D).
//  • Долг = дебет − кредит: дебет — клиент должен нам, кредит — переплата/аванс (долг со знаком минус).
//  • «На начало периода» = сверка на день from; «на конец» = сверка на следующий день после to.
//  • Проверка цифр: сальдо на начало + обороты (дебет − кредит) должно равняться сальдо на конец.

const r2 = x => Math.round((Number(x) || 0) * 100) / 100;

// Число из ячейки ведомости: «1 234 567,89», «1.234.567,89», «1,234,567.89», «1234567.89», 1234567.89 → 1234567.89
export function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  let s = String(v ?? "").replace(/[\s ']/g, "");
  if (!s || s === "-" || s === "—") return 0;
  const lastDot = s.lastIndexOf("."), lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) s = lastDot > lastComma ? s.replace(/,/g, "") : s.replace(/\./g, "").replace(",", "."); // что стоит последним — то копейки
  else if (lastComma >= 0) s = (s.match(/,/g) || []).length > 1 ? s.replace(/,/g, "") : s.replace(",", ".");
  else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

export const dayAfter = D => { const d = new Date(D + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

// Название без «ИП/ТОО», кавычек и знаков — для запасного сопоставления, если ИИ не узнал клиента
export const normName = s => String(s || "").toLowerCase().replace(/ё/g, "е")
  .replace(/(^|[\s«"'(])(ип|тоо|ао|чп|llp|ltd)(?=[\s»"').,]|$)/g, " ")
  .replace(/[«»"'`.,()\-–—/\\№]/g, " ").replace(/\s+/g, " ").trim();

// Клиент по названию: точное совпадение без «ИП/ТОО» с юр. или коротким названием, только если он один такой
export function matchByName(name, clients) {
  const n = normName(name);
  if (!n) return "";
  const hits = (clients || []).filter(c => [c.org_name, c.name].some(x => x && normName(x) === n));
  return hits.length === 1 ? hits[0].id : "";
}

// Строки ведомости от сервера ([[название, id, нач_дт, нач_кт, об_дт, об_кт, кон_дт, кон_кт, счёт]]) → строки таблицы
export function osvLines(rows, clients) {
  const ids = new Set((clients || []).map(c => c.id));
  return (rows || []).filter(Array.isArray).map((r, i) => {
    const [name, id, sD, sC, tD, tC, eD, eC, acc] = r;
    const start = r2(num(sD) - num(sC)), end = r2(num(eD) - num(eC));
    const ok = Math.abs(r2(start + num(tD) - num(tC)) - end) < 1;
    const aiId = ids.has(String(id || "")) ? String(id) : "";
    return { i, name: String(name || "").trim(), acc: String(acc || "").trim(), clientId: aiId || matchByName(name, clients), start, end, turnD: r2(num(tD)), turnC: r2(num(tC)), ok };
  }).filter(l => l.name && !/^(итого|всего|оборот)/i.test(l.name)); // строку итога ИИ мог выписать по ошибке
}

// Сходится ли сумма строк с «Итого» ведомости (если итог есть). null — итога нет.
export function osvTotalCheck(lines, total) {
  if (!Array.isArray(total) || total.length < 6) return null;
  const [sD, sC, , , eD, eC] = total.map(num);
  const start = r2(lines.reduce((s, l) => s + l.start, 0)), end = r2(lines.reduce((s, l) => s + l.end, 0));
  const tStart = r2(sD - sC), tEnd = r2(eD - eC);
  return { ok: Math.abs(start - tStart) < 1 && Math.abs(end - tEnd) < 1, start, end, tStart, tEnd };
}

// 📊 Ведомость из Excel/CSV → текст для ИИ: строки через перенос, ячейки через табуляцию. Числа — как в ячейке
// (без форматирования), поэтому точнее фото. sheets = [{ name, rows: [[значение ячейки, ...], ...] }].
export function cellText(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return isNaN(v) ? "" : v.toISOString().slice(0, 10);
  if (typeof v === "object") { // ExcelJS: формула {result}, гиперссылка {text}, форматированный текст {richText}
    if (v.result !== undefined) return cellText(v.result);
    if (v.richText) return v.richText.map(t => t.text || "").join("");
    if (v.text !== undefined) return cellText(v.text);
    if (v.error) return "";
    return "";
  }
  return String(v).replace(/[\t\r\n]+/g, " ").trim();
}
export function sheetsToText(sheets, maxChars = 250000) {
  const parts = [];
  for (const sh of sheets || []) {
    const lines = [];
    for (const row of sh.rows || []) {
      const cells = (row || []).map(cellText);
      while (cells.length && !cells[cells.length - 1]) cells.pop(); // пустой хвост строки
      if (cells.some(Boolean)) lines.push(cells.join("\t"));
    }
    if (lines.length) parts.push(`Лист «${sh.name || ""}»:\n${lines.join("\n")}`);
  }
  const text = parts.join("\n\n");
  if (!text) throw new Error("В файле пустые листы — нет таблицы ведомости.");
  if (text.length > maxChars) throw new Error("Таблица в файле слишком большая — оставь в ней только ведомость по покупателям.");
  return text;
}

// Несколько строк одного клиента (разные договоры/счета) складываем. lines — уже с выбранным клиентом.
export function osvByClient(lines) {
  const m = new Map();
  for (const l of lines) {
    if (!l.clientId) continue;
    const g = m.get(l.clientId) || { clientId: l.clientId, start: 0, end: 0, names: [], ok: true };
    g.start = r2(g.start + l.start); g.end = r2(g.end + l.end); g.names.push(l.name); g.ok = g.ok && l.ok;
    m.set(l.clientId, g);
  }
  return m;
}
