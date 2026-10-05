// 📊 Excel-отчёт по клиентам — в точности по шаблону «Отчет Темирлан.xlsx»:
//  • лист на каждого клиента: дата, [адрес точки — если у клиента несколько адресов], товар, кол-во (кг),
//    цена, сумма, итого по отгрузке, дата оплаты, способ, сумма оплаты и остаток долга нарастающим итогом
//    (формулы как в шаблоне: остаток = предыдущий + сумма − оплата, тянется по всем строкам);
//  • лист «общее»: блоки по дням (или по месяцам) — №, организация, долг на начало, отгрузка (наименование, кг, цена,
//    сумма, «Итого»), оплата, долг на конец; внизу «ИТОГО». В блок попадают клиенты с движением за этот день/месяц.
//  • листы клиентов в отчёте — со всей истории клиента (как в шаблоне: начало = 0), «общее» — за выбранный период.
// Долг считаем так же, как раздел «Долги»: отгружено (без проб) − оплачено при доставке − внесённые оплаты
// (вкл. корректировки по акту сверки). Разовые продажи без карточки клиента в отчёт не входят.
// ExcelJS подгружаем с cdnjs при первой выгрузке (как pdfmake для накладных) — основной бандл не растёт,
// дальше он берётся из кэша service worker (работает и офлайн).

const FONT = "Times New Roman";
const BRAND_LAT = { "ДАЛА НАН": "Dala Nan", "ДАРАД": "Darad" };
const GRADE_SHORT = { "Высший сорт": "Высший сорт", "Первый сорт": "1 сорт" };
const METHOD_SHORT = { "Наличные": "нал", "Безнал": "без нал" };
// Цвета и форматы сняты с шаблона
const FILL = { title: "FFCCFFFF", band: "FFDCE6F2", period: "FFD7E4BD", total: "FFFDEADA", white: "FFFFFFFF" };
const NF = {
  date: "dd.mm.yyyy",           // в шаблоне — системная «короткая дата» (на русском Excel это 01.06.2026)
  money: "#,##0.00\\ _₽",       // кол-во, цена, сумма, итого на листе клиента
  payDate: "[$-419]d\\ mmm;@",  // дата оплаты: «1 июн»
  payAmt: "#,##0\\ [$₸-43F]",   // сумма оплаты со знаком тенге
  bal: '#,##0.00"   "',         // остаток долга
  int: "#,##0",
  price: "#,##0.00",
  month: "mm/yy",               // заголовок блока на листе «общее»
  text: "@",
};
const EXCEL_URL = "https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js";

const pad = n => String(n).padStart(2, "0");
const round2 = x => Math.round((Number(x) || 0) * 100) / 100;
const toDate = s => { const [y, m, d] = String(s).split("-").map(Number); return new Date(Date.UTC(y, (m || 1) - 1, d || 1)); };
export const dmy = s => String(s || "").split("-").reverse().join(".");
const colL = n => { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const kgOf = o => (Number(o.bags) || 0) * (Number(o.bag_kg) || 0);
const sumOf = o => kgOf(o) * (Number(o.price_per_kg) || 0);
const isSale = o => o.status === "отгружена" && !o.isSample && !o.trial && !o.foreign && kgOf(o) > 0;
// Товар как в шаблоне: «Высший сорт (50) Dala Nan», «1 сорт (25) Darad»
export const productName = o => `${GRADE_SHORT[o.grade] || o.grade || ""} (${Number(o.bag_kg) || ""}) ${BRAND_LAT[o.brand] || o.brand || ""}`.replace(/\s+/g, " ").trim();
const payLabel = (method, note) => [METHOD_SHORT[method] || method || "", note || ""].filter(Boolean).join(", ");
export const clientTitle = c => {
  const name = String(c.name || "Клиент").trim(), org = String(c.org_name || "").trim();
  return org && !name.toLowerCase().includes(org.toLowerCase()) ? `${name} (${org})` : name;
};
const pointName = (c, pointId) => {
  const p = pointId && (c.points || []).find(x => x.id === pointId);
  return p ? (p.label || p.address || "") : (c.address_label || c.address || "");
};

// Все движения клиента: отгрузки (одна доставка = дата + точка, позиции одинакового товара по одной цене — одной
// строкой) и оплаты (внесённые + «оплачено при доставке» по отметке в заявке).
export function clientMoves(client, orders, payments) {
  const groups = new Map();
  for (const o of orders || []) {
    if (o.clientId !== client.id || !isSale(o)) continue;
    const k = o.date + "|" + (o.pointId || "");
    if (!groups.has(k)) groups.set(k, { date: o.date, pointId: o.pointId || "", orders: [] });
    groups.get(k).orders.push(o);
  }
  const ships = [...groups.values()].map(g => {
    const lines = new Map();
    for (const o of g.orders) {
      const name = productName(o), price = Number(o.price_per_kg) || 0, k = name + "|" + price;
      if (!lines.has(k)) lines.set(k, { name, price, kg: 0 });
      lines.get(k).kg += kgOf(o);
    }
    const paid = g.orders.filter(o => o.paid);
    const paidSum = paid.reduce((s, o) => s + sumOf(o), 0);
    return {
      kind: "ship", date: g.date, pointId: g.pointId, lines: [...lines.values()],
      total: g.orders.reduce((s, o) => s + sumOf(o), 0),
      paidNow: paidSum ? { date: g.date, amount: paidSum, label: payLabel((paid.find(o => o.pay_method) || {}).pay_method) } : null,
    };
  });
  const pays = (payments || []).filter(p => p.clientId === client.id && Number(p.amount))
    .map(p => ({ date: p.date || "", amount: Number(p.amount) || 0, label: p.adjust ? "акт сверки" : payLabel(p.method, String(p.note || "").trim()) }));
  return { ships, pays };
}
// Долг на начало дня `from` (всё, что было раньше)
export const balanceBefore = (mv, from) => !from ? 0 :
  mv.ships.filter(s => s.date < from).reduce((a, s) => a + s.total - (s.paidNow ? s.paidNow.amount : 0), 0)
  - mv.pays.filter(p => p.date < from).reduce((a, p) => a + p.amount, 0);
const inRange = (d, from, to) => (!from || d >= from) && (!to || d <= to);
const hasMoves = (mv, from, to) => mv.ships.some(s => inRange(s.date, from, to)) || mv.pays.some(p => inRange(p.date, from, to));

// События листа клиента по порядку. Оплата того же дня ставится в строку отгрузки (как в шаблоне),
// остальные оплаты — отдельными строками по дате.
function sheetEvents(mv, from, to) {
  const ships = mv.ships.filter(s => inRange(s.date, from, to))
    .sort((a, b) => a.date.localeCompare(b.date) || a.pointId.localeCompare(b.pointId))
    .map(s => ({ ...s, pays: s.paidNow ? [s.paidNow] : [] }));
  const out = [...ships];
  for (const p of mv.pays.filter(p => inRange(p.date, from, to)).sort((a, b) => a.date.localeCompare(b.date))) {
    const host = ships.find(s => s.date === p.date && s.pays.length < Math.max(1, s.lines.length));
    if (host) host.pays.push(p); else out.push({ kind: "pay", date: p.date, pointId: "", lines: [], pays: [p] });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? 0 : a.kind === "ship" ? -1 : 1));
}

const solid = argb => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
const bd = (l, r, t, b) => ({ ...(l ? { left: { style: l } } : {}), ...(r ? { right: { style: r } } : {}), ...(t ? { top: { style: t } } : {}), ...(b ? { bottom: { style: b } } : {}) });
function cellSetter(ws) {
  return (r, c, value, st = {}) => {
    const cell = ws.getCell(r, c);
    if (value !== undefined) cell.value = value;
    cell.font = { name: FONT, size: 11, ...(st.font || {}) };
    if (st.numFmt) cell.numFmt = st.numFmt;
    if (st.alignment) cell.alignment = st.alignment;
    if (st.fill) cell.fill = solid(st.fill);
    if (st.border) cell.border = st.border;
    return cell;
  };
}

// ── Лист клиента ─────────────────────────────────────────────────────────────────────────────
// Как в шаблоне: в отчёте лист ведётся со всей истории клиента (с первой отгрузки, начало = 0) — каждое
// число в остатке объясняется строками выше. Для выписки за период (statement) — с долгом на начало,
// подписанным отдельной строкой «Долг на начало периода».
function addClientSheet(wb, client, mv, from, to, sheetName, statement = false) {
  const ws = wb.addWorksheet(sheetName);
  const set = cellSetter(ws);
  const hasAddr = (client.points || []).length > 0; // несколько адресов — колонка «адрес», как у «Самал»
  const C = hasAddr
    ? { date: 1, addr: 2, prod: 3, qty: 4, price: 5, sum: 6, total: 7, pdate: 8, pmeth: 9, pamt: 10, bal: 11 }
    : { date: 1, prod: 2, qty: 3, price: 4, sum: 5, total: 6, pdate: 7, pmeth: 8, pamt: 9, bal: 10 };
  (hasAddr ? [12.1, 14.7, 25, 10.9, 9.7, 15.8, 14.3, 12, 11, 14.4, 15.1] : [12.1, 25, 10.9, 9.7, 15.8, 14.3, 12, 11, 14.4, 15.1])
    .forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  const L = colL;
  const thinTB = bd(null, null, "thin", "thin");

  // Строка 1: название клиента (на всю ширину) и долг на начало — в последней колонке
  const opening = round2(balanceBefore(mv, from));
  for (let c = 1; c < C.bal; c++) set(1, c, null, { border: thinTB });
  set(1, 1, clientTitle(client), { font: { bold: true }, alignment: { horizontal: "center" }, fill: FILL.title, border: thinTB });
  ws.mergeCells(1, 1, 1, C.bal - 1);
  set(1, C.bal, opening, { numFmt: NF.bal, fill: FILL.title, border: thinTB });

  let bal = opening; // остаток — для готовых значений формул (видно сразу, даже без пересчёта)
  const balRow = (r, sumVal, payVal) => {
    bal = bal + sumVal - payVal;
    set(r, C.bal, { formula: `${L(C.bal)}${r - 1}+${L(C.sum)}${r}-${L(C.pamt)}${r}`, result: round2(bal) }, { numFmt: NF.bal });
  };
  if (statement && from && opening) { // выписка за период: подпись, откуда цифра в начале
    set(2, C.date, toDate(from), { numFmt: NF.date, alignment: { horizontal: "left" } });
    set(2, C.prod, "Долг на начало периода", { font: { italic: true } });
  }
  balRow(2, 0, 0);

  let r = 3;
  const events = sheetEvents(mv, from, to);
  events.forEach((ev, i) => {
    const n = ev.kind === "ship" ? Math.max(ev.lines.length, ev.pays.length, 1) : 1;
    const vAlign = n > 1 ? "middle" : undefined;
    for (let k = 0; k < n; k++) {
      const row = r + k;
      let sumVal = 0, payVal = 0;
      const ln = ev.kind === "ship" ? ev.lines[k] : null;
      if (ln) {
        sumVal = ln.kg * ln.price;
        set(row, C.prod, ln.name, { numFmt: NF.text });
        set(row, C.qty, round2(ln.kg), { numFmt: NF.money, alignment: { horizontal: "right" } });
        set(row, C.price, round2(ln.price), { numFmt: NF.money, alignment: { horizontal: "right" } });
        set(row, C.sum, { formula: `${L(C.price)}${row}*${L(C.qty)}${row}`, result: round2(sumVal) }, { numFmt: NF.money, alignment: { horizontal: "right" } });
      }
      const p = ev.pays[k];
      if (p) {
        payVal = p.amount;
        set(row, C.pdate, p.date ? toDate(p.date) : null, { numFmt: NF.payDate });
        set(row, C.pmeth, p.label || "");
        set(row, C.pamt, round2(p.amount), { numFmt: NF.payAmt, alignment: { horizontal: "right" } });
      }
      balRow(row, sumVal, payVal);
    }
    if (ev.kind === "ship") {
      // Дата, адрес и «итого по отгрузке» — одной ячейкой на всю отгрузку (как в шаблоне у «Самал»)
      const lastLine = r + Math.max(ev.lines.length, 1) - 1;
      set(r, C.date, toDate(ev.date), { numFmt: NF.date, alignment: { horizontal: "left", vertical: vAlign } });
      if (hasAddr) set(r, C.addr, pointName(client, ev.pointId), { alignment: { horizontal: "left", vertical: vAlign, wrapText: true } });
      set(r, C.total, { formula: `SUM(${L(C.sum)}${r}:${L(C.sum)}${lastLine})`, result: round2(ev.total) }, { numFmt: NF.money, alignment: { horizontal: "right", vertical: vAlign } });
      if (n > 1) {
        ws.mergeCells(r, C.date, r + n - 1, C.date);
        if (hasAddr) ws.mergeCells(r, C.addr, r + n - 1, C.addr);
        ws.mergeCells(r, C.total, r + n - 1, C.total);
      }
    }
    r += n;
    // Разделитель: сменился месяц — голубая полоса (как в шаблоне между августом и сентябрём), иначе пустая строка
    const next = events[i + 1];
    const band = !!next && next.date.slice(0, 7) !== ev.date.slice(0, 7);
    if (!next) return; // после последней записи — ничего: без «хвоста» из повторяющегося остатка
    if (band) for (let c = 1; c <= C.bal; c++) set(r, c, null, { fill: FILL.band, border: thinTB });
    balRow(r, 0, 0);
    r++;
  });
  return ws;
}

// ── Лист «общее» ─────────────────────────────────────────────────────────────────────────────
function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.slice(0, 7).split("-").map(Number);
  const [ty, tm] = to.slice(0, 7).split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    out.push({ first: `${y}-${pad(m)}-01`, last: `${y}-${pad(m)}-${pad(last)}` });
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

// Блоки листа «общее»: по дням (каждый день с отгрузками или оплатами) или по месяцам
function generalPeriods(items, from, to, by) {
  if (by === "month") return monthsBetween(from, to).map(m => ({ first: from > m.first ? from : m.first, last: to < m.last ? to : m.last, title: m.first, fmt: NF.month }));
  const days = new Set();
  for (const { mv } of items) {
    for (const s of mv.ships) if (inRange(s.date, from, to)) days.add(s.date);
    for (const p of mv.pays) if (p.date && inRange(p.date, from, to)) days.add(p.date);
  }
  return [...days].sort().map(d => ({ first: d, last: d, title: d, fmt: NF.date }));
}

function addGeneralSheet(wb, items, from, to, by = "day") {
  const ws = wb.addWorksheet("общее");
  const set = cellSetter(ws);
  [13, 31.9, 17.4, 25.9, 18, 11.1, 16, 18.1, 17.1].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  const BI = { bold: true, italic: true };
  let r = 2;
  for (const mo of generalPeriods(items, from, to, by)) {
    const mFrom = mo.first, mTo = mo.last;
    const rows = items.map(({ client, mv }) => {
      const ships = mv.ships.filter(s => inRange(s.date, mFrom, mTo));
      const pays = mv.pays.filter(p => inRange(p.date, mFrom, mTo));
      if (!ships.length && !pays.length) return null; // в блок — только клиенты с движением
      const lines = new Map(); // за месяц: один товар по одной цене — одной строкой
      for (const s of ships) for (const ln of s.lines) {
        const k = ln.name + "|" + ln.price;
        if (!lines.has(k)) lines.set(k, { name: ln.name, price: ln.price, kg: 0 });
        lines.get(k).kg += ln.kg;
      }
      const pay = ships.reduce((a, s) => a + (s.paidNow ? s.paidNow.amount : 0), 0) + pays.reduce((a, p) => a + p.amount, 0);
      const first = [...ships.map(s => s.date), ...pays.map(p => p.date)].sort()[0];
      return { client, opening: round2(balanceBefore(mv, mFrom)), lines: [...lines.values()], pay: round2(pay), first };
    }).filter(Boolean).sort((a, b) => a.first.localeCompare(b.first) || clientTitle(a.client).localeCompare(clientTitle(b.client), "ru"));
    if (!rows.length) continue; // месяц без движения — блок не рисуем

    // Заголовок блока: месяц (зелёная полоса)
    for (let c = 2; c <= 9; c++) set(r, c, null, { border: bd(c === 2 ? "thin" : null, c === 9 ? "thick" : null, "thick", null) });
    set(r, 2, toDate(mo.title), { font: { bold: true }, numFmt: mo.fmt, alignment: { horizontal: "center" }, fill: FILL.period, border: bd("thin", "thick", "thick", null) });
    ws.mergeCells(r, 2, r, 9);
    // Шапка таблицы (2 строки)
    const h1 = r + 1, h2 = r + 2;
    const head = (row, c, text, st = {}) => set(row, c, text, { font: BI, alignment: { horizontal: "center", vertical: "middle", wrapText: true, ...(st.alignment || {}) }, numFmt: st.numFmt, fill: st.fill, border: st.border });
    for (let c = 1; c <= 9; c++) for (const row of [h1, h2]) set(row, c, null, { font: BI, border: bd(c === 1 ? "thick" : "thin", c === 9 ? "thick" : "thin", row === h1 ? "thick" : "thin", row === h2 ? "thick" : "thin") });
    head(h1, 1, "№", { border: bd("thick", "thin", "thick", "thick") });
    head(h1, 2, "Организация", { alignment: { horizontal: "left" }, fill: FILL.white, border: bd("thin", "thin", "thick", "thick") });
    head(h1, 3, "Долг на начало периода", { border: bd("thin", "thin", "thick", "thick") });
    head(h1, 4, "Отгрузка", { border: bd("thin", "thin", "thick", "thin") });
    head(h1, 8, "Оплата", { border: bd("thin", "thin", "thick", "thick") });
    head(h1, 9, "Долг на конец периода", { border: bd("thin", "thick", "thick", "thick") });
    head(h2, 4, "Наименование", { border: bd("thin", "thin", "thin", "thick") });
    head(h2, 5, "Количество,кг", { fill: FILL.white, border: bd("thin", "thin", "thin", "thick") });
    head(h2, 6, "Цена ", { border: bd("thin", "thin", "thin", "thick") });
    head(h2, 7, "Сумма", { border: bd("thin", "thin", "thin", "thick") });
    for (const c of [1, 2, 3, 8, 9]) ws.mergeCells(h1, c, h2, c);
    ws.mergeCells(h1, 4, h1, 7);

    // Клиенты
    let s = h2 + 1;
    const firstRow = s, itogoRows = [];
    let sumC = 0, sumE = 0, sumG = 0, sumH = 0, sumI = 0;
    rows.forEach((it, idx) => {
      const nLines = Math.max(1, it.lines.length);
      const itogo = s + nLines;
      let kg = 0, money = 0;
      for (let k = 0; k < nLines; k++) {
        const row = s + k, ln = it.lines[k];
        const t = k === 0 ? "thin" : "thin";
        set(row, 4, ln ? ln.name : null, { font: { italic: true }, numFmt: NF.text, alignment: { wrapText: true }, border: bd("thin", "thin", t, "thin") });
        set(row, 5, ln ? round2(ln.kg) : null, { font: { italic: true }, numFmt: NF.int, alignment: { horizontal: "center", wrapText: true }, fill: FILL.white, border: bd("thin", "thin", t, "thin") });
        set(row, 6, ln ? round2(ln.price) : null, { font: { italic: true }, numFmt: NF.price, alignment: { horizontal: "center", wrapText: true }, fill: FILL.white, border: bd("thin", "thin", t, "thin") });
        const v = ln ? ln.kg * ln.price : 0;
        set(row, 7, ln ? { formula: `F${row}*E${row}`, result: round2(v) } : null, { font: { italic: true }, numFmt: NF.int, alignment: { horizontal: "right", wrapText: true }, fill: FILL.white, border: bd("thin", "thin", t, "thin") });
        if (ln) { kg += ln.kg; money += v; }
      }
      // «Итого» по клиенту
      set(itogo, 4, "Итого", { font: BI, alignment: { wrapText: true }, fill: FILL.white, border: bd("thin", "thin", "thin", "thick") });
      set(itogo, 5, { formula: `SUM(E${s}:E${itogo - 1})`, result: round2(kg) }, { font: BI, numFmt: NF.int, alignment: { horizontal: "center", wrapText: true }, fill: FILL.white, border: bd("thin", "thin", "thin", "thick") });
      set(itogo, 6, null, { font: { italic: true }, numFmt: NF.price, fill: FILL.white, border: bd("thin", "thin", "thin", "thick") });
      set(itogo, 7, { formula: `SUM(G${s}:G${itogo - 1})`, result: round2(money) }, { font: BI, numFmt: NF.int, alignment: { horizontal: "right", wrapText: true }, fill: FILL.white, border: bd("thin", "thin", "thin", "thick") });
      // №, организация, долг на начало, оплата, долг на конец — одной ячейкой на весь клиентский блок
      const closing = it.opening + money - it.pay;
      for (let row = s; row <= itogo; row++) {
        const last = row === itogo;
        set(row, 1, row === s ? idx + 1 : null, { font: BI, numFmt: NF.int, alignment: { horizontal: "center", vertical: "middle", wrapText: true }, fill: FILL.white, border: bd("thick", "thin", row === s ? "thick" : null, last ? "thick" : null) });
        set(row, 2, row === s ? clientTitle(it.client) : null, { font: BI, alignment: { horizontal: "left", vertical: "middle", wrapText: true }, fill: FILL.white, border: bd("thin", "thin", row === s ? "thick" : null, last ? "thick" : null) });
        set(row, 3, row === s ? it.opening : null, { font: BI, numFmt: NF.int, alignment: { horizontal: "center", vertical: "middle", wrapText: true }, fill: FILL.white, border: bd("thin", "thin", row === s ? "thick" : null, last ? "thick" : null) });
        set(row, 8, row === s ? (it.pay || null) : null, { numFmt: NF.int, alignment: { horizontal: "center", vertical: "middle", wrapText: true }, border: bd("thin", "thin", row === s ? "thick" : null, last ? "thick" : null) });
        set(row, 9, row === s ? { formula: `C${s}+G${itogo}-H${s}`, result: round2(closing) } : null, { font: BI, numFmt: NF.int, alignment: { horizontal: "center", vertical: "middle", wrapText: true }, border: bd("thin", "thick", row === s ? "thick" : null, last ? "thick" : null) });
      }
      for (const c of [1, 2, 3, 8, 9]) ws.mergeCells(s, c, itogo, c);
      itogoRows.push(itogo);
      sumC += it.opening; sumE += kg; sumG += money; sumH += it.pay; sumI += closing;
      s = itogo + 1;
    });

    // ИТОГО по блоку
    const t = s, lastRow = s - 1;
    const tot = (c, value, numFmt = NF.int, h = "center") => set(t, c, value, { font: BI, numFmt, alignment: { horizontal: h }, fill: FILL.total, border: bd(c === 1 ? "thick" : "thin", c === 9 ? "thick" : "thin", null, "thick") });
    tot(1, "ИТОГО", undefined); tot(2, null);
    ws.mergeCells(t, 1, t, 2);
    tot(3, { formula: `SUM(C${firstRow}:C${lastRow})`, result: round2(sumC) });
    tot(4, null);
    tot(5, { formula: itogoRows.map(x => `E${x}`).join("+"), result: round2(sumE) });
    tot(6, null);
    tot(7, { formula: itogoRows.map(x => `G${x}`).join("+"), result: round2(sumG) }, NF.int, "right");
    tot(8, { formula: `SUM(H${firstRow}:H${lastRow})`, result: round2(sumH) });
    tot(9, { formula: `SUM(I${firstRow}:I${lastRow})`, result: round2(sumI) });
    r = t + 2; // пустая строка — и следующий месяц
  }
  return ws;
}

function uniqueSheetName(name, used) {
  let base = String(name || "Клиент").replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().replace(/^'+|'+$/g, "").slice(0, 31).trim() || "Клиент";
  let n = base, i = 2;
  while (used.has(n.toLowerCase())) { const suf = " " + i++; n = base.slice(0, 31 - suf.length).trim() + suf; }
  used.add(n.toLowerCase());
  return n;
}

// Книга: лист на каждого клиента + (по желанию) лист «общее». keepEmpty — оставить клиента и без движения
// (для выписки одного клиента: покажет хотя бы долг на начало). Возвращает null, если показывать нечего.
// generalBy: "day" — блоки «общее» по дням (по умолчанию), "month" — по месяцам.
// statement: выписка одного клиента за период (лист с долгом на начало); иначе листы клиентов — со всей истории.
export function buildClientsWorkbook(ExcelJS, { clients, orders, payments, from = "", to = "", includeGeneral = true, keepEmpty = false, generalBy = "day", statement = false }) {
  const all = (clients || []).filter(c => c && c.id).map(client => ({ client, mv: clientMoves(client, orders, payments) }));
  const items = keepEmpty ? all : all.filter(it => hasMoves(it.mv, from, to));
  if (!items.length) return null;
  // Границы периода для блоков «общее»: если не заданы — от первого до последнего движения
  const dates = items.flatMap(it => [...it.mv.ships.map(s => s.date), ...it.mv.pays.map(p => p.date)]).filter(d => inRange(d, from, to)).sort();
  const F = from || dates[0] || "", T = to || dates[dates.length - 1] || "";
  const wb = new ExcelJS.Workbook();
  wb.creator = "Darad";
  wb.created = new Date();
  wb.calcProperties.fullCalcOnLoad = true; // Excel пересчитает формулы при открытии
  const used = new Set(["общее"]);
  items.sort((a, b) => clientTitle(a.client).localeCompare(clientTitle(b.client), "ru"));
  for (const it of items) addClientSheet(wb, it.client, it.mv, statement ? from : "", to, uniqueSheetName(it.client.name, used), statement);
  if (includeGeneral && F && T) {
    addGeneralSheet(wb, items, F, T, generalBy);
    wb.views = [{ x: 0, y: 0, width: 20000, height: 12000, firstSheet: 0, activeTab: wb.worksheets.length - 1, visibility: "visible" }];
  }
  return wb;
}

// Загрузка ExcelJS (один раз) — как pdfmake для накладных
let excelPromise = null;
export function loadExcelJS() {
  if (typeof window !== "undefined" && window.ExcelJS) return Promise.resolve(window.ExcelJS);
  if (!excelPromise) excelPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = EXCEL_URL;
    s.onload = () => (window.ExcelJS ? resolve(window.ExcelJS) : reject(new Error("Модуль Excel не загрузился")));
    s.onerror = () => { excelPromise = null; reject(new Error("Нет интернета — не удалось загрузить модуль Excel. Попробуй ещё раз.")); };
    document.head.appendChild(s);
  });
  return excelPromise;
}

const safeFile = s => String(s).replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
// Сформировать и скачать. Возвращает false, если за период нечего показать.
export async function downloadClientsReport(opts, fileName) {
  const ExcelJS = await loadExcelJS();
  const wb = buildClientsWorkbook(ExcelJS, opts);
  if (!wb) return false;
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = safeFile(fileName) + ".xlsx";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return true;
}
