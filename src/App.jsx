import { useState, useEffect, useCallback, useRef, Fragment } from "react";

// Всё общение с базой идёт через защищённый сервер /api/data с токеном входа.
// Прямого ключа к базе в браузере больше нет.
let authToken = (typeof localStorage !== "undefined" && localStorage.getItem("sklad_token")) || null;
function setAuthToken(t) {
  authToken = t || null;
  if (t) localStorage.setItem("sklad_token", t); else localStorage.removeItem("sklad_token");
}
function decodeToken(t) {
  try {
    let b = t.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
    while (b.length % 4) b += "=";
    return JSON.parse(decodeURIComponent(escape(atob(b))));
  } catch { return null; }
}

async function apiData(op, table, extra = {}) {
  const res = await fetch("/api/data", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: authToken, op, table, ...extra }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) setAuthToken(null);
    throw new Error(data.error || "Ошибка сервера");
  }
  // Автопродление входа: сервер прислал свежий токен (старый скоро истечёт) — тихо обновляем
  if (data.fresh_token) setAuthToken(data.fresh_token);
  return data;
}
async function dbGetAll(table) { return (await apiData("list", table)).rows || []; }
async function dbUpsert(table, item) { await apiData("upsert", table, { item }); }
async function dbDelete(table, id) { await apiData("delete", table, { id }); }
// 🤖 ИИ-помощник: свободный текст → распознанное действие/ответ (операция на защищённом /api/data)
async function askAssistant(message) {
  return await apiData("assistant", null, { message }); // { result?, error? }
}

// Дата в местном времени (не UTC) — иначе в Астане вечером дата уезжала на день вперёд
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const TODAY = () => ymd(new Date());
const TOMORROW = () => ymd(new Date(Date.now() + 86400000));
const TODAY_WEEKDAY = () => WEEKDAYS[new Date().getDay()];
const fmt = n => Number(n).toLocaleString("ru-RU");
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// Время доставки клиента: точный интервал (с–по) если задан, иначе пресет
const clientTime = c => (c && ((c.delivery_from && c.delivery_to) ? `${c.delivery_from}–${c.delivery_to}` : c.delivery_time)) || "";

// Текст для накладной (бухгалтеру) по заявке клиента
// Суммируем одинаковые позиции (один бренд+сорт+фасовка) в одну строку: общий вес и сумма
function mergedPositions(orders) {
  const m = {};
  orders.forEach(o => {
    const k = `${o.brand}|${o.grade}|${o.bag_kg}`;
    if (!m[k]) m[k] = { brand: o.brand, grade: o.grade, bag_kg: o.bag_kg, bags: 0, tg: 0, trial: false };
    m[k].bags += Number(o.bags) || 0;
    m[k].tg += (Number(o.bags) || 0) * o.bag_kg * (o.price_per_kg || 0);
    if (o.trial) m[k].trial = true;
  });
  return Object.values(m);
}
function nakladnayaText(g, client) {
  const head = (client && client.org_name) || g.clientName || "Клиент";
  const billable = g.orders.filter(o => !o.trial && !o.isSample); // бесплатные пробы в накладную не идут
  if (!billable.length) return null;
  // объединяем одинаковые сорта с одной ценой
  const m = {};
  billable.forEach(o => { const k = `${o.brand}|${o.grade}|${o.bag_kg}|${o.price_per_kg || 0}`; if (!m[k]) m[k] = { brand: o.brand, grade: o.grade, bag_kg: o.bag_kg, price_per_kg: o.price_per_kg, bags: 0 }; m[k].bags += Number(o.bags) || 0; });
  const lines = Object.values(m).map(o => `${fmt(o.bags * o.bag_kg)} кг ${o.grade} ${o.brand}${o.price_per_kg ? ` — ${fmt(o.price_per_kg)} тг/кг` : ""}`);
  return head + ":\n" + lines.join("\n");
}
function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => alert("✓ Скопировано — вставь бухгалтеру (WhatsApp)")).catch(() => window.prompt("Скопируй вручную:", text));
  } else { window.prompt("Скопируй вручную:", text); }
}

// Скачивание файла из браузера (отчёт .txt / таблица .csv для Excel)
function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Генерация настоящего Word-файла (.docx) без внешних библиотек.
// .docx — это ZIP из нескольких XML. Собираем ZIP вручную (метод «store», без сжатия) + CRC32.
function crc32(bytes) {
  let crc = ~0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
function zipStore(files) {
  const enc = new TextEncoder();
  const chunks = []; let offset = 0;
  const u16 = n => new Uint8Array([n & 255, (n >>> 8) & 255]);
  const u32 = n => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
  const push = a => { chunks.push(a); offset += a.length; };
  const central = [];
  for (const f of files) {
    const nameB = enc.encode(f.name), data = f.data, crc = crc32(data), size = data.length, local = offset;
    push(u32(0x04034b50)); push(u16(20)); push(u16(0)); push(u16(0)); push(u16(0)); push(u16(0));
    push(u32(crc)); push(u32(size)); push(u32(size)); push(u16(nameB.length)); push(u16(0)); push(nameB); push(data);
    const cd = [u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(size), u32(size),
      u16(nameB.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(local), nameB];
    central.push(cd);
  }
  const cdStart = offset; let cdSize = 0;
  for (const cd of central) for (const p of cd) { push(p); cdSize += p.length; }
  const n = files.length;
  push(u32(0x06054b50)); push(u16(0)); push(u16(0)); push(u16(n)); push(u16(n)); push(u32(cdSize)); push(u32(cdStart)); push(u16(0));
  const total = chunks.reduce((s, a) => s + a.length, 0), out = new Uint8Array(total);
  let p = 0; for (const a of chunks) { out.set(a, p); p += a.length; }
  return out;
}
function downloadDocx(name, text) {
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Оформление точно как в эталонных договорах: Times New Roman 11, одинарный интервал,
  // без отступов после абзаца, выравнивание по ширине, заголовок по центру жирным,
  // реквизиты сторон — двумя колонками (таблица без границ), как в эталоне
  const rpr = `<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="22"/><w:szCs w:val="22"/>`;
  const mkPara = (line, opts = {}) => {
    const b = opts.bold ? "<w:b/>" : "";
    const jc = opts.jc || "both";
    const pPr = `<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="${jc}"/><w:rPr>${b}${rpr}</w:rPr></w:pPr>`;
    const run = line === "" ? "" : `<w:r><w:rPr>${b}${rpr}</w:rPr><w:t xml:space="preserve">${esc(line)}</w:t></w:r>`;
    return `<w:p>${pPr}${run}</w:p>`;
  };
  const lines = String(text).split("\n");
  const firstNonEmpty = lines.findIndex(l => l.trim() !== ""); // заголовок договора — по центру, жирным
  // Строка «г. Город … дата»: город прижат к левому краю, дата — к правому (таб по правому краю страницы)
  const cityDatePara = line => {
    const m = line.match(/^(г\..*?)\s{2,}(\S.*)$/);
    if (!m) return null;
    return `<w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="10092"/></w:tabs><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="left"/><w:rPr>${rpr}</w:rPr></w:pPr><w:r><w:rPr>${rpr}</w:rPr><w:t xml:space="preserve">${esc(m[1])}</w:t></w:r><w:r><w:rPr>${rpr}</w:rPr><w:tab/><w:t xml:space="preserve">${esc(m[2])}</w:t></w:r></w:p>`;
  };
  const paraFor = (line, idx) => cityDatePara(line) || mkPara(line, { bold: idx === firstNonEmpty, jc: idx === firstNonEmpty ? "center" : "both" });
  const trimEnd = arr => { const a = [...arr]; while (a.length && a[a.length - 1].trim() === "") a.pop(); return a; };
  const supIdx = lines.findIndex(l => l.trim().startsWith("«ПОСТАВЩИК»"));
  const buyIdx = lines.findIndex(l => l.trim().startsWith("«ПОКУПАТЕЛЬ»"));
  let paras;
  if (supIdx > 0 && buyIdx > supIdx) {
    const cell = ls => `<w:tc><w:tcPr><w:tcW w:w="5500" w:type="dxa"/></w:tcPr>${(trimEnd(ls).map(l => mkPara(l, { jc: "left" })).join("")) || mkPara("")}</w:tc>`;
    paras = lines.slice(0, supIdx).map(paraFor).join("")
      + `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="5958"/><w:gridCol w:w="5146"/></w:tblGrid><w:tr>${cell(lines.slice(supIdx, buyIdx))}${cell(lines.slice(buyIdx))}</w:tr></w:tbl>`
      + mkPara(""); // после таблицы в конце документа Word требует абзац
  } else {
    paras = lines.map(paraFor).join("");
  }
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="454" w:right="680" w:bottom="567" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const enc = new TextEncoder();
  const zip = zipStore([
    { name: "[Content_Types].xml", data: enc.encode(contentTypes) },
    { name: "_rels/.rels", data: enc.encode(rels) },
    { name: "word/document.xml", data: enc.encode(documentXml) },
  ]);
  const blob = new Blob([zip], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Шифрование пароля (SHA-256) — пароли не хранятся в открытом виде
async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}
const ROLES = { director: "Администратор", viewer: "Директор", accountant: "Бухгалтер", brigadir: "Бригадир", driver: "Водитель", rep: "Торговый представитель", kgdsenior: "Старший менеджер КГД", kgdmanager: "Младший менеджер КГД" };
// Какие вкладки видит каждая роль
const TABS_BY_ROLE = {
  director: ["today", "calendar", "stock", "lab", "revision", "clients", "crm", "reactivate", "reports", "debts", "contracts", "invoice", "supply", "karaganda", "kgdm", "drivers", "expenses", "cashbox", "access"],
  viewer: ["today", "calendar", "stock", "lab", "clients", "reactivate", "reports", "debts", "karaganda", "supply", "drivers", "expenses", "cashbox"], // директор — только просмотр
  accountant: ["today", "calendar", "reports"],
  brigadir: ["calendar", "mysalary"], // бригадир: заявки бригады + своя зарплата (объём и сумма)
  driver: ["calendar", "mysalary"],
  rep: ["today", "calendar", "clients", "debts", "reports", "invoice", "stock"], // торгпред: свои клиенты/заявки/долги + СВОЯ аналитика + накладная + расписание и остатки
  kgdmanager: ["kgdm"], // младший менеджер Караганды: только свой раздел
  kgdsenior: ["kgdm"], // старший менеджер Караганды: тот же раздел + история всех
};
// Что показываем в нижней панели (остальное — под «Ещё»)
const PRIMARY_NAV = {
  director: ["today", "calendar", "stock", "clients", "reports"],
  viewer: ["today", "calendar", "stock", "clients", "reports"],
  accountant: ["today", "calendar", "reports"],
  brigadir: ["calendar", "mysalary"],
  driver: ["calendar", "mysalary"],
  rep: ["today", "calendar", "clients", "debts", "stock"],
  kgdmanager: ["kgdm"],
  kgdsenior: ["kgdm"],
};
const NAV_ICON = { today: "home", calendar: "calendar", stock: "box", lab: "flask", revision: "calculator", clients: "building", crm: "target", reactivate: "bell", reports: "chart", debts: "wallet", contracts: "file", invoice: "receipt", orders: "clipboard", supply: "truck", karaganda: "store", kgdm: "folder", drivers: "cash", mysalary: "wallet", expenses: "expense", cashbox: "coin", access: "settings" };
const NAV_SHORT = { today: "Сегодня", calendar: "Календарь", stock: "Склад", lab: "Лаборатория", revision: "Ревизия", clients: "Клиенты", crm: "CRM", reactivate: "Напомнить", reports: "Отчёты", debts: "Долги", contracts: "Договоры", invoice: "Накладная", orders: "Заявки", supply: "Поставки", karaganda: "Караганда", kgdm: "Менеджеры КГД", drivers: "Зарплата", mysalary: "Моя ЗП", expenses: "Расходы", cashbox: "Касса", access: "Доступ" };
const BRANDS = ["ДАРАД", "ДАЛА НАН"];
const GRADES = ["Высший сорт", "Первый сорт", "Отруби"];
const WEIGHTS = [5, 10, 25, 35, 50];
const DELIVERY_TIMES = ["В течение дня", "Утром (8–12)", "Днём (12–17)", "Вечером (17–21)"];
const WRITEOFF_REASONS = ["Брак", "Порча", "Пересортица", "Возврат", "Ревизия", "Прочее"];
const EXPENSE_CATS = ["Фура/Поставка", "Водители", "Грузчики", "Склад", "Аренда", "Зарплата", "Прочее"];
// Способы оплаты клиента (для отметки «оплачено»)
const PAY_METHODS = [["Kaspi перевод", "🔴"], ["Kaspi QR", "📲"], ["Наличные", "💵"], ["Безнал", "🏦"]];
// Статусы потенциального клиента в личной CRM (значение → подпись + стиль карточки)
const CRM_STATUSES = [
  { v: "new", label: "🆕 Новый", cls: "bg-gray-100 text-gray-700" },
  { v: "work", label: "🔄 В работе", cls: "bg-blue-100 text-blue-700" },
  { v: "call", label: "📞 Позвонить", cls: "bg-amber-100 text-amber-800" },
  { v: "meet", label: "🤝 Встреча", cls: "bg-indigo-100 text-indigo-700" },
  { v: "think", label: "🤔 Думает", cls: "bg-violet-100 text-violet-700" },
  { v: "deal", label: "✅ Договорились", cls: "bg-emerald-100 text-emerald-700" },
  { v: "reject", label: "❌ Отказ", cls: "bg-red-100 text-red-600" },
];
const crmStatus = v => CRM_STATUSES.find(s => s.v === v) || CRM_STATUSES[0];
// Старые записи сохранены как «Поддоны/Склад» — показываем и считаем их как «Склад»
const catName = c => (c === "Поддоны/Склад" ? "Склад" : c);

// Адрес склада (точка старта маршрутов). Мутируемый объект — обновляется из настроек при загрузке.
const WAREHOUSE = { lat: 51.17833, lon: 71.460803, address: "" };
function applyWarehouse(notes) {
  const w = (notes || []).find(n => n.id === "warehouse");
  if (w && w.coords && typeof w.coords.lat === "number") { WAREHOUSE.lat = w.coords.lat; WAREHOUSE.lon = w.coords.lon; WAREHOUSE.address = w.address || ""; WAREHOUSE.gis_link = w.gis_link || ""; }
}

function parseCoordsFromGisLink(link) {
  if (!link) return null;
  // Формат: /geo/ID/lon,lat
  const m1 = link.match(/\/geo\/[^/]+\/([\d.]+),([\d.]+)/);
  if (m1) return { lon: parseFloat(m1[1]), lat: parseFloat(m1[2]) };
  // Формат: ?m=lon,lat или ?m=lon%2Clat
  const m2 = link.match(/[?&]m=([\d.]+)(?:%2C|,)([\d.]+)/);
  if (m2) return { lon: parseFloat(m2[1]), lat: parseFloat(m2[2]) };
  return null;
}

function parseCoordsFromText(text) {
  if (!text) return null;
  const m = text.match(/([\d.]+)[,\s]+([\d.]+)/);
  if (!m) return null;
  const a = parseFloat(m[1]), b = parseFloat(m[2]);
  // lat обычно 40–60, lon обычно 60–90 для Казахстана
  if (a > 40 && a < 60) return { lat: a, lon: b };
  if (b > 40 && b < 60) return { lat: b, lon: a };
  return null;
}

// Сжатие фото на стороне браузера: уменьшаем до 1280px и JPEG ~0.6 — обычно 100–200 КБ
async function compressImage(file, maxDim = 1280, quality = 0.6) {
  try {
    const img = await createImageBitmap(file);
    let { width, height } = img;
    if (width > maxDim || height > maxDim) {
      const r = Math.min(maxDim / width, maxDim / height);
      width = Math.round(width * r); height = Math.round(height * r);
    }
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    canvas.getContext("2d").drawImage(img, 0, 0, width, height);
    const blob = await new Promise(res => canvas.toBlob(res, "image/jpeg", quality));
    return blob || file;
  } catch { return file; }
}
// Загрузка фото через защищённый сервер /api/upload, возвращает публичную ссылку
async function uploadPhoto(orderId, file) {
  const blob = await compressImage(file);
  const dataUrl = await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
  const r = await fetch("/api/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: authToken, orderId, dataUrl }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "Ошибка загрузки");
  return data.url;
}

async function resolveGisCoords(link) {
  const res = await fetch(`/api/resolve-gis?url=${encodeURIComponent(link)}`, { headers: { Authorization: `Bearer ${authToken}` } });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || "Не удалось определить координаты");
  }
  return res.json();
}

function distKm(a, b) {
  const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLon = (b.lon - a.lon) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function optimizeRoute(points) {
  const remaining = [...points];
  const route = [];
  let current = WAREHOUSE;
  while (remaining.length > 0) {
    let nearest = 0, minDist = Infinity;
    remaining.forEach((p, i) => { const d = distKm(current, p); if (d < minDist) { minDist = d; nearest = i; } });
    route.push(remaining[nearest]);
    current = remaining[nearest];
    remaining.splice(nearest, 1);
  }
  return route;
}

function buildGisRouteUrl(points) {
  // Формат маршрута 2ГИС: /directions/points/|lon,lat;|lon,lat;... (спецсимволы кодируются)
  const all = [WAREHOUSE, ...points];
  const seg = all.map(p => `|${p.lon},${p.lat}`).join(";");
  return `https://2gis.kz/astana/directions/points/${encodeURIComponent(seg)}`;
}
// Маршрут до одной точки БЕЗ склада: старт пустой — 2ГИС берёт текущее местоположение водителя
function buildGisToPointUrl(p) {
  const seg = `|;|${p.lon},${p.lat}`;
  return `https://2gis.kz/astana/directions/points/${encodeURIComponent(seg)}`;
}

async function parseOrderWithAI(text, clients) {
  // Разбор идёт через нашу серверную функцию /api/parse-order — ключ Anthropic живёт там, не в браузере
  const res = await fetch("/api/parse-order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: authToken,
      text,
      today: TODAY(),
      tomorrow: TOMORROW(),
      weekday: TODAY_WEEKDAY(),
      clients: clients.map(c => ({ name: c.name, org_name: c.org_name, address: c.address, contact_name: c.contact_name, default_bag_kg: c.default_bag_kg, default_brand: c.default_brand, products: (c.prices || []).map(p => ({ brand: p.brand, grade: p.grade, bag_kg: p.bag_kg })) })),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Не удалось разобрать заявку");
  return JSON.parse(data.raw);
}

async function parseClientWithAI(text) {
  const res = await fetch("/api/parse-client", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: authToken, text }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Не удалось разобрать данные клиента");
  return JSON.parse(data.raw);
}

async function parseTruckWithAI(text) {
  // Разбор поставки (фуры) из WhatsApp — через серверную функцию /api/parse-truck
  const res = await fetch("/api/parse-truck", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: authToken, text, today: TODAY(), tomorrow: TOMORROW(), weekday: TODAY_WEEKDAY() }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Не удалось разобрать поставку");
  return JSON.parse(data.raw);
}

async function parseAnalysisWithAI(text) {
  // Разбор лабораторного анализа муки — операция parseAnalysis в защищённом /api/data
  // (отдельной функцией не делаем: на Vercel Hobby лимит 12 serverless-функций).
  const data = await apiData("parseAnalysis", null, { text, today: TODAY() });
  return JSON.parse(data.raw);
}

// Чистим ответ ИИ от markdown (звёздочки, заголовки, таблицы, линии) — чтобы показывался простым текстом
function cleanAdvice(t) {
  return (t || "")
    .replace(/\*\*/g, "").replace(/`/g, "")
    .replace(/^#{1,6}\s*/gm, "")
    .split("\n").filter(l => !/^\s*\|.*\|\s*$/.test(l) && !/^\s*-{3,}\s*$/.test(l)).join("\n")
    .replace(/\n{3,}/g, "\n\n").trim();
}

function Badge({ color, children }) {
  const c = { green: "bg-emerald-100 text-emerald-800", yellow: "bg-amber-100 text-amber-800", blue: "bg-blue-100 text-blue-800", red: "bg-red-100 text-red-800", gray: "bg-gray-100 text-gray-600" };
  return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${c[color]}`}>{children}</span>;
}
function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4" style={{ background: "rgba(0,0,0,0.5)" }}>
      <div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full max-w-lg flex flex-col" style={{ maxHeight: "90dvh" }}>
        <div className="flex items-center justify-between p-5 border-b border-gray-100 flex-shrink-0">
          <h3 className="text-lg font-bold text-gray-900">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">&times;</button>
        </div>
        <div className="p-5 overflow-y-auto" style={{ paddingBottom: "calc(1.25rem + env(safe-area-inset-bottom))" }}>{children}</div>
      </div>
    </div>
  );
}
function Inp({ label, ...p }) {
  return <div className="flex flex-col gap-1">{label && <label className="text-sm font-medium text-gray-700">{label}</label>}<input className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400" {...p} /></div>;
}
function Sel({ label, options, ...p }) {
  return <div className="flex flex-col gap-1">{label && <label className="text-sm font-medium text-gray-700">{label}</label>}<select className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400" {...p}>{options.map(o => <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>)}</select></div>;
}
function Btn({ variant = "primary", size = "md", children, onClick, disabled, ...p }) {
  const sz = { sm: "px-3 py-1.5 text-xs", md: "px-4 py-2 text-sm", lg: "px-6 py-3 text-base" };
  const vr = { primary: "bg-amber-500 hover:bg-amber-600 text-white", secondary: "bg-gray-100 hover:bg-gray-200 text-gray-700", danger: "bg-red-500 hover:bg-red-600 text-white", ghost: "hover:bg-gray-100 text-gray-600" };
  const [busy, setBusy] = useState(false);
  // Если onClick — асинхронный (возвращает промис), сами показываем «крутилку» и блокируем повторные нажатия
  const handleClick = async e => {
    if (busy || disabled || !onClick) return;
    let r;
    try { r = onClick(e); } catch (err) { return; }
    if (r && typeof r.then === "function") {
      setBusy(true);
      try { await r; } catch (err) {} finally { setBusy(false); }
    }
  };
  return (
    <button onClick={handleClick} disabled={disabled || busy} className={`relative rounded-lg font-medium transition-all focus:outline-none active:scale-95 disabled:opacity-60 disabled:cursor-default inline-flex items-center justify-center gap-1.5 ${sz[size]} ${vr[variant]}`} {...p}>
      {busy && <span className={`inline-block ${size === "sm" ? "w-3 h-3 border-2" : "w-3.5 h-3.5 border-2"} border-current border-t-transparent rounded-full animate-spin`} style={{ opacity: 0.85 }} aria-hidden="true"></span>}
      {children}
    </button>
  );
}
// Иконки — inline SVG (стиль Tabler), работают офлайн в PWA. Цвет наследуется из text-* (currentColor).
const ICONS = {
  home: '<path d="M4 11 12 4l8 7"/><path d="M6 10v9a1 1 0 0 0 1 1h3v-5h4v5h3a1 1 0 0 0 1-1v-9"/>',
  calendar: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4M16 3v4M4 9h16"/>',
  box: '<path d="M12 3 3.5 7.5v9L12 21l8.5-4.5v-9L12 3z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/>',
  flask: '<path d="M9 3h6M10 3v6l-4.6 8.1A1.5 1.5 0 0 0 6.7 20h10.6a1.5 1.5 0 0 0 1.3-2.9L14 9V3"/><path d="M8 14h8"/>',
  calculator: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01"/>',
  building: '<path d="M3 21h18M5 21V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v15M15 21V10h2a2 2 0 0 1 2 2v9M8 8h.01M12 8h.01M8 12h.01M12 12h.01M8 16h.01M12 16h.01"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5H3.5S6 15 6 9z"/><path d="M10 19a2 2 0 0 0 4 0"/>',
  chart: '<path d="M4 4v16h16"/><path d="M8 16v-4M12 16V8M16 16v-6"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M16 14h.01"/>',
  file: '<path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  receipt: '<path d="M6 3h12v17l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3z"/><path d="M9 8h6M9 12h4"/>',
  clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><rect x="9" y="2.5" width="6" height="3" rx="1"/><path d="M9 11h6M9 15h6"/>',
  truck: '<path d="M3 6h11v10H3z"/><path d="M14 9h3.5l2.5 3v4h-6z"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/>',
  store: '<path d="M4 10v10h16V10"/><path d="M3 10 4.5 4h15L21 10a2.5 2.5 0 0 1-5 0 2.5 2.5 0 0 1-4 0 2.5 2.5 0 0 1-4 0 2.5 2.5 0 0 1-5 0z"/><path d="M9 20v-5h6v5"/>',
  folder: '<path d="M4 6a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/>',
  cash: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9h.01M18 15h.01"/>',
  expense: '<rect x="3" y="7" width="13" height="10" rx="2"/><circle cx="9.5" cy="12" r="2"/><path d="M20 8v7m-2-2 2 2 2-2"/>',
  coin: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5v9M14.5 9.8C14 8.9 13 8.5 12 8.5c-1.4 0-2.5.7-2.5 1.8s1.1 1.5 2.5 1.7 2.5.6 2.5 1.7-1.1 1.8-2.5 1.8c-1 0-2-.4-2.5-1.3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
  refresh: '<path d="M19.9 13A8 8 0 1 1 18 6.7"/><path d="M18 2.5v4.2h-4.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  dots: '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="M5 12.5 10 17 19 6"/>',
  sparkle: '<path d="M12 3l1.8 4.7L18.5 9l-4.7 1.3L12 15l-1.8-4.7L5.5 9l4.7-1.3z"/><path d="M18.5 15l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6z"/>',
  chat: '<path d="M4 12a8 8 0 1 1 3.6 6.7L4 20l1.3-3.6A8 8 0 0 1 4 12z"/><path d="M8.5 11h.01M12 11h.01M15.5 11h.01"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M5 12v8h14v-8"/><path d="M12 8v12"/><path d="M12 8C10.5 8 8 7.6 8 5.9 8 4.8 8.8 4 9.9 4 11.6 4 12 6.5 12 8z"/><path d="M12 8c1.5 0 4-.4 4-2.1C16 4.8 15.2 4 14.1 4 12.4 4 12 6.5 12 8z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="2.5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  note: '<path d="M5 4h14a1 1 0 0 1 1 1v10l-5 5H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M15 20v-4a1 1 0 0 1 1-1h4"/><path d="M8 9h8M8 13h4"/>',
  pin: '<path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  camera: '<path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.2"/>',
  bag: '<path d="M6 8h12l-1 12H7z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
  trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M10 11v6M14 11v6"/>',
  nav: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5 13 13l-4.5 2.5L11 11z"/>',
  door: '<path d="M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17M4 21h16M14 12h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  phone: '<path d="M5 4h3l1.6 5-2 1.4a12 12 0 0 0 5.9 5.9l1.4-2 5 1.6v3a1.5 1.5 0 0 1-1.7 1.5A16 16 0 0 1 3.5 6.7 1.5 1.5 0 0 1 5 4z"/>',
  link: '<path d="M9.5 14.5 14.5 9.5"/><path d="M10.5 6.8 12.3 5a4 4 0 0 1 5.7 5.7l-1.8 1.8"/><path d="M13.5 17.2 11.7 19a4 4 0 0 1-5.7-5.7l1.8-1.8"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M10.9 12.1 20 3M16.5 6.5l2 2M14.5 8.5l1.5 1.5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  download: '<path d="M12 3v12M7 11l5 5 5-5M5 20h14"/>',
  moon: '<path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a6.5 6.5 0 0 0 11 11z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>',
  logout: '<path d="M9 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"/><path d="M15 16l4-4-4-4M19 12H9"/>',
};
function Icon({ name, size = 22, className = "", stroke = 1.8 }) {
  const p = ICONS[name];
  if (!p) return null;
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" dangerouslySetInnerHTML={{ __html: p }} />;
}
function Spinner() {
  return <div className="flex flex-col items-center justify-center py-16 gap-3"><div className="w-8 h-8 border-4 border-amber-400 border-t-transparent rounded-full animate-spin"></div><p className="text-sm text-gray-400">Загружаю данные...</p></div>;
}
function MiniBar({ value, max, color = "bg-amber-400" }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return <div className="flex items-center gap-2 w-full"><div className="flex-1 bg-gray-100 rounded-full h-2.5 overflow-hidden"><div className={`${color} h-2.5 rounded-full`} style={{ width: pct + "%" }} /></div><span className="text-xs text-gray-500 w-8 text-right">{pct}%</span></div>;
}

const TABS = [{ id: "today", label: "🏠 Сегодня" }, { id: "calendar", label: "📅 Календарь" }, { id: "stock", label: "🏭 Склад" }, { id: "clients", label: "🏢 Клиенты" }, { id: "reactivate", label: "🔔 Напомнить" }, { id: "reports", label: "📊 Отчёты" }, { id: "debts", label: "💰 Долги" }, { id: "contracts", label: "📄 Договоры" }, { id: "supply", label: "🚚 Поставки" }, { id: "karaganda", label: "🏬 Караганда" }, { id: "drivers", label: "🚛 Водители" }, { id: "expenses", label: "💸 Расходы" }, { id: "access", label: "⚙️ Доступ" }];

// Просмотр фото накладной с увеличением: щипок двумя пальцами, двойное касание, кнопки + −
function PhotoViewer({ url, onClose }) {
  const [zoom, setZoom] = useState(1);
  const boxRef = useRef(null);
  const pinch = useRef(null);
  // Щипок двумя пальцами
  const onTouchStart = e => { if (e.touches.length === 2) pinch.current = { d: Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY), z: zoom }; };
  const onTouchMove = e => {
    if (e.touches.length === 2 && pinch.current) {
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      setZoom(Math.min(5, Math.max(1, pinch.current.z * (d / pinch.current.d))));
    }
  };
  const onTouchEnd = () => { pinch.current = null; };
  const toggle = () => setZoom(z => (z > 1 ? 1 : 2.5)); // двойное касание / клик по фото
  return (
    <div className="fixed inset-0 z-50" style={{ background: "rgba(0,0,0,0.92)" }}>
      <div
        ref={boxRef}
        className="w-full h-full overflow-auto flex items-center justify-center p-2"
        style={{ touchAction: "pan-x pan-y pinch-zoom", WebkitOverflowScrolling: "touch" }}
        onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
      >
        <img
          src={url} alt="фото"
          onDoubleClick={toggle} onClick={e => { if (zoom > 1) e.stopPropagation(); }}
          style={{ width: `${zoom * 100}%`, maxWidth: zoom === 1 ? "100%" : "none", height: "auto", transition: "width .15s", borderRadius: 8 }}
        />
      </div>
      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/60 rounded-full px-2 py-1.5">
        <button onClick={() => setZoom(z => Math.max(1, z - 0.5))} className="text-white text-2xl w-10 h-10 leading-none">−</button>
        <span className="text-white text-sm font-bold w-12 text-center">{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom(z => Math.min(5, z + 0.5))} className="text-white text-2xl w-10 h-10 leading-none">+</button>
        <a href={url} target="_blank" rel="noreferrer" className="text-white text-sm font-medium px-3">Открыть</a>
      </div>
      <button className="absolute top-4 right-4 text-white text-4xl leading-none" onClick={onClose}>&times;</button>
      {zoom === 1 && <div className="absolute top-5 left-1/2 -translate-x-1/2 text-white/70 text-xs">Щипок или двойное касание — увеличить</div>}
    </div>
  );
}

function CalendarTab({ orders, drivers, clients, stock = [], reload, applyLocal = () => {}, canEdit = true, showPrices = true, driverFilter = null, driverMode = false, foremanMode = false, serverStock = false }) {
  const [cursor, setCursor] = useState(new Date());
  const [selected, setSelected] = useState(TODAY());
  const [uploadingId, setUploadingId] = useState(null);
  const [photoView, setPhotoView] = useState(null);
  const [editGroup, setEditGroup] = useState(null);

  // Отгрузки из Караганды идут напрямую клиенту — в маршруты Астаны не лезут, но в календаре видны отдельным блоком
  const local = orders.filter(o => !o.fromKaraganda);
  // Водитель видит свои отгрузки (развоз по driverId) + самовывоз, где он грузчик/контролёр (loaderId, у самовывоза driverId пустой)
  const visAll = driverFilter != null ? local.filter(o => o.driverId === driverFilter || o.loaderId === driverFilter) : local;
  const loadRows = visAll.filter(o => o.foreignLoad); // сводная загрузка чужих заявок (у торгпреда) — только тоннаж/число
  const vis = visAll.filter(o => !o.foreignLoad);
  const karagandaVis = driverFilter != null ? [] : orders.filter(o => o.fromKaraganda); // только директор/бухгалтер

  const notifyErr = e => alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз.");

  // Водитель отмечает «доставил» (предварительно, без списания со склада)
  const driverMarkDelivered = async o => { try { await dbUpsert("orders", { ...o, delivered_by_driver: true, delivered_at: new Date().toISOString() }); await reload("orders"); } catch (e) { notifyErr(e); } };
  const driverUnmark = async o => { try { await dbUpsert("orders", { ...o, delivered_by_driver: false }); await reload("orders"); } catch (e) { notifyErr(e); } };
  // Прикрепить фото (накладная / мука у клиента)
  const addPhoto = async (o, file) => {
    if (!file) return;
    setUploadingId(o.id);
    try {
      const url = await uploadPhoto(o.id, file);
      const at = new Date().toISOString(); // время загрузки документа — видно администратору
      applyLocal("orders", os => os.map(x => x.id === o.id ? { ...x, photos: [...(x.photos || []), url], photo_at: { ...(x.photo_at || {}), [url]: at } } : x));
      await dbUpsert("orders", { ...o, photos: [...(o.photos || []), url], photo_at: { ...(o.photo_at || {}), [url]: at } });
    } catch (e) { alert("⚠️ Не удалось загрузить фото: " + e.message + "\nПроверь интернет и попробуй ещё раз."); reload("orders"); }
    setUploadingId(null);
  };
  // ЖЕЛЕЗНЫЙ УЧЁТ: на каждую позицию заявки — ровно ОДНО движение склада (id = mv_<id заявки>).
  // Повторное списание (двойное нажатие, два администратора) перезаписывает ту же строку — не задваивается.
  // Отмена отгрузки удаляет эту строку — точный откат без «дрейфа» остатков.
  const busyRef = useRef(new Set()); // замок: группа, по которой уже идёт сохранение
  // serverStock=true (торгпред): движение склада пишет СЕРВЕР при сохранении заявки — у роли rep
  // нет прав на таблицу stock, и попытка записать её из браузера дала бы ложную ошибку.
  const shipStock = o => serverStock ? Promise.resolve() : dbUpsert("stock", { id: "mv_" + o.id, date: TODAY(), brand: o.brand, grade: o.grade, weight_kg: -(o.bags * o.bag_kg), bags: -o.bags, bag_kg: o.bag_kg, note: `Отгрузка: ${o.clientName}` });
  const unshipStock = async o => {
    if (serverStock) return; // откат тоже делает сервер
    if (stock.some(s => s.id === "mv_" + o.id)) return dbDelete("stock", "mv_" + o.id); // точный откат
    // заявки, списанные до этого обновления, возвращаем отдельной строкой (как раньше)
    return dbUpsert("stock", { id: uid(), date: TODAY(), brand: o.brand, grade: o.grade, weight_kg: o.bags * o.bag_kg, bags: o.bags, bag_kg: o.bag_kg, note: `Возврат: ${o.clientName}` });
  };

  // Директор подтверждает доставку → списание со склада
  const confirmDelivery = async o => {
    try {
      await dbUpsert("orders", { ...o, confirmed: true, status: "отгружена" });
      if (o.status !== "отгружена") {
        await shipStock(o);
        await reload("stock");
      }
      await reload("orders");
    } catch (e) { notifyErr(e); }
  };

  // Изменение статуса. Если переключаем НА "отгружена" — списываем со склада;
  // если снимаем "отгружена" — возвращаем на склад, чтобы остатки не врали.
  const updateStatus = async (o, status) => {
    if (status === o.status) return;
    try {
      await dbUpsert("orders", { ...o, status });
      if (status === "отгружена" && o.status !== "отгружена") {
        await shipStock(o);
        await reload("stock");
      } else if (status !== "отгружена" && o.status === "отгружена") {
        await unshipStock(o);
        await reload("stock");
      }
      await reload("orders");
    } catch (e) { notifyErr(e); }
  };
  const assignDriver = async (o, driverId) => { try { await dbUpsert("orders", { ...o, driverId }); await reload("orders"); } catch (e) { notifyErr(e); } };
  const deleteOrder = async (id) => { try { await dbDelete("orders", id); await reload("orders"); reload("stock"); } catch (e) { notifyErr(e); } };

  // Действия на всю заявку клиента (несколько позиций). Оптимистично: экран меняется сразу, запись — в фоне.
  const assignDriverGroup = async (g, driverId) => {
    const ids = new Set(g.orders.map(o => o.id));
    applyLocal("orders", os => os.map(o => ids.has(o.id) ? { ...o, driverId } : o));
    try { await Promise.all(g.orders.map(o => dbUpsert("orders", { ...o, driverId }))); } catch (e) { notifyErr(e); reload("orders"); }
  };
  const assignLoaderGroup = async (g, loaderId) => { // грузчик для самовывоза
    const ids = new Set(g.orders.map(o => o.id));
    applyLocal("orders", os => os.map(o => ids.has(o.id) ? { ...o, loaderId } : o));
    try { await Promise.all(g.orders.map(o => dbUpsert("orders", { ...o, loaderId }))); } catch (e) { notifyErr(e); reload("orders"); }
  };
  const setGroupWatch = async (g, pickupWatch) => { // самовывоз: грузим сами ↔ только контроль (без оплаты)
    const ids = new Set(g.orders.map(o => o.id));
    applyLocal("orders", os => os.map(o => ids.has(o.id) ? { ...o, pickupWatch } : o));
    try { await Promise.all(g.orders.map(o => dbUpsert("orders", { ...o, pickupWatch }))); } catch (e) { notifyErr(e); reload("orders"); }
  };
  const deleteGroup = async g => {
    const shipped = g.orders.some(o => o.status === "отгружена" && !o.fromKaraganda);
    if (!confirm(`Удалить всю заявку «${g.clientName}» (${g.orders.length} поз.)?${shipped ? "\nЗаявка была отгружена — мука вернётся на склад." : ""}`)) return;
    const ids = new Set(g.orders.map(o => o.id));
    applyLocal("orders", os => os.filter(o => !ids.has(o.id)));
    try { await Promise.all(g.orders.map(o => dbDelete("orders", o.id))); reload("stock"); } catch (e) { notifyErr(e); reload("orders"); reload("stock"); }
  };
  // Разовый покупатель понравился → заводим в базу клиентов и привязываем его заявки
  const addOneOffToClients = async g => {
    if (!confirm(`Добавить «${g.clientName}» в базу клиентов?`)) return;
    try {
      const o0 = g.orders[0];
      const id = uid();
      const prices = [];
      g.orders.forEach(o => { if ((o.price_per_kg || 0) > 0 && !prices.some(p => p.brand === o.brand && p.grade === o.grade && p.bag_kg === Number(o.bag_kg))) prices.push({ brand: o.brand, grade: o.grade, bag_kg: Number(o.bag_kg), price_per_kg: Number(o.price_per_kg) }); });
      await dbUpsert("clients", { id, name: g.clientName || "Клиент", org_name: "", contact_name: "", address: o0.oneOffAddress || "", contact: "", gis_link: o0.gis_link || "", coords: o0.coords || null, default_bag_kg: Number(o0.bag_kg) || "", default_brand: o0.brand || "", prices });
      await Promise.all(g.orders.map(o => dbUpsert("orders", { ...o, clientId: id })));
      await reload("clients"); await reload("orders");
      alert(`✓ «${g.clientName}» теперь в базе клиентов. Дополни карточку (телефон, реквизиты) во вкладке «Клиенты».`);
    } catch (e) { notifyErr(e); }
  };
  const setGroupStatus = async (g, status) => {
    if (busyRef.current.has(g.key)) return; // замок: пока первое нажатие сохраняется, второе игнорируем
    busyRef.current.add(g.key);
    const ids = new Set(g.orders.map(o => o.id));
    applyLocal("orders", os => os.map(o => ids.has(o.id) ? { ...o, status } : o));
    try {
      await Promise.all(g.orders.map(async o => {
        if (o.status === status) return;
        await dbUpsert("orders", { ...o, status });
        if (o.fromKaraganda) return; // карагандинские отгрузки склад Астаны не трогают
        if (status === "отгружена" && o.status !== "отгружена") await shipStock(o);
        else if (status !== "отгружена" && o.status === "отгружена") await unshipStock(o);
      }));
      reload("stock"); // склад подтянем в фоне (не блокируя экран)
    } catch (e) { notifyErr(e); reload("orders"); reload("stock"); }
    finally { busyRef.current.delete(g.key); }
  };
  const confirmGroup = async g => {
    if (busyRef.current.has(g.key)) return; // замок от двойного нажатия
    busyRef.current.add(g.key);
    const ids = new Set(g.orders.map(o => o.id));
    applyLocal("orders", os => os.map(o => ids.has(o.id) ? { ...o, confirmed: true, status: "отгружена" } : o));
    try {
      await Promise.all(g.orders.map(async o => {
        if (o.confirmed && o.status === "отгружена") return;
        await dbUpsert("orders", { ...o, confirmed: true, status: "отгружена" });
        if (o.status !== "отгружена" && !o.fromKaraganda) await shipStock(o);
      }));
      reload("stock");
    } catch (e) { notifyErr(e); reload("orders"); reload("stock"); }
    finally { busyRef.current.delete(g.key); }
  };
  const driverMarkGroup = async (g, val) => {
    const ids = new Set(g.orders.map(o => o.id));
    const at = new Date().toISOString();
    applyLocal("orders", os => os.map(o => ids.has(o.id) ? { ...o, delivered_by_driver: val, delivered_at: val ? at : o.delivered_at } : o));
    try { await Promise.all(g.orders.map(o => dbUpsert("orders", { ...o, delivered_by_driver: val, delivered_at: val ? at : o.delivered_at }))); } catch (e) { notifyErr(e); reload("orders"); }
  };
  // Отметка «загрузил в машину» (чтобы не путаться при загрузке нескольких заявок)
  const loadGroup = async (g, val) => {
    if (val && !confirm(`Точно загрузили товар «${g.clientName || "клиента"}» в машину?`)) return;
    const ids = new Set(g.orders.map(o => o.id));
    applyLocal("orders", os => os.map(o => ids.has(o.id) ? { ...o, loaded: val } : o));
    try { await Promise.all(g.orders.map(o => dbUpsert("orders", { ...o, loaded: val }))); } catch (e) { notifyErr(e); reload("orders"); }
  };

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const monthNames = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
  const dayNames = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

  const firstDay = new Date(year, month, 1);
  const startOffset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const kgByDate = {};
  const countByDate = {};
  const seenByDate = {}; // считаем заявки по клиентам, а не по позициям
  [...vis, ...karagandaVis].forEach(o => {
    kgByDate[o.date] = (kgByDate[o.date] || 0) + o.bags * o.bag_kg;
    const key = o.clientId || ("nm:" + (o.clientName || ""));
    if (!seenByDate[o.date]) seenByDate[o.date] = new Set();
    if (!seenByDate[o.date].has(key)) { seenByDate[o.date].add(key); countByDate[o.date] = (countByDate[o.date] || 0) + 1; }
  });
  // Сводная загрузка чужих заявок (торгпред) тоже влияет на «занятость дня» в календаре
  loadRows.forEach(o => { kgByDate[o.date] = (kgByDate[o.date] || 0) + (o.kg || 0); countByDate[o.date] = (countByDate[o.date] || 0) + (o.count || 0); });
  // Статус дня для календаря: всё отгружено → зелёный, есть неотгруженные → жёлтый (чтобы сразу видеть, где забыли подтвердить отгрузку). Отменённые не считаем.
  const shipByDate = {};
  [...vis, ...karagandaVis].forEach(o => {
    if (o.status === "отменена") return;
    const r = shipByDate[o.date] = shipByDate[o.date] || { total: 0, shipped: 0 };
    r.total++;
    if (o.status === "отгружена") r.shipped++;
  });
  const dayShip = ds => { const r = shipByDate[ds]; return !r || r.total === 0 ? null : (r.shipped === r.total ? "done" : "pending"); };

  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    cells.push(ds);
  }

  const sc = { "новая": "blue", "в пути": "yellow", "отгружена": "green", "отменена": "red", "частично": "gray" };
  const dayOrders = vis.filter(o => o.date === selected).sort((a, b) => (a.clientName || "").localeCompare(b.clientName || ""));
  const dayKg = dayOrders.reduce((s, o) => s + o.bags * o.bag_kg, 0);

  // Оптимальный маршрут на день (по неотвезённым с координатами) — используется и для блока маршрута, и для порядка карточек
  const dayRoute = (() => {
    const seen = new Set(); const pts = [];
    dayOrders.filter(o => o.status !== "отгружена" && !o.pickup).forEach(o => { // самовывоз в маршрут доставки не идёт
      const client = clients.find(c => c.id === o.clientId);
      if (client) {
        if (seen.has(client.id)) return;
        const coords = client.coords || parseCoordsFromGisLink(client.gis_link) || parseCoordsFromText(client.coords_manual);
        if (!coords) return;
        seen.add(client.id);
        pts.push({ ...coords, id: client.id, name: o.clientName, delivery_time: clientTime(client) });
        return;
      }
      // Разовая продажа с доставкой: точка 2ГИС хранится прямо в заявке
      const key = "nm:" + (o.clientName || "");
      if (!o.coords || seen.has(key)) return;
      seen.add(key);
      pts.push({ ...o.coords, id: key, name: o.clientName, delivery_time: "" });
    });
    return pts.length ? optimizeRoute(pts) : [];
  })();
  const routeIndex = {}; dayRoute.forEach((p, i) => { if (p.id) routeIndex[p.id] = i; }); // клиент → позиция в маршруте

  // Группируем позиции одного клиента в одну заявку (карточку)
  const dayGroups = (() => {
    const m = {};
    dayOrders.forEach(o => {
      const key = o.clientId || ("nm:" + (o.clientName || ""));
      if (!m[key]) m[key] = { key, clientId: o.clientId, clientName: o.clientName, isSample: false, isTrial: false, orders: [] };
      m[key].orders.push(o);
      if (o.isSample) m[key].isSample = true;
      if (o.trial) m[key].isTrial = true;
    });
    // Порядок: 0 — не загружены, 1 — в машине, 2 — отвезены. Внутри — по очерёдности маршрута.
    const tierOf = g => g.orders.every(o => o.status === "отгружена") ? 2 : (g.orders.every(o => o.loaded) ? 1 : 0);
    return Object.values(m).sort((a, b) => {
      const ta = tierOf(a), tb = tierOf(b);
      if (ta !== tb) return ta - tb;
      const ra = routeIndex[a.clientId || a.key] ?? 9999, rb = routeIndex[b.clientId || b.key] ?? 9999;
      if (ra !== rb) return ra - rb;
      return (a.clientName || "").localeCompare(b.clientName || "");
    });
  })();

  // Карагандинские отгрузки этого дня — отдельным блоком (фура напрямую клиенту)
  const karagandaDayGroups = (() => {
    const m = {};
    karagandaVis.filter(o => o.date === selected).forEach(o => {
      const key = o.clientId || ("nm:" + (o.clientName || ""));
      if (!m[key]) m[key] = { key: "kg:" + key, clientId: o.clientId, clientName: o.clientName, orders: [] };
      m[key].orders.push(o);
    });
    return Object.values(m);
  })();
  const allDayGroups = [...dayGroups, ...karagandaDayGroups]; // для кнопки «Все накладные»

  // Письменный отчёт за выбранный день
  const buildReport = () => {
    const d = selected.split("-").reverse().join(".");
    const totalKg = dayOrders.reduce((s, o) => s + o.bags * o.bag_kg, 0);
    const totalSum = dayOrders.reduce((s, o) => s + o.bags * o.bag_kg * (o.price_per_kg || 0), 0);
    const L = [`Отчёт за ${d}`, "=".repeat(30), `Заявок: ${dayGroups.length}  ·  Всего: ${fmt(totalKg)} кг${showPrices ? `  ·  Сумма: ${fmt(totalSum)} тг` : ""}`, ""];
    L.push("ПО КЛИЕНТАМ:");
    dayGroups.forEach(g => {
      const client = clients.find(c => c.id === g.clientId);
      const statuses = [...new Set(g.orders.map(o => o.status))];
      const st = statuses.length === 1 ? statuses[0] : "частично";
      const drv = drivers.find(dr => dr.id === g.orders[0].driverId);
      const gKg = g.orders.reduce((s, o) => s + o.bags * o.bag_kg, 0);
      L.push(`• ${g.clientName}${client?.org_name ? ` (${client.org_name})` : ""} — ${st}${drv ? `, водитель: ${drv.name}` : ""} — ${fmt(gKg)} кг`);
      g.orders.forEach(o => L.push(`    - ${o.brand} ${o.grade} ${o.bag_kg}кг × ${o.bags} = ${fmt(o.bags * o.bag_kg)} кг${showPrices && o.price_per_kg ? ` · ${fmt(o.bags * o.bag_kg * o.price_per_kg)} тг` : ""}`));
    });
    const byDrv = {};
    dayOrders.forEach(o => { if (!o.driverId) return; const dr = drivers.find(x => x.id === o.driverId); if (!dr) return; byDrv[o.driverId] = byDrv[o.driverId] || { name: dr.name, kg: 0, pay: 0 }; const kg = o.bags * o.bag_kg; byDrv[o.driverId].kg += kg; byDrv[o.driverId].pay += kg * (dr.rate_per_kg || 0); });
    if (Object.keys(byDrv).length) { L.push("", "ВОДИТЕЛИ:"); Object.values(byDrv).forEach(v => L.push(`• ${v.name}: ${fmt(v.kg)} кг · к оплате ${fmt(v.pay)} тг`)); }
    return L.join("\n");
  };
  // Таблица для Excel (CSV с ; и BOM — корректно открывается в Excel)
  const buildCsv = () => {
    const headers = ["Дата", "Клиент", "Организация", "Бренд", "Сорт", "Фасовка кг", "Мешков", "Кг", "Цена тг/кг", "Сумма тг", "Статус", "Водитель", "Внёс"];
    const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = dayOrders.map(o => {
      const client = clients.find(c => c.id === o.clientId);
      const drv = drivers.find(dr => dr.id === o.driverId);
      const kg = o.bags * o.bag_kg;
      return [o.date, o.clientName, client?.org_name || "", o.brand, o.grade, o.bag_kg, o.bags, kg, o.price_per_kg || 0, kg * (o.price_per_kg || 0), o.status, drv?.name || "", o.created_by_name || ""];
    });
    return "﻿" + [headers, ...rows].map(r => r.map(esc).join(";")).join("\r\n");
  };

  const prevMonth = () => setCursor(new Date(year, month - 1, 1));
  const nextMonth = () => setCursor(new Date(year, month + 1, 1));

  // Нехватка муки: спрос неотгруженных заявок (новая + в пути) против остатка на складе
  const stockShortages = (() => {
    if (driverMode || !stock.length) return [];
    const bal = {};
    stock.forEach(s => { const k = `${s.brand}|${s.grade}|${s.bag_kg}`; bal[k] = (bal[k] || 0) + Number(s.bags || 0); });
    const need = {};
    orders.filter(o => (o.status === "новая" || o.status === "в пути") && !o.fromKaraganda).forEach(o => { const k = `${o.brand}|${o.grade}|${o.bag_kg}`; need[k] = (need[k] || 0) + Number(o.bags || 0); });
    const out = [];
    Object.entries(need).forEach(([k, n]) => { const have = Math.max(0, bal[k] || 0); if (n > have) { const [brand, grade, bag_kg] = k.split("|"); out.push({ brand, grade, bag_kg, need: n, have, lack: n - have }); } });
    return out.sort((a, b) => b.lack - a.lack);
  })();

  return (
    <div className="space-y-5">
      {stockShortages.length > 0 && (
        <div className="bg-red-100 border border-red-300 rounded-2xl p-4">
          <div className="font-bold text-red-700 mb-1">⚠️ Не хватает муки под заявки</div>
          <div className="space-y-1">
            {stockShortages.map((s, i) => (
              <div key={i} className="text-sm text-red-700">• <b>{s.brand} {s.grade} {s.bag_kg}кг</b> — нужно {s.need} меш., на складе {s.have} → не хватает <b>{s.lack} меш.</b></div>
            ))}
          </div>
          <div className="text-xs text-red-600 mt-2">Закажи приход (фуру) или перенеси часть заявок на другой день.</div>
        </div>
      )}
      <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-4">
        <div className="flex items-center justify-between mb-4">
          <button onClick={prevMonth} className="px-3 py-1 rounded-lg hover:bg-gray-100 text-gray-600 text-lg">‹</button>
          <h3 className="font-bold text-gray-800">{monthNames[month]} {year}</h3>
          <button onClick={nextMonth} className="px-3 py-1 rounded-lg hover:bg-gray-100 text-gray-600 text-lg">›</button>
        </div>
        <div className="grid grid-cols-7 gap-1 mb-1">
          {dayNames.map(d => <div key={d} className="text-center text-xs font-semibold text-gray-400 py-1">{d}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((ds, i) => {
            if (!ds) return <div key={i} />;
            const dayNum = Number(ds.split("-")[2]);
            const cnt = countByDate[ds] || 0;
            const isToday = ds === TODAY();
            const isSelected = ds === selected;
            const st = dayShip(ds); // "done" | "pending" | null
            let cls = "aspect-square rounded-lg flex flex-col items-center justify-center text-sm relative transition-all ";
            if (isSelected && !st) cls += "bg-amber-500 text-white ";
            else if (st === "done") cls += "bg-emerald-100 text-emerald-900 hover:bg-emerald-200 ";
            else if (st === "pending") cls += "bg-amber-200 text-amber-900 hover:bg-amber-300 ";
            else cls += "text-gray-600 hover:bg-gray-100 ";
            if (isSelected && st) cls += "ring-2 ring-gray-800 font-bold ";
            else if (isToday && !isSelected) cls += "ring-2 ring-amber-400 ";
            return (
              <button key={ds} onClick={() => setSelected(ds)} className={cls}>
                <span className={isToday ? "font-bold" : ""}>{dayNum}</span>
                {cnt > 0 && <span className={`text-[9px] leading-none mt-0.5 ${st === "done" ? "text-emerald-700" : st === "pending" ? "text-amber-800" : "text-gray-400"}`}>{st === "done" ? "✓ " : st === "pending" ? "● " : ""}{cnt} зак.</span>}
              </button>
            );
          })}
        </div>
        <div className="flex items-center justify-center gap-4 mt-3 text-xs text-gray-500">
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-emerald-200 inline-block"></span>всё отгружено</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-amber-200 inline-block"></span>есть неотгруженные</span>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          <h4 className="font-semibold text-gray-700">Отгрузки на {selected.split("-").reverse().join(".")}</h4>
          {dayKg > 0 && (() => {
            const leftKg = dayOrders.filter(o => o.status !== "отгружена").reduce((s, o) => s + o.bags * o.bag_kg, 0);
            return <span className="text-sm text-gray-500 inline-flex items-center gap-1"><Icon name="box" size={13} />{fmt(dayKg)} кг{leftKg > 0 ? <> · <b className="text-amber-700">осталось {fmt(leftKg)} кг</b></> : <> · <b className="text-emerald-600">✓ всё отгружено</b></>}</span>;
          })()}
        </div>
        {!driverMode && dayOrders.length > 0 && (
          <div className="flex gap-2 mb-3">
            <Btn size="sm" variant="secondary" onClick={() => downloadFile(`Отчёт_${selected}.txt`, buildReport(), "text/plain;charset=utf-8")}><Icon name="download" size={15} />Отчёт за день</Btn>
            <Btn size="sm" variant="secondary" onClick={() => downloadFile(`Склад_${selected}.csv`, buildCsv(), "text/csv;charset=utf-8")}><Icon name="download" size={15} />Excel</Btn>
          </div>
        )}
        {(() => {
          const dl = loadRows.filter(o => o.date === selected && (o.kg > 0 || o.count > 0));
          if (!dl.length) return null;
          const tKg = dl.reduce((s, o) => s + (o.kg || 0), 0);
          const tCnt = dl.reduce((s, o) => s + (o.count || 0), 0);
          return (
            <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 mb-3">
              <div className="flex items-center justify-between mb-2 gap-2">
                <span className="font-semibold text-slate-700 text-sm flex items-center gap-1.5"><Icon name="truck" size={16} />Загрузка водителей</span>
                <span className="text-xs text-slate-500">{tCnt} заявок · {fmt(tKg)} кг</span>
              </div>
              <div className="space-y-1">
                {dl.sort((a, b) => (b.kg || 0) - (a.kg || 0)).map(o => {
                  const dr = drivers.find(d => d.id === o.driverId);
                  return (
                    <div key={o.id} className="flex items-center justify-between text-sm bg-white rounded-lg px-3 py-1.5">
                      <span className="text-slate-700 inline-flex items-center gap-1">{dr ? <><Icon name="truck" size={13} />{dr.name}</> : "— не распределено —"}</span>
                      <span className="text-slate-500">{o.count} заявок · <b className="text-slate-700">{fmt(o.kg)} кг</b></span>
                    </div>
                  );
                })}
              </div>
              <div className="text-[11px] text-slate-400 mt-1.5">Другие заявки — только объём, чтобы видеть загрузку водителя. Кому и что везут — не показывается.</div>
            </div>
          );
        })()}
        {dayOrders.length === 0 && karagandaDayGroups.length === 0 && loadRows.filter(o => o.date === selected).length === 0 ? (
          <div className="text-center py-10 text-gray-400">На это число отгрузок нет</div>
        ) : (
          <div className="space-y-2">
            {dayGroups.map((g, gi, arr) => {
              const client = clients.find(c => c.id === g.clientId);
              const driver = drivers.find(d => d.id === g.orders[0].driverId);
              const isPickup = g.orders.some(o => o.pickup);
              const isWatch = isPickup && g.orders.some(o => o.pickupWatch); // самовывоз только под контролем (без погрузки)
              const isOneOff = g.orders.some(o => o.oneOff);
              const worker = isPickup ? drivers.find(d => d.id === g.orders.find(o => o.loaderId)?.loaderId) : driver;
              const statuses = [...new Set(g.orders.map(o => o.status))];
              const gStatus = statuses.length === 1 ? statuses[0] : "частично";
              const gKg = g.orders.reduce((s, o) => s + o.bags * o.bag_kg, 0);
              const gSum = g.orders.reduce((s, o) => s + o.bags * o.bag_kg * (o.price_per_kg || 0), 0);
              const gPhotos = [...new Set(g.orders.flatMap(o => o.photos || []))];
              const allDelivered = g.orders.every(o => o.delivered_by_driver);
              // Считаем «заявкой на подтверждение» отметку водителя ИЛИ прикреплённое им фото (накладную)
              const anyClaim = g.orders.some(o => o.delivered_by_driver) || gPhotos.length > 0;
              const allConfirmed = g.orders.every(o => o.confirmed);
              const allShipped = g.orders.every(o => o.status === "отгружена");
              const allLoaded = g.orders.every(o => o.loaded);
              const firstId = g.orders[0].id;
              const prevShipped = gi > 0 && arr[gi - 1].orders.every(o => o.status === "отгружена");
              const shippedCount = arr.filter(x => x.orders.every(o => o.status === "отгружена")).length;
              return (
                <Fragment key={g.key}>
                {allShipped && !prevShipped && <div className="text-xs font-semibold text-emerald-600 pt-2 pb-1">— ✓ Отвезено ({shippedCount}) —</div>}
                <div className={`rounded-xl px-4 py-3 text-sm border ${allShipped ? "bg-emerald-50 border-emerald-300" : allLoaded ? "bg-amber-50 border-amber-300" : "bg-red-50 border-red-200"}`}>
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <span className="font-semibold text-gray-900 flex items-center gap-1.5 flex-wrap">{allShipped && <span className="text-emerald-600"><Icon name="check" size={18} stroke={2.4} /></span>}{g.clientName || "Клиент"}{g.isSample && <Badge color="yellow">Проба</Badge>}{g.isTrial && <Badge color="yellow">на пробу</Badge>}{isPickup && (isWatch ? <span className="text-xs font-medium text-purple-700 bg-purple-100 px-2 py-0.5 rounded-full inline-flex items-center gap-1"><Icon name="eye" size={12} />самовывоз · контроль</span> : <span className="text-xs font-medium text-sky-700 bg-sky-100 px-2 py-0.5 rounded-full inline-flex items-center gap-1"><Icon name="bag" size={12} />Самовывоз</span>)}{isOneOff && <span className="text-xs font-medium text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full inline-flex items-center gap-1"><Icon name="coin" size={12} />разовая</span>}{g.orders.some(o => o.from_client) && <span className="text-xs font-medium text-blue-700 bg-blue-100 px-2 py-0.5 rounded-full inline-flex items-center gap-1"><Icon name="globe" size={12} />от клиента</span>}{g.orders.some(o => o.created_by_role === "rep") && <span className="text-xs font-medium text-violet-700 bg-violet-100 px-2 py-0.5 rounded-full inline-flex items-center gap-1"><Icon name="user" size={12} />торгпред: {g.orders.find(o => o.created_by_role === "rep")?.created_by_name || "?"}</span>}{!isPickup && !isOneOff && allLoaded && !allShipped && <span className="text-xs font-medium text-blue-700 bg-blue-100 px-2 py-0.5 rounded-full inline-flex items-center gap-1"><Icon name="box" size={12} />в машине</span>}</span>
                    {allShipped ? <span className="text-xs font-bold bg-emerald-600 text-white px-3 py-1 rounded-full whitespace-nowrap">✓ Отгружено</span> : <Badge color={sc[gStatus] || "gray"}>{gStatus}</Badge>}
                  </div>
                  {client?.org_name && <div className="text-xs text-gray-500 flex items-center gap-1"><Icon name="building" size={12} />{client.org_name}</div>}
                  <div className="mt-1 space-y-1">
                    {mergedPositions(g.orders).map((m, mi) => (
                      <div key={mi} className="text-gray-600 flex items-center gap-2 flex-wrap">
                        <span>• {m.brand} {m.grade}</span>
                        <span className="bg-amber-100 text-amber-900 font-semibold px-2 py-0.5 rounded-md whitespace-nowrap inline-flex items-center gap-1"><Icon name="box" size={13} />{m.bags} меш. × {m.bag_kg} кг</span>
                        <span>= <b>{fmt(m.bags * m.bag_kg)} кг</b></span>
                        {m.trial ? <span className="text-orange-600 font-medium">на пробу</span> : (showPrices && m.tg ? <span className="text-gray-400">· {fmt(m.tg)} тг</span> : null)}
                      </div>
                    ))}
                  </div>
                  {g.orders.length > 1 && <div className="text-xs text-gray-500 mt-1">Итого: <b>{fmt(gKg)} кг</b>{showPrices && gSum ? ` · ${fmt(gSum)} тг` : ""}</div>}
                  {[...new Set(g.orders.map(o => o.note).filter(Boolean))].map((n, ni) => <div key={ni} className="text-sm font-semibold text-amber-900 bg-amber-100 border border-amber-300 rounded-lg px-3 py-2 mt-1.5 flex items-start gap-1.5"><span className="text-amber-700 mt-0.5"><Icon name="note" size={15} /></span><span className="break-words">{n}</span></div>)}
                  {isOneOff && g.orders[0].oneOffAddress && <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-1"><Icon name="pin" size={13} />{g.orders[0].oneOffAddress}</div>}
                  {!isOneOff && (client?.address || g.orders[0].address) && <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-1"><Icon name="pin" size={13} />{client?.address || g.orders[0].address}</div>}
                  {(client?.work_hours || g.orders[0].work_hours || clientTime(client)) && <div className="mt-1.5 inline-flex items-center gap-1.5 text-sm font-bold text-sky-800 bg-sky-100 border border-sky-300 rounded-lg px-3 py-1.5"><Icon name="clock" size={16} />Работает: {client?.work_hours || g.orders[0].work_hours || clientTime(client)}</div>}
                  {(client?.access_note || g.orders[0].access_note) && <div className="text-xs text-sky-800 bg-sky-50 border border-sky-100 rounded-lg px-2 py-1 mt-1 flex items-start gap-1"><span className="mt-0.5"><Icon name="door" size={13} /></span><span className="break-words">{client?.access_note || g.orders[0].access_note}</span></div>}
                  <div className="text-xs text-gray-400 mt-0.5 flex items-center gap-2 flex-wrap">
                    {(client?.gis_link || g.orders[0].gis_link) &&<a href={client?.gis_link || g.orders[0].gis_link} target="_blank" rel="noreferrer" className="bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full inline-flex items-center gap-1"><Icon name="pin" size={12} />2ГИС</a>}
                    {!driverMode && !g.orders.some(o => o.foreign) && g.orders.some(o => !o.trial && !o.isSample) && <button onClick={() => copyToClipboard(nakladnayaText(g, client))} className="bg-violet-50 text-violet-700 px-2 py-0.5 rounded-full inline-flex items-center gap-1"><Icon name="copy" size={12} />Для накладной</button>}
                    {!driverMode && !g.orders.some(o => o.foreign) && showPrices && g.orders.some(o => !o.trial && !o.isSample) && <button onClick={() => softInvoiceFromOrders(g, client)} className="bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full inline-flex items-center gap-1"><Icon name="receipt" size={12} />Накладная PDF</button>}
                    {!driverMode && canEdit && !g.orders.some(o => o.foreign) && <button onClick={() => setEditGroup(g)} className="bg-gray-100 text-gray-700 px-2 py-0.5 rounded-full inline-flex items-center gap-1"><Icon name="pencil" size={12} />Изменить</button>}
                    {g.orders[0].created_by_name && <span className="inline-flex items-center gap-1"><Icon name="pencil" size={11} />{g.orders[0].created_by_name}</span>}
                  </div>
                  {gPhotos.length > 0 && (() => {
                    const photoAt = Object.assign({}, ...g.orders.map(o => o.photo_at || {})); // когда загружен каждый документ
                    const fmtAt = iso => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }) + " " + d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }); };
                    return (
                      <div className="flex gap-2 flex-wrap mt-2">
                        {gPhotos.map((url, i) => (
                          <div key={i} className="text-center">
                            <img src={url} onClick={() => setPhotoView(url)} className="w-14 h-14 object-cover rounded-lg border border-gray-200 cursor-pointer" alt="фото" />
                            {photoAt[url] && <div className="text-[10px] text-gray-400 leading-tight mt-0.5">📎 {fmtAt(photoAt[url])}</div>}
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                  {anyClaim && !allConfirmed && <div className="text-xs text-amber-600 mt-1 flex items-center gap-1"><Icon name="truck" size={13} />Водитель отметил «доставил» — ждёт подтверждения</div>}
                  {allConfirmed && <div className="text-xs text-emerald-600 mt-1">✓ Подтверждено</div>}

                  {(driverMode || foremanMode) ? (
                    <div className="flex items-center gap-2 flex-wrap mt-2 pt-2 border-t border-gray-50">
                      {foremanMode && !isPickup && !isOneOff && (
                        <select className="border border-gray-200 rounded-lg px-2 py-1 text-xs" value={g.orders[0].driverId || ""} onChange={e => assignDriverGroup(g, e.target.value)}>
                          <option value="">Передать водителю…</option>
                          {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                        </select>
                      )}
                      {!allShipped && (allLoaded
                        ? <Btn size="sm" variant="secondary" onClick={() => loadGroup(g, false)}>↩ Не загружен</Btn>
                        : <Btn size="sm" onClick={() => loadGroup(g, true)}><Icon name="box" size={15} />Загрузил</Btn>)}
                      {allShipped
                        ? <span className="text-sm font-bold text-emerald-700">✓ Доставка подтверждена</span>
                        : (allDelivered
                          ? <Btn size="sm" variant="secondary" onClick={() => driverMarkGroup(g, false)}>↩ Отменить «доставил»</Btn>
                          : <Btn size="sm" onClick={() => driverMarkGroup(g, true)}>✓ Доставил</Btn>)}
                      <label className={`cursor-pointer text-xs rounded-lg px-3 py-1.5 font-medium ${uploadingId === firstId ? "bg-gray-200 text-gray-400" : "bg-gray-100 hover:bg-gray-200 text-gray-700"}`}>
                        {uploadingId === firstId ? "Загрузка..." : <span className="inline-flex items-center gap-1"><Icon name="camera" size={14} />Фото</span>}
                        <input type="file" accept="image/*" capture="environment" hidden disabled={uploadingId === firstId} onChange={e => { addPhoto(g.orders[0], e.target.files[0]); e.target.value = ""; }} />
                      </label>
                    </div>
                  ) : (canEdit && !g.orders.some(o => o.foreign)) ? (
                    (isPickup || isOneOff) ? (
                    <div className="flex items-center gap-2 flex-wrap mt-2 pt-2 border-t border-gray-50">
                      {isPickup && (
                        <select className="border border-gray-200 rounded-lg px-2 py-1 text-xs" value={g.orders[0].loaderId || ""} onChange={e => assignLoaderGroup(g, e.target.value)}>
                          <option value="">{g.orders[0].pickupWatch ? "Кто следит…" : "Грузчик…"}</option>
                          {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                        </select>
                      )}
                      {isPickup && (
                        <button onClick={() => setGroupWatch(g, !g.orders[0].pickupWatch)} className={`text-xs rounded-lg px-2 py-1.5 font-medium ${g.orders[0].pickupWatch ? "bg-purple-100 text-purple-700" : "bg-gray-100 text-gray-600"}`} title="Грузим сами / только контроль (клиент грузит сам)"><span className="inline-flex items-center gap-1"><Icon name={g.orders[0].pickupWatch ? "eye" : "bag"} size={13} />{g.orders[0].pickupWatch ? "Контроль" : "Грузим"}</span></button>
                      )}
                      {!allShipped
                        ? <Btn size="sm" onClick={() => setGroupStatus(g, "отгружена")}>✓ Отгрузить</Btn>
                        : <Btn size="sm" variant="secondary" onClick={() => setGroupStatus(g, "новая")}>↩ Отменить</Btn>}
                      {isOneOff && !g.clientId && <Btn size="sm" variant="secondary" onClick={() => addOneOffToClients(g)}><Icon name="plus" size={15} />В клиенты</Btn>}
                      <Btn size="sm" variant="danger" onClick={() => deleteGroup(g)}><Icon name="trash" size={15} /></Btn>
                    </div>
                    ) : (
                    <div className="flex items-center gap-2 flex-wrap mt-2 pt-2 border-t border-gray-50">
                      <select className="border border-gray-200 rounded-lg px-2 py-1 text-xs" value={g.orders[0].driverId || ""} onChange={e => assignDriverGroup(g, e.target.value)}>
                        <option value="">Водитель…</option>
                        {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </select>
                      {!allShipped && (allLoaded
                        ? <Btn size="sm" variant="secondary" onClick={() => loadGroup(g, false)}>↩ Не загружен</Btn>
                        : <Btn size="sm" variant="secondary" onClick={() => loadGroup(g, true)}><Icon name="box" size={15} />Загрузил</Btn>)}
                      {anyClaim && !allConfirmed
                        ? <Btn size="sm" onClick={() => confirmGroup(g)}>✓ Подтвердить</Btn>
                        : (!allShipped
                          ? <Btn size="sm" onClick={() => setGroupStatus(g, "отгружена")}>✓ Доставлено</Btn>
                          : <Btn size="sm" variant="secondary" onClick={() => setGroupStatus(g, "в пути")}>↩ Не доставлено</Btn>)}
                      <Btn size="sm" variant="danger" onClick={() => deleteGroup(g)}><Icon name="trash" size={15} /></Btn>
                    </div>
                    )
                  ) : (
                    worker ? <div className="text-xs text-gray-400 mt-1 flex items-center gap-1"><Icon name={isPickup ? (g.orders[0].pickupWatch ? "eye" : "bag") : "truck"} size={13} />{worker.name}{isPickup && g.orders[0].pickupWatch ? " · контроль" : ""}</div> : null
                  )}
                </div>
                </Fragment>
              );
            })}
          </div>
        )}
        {!driverMode && allDayGroups.filter(g => !g.orders.some(o => o.foreign) && g.orders.some(o => !o.trial && !o.isSample)).length > 0 && (
          <div className="mt-3">
            <Btn variant="secondary" onClick={() => copyToClipboard(`Накладные на ${selected.split("-").reverse().join(".")}:\n\n` + allDayGroups.filter(g => !g.orders.some(o => o.foreign)).map(g => nakladnayaText(g, clients.find(c => c.id === g.clientId))).filter(Boolean).join("\n\n"))}><Icon name="copy" size={15} />Скопировать все накладные ({allDayGroups.filter(g => !g.orders.some(o => o.foreign) && g.orders.some(o => !o.trial && !o.isSample)).length})</Btn>
          </div>
        )}

        {karagandaDayGroups.length > 0 && (
          <div className="mt-5">
            <h4 className="font-semibold text-gray-700 mb-2 flex items-center gap-1.5"><Icon name="store" size={15} />Из Караганды (напрямую клиентам)</h4>
            <div className="space-y-2">
              {karagandaDayGroups.map(g => {
                const statuses = [...new Set(g.orders.map(o => o.status))];
                const st = statuses.length === 1 ? statuses[0] : "частично";
                const shipped = st === "отгружена";
                const client = clients.find(c => c.id === g.clientId);
                return (
                  <div key={g.key} className={`rounded-xl px-4 py-3 text-sm border ${shipped ? "bg-emerald-50 border-emerald-200" : "bg-orange-50 border-orange-100"}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-gray-900 flex items-center gap-1.5">{shipped && <span className="text-emerald-600">✓</span>}{g.clientName || "Клиент"}</span>
                      {shipped ? <span className="text-xs font-bold bg-emerald-600 text-white px-2.5 py-1 rounded-full whitespace-nowrap">✓ Отгружено</span> : <Badge color="yellow">в пути</Badge>}
                    </div>
                    <div className="mt-1 space-y-1">
                      {mergedPositions(g.orders).map((m, mi) => (
                        <div key={mi} className="text-gray-600 flex items-center gap-2 flex-wrap">
                          <span>• {m.brand} {m.grade}</span>
                          <span className="bg-amber-100 text-amber-900 font-semibold px-2 py-0.5 rounded-md whitespace-nowrap inline-flex items-center gap-1"><Icon name="box" size={13} />{m.bags} меш. × {m.bag_kg} кг</span>
                          <span>= <b>{fmt(m.bags * m.bag_kg)} кг</b></span>
                          {showPrices && m.tg ? <span className="text-gray-400">· {fmt(m.tg)} тг</span> : null}
                        </div>
                      ))}
                    </div>
                    <div className="text-xs text-gray-400 mt-1.5 flex items-center gap-2 flex-wrap">
                      {g.orders.some(o => !o.trial && !o.isSample) && <button onClick={() => copyToClipboard(nakladnayaText(g, client))} className="bg-violet-50 text-violet-700 px-2 py-0.5 rounded-full inline-flex items-center gap-1"><Icon name="copy" size={12} />Для накладной</button>}
                      {showPrices && g.orders.some(o => !o.trial && !o.isSample) && <button onClick={() => softInvoiceFromOrders(g, client)} className="bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full inline-flex items-center gap-1"><Icon name="receipt" size={12} />Накладная PDF</button>}
                      <span className="text-orange-600 inline-flex items-center gap-1"><Icon name="store" size={12} />фура из Караганды</span>
                    </div>
                    {canEdit && (
                      <div className="flex gap-2 mt-2">
                        {shipped
                          ? <Btn size="sm" variant="secondary" onClick={() => setGroupStatus(g, "в пути")}>↩ В путь</Btn>
                          : <Btn size="sm" onClick={() => setGroupStatus(g, "отгружена")}>✓ Отгружено</Btn>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {dayOrders.length > 0 && (() => {
        const pending = dayOrders.filter(o => o.status !== "отгружена");
        const buildRoute = list => {
          const seen = new Set(); const pts = [];
          list.filter(o => !o.pickup).forEach(o => { // самовывоз в маршрут не идёт
            const client = clients.find(c => c.id === o.clientId);
            if (client) {
              if (seen.has(client.id)) return;
              const coords = client.coords || parseCoordsFromGisLink(client.gis_link) || parseCoordsFromText(client.coords_manual);
              if (!coords) return;
              seen.add(client.id);
              pts.push({ ...coords, name: o.clientName, delivery_time: clientTime(client) });
              return;
            }
            // Разовая продажа: точка 2ГИС в самой заявке
            const key = "nm:" + (o.clientName || "");
            if (!o.coords || seen.has(key)) return;
            seen.add(key);
            pts.push({ ...o.coords, name: o.clientName, delivery_time: "" });
          });
          if (!pts.length) return null;
          const optimized = optimizeRoute(pts);
          return { optimized, url: buildGisRouteUrl(optimized), dist: [WAREHOUSE, ...optimized].reduce((a, p, i, arr) => i === 0 ? 0 : a + distKm(arr[i - 1], p), 0) };
        };
        const all = buildRoute(pending);
        if (!all) return (
          <div className="bg-gray-50 border border-dashed border-gray-200 rounded-2xl p-4 text-sm text-gray-400 text-center">
            {pending.length === 0 ? "✓ Все доставки за день отгружены" : "Добавь координаты клиентам чтобы строить маршрут 🗺️"}
          </div>
        );
        // маршруты по водителям
        const byDriver = {};
        pending.forEach(o => { const k = o.driverId || ""; (byDriver[k] = byDriver[k] || []).push(o); });
        const driverBlocks = Object.entries(byDriver).map(([did, list]) => ({ did, name: did ? (drivers.find(d => d.id === did)?.name || "Водитель") : "Без водителя", route: buildRoute(list) })).filter(x => x.route);

        return (
          <div className="space-y-3">
            <div className="bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200 rounded-2xl p-4">
              <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
                <div>
                  <div className="font-bold text-gray-800">🗺️ Весь маршрут на {selected.split("-").reverse().join(".")}</div>
                  <div className="text-xs text-gray-500">{all.optimized.length} точек · ~{Math.round(all.dist)} км</div>
                </div>
                <div className="flex gap-2">
                  <a href={all.url} target="_blank" rel="noreferrer" className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-3 py-2 rounded-xl">Открыть →</a>
                  <button onClick={() => copyToClipboard(all.url)} className="bg-white border border-blue-200 text-blue-700 text-sm font-medium px-3 py-2 rounded-xl inline-flex items-center gap-1.5"><Icon name="link" size={14} />Ссылка</button>
                </div>
              </div>
              <div className="space-y-1">
                {[{ name: "Best Mill (склад)", delivery_time: "" }, ...all.optimized].map((p, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold flex-shrink-0">{i}</span>
                    <span className="text-gray-700">{p.name}</span>
                    {p.delivery_time && <span className="text-xs text-blue-600 ml-auto inline-flex items-center gap-1"><Icon name="clock" size={12} />{p.delivery_time}</span>}
                  </div>
                ))}
              </div>
              <div className="text-xs text-gray-400 mt-2">«Ссылка» — скопировать маршрут в 2ГИС и отправить водителю (в т.ч. разовому, не заводя в систему).</div>
            </div>

            {driverBlocks.length > 1 && driverBlocks.map(b => (
              <div key={b.did || "none"} className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm">
                <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                  <div className="font-display font-semibold text-gray-800 flex items-center gap-1.5"><Icon name="truck" size={16} />{b.name} <span className="text-xs font-normal text-gray-500">· {b.route.optimized.length} точек · ~{Math.round(b.route.dist)} км</span></div>
                  <div className="flex gap-2">
                    <a href={b.route.url} target="_blank" rel="noreferrer" className="bg-blue-50 text-blue-700 text-xs font-medium px-3 py-1.5 rounded-lg">Открыть →</a>
                    <button onClick={() => copyToClipboard(b.route.url)} className="bg-gray-100 text-gray-700 text-xs font-medium px-3 py-1.5 rounded-lg inline-flex items-center gap-1"><Icon name="link" size={13} />Ссылка</button>
                  </div>
                </div>
                <div className="text-xs text-gray-600 space-y-0.5">
                  {b.route.optimized.map((p, i) => <div key={i}>{i + 1}. {p.name}{p.delivery_time ? ` · ${p.delivery_time}` : ""}</div>)}
                </div>
              </div>
            ))}
          </div>
        );
      })()}

      {photoView && <PhotoViewer url={photoView} onClose={() => setPhotoView(null)} />}
      {editGroup && <EditGroupModal key={editGroup.key} group={editGroup} clients={clients} reload={reload} onClose={() => setEditGroup(null)} />}
    </div>
  );
}

function OrdersTab({ clients, drivers, orders, reload, openSignal = 0 }) {
  const [aiText, setAiText] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState(null);
  const [aiError, setAiError] = useState("");
  const [showManual, setShowManual] = useState(false);
  const [saving, setSaving] = useState(false);
  const [filterDate, setFilterDate] = useState(TODAY());
  const [form, setForm] = useState({ clientId: "", brand: BRANDS[0], grade: GRADES[0], bag_kg: 50, bags: "", date: TOMORROW(), driverId: "", price_per_kg: "", isSample: false, sampleName: "", trial: false });
  // Открыть форму заявки по сигналу с кнопки «+»
  useEffect(() => { if (openSignal) setShowManual(true); }, [openSignal]);

  function getPrice(client, brand, grade, bag_kg) {
    return (client?.prices || []).find(p => p.brand === brand && p.grade === grade && p.bag_kg === Number(bag_kg))?.price_per_kg || null;
  }

  const handleAI = async () => {
    if (!aiText.trim()) return;
    setAiLoading(true); setAiError(""); setAiResult(null);
    try {
      const parsed = await parseOrderWithAI(aiText, clients);
      setAiResult(parsed.map(p => {
        const found = clients.find(c => c.name.toLowerCase().includes(p.clientName.toLowerCase()) || p.clientName.toLowerCase().includes(c.name.toLowerCase()));
        return { ...p, trial: !!p.trial, clientId: found?.id || null, clientFound: found?.name || p.clientName, price_per_kg: p.trial ? 0 : (found ? getPrice(found, p.brand, p.grade, p.bag_kg) : null) };
      }));
    } catch { setAiError("Не удалось разобрать. Попробуй ещё раз."); }
    setAiLoading(false);
  };

  const confirmAI = async () => {
    setSaving(true);
    try {
      for (const p of aiResult) {
        await dbUpsert("orders", { id: uid(), date: p.date, clientId: p.clientId, clientName: p.clientFound, brand: p.brand, grade: p.grade, bag_kg: p.bag_kg, bags: p.bags, price_per_kg: p.trial ? 0 : p.price_per_kg, trial: !!p.trial, driverId: "", status: "новая" });
      }
      setAiResult(null); setAiText(""); await reload("orders");
    } catch (e) { setAiError("Ошибка: " + e.message); }
    setSaving(false);
  };

  const addManual = async () => {
    const isTrial = form.trial && !form.isSample; // «на пробу» — существующему клиенту, бесплатно
    if (isTrial && !form.clientId) { alert("Выбери клиента для пробы."); return; }
    setSaving(true);
    const client = form.isSample ? null : clients.find(c => c.id === form.clientId);
    // Пробник и «на пробу» — цена 0 (везём бесплатно). У пробника клиент не из базы — имя пишется вручную.
    const price = (form.isSample || isTrial) ? 0 : (form.price_per_kg || (client ? getPrice(client, form.brand, form.grade, Number(form.bag_kg)) : 0));
    try {
      await dbUpsert("orders", {
        id: uid(), date: form.date, brand: form.brand, grade: form.grade,
        bag_kg: Number(form.bag_kg), bags: Number(form.bags), driverId: form.driverId,
        price_per_kg: Number(price), status: "новая",
        isSample: form.isSample, trial: isTrial,
        clientId: form.isSample ? null : form.clientId,
        clientName: form.isSample ? (form.sampleName || "Проба") : (client?.name || ""),
      });
      setShowManual(false); await reload("orders");
    } catch (e) { alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз."); }
    setSaving(false);
  };

  const notifyErr = e => alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз.");
  const updateStatus = async (o, status) => {
    try {
      await dbUpsert("orders", { ...o, status });
      if (status === "отгружена") {
        const kg = o.bags * o.bag_kg;
        await dbUpsert("stock", { id: uid(), date: TODAY(), brand: o.brand, grade: o.grade, weight_kg: -kg, bags: -o.bags, bag_kg: o.bag_kg, note: `Отгрузка: ${o.clientName}` });
        await reload("stock");
      }
      await reload("orders");
    } catch (e) { notifyErr(e); }
  };

  const assignDriver = async (o, driverId) => { try { await dbUpsert("orders", { ...o, driverId }); await reload("orders"); } catch (e) { notifyErr(e); } };
  const deleteOrder = async id => { try { await dbDelete("orders", id); await reload("orders"); } catch (e) { notifyErr(e); } };
  // Действия на всю заявку клиента (несколько позиций)
  const assignDriverGroup = async (g, driverId) => { try { await Promise.all(g.orders.map(o => dbUpsert("orders", { ...o, driverId }))); await reload("orders"); } catch (e) { notifyErr(e); } };
  const deleteGroup = async g => { if (!confirm(`Удалить всю заявку «${g.clientName}» (${g.orders.length} поз.)?`)) return; try { await Promise.all(g.orders.map(o => dbDelete("orders", o.id))); await reload("orders"); } catch (e) { notifyErr(e); } };
  const setGroupStatus = async (g, status) => {
    try {
      for (const o of g.orders) {
        if (o.status === status) continue;
        await dbUpsert("orders", { ...o, status });
        if (status === "отгружена" && o.status !== "отгружена") { const kg = o.bags * o.bag_kg; await dbUpsert("stock", { id: uid(), date: TODAY(), brand: o.brand, grade: o.grade, weight_kg: -kg, bags: -o.bags, bag_kg: o.bag_kg, note: `Отгрузка: ${o.clientName}` }); }
      }
      await reload("stock"); await reload("orders");
    } catch (e) { notifyErr(e); }
  };
  // Перенести заявку на другую дату (все позиции)
  const rescheduleGroup = async (g, date) => { if (!date) return; try { await Promise.all(g.orders.map(o => dbUpsert("orders", { ...o, date }))); await reload("orders"); } catch (e) { notifyErr(e); } };

  const filtered = orders.filter(o => !filterDate || o.date === filterDate);
  const totalKg = filtered.reduce((s, o) => s + o.bags * o.bag_kg, 0);
  const totalSum = filtered.reduce((s, o) => s + o.bags * o.bag_kg * (o.price_per_kg || 0), 0);
  const sc = { "новая": "blue", "в пути": "yellow", "отгружена": "green", "отменена": "red", "частично": "gray" };
  // Группируем позиции одного клиента (за дату) в одну заявку
  const filteredGroups = (() => {
    const m = {};
    [...filtered].sort((a, b) => a.date.localeCompare(b.date)).forEach(o => {
      const key = (o.clientId || "nm:" + (o.clientName || "")) + "|" + o.date;
      if (!m[key]) m[key] = { key, clientName: o.clientName, isSample: false, isTrial: false, orders: [] };
      m[key].orders.push(o); if (o.isSample) m[key].isSample = true; if (o.trial) m[key].isTrial = true;
    });
    return Object.values(m);
  })();

  return (
    <div className="space-y-5">
      <div className="bg-gradient-to-br from-amber-50 to-orange-50 border border-amber-200 rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-2"><span className="text-amber-600"><Icon name="chat" size={20} /></span><h3 className="font-display font-semibold text-gray-800">Принять заявку из WhatsApp</h3></div>
        <p className="text-sm text-gray-500 mb-3">Вставь сообщение как есть — система разберёт сама</p>
        <textarea className="w-full border border-amber-200 rounded-xl p-3 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-400 resize-none" rows={3}
          placeholder='Например: "Мамыр хотят 10 мешков по 50кг высший ДАРАД на завтра"' value={aiText} onChange={e => setAiText(e.target.value)} />
        {aiError && <p className="text-red-500 text-sm mt-1">{aiError}</p>}
        <div className="flex gap-2 mt-3">
          <Btn onClick={handleAI} disabled={aiLoading}>{aiLoading ? "Разбираю..." : "Разобрать заявку"}</Btn>
          <Btn variant="secondary" onClick={() => setShowManual(true)}>Вручную</Btn>
        </div>
      </div>

      {aiResult && (
        <div className="bg-white border-2 border-emerald-300 rounded-2xl p-5">
          <h4 className="font-bold text-gray-800 mb-3">✅ Проверь и подтверди</h4>
          {aiResult.map((p, i) => (
            <div key={i} className="bg-gray-50 rounded-xl p-4 mb-3 text-sm space-y-1">
              <div className="flex items-center gap-2"><span className="font-semibold">{p.clientFound}</span>{!p.clientId && <Badge color="red">Не в базе</Badge>}{p.trial && <Badge color="yellow">на пробу</Badge>}</div>
              <div className="text-gray-600">{p.brand} · {p.grade} · {p.bag_kg}кг × {p.bags} = {fmt(p.bags * p.bag_kg)} кг</div>
              <div className="text-gray-600">Дата: {p.date} · {p.trial ? <span className="text-orange-600 font-medium">бесплатно (на пробу)</span> : <>Цена: {p.price_per_kg ? fmt(p.price_per_kg) + " тг/кг" : <span className="text-red-500">не найдена</span>}</>}</div>
            </div>
          ))}
          <div className="flex gap-2">
            <Btn onClick={confirmAI} disabled={saving}>{saving ? "Сохраняю..." : "Добавить все"}</Btn>
            <Btn variant="secondary" onClick={() => setAiResult(null)}>Отмена</Btn>
          </div>
        </div>
      )}

      {showManual && (
        <Modal title={form.isSample ? "Пробник" : form.trial ? "На пробу клиенту" : "Новая заявка"} onClose={() => setShowManual(false)}>
          {!form.isSample && (
            <label className="flex items-center gap-2 mb-2 cursor-pointer bg-orange-50 rounded-lg px-3 py-2">
              <input type="checkbox" checked={form.trial} onChange={e => setForm({ ...form, trial: e.target.checked })} className="w-4 h-4 accent-orange-500" />
              <span className="text-sm font-medium text-gray-700 flex items-center gap-1.5"><Icon name="gift" size={16} className="text-orange-500 shrink-0" />На пробу — клиенту из базы (бесплатно, маршрут строится, без накладной)</span>
            </label>
          )}
          {!form.trial && (
            <label className="flex items-center gap-2 mb-3 cursor-pointer bg-amber-50 rounded-lg px-3 py-2">
              <input type="checkbox" checked={form.isSample} onChange={e => setForm({ ...form, isSample: e.target.checked, trial: false })} className="w-4 h-4 accent-amber-500" />
              <span className="text-sm font-medium text-gray-700 flex items-center gap-1.5"><Icon name="flask" size={16} className="text-amber-600 shrink-0" />Проба новой компании — нет в базе (бесплатно или по цене, без маршрута)</span>
            </label>
          )}
          <div className="grid grid-cols-2 gap-3">
            {form.isSample
              ? <div className="col-span-2"><Inp label="Кому (название компании)" value={form.sampleName} onChange={e => setForm({ ...form, sampleName: e.target.value })} placeholder="Кафе Достык" /></div>
              : <div className="col-span-2"><Sel label="Клиент" value={form.clientId} onChange={e => setForm({ ...form, clientId: e.target.value })} options={[{ value: "", label: "— выбери клиента —" }, ...clients.map(c => ({ value: c.id, label: c.name + (c.org_name ? ` (${c.org_name})` : "") }))]} /></div>}
            <Sel label="Бренд" value={form.brand} onChange={e => setForm({ ...form, brand: e.target.value })} options={BRANDS} />
            <Sel label="Сорт" value={form.grade} onChange={e => setForm({ ...form, grade: e.target.value })} options={GRADES} />
            <Sel label="Фасовка" value={form.bag_kg} onChange={e => setForm({ ...form, bag_kg: e.target.value })} options={WEIGHTS.map(w => ({ value: w, label: w + " кг" }))} />
            <Inp label="Мешков" type="number" value={form.bags} onChange={e => setForm({ ...form, bags: e.target.value })} />
            {!form.isSample && !form.trial && <Inp label="Цена тг/кг" type="number" placeholder="авто из базы" value={form.price_per_kg || ""} onChange={e => setForm({ ...form, price_per_kg: e.target.value })} />}
            <Inp label="Дата доставки" type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
            <div className="col-span-2"><Sel label="Водитель" value={form.driverId} onChange={e => setForm({ ...form, driverId: e.target.value })} options={[{ value: "", label: "— назначить позже —" }, ...drivers.map(d => ({ value: d.id, label: d.name }))]} /></div>
          </div>
          <div className="flex gap-2 mt-4">
            <Btn onClick={addManual} disabled={saving}>{saving ? "Сохраняю..." : "Добавить"}</Btn>
            <Btn variant="secondary" onClick={() => setShowManual(false)}>Отмена</Btn>
          </div>
        </Modal>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Inp type="date" value={filterDate} onChange={e => setFilterDate(e.target.value)} />
        <Btn variant="ghost" size="sm" onClick={() => setFilterDate("")}>Все заявки</Btn>
        {filtered.length > 0 && <div className="ml-auto flex gap-4 text-sm text-gray-600"><span className="inline-flex items-center gap-1"><Icon name="box" size={13} />{fmt(totalKg)} кг</span><span className="inline-flex items-center gap-1"><Icon name="coin" size={13} />{fmt(totalSum)} тг</span></div>}
      </div>

      {filtered.length === 0 ? <div className="text-center py-12 text-gray-400">Заявок нет.</div> : (
        <div className="space-y-3">
          {filteredGroups.map(g => {
            const driver = drivers.find(d => d.id === g.orders[0].driverId);
            const statuses = [...new Set(g.orders.map(o => o.status))];
            const gStatus = statuses.length === 1 ? statuses[0] : "частично";
            const gKg = g.orders.reduce((s, o) => s + o.bags * o.bag_kg, 0);
            const gSum = g.orders.reduce((s, o) => s + o.bags * o.bag_kg * (o.price_per_kg || 0), 0);
            const allNew = g.orders.every(o => o.status === "новая");
            const allRoute = g.orders.every(o => o.status === "в пути");
            return (
              <div key={g.key} className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap"><span className="font-bold text-gray-900">{g.clientName || "Клиент"}</span><Badge color={sc[gStatus] || "gray"}>{gStatus}</Badge>{g.isSample && <Badge color="yellow">Проба</Badge>}{g.isTrial && <Badge color="yellow">на пробу</Badge>}</div>
                    <div className="text-sm text-gray-500 mt-1 space-y-0.5">
                      {g.orders.map(o => <div key={o.id} className="flex items-center gap-2 flex-wrap"><span>• {o.brand} · {o.grade}</span><span className="bg-amber-100 text-amber-900 font-semibold px-2 py-0.5 rounded-md whitespace-nowrap inline-flex items-center gap-1"><Icon name="box" size={13} />{o.bags} меш. × {o.bag_kg} кг</span><span>= <b>{fmt(o.bags * o.bag_kg)} кг</b>{o.trial ? " · на пробу" : (o.price_per_kg ? ` · ${fmt(o.bags * o.bag_kg * o.price_per_kg)} тг` : "")}</span></div>)}
                    </div>
                    {g.orders.length > 1 && <div className="text-sm text-gray-500 mt-1">Итого: <b>{fmt(gKg)} кг</b>{gSum ? ` · ${fmt(gSum)} тг` : ""}</div>}
                    <div className="text-xs text-gray-400 mt-1 flex items-center gap-1"><Icon name="calendar" size={12} />{g.orders[0].date}{driver ? ` · ${driver.name}` : ""}{g.orders[0].created_by_name ? ` · ${g.orders[0].created_by_name}` : ""}</div>
                  </div>
                  <div className="flex gap-1 flex-wrap items-center">
                    {allNew && <><Btn size="sm" variant="secondary" onClick={() => setGroupStatus(g, "в пути")}>В путь</Btn><select className="border border-gray-200 rounded-lg px-2 py-1 text-xs" value={g.orders[0].driverId || ""} onChange={e => assignDriverGroup(g, e.target.value)}><option value="">Водитель</option>{drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></>}
                    {allRoute && <Btn size="sm" onClick={() => setGroupStatus(g, "отгружена")}>✓ Доставлено</Btn>}
                    <Btn size="sm" variant="danger" onClick={() => deleteGroup(g)}><Icon name="trash" size={15} /></Btn>
                  </div>
                </div>
                <div className="flex items-center gap-2 mt-2 pt-2 border-t border-gray-50 text-xs text-gray-500">
                  <span className="inline-flex items-center gap-1"><Icon name="calendar" size={13} />Перенести:</span>
                  <input type="date" className="border border-gray-200 rounded-lg px-2 py-1 text-xs" value={g.orders[0].date} onChange={e => rescheduleGroup(g, e.target.value)} />
                  <button className="text-amber-600 hover:text-amber-700 font-medium" onClick={() => rescheduleGroup(g, TOMORROW())}>→ на завтра</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StockTab({ stock, orders = [], trucks = [], expenses = [], reload, canEdit = true }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);
  const [saving, setSaving] = useState(false);
  const blank = { date: TODAY(), brand: BRANDS[0], grade: GRADES[0], bag_kg: 50, bags: "", price_per_kg: "", note: "", op: "in", reason: WRITEOFF_REASONS[0] };
  const [form, setForm] = useState(blank);
  const [audit, setAudit] = useState(null); // сверка по позиции: {brand, grade, bag_kg}
  const [dupCheck, setDupCheck] = useState(false); // отчёт «дубли списаний»
  const [histType, setHistType] = useState("all"); // фильтр истории: all | in | ship | writeoff
  const [histReason, setHistReason] = useState(null); // конкретная причина списания (Брак, Порча…)
  const [histMonth, setHistMonth] = useState("all"); // 'all' | 'YYYY-MM'
  const [histLimit, setHistLimit] = useState(80); // сколько строк показывать (кнопка «ещё»)

  // 🔎 Поиск двойных списаний: по каждой связке «клиент + позиция» сумма списаний (минус возвраты)
  // должна равняться сумме отгруженных заявок. Расхождение > 0 — лишние списания (дубли).
  const dupReport = (() => {
    if (!dupCheck) return null;
    const groups = {};
    orders.filter(o => o.status === "отгружена" && !o.fromKaraganda).forEach(o => {
      const k = `${o.clientName}|${o.brand}|${o.grade}|${o.bag_kg}`;
      const g = groups[k] = groups[k] || { clientName: o.clientName, brand: o.brand, grade: o.grade, bag_kg: o.bag_kg, shipKg: 0, shipCnt: 0, rows: [] };
      g.shipKg += o.bags * o.bag_kg; g.shipCnt++;
    });
    stock.forEach(s => {
      const m = (s.note || "").match(/^(?:Отгрузка|Реализация|Возврат(?: \(отмена отгрузки\))?): (.+)$/);
      if (!m) return;
      const k = `${m[1]}|${s.brand}|${s.grade}|${s.bag_kg}`;
      const g = groups[k] = groups[k] || { clientName: m[1], brand: s.brand, grade: s.grade, bag_kg: s.bag_kg, shipKg: 0, shipCnt: 0, rows: [] };
      g.rows.push(s);
    });
    const out = [];
    Object.values(groups).forEach(g => {
      const movedKg = g.rows.reduce((s2, r) => s2 + (r.weight_kg || 0), 0); // списания со знаком минус, возвраты — плюс
      const diff = -movedKg - g.shipKg; // >0 — списано больше, чем отгружено (дубли); <0 — недосписано
      if (Math.abs(diff) >= 1) out.push({ ...g, diff });
    });
    // Дубли ПРИХОДОВ: два одинаковых прихода одной датой (позиция, вес и примечание совпадают)
    const inMap = {};
    stock.filter(s => s.weight_kg > 0 && !/^Возврат/.test(s.note || "")).forEach(s => {
      const k = `${s.date}|${s.brand}|${s.grade}|${s.bag_kg}|${s.weight_kg}|${s.note || ""}`;
      (inMap[k] = inMap[k] || []).push(s);
    });
    const inDups = Object.values(inMap).filter(g2 => g2.length > 1).sort((a, b) => b[0].weight_kg * b.length - a[0].weight_kg * a.length);
    // 👻 Движения-сироты: привязаны по id к заявке/фуре, которых уже нет (остались от удаления до исправления)
    const orderIds = new Set(orders.map(o => o.id));
    const truckIds = new Set(trucks.map(t => t.id));
    const orphanStock = stock.filter(s => {
      if (typeof s.id !== "string") return false;
      if (s.id.startsWith("mv_")) return !orderIds.has(s.id.slice(3)); // расход удалённой заявки
      if (s.id.startsWith("tin_")) return !truckIds.has(s.id.slice(4).replace(/_\d+$/, "")); // приход удалённой фуры
      return false;
    });
    const orphanExp = expenses.filter(x => typeof x.id === "string" && x.id.startsWith("texp_") && !truckIds.has(x.id.slice(5))); // расход за удалённую фуру
    return { groups: out.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)), inDups, orphanStock, orphanExp };
  })();

  const openNew = () => { setEditId(null); setForm(blank); setShowAdd(true); };
  const openEdit = s => {
    setEditId(s.id);
    setForm({ date: s.date || TODAY(), brand: s.brand, grade: s.grade, bag_kg: s.bag_kg, bags: Math.abs(s.bags), price_per_kg: s.price_per_kg || "", note: s.note || "", op: s.weight_kg < 0 ? "out" : "in", reason: s.reason || WRITEOFF_REASONS[0] });
    setShowAdd(true);
  };

  const saveMovement = async () => {
    setSaving(true);
    const sign = form.op === "out" ? -1 : 1;
    const bag_kg = Number(form.bag_kg);
    const bags = Math.abs(Number(form.bags)) * sign;
    try {
      await dbUpsert("stock", { id: editId || uid(), date: form.date, brand: form.brand, grade: form.grade, bag_kg, bags, weight_kg: bags * bag_kg, price_per_kg: Number(form.price_per_kg) || 0, note: form.note, reason: form.op === "out" ? form.reason : "" });
      setShowAdd(false); await reload("stock");
    } catch (e) { alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз."); }
    setSaving(false);
  };
  const deleteMovement = async id => {
    if (!confirm("Удалить эту запись со склада? Остаток пересчитается.")) return;
    try { await dbDelete("stock", id); await reload("stock"); } catch (e) { alert("⚠️ Не удалилось: " + (e && e.message ? e.message : e)); }
  };
  // Убрать все движения-сироты разом (расходы/приходы от удалённых заявок и фур + расходы за фуры)
  const clearOrphans = async () => {
    const { orphanStock, orphanExp } = dupReport || {};
    const n = (orphanStock?.length || 0) + (orphanExp?.length || 0);
    if (!n || !confirm(`Убрать ${n} движений-сирот от удалённых заявок/фур? Остатки и расходы пересчитаются.`)) return;
    try {
      for (const s of orphanStock) await dbDelete("stock", s.id);
      for (const x of orphanExp) await dbDelete("expenses", x.id);
      await reload("stock"); await reload("expenses");
      alert("✓ Готово — склад и расходы очищены от следов удалённых записей.");
    } catch (e) { alert("⚠️ Не получилось: " + (e && e.message ? e.message : e)); }
  };

  const balances = {};
  stock.forEach(s => {
    const k = `${s.brand}|${s.grade}|${s.bag_kg}`;
    if (!balances[k]) balances[k] = { brand: s.brand, grade: s.grade, bag_kg: s.bag_kg, kg: 0, bags: 0 };
    balances[k].kg += s.weight_kg; balances[k].bags += s.bags;
  });
  // Общий остаток всей муки на складе (честный: минусы не прячем — минус значит «расход есть, прихода нет»)
  const totalKg = Object.values(balances).reduce((s, b) => s + b.kg, 0);
  const totalBags = Object.values(balances).reduce((s, b) => s + b.bags, 0);
  const negatives = Object.values(balances).filter(b => b.kg < 0);
  // Сводка за сегодня — быстрый контроль «что пришло / что ушло»
  const todayIn = stock.filter(s => s.date === TODAY() && s.weight_kg > 0).reduce((sum, s) => sum + s.weight_kg, 0);
  const todayOut = stock.filter(s => s.date === TODAY() && s.weight_kg < 0).reduce((sum, s) => sum + Math.abs(s.weight_kg), 0);

  // Классификация движений для истории и фильтров
  const isShipmentRow = s => s.weight_kg < 0 && (String(s.id).startsWith("mv_") || /^(Отгрузка|Реализация)/.test(s.note || ""));
  const isReturnRow = s => s.weight_kg > 0 && /^Возврат/.test(s.note || "");
  const isWriteoffRow = s => s.weight_kg < 0 && !isShipmentRow(s); // ручное списание: брак/порча/пересортица/прочее
  const RU_MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
  const mKey = s => (s.date || "").slice(0, 7);
  const mLabel = mk => { const [y, m] = mk.split("-"); return `${RU_MONTHS[Number(m) - 1] || m} ${y}`; };
  const monthsPresent = [...new Set(stock.map(mKey).filter(Boolean))].sort().reverse();

  // Сколько мешков «забронировано» заявками, которые ещё НЕ отгружены (новая + в пути).
  // При отгрузке склад списывается автоматически, поэтому здесь только будущий спрос.
  const reserved = {};
  orders.filter(o => (o.status === "новая" || o.status === "в пути") && !o.fromKaraganda).forEach(o => {
    const k = `${o.brand}|${o.grade}|${o.bag_kg}`;
    reserved[k] = (reserved[k] || 0) + Number(o.bags || 0);
  });

  // Нехватка: где спрос больше остатка. Учитываем и позиции, которых вообще нет на складе.
  const shortages = [];
  Object.entries(reserved).forEach(([k, need]) => {
    const have = Math.max(0, balances[k]?.bags || 0);
    if (need > have) {
      const [brand, grade, bag_kg] = k.split("|");
      shortages.push({ brand, grade, bag_kg: Number(bag_kg), need, have, lack: need - have });
    }
  });
  shortages.sort((a, b) => b.lack - a.lack);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between"><h3 className="font-bold text-gray-800">Остатки на складе</h3><div className="flex gap-2">{canEdit && <Btn size="sm" variant="secondary" onClick={() => setDupCheck(true)}>🔎 Дубли</Btn>}{canEdit && <Btn onClick={openNew}>+ Операция</Btn>}</div></div>
      {canEdit && <p className="text-sm text-gray-500">Чтобы внести то, что уже есть на складе — нажми «+ Операция» → «Приход» и укажи текущее число мешков по каждому виду.</p>}
      <div className="bg-gradient-to-br from-amber-500 to-amber-600 rounded-2xl p-5 text-white shadow-sm">
        <div className="text-sm font-medium text-amber-100">🌾 Всего муки на складе</div>
        <div className="text-4xl font-black mt-1">{fmt(totalKg)} кг</div>
        <div className="text-sm text-amber-100 mt-1">≈ {fmt(Math.round(totalKg / 100) / 10)} т · {fmt(totalBags)} мешков · {Object.values(balances).filter(b => b.kg > 0).length} видов</div>
        <div className="text-sm text-amber-100 mt-1.5 border-t border-amber-400 pt-1.5">Сегодня: <b className="text-white">▲ +{fmt(todayIn)} кг</b> приход · <b className="text-white">▼ −{fmt(todayOut)} кг</b> расход</div>
        {(() => {
          const reservedKg = orders.filter(o => (o.status === "новая" || o.status === "в пути") && !o.fromKaraganda).reduce((s, o) => s + o.bags * o.bag_kg, 0);
          return <div className="text-sm text-amber-100 mt-1 flex items-center gap-1.5"><Icon name="clipboard" size={14} />В заявках (бронь): <b className="text-white">{fmt(reservedKg)} кг</b> · свободно: <b className="text-white">{fmt(totalKg - reservedKg)} кг</b></div>;
        })()}
      </div>
      {negatives.length > 0 && (
        <div className="bg-red-100 border border-red-300 rounded-2xl p-4">
          <div className="font-bold text-red-700 mb-1">⛔ Остаток ушёл в минус — приход не внесён</div>
          <div className="space-y-1">
            {negatives.map((b, i) => <div key={i} className="text-sm text-red-700">• <b>{b.brand} {b.grade} {b.bag_kg}кг</b>: {fmt(b.kg)} кг ({fmt(b.bags)} меш.)</div>)}
          </div>
          <div className="text-xs text-red-600 mt-2">Минус значит: отгрузки по этой позиции записаны, а приход — нет. Внеси приход («+ Операция» → Приход) или прими фуру в «Поставках» — остаток выправится.</div>
        </div>
      )}
      {shortages.length > 0 && (
        <div className="bg-red-100 border border-red-300 rounded-2xl p-4">
          <div className="font-bold text-red-700 mb-1">⚠️ Не хватает муки под заявки</div>
          <div className="space-y-1">
            {shortages.map((s, i) => (
              <div key={i} className="text-sm text-red-700">• <b>{s.brand} {s.grade} {s.bag_kg}кг</b> — нужно {s.need} меш., в наличии {s.have} → не хватает <b>{s.lack} меш.</b></div>
            ))}
          </div>
          <div className="text-xs text-red-600 mt-2">Закажи приход (фуру) или перенеси часть заявок на другой день.</div>
        </div>
      )}
      {showAdd && (
        <Modal title={editId ? "Изменить запись" : "Операция со складом"} onClose={() => setShowAdd(false)}>
          <div className="flex gap-2 mb-3">
            <button onClick={() => setForm({ ...form, op: "in" })} className={`flex-1 py-2 rounded-lg text-sm font-medium ${form.op === "in" ? "bg-emerald-500 text-white" : "bg-gray-100 text-gray-600"}`}>▲ Приход (+)</button>
            <button onClick={() => setForm({ ...form, op: "out" })} className={`flex-1 py-2 rounded-lg text-sm font-medium ${form.op === "out" ? "bg-red-500 text-white" : "bg-gray-100 text-gray-600"}`}>▼ Списание (−)</button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Inp label="Дата" type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
            <Sel label="Бренд" value={form.brand} onChange={e => setForm({ ...form, brand: e.target.value })} options={BRANDS} />
            <Sel label="Сорт" value={form.grade} onChange={e => setForm({ ...form, grade: e.target.value })} options={GRADES} />
            <Sel label="Фасовка" value={form.bag_kg} onChange={e => setForm({ ...form, bag_kg: e.target.value })} options={WEIGHTS.map(w => ({ value: w, label: w + " кг" }))} />
            <Inp label="Мешков" type="number" value={form.bags} onChange={e => setForm({ ...form, bags: e.target.value })} />
            {form.op === "in"
              ? <Inp label="Цена закупки тг/кг" type="number" value={form.price_per_kg} onChange={e => setForm({ ...form, price_per_kg: e.target.value })} />
              : <Sel label="Причина" value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} options={WRITEOFF_REASONS} />}
            <div className="col-span-2"><Inp label="Примечание" value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} placeholder={editId ? "" : (form.op === "out" ? "напр. подмок при разгрузке" : "напр. остаток на сегодня")} /></div>
          </div>
          <div className="flex gap-2 mt-4">
            <Btn onClick={saveMovement} disabled={saving || !form.bags}>{saving ? "Сохраняю..." : "Сохранить"}</Btn>
            <Btn variant="secondary" onClick={() => setShowAdd(false)}>Отмена</Btn>
          </div>
        </Modal>
      )}
      <div className="space-y-4">
        {(() => {
          const items = Object.values(balances);
          if (items.length === 0) return <div className="text-center py-12 text-gray-400">Склад пуст.</div>;
          const brandNames = [...new Set(items.map(b => b.brand))].sort((a, b) => (a || "").localeCompare(b || "", "ru"));
          return brandNames.map(brand => {
            const brandRows = items.filter(x => x.brand === brand);
            const brandKg = brandRows.reduce((s, b) => s + b.kg, 0);
            const brandBags = brandRows.reduce((s, b) => s + b.bags, 0);
            const gradeList = [...GRADES, ...new Set(brandRows.map(r => r.grade).filter(g => !GRADES.includes(g)))];
            return (
              <div key={brand} className="bg-white border border-gray-100 rounded-2xl shadow-sm p-4">
                <div className="flex items-end justify-between border-b-2 border-amber-300 pb-1">
                  <span className="text-xl font-black text-gray-900">{brand}</span>
                  <span className="text-sm text-gray-600"><b>{fmt(brandKg)} кг</b> · {fmt(brandBags)} меш.</span>
                </div>
                {gradeList.map(grade => {
                  const rows = brandRows.filter(r => r.grade === grade).sort((a, b) => b.bag_kg - a.bag_kg);
                  if (!rows.length) return null;
                  const gKg = rows.reduce((s, b) => s + b.kg, 0);
                  return (
                    <div key={grade} className="mt-2">
                      <div className="flex items-center justify-between text-sm font-bold text-amber-800">
                        <span>{grade === "Высший сорт" ? "⭐" : "🌾"} {grade}</span>
                        <span className="font-semibold text-gray-500">{fmt(gKg)} кг</span>
                      </div>
                      <div className="grid grid-cols-[3.2rem_1fr_1fr_1.6fr] gap-x-2 text-[11px] text-gray-400 mt-1 px-1">
                        <span>фасовка</span><span className="text-right">мешков</span><span className="text-right">кг</span><span className="text-right">в заявках</span>
                      </div>
                      {rows.map((b, i) => {
                        const have = b.bags; // честный остаток — минус видно сразу
                        const avail = Math.max(0, have);
                        const need = reserved[`${b.brand}|${b.grade}|${b.bag_kg}`] || 0;
                        const short = need > avail;
                        const negative = b.kg < 0;
                        const empty = b.kg <= 0;
                        return (
                          <div key={i} onClick={() => setAudit({ brand: b.brand, grade: b.grade, bag_kg: b.bag_kg })} title="Нажми — покажу все движения по этой позиции" className={`grid grid-cols-[3.2rem_1fr_1fr_1.6fr] gap-x-2 items-center text-sm py-1 px-1 border-b border-gray-50 last:border-b-0 cursor-pointer hover:bg-amber-50 ${short || empty ? "bg-red-50 rounded-lg" : ""}`}>
                            <span className="font-semibold text-gray-900">{b.bag_kg} кг</span>
                            <span className={`text-right font-bold ${empty || short ? "text-red-600" : "text-emerald-600"}`}>{fmt(have)}</span>
                            <span className="text-right text-gray-700">{fmt(b.kg)}</span>
                            <span className={`text-right text-xs ${short || negative ? "text-red-700 font-semibold" : "text-gray-500"}`}>{negative ? "⛔ минус — внеси приход" : need > 0 ? (short ? `${fmt(need * b.bag_kg)} кг (${need} меш.) · не хватает ${fmt((need - avail) * b.bag_kg)} кг` : `${fmt(need * b.bag_kg)} кг (${need} меш.) · своб. ${fmt((avail - need) * b.bag_kg)} кг`) : "—"}</span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            );
          });
        })()}
      </div>
      {dupCheck && dupReport && (
        <Modal title="🔎 Проверка списаний (дубли)" onClose={() => setDupCheck(false)}>
          <div className="text-xs text-gray-500 mb-3">Сверяю склад с заявками и ищу следы удалённых записей. Найденное можно убрать прямо здесь.</div>

          {(dupReport.orphanStock.length > 0 || dupReport.orphanExp.length > 0) && (
            <div className="border border-red-300 bg-red-50 rounded-xl p-3 mb-3">
              <div className="flex items-center justify-between gap-2 mb-1">
                <div className="font-bold text-red-700 text-sm">👻 Следы удалённых заявок/фур</div>
                {canEdit && <Btn size="sm" variant="danger" onClick={clearOrphans}>Убрать все ({dupReport.orphanStock.length + dupReport.orphanExp.length})</Btn>}
              </div>
              <div className="text-xs text-gray-600 mb-2">Эти движения остались от заявок и фур, которые удалили <b>до</b> исправления. Их безопасно убрать — родителей уже нет.</div>
              {dupReport.orphanStock.map((s, i) => (
                <div key={"s" + i} className="flex items-center justify-between gap-2 text-xs bg-white rounded-lg px-2 py-1.5 mb-1">
                  <span className="text-gray-600 min-w-0 truncate">{(s.date || "").split("-").reverse().join(".")} · {s.brand} {s.grade} {s.bag_kg}кг · {s.note || (s.weight_kg > 0 ? "приход" : "расход")}</span>
                  <span className="flex items-center gap-2 whitespace-nowrap"><b className={s.weight_kg > 0 ? "text-emerald-600" : "text-red-600"}>{s.weight_kg > 0 ? "+" : ""}{fmt(s.weight_kg)} кг</b>{canEdit && <button onClick={() => deleteMovement(s.id)} className="text-red-400 hover:text-red-600 font-bold">✕</button>}</span>
                </div>
              ))}
              {dupReport.orphanExp.map((x, i) => (
                <div key={"e" + i} className="flex items-center justify-between gap-2 text-xs bg-white rounded-lg px-2 py-1.5 mb-1">
                  <span className="text-gray-600 min-w-0 truncate">{(x.date || "").split("-").reverse().join(".")} · расход: {x.note || x.category}</span>
                  <span className="flex items-center gap-2 whitespace-nowrap"><b className="text-red-600">{fmt(x.amount)} тг</b>{canEdit && <button onClick={async () => { if (confirm("Убрать этот расход за удалённую фуру?")) { await dbDelete("expenses", x.id); reload("expenses"); } }} className="text-red-400 hover:text-red-600 font-bold">✕</button>}</span>
                </div>
              ))}
            </div>
          )}

          {dupReport.groups.length === 0 && dupReport.inDups.length === 0 && dupReport.orphanStock.length === 0 && dupReport.orphanExp.length === 0 ? (
            <div className="bg-emerald-50 text-emerald-700 rounded-xl p-4 text-center font-bold">✓ Всё сходится — лишних движений не найдено</div>
          ) : dupReport.groups.map((g, gi) => {
            // строки с одинаковой датой и весом внутри группы — вероятные дубли
            const cnt = {};
            g.rows.forEach(r => { const k = `${r.date}|${r.weight_kg}`; cnt[k] = (cnt[k] || 0) + 1; });
            return (
              <div key={gi} className={`border rounded-xl p-3 mb-3 ${g.diff > 0 ? "border-red-300 bg-red-50" : "border-amber-300 bg-amber-50"}`}>
                <div className="font-bold text-gray-900 text-sm">{g.clientName} · {g.brand} {g.grade} {g.bag_kg}кг</div>
                <div className={`text-sm mt-0.5 ${g.diff > 0 ? "text-red-700" : "text-amber-700"}`}>
                  Отгружено по заявкам: <b>{fmt(g.shipKg)} кг</b> ({g.shipCnt} поз.) · списано со склада: <b>{fmt(g.shipKg + g.diff)} кг</b> ({g.rows.filter(r => r.weight_kg < 0).length} строк)
                  → {g.diff > 0 ? `лишние списания ${fmt(g.diff)} кг` : `недосписано ${fmt(-g.diff)} кг`}
                </div>
                <div className="mt-2 space-y-1">
                  {g.rows.sort((a, b) => (b.date || "").localeCompare(a.date || "")).map((r, ri) => {
                    const isDup = cnt[`${r.date}|${r.weight_kg}`] > 1 && r.weight_kg < 0;
                    return (
                      <div key={ri} className={`flex items-center justify-between gap-2 text-xs rounded-lg px-2 py-1.5 ${isDup ? "bg-red-100" : "bg-white"}`}>
                        <span className="text-gray-600">{(r.date || "").split("-").reverse().join(".")} · {r.note}{isDup && <b className="text-red-700"> · возможный дубль</b>}</span>
                        <span className="flex items-center gap-2 whitespace-nowrap">
                          <b className={r.weight_kg < 0 ? "text-red-600" : "text-emerald-600"}>{r.weight_kg > 0 ? "+" : ""}{fmt(r.weight_kg)} кг</b>
                          {canEdit && r.weight_kg < 0 && <button onClick={() => deleteMovement(r.id)} className="text-red-400 hover:text-red-600 font-bold" title="Удалить это списание">✕</button>}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {dupReport.inDups.length > 0 && (
            <>
              <div className="font-bold text-gray-800 text-sm mt-4 mb-1">▲ Приходы, похожие на дубли</div>
              <div className="text-xs text-gray-500 mb-2">Одинаковые приходы одной датой (позиция, вес и примечание совпадают). Если приход на самом деле был один — удали лишний, остаток пересчитается.</div>
              {dupReport.inDups.map((g2, gi) => (
                <div key={gi} className="border border-red-300 bg-red-50 rounded-xl p-3 mb-3">
                  <div className="font-bold text-gray-900 text-sm">{g2[0].brand} {g2[0].grade} {g2[0].bag_kg}кг · {(g2[0].date || "").split("-").reverse().join(".")}</div>
                  <div className="text-sm text-red-700 mt-0.5">{g2.length} одинаковых прихода по <b>+{fmt(g2[0].weight_kg)} кг</b>{g2[0].note ? ` · «${g2[0].note}»` : ""}</div>
                  <div className="mt-2 space-y-1">
                    {g2.map((r, ri) => (
                      <div key={ri} className="flex items-center justify-between gap-2 text-xs bg-white rounded-lg px-2 py-1.5">
                        <span className="text-gray-600">{(r.date || "").split("-").reverse().join(".")} · {r.note || "Приход"}{ri > 0 && <b className="text-red-700"> · возможный дубль</b>}</span>
                        <span className="flex items-center gap-2 whitespace-nowrap">
                          <b className="text-emerald-600">+{fmt(r.weight_kg)} кг</b>
                          {canEdit && <button onClick={() => deleteMovement(r.id)} className="text-red-400 hover:text-red-600 font-bold" title="Удалить этот приход">✕</button>}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}
        </Modal>
      )}

      {audit && (() => {
        const rows = stock
          .filter(s => s.brand === audit.brand && s.grade === audit.grade && String(s.bag_kg) === String(audit.bag_kg))
          .sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.id || "").replace(/^mv_/, "").localeCompare((b.id || "").replace(/^mv_/, "")));
        let run = 0;
        const lines = rows.map(s => { run += s.weight_kg || 0; return { ...s, run }; });
        // Диагностика: где дыра — в приходе или в расходе
        const totalIn = rows.filter(s => s.weight_kg > 0).reduce((a, s) => a + s.weight_kg, 0);
        const outByOrders = rows.filter(s => s.weight_kg < 0 && (String(s.id).startsWith("mv_") || /^(Отгрузка|Реализация)/.test(s.note || ""))).reduce((a, s) => a - s.weight_kg, 0);
        const outManual = rows.filter(s => s.weight_kg < 0 && !(String(s.id).startsWith("mv_") || /^(Отгрузка|Реализация)/.test(s.note || ""))).reduce((a, s) => a - s.weight_kg, 0);
        // Сколько ДОЛЖНО быть списано по реально существующим отгруженным заявкам этой позиции
        const shippedByOrders = orders.filter(o => o.status === "отгружена" && !o.fromKaraganda && o.brand === audit.brand && o.grade === audit.grade && String(o.bag_kg) === String(audit.bag_kg)).reduce((a, o) => a + o.bags * o.bag_kg, 0);
        const outGap = outByOrders - shippedByOrders; // >0 — списано больше, чем есть заявок (лишний расход); <0 — недосписано
        return (
          <Modal title={`🔍 Сверка: ${audit.brand} ${audit.grade} ${audit.bag_kg}кг`} onClose={() => setAudit(null)}>
            <div className="bg-gray-50 rounded-xl p-3 mb-3 text-sm space-y-1">
              <div className="flex justify-between"><span className="text-gray-500">▲ Приходов всего</span><b className="text-emerald-600">+{fmt(totalIn)} кг</b></div>
              <div className="flex justify-between"><span className="text-gray-500">▼ Расход по заявкам</span><b className="text-red-600">−{fmt(outByOrders)} кг</b></div>
              <div className="flex justify-between"><span className="text-gray-500">▼ Расход вручную (брак/списания)</span><b className="text-red-600">−{fmt(outManual)} кг</b></div>
              <div className="flex justify-between border-t border-gray-200 pt-1 mt-1"><span className="font-semibold text-gray-700">Остаток сейчас</span><b className={run < 0 ? "text-red-600" : "text-gray-900"}>{fmt(run)} кг</b></div>
              <div className="flex justify-between text-xs pt-1"><span className="text-gray-400">Отгружено по заявкам (из самих заявок)</span><span className="text-gray-500">{fmt(shippedByOrders)} кг</span></div>
            </div>
            {Math.abs(outGap) >= 1 ? (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-3 text-sm text-amber-800">
                {outGap > 0
                  ? <>▼ Списано <b>на {fmt(outGap)} кг больше</b>, чем отгружено по заявкам — лишний расход. Найди строку списания без своей заявки в списке ниже и убери её.</>
                  : <>▼ Списано <b>на {fmt(-outGap)} кг меньше</b>, чем отгружено — где-то не хватает списания.</>}
              </div>
            ) : (
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 mb-3 text-sm text-emerald-800">
                ✓ Расход сходится с заявками — списано ровно столько, сколько отгружено. Значит, если на складе не хватает, дело в <b>потерянном приходе</b>: его не внесли, внесли на другой сорт/фасовку, или удалили. Проверь <b>⚙️ Доступ → Журнал изменений</b> (удалённый приход можно вернуть) и сверку соседних сортов/фасовок.
              </div>
            )}
            <div className="text-xs text-gray-500 mb-2">Все движения по позиции от первого до последнего. «Остаток» — сколько стало после операции.</div>
            <div className="grid grid-cols-[4rem_1fr_4.2rem_4.2rem] gap-x-2 text-[11px] text-gray-400 px-1 mb-1">
              <span>дата</span><span>операция</span><span className="text-right">кг</span><span className="text-right">остаток</span>
            </div>
            <div className="max-h-96 overflow-y-auto">
              {lines.length === 0 && <div className="text-center text-gray-400 py-6 text-sm">По этой позиции движений нет.</div>}
              {lines.map((s, i) => (
                <div key={i} className="grid grid-cols-[4rem_1fr_4.2rem_4.2rem] gap-x-2 items-center text-xs py-1.5 px-1 border-b border-gray-50 last:border-b-0">
                  <span className="text-gray-500">{(s.date || "").slice(5).split("-").reverse().join(".")}</span>
                  <span className="text-gray-700 truncate">{s.note || s.reason || (s.weight_kg > 0 ? "Приход" : "Расход")}</span>
                  <span className={`text-right font-semibold ${s.weight_kg > 0 ? "text-emerald-600" : "text-red-500"}`}>{s.weight_kg > 0 ? "+" : ""}{fmt(s.weight_kg)}</span>
                  <span className={`text-right font-bold ${s.run < 0 ? "text-red-600" : "text-gray-800"}`}>{fmt(s.run)}</span>
                </div>
              ))}
            </div>
            <div className={`mt-3 rounded-xl p-3 text-sm font-bold ${run < 0 ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`}>Итоговый остаток: {fmt(run)} кг{run < 0 ? " — приход не внесён или внесён на другую позицию" : ""}</div>
          </Modal>
        );
      })()}

      <div>
        <div className="flex items-center justify-between mb-2 gap-2">
          <h4 className="font-semibold text-gray-700">История движений</h4>
          <select value={histMonth} onChange={e => { setHistMonth(e.target.value); setHistLimit(80); }} className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700">
            <option value="all">Все месяцы</option>
            {monthsPresent.map(mk => <option key={mk} value={mk}>{mLabel(mk)}</option>)}
          </select>
        </div>

        {/* Фильтр по типу движения */}
        <div className="flex flex-wrap gap-1.5 mb-2">
          {[["all", "Все"], ["in", "▲ Приход"], ["ship", "Отгрузки"], ["writeoff", "Брак и списания"]].map(([v, l]) => (
            <button key={v} onClick={() => { setHistType(v); setHistReason(null); setHistLimit(80); }}
              className={`px-3 py-1.5 rounded-full text-xs font-medium ${histType === v ? "bg-amber-500 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>{l}</button>
          ))}
        </div>

        {/* Брак и списания — разбивка по причинам за выбранный период */}
        {histType === "writeoff" && (() => {
          const wo = stock.filter(s => isWriteoffRow(s) && (histMonth === "all" || mKey(s) === histMonth));
          const byReason = {};
          wo.forEach(s => { const r = s.reason || "Списание"; const g = byReason[r] = byReason[r] || { kg: 0, bags: 0 }; g.kg += -s.weight_kg; g.bags += -s.bags; });
          const totalKg = wo.reduce((a, s) => a - s.weight_kg, 0);
          const totalBags = wo.reduce((a, s) => a - s.bags, 0);
          const reasons = Object.entries(byReason).sort((a, b) => b[1].kg - a[1].kg);
          return (
            <div className="bg-red-50 border border-red-100 rounded-xl p-3 mb-2">
              <div className="flex items-center justify-between text-sm">
                <span className="font-bold text-red-700">⚠️ Списано {histMonth === "all" ? "за всё время" : "за " + mLabel(histMonth).toLowerCase()}</span>
                <b className="text-red-700">−{fmt(totalKg)} кг · {fmt(totalBags)} меш.</b>
              </div>
              {totalKg === 0
                ? <div className="text-xs text-gray-500 mt-1">За выбранный период списаний нет.</div>
                : <div className="flex flex-wrap gap-1.5 mt-2">
                    <button onClick={() => setHistReason(null)} className={`px-2.5 py-1 rounded-full text-xs ${histReason === null ? "bg-red-500 text-white" : "bg-white text-red-600 border border-red-200"}`}>Все причины</button>
                    {reasons.map(([r, g]) => (
                      <button key={r} onClick={() => setHistReason(r)} className={`px-2.5 py-1 rounded-full text-xs ${histReason === r ? "bg-red-500 text-white" : "bg-white text-red-600 border border-red-200"}`}>{r}: {fmt(g.kg)} кг ({fmt(g.bags)} меш.)</button>
                    ))}
                  </div>}
            </div>
          );
        })()}

        {/* Список движений, сгруппированный по дням */}
        {(() => {
          const match = s => {
            if (histMonth !== "all" && mKey(s) !== histMonth) return false;
            if (histType === "in") return s.weight_kg > 0;
            if (histType === "ship") return isShipmentRow(s);
            if (histType === "writeoff") { if (!isWriteoffRow(s)) return false; if (histReason) return (s.reason || "Списание") === histReason; return true; }
            return true;
          };
          const filtered = [...stock].filter(match).sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.id || "").replace(/^mv_/, "").localeCompare((a.id || "").replace(/^mv_/, "")));
          if (filtered.length === 0) return <div className="text-center py-8 text-gray-400 text-sm">Движений не найдено за выбранный период.</div>;
          const filtKg = filtered.reduce((a, s) => a + (s.weight_kg || 0), 0);
          const shown = filtered.slice(0, histLimit);
          const days = [];
          shown.forEach(s => { const d = s.date || "—"; let g = days[days.length - 1]; if (!g || g.date !== d) { g = { date: d, rows: [] }; days.push(g); } g.rows.push(s); });
          return (
            <>
              <div className="text-xs text-gray-500 mb-2">Найдено {filtered.length} движений · итог по фильтру: <b className={filtKg < 0 ? "text-red-600" : "text-emerald-600"}>{filtKg > 0 ? "+" : ""}{fmt(filtKg)} кг</b></div>
              <div className="space-y-3">
                {days.map(day => {
                  const dayKg = day.rows.reduce((a, s) => a + (s.weight_kg || 0), 0);
                  return (
                    <div key={day.date}>
                      <div className="flex items-center justify-between text-xs font-semibold text-gray-500 bg-gray-50 rounded-lg px-3 py-1.5 mb-1">
                        <span>{day.date === "—" ? "без даты" : day.date.split("-").reverse().join(".")}</span>
                        <span className={dayKg < 0 ? "text-red-500" : "text-emerald-600"}>{dayKg > 0 ? "+" : ""}{fmt(dayKg)} кг</span>
                      </div>
                      <div className="space-y-1.5">
                        {day.rows.map(s => {
                          const ship = isShipmentRow(s);
                          const wo = isWriteoffRow(s);
                          const label = s.weight_kg > 0 ? (isReturnRow(s) ? "↩ Возврат" : "▲ Приход") : ship ? "Отгрузка" : (s.reason || "Списание");
                          const color = s.weight_kg > 0 ? "text-emerald-600" : wo ? "text-red-600" : "text-red-500";
                          return (
                            <div key={s.id} className="flex items-center justify-between bg-white border border-gray-100 rounded-xl px-3 py-2 text-sm">
                              <div className="min-w-0">
                                <span className={`${color} font-medium whitespace-nowrap`}>{label}</span>
                                <span className="text-gray-600 ml-2">{s.brand} {s.grade} {s.bag_kg}кг</span>
                                {s.note && <span className="text-gray-400 ml-2 text-xs">· {s.note}</span>}
                              </div>
                              <div className="flex items-center gap-2 flex-shrink-0">
                                <div className="font-medium whitespace-nowrap">{s.weight_kg > 0 ? "+" : ""}{fmt(s.weight_kg)} кг</div>
                                {canEdit && <button onClick={() => openEdit(s)} className="text-gray-400 hover:text-gray-700" title="Изменить"><Icon name="pencil" size={15} /></button>}
                                {canEdit && <button onClick={() => deleteMovement(s.id)} className="text-red-400 hover:text-red-600" title="Удалить">✕</button>}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
              {filtered.length > shown.length && (
                <div className="text-center mt-3">
                  <Btn size="sm" variant="secondary" onClick={() => setHistLimit(l => l + 120)}>Показать ещё ({filtered.length - shown.length})</Btn>
                </div>
              )}
            </>
          );
        })()}
      </div>
    </div>
  );
}

// 🧪 Лаборатория — журнал анализов муки. Каждая строка — партия с показателями.
// Марка/сорт — свободные поля (анализируем и свою, и чужую муку), с подсказками.
// «🤖 Разобрать анализ» — вставить протокол/сообщение, ИИ заполнит поля (как разбор заявки).
function LabTab({ lab = [], reload, canEdit = true }) {
  const blank = { prod_date: TODAY(), brand: BRANDS[0], grade: GRADES[0], moisture: "", whiteness: "", gluten: "", idk_group: "", idk: "", falling_number: "", extra: "", note: "" };
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  const [showAi, setShowAi] = useState(false);
  const [aiText, setAiText] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState("");
  const [q, setQ] = useState("");

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const openNew = () => { setEditId(null); setForm(blank); setAiErr(""); setAiText(""); setShowAi(false); setShowAdd(true); };
  const openEdit = r => { setEditId(r.id); setForm({ ...blank, ...r }); setAiErr(""); setAiText(""); setShowAi(false); setShowAdd(true); };

  const save = async () => {
    setSaving(true);
    try { await dbUpsert("lab", { id: editId || uid(), ...form }); setShowAdd(false); await reload("lab"); }
    catch (e) { alert("⚠️ Не сохранилось: " + ((e && e.message) || e) + "\nПроверь интернет и попробуй ещё раз."); }
    setSaving(false);
  };
  const del = async id => {
    if (!confirm("Удалить этот анализ?")) return;
    try { await dbDelete("lab", id); await reload("lab"); } catch (e) { alert("⚠️ Не удалилось: " + ((e && e.message) || e)); }
  };

  const runAi = async () => {
    if (!aiText.trim()) return;
    setAiBusy(true); setAiErr("");
    try {
      const r = await parseAnalysisWithAI(aiText);
      const pick = (a, b) => (a === undefined || a === null || a === "") ? b : a;
      const brand = BRANDS.find(x => x.toLowerCase() === String(r.brand || "").toLowerCase()) || pick(r.brand, form.brand);
      const grade = GRADES.find(x => x.toLowerCase() === String(r.grade || "").toLowerCase()) || pick(r.grade, form.grade);
      setForm(f => ({
        ...f, brand, grade,
        prod_date: pick(r.prod_date, f.prod_date),
        moisture: pick(r.moisture, f.moisture),
        whiteness: pick(r.whiteness, f.whiteness),
        gluten: pick(r.gluten, f.gluten),
        idk_group: pick(r.idk_group, f.idk_group),
        idk: pick(r.idk, f.idk),
        falling_number: pick(r.falling_number, f.falling_number),
        extra: pick(r.extra, f.extra),
      }));
      setShowAi(false); setAiText("");
    } catch (e) { setAiErr((e && e.message) || String(e)); }
    setAiBusy(false);
  };

  const rows = [...lab].sort((a, b) => (b.prod_date || "").localeCompare(a.prod_date || "") || String(b.id).localeCompare(String(a.id)));
  const ql = q.trim().toLowerCase();
  const shown = ql ? rows.filter(r => `${r.brand} ${r.grade} ${r.extra} ${r.prod_date}`.toLowerCase().includes(ql)) : rows;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-display font-semibold text-gray-800 flex items-center gap-1.5"><Icon name="flask" size={18} />Лаборатория — анализы муки</h3>
        {canEdit && <Btn onClick={openNew}>+ Анализ</Btn>}
      </div>
      <p className="text-sm text-gray-500">Показатели каждой партии муки. «+ Анализ» — занести вручную или вставить протокол и нажать «Разобрать» — поля заполнятся сами.</p>
      {lab.length > 3 && <Inp placeholder="🔎 Поиск: марка, сорт, дата…" value={q} onChange={e => setQ(e.target.value)} />}

      <div className="bg-white border border-gray-100 rounded-2xl shadow-sm overflow-x-auto">
        {shown.length === 0 ? (
          <div className="text-center py-12 text-gray-400 text-sm">{lab.length === 0 ? "Пока нет анализов. Нажми «+ Анализ»." : "Ничего не найдено."}</div>
        ) : (
          <table className="w-full text-sm" style={{ minWidth: "760px" }}>
            <thead>
              <tr className="text-[11px] text-gray-400 border-b border-gray-100 bg-gray-50/60">
                <th className="text-left font-medium px-3 py-2 whitespace-nowrap">Дата произв.</th>
                <th className="text-left font-medium px-2 py-2">Марка</th>
                <th className="text-left font-medium px-2 py-2">Сорт</th>
                <th className="text-right font-medium px-2 py-2 whitespace-nowrap">Влажн. %</th>
                <th className="text-right font-medium px-2 py-2">Белизна</th>
                <th className="text-right font-medium px-2 py-2 whitespace-nowrap">Клейк. %</th>
                <th className="text-center font-medium px-2 py-2 whitespace-nowrap">Гр. ИДК</th>
                <th className="text-right font-medium px-2 py-2">ИДК</th>
                <th className="text-right font-medium px-2 py-2 whitespace-nowrap">ЧП, с</th>
                <th className="text-left font-medium px-2 py-2">Доп. показатель</th>
                {canEdit && <th className="px-2 py-2"></th>}
              </tr>
            </thead>
            <tbody>
              {shown.map(r => (
                <tr key={r.id} className="border-b border-gray-50 last:border-0 hover:bg-amber-50/50">
                  <td className="px-3 py-2 whitespace-nowrap text-gray-700">{r.prod_date ? r.prod_date.split("-").reverse().join(".") : "—"}</td>
                  <td className="px-2 py-2 whitespace-nowrap font-semibold text-gray-900">{r.brand || "—"}</td>
                  <td className="px-2 py-2 whitespace-nowrap text-gray-700">{r.grade || "—"}</td>
                  <td className="px-2 py-2 text-right text-gray-700">{r.moisture || "—"}</td>
                  <td className="px-2 py-2 text-right text-gray-700">{r.whiteness || "—"}</td>
                  <td className="px-2 py-2 text-right text-gray-700">{r.gluten || "—"}</td>
                  <td className="px-2 py-2 text-center text-gray-700">{r.idk_group || "—"}</td>
                  <td className="px-2 py-2 text-right text-gray-700">{r.idk || "—"}</td>
                  <td className="px-2 py-2 text-right text-gray-700">{r.falling_number || "—"}</td>
                  <td className="px-2 py-2 text-gray-500 text-xs" style={{ maxWidth: "11rem" }}><span className="block truncate" title={r.extra}>{r.extra || "—"}</span></td>
                  {canEdit && (
                    <td className="px-2 py-2 whitespace-nowrap text-right">
                      <button onClick={() => openEdit(r)} className="text-gray-400 hover:text-gray-700 mr-2" title="Изменить"><Icon name="pencil" size={15} /></button>
                      <button onClick={() => del(r.id)} className="text-red-400 hover:text-red-600" title="Удалить">✕</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {shown.length > 0 && <p className="text-xs text-gray-400">Всего анализов: {rows.length}{ql ? ` · найдено: ${shown.length}` : ""}. Таблицу можно листать вбок.</p>}

      {showAdd && (
        <Modal title={editId ? "Изменить анализ" : "Новый анализ муки"} onClose={() => setShowAdd(false)}>
          {!editId && (
            <div className="mb-3">
              {!showAi ? (
                <button onClick={() => setShowAi(true)} className="w-full text-sm bg-violet-50 text-violet-700 border border-violet-200 rounded-xl py-2 font-medium hover:bg-violet-100 inline-flex items-center justify-center gap-1.5"><Icon name="sparkle" size={15} />Разобрать анализ из текста</button>
              ) : (
                <div className="bg-violet-50 border border-violet-200 rounded-xl p-3">
                  <div className="text-xs text-violet-700 font-medium mb-1">Вставь протокол или сообщение с показателями — заполню поля сам</div>
                  <textarea value={aiText} onChange={e => setAiText(e.target.value)} rows={4} placeholder="напр.: ДАРАД в/с, произведено 12.08.2026, влажность 14,2; белизна 54; клейковина 28%; ИДК 75 (II группа); ЧП 320 с" className="w-full border border-violet-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-300" />
                  {aiErr && <div className="text-xs text-red-600 mt-1">⚠️ {aiErr}</div>}
                  <div className="flex gap-2 mt-2">
                    <Btn size="sm" onClick={runAi} disabled={aiBusy || !aiText.trim()}>{aiBusy ? "Разбираю…" : <><Icon name="sparkle" size={15} />Разобрать</>}</Btn>
                    <Btn size="sm" variant="secondary" onClick={() => { setShowAi(false); setAiErr(""); }}>Свернуть</Btn>
                  </div>
                </div>
              )}
            </div>
          )}
          <datalist id="lab-brands">{BRANDS.map(b => <option key={b} value={b} />)}</datalist>
          <datalist id="lab-grades">{GRADES.map(g => <option key={g} value={g} />)}</datalist>
          <div className="grid grid-cols-2 gap-3">
            <Inp label="Дата производства" type="date" value={form.prod_date} onChange={e => set("prod_date", e.target.value)} />
            <Inp label="Марка" list="lab-brands" value={form.brand} onChange={e => set("brand", e.target.value)} placeholder="ДАРАД" />
            <Inp label="Сорт" list="lab-grades" value={form.grade} onChange={e => set("grade", e.target.value)} placeholder="Высший сорт" />
            <Inp label="Влажность, %" inputMode="decimal" value={form.moisture} onChange={e => set("moisture", e.target.value)} placeholder="14.2" />
            <Inp label="Белизна" inputMode="decimal" value={form.whiteness} onChange={e => set("whiteness", e.target.value)} placeholder="54" />
            <Inp label="Клейковина, %" inputMode="decimal" value={form.gluten} onChange={e => set("gluten", e.target.value)} placeholder="28" />
            <Inp label="Группа ИДК" value={form.idk_group} onChange={e => set("idk_group", e.target.value)} placeholder="II" />
            <Inp label="ИДК, ед." inputMode="decimal" value={form.idk} onChange={e => set("idk", e.target.value)} placeholder="75" />
            <Inp label="Число падения (ЧП), с" inputMode="numeric" value={form.falling_number} onChange={e => set("falling_number", e.target.value)} placeholder="320" />
            <div className="col-span-2"><Inp label="Доп. показатель" value={form.extra} onChange={e => set("extra", e.target.value)} placeholder="напр. зольность 0.55%" /></div>
          </div>
          <div className="flex gap-2 mt-4">
            <Btn onClick={save} disabled={saving}>{saving ? "Сохраняю…" : "Сохранить"}</Btn>
            <Btn variant="secondary" onClick={() => setShowAdd(false)}>Отмена</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// 🧮 Ревизия склада — только у Администратора (Альяса). Записываешь, сколько мешков РЕАЛЬНО
// стоит на складе; приложение сравнивает с учётным остатком (таблица stock) и показывает
// недостачу/излишек по каждой позиции. Данные храним в notes id="revision" (без новой таблицы).
function RevisionTab({ stock = [], notes = [], reload, applyLocal = () => {} }) {
  const rev = notes.find(n => n.id === "revision") || { id: "revision", date: TODAY(), items: {} };
  const items = rev.items || {};
  const [form, setForm] = useState({ brand: BRANDS[0], grade: GRADES[0], bag_kg: 50, bags: "" });

  // «прил.» — РЕАЛЬНЫЙ текущий остаток в приложении: сумма ВСЕХ движений склада (включая прошлые
  // поправки ревизии). Показываем ровно то, что сейчас числится на складе.
  const appBal = {};
  stock.forEach(s => { const k = `${s.brand}|${s.grade}|${s.bag_kg}`; appBal[k] = (appBal[k] || 0) + Number(s.bags || 0); });
  const curKey = `${form.brand}|${form.grade}|${form.bag_kg}`;
  const curApp = Math.round(appBal[curKey] || 0);

  // Сохранение ревизии — оптимистично: экран меняется сразу, запись идёт в фоне. Иначе удаление
  // по крестику «подвисало» в ожидании ответа сервера.
  const saveDoc = (newItems, extra = {}) => {
    const doc = { ...rev, id: "revision", items: newItems, date: rev.date || TODAY(), updatedAt: new Date().toISOString(), ...extra };
    applyLocal("notes", ns => [...ns.filter(n => n.id !== "revision"), doc]);
    dbUpsert("notes", doc).catch(e => { alert("⚠️ Не сохранилось: " + ((e && e.message) || e) + "\nПроверь интернет."); reload("notes"); });
  };
  const addPos = () => {
    const n = Number(form.bags);
    if (form.bags === "" || isNaN(n) || n < 0) return;
    saveDoc({ ...items, [curKey]: n });
    setForm(f => ({ ...f, bags: "" }));
  };
  const removePos = k => { const ni = { ...items }; delete ni[k]; saveDoc(ni); };
  const clearAll = () => { if (!confirm("Очистить всю ревизию и начать заново? Записанные цифры удалятся.")) return; saveDoc({}, { date: TODAY() }); };
  const editPos = k => { const [b, g, w] = k.split("|"); setForm({ brand: b, grade: g, bag_kg: Number(w), bags: String(items[k]) }); };

  const rows = Object.keys(items).map(k => {
    const [brand, grade, w] = k.split("|");
    const actual = Number(items[k]) || 0, app = Math.round(appBal[k] || 0);
    return { k, brand, grade, bag_kg: Number(w), actual, app, diff: actual - app };
  }).sort((a, b) => a.brand.localeCompare(b.brand, "ru") || a.grade.localeCompare(b.grade, "ru") || b.bag_kg - a.bag_kg);

  const shortKg = rows.filter(r => r.diff < 0).reduce((s, r) => s + (-r.diff) * r.bag_kg, 0);
  const overKg = rows.filter(r => r.diff > 0).reduce((s, r) => s + r.diff * r.bag_kg, 0);
  const okCnt = rows.filter(r => r.diff === 0).length;

  // Выправить учёт по факту: на каждую расходящуюся позицию — движение на ТЕКУЩУЮ разницу
  // (реально − приложение). Уникальный id: если пересчитать позже, добавится поправка только на
  // остаточную разницу — после применения разница становится 0, задвоения нет.
  const [fixing, setFixing] = useState(false);
  const applyRevision = async () => {
    const bad = rows.filter(r => r.diff !== 0);
    if (!bad.length) return;
    const d = TODAY();
    if (!confirm(`Привести остатки в приложении к тому, что ты насчитал (${bad.length} поз.)?\n\nВ истории склада появятся строки «Ревизия» — их видно и можно отменить.`)) return;
    setFixing(true);
    try {
      for (const r of bad) {
        await dbUpsert("stock", {
          id: uid(), date: d, brand: r.brand, grade: r.grade, bag_kg: r.bag_kg,
          bags: r.diff, weight_kg: r.diff * r.bag_kg,
          reason: r.diff < 0 ? "Ревизия" : "", // reason осмыслен только у списаний
          note: `Ревизия ${d.split("-").reverse().join(".")}: было ${r.app}, по факту ${r.actual} меш.`,
        });
      }
      alert("✓ Готово — остатки в приложении теперь совпадают с тем, что реально на складе.");
    } catch (e) {
      alert("⚠️ Записалось не всё: " + ((e && e.message) || e) + "\nОстаток обновлён — посмотри разницу и при необходимости нажми «Выправить» ещё раз.");
    } finally {
      // ВСЕГДА подтягиваем свежий склад: если запись оборвалась на середине, повторная попытка
      // должна считать разницу от фактически записанного, а не от устаревших данных (иначе задвоение).
      await reload("stock");
      setFixing(false);
    }
  };

  // Позиции, которые ЕСТЬ в приложении, но ещё не посчитаны (5/10 кг не напоминаем — их не считаем)
  const SKIP = new Set([5, 10]);
  const uncounted = Object.keys(appBal).filter(k => !(k in items) && Math.round(appBal[k]) > 0 && !SKIP.has(Number(k.split("|")[2]))).sort((a, b) => a.localeCompare(b, "ru"));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-bold text-gray-800">🧮 Ревизия склада</h3>
        {rows.length > 0 && <Btn size="sm" variant="secondary" onClick={clearAll}>Очистить</Btn>}
      </div>
      <p className="text-sm text-gray-500">Записывай, сколько мешков <b>реально</b> стоит на складе. Приложение само сравнит с учётом и покажет, где недостача, а где излишек. Мешки 5 и 10 кг можно не считать.</p>

      <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-4 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Sel label="Марка" value={form.brand} onChange={e => setForm({ ...form, brand: e.target.value })} options={BRANDS} />
          <Sel label="Сорт" value={form.grade} onChange={e => setForm({ ...form, grade: e.target.value })} options={GRADES} />
          <Sel label="Фасовка" value={form.bag_kg} onChange={e => setForm({ ...form, bag_kg: Number(e.target.value) })} options={WEIGHTS.map(w => ({ value: w, label: w + " кг" }))} />
          <Inp label="Мешков (реально)" type="number" inputMode="numeric" value={form.bags} onChange={e => setForm({ ...form, bags: e.target.value })} placeholder="напр. 40" />
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-gray-500">В приложении: <b className={curApp < 0 ? "text-red-600" : "text-gray-700"}>{curApp} меш.</b>{items[curKey] !== undefined && <span className="text-amber-600"> · записано: {items[curKey]}</span>}</span>
          <Btn onClick={addPos} disabled={form.bags === ""}>{items[curKey] !== undefined ? "Обновить" : "Записать"}</Btn>
        </div>
      </div>

      {rows.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-red-50 border border-red-100 rounded-2xl p-4">
              <div className="text-xs font-medium text-red-600">▼ Недостача (не хватает)</div>
              <div className="text-2xl font-black text-red-700 mt-0.5">{fmt(shortKg)} кг</div>
            </div>
            <div className="bg-blue-50 border border-blue-100 rounded-2xl p-4">
              <div className="text-xs font-medium text-blue-600">▲ Излишек (лишнее)</div>
              <div className="text-2xl font-black text-blue-700 mt-0.5">{fmt(overKg)} кг</div>
            </div>
          </div>

          {rows.some(r => r.diff !== 0) && (
            <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-4">
              <div className="text-sm font-semibold text-gray-800 mb-1">Привести приложение к факту</div>
              <p className="text-xs text-gray-500 mb-2">Остатки в приложении станут такими, как ты насчитал на складе. По каждой позиции появится строка «Ревизия» в истории склада — видно, что и когда выправили, можно отменить.</p>
              <Btn onClick={applyRevision} disabled={fixing || rows.every(r => r.diff === 0)}>
                {fixing ? "Выправляю…" : "✅ Выправить остатки по ревизии"}
              </Btn>
            </div>
          )}

          <div className="bg-white border border-gray-100 rounded-2xl shadow-sm overflow-hidden">
            <div className="grid grid-cols-[1fr_3rem_3.4rem_5.4rem_1.4rem] gap-x-2 text-[11px] text-gray-400 px-3 py-2 border-b border-gray-100 bg-gray-50/60">
              <span>позиция</span><span className="text-right">прил.</span><span className="text-right">реально</span><span className="text-right">разница</span><span></span>
            </div>
            {rows.map(r => (
              <div key={r.k} className="grid grid-cols-[1fr_3rem_3.4rem_5.4rem_1.4rem] gap-x-2 items-center px-3 py-2 border-b border-gray-50 last:border-0 text-sm">
                <span className="min-w-0 cursor-pointer" onClick={() => editPos(r.k)} title="Нажми, чтобы поправить число">
                  <span className="font-semibold text-gray-900">{r.brand}</span> <span className="text-gray-600">{r.grade} {r.bag_kg}кг</span>
                </span>
                <span className="text-right text-gray-500">{r.app}</span>
                <span className="text-right font-semibold text-gray-900">{r.actual}</span>
                <span className="text-right">
                  {r.diff === 0
                    ? <span className="text-emerald-600 text-xs font-medium">✓ сходится</span>
                    : r.diff < 0
                      ? <span className="text-red-600 font-bold text-xs">−{-r.diff} меш.</span>
                      : <span className="text-blue-600 font-bold text-xs">+{r.diff} меш.</span>}
                </span>
                <button onClick={() => removePos(r.k)} className="text-gray-300 hover:text-red-500 text-right" title="Убрать">✕</button>
              </div>
            ))}
            <div className="px-3 py-2 text-[11px] text-gray-400">Нажми на позицию — поправить число. {okCnt > 0 ? `Сходится: ${okCnt}.` : ""} «прил.» — сколько числится в приложении.</div>
          </div>
        </>
      )}

      {uncounted.length > 0 && (
        <div className="bg-amber-50 border border-amber-100 rounded-2xl p-3">
          <div className="text-sm font-semibold text-amber-800 mb-1.5">Ещё не посчитано (числится в приложении)</div>
          <div className="flex flex-wrap gap-1.5">
            {uncounted.map(k => {
              const [b, g, w] = k.split("|");
              return <button key={k} onClick={() => setForm({ brand: b, grade: g, bag_kg: Number(w), bags: "" })} className="px-2.5 py-1 rounded-full text-xs bg-white border border-amber-200 text-amber-700 hover:bg-amber-100">{b} {g} {w}кг · {Math.round(appBal[k])} меш.</button>;
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ClientsTab({ clients, orders = [], payments = [], users = [], notes = [], role = "director", myUid = "", reload, canEdit = true }) {
  const isRep = role === "rep"; // торгпред видит только своих клиентов (сервер уже отфильтровал)
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolveErr, setResolveErr] = useState("");
  const [historyClient, setHistoryClient] = useState(null);
  const [showPayForm, setShowPayForm] = useState(false); // «клиент закинул сумму» — ручная оплата в счёт долга
  const [payForm, setPayForm] = useState({ amount: "", method: "Наличные", date: TODAY(), note: "" });
  const [savingPay, setSavingPay] = useState(false);
  const [histPeriod, setHistPeriod] = useState("all");
  const [histFrom, setHistFrom] = useState(TODAY());
  const [histTo, setHistTo] = useState(TODAY());
  const [search, setSearch] = useState("");
  const [staleOnly, setStaleOnly] = useState(false);
  const [showRestore, setShowRestore] = useState(false);
  const [form, setForm] = useState({ name: "", address: "", contact: "", prices: [] });

  // Пересобираем цены из заявок: последняя цена по каждой связке бренд|сорт|фасовка
  const pricesFromOrders = list => {
    const prices = [], seen = {};
    [...list].sort((a, b) => (b.date || "").localeCompare(a.date || "")).forEach(o => {
      const k = `${o.brand}|${o.grade}|${o.bag_kg}`;
      if (!seen[k] && !o.trial && (o.price_per_kg || 0) > 0) { seen[k] = true; prices.push({ brand: o.brand, grade: o.grade, bag_kg: Number(o.bag_kg), price_per_kg: Number(o.price_per_kg) }); }
    });
    return prices;
  };
  const freqOf = (list, key, num) => { const c = {}; list.forEach(o => { const v = o[key]; if (v) c[v] = (c[v] || 0) + 1; }); const top = Object.entries(c).sort((a, b) => b[1] - a[1])[0]; return top ? (num ? Number(top[0]) : top[0]) : ""; };

  // Что можно восстановить:
  // 1) orphans — заявки привязаны к ID, но карточки в базе нет (клиента удалили)
  // 2) unlinked — заявки записаны только по имени, без привязки к карточке
  //    (так бывает, когда разбор из WhatsApp не узнал клиента, либо карточку удалили давно)
  const { orphans, unlinked } = (() => {
    const ids = new Set(clients.map(c => c.id));
    const byId = {}, byName = {};
    orders.forEach(o => {
      if (o.clientId) {
        if (ids.has(o.clientId)) return;
        const g = byId[o.clientId] = byId[o.clientId] || { id: o.clientId, name: o.clientName || "?", orders: [], lastDate: "" };
        g.orders.push(o); if ((o.date || "") > g.lastDate) g.lastDate = o.date;
      } else {
        // Заявки без карточки: разовые продажи, самовывоз, пробники, неузнанные разбором — всё сюда
        const nm = (o.clientName || "").trim();
        if (!nm) return;
        const key = nm.toLowerCase();
        const g = byName[key] = byName[key] || { name: nm, orders: [], lastDate: "", kinds: new Set() };
        g.orders.push(o);
        if (o.oneOff) g.kinds.add("разовая продажа");
        if (o.pickup) g.kinds.add("самовывоз");
        if (o.isSample) g.kinds.add("проба");
        if ((o.date || "") > g.lastDate) g.lastDate = o.date;
      }
    });
    const byDate = (a, b) => (b.lastDate || "").localeCompare(a.lastDate || "");
    return { orphans: Object.values(byId).sort(byDate), unlinked: Object.values(byName).sort(byDate) };
  })();

  const restoreClient = async g => {
    if (!confirm(`Восстановить клиента «${g.name}»? Вернутся имя, цены и вся история заявок/долгов. Реквизиты (БИН, адрес, банк) нужно будет вписать заново.`)) return;
    const prices = pricesFromOrders(g.orders);
    try {
      // ВАЖНО: тот же id — чтобы вся история (заявки, долги) снова подцепилась к карточке
      await dbUpsert("clients", { id: g.id, name: g.name, org_name: "", contact_name: "", address: "", contact: "", default_brand: freqOf(g.orders, "brand"), default_bag_kg: freqOf(g.orders, "bag_kg", true), prices });
      await reload("clients");
      setShowRestore(false);
      alert(`✓ «${g.name}» восстановлен — имя, цены (${prices.length}) и вся история на месте. Открой карточку (✏️) и допиши реквизиты: БИН, адрес, банк, телефон.`);
    } catch (e) { alert("⚠️ Не восстановилось: " + (e && e.message ? e.message : e)); }
  };

  // Заявки только по имени: создаём карточку (или привязываем к существующей) и подшиваем к ней историю
  const linkUnlinked = async g => {
    const exist = clients.find(c => (c.name || "").toLowerCase().trim() === g.name.toLowerCase().trim());
    const msg = exist
      ? `Привязать ${g.orders.length} заявок к существующему клиенту «${exist.name}»? Его история и долги пополнятся этими заявками.`
      : `Создать клиента «${g.name}» из его ${g.orders.length} заявок? Подставим цены из истории, заявки привяжутся к карточке. Реквизиты впишешь потом.`;
    if (!confirm(msg)) return;
    try {
      let id = exist?.id;
      if (!exist) {
        id = uid();
        // если это были разовые продажи с доставкой — подтянем адрес и точку 2ГИС из заявки
        const withAddr = g.orders.find(o => o.oneOffAddress || o.gis_link || o.coords) || {};
        await dbUpsert("clients", { id, name: g.name, org_name: "", contact_name: "", address: withAddr.oneOffAddress || "", contact: "", gis_link: withAddr.gis_link || "", coords: withAddr.coords || null, default_brand: freqOf(g.orders, "brand"), default_bag_kg: freqOf(g.orders, "bag_kg", true), prices: pricesFromOrders(g.orders) });
      }
      await Promise.all(g.orders.map(o => dbUpsert("orders", { ...o, clientId: id })));
      await reload("clients"); await reload("orders");
      setShowRestore(false);
      alert(`✓ Готово: «${g.name}» ${exist ? "получил" : "создан и получил"} ${g.orders.length} заявок из истории. Допиши реквизиты в карточке (✏️).`);
    } catch (e) { alert("⚠️ Не получилось: " + (e && e.message ? e.message : e)); }
  };
  const [pf, setPf] = useState({ brand: BRANDS[0], grade: GRADES[0], bag_kg: 50, price_per_kg: "" });
  const [clientText, setClientText] = useState("");
  const [parsingClient, setParsingClient] = useState(false);
  const [clientParseErr, setClientParseErr] = useState("");

  const handleParseClient = async () => {
    if (!clientText.trim()) return;
    setParsingClient(true); setClientParseErr("");
    try {
      const d = await parseClientWithAI(clientText);
      setForm(f => ({ ...f, name: d.name || f.name, org_name: d.org_name || f.org_name, bin: d.bin || f.bin, director: d.director || f.director, basis: d.basis || f.basis, contact_name: d.contact_name || f.contact_name, contact: d.contact || f.contact, email: d.email || f.email, address: d.address || f.address, legal_address: d.legal_address || f.legal_address, bank: d.bank || f.bank, iik: d.iik || f.iik, bik: d.bik || f.bik }));
    } catch (e) { setClientParseErr(e.message); }
    setParsingClient(false);
  };

  // Долг клиента = отгружено и не оплачено
  // Ручные оплаты клиента «в счёт долга» — уменьшают его долг
  const paidManual = cid => (payments || []).filter(p => p.clientId === cid).reduce((s, p) => s + (p.amount || 0), 0);
  const clientDebt = c => orders.filter(o => o.clientId === c.id && o.status === "отгружена" && !o.paid).reduce((s, o) => s + o.bags * o.bag_kg * (o.price_per_kg || 0), 0) - paidManual(c.id);
  // Клиент закинул произвольную сумму в счёт общего долга — записываем в payments
  const savePayment = async () => {
    if (!historyClient || !payForm.amount || Number(payForm.amount) <= 0) return;
    setSavingPay(true);
    try {
      await dbUpsert("payments", { id: uid(), clientId: historyClient.id, clientName: historyClient.name, date: payForm.date, amount: Number(payForm.amount), method: payForm.method, note: payForm.note.trim() });
      setShowPayForm(false); setPayForm({ amount: "", method: "Наличные", date: TODAY(), note: "" }); await reload("payments");
    } catch (e) { const m = String((e && e.message) || e); alert(/payments|PGRST205/i.test(m) ? "Нужно один раз создать таблицу «payments» в Supabase." : "⚠️ Не сохранилось: " + m); }
    finally { setSavingPay(false); }
  };
  const delPayment = async id => { if (!confirm("Удалить эту оплату? Долг клиента вырастет обратно.")) return; try { await dbDelete("payments", id); await reload("payments"); } catch (e) { alert("⚠️ " + ((e && e.message) || e)); } };
  // Отметить поставку (все позиции за дату) оплаченной — с указанием способа (нал/безнал)
  const markPaid = async (clientId, date, paid, method = "") => {
    try {
      await Promise.all(orders.filter(o => o.clientId === clientId && o.date === date).map(o => dbUpsert("orders", { ...o, paid, pay_method: paid ? method : "" })));
      await reload("orders");
    } catch (e) { alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз."); }
  };

  const openEdit = c => { setEditId(c.id); setResolveErr(""); setClientText(""); setClientParseErr(""); setForm({ name: c.name, org_name: c.org_name || "", contact_name: c.contact_name || "", address: c.address, contact: c.contact || "", bin: c.bin || "", director: c.director || "", basis: c.basis || "", legal_address: c.legal_address || "", email: c.email || "", bank: c.bank || "", iik: c.iik || "", bik: c.bik || "", default_bag_kg: c.default_bag_kg || "", default_brand: c.default_brand || "", gis_link: c.gis_link || "", coords: c.coords || null, coords_manual: c.coords_manual || "", delivery_time: c.delivery_time || "", delivery_from: c.delivery_from || "", delivery_to: c.delivery_to || "", access_note: c.access_note || "", work_hours: c.work_hours || "", prices: c.prices || [], ownerId: c.ownerId || "" }); setShowAdd(true); };
  const openNew = () => { setEditId(null); setResolveErr(""); setClientText(""); setClientParseErr(""); setForm({ name: "", org_name: "", contact_name: "", address: "", contact: "", bin: "", director: "", basis: "", legal_address: "", email: "", bank: "", iik: "", bik: "", default_bag_kg: "", default_brand: "", gis_link: "", coords: null, coords_manual: "", delivery_time: "", delivery_from: "", delivery_to: "", access_note: "", work_hours: "", prices: [], ownerId: isRep ? myUid : "" }); setShowAdd(true); };

  const handleResolve = async () => {
    setResolving(true); setResolveErr("");
    try {
      // сперва пробуем вытащить прямо из ссылки, иначе спрашиваем сервер
      const direct = parseCoordsFromGisLink(form.gis_link) || parseCoordsFromText(form.coords_manual);
      const coords = direct || await resolveGisCoords(form.gis_link);
      setForm(f => ({ ...f, coords }));
    } catch (e) { setResolveErr(e.message); }
    setResolving(false);
  };
  const addPrice = () => {
    const p = { ...pf, bag_kg: Number(pf.bag_kg), price_per_kg: Number(pf.price_per_kg) };
    setForm({ ...form, prices: [...form.prices.filter(x => !(x.brand === p.brand && x.grade === p.grade && x.bag_kg === p.bag_kg)), p] });
    setPf({ brand: BRANDS[0], grade: GRADES[0], bag_kg: 50, price_per_kg: "" });
  };
  const saveClient = async () => {
    setSaving(true);
    // ownerId: торгпреду сервер всё равно проставит своего; админ выбирает группу (пусто = наши)
    const ownerId = isRep ? myUid : (form.ownerId || "");
    try { await dbUpsert("clients", { id: editId || uid(), ...form, ownerId }); setShowAdd(false); await reload("clients"); } catch (e) { alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз."); }
    setSaving(false);
  };
  // Группы клиентов: «Наши» (ownerId пусто) + группа каждого торгпреда. Названия можно переименовать.
  const repUsers = (users || []).filter(u => u.role === "rep");
  const houseName = ((notes || []).find(n => n.id === "clientgroups") || {}).houseName || "Наши клиенты";
  const renameGroup = async g => {
    const cur = g.key === "" ? houseName : ((repUsers.find(u => u.id === g.key) || {}).group_name || (repUsers.find(u => u.id === g.key) || {}).name || "");
    const name = prompt("Название группы:", cur);
    if (name == null || !name.trim()) return;
    try {
      if (g.key === "") { const ex = (notes || []).find(n => n.id === "clientgroups") || { id: "clientgroups" }; await dbUpsert("notes", { ...ex, id: "clientgroups", houseName: name.trim() }); await reload("notes"); }
      else { const u = repUsers.find(x => x.id === g.key); if (u) { await dbUpsert("users", { ...u, group_name: name.trim() }); await reload("users"); } }
    } catch (e) { alert("⚠️ " + ((e && e.message) || e)); }
  };
  const deleteClient = async id => {
    const c = clients.find(x => x.id === id);
    if (!confirm(`Удалить клиента «${c?.name || "?"}»? Карточка с ценами и реквизитами удалится (история заявок останется).`)) return;
    await dbDelete("clients", id); await reload("clients");
  };
  // Персональная заказ-ссылка: клиент открывает её и сам отправляет заявку — она падает к нам со статусом «новая»
  const copyOrderLink = async c => {
    try {
      const d = await apiData("orderLink", null, { clientId: c.id });
      const link = `${location.origin}/order.html?c=${c.id}&k=${d.sig}`;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(link);
        alert(`✓ Ссылка скопирована — отправь клиенту «${c.name}» в WhatsApp.\nОн сам выберет позиции из своего прайса, и заявка придёт к нам как «новая».`);
      } else window.prompt("Скопируй ссылку для клиента:", link);
    } catch (e) { alert("⚠️ " + (e.message || e)); }
  };

  // Дата последнего заказа по каждому клиенту (любая продажа, включая Караганду)
  const STALE_DAYS = 14;
  const lastByClient = {};
  orders.forEach(o => { if (!o.clientId) return; if (!lastByClient[o.clientId] || o.date > lastByClient[o.clientId]) lastByClient[o.clientId] = o.date; });
  const daysSince = d => d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : null;
  const isStale = c => { const days = daysSince(lastByClient[c.id]); return days !== null && days >= STALE_DAYS; }; // заказывал, но давно

  const q = search.trim().toLowerCase();
  let shown = clients.filter(c => !q || [c.name, c.org_name, c.contact_name, c.contact].some(v => (v || "").toLowerCase().includes(q)));
  if (staleOnly) shown = shown.filter(isStale);
  shown = shown.sort((a, b) => staleOnly ? (lastByClient[a.id] || "").localeCompare(lastByClient[b.id] || "") : (a.name || "").localeCompare(b.name || ""));
  const staleCount = clients.filter(isStale).length;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-2 flex-wrap"><h3 className="font-bold text-gray-800">Клиенты ({clients.length})</h3><div className="flex gap-2">{canEdit && <Btn size="sm" variant="secondary" onClick={() => setShowRestore(true)}>↩️ Восстановить{orphans.length + unlinked.length > 0 ? ` (${orphans.length + unlinked.length})` : ""}</Btn>}{canEdit && <Btn onClick={openNew}>+ Новый клиент</Btn>}</div></div>
      {showRestore && (
        <Modal title="↩️ Восстановить удалённого клиента" onClose={() => setShowRestore(false)}>
          <div className="text-xs text-gray-500 mb-3">Восстановление вернёт имя, цены и всю историю (заявки, долги). Реквизиты (БИН, адрес, банк) нужно вписать заново.</div>

          {orphans.length > 0 && (
            <>
              <div className="font-bold text-gray-800 text-sm mb-1">Удалённые клиенты</div>
              {orphans.map(g => (
                <div key={g.id} className="flex items-center justify-between gap-2 border border-gray-100 rounded-xl p-3 mb-2">
                  <div className="min-w-0">
                    <div className="font-bold text-gray-900 truncate">{g.name}</div>
                    <div className="text-xs text-gray-500">{g.orders.length} заявок · последняя {g.lastDate ? g.lastDate.split("-").reverse().join(".") : "—"}</div>
                  </div>
                  <Btn size="sm" onClick={() => restoreClient(g)}>Восстановить</Btn>
                </div>
              ))}
            </>
          )}

          {unlinked.length > 0 && (
            <>
              <div className="font-bold text-gray-800 text-sm mb-1 mt-3">Заявки без карточки клиента</div>
              <div className="text-xs text-gray-500 mb-2">Записаны только по имени: разовые продажи, самовывоз, пробы или заявки, где разбор не узнал клиента. Создадим карточку из этих заявок (или привяжем к существующей с таким же именем).</div>
              {unlinked.map((g, i) => {
                const exist = clients.find(c => (c.name || "").toLowerCase().trim() === g.name.toLowerCase().trim());
                const kinds = [...(g.kinds || [])].join(", ");
                return (
                  <div key={i} className="flex items-center justify-between gap-2 border border-gray-100 rounded-xl p-3 mb-2">
                    <div className="min-w-0">
                      <div className="font-bold text-gray-900 truncate">{g.name}</div>
                      <div className="text-xs text-gray-500">{g.orders.length} заявок · последняя {g.lastDate ? g.lastDate.split("-").reverse().join(".") : "—"}{kinds ? ` · ${kinds}` : ""}{exist ? " · есть карточка с таким именем" : ""}</div>
                    </div>
                    <Btn size="sm" onClick={() => linkUnlinked(g)}>{exist ? "Привязать" : "Создать"}</Btn>
                  </div>
                );
              })}
            </>
          )}

          {orphans.length === 0 && unlinked.length === 0 && (
            <div className="text-sm text-gray-500 py-4 space-y-2">
              <div className="font-medium text-gray-700">Восстанавливать нечего.</div>
              <div>Все заявки привязаны к существующим карточкам — значит у удалённого клиента <b>не было ни одной заявки</b>. Заведи его заново через «+ Новый клиент».</div>
              <div className="text-xs text-gray-400 pt-1">Всего заявок: {orders.length} · с привязкой: {orders.filter(o => o.clientId).length} · без привязки: {orders.filter(o => !o.clientId).length}</div>
            </div>
          )}
        </Modal>
      )}
      <div className="space-y-2">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 Поиск по имени, организации, телефону" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300" />
        {staleCount > 0 && (
          <button onClick={() => setStaleOnly(v => !v)} className={`text-xs font-medium px-3 py-1.5 rounded-full ${staleOnly ? "bg-orange-500 text-white" : "bg-orange-50 text-orange-700"}`}>⏳ Давно не заказывали ({staleCount}){staleOnly ? " ✕" : ""}</button>
        )}
      </div>
      {showAdd && (
        <Modal title={editId ? "Редактировать" : "Новый клиент"} onClose={() => setShowAdd(false)}>
          <div className="space-y-3">
            <div className="bg-amber-50 border border-amber-100 rounded-xl p-3">
              <div className="text-sm font-medium text-gray-700 mb-1 flex items-center gap-1.5"><Icon name="clipboard" size={15} />Вставь все данные — разберу по полям</div>
              <textarea value={clientText} onChange={e => setClientText(e.target.value)} rows={3} placeholder="напр.: ИП Салават, БИН 880101300123, тел +7 701 234 5678, адрес Астана, ул. Абая 10, Kaspi Bank, ИИК KZ12..., БИК CASPKZKA" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-amber-300" />
              {clientParseErr && <div className="text-xs text-red-500 mt-1">{clientParseErr}</div>}
              <button onClick={handleParseClient} disabled={parsingClient || !clientText.trim()} className="mt-2 w-full bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded-lg font-medium px-4 py-2 text-sm">{parsingClient ? "Разбираю..." : "✨ Разобрать и заполнить"}</button>
            </div>
            <Inp label="Название заведения" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Мамыр" />
            {!isRep && repUsers.length > 0 && <Sel label="Группа клиента" value={form.ownerId || ""} onChange={e => setForm({ ...form, ownerId: e.target.value })} options={[{ value: "", label: houseName }, ...repUsers.map(u => ({ value: u.id, label: u.group_name || u.name }))]} />}
            <Inp label="Организация (ИП / ТОО)" value={form.org_name} onChange={e => setForm({ ...form, org_name: e.target.value })} placeholder="ИП Салават" />
            <Inp label="Имя контакта (кто пишет)" value={form.contact_name} onChange={e => setForm({ ...form, contact_name: e.target.value })} placeholder="Азиз" />
            <Inp label="Адрес доставки" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} />
            <div>
              <div className="text-sm font-medium text-gray-700 mb-1 flex items-center gap-1.5"><Icon name="door" size={15} />Как пройти / ориентиры</div>
              <textarea rows={2} value={form.access_note || ""} onChange={e => setForm({ ...form, access_note: e.target.value })} placeholder="напр. от шлагбаума направо, вход в здание, 2 этаж, дверь справа" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300" />
              <div className="text-xs text-gray-400 mt-0.5">Покажется водителю в каждой заявке этого клиента — писать каждый раз не нужно.</div>
            </div>
            <Inp label="WhatsApp / телефон" value={form.contact} onChange={e => setForm({ ...form, contact: e.target.value })} />
            <div className="border-t border-gray-100 pt-3">
              <p className="text-sm font-medium text-gray-700 mb-2">Реквизиты (для договоров)</p>
              <div className="space-y-3">
                <Inp label="БИН / ИИН" value={form.bin || ""} onChange={e => setForm({ ...form, bin: e.target.value })} placeholder="12 цифр" />
                <Inp label="Директор / в лице" value={form.director || ""} onChange={e => setForm({ ...form, director: e.target.value })} placeholder="Салават Б." />
                <Inp label="Действует на основании (для договора)" value={form.basis || ""} onChange={e => setForm({ ...form, basis: e.target.value })} placeholder="Устава / Свидетельства — пусто, если неизвестно" />
                <Inp label="Юридический адрес" value={form.legal_address || ""} onChange={e => setForm({ ...form, legal_address: e.target.value })} />
                <Inp label="Email" value={form.email || ""} onChange={e => setForm({ ...form, email: e.target.value })} />
                <Inp label="Банк" value={form.bank || ""} onChange={e => setForm({ ...form, bank: e.target.value })} placeholder="Kaspi Bank" />
                <div className="grid grid-cols-2 gap-3">
                  <Inp label="ИИК (счёт)" value={form.iik || ""} onChange={e => setForm({ ...form, iik: e.target.value })} placeholder="KZ..." />
                  <Inp label="БИК" value={form.bik || ""} onChange={e => setForm({ ...form, bik: e.target.value })} />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Sel label="Фасовка по умолчанию" value={form.default_bag_kg} onChange={e => setForm({ ...form, default_bag_kg: Number(e.target.value) })} options={[{ value: "", label: "— не указана —" }, ...WEIGHTS.map(w => ({ value: w, label: w + " кг" }))]} />
              <Sel label="Бренд по умолчанию" value={form.default_brand} onChange={e => setForm({ ...form, default_brand: e.target.value })} options={[{ value: "", label: "— не указан —" }, ...BRANDS.map(b => ({ value: b, label: b }))]} />
            </div>
            <Sel label="Время доставки (общее)" value={form.delivery_time} onChange={e => setForm({ ...form, delivery_time: e.target.value })} options={[{ value: "", label: "— не указано —" }, ...DELIVERY_TIMES.map(t => ({ value: t, label: t }))]} />
            <div>
              <label className="text-sm font-medium text-gray-700">Или точное время (с — по)</label>
              <div className="flex items-center gap-2 mt-1">
                <input type="time" className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400" value={form.delivery_from} onChange={e => setForm({ ...form, delivery_from: e.target.value })} />
                <span className="text-gray-500">—</span>
                <input type="time" className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400" value={form.delivery_to} onChange={e => setForm({ ...form, delivery_to: e.target.value })} />
              </div>
              <p className="text-xs text-gray-400 mt-1">Если заполнишь — будет показываться как «08:00–10:00» вместо общего.</p>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700">Время работы клиента</label>
              <div className="flex items-center gap-2 mt-1">
                <input type="text" value={form.work_hours || ""} onChange={e => setForm({ ...form, work_hours: e.target.value })} placeholder="напр. 9:00–18:00" className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400" />
                <button type="button" onClick={() => setForm({ ...form, work_hours: form.work_hours === "24/7" ? "" : "24/7" })} className={`px-3 py-2 rounded-lg text-sm font-semibold whitespace-nowrap ${form.work_hours === "24/7" ? "bg-amber-500 text-white" : "bg-gray-100 text-gray-600"}`}>24/7</button>
              </div>
              <p className="text-xs text-gray-400 mt-1">Когда клиент открыт. Нажми «24/7», если круглосуточно.</p>
            </div>
            <div>
              <Inp label="Ссылка 2ГИС на адрес" value={form.gis_link} onChange={e => setForm({ ...form, gis_link: e.target.value, coords: null })} placeholder="https://2gis.kz/astana/geo/..." />
              <div className="flex items-center gap-2 mt-2">
                <Btn size="sm" variant="secondary" onClick={handleResolve} disabled={resolving || !form.gis_link}>{resolving ? "Определяю..." : "Определить координаты"}</Btn>
                {form.coords && <span className="text-xs text-emerald-600">✓ {form.coords.lat.toFixed(5)}, {form.coords.lon.toFixed(5)}</span>}
              </div>
              {resolveErr && <p className="text-xs text-red-500 mt-1">{resolveErr}. Введи координаты вручную ниже.</p>}
              {resolveErr && (
                <Inp label="Координаты вручную (широта, долгота)" value={form.coords_manual} onChange={e => setForm({ ...form, coords_manual: e.target.value, coords: parseCoordsFromText(e.target.value) })} placeholder="51.1234, 71.4567" />
              )}
            </div>
            <div>
              <p className="text-sm font-medium text-gray-700 mb-2">Цены по сортам и фасовкам</p>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <Sel value={pf.brand} onChange={e => setPf({ ...pf, brand: e.target.value })} options={BRANDS} />
                <Sel value={pf.grade} onChange={e => setPf({ ...pf, grade: e.target.value })} options={GRADES} />
                <Sel value={pf.bag_kg} onChange={e => setPf({ ...pf, bag_kg: e.target.value })} options={WEIGHTS.map(w => ({ value: w, label: w + " кг" }))} />
                <Inp type="number" placeholder="тг/кг" value={pf.price_per_kg} onChange={e => setPf({ ...pf, price_per_kg: e.target.value })} />
              </div>
              <Btn size="sm" variant="secondary" onClick={addPrice}>+ Добавить цену</Btn>
              {form.prices.length > 0 && <div className="mt-2 space-y-1">{form.prices.map((p, i) => <div key={i} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 text-sm"><span>{p.brand} · {p.grade} · {p.bag_kg}кг</span><span className="font-medium">{fmt(p.price_per_kg)} тг/кг</span><button className="text-red-400 hover:text-red-600" onClick={() => setForm({ ...form, prices: form.prices.filter((_, j) => j !== i) })}>✕</button></div>)}</div>}
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <Btn onClick={saveClient} disabled={saving}>{saving ? "Сохраняю..." : "Сохранить"}</Btn>
            <Btn variant="secondary" onClick={() => setShowAdd(false)}>Отмена</Btn>
          </div>
        </Modal>
      )}
      <div className="space-y-3">
        {clients.length === 0 && <div className="text-center py-12 text-gray-400">Клиентов нет.</div>}
        {clients.length > 0 && shown.length === 0 && <div className="text-center py-12 text-gray-400">Ничего не найдено.</div>}
        {(() => {
          const card = c => {
            const debt = clientDebt(c);
            const last = lastByClient[c.id];
            const days = daysSince(last);
            const stale = days !== null && days >= STALE_DAYS;
            return (
            <div key={c.id} className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm">
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-bold text-gray-900">{c.name}{debt > 0 && <span className="ml-2 text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full align-middle">долг {fmt(debt)} тг</span>}{stale && <span className="ml-2 text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full align-middle">⏳ давно</span>}</div>
                  {c.org_name && <div className="text-sm text-gray-500 flex items-center gap-1.5"><Icon name="building" size={13} />{c.org_name}</div>}
                  {c.contact_name && <div className="text-sm text-gray-500 flex items-center gap-1.5"><Icon name="user" size={13} />{c.contact_name}</div>}
                  {c.address && <div className="text-sm text-gray-500 flex items-center gap-1.5"><Icon name="pin" size={13} />{c.address}</div>}
                  {c.work_hours && <div className="text-sm text-gray-500 flex items-center gap-1.5"><Icon name="clock" size={13} />Работает: <b className="text-gray-700 font-medium">{c.work_hours}</b></div>}
                  {c.contact && <div className="text-sm text-gray-500 flex items-center gap-1.5"><Icon name="phone" size={13} />{c.contact}</div>}
                  <div className="text-xs text-gray-500 mt-1 flex items-center gap-1.5"><Icon name="calendar" size={12} />{last ? `последний заказ ${last.split("-").reverse().join(".")}${days > 0 ? ` (${days} дн. назад)` : " (сегодня)"}` : "ещё не заказывал"}</div>
                  {(c.default_bag_kg || c.default_brand) && <div className="text-xs text-amber-700 bg-amber-50 rounded-lg px-2 py-1 mt-1 inline-flex items-center gap-1"><Icon name="box" size={12} />{c.default_brand || "—"} · {c.default_bag_kg ? c.default_bag_kg + " кг мешки" : "фасовка не указана"}</div>}
                  {(c.prices || []).length > 0 && <div className="flex flex-wrap gap-1 mt-2">{c.prices.map((p, i) => <span key={i} className="bg-amber-50 text-amber-800 text-xs px-2 py-0.5 rounded-full">{p.brand} {p.grade} {p.bag_kg}кг — {fmt(p.price_per_kg)}тг</span>)}</div>}
                </div>
                {canEdit && <div className="flex gap-1"><Btn size="sm" variant="secondary" onClick={() => openEdit(c)}><Icon name="pencil" size={15} /></Btn><Btn size="sm" variant="danger" onClick={() => deleteClient(c.id)}><Icon name="trash" size={15} /></Btn></div>}
              </div>
              <div className="flex gap-2 flex-wrap">
                <Btn size="sm" variant="secondary" onClick={() => setHistoryClient(c)}><Icon name="clipboard" size={15} />История и оплаты</Btn>
                {canEdit && (c.prices || []).length > 0 && <Btn size="sm" variant="secondary" onClick={() => copyOrderLink(c)}><Icon name="link" size={15} />Заказ-ссылка</Btn>}
              </div>
            </div>
            );
          };
          if (isRep) return shown.map(card); // торгпред: только свои, плоским списком
          // Админ/директор: разделы по группам с переименованием
          const groups = [{ key: "", label: houseName, items: shown.filter(c => !c.ownerId) }, ...repUsers.map(u => ({ key: u.id, label: u.group_name || u.name, items: shown.filter(c => c.ownerId === u.id) }))];
          const orphan = shown.filter(c => c.ownerId && !repUsers.some(u => u.id === c.ownerId));
          if (orphan.length) groups.push({ key: "orphan", label: "Без группы", items: orphan });
          return groups.filter(g => g.items.length).map(g => (
            <div key={g.key} className="space-y-3">
              <div className="flex items-center justify-between pt-1 border-b border-gray-100 pb-1">
                <h4 className="font-semibold text-gray-700 flex items-center gap-1.5"><Icon name={g.key === "" ? "home" : "user"} size={15} />{g.label} <span className="text-gray-400 font-normal text-sm">· {g.items.length}</span></h4>
                {canEdit && g.key !== "orphan" && <button onClick={() => renameGroup(g)} className="text-xs text-amber-600 hover:text-amber-700 inline-flex items-center gap-1"><Icon name="pencil" size={12} />переименовать</button>}
              </div>
              {g.items.map(card)}
            </div>
          ));
        })()}
      </div>

      {historyClient && (() => {
        const nowH = new Date();
        const inPeriod = o => {
          if (histPeriod === "all") return true;
          const d = new Date(o.date);
          if (histPeriod === "day") return o.date === TODAY();
          if (histPeriod === "week") { const w = new Date(nowH); w.setDate(w.getDate() - 7); return d >= w; }
          if (histPeriod === "month") return d.getMonth() === nowH.getMonth() && d.getFullYear() === nowH.getFullYear();
          if (histPeriod === "3month") { const m = new Date(nowH); m.setMonth(m.getMonth() - 3); return d >= m; }
          if (histPeriod === "custom") return o.date >= histFrom && o.date <= histTo;
          return true;
        };
        const co = orders.filter(o => o.clientId === historyClient.id && inPeriod(o)).sort((a, b) => b.date.localeCompare(a.date));
        const byDate = {};
        co.forEach(o => { (byDate[o.date] = byDate[o.date] || []).push(o); });
        const delivered = co.filter(o => o.status === "отгружена");
        const totalKg = delivered.reduce((s, o) => s + o.bags * o.bag_kg, 0);
        const totalDelivered = delivered.reduce((s, o) => s + o.bags * o.bag_kg * (o.price_per_kg || 0), 0);
        const totalPaid = delivered.filter(o => o.paid).reduce((s, o) => s + o.bags * o.bag_kg * (o.price_per_kg || 0), 0);
        const manualPaid = paidManual(historyClient.id); // внесено «в счёт долга» (всего)
        const debtAll = orders.filter(o => o.clientId === historyClient.id && o.status === "отгружена" && !o.paid).reduce((s, o) => s + o.bags * o.bag_kg * (o.price_per_kg || 0), 0) - manualPaid;
        const periods = [["day", "День"], ["week", "Неделя"], ["month", "Месяц"], ["3month", "3 мес"], ["all", "Всё"], ["custom", "Свой"]];
        return (
          <Modal title={`${historyClient.name} — история`} onClose={() => setHistoryClient(null)}>
            <div className="flex flex-wrap gap-1 mb-2">
              {periods.map(([v, l]) => <button key={v} onClick={() => setHistPeriod(v)} className={`text-xs px-2.5 py-1 rounded-full font-medium ${histPeriod === v ? "bg-amber-500 text-white" : "bg-gray-100 text-gray-600"}`}>{l}</button>)}
            </div>
            {histPeriod === "custom" && (
              <div className="flex items-center gap-2 mb-2 text-sm">
                <input type="date" className="border border-gray-200 rounded-lg px-2 py-1 text-xs" value={histFrom} onChange={e => setHistFrom(e.target.value)} />
                <span className="text-gray-400">—</span>
                <input type="date" className="border border-gray-200 rounded-lg px-2 py-1 text-xs" value={histTo} onChange={e => setHistTo(e.target.value)} />
              </div>
            )}
            <div className="text-sm mb-3 space-y-0.5 bg-gray-50 rounded-xl p-3">
              <div>Отгружено за период: <b>{fmt(totalKg)} кг</b> · <b>{fmt(totalDelivered)} тг</b></div>
              <div className="text-emerald-600">Оплачено за период: {fmt(totalPaid)} тг</div>
              {manualPaid > 0 && <div className="text-emerald-600">Внесено в счёт долга (всего): {fmt(manualPaid)} тг</div>}
              <div className={debtAll > 0 ? "text-red-600 font-bold" : "text-gray-500"}>{debtAll < 0 ? `Переплата (всего): ${fmt(-debtAll)} тг` : `Текущий долг (всего): ${fmt(debtAll)} тг`}</div>
            </div>
            {canEdit && (
              <div className="mb-3">
                {!showPayForm ? (
                  <Btn size="sm" onClick={() => { setShowPayForm(true); setPayForm({ amount: "", method: "Наличные", date: TODAY(), note: "" }); }}><Icon name="cash" size={15} />Клиент закинул сумму</Btn>
                ) : (
                  <div className="border-2 border-emerald-200 bg-emerald-50 rounded-xl p-3 space-y-2">
                    <div className="text-xs text-gray-600">Сумма, которую клиент прислал в счёт общего долга — она уменьшит долг.</div>
                    <Inp label="Сколько прислал, тг" type="number" value={payForm.amount} onChange={e => setPayForm({ ...payForm, amount: e.target.value })} />
                    <div className="flex gap-1.5 flex-wrap">{PAY_METHODS.map(([m, ic]) => <button key={m} onClick={() => setPayForm({ ...payForm, method: m })} className={`px-2.5 py-1 rounded-lg text-xs font-medium ${payForm.method === m ? "bg-amber-500 text-white" : "bg-white text-gray-600 border border-gray-200"}`}>{ic} {m}</button>)}</div>
                    <div className="flex items-center gap-2">
                      <input type="date" value={payForm.date} onChange={e => setPayForm({ ...payForm, date: e.target.value })} className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm" />
                      <input value={payForm.note} onChange={e => setPayForm({ ...payForm, note: e.target.value })} placeholder="заметка (по желанию)" className="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-sm" />
                    </div>
                    <div className="flex gap-2"><Btn size="sm" onClick={savePayment} disabled={!payForm.amount || savingPay}>{savingPay ? "Сохраняю…" : "Записать оплату"}</Btn><Btn size="sm" variant="secondary" onClick={() => setShowPayForm(false)}>Отмена</Btn></div>
                  </div>
                )}
                {(payments || []).filter(p => p.clientId === historyClient.id).length > 0 && (
                  <div className="mt-2 space-y-1">
                    {(payments || []).filter(p => p.clientId === historyClient.id).sort((a, b) => (b.date || "").localeCompare(a.date || "")).map(p => (
                      <div key={p.id} className="flex items-center justify-between text-xs bg-white border border-gray-100 rounded-lg px-3 py-1.5">
                        <span className="text-gray-600 inline-flex items-center gap-1"><Icon name="cash" size={13} className="text-emerald-600" />{(p.date || "").split("-").reverse().join(".")} · {p.method || "оплата"}{p.note ? ` · ${p.note}` : ""}</span>
                        <span className="flex items-center gap-2"><b className="text-emerald-600">{fmt(p.amount)} тг</b><button onClick={() => delPayment(p.id)} className="text-red-400 hover:text-red-600" title="Удалить">✕</button></span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {Object.entries(byDate).map(([date, list]) => {
                const sum = list.reduce((s, o) => s + o.bags * o.bag_kg * (o.price_per_kg || 0), 0);
                const kg = list.reduce((s, o) => s + o.bags * o.bag_kg, 0);
                const allPaid = list.every(o => o.paid);
                const method = list.find(o => o.pay_method)?.pay_method;
                const isFree = sum <= 0 && list.every(o => o.trial || o.isSample); // вся отгрузка на пробу — платить нечего
                return (
                  <div key={date} className={`border rounded-xl p-3 text-sm ${isFree ? "border-orange-200 bg-orange-50" : allPaid ? "border-emerald-200 bg-emerald-50" : "border-gray-100"}`}>
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{date.split("-").reverse().join(".")}</span>
                      <span className="text-gray-500">{fmt(kg)} кг · {fmt(sum)} тг</span>
                    </div>
                    {list.map(o => <div key={o.id} className="text-gray-500 text-xs mt-0.5">• {o.brand} {o.grade} {o.bag_kg}кг × {o.bags} — {o.status}</div>)}
                    <div className="mt-2">
                      {isFree
                        ? <span className="text-orange-600 font-medium text-xs">На пробу — бесплатно</span>
                        : allPaid
                        ? <div className="flex items-center gap-2 flex-wrap"><span className="text-emerald-700 font-medium text-xs">✓ Оплачено{method ? ` · ${method}` : ""}</span>{canEdit && <Btn size="sm" variant="ghost" onClick={() => markPaid(historyClient.id, date, false)}>отменить</Btn>}</div>
                        : (canEdit
                          ? <div className="flex gap-2 flex-wrap">{PAY_METHODS.map(([m, ic]) => <Btn key={m} size="sm" variant={m === "Наличные" ? "primary" : "secondary"} onClick={() => markPaid(historyClient.id, date, true, m)}>{ic} {m}</Btn>)}</div>
                          : <span className="text-amber-700 font-medium text-xs">● Не оплачено</span>)}
                    </div>
                  </div>
                );
              })}
              {co.length === 0 && <div className="text-gray-400 text-center py-6">Нет отгрузок за этот период</div>}
            </div>
          </Modal>
        );
      })()}
    </div>
  );
}

// Разбивка зарплаты бригадира по тарифам для объёма бригады kg (кг за месяц).
// Оклад включает incl тонн; тариф r1 действует incl→t1 тонн; тариф r2 — выше t1. Всё считается по всей бригаде.
function brigadeSalary(d, kg) {
  const base = Number(d.base_salary) || 0;
  const incl = (Number(d.base_included_t) || 0) * 1000; // кг, включённые в оклад
  const t1 = (Number(d.tier1_to_t) || 0) * 1000;        // порог второго тарифа, кг
  const r1 = Number(d.tier1_rate) || 0, r2 = Number(d.tier2_rate) || 0;
  const tier1kg = Math.max(0, Math.min(kg, t1) - incl);
  const tier2kg = Math.max(0, kg - t1);
  const tier1pay = Math.round(tier1kg * r1);
  const tier2pay = Math.round(tier2kg * r2);
  const total = Math.round(base + tier1kg * r1 + tier2kg * r2);
  const toNext = kg < incl ? incl - kg : (kg < t1 ? t1 - kg : 0);
  const nextLabel = kg < incl ? `до конца оклада (${fmt(incl / 1000)} т)` : (kg < t1 ? `до тарифа ${fmt(r2)} тг/кг (${fmt(t1 / 1000)} т)` : "");
  return { base, incl, t1, r1, r2, tier1kg, tier1pay, tier2kg, tier2pay, total, toNext, nextLabel };
}

// 📦 Погрузка самовывоза бригадой за месяц — считается ОТДЕЛЬНО от оклада/тарифов (не входит в объём бригады).
// Заявки-самовывоз (pickup), которые грузил кто-то из бригады (loaderId), × ставка за погрузку (load_rate_per_kg, по умолч. 2.7 тг/кг).
function brigadePickupLoad(d, drivers, orders, ym) {
  const rate = Number(d.load_rate_per_kg) || 2.7;
  const brigade = [d.id, ...drivers.filter(x => x.foremanId === d.id).map(x => x.id)];
  const inb = new Set(brigade);
  const per = brigade.map(id => ({
    id, name: drivers.find(x => x.id === id)?.name || "?", me: id === d.id,
    kg: orders.filter(o => o.status === "отгружена" && o.pickup && !o.pickupWatch && o.loaderId === id && (o.date || "").startsWith(ym)).reduce((s, o) => s + o.bags * o.bag_kg, 0),
  })).filter(x => x.kg > 0);
  const kg = per.reduce((s, x) => s + x.kg, 0);
  // 👀 «только контроль» — клиент грузил сам, бригада проследила: тоннаж для статистики, но БЕЗ оплаты
  const watchKg = orders.filter(o => o.status === "отгружена" && o.pickup && o.pickupWatch && inb.has(o.loaderId) && (o.date || "").startsWith(ym)).reduce((s, o) => s + o.bags * o.bag_kg, 0);
  return { rate, per, kg, pay: Math.round(kg * rate), watchKg };
}

function DriversTab({ drivers, orders, expenses = [], users = [], reload, canEdit = true }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);
  const [saving, setSaving] = useState(false);
  const blankDriver = { name: "", salary_type: "kg", rate_per_kg: "", load_rate_per_kg: "", foremanId: "", base_salary: "650000", base_included_t: "60", tier1_to_t: "190", tier1_rate: "6", tier2_rate: "8" };
  const [form, setForm] = useState(blankDriver);
  const [payDriver, setPayDriver] = useState(null);
  const [payAmount, setPayAmount] = useState("");
  const [payDate, setPayDate] = useState(TODAY());
  const [payExtra, setPayExtra] = useState(false);
  const [detailDriver, setDetailDriver] = useState(null);
  const [salMonth, setSalMonth] = useState(TODAY().slice(0, 7)); // YYYY-MM — месяц для зарплаты бригадира

  const brigadirs = drivers.filter(d => d.salary_type === "brigadir"); // для выбора старшего у младшего
  const openNew = () => { setEditId(null); setForm(blankDriver); setShowAdd(true); };
  const openEdit = d => { setEditId(d.id); setForm({ name: d.name, salary_type: d.salary_type || "kg", rate_per_kg: d.rate_per_kg ?? "", load_rate_per_kg: d.salary_type === "brigadir" ? (d.load_rate_per_kg || 2.7) : (d.load_rate_per_kg ?? ""), foremanId: d.foremanId || "", base_salary: d.base_salary ?? "650000", base_included_t: d.base_included_t ?? "60", tier1_to_t: d.tier1_to_t ?? "190", tier1_rate: d.tier1_rate ?? "6", tier2_rate: d.tier2_rate ?? "8" }); setShowAdd(true); };
  const saveDriver = async () => {
    setSaving(true);
    const t = form.salary_type;
    const rec = { id: editId || uid(), name: form.name, salary_type: t };
    if (t === "brigadir") Object.assign(rec, { base_salary: Number(form.base_salary) || 0, base_included_t: Number(form.base_included_t) || 0, tier1_to_t: Number(form.tier1_to_t) || 0, tier1_rate: Number(form.tier1_rate) || 0, tier2_rate: Number(form.tier2_rate) || 0, rate_per_kg: 0, load_rate_per_kg: form.load_rate_per_kg === "" ? 2.7 : (Number(form.load_rate_per_kg) || 0), foremanId: "" });
    else if (t === "junior") Object.assign(rec, { foremanId: form.foremanId || "", rate_per_kg: 0, load_rate_per_kg: 0 });
    else Object.assign(rec, { rate_per_kg: Number(form.rate_per_kg) || 0, load_rate_per_kg: Number(form.load_rate_per_kg) || 0, foremanId: "" });
    try { await dbUpsert("drivers", rec); setShowAdd(false); setEditId(null); setForm(blankDriver); await reload("drivers"); } catch (e) { alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз."); }
    setSaving(false);
  };
  // Зарплата бригадира: оклад (вкл. N тонн) + тариф1 до M тонн + тариф2 выше. Объём — вся бригада за месяц.
  const brigadeKgMonth = (d, ym) => {
    const brigade = new Set([d.id, ...drivers.filter(x => x.foremanId === d.id).map(x => x.id)]);
    return orders.filter(o => o.status === "отгружена" && brigade.has(o.driverId) && (o.date || "").startsWith(ym)).reduce((s, o) => s + o.bags * o.bag_kg, 0);
  };
  const brigadirPay = (d, kg) => brigadeSalary(d, kg).total;
  const deleteDriver = async id => {
    const linked = (users || []).filter(u => u.driverId === id);
    if (!confirm(`Удалить рабочего${linked.length ? " и его логин? Он больше не сможет войти и его выкинет из приложения." : "?"}`)) return;
    try {
      await dbDelete("drivers", id);
      for (const u of linked) await dbDelete("users", u.id); // закрываем вход
      await reload("drivers"); if (linked.length) await reload("users");
    } catch (e) { alert("⚠️ Не удалилось: " + (e && e.message ? e.message : e)); }
  };

  // Заработок обычного водителя/грузчика по ставке (всё время). Бригадир и младшие считаются иначе.
  const earnings = {}, loadEarn = {};
  orders.filter(o => o.status === "отгружена").forEach(o => {
    if (o.driverId && !o.pickup) { const d = drivers.find(x => x.id === o.driverId); if (d && d.salary_type !== "brigadir" && d.salary_type !== "junior") earnings[o.driverId] = (earnings[o.driverId] || 0) + o.bags * o.bag_kg * (d.rate_per_kg || 0); }
    if (o.pickup && o.loaderId && !o.pickupWatch) { const d = drivers.find(x => x.id === o.loaderId); if (d && d.salary_type !== "brigadir" && d.salary_type !== "junior") loadEarn[o.loaderId] = (loadEarn[o.loaderId] || 0) + o.bags * o.bag_kg * (d.load_rate_per_kg || 0); }
  });
  // Выплаты: зарплата (уменьшает долг) и доплаты за доп. работу (НЕ уменьшают долг)
  const wagePaid = {}, extraPaid = {};
  expenses.filter(x => x.driverId).forEach(x => { const m = x.extra ? extraPaid : wagePaid; m[x.driverId] = (m[x.driverId] || 0) + (x.amount || 0); });
  const wagePaidMonth = id => expenses.filter(x => x.driverId === id && !x.extra && (x.date || "").startsWith(salMonth)).reduce((s, x) => s + (x.amount || 0), 0);
  // Заработано: бригадир — оклад+тарифы за выбранный месяц (по объёму всей бригады); младший — платит бригадир (0); обычный — по ставке (всё время)
  const earnedOf = d => d.salary_type === "brigadir" ? brigadirPay(d, brigadeKgMonth(d, salMonth)) + brigadePickupLoad(d, drivers, orders, salMonth).pay : d.salary_type === "junior" ? 0 : ((earnings[d.id] || 0) + (loadEarn[d.id] || 0));
  const paidOf = d => d.salary_type === "brigadir" ? wagePaidMonth(d.id) : (wagePaid[d.id] || 0);
  const remainingOf = d => Math.max(0, Math.round(earnedOf(d) - paidOf(d)));

  const openPay = (d, extra = false) => { setPayDriver(d); setPayExtra(extra); setPayAmount(extra ? "" : String(remainingOf(d))); setPayDate(TODAY()); };
  const doPay = async () => {
    if (!payAmount) return;
    setSaving(true);
    const isBrig = payDriver.salary_type === "brigadir";
    const note = payExtra ? `Доплата (доп. работа) — ${payDriver.name}` : (isBrig ? `Зарплата бригадира за ${salMonth} — ${payDriver.name}` : `Зарплата (развоз+отгрузка) — ${payDriver.name}`);
    try { await dbUpsert("expenses", { id: uid(), date: payDate, category: "Водители", driverId: payDriver.id, amount: Number(payAmount), extra: payExtra, note }); setPayDriver(null); await reload("expenses"); }
    catch (e) { alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз."); }
    setSaving(false);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between"><h3 className="font-bold text-gray-800">Зарплата</h3>{canEdit && <Btn onClick={openNew}>+ Рабочий</Btn>}</div>
      <div className="flex items-center gap-2 text-sm">
        <span className="text-gray-500">Месяц зарплаты бригадира:</span>
        <input type="month" value={salMonth} onChange={e => setSalMonth(e.target.value)} className="border border-gray-200 rounded-lg px-2 py-1 text-sm" />
      </div>
      {showAdd && (<Modal title={editId ? "Изменить рабочего" : "Новый рабочий"} onClose={() => setShowAdd(false)}>
        <div className="space-y-3">
          <Inp label="Имя" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          <Sel label="Тип оплаты" value={form.salary_type} onChange={e => setForm({ ...form, salary_type: e.target.value })} options={[{ value: "kg", label: "Обычный — ставка за кг" }, { value: "brigadir", label: "Бригадир — оклад + тарифы" }, { value: "junior", label: "Младший водитель (платит бригадир)" }]} />
          {form.salary_type === "kg" && (<>
            <Inp label="Ставка за развоз (водитель), тг/кг" type="number" value={form.rate_per_kg} onChange={e => setForm({ ...form, rate_per_kg: e.target.value })} placeholder="напр. 3" />
            <Inp label="Ставка за отгрузку (грузчик), тг/кг" type="number" value={form.load_rate_per_kg} onChange={e => setForm({ ...form, load_rate_per_kg: e.target.value })} placeholder="напр. 2" />
          </>)}
          {form.salary_type === "junior" && (
            brigadirs.length === 0
              ? <p className="text-xs text-amber-600">Сначала создай бригадира (тип оплаты «Бригадир»), потом привяжешь к нему младших.</p>
              : <Sel label="Бригадир (старший)" value={form.foremanId} onChange={e => setForm({ ...form, foremanId: e.target.value })} options={[{ value: "", label: "— выбери бригадира —" }, ...brigadirs.map(b => ({ value: b.id, label: b.name }))]} />
          )}
          {form.salary_type === "junior" && <p className="text-xs text-gray-500">Зарплату младшему платит бригадир из своих. В приложении его зарплату не считаем — только показываем, сколько он развёз.</p>}
          {form.salary_type === "brigadir" && (<>
            <Inp label="Оклад, тг/мес" type="number" value={form.base_salary} onChange={e => setForm({ ...form, base_salary: e.target.value })} />
            <Inp label="В оклад включено, тонн/мес" type="number" value={form.base_included_t} onChange={e => setForm({ ...form, base_included_t: e.target.value })} />
            <Inp label="Тариф до порога, тг/кг" type="number" value={form.tier1_rate} onChange={e => setForm({ ...form, tier1_rate: e.target.value })} />
            <Inp label="Порог второго тарифа, тонн/мес" type="number" value={form.tier1_to_t} onChange={e => setForm({ ...form, tier1_to_t: e.target.value })} />
            <Inp label="Тариф выше порога, тг/кг" type="number" value={form.tier2_rate} onChange={e => setForm({ ...form, tier2_rate: e.target.value })} />
            <Inp label="Погрузка самовывоза, тг/кг" type="number" value={form.load_rate_per_kg} onChange={e => setForm({ ...form, load_rate_per_kg: e.target.value })} placeholder="напр. 2.7" />
            <p className="text-xs text-gray-500">Пример: оклад 650000 (вкл. 60 т), 60–190 т по 6 тг/кг, свыше 190 т по 8 тг/кг. Считается по объёму всей бригады за месяц. Погрузка самовывоза (клиент забрал сам) — отдельно, в объём бригады НЕ входит.</p>
          </>)}
        </div>
        <div className="flex gap-2 mt-4"><Btn onClick={saveDriver} disabled={saving || (form.salary_type === "junior" && !form.foremanId)}>{saving ? "Сохраняю..." : "Сохранить"}</Btn><Btn variant="secondary" onClick={() => setShowAdd(false)}>Отмена</Btn></div>
      </Modal>)}
      {payDriver && (<Modal title={`Выплата: ${payDriver.name}`} onClose={() => setPayDriver(null)}>
        <div className="space-y-3">
          <div className="flex gap-2">
            <button onClick={() => { setPayExtra(false); setPayAmount(String(remainingOf(payDriver))); }} className={`flex-1 py-2 rounded-lg text-sm font-medium ${!payExtra ? "bg-amber-500 text-white" : "bg-gray-100 text-gray-600"}`}>Зарплата</button>
            <button onClick={() => { setPayExtra(true); setPayAmount(""); }} className={`flex-1 py-2 rounded-lg text-sm font-medium ${payExtra ? "bg-amber-500 text-white" : "bg-gray-100 text-gray-600"}`}>Доплата (доп. работа)</button>
          </div>
          {payExtra
            ? <div className="text-xs text-amber-700 bg-amber-50 rounded-lg p-2">Доплата НЕ уменьшает остаток по зарплате — это оплата за дополнительную работу.</div>
            : <div className="text-sm bg-gray-50 rounded-xl p-3">{payDriver.salary_type === "brigadir" ? <>Зарплата за {salMonth} (бригада {fmt(brigadeKgMonth(payDriver, salMonth))} кг): <b>{fmt(earnedOf(payDriver))} тг</b> · выплачено в этом месяце: {fmt(paidOf(payDriver))} тг · осталось: <b className="text-red-600">{fmt(remainingOf(payDriver))} тг</b></> : <>Заработал (развоз {fmt(earnings[payDriver.id] || 0)} + отгрузка {fmt(loadEarn[payDriver.id] || 0)}): <b>{fmt(earnedOf(payDriver))} тг</b> · выплачено: {fmt(wagePaid[payDriver.id] || 0)} тг · осталось: <b className="text-red-600">{fmt(remainingOf(payDriver))} тг</b></>}</div>}
          <Inp label="Дата" type="date" value={payDate} onChange={e => setPayDate(e.target.value)} />
          <Inp label="Сумма выплаты, тг" type="number" value={payAmount} onChange={e => setPayAmount(e.target.value)} />
        </div>
        <div className="flex gap-2 mt-4"><Btn onClick={doPay} disabled={saving || !payAmount}>{saving ? "Сохраняю..." : <><Icon name="cash" size={16} />Выплатить</>}</Btn><Btn variant="secondary" onClick={() => setPayDriver(null)}>Отмена</Btn></div>
      </Modal>)}
      {detailDriver && (() => {
        const d = detailDriver;
        const pays = expenses.filter(x => x.driverId === d.id).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
        const paysBlock = (
          <div>
            <div className="font-semibold text-gray-700 mb-1">Выплаты</div>
            {pays.length === 0 ? <div className="text-gray-400 text-sm">Выплат ещё не было</div> : (
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {pays.map(x => <div key={x.id} className="flex items-center justify-between text-sm border border-gray-100 rounded-lg px-3 py-2"><span className="text-gray-500">{(x.date || "").split("-").reverse().join(".")}{x.extra ? <span className="text-amber-700"> · доплата</span> : <span className="text-emerald-600"> · зарплата</span>}</span><span className="font-medium">{fmt(x.amount)} тг</span></div>)}
              </div>
            )}
          </div>
        );
        // 👷 Бригадир: разбивка зарплаты по тарифам за месяц + сколько развёз каждый водитель бригады
        if (d.salary_type === "brigadir") {
          const brigade = [d.id, ...drivers.filter(x => x.foremanId === d.id).map(x => x.id)];
          const kgOf = id => orders.filter(o => o.status === "отгружена" && o.driverId === id && (o.date || "").startsWith(salMonth)).reduce((s, o) => s + o.bags * o.bag_kg, 0);
          const perDriver = brigade.map(id => ({ id, name: drivers.find(x => x.id === id)?.name || "?", kg: kgOf(id), me: id === d.id })).filter(x => x.kg > 0 || x.me).sort((a, b) => b.kg - a.kg);
          const kg = perDriver.reduce((s, x) => s + x.kg, 0);
          const b = brigadeSalary(d, kg);
          const sv = brigadePickupLoad(d, drivers, orders, salMonth); // погрузка самовывоза — отдельно
          const grand = b.total + sv.pay;
          const paidM = wagePaidMonth(d.id);
          const left = Math.max(0, grand - paidM);
          return (<Modal title={`${d.name} — детали за ${salMonth}`} onClose={() => setDetailDriver(null)}>
            <div className="space-y-4">
              <div className="rounded-2xl p-4 bg-gradient-to-br from-amber-500 to-amber-600 text-white">
                <div className="text-sm opacity-90">Зарплата за месяц</div>
                <div className="text-3xl font-black mt-0.5">{fmt(grand)} тг</div>
                <div className="text-sm opacity-90 mt-1 border-t border-white/30 pt-1">Развоз бригады: <b>{fmt(kg)} кг</b> ({fmt(Math.round(kg / 100) / 10)} т){sv.kg > 0 ? <> · самовывоз: <b>{fmt(sv.kg)} кг</b></> : ""}</div>
              </div>
              <div className="bg-gray-50 rounded-xl p-3 text-sm space-y-1">
                <div className="font-semibold text-gray-700 mb-1 flex items-center gap-1.5"><Icon name="truck" size={15} />За развоз (оклад + тарифы)</div>
                <div className="flex justify-between"><span className="text-gray-600">Оклад (за первые {fmt(b.incl / 1000)} т)</span><b>{fmt(b.base)} тг</b></div>
                <div className="flex justify-between"><span className="text-gray-600">{fmt(b.incl / 1000)}–{fmt(b.t1 / 1000)} т: {fmt(b.tier1kg)} кг × {fmt(b.r1)} тг/кг</span><b>+{fmt(b.tier1pay)} тг</b></div>
                <div className="flex justify-between"><span className="text-gray-600">свыше {fmt(b.t1 / 1000)} т: {fmt(b.tier2kg)} кг × {fmt(b.r2)} тг/кг</span><b>+{fmt(b.tier2pay)} тг</b></div>
                <div className="flex justify-between border-t border-gray-200 pt-1 mt-1"><span className="font-semibold">Итого за развоз</span><b>{fmt(b.total)} тг</b></div>
                {b.toNext > 0 && <div className="text-xs text-amber-700 bg-amber-50 rounded-lg px-2 py-1 mt-1">Ещё {fmt(b.toNext)} кг {b.nextLabel}</div>}
              </div>
              <div className="bg-gray-50 rounded-xl p-3 text-sm space-y-1">
                <div className="font-semibold text-gray-700 mb-1 flex items-center gap-1.5"><Icon name="box" size={15} />Погрузка самовывоза <span className="font-normal text-gray-400">(клиент забрал сам · {fmt(sv.rate)} тг/кг)</span></div>
                {sv.kg > 0 ? (<>
                  {sv.per.map(x => <div key={x.id} className="flex justify-between py-0.5"><span className="text-gray-600"><Icon name={x.me ? "user" : "truck"} size={12} className="inline-block mr-1 align-[-2px]" />{x.name}: {fmt(x.kg)} кг × {fmt(sv.rate)}</span><b>+{fmt(Math.round(x.kg * sv.rate))} тг</b></div>)}
                  <div className="flex justify-between border-t border-gray-200 pt-1 mt-1"><span className="font-semibold">Итого за погрузку</span><b>+{fmt(sv.pay)} тг</b></div>
                </>) : <div className="text-gray-400">Самовывоза (с погрузкой) в этом месяце не было.</div>}
                {sv.watchKg > 0 && <div className="flex justify-between border-t border-gray-200 pt-1 mt-1 text-purple-800"><span className="inline-flex items-center gap-1"><Icon name="eye" size={13} />На контроле (клиент грузил сам)</span><b>{fmt(sv.watchKg)} кг · без оплаты</b></div>}
              </div>
              <div className="flex justify-between bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-sm"><span className="font-bold text-amber-800">Всего к начислению</span><b className="text-amber-800">{fmt(grand)} тг</b></div>
              <div className="bg-white border border-gray-100 rounded-xl p-3 text-sm">
                <div className="font-semibold text-gray-700 mb-1">Сколько развёз каждый водитель</div>
                {perDriver.map(x => <div key={x.id} className="flex justify-between py-0.5"><span className={x.me ? "font-medium text-gray-900" : "text-gray-600"}><Icon name={x.me ? "user" : "truck"} size={12} className="inline-block mr-1 align-[-2px]" />{x.name}{x.me ? " (бригадир)" : ""}</span><b>{fmt(x.kg)} кг</b></div>)}
                {perDriver.every(x => x.kg === 0) && <div className="text-gray-400">Отгрузок за месяц ещё нет.</div>}
              </div>
              <div className="text-sm flex items-center justify-between bg-gray-50 rounded-xl px-3 py-2">
                <span>Выплачено за месяц: <b className="text-emerald-600">{fmt(paidM)} тг</b></span>
                <span className={left > 0 ? "text-red-600 font-bold" : "text-gray-500"}>Осталось: {fmt(left)} тг</span>
              </div>
              {paysBlock}
            </div>
          </Modal>);
        }
        // 🚛 Обычный водитель/грузчик — по дням
        const byDate = {};
        orders.filter(o => o.status === "отгружена" && ((o.driverId === d.id && !o.pickup) || (o.pickup && o.loaderId === d.id && !o.pickupWatch))).forEach(o => {
          const rec = byDate[o.date] = byDate[o.date] || { delivKg: 0, loadKg: 0 };
          if (o.pickup) rec.loadKg += o.bags * o.bag_kg; else rec.delivKg += o.bags * o.bag_kg;
        });
        const days = Object.entries(byDate).map(([date, v]) => ({ date, ...v, owed: Math.round(v.delivKg * (d.rate_per_kg || 0) + v.loadKg * (d.load_rate_per_kg || 0)) })).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
        const watchKg = orders.filter(o => o.status === "отгружена" && o.pickup && o.pickupWatch && o.loaderId === d.id).reduce((s, o) => s + o.bags * o.bag_kg, 0); // на контроле — без оплаты
        return (<Modal title={`${d.name} — детали`} onClose={() => setDetailDriver(null)}>
          <div className="space-y-4">
            <div>
              <div className="font-semibold text-gray-700 mb-1">{d.salary_type === "junior" ? "По дням (развоз)" : "По дням (развоз + отгрузка)"}</div>
              {days.length === 0 ? <div className="text-gray-400 text-sm">Работы ещё не было</div> : (
                <div className="space-y-1 max-h-60 overflow-y-auto">
                  {days.map(x => <div key={x.date} className="flex items-center justify-between text-sm bg-gray-50 rounded-lg px-3 py-2"><span>{x.date.split("-").reverse().join(".")}{x.delivKg ? ` · развоз ${fmt(x.delivKg)}` : ""}{x.loadKg ? ` · погрузка ${fmt(x.loadKg)}` : ""} кг</span>{d.salary_type === "junior" ? <span className="text-gray-400">тоннаж</span> : <span className="font-medium">должны {fmt(x.owed)} тг</span>}</div>)}
                </div>
              )}
            </div>
            {watchKg > 0 && <div className="bg-purple-50 border border-purple-100 rounded-xl px-3 py-2 text-sm text-purple-800 flex items-center gap-1.5"><Icon name="eye" size={14} className="shrink-0" />На контроле (клиент грузил сам): <b>{fmt(watchKg)} кг</b> — без оплаты, для учёта.</div>}
            {paysBlock}
          </div>
        </Modal>);
      })()}
      <div className="space-y-3">
        {drivers.length === 0 && <div className="text-center py-12 text-gray-400">Рабочих нет.</div>}
        {[...drivers].sort((a, b) => (a.salary_type === "brigadir" ? 0 : a.salary_type === "junior" ? 1 : 2) - (b.salary_type === "brigadir" ? 0 : b.salary_type === "junior" ? 1 : 2)).map(d => {
          const isBrig = d.salary_type === "brigadir";
          const isJunior = d.salary_type === "junior";
          const foreman = isJunior ? drivers.find(x => x.id === d.foremanId) : null;
          const juniors = isBrig ? drivers.filter(x => x.foremanId === d.id) : [];
          const monthKg = isBrig ? brigadeKgMonth(d, salMonth) : orders.filter(o => o.status === "отгружена" && ((o.driverId === d.id && !o.pickup) || (o.pickup && o.loaderId === d.id && !o.pickupWatch)) && (o.date || "").startsWith(salMonth)).reduce((s, o) => s + o.bags * o.bag_kg, 0);
          const eDeliv = earnings[d.id] || 0, eLoad = loadEarn[d.id] || 0;
          const wage = wagePaid[d.id] || 0;
          const extra = extraPaid[d.id] || 0;
          const earned = earnedOf(d), paidM = paidOf(d), left = remainingOf(d);
          return (
            <div key={d.id} className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm">
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-display font-semibold text-gray-900 flex items-center gap-2"><Icon name="truck" size={17} />{d.name}
                    {isBrig && <span className="text-xs font-medium text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full inline-flex items-center gap-1"><Icon name="user" size={11} />Бригадир</span>}
                    {isJunior && <span className="text-xs font-medium text-sky-700 bg-sky-100 px-2 py-0.5 rounded-full">младший{foreman ? ` · ${foreman.name}` : ""}</span>}
                  </div>
                  {isBrig ? (<>
                    <div className="text-xs text-gray-500 mt-0.5">Оклад {fmt(d.base_salary)} тг (вкл. {fmt(d.base_included_t)} т) · {fmt(d.base_included_t)}–{fmt(d.tier1_to_t)} т по {fmt(d.tier1_rate)} тг/кг · свыше {fmt(d.tier1_to_t)} т по {fmt(d.tier2_rate)} тг/кг</div>
                    <div className="text-sm mt-1">Бригада за {salMonth}: <b>{fmt(monthKg)} кг</b> <span className="text-gray-400">({fmt(monthKg / 1000)} т{juniors.length ? `, ${juniors.length} мл.` : ""})</span></div>
                    <div className="text-sm">Зарплата за месяц: <b>{fmt(earned)} тг</b> · выплачено: <span className="text-emerald-600">{fmt(paidM)} тг</span></div>
                    <div className={`text-sm font-bold ${left > 0 ? "text-red-600" : "text-gray-500"}`}>Осталось за месяц: {fmt(left)} тг</div>
                  </>) : isJunior ? (
                    <div className="text-sm text-gray-500 mt-1">Развёз за {salMonth}: <b className="text-gray-700">{fmt(monthKg)} кг</b>. Зарплату платит бригадир{foreman ? ` ${foreman.name}` : ""} — в приложении не считаем.</div>
                  ) : (<>
                    <div className="text-sm text-gray-500">развоз {fmt(d.rate_per_kg)} тг/кг · отгрузка {fmt(d.load_rate_per_kg || 0)} тг/кг</div>
                    <div className="text-sm mt-1">Развоз: <b>{fmt(eDeliv)} тг</b> · Отгрузка: <b>{fmt(eLoad)} тг</b></div>
                    <div className="text-sm">Всего заработал: <b>{fmt(eDeliv + eLoad)} тг</b> · выплачено: <span className="text-emerald-600">{fmt(wage)} тг</span></div>
                    <div className={`text-sm font-bold ${left > 0 ? "text-red-600" : "text-gray-500"}`}>Осталось выплатить: {fmt(left)} тг</div>
                  </>)}
                  {extra > 0 && <div className="text-xs text-amber-700 mt-0.5">Доплаты (доп. работа): {fmt(extra)} тг</div>}
                </div>
                {canEdit && <div className="flex gap-1"><Btn size="sm" variant="secondary" onClick={() => openEdit(d)}><Icon name="pencil" size={15} /></Btn><Btn size="sm" variant="danger" onClick={() => deleteDriver(d.id)}><Icon name="trash" size={15} /></Btn></div>}
              </div>
              <div className="flex gap-2 mt-3 flex-wrap">
                {canEdit && !isJunior && <Btn size="sm" onClick={() => openPay(d, false)}><Icon name="cash" size={15} />Выплатить{isBrig ? " за месяц" : " зарплату"}</Btn>}
                {canEdit && <Btn size="sm" variant="secondary" onClick={() => openPay(d, true)}>+ Доплата</Btn>}
                <Btn size="sm" variant="secondary" onClick={() => setDetailDriver(d)}><Icon name="clipboard" size={15} />Детали</Btn>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// 📊 Детальная аналитика по набору заявок (для торгпреда или выбранного торгпреда):
// оборот/тоннаж/заявки/клиенты + долг + что чаще берут (топ товаров) + кто больше берёт (топ клиентов, разворачиваются).
function RepAnalytics({ delivered = [], allMine = [], payments = [] }) {
  const [openCli, setOpenCli] = useState(null);
  const rev = delivered.reduce((s, o) => s + o.bags * o.bag_kg * (o.price_per_kg || 0), 0);
  const kg = delivered.reduce((s, o) => s + o.bags * o.bag_kg, 0);
  const ordN = new Set(delivered.map(o => (o.clientId || "nm:" + (o.clientName || "")) + "|" + o.date)).size;
  const cliN = new Set(delivered.map(o => o.clientId || "nm:" + (o.clientName || "")).filter(Boolean)).size;
  let debt = 0; allMine.filter(o => o.status === "отгружена" && !o.paid).forEach(o => { debt += o.bags * o.bag_kg * (o.price_per_kg || 0); });
  (payments || []).forEach(p => { debt -= (p.amount || 0); }); debt = Math.max(0, Math.round(debt));
  const prod = {}; delivered.forEach(o => { const k = `${o.brand} · ${o.grade} · ${o.bag_kg} кг`; const a = prod[k] = prod[k] || { k, kg: 0, rev: 0 }; a.kg += o.bags * o.bag_kg; a.rev += o.bags * o.bag_kg * (o.price_per_kg || 0); });
  const topProd = Object.values(prod).sort((a, b) => b.kg - a.kg);
  const maxProd = topProd.length ? topProd[0].kg : 1;
  const cli = {}; delivered.forEach(o => { const key = o.clientId || "nm:" + (o.clientName || ""); const a = cli[key] = cli[key] || { key, name: o.clientName || "?", kg: 0, rev: 0, prod: {} }; a.kg += o.bags * o.bag_kg; a.rev += o.bags * o.bag_kg * (o.price_per_kg || 0); const pk = `${o.brand} ${o.grade} ${o.bag_kg}кг`; a.prod[pk] = (a.prod[pk] || 0) + o.bags * o.bag_kg; });
  const topCli = Object.values(cli).sort((a, b) => b.kg - a.kg);
  const maxCli = topCli.length ? topCli[0].kg : 1;
  if (!delivered.length) return <div className="bg-white border border-gray-100 rounded-2xl p-4 text-sm text-gray-400">За этот период отгрузок нет.</div>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-gradient-to-br from-emerald-50 to-green-100 rounded-2xl p-4"><div className="text-xs text-emerald-700 font-medium">Оборот за период</div><div className="text-2xl font-display font-semibold text-emerald-800">{fmt(Math.round(rev))} тг</div></div>
        <div className="bg-white border border-gray-100 rounded-2xl p-4"><div className="text-xs text-gray-500">Отгружено</div><div className="text-2xl font-display font-semibold text-gray-800">{fmt(kg)} кг</div></div>
        <div className="bg-white border border-gray-100 rounded-2xl p-4"><div className="text-xs text-gray-500">Заявок</div><div className="text-2xl font-display font-semibold text-gray-800">{ordN}</div></div>
        <div className="bg-white border border-gray-100 rounded-2xl p-4"><div className="text-xs text-gray-500">Клиентов</div><div className="text-2xl font-display font-semibold text-gray-800">{cliN}</div></div>
      </div>
      <div className={`rounded-2xl p-4 border flex items-center justify-between gap-2 ${debt > 0 ? "bg-red-50 border-red-100" : "bg-emerald-50 border-emerald-100"}`}>
        <div className="font-display font-semibold text-gray-800 flex items-center gap-1.5"><Icon name="wallet" size={16} />Текущий долг <span className="text-xs font-normal text-gray-400">(не зависит от периода)</span></div>
        <div className={`text-xl font-display font-semibold ${debt > 0 ? "text-red-600" : "text-emerald-600"}`}>{fmt(debt)} тг</div>
      </div>
      <div className="bg-white border border-gray-100 rounded-2xl p-4">
        <div className="font-display font-semibold text-gray-800 mb-3 flex items-center gap-1.5"><Icon name="box" size={16} />Что чаще берут <span className="text-xs font-normal text-gray-400">за период</span></div>
        <div className="space-y-2">{topProd.slice(0, 10).map(p => (
          <div key={p.k}>
            <div className="flex items-center justify-between text-sm mb-0.5"><span className="text-gray-700">{p.k}</span><b className="text-gray-800 whitespace-nowrap">{fmt(p.kg)} кг</b></div>
            <div className="h-2 rounded-full bg-gray-100 overflow-hidden"><div className="h-full bg-amber-500 rounded-full" style={{ width: `${Math.max(4, Math.round(p.kg / maxProd * 100))}%` }}></div></div>
          </div>
        ))}</div>
      </div>
      <div className="bg-white border border-gray-100 rounded-2xl p-4">
        <div className="font-display font-semibold text-gray-800 mb-3 flex items-center gap-1.5"><Icon name="user" size={16} />Кто больше берёт <span className="text-xs font-normal text-gray-400">· нажми, чтобы увидеть что берёт</span></div>
        <div className="space-y-2">{topCli.slice(0, 20).map(c => (
          <div key={c.key} className="border-b border-gray-50 pb-2 last:border-0">
            <button onClick={() => setOpenCli(openCli === c.key ? null : c.key)} className="w-full text-left">
              <div className="flex items-center justify-between text-sm mb-0.5"><span className="text-gray-700 flex items-center gap-1"><Icon name={openCli === c.key ? "eye" : "user"} size={13} />{c.name}</span><b className="text-gray-800 whitespace-nowrap">{fmt(c.kg)} кг · {fmt(Math.round(c.rev))} тг</b></div>
              <div className="h-2 rounded-full bg-gray-100 overflow-hidden"><div className="h-full bg-emerald-500 rounded-full" style={{ width: `${Math.max(4, Math.round(c.kg / maxCli * 100))}%` }}></div></div>
            </button>
            {openCli === c.key && <div className="mt-2 pl-1 space-y-1">{Object.entries(c.prod).sort((a, b) => b[1] - a[1]).map(([pk, v]) => <div key={pk} className="flex items-center justify-between text-xs text-gray-500"><span>· {pk}</span><span>{fmt(v)} кг</span></div>)}</div>}
          </div>
        ))}</div>
      </div>
    </div>
  );
}
function ReportsTab({ orders: ordersProp, drivers, stock = [], expenses = [], payments = [], clients = [], users = [], role = "director", reload = () => {}, canEdit = true }) {
  const repMode = role === "rep"; // торгпред видит СВОЮ аналитику: считаем только по его заявкам (не foreign)
  const orders = repMode ? ordersProp.filter(o => !o.foreign) : ordersProp;
  const [selRep, setSelRep] = useState(""); // директор: подробная аналитика по выбранному торгпреду
  const [period, setPeriod] = useState("month");
  const [view, setView] = useState("product");
  // 🔍 Свой отчёт: фильтры по бренду, сорту и фасовкам (период — общий сверху)
  const [repBrand, setRepBrand] = useState("all");
  const [repGrade, setRepGrade] = useState("all");
  const [repPacks, setRepPacks] = useState([]); // пусто = все фасовки
  const [from, setFrom] = useState(TODAY());
  const [to, setTo] = useState(TODAY());
  const [advice, setAdvice] = useState("");
  const [adviceLoading, setAdviceLoading] = useState(false);
  const getAdvice = async () => {
    setAdviceLoading(true); setAdvice("");
    try {
      const r = await fetch("/api/advice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: authToken }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Ошибка");
      setAdvice(d.advice || "Нет рекомендации");
    } catch (e) { setAdvice("⚠️ Не удалось получить совет: " + e.message); }
    setAdviceLoading(false);
  };
  // «Что взять в фуру» — ИИ по вместимости
  const [truckCap, setTruckCap] = useState("");
  const [truckUnit, setTruckUnit] = useState("т"); // т / кг
  const [truckAdvice, setTruckAdvice] = useState("");
  const [truckItems, setTruckItems] = useState([]);
  const [truckPlanned, setTruckPlanned] = useState(false);
  const [truckLoading, setTruckLoading] = useState(false);
  const getTruckAdvice = async () => {
    const kg = Math.round((Number(truckCap) || 0) * (truckUnit === "т" ? 1000 : 1));
    if (kg <= 0) { setTruckAdvice("Укажи вместимость фуры."); return; }
    setTruckLoading(true); setTruckAdvice(""); setTruckItems([]); setTruckPlanned(false);
    try {
      const r = await fetch("/api/advice-truck", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: authToken, capacity_kg: kg }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Ошибка");
      setTruckAdvice(d.advice || "Нет рекомендации");
      setTruckItems(Array.isArray(d.items) ? d.items : []);
    } catch (e) { setTruckAdvice("⚠️ Не удалось получить совет: " + e.message); }
    setTruckLoading(false);
  };
  const planTruck = async () => {
    if (!truckItems.length) return;
    try {
      await dbUpsert("trucks", { id: uid(), date: TODAY(), driver_name: "", car_number: "", whatsapp: "", logist_phone: "", price: 0, note: "Из совета ИИ", items: truckItems.map(i => ({ brand: i.brand, grade: i.grade, bag_kg: Number(i.bag_kg), kg: Number(i.kg) })), status: "запланирована" });
      await reload("trucks");
      setTruckPlanned(true);
    } catch (e) { alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз."); }
  };
  const now = new Date();
  const filterFn = o => {
    const d = new Date(o.date);
    if (period === "week") { const w = new Date(now); w.setDate(w.getDate() - 7); return d >= w; }
    if (period === "month") return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    if (period === "3month") { const m = new Date(now); m.setMonth(m.getMonth() - 3); return d >= m; }
    if (period === "custom") return o.date >= from && o.date <= to; // сравнение строк YYYY-MM-DD работает для диапазона
    return true;
  };
  const filtered = orders.filter(filterFn);
  const delivered = filtered.filter(o => o.status === "отгружена");
  const allDelivered = orders.filter(o => o.status === "отгружена");
  const totalKg = delivered.reduce((s, o) => s + o.bags * o.bag_kg, 0);
  const totalRev = delivered.reduce((s, o) => s + o.bags * o.bag_kg * (o.price_per_kg || 0), 0);
  const ordersCount = new Set(delivered.map(o => (o.clientId || "nm:" + (o.clientName || "")) + "|" + o.date)).size; // заявок по клиентам, не позициям
  // Брак и списания за период (ручные списания со склада с причиной)
  const writeoffs = stock.filter(s => s.weight_kg < 0 && s.reason && filterFn(s));
  const writeoffKg = writeoffs.reduce((sum, s) => sum + Math.abs(s.weight_kg), 0);
  const byReason = {};
  writeoffs.forEach(s => { byReason[s.reason] = (byReason[s.reason] || 0) + Math.abs(s.weight_kg); });
  // Долги клиентов — всё отгруженное и неоплаченное (не зависит от периода)
  const debtByClient = {};
  orders.filter(o => o.status === "отгружена" && !o.paid).forEach(o => { const sum = o.bags * o.bag_kg * (o.price_per_kg || 0); if (sum > 0) debtByClient[o.clientName || "?"] = (debtByClient[o.clientName || "?"] || 0) + sum; });
  (payments || []).forEach(p => { const n = p.clientName || "?"; if (debtByClient[n] != null) debtByClient[n] -= (p.amount || 0); }); // ручные оплаты «в счёт долга»
  const debtList = Object.entries(debtByClient).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const totalDebt = debtList.reduce((s, [, v]) => s + v, 0);
  // Поступления (оплаченные заявки) — всего и по способу нал/безнал
  const paidOrders = orders.filter(o => o.paid && o.bags * o.bag_kg * (o.price_per_kg || 0) > 0);
  const paidTotal = paidOrders.reduce((s, o) => s + o.bags * o.bag_kg * (o.price_per_kg || 0), 0);
  const paidByMethod = {};
  paidOrders.forEach(o => { const m = o.pay_method || "Не указано"; paidByMethod[m] = (paidByMethod[m] || 0) + o.bags * o.bag_kg * (o.price_per_kg || 0); });
  // 📊 По торгпредам: оборот/тоннаж/заявки за период + текущий долг (всё неоплаченное минус оплаты)
  const repsList = (users || []).filter(u => u.role === "rep");
  const ownerByClient = {}; (clients || []).forEach(c => { if (c.ownerId) ownerByClient[c.id] = c.ownerId; });
  const ownerOf = o => ownerByClient[o.clientId] || (o.created_by_role === "rep" ? o.created_by : null); // клиент → его торгпред (или автор-пробник)
  const repAgg = {};
  const repEnsure = id => (repAgg[id] = repAgg[id] || { kg: 0, rev: 0, ordSet: new Set(), cliSet: new Set(), debt: 0 });
  delivered.forEach(o => { const owner = ownerOf(o); if (!owner) return; const a = repEnsure(owner); a.kg += o.bags * o.bag_kg; a.rev += o.bags * o.bag_kg * (o.price_per_kg || 0); a.ordSet.add((o.clientId || "nm:" + (o.clientName || "")) + "|" + o.date); if (o.clientId) a.cliSet.add(o.clientId); });
  orders.filter(o => o.status === "отгружена" && !o.paid).forEach(o => { const owner = ownerOf(o); if (!owner) return; const sum = o.bags * o.bag_kg * (o.price_per_kg || 0); if (sum > 0) repEnsure(owner).debt += sum; });
  (payments || []).forEach(p => { const owner = ownerByClient[p.clientId]; if (owner && repAgg[owner]) repAgg[owner].debt -= (p.amount || 0); });
  const repStats = repsList.map(r => { const a = repAgg[r.id] || { kg: 0, rev: 0, ordSet: new Set(), cliSet: new Set(), debt: 0 }; return { id: r.id, name: r.group_name || r.name, kg: a.kg, rev: a.rev, orders: a.ordSet.size, clientsN: a.cliSet.size, debt: Math.max(0, a.debt) }; }).sort((a, b) => b.rev - a.rev);
  // Расходы за период
  const expInPeriod = expenses.filter(filterFn);
  const expByCat = {};
  expInPeriod.forEach(x => { const k = catName(x.category); expByCat[k] = (expByCat[k] || 0) + (x.amount || 0); });

  // 🎁 «На пробу» — бесплатно отгруженная мука. Оцениваем по закупочной цене (средней из приходов склада).
  const costPerKg = {};
  const costAgg = {};
  stock.filter(s => s.weight_kg > 0 && s.price_per_kg).forEach(s => { const k = `${s.brand}|${s.grade}|${s.bag_kg}`; (costAgg[k] = costAgg[k] || { kg: 0, sum: 0 }); costAgg[k].kg += s.weight_kg; costAgg[k].sum += s.weight_kg * s.price_per_kg; });
  Object.entries(costAgg).forEach(([k, v]) => { costPerKg[k] = v.kg ? v.sum / v.kg : 0; });
  const trialDel = delivered.filter(o => o.trial);
  const trialKg = trialDel.reduce((s, o) => s + o.bags * o.bag_kg, 0);
  const trialCost = Math.round(trialDel.reduce((s, o) => s + o.bags * o.bag_kg * (costPerKg[`${o.brand}|${o.grade}|${o.bag_kg}`] || 0), 0));
  const trialByProduct = {};
  trialDel.forEach(o => { const p = `${o.brand} ${o.grade}`; trialByProduct[p] = (trialByProduct[p] || 0) + o.bags * o.bag_kg; });
  if (trialCost > 0) expByCat["На пробу"] = (expByCat["На пробу"] || 0) + trialCost;
  // Общие расходы = ручные расходы + оценка стоимости проб
  const expTotal = expInPeriod.reduce((s, x) => s + (x.amount || 0), 0) + trialCost;
  // Зарплаты за период — реально выплаченные людям (водители/бригадир/грузчики/зарплата), а не расчётная ставка
  const salaryPaid = expInPeriod.filter(x => ["Водители", "Грузчики", "Зарплата"].includes(x.category)).reduce((s, x) => s + (x.amount || 0), 0);

  // 🔮 Прогноз: спрос по дням недели за последние 8 недель → ожидание на неделю vs остатки
  const WD = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
  const cutoffD = new Date(now); cutoffD.setDate(cutoffD.getDate() - 56);
  const recentDel = orders.filter(o => o.status === "отгружена" && !o.fromKaraganda && new Date(o.date) >= cutoffD);
  const demandWD = {};
  recentDel.forEach(o => { const wd = new Date(o.date).getDay(); const p = `${o.brand} ${o.grade} ${o.bag_kg}кг`; (demandWD[wd] = demandWD[wd] || {})[p] = (demandWD[wd][p] || 0) + o.bags * o.bag_kg; });
  const expectedWk = {};
  for (let i = 1; i <= 7; i++) { const d = new Date(now); d.setDate(d.getDate() + i); const m = demandWD[d.getDay()] || {}; Object.entries(m).forEach(([p, kg]) => { expectedWk[p] = (expectedWk[p] || 0) + kg / 8; }); }
  const stockByProd = {};
  stock.forEach(s => { const p = `${s.brand} ${s.grade} ${s.bag_kg}кг`; stockByProd[p] = (stockByProd[p] || 0) + s.weight_kg; }); // каждая фасовка отдельно
  const restock = Object.entries(expectedWk).map(([p, kg]) => ({ p, exp: Math.round(kg), st: Math.round(stockByProd[p] || 0) })).filter(x => x.exp > 0).sort((a, b) => (b.exp - b.st) - (a.exp - a.st));
  const byClientWD = {};
  recentDel.forEach(o => { const c = o.clientName || "?"; const wd = new Date(o.date).getDay(); const k = byClientWD[c] = byClientWD[c] || {}; const v = k[wd] = k[wd] || { kg: 0, days: new Set() }; v.kg += o.bags * o.bag_kg; v.days.add(o.date); });
  const regulars = [];
  Object.entries(byClientWD).forEach(([c, wds]) => { let best = null; Object.entries(wds).forEach(([wd, v]) => { if (!best || v.days.size > best.days.size) best = { wd: +wd, ...v }; }); if (best && best.days.size >= 2) regulars.push({ c, wd: best.wd, avg: Math.round(best.kg / best.days.size) }); });
  regulars.sort((a, b) => b.avg - a.avg);

  const ds = {};
  delivered.forEach(o => { if (!o.driverId) return; const d = drivers.find(x => x.id === o.driverId); if (!d) return; if (!ds[o.driverId]) ds[o.driverId] = { name: d.name, kg: 0, pay: 0 }; const kg = o.bags * o.bag_kg; ds[o.driverId].kg += kg; ds[o.driverId].pay += kg * d.rate_per_kg; });
  const totalPay = Object.values(ds).reduce((s, d) => s + d.pay, 0);
  // Из Караганды — напрямую клиенту: в объём/деньги входит, но в закуп для Астаны НЕ берём
  const deliveredKaraganda = delivered.filter(o => o.fromKaraganda);
  const karagandaKg = deliveredKaraganda.reduce((s, o) => s + o.bags * o.bag_kg, 0);
  const karagandaSum = deliveredKaraganda.reduce((s, o) => s + o.bags * o.bag_kg * (o.price_per_kg || 0), 0);
  const bp = {}, bw = {}, bc = {};
  delivered.forEach(o => {
    const kg = o.bags * o.bag_kg; const rev = kg * (o.price_per_kg || 0);
    if (!o.fromKaraganda) { // приоритеты закупа и фасовки — только по своему складу
      const pk = `${o.brand} · ${o.grade}`; if (!bp[pk]) bp[pk] = { kg: 0, revenue: 0, orders: 0 }; bp[pk].kg += kg; bp[pk].revenue += rev; bp[pk].orders += 1;
      const wk = `${o.bag_kg} кг мешки`; if (!bw[wk]) bw[wk] = { kg: 0, bags: 0 }; bw[wk].kg += kg; bw[wk].bags += o.bags;
    }
    const ck = o.clientName || "?"; if (!bc[ck]) bc[ck] = { kg: 0, revenue: 0 }; bc[ck].kg += kg; bc[ck].revenue += rev;
  });
  const pl = Object.entries(bp).sort((a, b) => b[1].kg - a[1].kg);
  const wl = Object.entries(bw).sort((a, b) => b[1].kg - a[1].kg);
  const cl = Object.entries(bc).sort((a, b) => b[1].kg - a[1].kg);
  // 📊 Детальная статистика продаж: бренд → сорт → фасовка (за выбранный период)
  const brandTree = {};
  delivered.forEach(o => {
    const kg = o.bags * o.bag_kg, rev = kg * (o.price_per_kg || 0);
    const b = brandTree[o.brand] = brandTree[o.brand] || { kg: 0, rev: 0, bags: 0, grades: {} };
    b.kg += kg; b.rev += rev; b.bags += Number(o.bags) || 0;
    const g = b.grades[o.grade] = b.grades[o.grade] || { kg: 0, rev: 0, bags: 0, packs: {} };
    g.kg += kg; g.rev += rev; g.bags += Number(o.bags) || 0;
    const p = g.packs[o.bag_kg] = g.packs[o.bag_kg] || { kg: 0, rev: 0, bags: 0 };
    p.kg += kg; p.rev += rev; p.bags += Number(o.bags) || 0;
  });
  const gradeOrder = g => { const i = GRADES.indexOf(g); return i === -1 ? 99 : i; }; // Высший, потом Первый
  const downloadGradeDetail = () => {
    const esc2 = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [["Бренд", "Сорт", "Фасовка кг", "Мешков", "Кг", "Сумма тг", "Ср. цена тг/кг", "Доля объёма %"]];
    Object.entries(brandTree).sort((a, b) => a[0].localeCompare(b[0], "ru")).forEach(([brand, b]) =>
      Object.entries(b.grades).sort((a, b) => gradeOrder(a[0]) - gradeOrder(b[0])).forEach(([grade, g]) =>
        Object.entries(g.packs).sort((a, b) => Number(b[0]) - Number(a[0])).forEach(([pk, p]) =>
          rows.push([brand, grade, pk, p.bags, p.kg, Math.round(p.rev), p.kg ? Math.round(p.rev / p.kg) : 0, totalKg ? (p.kg / totalKg * 100).toFixed(1) : 0]))));
    downloadFile(`Отчёт_бренды_сорта_фасовки_${TODAY()}.csv`, "﻿" + rows.map(r => r.map(esc2).join(";")).join("\r\n"), "text/csv;charset=utf-8");
  };

  // 🔍 Свой отчёт: продажи за период с фильтрами бренд/сорт/фасовки
  const repFiltered = delivered.filter(o =>
    (repBrand === "all" || o.brand === repBrand) &&
    (repGrade === "all" || o.grade === repGrade) &&
    (repPacks.length === 0 || repPacks.includes(Number(o.bag_kg))));
  const repKg = repFiltered.reduce((s, o) => s + o.bags * o.bag_kg, 0);
  const repBags = repFiltered.reduce((s, o) => s + (Number(o.bags) || 0), 0);
  const repRev = repFiltered.reduce((s, o) => s + o.bags * o.bag_kg * (o.price_per_kg || 0), 0);
  const repOrdersCount = new Set(repFiltered.map(o => (o.clientId || "nm:" + (o.clientName || "")) + "|" + o.date)).size;
  const repDays = new Set(repFiltered.map(o => o.date)).size;
  // Средняя цена продаж — взвешенная по объёму, бесплатные (пробы) не считаем
  const repPricedKg = repFiltered.filter(o => (o.price_per_kg || 0) > 0).reduce((s, o) => s + o.bags * o.bag_kg, 0);
  const repAvgPrice = repPricedKg ? repRev / repPricedKg : 0;
  const repPriceList = [...new Set(repFiltered.filter(o => (o.price_per_kg || 0) > 0).map(o => o.price_per_kg))];
  const repMinPrice = repPriceList.length ? Math.min(...repPriceList) : 0;
  const repMaxPrice = repPriceList.length ? Math.max(...repPriceList) : 0;
  const repByClient = {};
  repFiltered.forEach(o => { const k = o.clientName || "?"; if (!repByClient[k]) repByClient[k] = { kg: 0, bags: 0, rev: 0 }; repByClient[k].kg += o.bags * o.bag_kg; repByClient[k].bags += Number(o.bags) || 0; repByClient[k].rev += o.bags * o.bag_kg * (o.price_per_kg || 0); });
  const repClients = Object.entries(repByClient).sort((a, b) => b[1].kg - a[1].kg);
  const repByDate = {};
  repFiltered.forEach(o => { if (!repByDate[o.date]) repByDate[o.date] = { kg: 0, rev: 0 }; repByDate[o.date].kg += o.bags * o.bag_kg; repByDate[o.date].rev += o.bags * o.bag_kg * (o.price_per_kg || 0); });
  const repDates = Object.entries(repByDate).sort((a, b) => b[0].localeCompare(a[0]));
  const repFilterName = `${repBrand === "all" ? "все бренды" : repBrand} · ${repGrade === "all" ? "все сорта" : repGrade} · ${repPacks.length ? repPacks.join("+") + " кг" : "все фасовки"}`;
  const downloadRep = () => {
    const esc2 = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [["Фильтр", repFilterName], ["Итого кг", repKg], ["Мешков", repBags], ["Сумма тг", Math.round(repRev)], ["Средняя цена тг/кг", Math.round(repAvgPrice)], [],
      ["Клиент", "Мешков", "Кг", "Сумма тг", "Ср. цена тг/кг", "Доля %"]];
    repClients.forEach(([name, v]) => rows.push([name, v.bags, v.kg, Math.round(v.rev), v.kg ? Math.round(v.rev / v.kg) : 0, repKg ? (v.kg / repKg * 100).toFixed(1) : 0]));
    rows.push([]);
    rows.push(["Дата", "Кг", "Сумма тг"]);
    repDates.forEach(([d, v]) => rows.push([d, v.kg, Math.round(v.rev)]));
    downloadFile(`Свой_отчёт_${TODAY()}.csv`, "﻿" + rows.map(r => r.map(esc2).join(";")).join("\r\n"), "text/csv;charset=utf-8");
  };
  const maxP = Math.max(...pl.map(([, v]) => v.kg), 1), maxW = Math.max(...wl.map(([, v]) => v.kg), 1), maxC = Math.max(...cl.map(([, v]) => v.kg), 1);
  const TD = 14;
  const td = Array.from({ length: TD }, (_, i) => { const d = new Date(now); d.setDate(d.getDate() - (TD - 1 - i)); const ds2 = d.toISOString().split("T")[0]; return { date: ds2, label: `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, "0")}`, kg: allDelivered.filter(o => o.date === ds2).reduce((s, o) => s + o.bags * o.bag_kg, 0) }; });
  const maxT = Math.max(...td.map(d => d.kg), 1);
  const bc2 = ["bg-amber-400", "bg-orange-400", "bg-yellow-400", "bg-amber-600", "bg-orange-300"];

  const periodPicker = (
    <div className="space-y-2">
      <div className="flex gap-2 flex-wrap">
        {[["week", "7 дней"], ["month", "Месяц"], ["3month", "3 месяца"], ["all", "Всё время"], ["custom", "Свой период"]].map(([v, l]) => (
          <button key={v} onClick={() => setPeriod(v)} className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${period === v ? "bg-amber-500 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>{l}</button>
        ))}
      </div>
      {period === "custom" && (
        <div className="flex items-center gap-2 flex-wrap bg-white border border-gray-100 rounded-xl p-3">
          <span className="text-sm text-gray-500">с</span>
          <Inp type="date" value={from} onChange={e => setFrom(e.target.value)} />
          <span className="text-sm text-gray-500">по</span>
          <Inp type="date" value={to} onChange={e => setTo(e.target.value)} />
        </div>
      )}
    </div>
  );

  // 🧑‍💼 Торгпред: своя детальная аналитика — оборот/тоннаж/что берут/кто берёт/долг за период
  if (repMode) {
    return (
      <div className="space-y-5">
        <h3 className="font-display font-semibold text-gray-800 flex items-center gap-1.5"><Icon name="chart" size={18} />Моя аналитика</h3>
        {periodPicker}
        <RepAnalytics delivered={delivered} allMine={orders} payments={payments} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {periodPicker}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-gradient-to-br from-emerald-50 to-green-100 rounded-2xl p-4"><div className="text-xs text-emerald-700 font-medium">Отгружено</div><div className="text-2xl font-bold text-emerald-800">{fmt(totalKg)} кг</div></div>
        <div className="bg-gradient-to-br from-amber-50 to-orange-100 rounded-2xl p-4"><div className="text-xs text-amber-700 font-medium">Сумма отгрузок</div><div className="text-2xl font-bold text-amber-800">{fmt(totalRev)} тг</div></div>
        <div className="bg-gradient-to-br from-blue-50 to-blue-100 rounded-2xl p-4"><div className="text-xs text-blue-700 font-medium">Заявок</div><div className="text-2xl font-bold text-blue-800">{ordersCount}</div></div>
        <div className="bg-gradient-to-br from-purple-50 to-purple-100 rounded-2xl p-4"><div className="text-xs text-purple-700 font-medium">Зарплаты (выплачено)</div><div className="text-2xl font-bold text-purple-800">{fmt(salaryPaid)} тг</div></div>
      </div>

      {pl.length > 0 && totalKg > 0 && (
        <div className="bg-gradient-to-br from-indigo-50 to-blue-50 border border-indigo-100 rounded-2xl p-4">
          <div className="font-display font-semibold text-gray-800 mb-2 flex items-center gap-1.5"><Icon name="target" size={16} />Приоритеты закупа за период</div>
          <div className="space-y-1.5 text-sm">
            {pl.slice(0, 3).map(([name, v], i) => (
              <div key={name} className="flex items-center justify-between">
                <span>{i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉"} {name}</span>
                <span className="font-medium">{Math.round(v.kg / totalKg * 100)}% · {fmt(v.kg)} кг</span>
              </div>
            ))}
          </div>
          <div className="text-xs text-gray-600 mt-2">
            Чаще всего уходит <b>{pl[0][0]}</b> ({Math.round(pl[0][1].kg / totalKg * 100)}% объёма){wl.length > 0 ? <>, фасовка <b>{wl[0][0]}</b></> : null}. Держи в приоритете при заказе.
          </div>
        </div>
      )}

      {repStats.length > 0 && (
        <div className="bg-white border border-gray-100 rounded-2xl p-4">
          <div className="font-display font-semibold text-gray-800 flex items-center gap-1.5 mb-3"><Icon name="user" size={16} />По торгпредам <span className="text-xs font-normal text-gray-400">· нажми на торгпреда для подробностей</span></div>
          <div className="space-y-3">
            {repStats.map(r => (
              <button key={r.id} onClick={() => setSelRep(selRep === r.id ? "" : r.id)} className={`w-full text-left border rounded-xl p-3 transition-all ${selRep === r.id ? "border-amber-300 bg-amber-50" : "border-gray-100 hover:bg-gray-50"}`}>
                <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                  <span className="font-semibold text-gray-800 flex items-center gap-1.5"><Icon name={selRep === r.id ? "chart" : "user"} size={14} />{r.name}</span>
                  <span className="text-xs text-gray-400">{r.orders} заявок · {r.clientsN} клиентов</span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="bg-emerald-50 rounded-lg py-2 px-1"><div className="text-[11px] text-emerald-700">Оборот</div><div className="font-display font-semibold text-emerald-800 text-sm">{fmt(Math.round(r.rev))} тг</div></div>
                  <div className="bg-gray-50 rounded-lg py-2 px-1"><div className="text-[11px] text-gray-500">Отгружено</div><div className="font-display font-semibold text-gray-800 text-sm">{fmt(r.kg)} кг</div></div>
                  <div className={`rounded-lg py-2 px-1 ${r.debt > 0 ? "bg-red-50" : "bg-gray-50"}`}><div className={`text-[11px] ${r.debt > 0 ? "text-red-600" : "text-gray-500"}`}>Долг</div><div className={`font-display font-semibold text-sm ${r.debt > 0 ? "text-red-700" : "text-gray-800"}`}>{fmt(Math.round(r.debt))} тг</div></div>
                </div>
              </button>
            ))}
          </div>
          <div className="text-xs text-gray-400 mt-2">Оборот и тоннаж — за выбранный период. Долг — текущий (всё неоплаченное минус оплаты).</div>
        </div>
      )}
      {selRep && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h4 className="font-display font-semibold text-gray-800 flex items-center gap-1.5"><Icon name="chart" size={17} />{repStats.find(r => r.id === selRep)?.name || "Торгпред"} — подробно</h4>
            <button onClick={() => setSelRep("")} className="text-xs text-gray-500 hover:text-gray-700 inline-flex items-center gap-1"><Icon name="close" size={13} />закрыть</button>
          </div>
          <RepAnalytics delivered={delivered.filter(o => ownerOf(o) === selRep)} allMine={orders.filter(o => ownerOf(o) === selRep)} payments={(payments || []).filter(p => ownerByClient[p.clientId] === selRep)} />
        </div>
      )}

      {totalKg > 0 && Object.keys(brandTree).length > 0 && (
        <div className="bg-white border border-gray-100 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-1">
            <div className="font-display font-semibold text-gray-800 flex items-center gap-1.5"><Icon name="chart" size={16} />По брендам, сортам и фасовкам</div>
            <button onClick={downloadGradeDetail} className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg px-3 py-1.5 font-medium inline-flex items-center gap-1"><Icon name="download" size={13} />Excel</button>
          </div>
          <div className="text-xs text-gray-400 mb-3">Продажи за выбранный период.</div>
          <div className="space-y-5">
            {Object.entries(brandTree).sort((a, b) => a[0].localeCompare(b[0], "ru")).map(([brand, b]) => (
              <div key={brand}>
                <div className="flex items-end justify-between border-b-2 border-amber-300 pb-1">
                  <span className="text-xl font-black text-gray-900">{brand}</span>
                  <span className="text-sm text-gray-600"><b>{fmt(b.kg)} кг</b> · {fmt(b.rev)} тг · {Math.round(b.kg / totalKg * 100)}%</span>
                </div>
                {Object.entries(b.grades).sort((a2, b2) => gradeOrder(a2[0]) - gradeOrder(b2[0])).map(([grade, g]) => (
                  <div key={grade} className="mt-2">
                    <div className="flex items-center justify-between text-sm font-bold text-amber-800">
                      <span>{grade === "Высший сорт" ? "⭐" : "🌾"} {grade}</span>
                      <span className="font-semibold text-gray-500">{fmt(g.kg)} кг</span>
                    </div>
                    <div className="grid grid-cols-[3.2rem_1fr_1fr_1.3fr] gap-x-2 text-[11px] text-gray-400 mt-1 px-1">
                      <span>фасовка</span><span className="text-right">мешков</span><span className="text-right">кг</span><span className="text-right">сумма</span>
                    </div>
                    {Object.entries(g.packs).sort((a2, b2) => Number(b2[0]) - Number(a2[0])).map(([pk, p]) => (
                      <div key={pk} className="grid grid-cols-[3.2rem_1fr_1fr_1.3fr] gap-x-2 items-center text-sm py-1 px-1 border-b border-gray-50 last:border-b-0">
                        <span className="font-semibold text-gray-900">{pk} кг</span>
                        <span className="text-right text-gray-600">{fmt(p.bags)}</span>
                        <span className="text-right font-semibold text-gray-800">{fmt(p.kg)}</span>
                        <span className="text-right text-gray-600">{fmt(Math.round(p.rev))} тг</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-white border border-gray-100 rounded-2xl p-4">
        <div className="flex items-center justify-between mb-1">
          <div className="font-bold text-gray-800">🔍 Свой отчёт</div>
          {repFiltered.length > 0 && <button onClick={downloadRep} className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg px-3 py-1.5 font-medium">⬇️ Excel</button>}
        </div>
        <div className="text-xs text-gray-400 mb-2">Дни выбираются периодом сверху (в т.ч. «Свой период» — любые даты). Фасовок можно отметить несколько — нажимай по очереди, повторное нажатие снимает выбор.</div>
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-gray-500 w-14">Бренд:</span>
            {[["all", "Все"], ...BRANDS.map(b => [b, b])].map(([v, l]) => (
              <button key={v} onClick={() => setRepBrand(v)} className={`text-xs px-3 py-1.5 rounded-full font-medium ${repBrand === v ? "bg-amber-500 text-white" : "bg-gray-100 text-gray-600"}`}>{l}</button>
            ))}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-gray-500 w-14">Сорт:</span>
            {[["all", "Все"], ...GRADES.map(g => [g, g])].map(([v, l]) => (
              <button key={v} onClick={() => setRepGrade(v)} className={`text-xs px-3 py-1.5 rounded-full font-medium ${repGrade === v ? "bg-amber-500 text-white" : "bg-gray-100 text-gray-600"}`}>{l}</button>
            ))}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-gray-500 w-14">Фасовка:</span>
            <button onClick={() => setRepPacks([])} className={`text-xs px-3 py-1.5 rounded-full font-medium ${repPacks.length === 0 ? "bg-amber-500 text-white" : "bg-gray-100 text-gray-600"}`}>Все</button>
            {[...WEIGHTS].sort((a, b) => b - a).map(w => (
              <button key={w} onClick={() => setRepPacks(p => p.includes(w) ? p.filter(x => x !== w) : [...p, w])} className={`text-xs px-3 py-1.5 rounded-full font-medium ${repPacks.includes(w) ? "bg-amber-500 text-white" : "bg-gray-100 text-gray-600"}`}>{w} кг</button>
            ))}
          </div>
        </div>
        {repFiltered.length === 0 ? (
          <div className="text-center py-6 text-gray-400 text-sm">По этим фильтрам за выбранный период продаж нет.</div>
        ) : (
          <div className="mt-3 space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-emerald-50 rounded-xl p-3"><div className="text-xs text-emerald-700">Отгружено</div><div className="text-lg font-bold text-emerald-800">{fmt(repKg)} кг</div><div className="text-xs text-gray-500">{fmt(repBags)} мешков</div></div>
              <div className="bg-amber-50 rounded-xl p-3"><div className="text-xs text-amber-700">Сумма</div><div className="text-lg font-bold text-amber-800">{fmt(Math.round(repRev))} тг</div><div className="text-xs text-gray-500">{repOrdersCount} заявок</div></div>
              <div className="bg-blue-50 rounded-xl p-3"><div className="text-xs text-blue-700">Средняя цена продаж</div><div className="text-lg font-bold text-blue-800">{fmt(Math.round(repAvgPrice))} тг/кг</div>{repMinPrice !== repMaxPrice && <div className="text-xs text-gray-500">от {fmt(repMinPrice)} до {fmt(repMaxPrice)} тг/кг</div>}</div>
              <div className="bg-purple-50 rounded-xl p-3"><div className="text-xs text-purple-700">Средние</div><div className="text-sm font-bold text-purple-800">~{fmt(repDays ? Math.round(repKg / repDays) : 0)} кг/день</div><div className="text-xs text-gray-500">{repDays} дн. с продажами · ~{fmt(repOrdersCount ? Math.round(repKg / repOrdersCount) : 0)} кг/заявка</div></div>
            </div>
            <div>
              <div className="text-sm font-bold text-gray-700 mb-1">Кому ушло</div>
              <div className="grid grid-cols-[1fr_4rem_4.5rem_3rem] gap-x-2 text-[11px] text-gray-400 px-1">
                <span>клиент</span><span className="text-right">кг</span><span className="text-right">сумма</span><span className="text-right">доля</span>
              </div>
              <div className="max-h-64 overflow-y-auto">
                {repClients.map(([name, v]) => (
                  <div key={name} className="grid grid-cols-[1fr_4rem_4.5rem_3rem] gap-x-2 items-center text-sm py-1 px-1 border-b border-gray-50 last:border-b-0">
                    <span className="text-gray-800 truncate">{name}</span>
                    <span className="text-right font-semibold">{fmt(v.kg)}</span>
                    <span className="text-right text-gray-600">{fmt(Math.round(v.rev))}</span>
                    <span className="text-right text-gray-500">{repKg ? Math.round(v.kg / repKg * 100) : 0}%</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="text-sm font-bold text-gray-700 mb-1">По дням</div>
              <div className="max-h-48 overflow-y-auto">
                {repDates.map(([d, v]) => (
                  <div key={d} className="flex items-center justify-between text-sm py-1 px-1 border-b border-gray-50 last:border-b-0">
                    <span className="text-gray-600">{d.split("-").reverse().join(".")}</span>
                    <span><b>{fmt(v.kg)} кг</b> · <span className="text-gray-500">{fmt(Math.round(v.rev))} тг</span></span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {writeoffKg > 0 && (
        <div className="bg-gradient-to-br from-red-50 to-orange-50 border border-red-100 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="font-display font-semibold text-gray-800 flex items-center gap-1.5"><Icon name="trash" size={16} />Брак и списания за период</div>
            <div className="text-lg font-bold text-red-600">{fmt(writeoffKg)} кг</div>
          </div>
          <div className="space-y-1 text-sm">
            {Object.entries(byReason).sort((a, b) => b[1] - a[1]).map(([reason, kg]) => (
              <div key={reason} className="flex items-center justify-between">
                <span className="text-gray-600">{reason}</span>
                <span className="font-medium">{fmt(kg)} кг ({Math.round(kg / writeoffKg * 100)}%)</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {trialKg > 0 && (
        <div className="bg-gradient-to-br from-orange-50 to-amber-50 border border-orange-100 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="font-display font-semibold text-gray-800 flex items-center gap-1.5"><Icon name="gift" size={16} />На пробу (бесплатно) за период</div>
            <div className="text-right"><div className="text-lg font-bold text-orange-600">{fmt(trialKg)} кг</div>{trialCost > 0 && <div className="text-xs text-gray-500">≈ {fmt(trialCost)} тг по закупке</div>}</div>
          </div>
          <div className="space-y-1 text-sm">
            {Object.entries(trialByProduct).sort((a, b) => b[1] - a[1]).map(([p, kg]) => (
              <div key={p} className="flex items-center justify-between">
                <span className="text-gray-600">{p}</span>
                <span className="font-medium">{fmt(kg)} кг</span>
              </div>
            ))}
          </div>
          <div className="text-xs text-gray-400 mt-2">Везём клиентам на пробу бесплатно. Стоимость оценена по средней закупочной цене и учтена в расходах.</div>
        </div>
      )}

      {karagandaKg > 0 && (
        <div className="bg-gradient-to-br from-orange-50 to-amber-50 border border-orange-100 rounded-2xl p-4">
          <div className="flex items-center justify-between">
            <div className="font-display font-semibold text-gray-800 flex items-center gap-1.5"><Icon name="store" size={16} />Из Караганды (напрямую клиентам)</div>
            <div className="text-right"><div className="text-lg font-bold text-orange-600">{fmt(karagandaKg)} кг</div>{karagandaSum > 0 && <div className="text-xs text-gray-500">{fmt(karagandaSum)} тг</div>}</div>
          </div>
          <div className="text-xs text-gray-500 mt-2">Входит в объём и деньги, но склад Астаны не трогает и в закуп не считается.</div>
        </div>
      )}

      {paidTotal > 0 && (
        <div className="bg-gradient-to-br from-emerald-50 to-green-50 border border-emerald-100 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="font-display font-semibold text-gray-800 flex items-center gap-1.5"><Icon name="cash" size={16} />Приход от клиентов (всего)</div>
            <div className="text-lg font-bold text-emerald-700">{fmt(paidTotal)} тг</div>
          </div>
          <div className="space-y-1 text-sm">
            {Object.entries(paidByMethod).sort((a, b) => b[1] - a[1]).map(([m, v]) => (
              <div key={m} className="flex items-center justify-between">
                <span className="text-gray-600">{m}</span>
                <span className="font-medium">{fmt(v)} тг</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {totalDebt > 0 && (
        <div className="bg-gradient-to-br from-rose-50 to-red-50 border border-rose-100 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="font-display font-semibold text-gray-800 flex items-center gap-1.5"><Icon name="wallet" size={16} />Долги клиентов (всего)</div>
            <div className="text-lg font-bold text-red-600">{fmt(totalDebt)} тг</div>
          </div>
          <div className="space-y-1 text-sm">
            {debtList.map(([name, v]) => (
              <div key={name} className="flex items-center justify-between">
                <span className="text-gray-600">{name}</span>
                <span className="font-medium text-red-600">{fmt(v)} тг</span>
              </div>
            ))}
          </div>
          <div className="text-xs text-gray-400 mt-2">Отметить оплату — во вкладке «Клиенты» → История и оплаты.</div>
        </div>
      )}

      {expTotal > 0 && (
        <div className="bg-gradient-to-br from-slate-50 to-gray-100 border border-gray-200 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="font-display font-semibold text-gray-800 flex items-center gap-1.5"><Icon name="expense" size={16} />Расходы за период</div>
            <div className="text-lg font-bold text-gray-700">{fmt(expTotal)} тг</div>
          </div>
          <div className="space-y-1 text-sm">
            {Object.entries(expByCat).sort((a, b) => b[1] - a[1]).map(([cat, v]) => (
              <div key={cat} className="flex items-center justify-between">
                <span className="text-gray-600">{cat}</span>
                <span className="font-medium">{fmt(v)} тг</span>
              </div>
            ))}
          </div>
          {totalRev > 0 && <div className="text-xs text-gray-500 mt-2 pt-2 border-t border-gray-200">Сумма отгрузок {fmt(totalRev)} − расходы {fmt(expTotal)} = <b className={totalRev - expTotal >= 0 ? "text-emerald-600" : "text-red-600"}>{fmt(totalRev - expTotal)} тг</b></div>}
        </div>
      )}

      <div className="bg-gradient-to-br from-violet-50 to-indigo-50 border border-violet-100 rounded-2xl p-4">
        <div className="font-bold text-gray-800 mb-2">🔮 Прогноз и рекомендации</div>
        {recentDel.length < 3 ? (
          <div className="text-sm text-gray-500">Пока мало отгрузок для прогноза — он появится, когда накопится статистика за 2–4 недели.</div>
        ) : (
          <>
            {restock.some(x => x.exp - x.st > 0) && (
              <div className="bg-red-100 border border-red-200 rounded-xl p-3 mb-3">
                <div className="font-semibold text-red-700 text-sm mb-1">⚠️ Пора заказать муку — на следующую неделю может не хватить:</div>
                <div className="space-y-0.5 text-sm">
                  {restock.filter(x => x.exp - x.st > 0).map(x => (
                    <div key={x.p} className="text-red-700">• <b>{x.p}</b>: нужно ~{fmt(x.exp)} кг, на складе {fmt(x.st)} → закажи ещё ~{fmt(x.exp - x.st)} кг</div>
                  ))}
                </div>
              </div>
            )}
            {regulars.length > 0 && (
              <div className="mb-3">
                <div className="text-xs font-semibold text-gray-500 mb-1">Постоянные клиенты (по дням)</div>
                <div className="space-y-0.5 text-sm">
                  {regulars.slice(0, 6).map(r => <div key={r.c} className="flex items-center justify-between"><span>{r.c}</span><span className="text-gray-500">обычно {WD[r.wd]} · ~{fmt(r.avg)} кг</span></div>)}
                </div>
              </div>
            )}
            {restock.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-gray-500 mb-1">Ожидается на неделю vs склад (в кг)</div>
                <div className="space-y-0.5 text-sm">
                  {restock.map(x => { const need = x.exp - x.st; return (
                    <div key={x.p} className="flex items-center justify-between">
                      <span>{x.p}</span>
                      <span className={need > 0 ? "text-red-600 font-medium" : "text-gray-500"}>ожид. ~{fmt(x.exp)} кг · склад {fmt(x.st)} кг{need > 0 ? ` → докупить ~${fmt(need)} кг` : " ✓"}</span>
                    </div>
                  ); })}
                </div>
              </div>
            )}
          </>
        )}
        <div className="mt-3 pt-3 border-t border-violet-100">
          <Btn size="sm" onClick={getAdvice} disabled={adviceLoading}>{adviceLoading ? "Думаю..." : <><Icon name="sparkle" size={15} />Совет на неделю</>}</Btn>
          {advice && <div className="mt-2 bg-white rounded-xl p-3 text-sm text-gray-700 whitespace-pre-wrap">{cleanAdvice(advice)}</div>}
        </div>
        <div className="mt-3 pt-3 border-t border-violet-100">
          <div className="font-medium text-gray-800 mb-2 flex items-center gap-1.5"><Icon name="truck" size={15} />Что взять в фуру</div>
          <div className="flex items-center gap-2 flex-wrap">
            <input type="number" value={truckCap} onChange={e => setTruckCap(e.target.value)} placeholder="вместимость" className="w-28 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300" />
            <div className="flex">
              <button onClick={() => setTruckUnit("т")} className={`px-3 py-2 text-sm rounded-l-lg ${truckUnit === "т" ? "bg-amber-500 text-white" : "bg-gray-100 text-gray-600"}`}>тонн</button>
              <button onClick={() => setTruckUnit("кг")} className={`px-3 py-2 text-sm rounded-r-lg ${truckUnit === "кг" ? "bg-amber-500 text-white" : "bg-gray-100 text-gray-600"}`}>кг</button>
            </div>
            <Btn size="sm" onClick={getTruckAdvice} disabled={truckLoading}>{truckLoading ? "Думаю..." : "Подобрать"}</Btn>
          </div>
          {truckAdvice && <div className="mt-2 bg-white rounded-xl p-3 text-sm text-gray-700 whitespace-pre-wrap">{cleanAdvice(truckAdvice)}</div>}
          {canEdit && truckItems.length > 0 && (truckPlanned
            ? <div className="mt-2 text-sm text-emerald-700 font-medium">✓ Фура запланирована — поправь дату/фуриста/цену в разделе «Поставки».</div>
            : <div className="mt-2"><Btn size="sm" onClick={planTruck}><Icon name="truck" size={15} />Запланировать эту фуру</Btn></div>)}
        </div>
      </div>

      <div className="bg-white border border-gray-100 rounded-2xl shadow-sm overflow-hidden">
        <div className="flex border-b border-gray-100 overflow-x-auto">
          {[["product", "По продукту"], ["pack", "По фасовке"], ["client", "По клиентам"], ["trend", "Динамика"]].map(([v, l]) => (
            <button key={v} onClick={() => setView(v)} className={`flex-shrink-0 px-4 py-3 text-xs font-semibold border-b-2 transition-all ${view === v ? "border-amber-500 text-amber-600 bg-amber-50" : "border-transparent text-gray-500"}`}>{l}</button>
          ))}
        </div>
        <div className="p-4 space-y-3">
          {view === "product" && <>{pl.length === 0 ? <div className="text-center py-8 text-gray-400 text-sm">Нет данных</div> : pl.map(([name, v], i) => <div key={name} className="space-y-1"><div className="flex items-center justify-between text-sm"><div className="flex items-center gap-2"><span className="text-lg">{i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "  "}</span><span className="font-medium">{name}</span></div><div><span className="font-bold">{fmt(v.kg)} кг</span><span className="text-gray-400 text-xs ml-2">{v.orders} заявок</span></div></div><MiniBar value={v.kg} max={maxP} color={bc2[i % bc2.length]} /><div className="text-xs text-gray-400 text-right">Выручка: {fmt(v.revenue)} тг</div></div>)}</>}
          {view === "pack" && <>{wl.length === 0 ? <div className="text-center py-8 text-gray-400 text-sm">Нет данных</div> : wl.map(([name, v], i) => <div key={name} className="space-y-1"><div className="flex items-center justify-between text-sm"><div className="flex items-center gap-2"><span className="text-lg">{i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "  "}</span><span className="font-medium">{name}</span></div><div><span className="font-bold">{fmt(v.bags)} мешков</span><span className="text-gray-400 text-xs ml-2">= {fmt(v.kg)} кг</span></div></div><MiniBar value={v.kg} max={maxW} color={bc2[i % bc2.length]} /></div>)}{wl.length > 0 && totalKg > 0 && <div className="bg-amber-50 rounded-xl p-3 text-xs text-amber-800">💡 Топ фасовка: <b>{wl[0][0]}</b> — {Math.round(wl[0][1].kg / totalKg * 100)}%</div>}</>}
          {view === "client" && <>{cl.length === 0 ? <div className="text-center py-8 text-gray-400 text-sm">Нет данных</div> : cl.slice(0, 10).map(([name, v], i) => <div key={name} className="space-y-1"><div className="flex items-center justify-between text-sm"><div className="flex items-center gap-2"><span className="w-5 text-xs font-bold text-gray-400">#{i + 1}</span><span className="font-medium">{name}</span></div><div><span className="font-bold">{fmt(v.kg)} кг</span><span className="text-gray-400 text-xs ml-2">{fmt(v.revenue)} тг</span></div></div><MiniBar value={v.kg} max={maxC} color={i === 0 ? "bg-emerald-500" : bc2[i % bc2.length]} /></div>)}</>}
          {view === "trend" && <>
            <p className="text-xs text-gray-400">Отгрузки за последние {TD} дней</p>
            <div className="flex items-end gap-1 h-28">
              {td.map(d => { const pct = maxT > 0 ? (d.kg / maxT) * 100 : 0; return (<div key={d.date} className="flex-1 flex flex-col items-center gap-1 group relative"><div className="w-full flex items-end justify-center" style={{ height: "80px" }}><div className={`w-full rounded-t-md ${d.date === TODAY() ? "bg-amber-500" : d.kg > 0 ? "bg-amber-300" : "bg-gray-100"}`} style={{ height: `${Math.max(pct, d.kg > 0 ? 4 : 0)}%` }} /></div>{d.kg > 0 && <div className="absolute -top-5 left-1/2 -translate-x-1/2 bg-gray-800 text-white text-xs px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 whitespace-nowrap z-10 pointer-events-none">{fmt(d.kg)} кг</div>}<span style={{ fontSize: "9px" }} className="text-gray-400">{d.label}</span></div>); })}
            </div>
            <div className="flex justify-between text-xs text-gray-400 mt-1"><span>Макс: {fmt(maxT)} кг</span><span>Среднее/день: {fmt(Math.round(td.reduce((s, d) => s + d.kg, 0) / TD))} кг</span></div>
          </>}
        </div>
      </div>
      {Object.keys(ds).length > 0 && <div><h4 className="font-semibold text-gray-700 mb-3">Расчёт с водителями</h4><div className="space-y-2">{Object.values(ds).map((d, i) => <div key={i} className="bg-white border border-gray-100 rounded-xl px-4 py-3 flex items-center justify-between"><div><div className="font-medium flex items-center gap-1.5"><Icon name="truck" size={15} />{d.name}</div><div className="text-sm text-gray-500">{fmt(d.kg)} кг</div></div><div className="text-emerald-600 font-bold">{fmt(d.pay)} тг</div></div>)}</div></div>}
      <div><h4 className="font-semibold text-gray-700 mb-3">Маршрутный лист</h4>{filtered.length === 0 ? <div className="text-center py-8 text-gray-400">Нет заявок</div> : (() => {
        const groups = {};
        [...filtered].sort((a, b) => a.date.localeCompare(b.date)).forEach(o => { const key = (o.clientId || "nm:" + (o.clientName || "")) + "|" + o.date; (groups[key] = groups[key] || { clientName: o.clientName, date: o.date, orders: [] }).orders.push(o); });
        return <div className="space-y-2">{Object.values(groups).map((g, i) => {
          const driver = drivers.find(d => d.id === g.orders[0].driverId);
          const statuses = [...new Set(g.orders.map(o => o.status))];
          const st = statuses.length === 1 ? statuses[0] : "частично";
          const kg = g.orders.reduce((s, o) => s + o.bags * o.bag_kg, 0);
          return (<div key={i} className="bg-white border border-gray-100 rounded-xl px-4 py-3 text-sm">
            <div className="flex items-center justify-between flex-wrap gap-2"><div><span className="font-medium">{g.clientName}</span><span className="text-gray-400 ml-2">{g.date}</span></div><Badge color={{ "новая": "blue", "в пути": "yellow", "отгружена": "green", "отменена": "red", "частично": "gray" }[st] || "gray"}>{st}</Badge></div>
            {g.orders.map(o => <div key={o.id} className="text-gray-500 mt-0.5">{o.brand} {o.grade} {o.bag_kg}кг × {o.bags} = {fmt(o.bags * o.bag_kg)}кг</div>)}
            <div className="text-xs text-gray-400 mt-1">Итого {fmt(kg)} кг{driver ? ` · ${driver.name}` : ""}</div>
          </div>);
        })}</div>;
      })()}</div>
    </div>
  );
}

function TrucksTab({ trucks, reload, canEdit = true }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);
  const [editItemIdx, setEditItemIdx] = useState(null);
  const [saving, setSaving] = useState(false);
  const [f, setF] = useState({ date: TODAY(), driver_name: "", car_number: "", whatsapp: "", logist_phone: "", price: "", note: "" });
  const [items, setItems] = useState([]);
  const [it, setIt] = useState({ brand: BRANDS[0], grade: GRADES[0], bag_kg: 50, kg: "" });
  const [aiText, setAiText] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiErr, setAiErr] = useState("");
  const handleParseTruck = async () => {
    if (!aiText.trim()) return;
    setAiLoading(true); setAiErr("");
    try {
      const d = await parseTruckWithAI(aiText);
      setF(prev => ({
        ...prev,
        date: d.date || prev.date,
        driver_name: d.driver_name || prev.driver_name,
        car_number: d.car_number || prev.car_number,
        whatsapp: d.whatsapp || prev.whatsapp,
        logist_phone: d.logist_phone || prev.logist_phone,
        price: d.price ? String(d.price) : prev.price,
      }));
      const parsed = (d.items || []).filter(i => Number(i.kg) > 0).map(i => ({
        brand: BRANDS.includes(i.brand) ? i.brand : BRANDS[0],
        grade: GRADES.includes(i.grade) ? i.grade : GRADES[0],
        bag_kg: WEIGHTS.includes(Number(i.bag_kg)) ? Number(i.bag_kg) : 50,
        kg: Number(i.kg),
      }));
      if (parsed.length) setItems(parsed);
      setAiText("");
    } catch (e) { setAiErr(e.message || "Не удалось разобрать. Проверь текст."); }
    setAiLoading(false);
  };

  const itemKg = i => (i.kg != null && i.kg !== "") ? Number(i.kg) : Number(i.tonnes || 0) * 1000; // старые записи были в тоннах
  const reset = () => { setF({ date: TODAY(), driver_name: "", car_number: "", whatsapp: "", logist_phone: "", price: "", note: "" }); setItems([]); setIt({ brand: BRANDS[0], grade: GRADES[0], bag_kg: 50, kg: "" }); setEditItemIdx(null); setAiText(""); setAiErr(""); };
  const saveItem = () => {
    if (!it.kg) return;
    const ni = { brand: it.brand, grade: it.grade, bag_kg: Number(it.bag_kg), kg: Number(it.kg) };
    if (editItemIdx != null) { setItems(items.map((p, j) => j === editItemIdx ? ni : p)); setEditItemIdx(null); }
    else setItems([...items, ni]);
    setIt({ brand: BRANDS[0], grade: GRADES[0], bag_kg: 50, kg: "" });
  };
  const editItem = i => { const p = items[i]; setIt({ brand: p.brand, grade: p.grade, bag_kg: p.bag_kg, kg: itemKg(p) }); setEditItemIdx(i); };
  const removeItem = i => { setItems(items.filter((_, j) => j !== i)); if (editItemIdx === i) setEditItemIdx(null); };
  const openNew = () => { setEditId(null); reset(); setShowAdd(true); };
  const openEdit = t => { setEditId(t.id); setEditItemIdx(null); setF({ date: t.date || TODAY(), driver_name: t.driver_name || "", car_number: t.car_number || "", whatsapp: t.whatsapp || "", logist_phone: t.logist_phone || "", price: t.price || "", note: t.note || "" }); setItems((t.items || []).map(i => ({ brand: i.brand, grade: i.grade, bag_kg: Number(i.bag_kg), kg: itemKg(i) }))); setIt({ brand: BRANDS[0], grade: GRADES[0], bag_kg: 50, kg: "" }); setShowAdd(true); };

  const saveTruck = async () => {
    if (items.length === 0) return;
    setSaving(true);
    try {
      const existing = trucks.find(t => t.id === editId);
      await dbUpsert("trucks", { ...(existing || {}), id: editId || uid(), ...f, price: Number(f.price) || 0, items, status: existing?.status || "запланирована" });
      setShowAdd(false); setEditId(null); reset(); await reload("trucks");
    } catch (e) { alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз."); }
    setSaving(false);
  };

  // Смена статуса. При «принята» — позиции падают на склад приходом, а цена фуры идёт в расходы.
  const setTruckStatus = async (t, status) => {
    if (t.status === status) return;
    setSaving(true);
    try {
      if (status === "принята" && t.status !== "принята") {
        // id прихода привязан к фуре и позиции — двойное нажатие «Принять» перезапишет те же строки, а не задвоит их
        for (let i = 0; i < t.items.length; i++) { const item = t.items[i]; const weight_kg = itemKg(item); const bags = item.bag_kg > 0 ? Math.round(weight_kg / item.bag_kg) : 0; await dbUpsert("stock", { id: `tin_${t.id}_${i}`, date: TODAY(), brand: item.brand, grade: item.grade, bag_kg: item.bag_kg, bags, weight_kg, price_per_kg: 0, note: `Приход (фура от ${t.date})` }); }
        if (t.price) await dbUpsert("expenses", { id: "texp_" + t.id, date: TODAY(), category: "Фура/Поставка", amount: Number(t.price), note: `Фура от ${t.date}${t.driver_name ? `, ${t.driver_name}` : ""}` });
        await dbUpsert("trucks", { ...t, status: "принята", accepted_date: TODAY() });
        await reload("stock"); await reload("expenses");
      } else {
        await dbUpsert("trucks", { ...t, status });
      }
      await reload("trucks");
    } catch (e) { alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз."); }
    setSaving(false);
  };
  const deleteTruck = async id => {
    const t = trucks.find(x => x.id === id);
    const accepted = t && t.status === "принята";
    if (!confirm(`Удалить фуру?${accepted ? "\nФура была принята на склад — её приход спишется со склада, а расход за фуру уберётся." : ""}`)) return;
    try { await dbDelete("trucks", id); await reload("trucks"); if (accepted) { reload("stock"); reload("expenses"); } }
    catch (e) { alert("⚠️ Не удалилось: " + (e && e.message ? e.message : e)); }
  };

  // Быстрая смена даты прихода прямо в списке
  const changeDate = async (t, newDate) => {
    if (!newDate || newDate === t.date) return;
    try { await dbUpsert("trucks", { ...t, date: newDate }); await reload("trucks"); }
    catch (e) { alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e)); }
  };

  const totalKg = t => (t.items || []).reduce((s, i) => s + itemKg(i), 0);
  const sorted = [...trucks].sort((a, b) => ((a.status === "принята") === (b.status === "принята") ? (b.date || "").localeCompare(a.date || "") : a.status === "принята" ? 1 : -1));
  const waLink = n => "https://wa.me/" + String(n || "").replace(/\D/g, "");

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between"><h3 className="font-bold text-gray-800">Поставки (фуры)</h3>{canEdit && <Btn onClick={openNew}>+ Запланировать фуру</Btn>}</div>
      {showAdd && (
        <Modal title={editId ? "Изменить фуру" : "Новая фура"} onClose={() => setShowAdd(false)}>
          <div className="space-y-3">
            {!editId && (
              <div className="bg-amber-50 border border-amber-100 rounded-xl p-3">
                <div className="text-sm font-medium text-gray-700 mb-1 flex items-center gap-1.5"><Icon name="chat" size={15} />Разобрать из WhatsApp</div>
                <textarea value={aiText} onChange={e => setAiText(e.target.value)} rows={3} placeholder="Вставь сообщение о фуре, напр.: ДАРАД первый сорт 50кг - 10 тонн, высший 25кг - 5 тонн, фурист Асхат 87011234567, машина 123 ABC 01, цена 250000" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-amber-300" />
                {aiErr && <div className="text-xs text-red-500 mt-1">{aiErr}</div>}
                <button onClick={handleParseTruck} disabled={aiLoading || !aiText.trim()} className="mt-2 w-full bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded-lg font-medium px-4 py-2 text-sm">{aiLoading ? "Разбираю..." : "✨ Разобрать и заполнить"}</button>
                <div className="text-xs text-gray-400 mt-1">Заполнит позиции и данные фуриста ниже — проверь и поправь перед сохранением.</div>
              </div>
            )}
            <Inp label="Дата прихода" type="date" value={f.date} onChange={e => setF({ ...f, date: e.target.value })} />
            <div className="grid grid-cols-2 gap-2">
              <Inp label="Фурист (имя)" value={f.driver_name} onChange={e => setF({ ...f, driver_name: e.target.value })} />
              <Inp label="Номер машины" value={f.car_number} onChange={e => setF({ ...f, car_number: e.target.value })} placeholder="123 ABC 01" />
              <Inp label="WhatsApp фуриста" value={f.whatsapp} onChange={e => setF({ ...f, whatsapp: e.target.value })} placeholder="+7..." />
              <Inp label="Телефон логиста" value={f.logist_phone} onChange={e => setF({ ...f, logist_phone: e.target.value })} placeholder="+7..." />
            </div>
            <Inp label="Цена за фуру, тг (пойдёт в расходы)" type="number" value={f.price} onChange={e => setF({ ...f, price: e.target.value })} />
            <div>
              <p className="text-sm font-medium text-gray-700 mb-2">Что в фуре (по позициям)</p>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <Sel value={it.brand} onChange={e => setIt({ ...it, brand: e.target.value })} options={BRANDS} />
                <Sel value={it.grade} onChange={e => setIt({ ...it, grade: e.target.value })} options={GRADES} />
                <Sel value={it.bag_kg} onChange={e => setIt({ ...it, bag_kg: e.target.value })} options={WEIGHTS.map(w => ({ value: w, label: w + " кг" }))} />
                <Inp type="number" placeholder="кг" value={it.kg} onChange={e => setIt({ ...it, kg: e.target.value })} />
              </div>
              <Btn size="sm" variant={editItemIdx != null ? "primary" : "secondary"} onClick={saveItem}>{editItemIdx != null ? "✓ Сохранить позицию" : "+ Добавить позицию"}</Btn>
              {items.length > 0 && <div className="mt-2 space-y-1">{items.map((p, i) => <div key={i} className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm gap-2 ${editItemIdx === i ? "bg-amber-100" : "bg-gray-50"}`}><span className="min-w-0">{p.brand} · {p.grade} · {p.bag_kg}кг</span><span className="font-medium ml-auto whitespace-nowrap">{fmt(itemKg(p))} кг</span><button className="text-gray-400 hover:text-amber-600 flex-shrink-0" title="Изменить" onClick={() => editItem(i)}><Icon name="pencil" size={15} /></button><button className="text-red-400 hover:text-red-600 flex-shrink-0" title="Удалить" onClick={() => removeItem(i)}><Icon name="trash" size={15} /></button></div>)}</div>}
            </div>
            <Inp label="Примечание" value={f.note} onChange={e => setF({ ...f, note: e.target.value })} />
          </div>
          <div className="flex gap-2 mt-4">
            <Btn onClick={saveTruck} disabled={saving || items.length === 0}>{saving ? "Сохраняю..." : (editId ? "Сохранить" : "Запланировать")}</Btn>
            <Btn variant="secondary" onClick={() => setShowAdd(false)}>Отмена</Btn>
          </div>
        </Modal>
      )}
      <div className="space-y-3">
        {trucks.length === 0 && <div className="text-center py-12 text-gray-400">Фур пока нет.</div>}
        {sorted.map(t => (
          <div key={t.id} className={`rounded-2xl p-4 border ${t.status === "принята" ? "bg-white border-gray-100 shadow-sm" : "bg-amber-50 border-amber-200"}`}>
            <div className="flex items-center justify-between mb-2">
              <div className="font-display font-semibold text-gray-900 flex items-center gap-1.5"><Icon name="truck" size={16} />Фура на {t.date} <span className="text-sm font-normal text-gray-500">· {fmt(totalKg(t))} кг{t.price ? ` · ${fmt(t.price)} тг` : ""}</span></div>
              <Badge color={t.status === "принята" ? "green" : t.status === "в пути" ? "yellow" : "blue"}>{t.status}</Badge>
            </div>
            <div className="space-y-1 text-sm text-gray-600">
              {t.items.map((p, i) => <div key={i}>• {p.brand} {p.grade} {p.bag_kg}кг — {fmt(itemKg(p))} кг ({fmt(p.bag_kg > 0 ? Math.round(itemKg(p) / p.bag_kg) : 0)} мешков)</div>)}
            </div>
            {(t.driver_name || t.car_number || t.whatsapp || t.logist_phone) && (
              <div className="text-xs text-gray-500 mt-2 space-y-0.5">
                {(t.driver_name || t.car_number) && <div className="flex items-center gap-1"><Icon name="user" size={13} />{t.driver_name}{t.car_number ? ` · ${t.car_number}` : ""}</div>}
                {t.whatsapp && <div className="flex items-center gap-1.5"><Icon name="phone" size={13} /><a href={waLink(t.whatsapp)} target="_blank" rel="noreferrer" className="text-emerald-600">{t.whatsapp}</a></div>}
                {t.logist_phone && <div>📞 Логист: {t.logist_phone}</div>}
              </div>
            )}
            {t.note && <div className="text-xs text-gray-400 mt-1">{t.note}</div>}
            {canEdit && t.status !== "принята" && (
              <div className="flex gap-1 flex-wrap mt-3 items-center">
                <span className="text-xs text-gray-400">Статус:</span>
                {["грузится", "в пути", "разгрузка"].map(s => <button key={s} onClick={() => setTruckStatus(t, s)} className={`text-xs px-2 py-1 rounded-lg ${t.status === s ? "bg-amber-500 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>{s}</button>)}
                <Btn size="sm" onClick={() => setTruckStatus(t, "принята")} disabled={saving}>✓ Принять на склад</Btn>
              </div>
            )}
            {canEdit && t.status !== "принята" && (
              <div className="mt-2 flex items-center gap-2 text-xs text-gray-500 flex-wrap pt-2 border-t border-gray-100">
                <span className="inline-flex items-center gap-1"><Icon name="calendar" size={13} />Дата прихода:</span>
                <input type="date" className="border border-gray-200 rounded-lg px-2 py-1 text-xs" value={t.date || ""} onChange={e => changeDate(t, e.target.value)} />
                <button className="text-amber-600 hover:text-amber-700 font-medium" onClick={() => changeDate(t, TOMORROW())}>→ на завтра</button>
              </div>
            )}
            {canEdit && (
              <div className="mt-2 flex gap-2">
                {t.status !== "принята" && <Btn size="sm" variant="secondary" onClick={() => openEdit(t)}><Icon name="pencil" size={15} />Изменить</Btn>}
                <Btn size="sm" variant="danger" onClick={() => deleteTruck(t.id)}>Удалить</Btn>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Настройка адреса склада (точка старта маршрутов). Хранится в notes id="warehouse".
function WarehouseSettings({ notes = [], reload }) {
  const w = notes.find(n => n.id === "warehouse");
  const [link, setLink] = useState(w?.gis_link || "");
  const [addr, setAddr] = useState(w?.address || "");
  const [coords, setCoords] = useState(w?.coords || null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const resolve = async () => {
    setBusy(true); setMsg("");
    try {
      const c = parseCoordsFromGisLink(link) || parseCoordsFromText(link) || await resolveGisCoords(link);
      setCoords(c); setMsg("✓ точка найдена");
    } catch (e) { setMsg("⚠️ " + (e.message || "не удалось определить точку")); }
    setBusy(false);
  };
  const save = async () => {
    if (!coords) { setMsg("Сначала определи точку по ссылке 2ГИС"); return; }
    setBusy(true); setMsg("");
    try {
      await dbUpsert("notes", { id: "warehouse", coords, address: addr.trim(), gis_link: link.trim(), at: new Date().toISOString() });
      WAREHOUSE.lat = coords.lat; WAREHOUSE.lon = coords.lon; WAREHOUSE.address = addr.trim();
      await reload("notes"); setMsg("✓ адрес склада сохранён — маршруты теперь строятся отсюда");
    } catch (e) {
      const m = String((e && e.message) || e);
      setMsg(/notes|PGRST205/i.test(m) ? "Нужна таблица notes в Supabase" : "⚠️ " + m);
    }
    setBusy(false);
  };
  return (
    <div className="bg-white border border-gray-100 rounded-xl p-4">
      <div className="font-display font-semibold text-gray-800 mb-1 flex items-center gap-1.5"><Icon name="box" size={16} />Адрес склада (старт маршрутов)</div>
      <div className="text-xs text-gray-400 mb-3">Отсюда строится маршрут доставки. Вставь ссылку 2ГИС на склад и определи точку.{coords ? "" : " Сейчас — адрес по умолчанию."}</div>
      <div className="space-y-2">
        <Inp label="Название/адрес склада" value={addr} onChange={e => setAddr(e.target.value)} placeholder="напр. Астана, ул. …" />
        <Inp label="Ссылка 2ГИС на склад" value={link} onChange={e => { setLink(e.target.value); setCoords(null); }} placeholder="https://2gis.kz/astana/geo/..." />
        <div className="flex items-center gap-2 flex-wrap">
          <Btn size="sm" variant="secondary" onClick={resolve} disabled={busy || !link.trim()}><Icon name="pin" size={15} />Определить точку</Btn>
          <Btn size="sm" onClick={save} disabled={busy || !coords}>Сохранить</Btn>
          {coords && <span className="text-xs text-emerald-600">точка: {coords.lat.toFixed(5)}, {coords.lon.toFixed(5)}</span>}
        </div>
        {msg && <div className={`text-xs ${msg.startsWith("✓") ? "text-emerald-600" : "text-red-500"}`}>{msg}</div>}
      </div>
    </div>
  );
}

function UsersTab({ users, drivers, logins = [], notes = [], reload, currentUser }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({ name: "", username: "", password: "", role: "accountant", driverId: "", group_name: "", dev: false });

  const openNew = () => { setEditId(null); setForm({ name: "", username: "", password: "", role: "accountant", driverId: "", group_name: "", dev: false }); setErr(""); setShowAdd(true); };
  const openEdit = u => { setEditId(u.id); setForm({ name: u.name, username: u.username, password: "", role: u.role, driverId: u.driverId || "", group_name: u.group_name || "", dev: !!u.dev }); setErr(""); setShowAdd(true); };

  const saveUser = async () => {
    setErr("");
    if (!form.name.trim() || !form.username.trim()) { setErr("Заполни имя и логин"); return; }
    if (!editId && !form.password) { setErr("Задай пароль"); return; }
    const uname = form.username.trim().toLowerCase();
    if (users.some(u => u.id !== editId && (u.username || "").toLowerCase() === uname)) { setErr("Такой логин уже есть"); return; }
    setSaving(true);
    try {
      const existing = users.find(u => u.id === editId);
      // Пароль меняем только если ввели новый; пустое поле при редактировании = оставить старый
      const passhash = form.password ? await sha256(form.password) : existing?.passhash;
      await dbUpsert("users", {
        id: editId || uid(),
        name: form.name.trim(),
        username: form.username.trim(),
        passhash,
        role: form.role,
        driverId: (form.role === "driver" || form.role === "brigadir") ? form.driverId : "",
        group_name: form.role === "rep" ? form.group_name.trim() : "",
        dev: form.role === "director" ? !!form.dev : false, // 🔧 разработчик (видит «Ревизию», метка «р»)
        last_seen: existing?.last_seen, // не терять отметку «был в сети» при редактировании
      });
      setShowAdd(false); await reload("users");
    } catch (e) { setErr("Ошибка: " + e.message); }
    setSaving(false);
  };
  const deleteUser = async (id) => {
    const u = users.find(x => x.id === id);
    // Двойная защита от случайного пальца: подтверждение с именем + удаление только после точного ответа
    if (!confirm(`Удалить пользователя «${u?.name || "?"}» (@${u?.username || "?"})? Он больше не сможет войти в приложение.`)) return;
    await dbDelete("users", id); await reload("users");
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between"><h3 className="font-bold text-gray-800">Пользователи</h3><Btn onClick={openNew}>+ Добавить</Btn></div>
      <p className="text-sm text-gray-500">Администратор — всё (создаёт заявки, вносит данные). Директор — видит всё (заявки, аналитику, отчёты, отгрузки, расходы), но НЕ может ничего менять или добавлять. Бухгалтер — просмотр календаря и отчётов с ценами/реквизитами для накладных. Водитель — видит только свои отгрузки (день, что, куда, объём), без цен.</p>
      {showAdd && (
        <Modal title={editId ? "Редактировать пользователя" : "Новый пользователь"} onClose={() => setShowAdd(false)}>
          <div className="space-y-3">
            <Inp label="Имя" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Асхат" />
            <Inp label="Логин" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} placeholder="ashat" />
            <Inp label={editId ? "Новый пароль (пусто = не менять)" : "Пароль"} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder={editId ? "оставь пустым чтобы не менять" : ""} />
            <Sel label="Роль" value={form.role} onChange={e => setForm({ ...form, role: e.target.value })} options={Object.entries(ROLES).map(([v, l]) => ({ value: v, label: l }))} />
            {form.role === "director" && (
              <label className="flex items-center gap-2 text-sm text-gray-700 bg-violet-50 border border-violet-100 rounded-lg px-3 py-2 cursor-pointer">
                <input type="checkbox" checked={!!form.dev} onChange={e => setForm({ ...form, dev: e.target.checked })} className="w-4 h-4 accent-violet-500" />
                <span>🔧 Разработчик <span className="text-gray-400">— видит раздел «Ревизия» (метка «р»)</span></span>
              </label>
            )}
            {(form.role === "driver" || form.role === "brigadir") && (
              <Sel label={form.role === "brigadir" ? "Привязать к бригадиру (его карточка водителя)" : "Привязать к водителю"} value={form.driverId} onChange={e => setForm({ ...form, driverId: e.target.value })} options={[{ value: "", label: "— выбери водителя —" }, ...drivers.map(d => ({ value: d.id, label: d.name }))]} />
            )}
            {(form.role === "driver" || form.role === "brigadir") && drivers.length === 0 && <p className="text-xs text-amber-600">Сначала добавь водителя во вкладке «Зарплата».</p>}
            {form.role === "brigadir" && <p className="text-xs text-gray-500">Бригадир видит все заявки своей бригады и может переназначить водителя с себя на младшего. Младшие водители привязываются к нему во вкладке «Зарплата».</p>}
            {form.role === "rep" && <Inp label="Название группы клиентов" value={form.group_name} onChange={e => setForm({ ...form, group_name: e.target.value })} placeholder={`напр. Клиенты ${form.name || "торгпреда"}`} />}
            {form.role === "rep" && <p className="text-xs text-gray-500">Торгпред заводит СВОИХ клиентов (наших не видит), создаёт им заявки для нашего водителя и ведёт их долги. Склад общий.</p>}
            {err && <p className="text-red-500 text-sm">{err}</p>}
          </div>
          <div className="flex gap-2 mt-4">
            <Btn onClick={saveUser} disabled={saving}>{saving ? "Сохраняю..." : "Сохранить"}</Btn>
            <Btn variant="secondary" onClick={() => setShowAdd(false)}>Отмена</Btn>
          </div>
        </Modal>
      )}
      <div className="space-y-2">
        {users.map(u => {
          const linkedDriver = u.role === "driver" ? drivers.find(d => d.id === u.driverId) : null;
          return (
            <div key={u.id} className="bg-white border border-gray-100 rounded-xl px-4 py-3 flex items-center justify-between">
              <div>
                <div className="font-medium text-gray-900">{u.name} <span className="text-xs text-gray-400">@{u.username}</span>{u.dev && <span className="ml-1 align-middle text-[10px] font-bold text-white bg-violet-500 rounded px-1 py-0.5" title="Разработчик — видит «Ревизию»">р</span>}</div>
                <div className="text-sm text-gray-500">{ROLES[u.role] || u.role}{linkedDriver ? ` · ${linkedDriver.name}` : ""}{u.id === currentUser.id ? " · это вы" : ""}</div>
                {(() => {
                  if (!u.last_seen) return <div className="text-xs text-gray-400 mt-0.5">⚪ ещё не заходил(а)</div>;
                  const mins = Math.floor((Date.now() - Date.parse(u.last_seen)) / 60000);
                  if (mins < 10) return <div className="text-xs text-emerald-600 mt-0.5 flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block"></span>сейчас в приложении</div>;
                  const d = new Date(u.last_seen);
                  return <div className="text-xs text-gray-400 mt-0.5">🕐 был(а) в сети: {d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })} {d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</div>;
                })()}
              </div>
              <div className="flex gap-1">
                <Btn size="sm" variant="secondary" onClick={() => openEdit(u)}><Icon name="pencil" size={15} /></Btn>
                {u.id !== currentUser.id && <Btn size="sm" variant="danger" onClick={() => deleteUser(u.id)}><Icon name="trash" size={15} /></Btn>}
              </div>
            </div>
          );
        })}
      </div>

      <WarehouseSettings notes={notes} reload={reload} />
      <BackupLog />
      <LoginLog logins={logins} />
    </div>
  );
}

// 💾 Резервные копии и 📝 журнал изменений (для администратора)
const CH_ACTION = { create: ["добавил", "text-emerald-600"], update: ["изменил", "text-blue-600"], delete: ["удалил", "text-red-600"], restore: ["восстановил", "text-amber-600"] };
const CH_TABLE = { clients: "клиента", users: "пользователя", drivers: "рабочего", trucks: "фуру", orders: "заявку", stock: "движение склада", expenses: "расход" };
function BackupLog() {
  const [open, setOpen] = useState(false);
  const [backups, setBackups] = useState([]);
  const [changes, setChanges] = useState([]);
  const [busy, setBusy] = useState("");
  const [needTables, setNeedTables] = useState([]);
  const load = async () => {
    try {
      const [b, c] = await Promise.all([apiData("backupList"), apiData("changes")]);
      setBackups(b.rows || []); setChanges(c.rows || []);
      setNeedTables([b.needTable, c.needTable].filter(Boolean));
    } catch (e) { alert("⚠️ " + (e.message || e)); }
  };
  useEffect(() => { if (open) load(); }, [open]);
  const fmtAt = iso => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" }) + " " + d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }); };
  const makeNow = async () => {
    setBusy("now");
    try { await apiData("backupNow"); await load(); alert("✓ Копия сделана"); } catch (e) { alert("⚠️ " + (e.message || e)); }
    setBusy("");
  };
  const download = async b => {
    setBusy(b.id);
    try {
      const d = await apiData("backupGet", null, { id: b.id });
      downloadFile(`Копия_базы_${(b.at || "").slice(0, 10)}.json`, JSON.stringify(d.backup, null, 2), "application/json;charset=utf-8");
    } catch (e) { alert("⚠️ " + (e.message || e)); }
    setBusy("");
  };
  const restore = async ch => {
    if (!confirm(`Восстановить ${CH_TABLE[ch.table] || ch.table} «${ch.title}»?`)) return;
    setBusy(ch.id);
    try { const d = await apiData("restoreChange", null, { id: ch.id }); await load(); alert(`✓ «${d.title}» восстановлен. Обнови данные кнопкой 🔄.`); }
    catch (e) { alert("⚠️ " + (e.message || e)); }
    setBusy("");
  };
  const totalOf = b => Object.values(b.counts || {}).reduce((s, n) => s + n, 0);
  return (
    <div className="pt-2">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between bg-white border border-gray-100 rounded-xl px-4 py-3">
        <span className="font-bold text-gray-800">💾 Копии базы и журнал изменений</span>
        <span className="text-sm text-gray-400">{open ? "скрыть" : "показать"}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-4">
          {needTables.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800">
              ⚠️ Нужно один раз создать таблицы в Supabase ({needTables.join(", ")}) — иначе копии и журнал не сохраняются. Попроси Claude прислать инструкцию.
            </div>
          )}
          <div className="bg-white border border-gray-100 rounded-xl p-3">
            <div className="flex items-center justify-between mb-2 gap-2">
              <div className="font-bold text-gray-800 text-sm">💾 Резервные копии</div>
              <Btn size="sm" onClick={makeNow} disabled={busy === "now"}>{busy === "now" ? "Делаю..." : "Сделать копию"}</Btn>
            </div>
            <div className="text-xs text-gray-400 mb-2">Копия базы создаётся автоматически раз в неделю (воскресенье, 21:00) и уходит файлом на почту. Хранятся последние 14 — это ~3 месяца.</div>
            {backups.length === 0 && <div className="text-sm text-gray-400 py-2">Копий пока нет — нажми «Сделать копию».</div>}
            {backups.map(b => (
              <div key={b.id} className="flex items-center justify-between gap-2 text-sm py-1.5 border-b border-gray-50 last:border-b-0">
                <div className="min-w-0">
                  <div className="font-medium text-gray-800">{fmtAt(b.at)}</div>
                  <div className="text-xs text-gray-400">{fmt(totalOf(b))} записей · {b.by}</div>
                </div>
                <Btn size="sm" variant="secondary" onClick={() => download(b)} disabled={busy === b.id}>{busy === b.id ? "..." : "⬇️ Скачать"}</Btn>
              </div>
            ))}
          </div>
          <div className="bg-white border border-gray-100 rounded-xl p-3">
            <div className="font-display font-semibold text-gray-800 text-sm mb-1 flex items-center gap-1.5"><Icon name="note" size={15} />Журнал изменений</div>
            <div className="text-xs text-gray-400 mb-2">Кто что удалил или изменил. Удалённое можно вернуть кнопкой «Восстановить».</div>
            {changes.length === 0 && <div className="text-sm text-gray-400 py-2">Изменений пока нет.</div>}
            {changes.map(ch => {
              const [act, color] = CH_ACTION[ch.action] || [ch.action, "text-gray-600"];
              return (
                <div key={ch.id} className="flex items-center justify-between gap-2 text-sm py-1.5 border-b border-gray-50 last:border-b-0">
                  <div className="min-w-0">
                    <div className="text-gray-800 truncate"><b>{ch.userName}</b> <span className={color}>{act}</span> {CH_TABLE[ch.table] || ch.table} <b>«{ch.title}»</b></div>
                    <div className="text-xs text-gray-400">{fmtAt(ch.at)}</div>
                  </div>
                  {ch.action === "delete" && ch.canRestore && <Btn size="sm" variant="secondary" onClick={() => restore(ch)} disabled={busy === ch.id}>{busy === ch.id ? "..." : "↩️ Вернуть"}</Btn>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// Журнал входов: кто и когда заходил в приложение (для администратора), с фильтрами
function LoginLog({ logins }) {
  const [open, setOpen] = useState(true);
  const [who, setWho] = useState(""); // фильтр по человеку (userId)
  const [kind, setKind] = useState("all"); // all | login | open
  const [day, setDay] = useState(""); // конкретная дата (YYYY-MM-DD)
  const fmt = iso => {
    const d = new Date(iso);
    if (isNaN(d)) return iso || "";
    return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
  };
  // уникальные люди из журнала
  const people = [];
  (logins || []).forEach(l => { const id = l.userId || l.username || l.name; if (id && !people.some(p => p.id === id)) people.push({ id, name: l.name || l.username }); });
  people.sort((a, b) => (a.name || "").localeCompare(b.name || "", "ru"));
  const filtered = [...(logins || [])]
    .filter(l => !who || (l.userId || l.username || l.name) === who)
    .filter(l => kind === "all" || (kind === "login" ? l.kind === "login" : l.kind !== "login"))
    .filter(l => !day || String(l.at || "").slice(0, 10) === day)
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  return (
    <div className="pt-2">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between bg-white border border-gray-100 rounded-xl px-4 py-3">
        <span className="font-bold text-gray-800">🕐 Кто когда заходил</span>
        <span className="text-sm text-gray-400">{filtered.length} · {open ? "скрыть" : "показать"}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <div className="bg-white border border-gray-100 rounded-xl p-3 space-y-2">
            <Sel label="Кто" value={who} onChange={e => setWho(e.target.value)} options={[{ value: "", label: "— все —" }, ...people.map(p => ({ value: p.id, label: p.name }))]} />
            <div className="grid grid-cols-2 gap-2">
              <Sel label="Тип" value={kind} onChange={e => setKind(e.target.value)} options={[{ value: "all", label: "Все" }, { value: "open", label: "Открыл приложение" }, { value: "login", label: "Вход по паролю" }]} />
              <Inp label="За дату" type="date" value={day} onChange={e => setDay(e.target.value)} />
            </div>
            {(who || kind !== "all" || day) && <button onClick={() => { setWho(""); setKind("all"); setDay(""); }} className="text-xs text-amber-600 font-medium">Сбросить фильтры</button>}
          </div>
          {filtered.length === 0 && <p className="text-sm text-gray-400 px-1">Нет записей по фильтру.</p>}
          {filtered.slice(0, 300).map(l => (
            <div key={l.id} className="bg-white border border-gray-100 rounded-lg px-3 py-2 flex items-center justify-between text-sm">
              <div>
                <span className="mr-1 inline-flex text-gray-400" title={l.kind === "login" ? "вход по паролю" : "открыл приложение"}><Icon name={l.kind === "login" ? "key" : "phone"} size={13} /></span>
                <span className="font-medium text-gray-900">{l.name || l.username}</span>
                <span className="text-xs text-gray-400 ml-1">· {ROLES[l.role] || l.role}</span>
              </div>
              <span className="text-gray-500">{fmt(l.at)}</span>
            </div>
          ))}
          {filtered.length > 300 && <p className="text-xs text-gray-400 px-1">Показаны последние 300 записей.</p>}
        </div>
      )}
    </div>
  );
}

function LoginScreen({ onLogin }) {
  const [bootstrap, setBootstrap] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  // Узнаём у сервера, нужен ли первый пользователь
  useEffect(() => {
    fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "status" }) })
      .then(r => r.json()).then(d => setBootstrap(!!d.bootstrap)).catch(() => {});
  }, []);

  const callAuth = async payload => {
    const r = await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Ошибка входа");
    setAuthToken(data.token);
    onLogin(data.user);
  };
  const doLogin = async () => {
    setErr(""); setBusy(true);
    try { await callAuth({ action: "login", username, password }); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const doBootstrap = async () => {
    setErr("");
    if (!name.trim() || !username.trim() || !password) { setErr("Заполни все поля"); return; }
    setBusy(true);
    try { await callAuth({ action: "bootstrap", name, username, password }); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const submit = () => (bootstrap ? doBootstrap() : doLogin());

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4 font-sans">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
        <div className="text-center mb-5">
          <h1 className="text-2xl font-black text-gray-900">🌾 Darad</h1>
          <p className="text-sm text-gray-400 mt-1">{bootstrap ? "Создай первого пользователя (директора)" : "Вход в систему"}</p>
        </div>
        <div className="space-y-3">
          {bootstrap && <Inp label="Имя" value={name} onChange={e => setName(e.target.value)} placeholder="Алияс" />}
          <Inp label="Логин" value={username} onChange={e => setUsername(e.target.value)} />
          <Inp label="Пароль" type="password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === "Enter" && submit()} />
          {err && <p className="text-red-500 text-sm">{err}</p>}
          <div className="pt-1"><Btn onClick={submit} disabled={busy} size="lg">{busy ? "..." : bootstrap ? "Создать и войти" : "Войти"}</Btn></div>
        </div>
      </div>
    </div>
  );
}

// 💵 Касса (подотчётные деньги): тебе дали сумму — ты тратишь, всегда виден остаток.
// Полностью отдельно от расходов компании и отчётов склада.
function CashboxTab({ cashbox = [], reload, canEdit = true }) {
  const [showAdd, setShowAdd] = useState(false);
  const [dir, setDir] = useState("out"); // in — приход (дали), out — трата
  const [editItem, setEditItem] = useState(null); // редактируемая запись (null = новая)
  const [form, setForm] = useState({ date: TODAY(), amount: "", note: "" });
  const [saving, setSaving] = useState(false);
  const [period, setPeriod] = useState("month");
  const [from, setFrom] = useState(TODAY());
  const [to, setTo] = useState(TODAY());

  const openNew = d => { setEditItem(null); setDir(d); setForm({ date: TODAY(), amount: "", note: "" }); setShowAdd(true); };
  const openEdit = x => { setEditItem(x); setDir(x.dir === "in" ? "in" : "out"); setForm({ date: x.date || TODAY(), amount: String(x.amount ?? ""), note: x.note || "" }); setShowAdd(true); };
  const save = async () => {
    if (!form.amount || Number(form.amount) <= 0) return;
    setSaving(true);
    try {
      const rec = editItem
        ? { ...editItem, dir, date: form.date, amount: Number(form.amount), note: form.note.trim() }
        : { id: uid(), dir, date: form.date, amount: Number(form.amount), note: form.note.trim() };
      await dbUpsert("cashbox", rec);
      setShowAdd(false); setEditItem(null); await reload("cashbox");
    } catch (e) {
      const m = String((e && e.message) || e);
      alert(/cashbox|PGRST205/i.test(m) ? "Нужно один раз создать таблицу «cashbox» в Supabase — попроси инструкцию." : "⚠️ Не сохранилось: " + m);
    } finally { setSaving(false); }
  };
  const del = async id => { if (!confirm("Удалить эту запись из кассы?")) return; try { await dbDelete("cashbox", id); setShowAdd(false); await reload("cashbox"); } catch (e) { alert("⚠️ " + ((e && e.message) || e)); } };

  // Остаток — всегда по всей истории (это накопительный баланс кассы)
  const totalIn = cashbox.filter(x => x.dir === "in").reduce((s, x) => s + (x.amount || 0), 0);
  const totalOut = cashbox.filter(x => x.dir !== "in").reduce((s, x) => s + (x.amount || 0), 0);
  const balance = totalIn - totalOut;

  // Фильтр по датам — влияет на список и на суммы «за период»
  const now = new Date();
  const inPeriod = x => {
    if (period === "all") return true;
    const d = new Date(x.date);
    if (period === "week") { const w = new Date(now); w.setDate(w.getDate() - 7); return d >= w; }
    if (period === "month") return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    if (period === "3month") { const m = new Date(now); m.setMonth(m.getMonth() - 3); return d >= m; }
    if (period === "custom") return (x.date || "") >= from && (x.date || "") <= to;
    return true;
  };
  const list = cashbox.filter(inPeriod).sort((a, b) => (b.date || "").localeCompare(a.date || "") || String(b.id).localeCompare(String(a.id)));
  const perIn = list.filter(x => x.dir === "in").reduce((s, x) => s + (x.amount || 0), 0);
  const perOut = list.filter(x => x.dir !== "in").reduce((s, x) => s + (x.amount || 0), 0);
  const periods = [["week", "Неделя"], ["month", "Месяц"], ["3month", "3 мес"], ["all", "Всё"], ["custom", "Свой"]];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h3 className="font-display font-semibold text-gray-800 flex items-center gap-1.5"><Icon name="coin" size={18} />Касса</h3></div>
      <div className={`rounded-2xl p-5 text-white shadow-sm bg-gradient-to-br ${balance < 0 ? "from-red-500 to-red-600" : "from-emerald-500 to-emerald-600"}`}>
        <div className="text-sm font-medium opacity-90">Остаток в кассе</div>
        <div className="text-4xl font-black mt-1">{fmt(balance)} тг</div>
        <div className="text-sm opacity-90 mt-1.5 border-t border-white/30 pt-1.5">Всего получено: <b>{fmt(totalIn)}</b> · потрачено: <b>{fmt(totalOut)}</b></div>
      </div>
      {canEdit && (
        <div className="flex gap-2">
          <Btn onClick={() => openNew("in")} size="lg">+ Приход</Btn>
          <button onClick={() => openNew("out")} className="flex-1 bg-red-500 hover:bg-red-600 text-white rounded-lg font-medium px-6 py-3 text-base active:scale-95 transition-all">− Трата</button>
        </div>
      )}

      {/* Фильтр по датам */}
      <div className="flex flex-wrap gap-2">
        {periods.map(([v, l]) => <button key={v} onClick={() => setPeriod(v)} className={`px-3.5 py-1.5 rounded-xl text-sm font-medium transition-all ${period === v ? "bg-amber-500 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>{l}</button>)}
      </div>
      {period === "custom" && (
        <div className="flex items-center gap-2 text-sm">
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="border border-gray-200 rounded-lg px-2 py-1.5 flex-1" />
          <span className="text-gray-400">—</span>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} className="border border-gray-200 rounded-lg px-2 py-1.5 flex-1" />
        </div>
      )}
      <div className="flex gap-2 text-sm">
        <div className="flex-1 bg-emerald-50 text-emerald-700 rounded-xl px-3 py-2"><div className="text-xs opacity-70">Получено за период</div><div className="font-bold">+{fmt(perIn)} тг</div></div>
        <div className="flex-1 bg-red-50 text-red-600 rounded-xl px-3 py-2"><div className="text-xs opacity-70">Потрачено за период</div><div className="font-bold">−{fmt(perOut)} тг</div></div>
      </div>

      {showAdd && (
        <Modal title={editItem ? (dir === "in" ? "Приход" : "Трата") : (dir === "in" ? "Приход — дали денег" : "Трата")} onClose={() => { setShowAdd(false); setEditItem(null); }}>
          <div className="space-y-3">
            {/* переключатель Приход/Трата — чтобы можно было и тип поправить */}
            <div className="flex gap-2">
              <button onClick={() => setDir("in")} className={`flex-1 py-2 rounded-lg text-sm font-medium ${dir === "in" ? "bg-emerald-500 text-white" : "bg-gray-100 text-gray-600"}`}>▲ Приход</button>
              <button onClick={() => setDir("out")} className={`flex-1 py-2 rounded-lg text-sm font-medium ${dir === "out" ? "bg-red-500 text-white" : "bg-gray-100 text-gray-600"}`}>▼ Трата</button>
            </div>
            <Inp label="Дата" type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
            <Inp label="Сумма, тг" type="number" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} />
            <Inp label={dir === "in" ? "От кого / за что (по желанию)" : "На что потратил"} value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} placeholder={dir === "in" ? "напр. от Эрика на закуп" : "напр. роутер, камеры"} />
          </div>
          <div className="flex gap-2 mt-4">
            <Btn onClick={save} disabled={!form.amount || saving}>{saving ? "Сохраняю…" : "Сохранить"}</Btn>
            {editItem && <Btn variant="danger" onClick={() => del(editItem.id)}>Удалить</Btn>}
            <Btn variant="secondary" onClick={() => { setShowAdd(false); setEditItem(null); }}>Отмена</Btn>
          </div>
        </Modal>
      )}
      <div className="space-y-2">
        {list.length === 0 && <div className="text-center py-12 text-gray-400">{cashbox.length ? "За этот период записей нет." : "Пока пусто. Нажми «+ Приход», когда дадут денег."}</div>}
        {list.map(x => {
          const isIn = x.dir === "in";
          return (
            <button key={x.id} onClick={() => canEdit && openEdit(x)} disabled={!canEdit} className="w-full text-left bg-white border border-gray-100 rounded-xl px-4 py-3 flex items-center justify-between text-sm active:scale-[0.99] transition-transform">
              <div className="min-w-0">
                <div className="font-medium text-gray-900">{isIn ? "▲ Приход" : "▼ Трата"}{x.note ? ` — ${x.note}` : ""}</div>
                <div className="text-xs text-gray-400">{(x.date || "").split("-").reverse().join(".")}{x.created_by_name ? ` · ${x.created_by_name}` : ""}{canEdit ? " · нажми чтобы изменить" : ""}</div>
              </div>
              <span className={`font-bold flex-shrink-0 ${isIn ? "text-emerald-600" : "text-red-500"}`}>{isIn ? "+" : "−"}{fmt(x.amount)} тг</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// 🤖 ИИ-помощник: пишешь задачу простым языком — он определяет раздел и делает (после подтверждения)
function AssistantModal({ onClose, orders = [], reload }) {
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState("input"); // input | loading | result | executing | done
  const [result, setResult] = useState(null);
  const [err, setErr] = useState("");
  const [doneMsg, setDoneMsg] = useState("");
  const examples = [
    "Мамыр взяли 10 мешков высший на завтра",
    "Ерлан занёс 200 тысяч в счёт долга",
    "расход с кассы 15000 за роутер сегодня",
    "приедет фура 20 тонн высший 25 июля",
    "сколько осталось первого сорта?",
  ];

  const ask = async (msg) => {
    const m = (msg ?? input).trim();
    if (!m) return;
    setInput(m); setErr(""); setPhase("loading");
    try {
      const d = await askAssistant(m);
      if (d.error) { setErr(d.error); setPhase("input"); return; }
      setResult(d.result); setPhase("result");
    } catch (e) { setErr(String((e && e.message) || e)); setPhase("input"); }
  };

  const execute = async () => {
    const a = result || {}; const p = a.params || {};
    setPhase("executing"); setErr("");
    try {
      if (a.action === "create_order") {
        const positions = (p.positions && p.positions.length) ? p.positions : [{ brand: p.brand, grade: p.grade, bag_kg: p.bag_kg, bags: p.bags, price_per_kg: p.price_per_kg }];
        await Promise.all(positions.map(pos => dbUpsert("orders", {
          id: uid(), date: p.date, brand: pos.brand, grade: pos.grade, bag_kg: Number(pos.bag_kg), bags: Number(pos.bags),
          driverId: "", price_per_kg: Number(p.trial ? 0 : (pos.price_per_kg || 0)), status: "новая",
          isSample: false, trial: !!p.trial, clientId: p.clientId || null, clientName: p.clientName || "",
        })));
        await reload("orders");
      } else if (a.action === "add_payment") {
        await dbUpsert("payments", { id: uid(), clientId: p.clientId || "", clientName: p.clientName || "", date: p.date, amount: Number(p.amount), method: p.method || "Наличные", note: p.note || "" });
        await reload("payments");
      } else if (a.action === "cashbox") {
        await dbUpsert("cashbox", { id: uid(), dir: p.dir === "in" ? "in" : "out", date: p.date, amount: Number(p.amount), note: p.note || "" });
        await reload("cashbox");
      } else if (a.action === "add_expense") {
        await dbUpsert("expenses", { id: uid(), date: p.date, category: p.category || "Прочее", amount: Number(p.amount), note: p.note || "" });
        await reload("expenses");
      } else if (a.action === "add_truck") {
        await dbUpsert("trucks", { id: uid(), date: p.date, driver_name: p.driver_name || "", car_number: p.car_number || "", whatsapp: "", logist_phone: "", price: Number(p.price) || 0, note: p.note || "", items: (p.items || []).map(i => ({ brand: i.brand, grade: i.grade, bag_kg: Number(i.bag_kg), kg: Number(i.kg) })), status: "запланирована" });
        await reload("trucks");
      } else if (a.action === "mark_paid") {
        const os = orders.filter(o => (p.clientId ? o.clientId === p.clientId : o.clientName === p.clientName) && o.date === p.date && o.status === "отгружена");
        if (!os.length) { setErr("Не нашёл отгрузок этого клиента за эту дату."); setPhase("result"); return; }
        await Promise.all(os.map(o => dbUpsert("orders", { ...o, paid: true, pay_method: p.method || "Наличные" })));
        await reload("orders");
      } else { setErr("Неизвестное действие."); setPhase("result"); return; }
      setDoneMsg(a.summary || "Готово"); setPhase("done");
    } catch (e) {
      const m = String((e && e.message) || e);
      setErr(/cashbox|payments|PGRST205/i.test(m) ? "Нужно один раз создать таблицу в Supabase — попроси инструкцию." : "⚠️ Не сохранилось: " + m);
      setPhase("result");
    }
  };

  const reset = () => { setInput(""); setResult(null); setErr(""); setDoneMsg(""); setPhase("input"); };
  const ACTION_ICON = { create_order: "📋", add_payment: "💰", cashbox: "💵", add_expense: "💸", add_truck: "🏬", mark_paid: "✓" };

  return (
    <Modal title="ИИ-помощник" onClose={onClose}>
      {(phase === "input" || phase === "loading") && (
        <div className="space-y-3">
          <div className="text-sm text-gray-500">Напиши задачу простым языком — я пойму, к чему это относится, и покажу, что сделать. Ты подтвердишь.</div>
          <textarea autoFocus rows={3} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) ask(); }} placeholder="напр. Ерлан занёс 200 тысяч в счёт долга" className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300" />
          {err && <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{err}</div>}
          <Btn onClick={() => ask()} disabled={!input.trim() || phase === "loading"} size="lg">{phase === "loading" ? "Думаю…" : "Спросить / Сделать"}</Btn>
          <div className="flex flex-wrap gap-1.5 pt-1">
            {examples.map((ex, i) => <button key={i} onClick={() => ask(ex)} disabled={phase === "loading"} className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-full px-2.5 py-1">{ex}</button>)}
          </div>
        </div>
      )}

      {phase === "result" && result && (
        <div className="space-y-3">
          <div className="text-xs text-gray-400">Ты попросил: «{input}»</div>
          {result.kind === "answer" && <div className="text-sm text-gray-800 bg-gray-50 rounded-xl p-3 whitespace-pre-wrap">{result.text}</div>}
          {result.kind === "clarify" && <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-3">🤔 {result.text}</div>}
          {result.kind === "action" && (
            <div className="border-2 border-amber-300 bg-amber-50 rounded-xl p-3">
              <div className="text-xs font-semibold text-amber-700 mb-1">Собираюсь сделать:</div>
              <div className="text-sm font-bold text-gray-900 flex items-start gap-1.5"><span>{ACTION_ICON[result.action] || "•"}</span><span>{result.summary}</span></div>
              {result.warn && <div className="text-xs text-orange-600 mt-1.5">⚠️ {result.warn}</div>}
            </div>
          )}
          {err && <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{err}</div>}
          <div className="flex gap-2">
            {result.kind === "action" && <Btn onClick={execute}>✓ Подтвердить и сделать</Btn>}
            <Btn variant="secondary" onClick={reset}>{result.kind === "action" ? "Отмена" : "Новая задача"}</Btn>
          </div>
        </div>
      )}

      {phase === "executing" && <div className="text-center py-8 text-gray-500">Выполняю…</div>}

      {phase === "done" && (
        <div className="space-y-4 text-center py-4">
          <div className="text-5xl">✅</div>
          <div className="text-sm font-medium text-gray-800">{doneMsg}</div>
          <div className="flex gap-2 justify-center">
            <Btn onClick={reset}>Ещё задача</Btn>
            <Btn variant="secondary" onClick={onClose}>Закрыть</Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}

// 💰 «Моя зарплата» для бригадира: видит свой объём (вся бригада) и посчитанную зарплату за месяц.
function MySalaryTab({ drivers = [], orders = [], myDriverId = "" }) {
  const [month, setMonth] = useState(TODAY().slice(0, 7));
  const me = drivers.find(d => d.id === myDriverId);
  if (!me) return <div className="text-center py-12 text-gray-400">Карточка не найдена. Обратись к администратору.</div>;

  const monthPicker = <input type="month" value={month} onChange={e => setMonth(e.target.value)} className="border border-gray-200 rounded-lg px-2 py-1 text-sm" />;

  // 🚙 Младший / обычный водитель — показываем ТОЛЬКО объём за месяц (сумму говорит бригадир / считает админ).
  // Развоз (driverId) и погрузка самовывоза (loaderId) — раздельно: у них разные ставки.
  if (me.salary_type !== "brigadir") {
    const inMonth = o => o.status === "отгружена" && (o.date || "").startsWith(month);
    const myDeliv = orders.filter(o => inMonth(o) && o.driverId === me.id && !o.pickup).reduce((s, o) => s + o.bags * o.bag_kg, 0);
    const myLoad = orders.filter(o => inMonth(o) && o.pickup && !o.pickupWatch && o.loaderId === me.id).reduce((s, o) => s + o.bags * o.bag_kg, 0);
    const myWatch = orders.filter(o => inMonth(o) && o.pickup && o.pickupWatch && o.loaderId === me.id).reduce((s, o) => s + o.bags * o.bag_kg, 0);
    const myKg = myDeliv + myLoad;
    const estimate = Math.round(myDeliv * (me.rate_per_kg || 0) + myLoad * (me.load_rate_per_kg || 0));
    const isJunior = me.salary_type === "junior";
    const foreman = isJunior ? drivers.find(d => d.id === me.foremanId) : null;
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between"><h3 className="font-display font-semibold text-gray-800 flex items-center gap-1.5"><Icon name="wallet" size={18} />Моя зарплата</h3>{monthPicker}</div>
        <div className="rounded-2xl p-5 text-white shadow-sm bg-gradient-to-br from-sky-500 to-sky-600">
          <div className="text-sm font-medium opacity-90">Развёз за {month}</div>
          <div className="text-4xl font-black mt-1">{fmt(myKg)} кг</div>
          <div className="text-sm opacity-90 mt-1">≈ {fmt(Math.round(myKg / 100) / 10)} т{myLoad > 0 ? ` · развоз ${fmt(myDeliv)} · погрузка ${fmt(myLoad)} кг` : ""}</div>
        </div>
        {isJunior
          ? <div className="bg-white border border-gray-100 rounded-2xl p-4 text-sm text-gray-600">Сумму за развоз тебе скажет бригадир{foreman ? ` — ${foreman.name}` : ""}. Здесь виден только твой объём за месяц.</div>
          : <div className="bg-white border border-gray-100 rounded-2xl p-4 text-sm text-gray-600">По ставкам ({fmt(me.rate_per_kg || 0)} тг/кг развоз{myLoad > 0 ? `, ${fmt(me.load_rate_per_kg || 0)} тг/кг погрузка` : ""}) это ≈ <b className="text-gray-900">{fmt(estimate)} тг</b> за месяц. Итог и выплаты — у администратора.</div>}
        {myWatch > 0 && <div className="bg-purple-50 border border-purple-100 rounded-2xl p-3 text-sm text-purple-800 flex items-center gap-1.5"><Icon name="eye" size={14} className="shrink-0" />На контроле (клиент грузил сам): <b>{fmt(myWatch)} кг</b> — без оплаты, для учёта.</div>}
      </div>
    );
  }

  // 👷 Бригадир — полная разбивка по тарифам + объём каждого водителя бригады
  const brigadeIds = [me.id, ...drivers.filter(d => d.foremanId === me.id).map(d => d.id)];
  const kgOf = id => orders.filter(o => o.status === "отгружена" && o.driverId === id && (o.date || "").startsWith(month)).reduce((s, o) => s + o.bags * o.bag_kg, 0);
  const perDriver = brigadeIds.map(id => ({ id, name: drivers.find(d => d.id === id)?.name || "?", kg: kgOf(id), me: id === me.id })).filter(x => x.kg > 0 || x.me).sort((a, b) => b.kg - a.kg);
  const kg = perDriver.reduce((s, x) => s + x.kg, 0);
  const b = brigadeSalary(me, kg);
  const sv = brigadePickupLoad(me, drivers, orders, month); // погрузка самовывоза — отдельно
  const grand = b.total + sv.pay;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h3 className="font-display font-semibold text-gray-800 flex items-center gap-1.5"><Icon name="wallet" size={18} />Моя зарплата</h3>{monthPicker}</div>

      <div className="rounded-2xl p-5 text-white shadow-sm bg-gradient-to-br from-emerald-500 to-emerald-600">
        <div className="text-sm font-medium opacity-90">Зарплата за {month}</div>
        <div className="text-4xl font-black mt-1">{fmt(grand)} тг</div>
        <div className="text-sm opacity-90 mt-1.5 border-t border-white/30 pt-1.5">Развоз бригады: <b>{fmt(kg)} кг</b> ({fmt(Math.round(kg / 100) / 10)} т){sv.kg > 0 ? <> · самовывоз: <b>{fmt(sv.kg)} кг</b></> : ""}</div>
      </div>

      <div className="bg-white border border-gray-100 rounded-2xl p-4 text-sm space-y-1">
        <div className="font-semibold text-gray-700 mb-1 flex items-center gap-1.5"><Icon name="truck" size={15} />За развоз (оклад + тарифы)</div>
        <div className="flex justify-between"><span className="text-gray-600">Оклад (за первые {fmt(b.incl / 1000)} т)</span><b>{fmt(b.base)} тг</b></div>
        <div className="flex justify-between"><span className="text-gray-600">{fmt(b.incl / 1000)}–{fmt(b.t1 / 1000)} т: {fmt(b.tier1kg)} кг × {fmt(b.r1)} тг/кг</span><b>+{fmt(b.tier1pay)} тг</b></div>
        <div className="flex justify-between"><span className="text-gray-600">свыше {fmt(b.t1 / 1000)} т: {fmt(b.tier2kg)} кг × {fmt(b.r2)} тг/кг</span><b>+{fmt(b.tier2pay)} тг</b></div>
        <div className="flex justify-between border-t border-gray-100 pt-1 mt-1"><span className="font-semibold">Итого за развоз</span><b>{fmt(b.total)} тг</b></div>
        {b.toNext > 0 && <div className="text-xs text-amber-700 bg-amber-50 rounded-lg px-2 py-1 mt-1">Ещё <b>{fmt(b.toNext)} кг</b> {b.nextLabel}</div>}
      </div>

      <div className="bg-white border border-gray-100 rounded-2xl p-4 text-sm space-y-1">
        <div className="font-semibold text-gray-700 mb-1 flex items-center gap-1.5"><Icon name="box" size={15} />Погрузка самовывоза <span className="font-normal text-gray-400">(клиент забрал сам · {fmt(sv.rate)} тг/кг)</span></div>
        {sv.kg > 0 ? (<>
          {sv.per.map(x => <div key={x.id} className="flex justify-between py-0.5"><span className="text-gray-600"><Icon name={x.me ? "user" : "truck"} size={12} className="inline-block mr-1 align-[-2px]" />{x.name}: {fmt(x.kg)} кг × {fmt(sv.rate)}</span><b>+{fmt(Math.round(x.kg * sv.rate))} тг</b></div>)}
          <div className="flex justify-between border-t border-gray-100 pt-1 mt-1"><span className="font-semibold">Итого за погрузку</span><b>+{fmt(sv.pay)} тг</b></div>
        </>) : <div className="text-gray-400">Самовывоза (с погрузкой) в этом месяце не было.</div>}
        {sv.watchKg > 0 && <div className="flex justify-between border-t border-gray-100 pt-1 mt-1 text-purple-800"><span className="inline-flex items-center gap-1"><Icon name="eye" size={13} />На контроле (клиент грузил сам)</span><b>{fmt(sv.watchKg)} кг · без оплаты</b></div>}
      </div>

      <div className="flex justify-between bg-emerald-50 border border-emerald-200 rounded-2xl px-4 py-3"><span className="font-bold text-emerald-800">Всего к начислению</span><b className="text-emerald-800 text-lg">{fmt(grand)} тг</b></div>

      <div className="bg-white border border-gray-100 rounded-2xl p-4 text-sm">
        <div className="font-semibold text-gray-700 mb-1">По водителям бригады за {month}</div>
        {perDriver.map(x => <div key={x.id} className="flex justify-between py-0.5"><span className={x.me ? "font-medium text-gray-900" : "text-gray-600"}><Icon name={x.me ? "user" : "truck"} size={12} className="inline-block mr-1 align-[-2px]" />{x.name}{x.me ? " (я)" : ""}</span><b>{fmt(x.kg)} кг</b></div>)}
      </div>

      <div className="text-xs text-gray-400 text-center">Оклад {fmt(b.base)} тг (вкл. {fmt(b.incl / 1000)} т) · {fmt(b.incl / 1000)}–{fmt(b.t1 / 1000)} т по {fmt(b.r1)} тг/кг · свыше {fmt(b.t1 / 1000)} т по {fmt(b.r2)} тг/кг. Погрузка самовывоза — отдельно, по {fmt(sv.rate)} тг/кг.</div>
    </div>
  );
}

// 🎯 Личная CRM: потенциальные клиенты + личные записи и статус. Только для админа.
// Договорился — «→ В клиенты» переносит карточку в обычную вкладку «Клиенты».
function CrmTab({ crm = [], clients = [], reload }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState("all");
  const blank = { name: "", contact: "", address: "", status: "new", note: "", next_date: "" };
  const [form, setForm] = useState(blank);

  const openNew = () => { setEditId(null); setForm(blank); setShowAdd(true); };
  const openEdit = c => { setEditId(c.id); setForm({ name: c.name || "", contact: c.contact || "", address: c.address || "", status: c.status || "new", note: c.note || "", next_date: c.next_date || "" }); setShowAdd(true); };
  const save = async () => {
    if (!form.name.trim()) { alert("Впиши название/имя."); return; }
    setSaving(true);
    try {
      await dbUpsert("crm", { id: editId || uid(), name: form.name.trim(), contact: form.contact.trim(), address: form.address.trim(), status: form.status, note: form.note.trim(), next_date: form.next_date });
      setShowAdd(false); setEditId(null); setForm(blank); await reload("crm");
    } catch (e) { const m = String((e && e.message) || e); alert(/crm|PGRST205/i.test(m) ? "Нужно один раз создать таблицу «crm» в Supabase — попроси инструкцию." : "⚠️ Не сохранилось: " + m); }
    finally { setSaving(false); }
  };
  const setStatus = async (c, status) => { try { await dbUpsert("crm", { ...c, status }); await reload("crm"); } catch (e) { alert("⚠️ " + ((e && e.message) || e)); } };
  const del = async id => { if (!confirm("Удалить эту запись из CRM?")) return; try { await dbDelete("crm", id); await reload("crm"); } catch (e) { alert("⚠️ " + ((e && e.message) || e)); } };
  const toClient = async c => {
    if (!confirm(`Перенести «${c.name}» в обычную вкладку «Клиенты»? Карточку CRM после этого удалим.`)) return;
    try {
      await dbUpsert("clients", { id: uid(), name: c.name, address: c.address || "", contact: c.contact || "", ownerId: "", prices: [] });
      await dbDelete("crm", c.id);
      await reload("clients"); await reload("crm");
      alert(`✓ «${c.name}» теперь в «Клиентах». Допиши цены и реквизиты там.`);
    } catch (e) { alert("⚠️ Не перенеслось: " + ((e && e.message) || e)); }
  };

  const list = [...crm].filter(c => filter === "all" || c.status === filter);
  // сортировка: сначала «позвонить»/«в работе», потом по дате следующего контакта
  const order = { call: 0, work: 1, meet: 2, new: 3, think: 4, deal: 5, reject: 6 };
  list.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || (a.next_date || "9999").localeCompare(b.next_date || "9999"));
  const counts = {}; crm.forEach(c => { counts[c.status] = (counts[c.status] || 0) + 1; });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><div><h3 className="font-display font-semibold text-gray-800 flex items-center gap-1.5"><Icon name="target" size={17} />Мои потенциальные клиенты</h3><p className="text-xs text-gray-400">Личная база — заношу, кому продать, и веду записи по ним.</p></div><Btn onClick={openNew}>+ Добавить</Btn></div>

      <div className="flex flex-wrap gap-1.5">
        <button onClick={() => setFilter("all")} className={`px-3 py-1 rounded-full text-xs font-medium ${filter === "all" ? "bg-amber-500 text-white" : "bg-gray-100 text-gray-600"}`}>Все · {crm.length}</button>
        {CRM_STATUSES.map(s => counts[s.v] ? <button key={s.v} onClick={() => setFilter(s.v)} className={`px-3 py-1 rounded-full text-xs font-medium ${filter === s.v ? "bg-amber-500 text-white" : s.cls}`}>{s.label} · {counts[s.v]}</button> : null)}
      </div>

      {showAdd && (
        <Modal title={editId ? "Изменить запись" : "Новый потенциальный клиент"} onClose={() => setShowAdd(false)}>
          <div className="space-y-3">
            <Inp label="Название / имя" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="напр. Кафе на Абая" />
            <Sel label="Статус" value={form.status} onChange={e => setForm({ ...form, status: e.target.value })} options={CRM_STATUSES.map(s => ({ value: s.v, label: s.label }))} />
            <Inp label="Телефон / WhatsApp" value={form.contact} onChange={e => setForm({ ...form, contact: e.target.value })} />
            <Inp label="Адрес" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} />
            <Inp label="Когда связаться (по желанию)" type="date" value={form.next_date} onChange={e => setForm({ ...form, next_date: e.target.value })} />
            <div>
              <div className="text-sm font-medium text-gray-700 mb-1">Личные записи</div>
              <textarea rows={3} value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} placeholder="напр. просил цену на высший, перезвонить после 15:00, берёт у конкурента по 250" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300" />
            </div>
          </div>
          <div className="flex gap-2 mt-4"><Btn onClick={save} disabled={saving || !form.name.trim()}>{saving ? "Сохраняю…" : "Сохранить"}</Btn><Btn variant="secondary" onClick={() => setShowAdd(false)}>Отмена</Btn></div>
        </Modal>
      )}

      <div className="space-y-2">
        {crm.length === 0 && <div className="text-center py-12 text-gray-400">Пока пусто. Нажми «+ Добавить», чтобы занести первого.</div>}
        {crm.length > 0 && list.length === 0 && <div className="text-center py-8 text-gray-400">В этом статусе никого нет.</div>}
        {list.map(c => {
          const st = crmStatus(c.status);
          return (
            <div key={c.id} className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap"><span className="font-bold text-gray-900">{c.name}</span><span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span></div>
                  {c.contact && <div className="text-sm text-gray-500 mt-0.5 flex items-center gap-1.5"><Icon name="phone" size={13} />{c.contact}</div>}
                  {c.address && <div className="text-sm text-gray-500 flex items-center gap-1.5"><Icon name="pin" size={13} />{c.address}</div>}
                  {c.next_date && <div className="text-xs text-amber-700 bg-amber-50 rounded-lg px-2 py-1 mt-1 inline-flex items-center gap-1"><Icon name="bell" size={12} />связаться {(c.next_date || "").split("-").reverse().join(".")}</div>}
                  {c.note && <div className="text-sm text-gray-700 bg-gray-50 rounded-lg px-3 py-2 mt-1.5 whitespace-pre-wrap">{c.note}</div>}
                </div>
                <div className="flex gap-1 flex-shrink-0"><Btn size="sm" variant="secondary" onClick={() => openEdit(c)}><Icon name="pencil" size={15} /></Btn><Btn size="sm" variant="danger" onClick={() => del(c.id)}><Icon name="trash" size={15} /></Btn></div>
              </div>
              <div className="flex items-center gap-2 flex-wrap mt-3">
                <select value={c.status} onChange={e => setStatus(c, e.target.value)} className="border border-gray-200 rounded-lg px-2 py-1 text-xs">
                  {CRM_STATUSES.map(s => <option key={s.v} value={s.v}>{s.label}</option>)}
                </select>
                <Btn size="sm" onClick={() => toClient(c)}>✅ В клиенты</Btn>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ExpensesTab({ expenses, reload, openSignal = 0, canEdit = true }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);
  const [saving, setSaving] = useState(false);
  const blank = { date: TODAY(), category: EXPENSE_CATS[0], amount: "", note: "" };
  const [form, setForm] = useState(blank);
  // Открыть форму расхода по сигналу с кнопки «+»
  useEffect(() => { if (openSignal) { setEditId(null); setForm(blank); setShowAdd(true); } }, [openSignal]);

  const openNew = () => { setEditId(null); setForm(blank); setShowAdd(true); };
  const openEdit = x => { setEditId(x.id); setForm({ date: x.date, category: catName(x.category), amount: x.amount, note: x.note || "" }); setShowAdd(true); };
  const save = async () => {
    if (!form.amount) return;
    setSaving(true);
    try { await dbUpsert("expenses", { id: editId || uid(), date: form.date, category: form.category, amount: Number(form.amount), note: form.note }); setShowAdd(false); await reload("expenses"); }
    catch (e) { alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз."); }
    setSaving(false);
  };
  const del = async id => { if (!confirm("Удалить расход?")) return; try { await dbDelete("expenses", id); await reload("expenses"); } catch (e) { alert("⚠️ Не удалилось: " + (e && e.message ? e.message : e)); } };

  const now = new Date();
  const monthTotal = expenses.filter(x => { const d = new Date(x.date); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); }).reduce((s, x) => s + (x.amount || 0), 0);
  const sorted = [...expenses].sort((a, b) => b.date.localeCompare(a.date));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between"><h3 className="font-bold text-gray-800">Расходы</h3>{canEdit && <Btn onClick={openNew}>+ Расход</Btn>}</div>
      <div className="bg-gradient-to-br from-rose-50 to-red-50 rounded-2xl p-4"><div className="text-xs text-red-700 font-medium">Расходы за текущий месяц</div><div className="text-2xl font-bold text-red-700">{fmt(monthTotal)} тг</div></div>
      {showAdd && (
        <Modal title={editId ? "Изменить расход" : "Новый расход"} onClose={() => setShowAdd(false)}>
          <div className="space-y-3">
            <Inp label="Дата" type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
            <Sel label="Категория" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} options={EXPENSE_CATS} />
            <Inp label="Сумма, тг" type="number" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} />
            <Inp label="Примечание" value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} placeholder="напр. оплата фуры, водитель Эрик, поддоны" />
          </div>
          <div className="flex gap-2 mt-4">
            <Btn onClick={save} disabled={saving || !form.amount}>{saving ? "Сохраняю..." : "Сохранить"}</Btn>
            <Btn variant="secondary" onClick={() => setShowAdd(false)}>Отмена</Btn>
          </div>
        </Modal>
      )}
      <div className="space-y-2">
        {expenses.length === 0 && <div className="text-center py-12 text-gray-400">Расходов нет.</div>}
        {sorted.map(x => (
          <div key={x.id} className="bg-white border border-gray-100 rounded-xl px-4 py-3 flex items-center justify-between text-sm">
            <div>
              <div className="font-medium text-gray-900">{catName(x.category)} — {fmt(x.amount)} тг</div>
              <div className="text-xs text-gray-400">{(x.date || "").split("-").reverse().join(".")}{x.note ? ` · ${x.note}` : ""}{x.created_by_name ? ` · ${x.created_by_name}` : ""}</div>
            </div>
            {canEdit && <div className="flex gap-1"><Btn size="sm" variant="secondary" onClick={() => openEdit(x)}><Icon name="pencil" size={15} /></Btn><Btn size="sm" variant="danger" onClick={() => del(x.id)}><Icon name="trash" size={15} /></Btn></div>}
          </div>
        ))}
      </div>
    </div>
  );
}

const CONTRACT_SUPPLIER = `8. Юридические адреса и реквизиты Сторон

«ПОСТАВЩИК»:
ТОО «BEST MILL»
Республика Казахстан, Карагандинская область, г. Караганда, район им. Казыбек Би, учетный квартал 168, строение 1
БИН 110440013701
ИИК KZ18998HTB0000486384 (KZT)
АО «Alatau City Bank»
БИК TSESKZKA
телефон whatsApp +7 705 759 41 14
эл. адрес: astana@darad.kz

Директор _____________________________ Ли А. Ю.


«ПОКУПАТЕЛЬ»:
{{org}}
Адрес: {{legal_address}}
БИН (ИИН): {{bin}}
ИИК: {{iik}}
{{bank}}
БИК: {{bik}}
телефон whatsApp: {{phone}}
эл. адрес: {{email}}

Директор _____________________________ {{director}}`;

const CONTRACT_HEAD = `ДОГОВОР ПОСТАВКИ № 〔ВПИШИТЕ №〕
г. Караганда                           〔ВПИШИТЕ дату〕

ТОО «BEST MILL», именуемое в дальнейшем «Поставщик», в лице директора Ли А. Ю., действующего на основании Устава, с одной стороны, и
{{org}}, именуемое в дальнейшем «Покупатель», в лице {{director}}, действующего на основании 〔ВПИШИТЕ: Устава / Свидетельства〕, с другой стороны, совместно именуемые в Договоре «Стороны», заключили настоящий Договор о нижеследующем:

1. Предмет Договора
1.1. Поставщик обязуется продать, а Покупатель обязуется принять и оплатить муку пшеничную первого и высшего сорта (далее - Товар) качеством в соответствии с ГОСТ 26574-2017 на условиях настоящего договора.
1.2. Единица измерения Товара - килограмм.
1.3. Поставка товара осуществляется в упаковке (или мешках) по 2, 5, 10, 25 и 50 (пятьдесят) килограмм (фасовка Товара) в соответствии с заявкой Покупателя.

2. Цена и порядок расчетов
2.1. Цена каждой партии Товара определяется в порядке, предусмотренном пунктами 3.3 и 3.4. настоящего договора.`;

const POSTOPLATA = `${CONTRACT_HEAD}
2.2. Оплата каждой партии Товара производится Покупателем в течение 〔семи〕 дней с момента ее поставки.
2.3. Оплата осуществляется Покупателем в безналичной форме путем перечисления денег на расчетный счет Поставщика.
2.4. Право собственности на каждую партию Товара у Покупателя возникает после полного расчета с Поставщиком за поставленную партию Товара.

3. Сроки и условия поставки и приемки
3.1. Поставка Товара осуществляется партиями по заявкам Покупателя, которые должны быть направлены Поставщику следующими способами: электронный адрес или в приложение-мессенджер WhatsApp, по реквизитам, указанным в разделе 8 настоящего договора.
3.2. Заявка должна содержать: наименование Товара, сорт, количество, фасовку Товара, условия поставки (самовывоз или доставка).
3.3. Поставщик в течение одного рабочего дня с момента получения Заявки направляет Покупателю информацию о возможности поставки Товара, указанного в заявке, и его цене.
3.4. О несогласии с ценой Товара Покупатель обязан уведомить Поставщика в течение одного рабочего дня с момента получения информации согласно п.3.3. настоящего договора. В случае не уведомления Покупателем Поставщика в указанный срок, цена на партию Товара считается согласованной Сторонами.
3.5. Поставка Товара осуществляется в течение 6 рабочих дней с момента подтверждения Поставщиком возможности поставки по соответствующей заявке и согласования цены.
3.6. При приемке Товара Покупатель обязан проверить вес, количество мест и качество Товара. После подписания обеими Сторонами накладной партия Товара признается Сторонами поставленной в соответствии с условиями настоящего договора и соответствующей заявкой, претензии по количеству и качеству не могут быть предъявлены Поставщику.

4. Ответственность сторон и порядок разрешения спора
4.1. В случае невыполнения или ненадлежащего выполнения своих обязательств, стороны несут ответственность в соответствии с действующим законодательством Республики Казахстан.
4.2. За необоснованный отказ от получения Товара Покупатель оплачивает Поставщику штраф в размере 15 % от стоимости Товара.
4.3. За несвоевременную оплату за Товар, Покупатель оплачивает Поставщику неустойку в размере 0,1 % от стоимости неоплаченного Товара за каждый день просрочки платежа.
4.4. В случае просрочки оплаты за Товар, Поставщик вправе приостановить поставку последующих партий Товара до погашения задолженности.
4.5. Все споры и разногласия, которые могут возникнуть из настоящего Договора или в связи с ним, будут, по возможности, решаться путем переговоров между Сторонами. Если Стороны не придут к согласию, то спорный вопрос подлежит урегулированию Специализированным межрайонным экономическим судом Карагандинской области.

5. Форс-мажор
5.1. При возникновении обстоятельств, препятствующих полному или частичному исполнению обязательств по настоящему Договору любой из Сторон, а именно: стихийные бедствия, военные действия, блокада, изменение условий экспорта или импорта на правительственном уровне, либо иные объективные обязательства, не зависящие от воли Сторон и препятствующие выполнению Сторонами своих обязательств по настоящему Договору, срок выполнения настоящего Договора продлевается не более, чем на 30 дней.
5.2. Сторона, для которой исполнение её обязательств по настоящему Договору становится невозможным, должна незамедлительно известить другую Сторону о начале и предполагаемой продолжительности действия обстоятельств, препятствующих исполнению ее обязательств. Документом, бесспорно подтверждающим наступление форс-мажорных обстоятельств, Стороны признают справку соответствующей Торговой Палаты.

6. Срок действия Договора
6.1. Настоящий Договор вступает в силу после его подписания обеими Сторонами и действует до 31 декабря 2026 года, а в части взаиморасчетов - до полного исполнения Сторонами своих обязательств.
6.2. Действие Договора продлевается на каждый последующий календарный год, если ни одна из Сторон не заявит о своём намерении прекратить его не позднее, чем за месяц до истечения срока действия Договора.
6.3. Настоящий Договор может быть расторгнут по инициативе одной из Сторон при условии письменного предупреждения об этом другой Стороны за 30 (Тридцать) календарных дней до момента расторжения настоящего Договора.

7. Другие условия
7.1. Все цены и конкретные условия поставки Товара составляют коммерческую тайну Сторон и не могут раскрыться ни одной из Сторон перед любой третьей стороной без ведома и согласия на то другой Стороны.
7.2. Стороны обязаны незамедлительно информировать друг друга в письменной форме о любых изменениях юридического адреса, юридического статуса, организационно-правовой формы или банковских реквизитов.
7.3. Уведомления, требования, претензии, письма по настоящему договору считаются надлежащим образом доставленными, если они направлены другой стороне одним из следующих способов: на электронный адрес или в приложение-мессенджер WhatsApp, по реквизитам, указанным в разделе 8 настоящего договора, или нарочно.
7.4. Договор, подписанный и переданный по электронной почте, имеет полную юридическую силу до предоставления оригинала.
7.5. Настоящий Договор составлен в двух аутентичных по содержанию и имеющих одинаковую юридическую силу экземплярах на 2 (двух) листах, на русском языке, один экземпляр для Покупателя, один экземпляр для Поставщика.

${CONTRACT_SUPPLIER}`;

const PREDOPLATA = `${CONTRACT_HEAD}
2.2. Оплата каждой партии Товара производится Покупателем в форме 100% предоплаты в течение 〔ВПИШИТЕ кол-во〕 дней с момента согласования цены на партию Товара. В случае несоблюдения указанного срока оплаты, цена на Товар может быть изменена Поставщиком в одностороннем порядке.
2.3. Оплата осуществляется Покупателем в безналичной форме путем перечисления денег на расчетный счет Поставщика.
2.4. Право собственности на каждую партию Товара у Покупателя возникает с момента подписания сторонами накладной на соответствующую партию Товара.

3. Сроки и условия поставки и приемки
3.1. Поставка Товара осуществляется партиями по заявкам Покупателя, которые должны быть направлены Поставщику следующими способами: электронный адрес или в приложение-мессенджер WhatsApp, по реквизитам, указанным в разделе 8 настоящего договора.
3.2. Заявка должна содержать: наименование Товара, сорт, количество, фасовку Товара, условия поставки (самовывоз или доставка).
3.3. Поставщик в течение одного рабочего дня с момента получения Заявки направляет Покупателю информацию о возможности поставки Товара, указанного в заявке, и его цене.
3.4. О несогласии с ценой Товара Покупатель обязан уведомить Поставщика в течение одного рабочего дня с момента получения информации согласно п.3.3. настоящего договора. В случае не уведомления Покупателем Поставщика в указанный срок, цена на партию Товара считается согласованной Сторонами.
3.5. Поставка партии Товара осуществляется в течение 6 рабочих дней с момента получения предоплаты.
3.6. При приемке Товара Покупатель обязан проверить вес, количество мест и качество Товара. После подписания обеими Сторонами накладной партия Товара признается Сторонами поставленной в соответствии с условиями настоящего договора и соответствующей заявкой, претензии по количеству и качеству не могут быть предъявлены Поставщику.

4. Ответственность сторон и порядок разрешения спора
4.1. В случае невыполнения или ненадлежащего выполнения своих обязательств, стороны несут ответственность в соответствии с действующим законодательством Республики Казахстан.
4.2. За необоснованный отказ от получения Товара, Покупатель оплачивает Поставщику штраф в размере 15 % от стоимости Товара.
4.3. За несвоевременную оплату за Товар, Покупатель оплачивает Поставщику неустойку в размере 0,1 % от стоимости неоплаченного Товара за каждый день просрочки платежа.
4.4. Все споры и разногласия, которые могут возникнуть из настоящего Договора или в связи с ним, будут, по возможности, решаться путем переговоров между Сторонами. Если Стороны не придут к согласию, то спорный вопрос подлежит урегулированию Специализированным межрайонным экономическим судом Карагандинской области.

5. Форс-мажор
5.1. При возникновении обстоятельств, препятствующих полному или частичному исполнению обязательств по настоящему Договору любой из Сторон, а именно: стихийные бедствия, военные действия, блокада, изменение условий экспорта или импорта на правительственном уровне, либо иные объективные обязательства, не зависящие от воли Сторон и препятствующие выполнению Сторонами своих обязательств по настоящему Договору, срок выполнения настоящего Договора продлевается не более, чем на 30 дней.
5.2. Сторона, для которой исполнение её обязательств по настоящему Договору становится невозможным, должна незамедлительно известить другую Сторону о начале и предполагаемой продолжительности действия обстоятельств, препятствующих исполнению ее обязательств. Документом, бесспорно подтверждающим наступление форс-мажорных обстоятельств, Стороны признают справку соответствующей Торговой Палаты.

6. Срок действия Договора
6.1. Настоящий Договор вступает в силу после его подписания обеими Сторонами и действует до 31 декабря 2026 года, а в части взаиморасчетов - до полного исполнения Сторонами своих обязательств.
6.2. Действие Договора продлевается на каждый последующий календарный год, если ни одна из Сторон не заявит о своём намерении прекратить его не позднее, чем за месяц до истечения срока действия Договора.
6.3. Настоящий Договор может быть расторгнут по инициативе одной из Сторон при условии письменного предупреждения об этом другой Стороны за 30 (Тридцать) календарных дней до момента расторжения настоящего Договора.

7. Другие условия
7.1. Все цены и конкретные условия поставки Товара составляют коммерческую тайну Сторон и не могут раскрыться ни одной из Сторон перед любой третьей стороной без ведома и согласия на то другой Стороны.
7.2. Стороны обязаны незамедлительно информировать друг друга в письменной форме о любых изменениях юридического адреса, юридического статуса, организационно-правовой формы или банковских реквизитов.
7.3. Уведомления, требования, претензии, письма по настоящему договору считаются надлежащим образом доставленными, если они направлены другой стороне одним из следующих способов: на электронный адрес или в приложение-мессенджер WhatsApp, по реквизитам, указанным в разделе 8 настоящего договора, или нарочно.
7.4. Договор, подписанный и переданный по электронной почте, имеет полную юридическую силу до предоставления оригинала.
7.5. Настоящий Договор составлен в двух аутентичных по содержанию и имеющих одинаковую юридическую силу экземплярах на 2 (двух) листах, на русском языке, один экземпляр для Покупателя, один экземпляр для Поставщика.

${CONTRACT_SUPPLIER}`;

const CONTRACT_TEMPLATES = [
  { key: "postoplata", name: "Постоплата (оплата после поставки)", text: POSTOPLATA },
  { key: "predoplata", name: "Предоплата (100% предоплата)", text: PREDOPLATA },
];

// 🧾 Мягкая накладная — точная копия Excel-шаблона «расх. накладная на выезд»:
// две копии на листе, те же колонки/шрифты/высоты строк. Позиции подставляются из заявок клиента за дату.
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

// Генератор PDF (pdfmake с кириллицей) — подгружается один раз
function loadPdfMake() {
  return new Promise((resolve, reject) => {
    if (window.pdfMake && window.pdfMake.vfs) return resolve(window.pdfMake);
    const s1 = document.createElement("script");
    s1.src = "https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.10/pdfmake.min.js";
    s1.onload = () => {
      const s2 = document.createElement("script");
      s2.src = "https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.10/vfs_fonts.js";
      s2.onload = () => resolve(window.pdfMake);
      s2.onerror = () => reject(new Error("Не удалось загрузить шрифты PDF"));
      document.body.appendChild(s2);
    };
    s1.onerror = () => reject(new Error("Не удалось загрузить генератор PDF"));
    document.body.appendChild(s1);
  });
}

// Мягкая накладная: две копии на листе. rows = [{name, qty(мешков), price(за мешок), bag_kg}]
async function buildSoftInvoicePdf({ buyer, rows, date, docNum = "1" }) {
  const pdfMake = await loadPdfMake();
  const fmt2 = n => (Number(n) || 0).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const filled = rows.filter(r => Number(r.qty) > 0);
  const total = filled.reduce((s, r) => s + (Number(r.qty) || 0) * (Number(r.price) || 0), 0);
  const d = new Date(date + "T00:00:00");
  const day = isNaN(d) ? "" : d.getDate();
  const monthYear = isNaN(d) ? "" : `${MONTHS_GEN[d.getMonth()]} ${d.getFullYear()} г`;
  const cell = (t, extra = {}) => ({ text: String(t ?? ""), fontSize: 10.5, ...extra });
  const copyContent = () => [
    { text: "Основное подразделение", bold: true, fontSize: 14, margin: [300, 0, 0, 6] },
    { table: { widths: [80, 45, 95], body: [
      [cell("Номер документа", { bold: true, fontSize: 8.5, alignment: "center" }), { ...cell("Дата составления", { bold: true, fontSize: 8.5, alignment: "center" }), colSpan: 2 }, {}],
      [cell(docNum, { alignment: "center" }), cell(day, { alignment: "center" }), cell(monthYear, { alignment: "center" })],
    ] }, margin: [240, 0, 0, 16] },
    { columns: [{ width: 78, text: "Покупатель:", bold: true, fontSize: 11 }, { width: "auto", text: buyer, fontSize: 11, decoration: "underline" }], margin: [0, 0, 0, 12] },
    { table: { widths: [20, "*", 58, 66, 52, 70], body: [
      ["№", "Наименование, сорт, размер", "Кол-во мешков", "Цена за мешок", "Кол-во кг", "Сумма"].map(h => cell(h, { bold: true, alignment: "center", fontSize: 10 })),
      ...filled.map((r, i) => {
        const qty = Number(r.qty) || 0, price = Number(r.price) || 0, kg = qty * (Number(r.bag_kg) || 0);
        return [cell(i + 1, { alignment: "center" }), cell(r.name), cell(fmt2(qty), { alignment: "center" }), cell(fmt2(price), { alignment: "center" }), cell(kg ? fmt(kg) : "", { alignment: "center" }), cell(fmt(qty * price), { alignment: "center" })];
      }),
    ] } },
    { columns: [{ width: "*", text: "" }, { width: "auto", text: `Итого: ${fmt(total)} тенге`, bold: true, fontSize: 12 }], margin: [0, 8, 12, 0] },
    { text: "Принял______________/", fontSize: 11, margin: [40, 26, 0, 0] },
    { columns: [{ width: 230, text: "Кассир ______________/", fontSize: 11 }, { width: "auto", text: "Менеджер ______________/", fontSize: 11 }], margin: [40, 14, 0, 0] },
  ];
  const dd = { pageSize: "A4", pageMargins: [28, 24, 28, 20], content: [...copyContent(), { text: "", margin: [0, 26, 0, 0] }, ...copyContent()] };
  pdfMake.createPdf(dd).download(`Накладная_${(buyer || "клиент").replace(/[\\/:*?"<>|]/g, "")}_${date}.pdf`);
}

// Мягкая накладная прямо из заявки клиента (позиции берём из самой заявки)
async function softInvoiceFromOrders(group, client) {
  const orders = (group.orders || []).filter(o => !o.trial && !o.isSample); // бесплатные пробы в накладную не идут
  if (!orders.length) { alert("В этой заявке нечего выставлять — только бесплатные пробы."); return; }
  // Объединяем одинаковые позиции (тот же сорт/фасовка/цена)
  const m = {};
  orders.forEach(o => {
    const k = `${o.brand}|${o.grade}|${o.bag_kg}|${o.price_per_kg || 0}`;
    if (!m[k]) m[k] = { name: `${o.brand} ${o.bag_kg} кг ${o.grade}`, bag_kg: Number(o.bag_kg) || 0, qty: 0, price: Math.round((o.price_per_kg || 0) * (Number(o.bag_kg) || 0)) };
    m[k].qty += Number(o.bags) || 0;
  });
  await buildSoftInvoicePdf({
    buyer: (client && (client.org_name || client.name)) || group.clientName || "Клиент",
    rows: Object.values(m),
    date: orders[0].date || TODAY(),
  });
}
function SoftInvoiceTab({ clients, orders }) {
  const [clientId, setClientId] = useState("");
  const [buyer, setBuyer] = useState("");
  const [date, setDate] = useState(TODAY());
  const [docNum, setDocNum] = useState("1");
  const [rows, setRows] = useState([]);

  // Выбрал клиента → подставляем ВСЕ позиции его прайса (наименование + цена за мешок).
  // Вручную остаётся заполнить только количество мешков; пустые строки в печать не идут.
  const pickClient = id => {
    setClientId(id);
    const c = clients.find(x => x.id === id);
    setBuyer(c ? c.name : "");
    setRows(c ? (c.prices || []).map(p => ({
      name: `${p.brand} ${p.bag_kg} кг ${p.grade}`,
      bag_kg: Number(p.bag_kg) || 0,
      qty: "",
      price: Math.round((p.price_per_kg || 0) * (Number(p.bag_kg) || 0)),
    })) : []);
  };
  const upd = (i, k, v) => setRows(rs => rs.map((r, j) => j === i ? { ...r, [k]: v } : r));
  const filled = rows.filter(r => Number(r.qty) > 0); // в печать идут только строки с количеством
  const total = filled.reduce((s, r) => s + (Number(r.qty) || 0) * (Number(r.price) || 0), 0);
  const fmt2 = n => (Number(n) || 0).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const [pdfBusy, setPdfBusy] = useState(false);
  const downloadPdf = async () => {
    setPdfBusy(true);
    try { await buildSoftInvoicePdf({ buyer, rows, date, docNum }); }
    catch (e) { alert("⚠️ " + (e.message || e) + "\nПроверь интернет и попробуй ещё раз."); }
    setPdfBusy(false);
  };

  const printInvoice = () => {
    const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const d = new Date(date + "T00:00:00");
    const day = isNaN(d) ? "" : d.getDate();
    const monthYear = isNaN(d) ? "" : `${MONTHS_GEN[d.getMonth()]} ${d.getFullYear()} г`;
    // строк ровно столько, сколько заполненных позиций; форматы чисел как в образце PDF (15,00 · 7 875,00 · 118 125)
    const tr = (r, i) => {
      const qty = Number(r.qty) || 0, price = Number(r.price) || 0;
      const kg = qty * (Number(r.bag_kg) || 0);
      return `<tr class="line"><td class="bx c">${i + 1}</td><td class="bx">${esc(r.name)}</td><td class="bx c tnr">${fmt2(qty)}</td><td class="bx c tnr">${fmt2(price)}</td><td class="bx c tnr">${kg ? fmt(kg) : ""}</td><td class="bx c">${fmt(qty * price)}</td></tr>`;
    };
    const copy = `
      <div class="hdr">Основное подразделение</div>
      <table class="doc">
        <colgroup><col style="width:60px"><col style="width:230px"><col style="width:95px"><col style="width:105px"><col style="width:95px"><col style="width:110px"></colgroup>
        <tr style="height:40px"><td colspan="2"></td><td class="bx c b s10">Номер документа</td><td class="bx c b s10" colspan="3">Дата составления</td></tr>
        <tr><td colspan="2"></td><td class="bx c">${esc(docNum)}</td><td class="bx c">${day}</td><td class="bx c" colspan="2">${monthYear}</td></tr>
        <tr class="line"><td></td></tr>
        <tr class="line"><td></td></tr>
        <tr class="line"><td class="b" style="white-space:nowrap">Покупатель:</td><td class="ub" colspan="3">${esc(buyer)}</td></tr>
        <tr class="line"><td></td></tr>
        <tr style="height:40px"><td class="bx c b">№</td><td class="bx c b">Наименование, сорт, размер</td><td class="bx c b">Кол-во мешков</td><td class="bx c b">Цена за мешок</td><td class="bx c b">Кол-во кг</td><td class="bx c b">Сумма</td></tr>
        ${filled.map((r, i) => tr(r, i)).join("")}
        <tr style="height:24px"><td colspan="3"></td><td class="b s12" style="text-align:right">Итого: </td><td class="b s12 c">${fmt(total)}</td><td class="b">тенге</td></tr>
        <tr class="line"><td></td></tr>
        <tr class="line"><td></td></tr>
        <tr class="line"><td></td><td>Принял______________/</td></tr>
        <tr class="line"><td></td></tr>
        <tr class="line"><td></td><td>Кассир ______________/</td><td colspan="2"></td><td colspan="2">Менеджер ______________/</td></tr>
      </table>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Накладная</title><style>
      @page{size:A4 portrait;margin:7mm 10mm}
      body{font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#000;margin:0}
      table.doc{border-collapse:collapse;table-layout:fixed}
      td{padding:1px 4px;overflow:hidden;white-space:nowrap}
      tr.line{height:21px}
      .bx{border:1px solid #000}
      .c{text-align:center}
      .b{font-weight:bold}
      .s10{font-size:10pt}
      .s12{font-size:12pt}
      .tnr{font-family:'Times New Roman',serif}
      .ub{border-bottom:1px solid #000}
      .hdr{font-weight:bold;font-size:14pt;margin:6px 0 4px 470px;white-space:nowrap}
      .gap{height:80px}
    </style></head><body>${copy}<div class="gap"></div>${copy}</body></html>`;
    const old = document.getElementById("print-frame");
    if (old) old.remove();
    const iframe = document.createElement("iframe");
    iframe.id = "print-frame";
    iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow.document;
    doc.open(); doc.write(html); doc.close();
    setTimeout(() => { try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch (e) {} setTimeout(() => iframe.remove(), 3000); }, 400);
  };

  return (
    <div className="space-y-4">
      <div className="bg-blue-50 border border-blue-100 rounded-2xl p-4 text-sm text-blue-800 flex items-start gap-2"><span className="mt-0.5 shrink-0"><Icon name="receipt" size={16} /></span><span>Выбери клиента — подставятся все позиции его прайса с ценами за мешок. Проставь <b>только количество мешков</b> у нужных позиций: в накладную попадут именно они, ровно столько строк. Печать — две копии на листе.</span></div>
      <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-4 space-y-3">
        <Sel label="Клиент (покупатель)" value={clientId} onChange={e => pickClient(e.target.value)} options={[{ value: "", label: "— выбери клиента —" }, ...clients.map(c => ({ value: c.id, label: c.name + (c.org_name ? ` (${c.org_name})` : "") }))]} />
        <div className="grid grid-cols-2 gap-3">
          <Inp label="Покупатель (как в накладной)" value={buyer} onChange={e => setBuyer(e.target.value)} placeholder="можно вписать вручную" />
          <Inp label="Дата составления" type="date" value={date} onChange={e => setDate(e.target.value)} />
        </div>
        <div className="w-32"><Inp label="Номер документа" value={docNum} onChange={e => setDocNum(e.target.value)} /></div>
      </div>
      <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="font-bold text-gray-800">Позиции из прайса клиента</div>
          <Btn size="sm" variant="secondary" onClick={() => setRows(rs => [...rs, { name: "", bag_kg: 50, qty: "", price: "" }])}>+ строка</Btn>
        </div>
        {rows.length === 0 && <div className="text-sm text-gray-400 text-center py-4">{clientId ? "У этого клиента нет цен в карточке — добавь их во вкладке «Клиенты» или строку вручную." : "Выбери клиента — позиции его прайса появятся здесь."}</div>}
        {rows.map((r, i) => {
          const qty = Number(r.qty) || 0;
          const kg = qty * (Number(r.bag_kg) || 0);
          const sum = qty * (Number(r.price) || 0);
          return (
            <div key={i} className={`border rounded-xl p-3 mb-2 ${qty > 0 ? "border-emerald-300 bg-emerald-50" : "border-gray-100"}`}>
              <div className="flex items-center justify-between gap-2 mb-1">
                <input value={r.name} onChange={e => upd(i, "name", e.target.value)} placeholder="ДАРАД 50 кг Высший сорт" className="font-medium text-gray-900 bg-transparent flex-1 focus:outline-none border-b border-transparent focus:border-amber-300" />
                <button onClick={() => setRows(rs => rs.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-600 text-lg leading-none flex-shrink-0" title="Убрать">✕</button>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Inp label="Мешков" type="number" value={r.qty} onChange={e => upd(i, "qty", e.target.value)} placeholder="0" />
                <Inp label="Цена за мешок" type="number" value={r.price} onChange={e => upd(i, "price", e.target.value)} />
                <Inp label="Фасовка, кг" type="number" value={r.bag_kg} onChange={e => upd(i, "bag_kg", e.target.value)} />
              </div>
              {qty > 0 && <div className="text-xs text-emerald-700 font-medium mt-1">✓ в накладную: {fmt(kg)} кг · {fmt(sum)} тг</div>}
            </div>
          );
        })}
        {filled.length > 0 && <div className="text-right font-bold text-gray-800 mt-2">Позиций: {filled.length} · Итого: {fmt(total)} тенге</div>}
      </div>
      <div className="flex gap-2">
        <button onClick={downloadPdf} disabled={!buyer || filled.length === 0 || pdfBusy} className="flex-1 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded-xl font-semibold px-4 py-3">{pdfBusy ? "Собираю PDF..." : "⬇️ Скачать PDF"}</button>
        <button onClick={printInvoice} disabled={!buyer || filled.length === 0} className="flex-1 bg-gray-100 hover:bg-gray-200 disabled:opacity-50 text-gray-700 rounded-xl font-semibold px-4 py-3">🖨 Сразу на печать</button>
      </div>
    </div>
  );
}

// ═══════════ 🗂️ МЕНЕДЖЕРЫ КАРАГАНДА ═══════════
// Отдельный мир: свой справочник клиентов (kgd_clients), свои накладные-PDF по образцам BM.
// НИЧЕГО не сохраняется в заявки/склад/отчёты — сформировал два PDF и всё.

// Сумма прописью: 1800000 → «Один миллион восемьсот тысяч тенге 00 тиын»
function tengeInWords(n) {
  n = Math.floor(Number(n) || 0);
  const ones = ["", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
  const onesF = ["", "одна", "две", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
  const teens = ["десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать", "пятнадцать", "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать"];
  const tens = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто"];
  const hundreds = ["", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот"];
  const triple = (num, female) => {
    const o = female ? onesF : ones;
    const parts = [hundreds[Math.floor(num / 100)]];
    const r = num % 100;
    if (r >= 10 && r < 20) parts.push(teens[r - 10]);
    else { parts.push(tens[Math.floor(r / 10)]); parts.push(o[r % 10]); }
    return parts.filter(Boolean).join(" ");
  };
  const plural = (num, f) => { const r100 = num % 100, r10 = num % 10; if (r100 >= 11 && r100 <= 14) return f[2]; if (r10 === 1) return f[0]; if (r10 >= 2 && r10 <= 4) return f[1]; return f[2]; };
  if (n === 0) return "Ноль тенге 00 тиын";
  const out = [];
  const bln = Math.floor(n / 1e9), mln = Math.floor(n / 1e6) % 1000, th = Math.floor(n / 1000) % 1000, rest = n % 1000;
  if (bln) out.push(triple(bln, false), plural(bln, ["миллиард", "миллиарда", "миллиардов"]));
  if (mln) out.push(triple(mln, false), plural(mln, ["миллион", "миллиона", "миллионов"]));
  if (th) out.push(triple(th, true), plural(th, ["тысяча", "тысячи", "тысяч"]));
  if (rest) out.push(triple(rest, false));
  const s = out.filter(Boolean).join(" ") + " тенге 00 тиын";
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function countInWords(n) {
  const w = ["", "Один", "Два", "Три", "Четыре", "Пять", "Шесть", "Семь", "Восемь", "Девять", "Десять"];
  return w[n] || String(n);
}
// Генератор PDF (pdfmake) — тот же, что в накладных, отдельная копия для этого раздела
function loadPdfMakeKgd() {
  return new Promise((resolve, reject) => {
    if (window.pdfMake && window.pdfMake.vfs) return resolve(window.pdfMake);
    const s1 = document.createElement("script");
    s1.src = "https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.10/pdfmake.min.js";
    s1.onload = () => {
      const s2 = document.createElement("script");
      s2.src = "https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.10/vfs_fonts.js";
      s2.onload = () => resolve(window.pdfMake);
      s2.onerror = () => reject(new Error("Не удалось загрузить шрифты PDF"));
      document.body.appendChild(s2);
    };
    s1.onerror = () => reject(new Error("Не удалось загрузить генератор PDF"));
    document.body.appendChild(s1);
  });
}

// Офлайн-очередь документов Караганды: если сети нет — складываем на устройство,
// при появлении связи отправляем в историю автоматически.
const KGD_QUEUE = "kgd_queue";
const kgdQueueRead = () => { try { return JSON.parse(localStorage.getItem(KGD_QUEUE) || "[]"); } catch { return []; } };
const kgdQueueWrite = list => { try { localStorage.setItem(KGD_QUEUE, JSON.stringify(list)); } catch {} };
async function kgdFlushQueue(reload) {
  const q = kgdQueueRead();
  if (!q.length) return 0;
  const left = [];
  let sent = 0;
  for (const doc of q) {
    try { await dbUpsert("kgd_docs", doc); sent++; } catch { left.push(doc); }
  }
  kgdQueueWrite(left);
  if (sent && reload) reload("kgd_docs");
  return sent;
}

function KgdManagersTab({ kgdClients = [], kgdDocs = [], reload, canManage = true, isSenior = false, me = "" }) {
  const [view, setView] = useState("new"); // new | clients | history
  const [pending, setPending] = useState(kgdQueueRead().length);
  // При появлении связи автоматически отправляем накопленные документы в историю
  useEffect(() => {
    const flush = async () => { const n = await kgdFlushQueue(reload); setPending(kgdQueueRead().length); if (n) console.log("Отправлено в историю:", n); };
    flush();
    window.addEventListener("online", flush);
    const t = setInterval(flush, 60000);
    return () => { window.removeEventListener("online", flush); clearInterval(t); };
  }, []);
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);
  const [cf, setCf] = useState({ name: "", bin: "", address: "", products: [] });
  const [pf, setPf] = useState({ name: "", price_kg: "" });
  // форма отгрузки
  const [clientId, setClientId] = useState("");
  const [deal, setDeal] = useState("");
  const [docNum, setDocNum] = useState("");
  const [carNum, setCarNum] = useState("");
  const [date, setDate] = useState(TODAY());
  const [qty, setQty] = useState({}); // индекс товара -> кг
  const [pdfBusy, setPdfBusy] = useState("");
  // Заранее подтягиваем генератор PDF, пока есть связь — чтобы офлайн документы собирались сразу
  useEffect(() => { loadPdfMakeKgd().catch(() => {}); }, []);

  const client = kgdClients.find(c => c.id === clientId);
  const rows = client ? (client.products || []).map((p, i) => ({ ...p, kg: Number(qty[i]) || 0 })).filter(r => r.kg > 0) : [];
  const total = rows.reduce((s, r) => s + r.kg * (Number(r.price_kg) || 0), 0);
  const totalKg = rows.reduce((s, r) => s + r.kg, 0);
  const dateDisp = (date || "").split("-").reverse().join(".");

  const pickClient = id => { setClientId(id); setQty({}); };

  // Запись документа в историю. Нет связи — кладём в очередь на устройстве, уйдёт само при появлении сети.
  const saveToHistory = async kind => {
    const doc = {
      id: uid(), at: new Date().toISOString(), by: me, kind,
      clientId: client.id, clientName: client.name, bin: client.bin || "", address: client.address || "",
      deal, docNum, carNum, date,
      rows: rows.map(r => ({ name: r.name, kg: r.kg, price_kg: Number(r.price_kg) || 0 })),
      totalKg, total,
    };
    try { await dbUpsert("kgd_docs", doc); reload("kgd_docs"); }
    catch { kgdQueueWrite([...kgdQueueRead(), doc]); setPending(kgdQueueRead().length); } // офлайн — в очередь
  };

  // ─── Справочник клиентов ───
  const openNewClient = () => { setEditId(null); setCf({ name: "", bin: "", address: "", products: [] }); setPf({ name: "", price_kg: "" }); setShowAdd(true); };
  const openEditClient = c => { setEditId(c.id); setCf({ name: c.name || "", bin: c.bin || "", address: c.address || "", products: [...(c.products || [])] }); setPf({ name: "", price_kg: "" }); setShowAdd(true); };
  const addProduct = () => {
    if (!pf.name.trim() || !pf.price_kg) return;
    setCf(f => ({ ...f, products: [...f.products, { name: pf.name.trim(), price_kg: Number(pf.price_kg) }] }));
    setPf({ name: "", price_kg: "" });
  };
  const saveClient = async () => {
    if (!cf.name.trim()) { alert("Впиши название покупателя."); return; }
    try {
      await dbUpsert("kgd_clients", { id: editId || uid(), name: cf.name.trim(), bin: cf.bin.trim(), address: cf.address.trim(), products: cf.products });
      setShowAdd(false); await reload("kgd_clients");
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/kgd_clients|PGRST205/i.test(msg)) alert("Нужно один раз создать таблицу kgd_clients в Supabase — попроси у администратора инструкцию.");
      else alert("⚠️ Не сохранилось: " + msg);
    }
  };
  const deleteKgdClient = async c => {
    if (!confirm(`Удалить клиента «${c.name}» из справочника Караганды?`)) return;
    try { await dbDelete("kgd_clients", c.id); await reload("kgd_clients"); } catch (e) { alert("⚠️ " + ((e && e.message) || e)); }
  };

  // ─── PDF: Пропуск на погрузку (2 копии) ───
  const pdfPass = async () => {
    setPdfBusy("pass");
    try {
      const pdfMake = await loadPdfMakeKgd();
      const cell = (t, extra = {}) => ({ text: String(t ?? ""), fontSize: 9, ...extra });
      // ВАЖНО: каждая копия строится заново (фабрики) — pdfmake портит объекты при повторном использовании
      const header = () => ({ table: { widths: [90, "*", 80, 90], body: [[
        { stack: [cell("Сделка", { fontSize: 8, color: "#555" }), cell(deal ? `Сделка #${deal}` : " ")], margin: [2, 2, 2, 2] },
        { stack: [cell("Пропуск на погрузку товара №________", { bold: true, alignment: "center", margin: [0, 8, 0, 0] })] },
        { stack: [cell("№ а/м", { fontSize: 8, color: "#555" }), cell(carNum || " ")], margin: [2, 2, 2, 2] },
        { stack: [cell("Дата составления", { fontSize: 8, color: "#555" }), cell(dateDisp)], margin: [2, 2, 2, 2] },
      ]] } });
      const buyer = () => ({ text: [{ text: "Покупатель:  ", bold: true, fontSize: 9 }, { text: `${client.name}${client.bin ? `, БИН/ИИН ${client.bin}` : ""}`, fontSize: 9 }], margin: [0, 8, 0, 6] });
      const tbl = () => ({ table: { widths: [16, "*", 26, 52, 52, 56, 52], body: [
        ["№", "Наименование", "Ед.", "Кол-во кг", "Кол-во шт.", "Дата выбоя", "Факт. вес"].map(h => cell(h, { bold: true, alignment: "center", fontSize: 8.5 })),
        ...rows.map((r, i) => [cell(i + 1, { alignment: "center" }), cell(r.name), cell("кг", { alignment: "center" }), cell(fmt(r.kg), { alignment: "center" }), cell(" "), cell(" "), cell(" ")]),
      ] } });
      const sig = (l, r) => ({ columns: [{ text: l, fontSize: 9, width: "55%" }, { text: r || "", fontSize: 9, width: "*" }], margin: [0, 9, 0, 0] });
      const signatures = () => [
        sig("Въезд разрешил менеджер:  _______________________/", "Выезд разрешил менеджер:  ____________________/"),
        sig("Отгружено зав. складом:     _______________________/", "Б/н расчёт  ______________________________/"),
        sig("Ответственный лаборант:   _______________________/", "Опломбировано  ___________________________/"),
        sig("Оператор весовой:              _______________________/", ""),
        sig("Примечание:  ______________________________________________________________________________/", ""),
      ];
      const copy = withSignatures => [header(), buyer(), tbl(), ...(withSignatures ? signatures() : [sig("Примечание:  ______________________________________________________________________________/", "")])];
      const dd = { pageSize: "A4", pageMargins: [28, 22, 28, 20], content: [...copy(true), { text: "", margin: [0, 26, 0, 0] }, { canvas: [{ type: "line", x1: 0, y1: 0, x2: 539, y2: 0, dash: { length: 4 }, lineWidth: 0.5, lineColor: "#999" }] }, { text: "", margin: [0, 14, 0, 0] }, ...copy(false)] };
      pdfMake.createPdf(dd).download(`Пропуск_${(client.name || "").replace(/[\\/:*?"<>|]/g, "")}_${date}.pdf`);
      await saveToHistory("Пропуск");
    } catch (e) { alert("⚠️ " + ((e && e.message) || e)); }
    setPdfBusy("");
  };

  // ─── PDF: Расходная накладная с ценами (2 копии) ───
  const pdfInvoice = async () => {
    setPdfBusy("inv");
    try {
      const pdfMake = await loadPdfMakeKgd();
      const cell = (t, extra = {}) => ({ text: String(t ?? ""), fontSize: 9, ...extra });
      const money = n => (Number(n) || 0).toLocaleString("ru-RU").replace(/ /g, " ");
      // Каждая копия строится заново (фабрики) — pdfmake портит объекты при повторном использовании
      const header = () => ({ table: { widths: ["*", 90, 90], body: [[
        { stack: [cell("Сделка", { fontSize: 8, color: "#555" }), cell(deal ? `Сделка #${deal}` : " ", { bold: true })], margin: [2, 2, 2, 2] },
        { stack: [cell("Номер документа", { fontSize: 8, color: "#555", alignment: "center" }), cell(docNum || " ", { alignment: "center" })], margin: [2, 2, 2, 2] },
        { stack: [cell("Дата составления", { fontSize: 8, color: "#555", alignment: "center" }), cell(dateDisp, { alignment: "center" })], margin: [2, 2, 2, 2] },
      ]] } });
      const buyer = () => ({ text: [{ text: "Покупатель:  ", bold: true, fontSize: 9 }, { text: `${client.name}${client.bin ? `, БИН/ИИН ${client.bin}` : ""}`, fontSize: 9 }], margin: [0, 8, 0, 2] });
      const addr = () => ({ text: [{ text: "Адрес поставки:  ", bold: true, fontSize: 9 }, { text: client.address || " ", fontSize: 9 }], margin: [0, 0, 0, 6] });
      // Верхняя таблица — с ценой и суммой
      const tbl = () => ({ table: { widths: [16, 44, "*", 52, 26, 44, 66], body: [
        ["№", "Код", "Наименование", "Кол-во", "Ед.", "Цена", "Сумма"].map(h => cell(h, { bold: true, alignment: "center", fontSize: 8.5 })),
        ...rows.map((r, i) => [cell(i + 1, { alignment: "center" }), cell(" "), cell(r.name), cell(fmt(r.kg), { alignment: "center" }), cell("кг", { alignment: "center" }), cell(money(r.price_kg), { alignment: "right" }), cell(money(r.kg * r.price_kg), { alignment: "right" })]),
      ] } });
      // Нижняя таблица — БЕЗ цен (только ассортимент и тоннаж)
      const tblNoPrice = () => ({ table: { widths: [16, 44, "*", 60, 30], body: [
        ["№", "Код", "Наименование", "Кол-во", "Ед."].map(h => cell(h, { bold: true, alignment: "center", fontSize: 8.5 })),
        ...rows.map((r, i) => [cell(i + 1, { alignment: "center" }), cell(" "), cell(r.name), cell(fmt(r.kg), { alignment: "center" }), cell("кг", { alignment: "center" })]),
      ] } });
      const totalLine = t => ({ columns: [{ text: "", width: "*" }, { text: t, bold: true, fontSize: 9.5, width: "auto" }], margin: [0, 5, 4, 0] });
      const cashier = () => ({ columns: [{ text: "Кассир     _______________________/", fontSize: 9, width: "55%" }, { text: "Менеджер  ___________________/", fontSize: 9, width: "*" }], margin: [0, 16, 0, 0] });
      const full = [
        header(), buyer(), addr(), tbl(),
        totalLine(`Итого:  ${money(total)}.00 тенге`),
        totalLine(`Итого к оплате:  ${money(total)}.00 тенге`),
        { text: `Всего наименований ${countInWords(rows.length)}, на сумму ${money(total)}.00 тенге`, fontSize: 9, margin: [0, 8, 0, 0] },
        { text: "Всего к оплате: (сумма прописью)", fontSize: 9, margin: [0, 2, 0, 0] },
        { text: tengeInWords(total), fontSize: 9, bold: true, margin: [0, 2, 0, 0] },
        cashier(),
      ];
      // Нижняя копия — без цен и без итогов (для водителя)
      const short = [header(), buyer(), addr(), tblNoPrice(), cashier()];
      const dd = { pageSize: "A4", pageMargins: [28, 22, 28, 20], content: [...full, { text: "", margin: [0, 18, 0, 0] }, { canvas: [{ type: "line", x1: 0, y1: 0, x2: 539, y2: 0, dash: { length: 4 }, lineWidth: 0.5, lineColor: "#999" }] }, { text: "", margin: [0, 12, 0, 0] }, ...short] };
      pdfMake.createPdf(dd).download(`Накладная_${(client.name || "").replace(/[\\/:*?"<>|]/g, "")}_${date}.pdf`);
      await saveToHistory("Накладная");
    } catch (e) { alert("⚠️ " + ((e && e.message) || e)); }
    setPdfBusy("");
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <button onClick={() => setView("new")} className={`flex-1 py-2.5 rounded-xl text-sm font-medium inline-flex items-center justify-center gap-1.5 ${view === "new" ? "bg-amber-500 text-white" : "bg-gray-100 text-gray-600"}`}><Icon name="file" size={15} />Отгрузка</button>
        <button onClick={() => setView("clients")} className={`flex-1 py-2.5 rounded-xl text-sm font-medium inline-flex items-center justify-center gap-1.5 ${view === "clients" ? "bg-amber-500 text-white" : "bg-gray-100 text-gray-600"}`}><Icon name="building" size={15} />Клиенты ({kgdClients.length})</button>
        <button onClick={() => setView("history")} className={`flex-1 py-2.5 rounded-xl text-sm font-medium inline-flex items-center justify-center gap-1.5 ${view === "history" ? "bg-amber-500 text-white" : "bg-gray-100 text-gray-600"}`}><Icon name="clipboard" size={15} />История{pending > 0 ? ` (${pending})` : ""}</button>
      </div>
      {pending > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-sm text-amber-800">⏳ {pending} документ(ов) ждут отправки в историю — уйдут сами, когда появится интернет.</div>
      )}

      {view === "new" && (
        <>
          <div className="bg-blue-50 border border-blue-100 rounded-2xl p-4 text-sm text-blue-800">Выбери клиента и проставь количество кг — система посчитает суммы и соберёт два PDF: пропуск на погрузку и расходную накладную. <b>Ничего никуда не сохраняется</b> — скачал и распечатал.</div>
          <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-4 space-y-3">
            <Sel label="Покупатель" value={clientId} onChange={e => pickClient(e.target.value)} options={[{ value: "", label: "— выбери клиента —" }, ...[...kgdClients].sort((a, b) => (a.name || "").localeCompare(b.name || "", "ru")).map(c => ({ value: c.id, label: c.name }))]} />
            <div className="grid grid-cols-2 gap-3">
              <Inp label="Сделка №" value={deal} onChange={e => setDeal(e.target.value)} placeholder="4474" />
              <Inp label="Номер документа" value={docNum} onChange={e => setDocNum(e.target.value)} />
              <Inp label="№ а/м" value={carNum} onChange={e => setCarNum(e.target.value)} placeholder="123 ABC 01" />
              <Inp label="Дата составления" type="date" value={date} onChange={e => setDate(e.target.value)} />
            </div>
          </div>
          {client && (
            <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-4">
              <div className="font-bold text-gray-800 mb-2">Товары клиента — проставь кг</div>
              {(client.products || []).length === 0 && <div className="text-sm text-gray-400 py-3">У клиента нет товаров — добавь их во вкладке «Клиенты».</div>}
              {(client.products || []).map((p, i) => {
                const kg = Number(qty[i]) || 0;
                return (
                  <div key={i} className={`border rounded-xl p-3 mb-2 ${kg > 0 ? "border-emerald-300 bg-emerald-50" : "border-gray-100"}`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium text-gray-900 truncate">{p.name}</div>
                        <div className="text-xs text-gray-500">{fmt(p.price_kg)} тг/кг</div>
                      </div>
                      <div className="w-28"><Inp label="Кол-во, кг" type="number" value={qty[i] ?? ""} onChange={e => setQty(q => ({ ...q, [i]: e.target.value }))} placeholder="0" /></div>
                    </div>
                    {kg > 0 && <div className="text-xs text-emerald-700 font-medium mt-1">= {fmt(kg * (Number(p.price_kg) || 0))} тг</div>}
                  </div>
                );
              })}
              {rows.length > 0 && <div className="text-right font-bold text-gray-800 mt-2">{fmt(totalKg)} кг · Итого: {fmt(total)} тенге</div>}
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={pdfPass} disabled={!client || rows.length === 0 || !!pdfBusy} className="flex-1 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded-xl font-semibold px-4 py-3">{pdfBusy === "pass" ? "Собираю..." : "⬇️ Пропуск (PDF)"}</button>
            <button onClick={pdfInvoice} disabled={!client || rows.length === 0 || !!pdfBusy} className="flex-1 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded-xl font-semibold px-4 py-3">{pdfBusy === "inv" ? "Собираю..." : "⬇️ Накладная (PDF)"}</button>
          </div>
        </>
      )}

      {view === "clients" && (
        <>
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-gray-800">Клиенты Караганды</h3>
            {canManage && <Btn onClick={openNewClient}>+ Клиент</Btn>}
          </div>
          {showAdd && (
            <Modal title={editId ? "Редактировать клиента" : "Новый клиент"} onClose={() => setShowAdd(false)}>
              <div className="space-y-3">
                <Inp label="Покупатель (как в накладной)" value={cf.name} onChange={e => setCf({ ...cf, name: e.target.value })} placeholder="Мекембаева ФЛ" />
                <Inp label="БИН/ИИН" value={cf.bin} onChange={e => setCf({ ...cf, bin: e.target.value })} placeholder="930125302042" />
                <Inp label="Адрес поставки" value={cf.address} onChange={e => setCf({ ...cf, address: e.target.value })} />
                <div>
                  <p className="text-sm font-medium text-gray-700 mb-2">Товары и цены (за кг)</p>
                  {cf.products.map((p, i) => (
                    <div key={i} className="flex items-center justify-between gap-2 bg-gray-50 rounded-lg px-3 py-2 mb-1 text-sm">
                      <span className="min-w-0 truncate">{p.name}</span>
                      <span className="whitespace-nowrap font-medium">{fmt(p.price_kg)} тг/кг</span>
                      <button onClick={() => setCf(f => ({ ...f, products: f.products.filter((_, j) => j !== i) }))} className="text-red-400 hover:text-red-600 flex-shrink-0">✕</button>
                    </div>
                  ))}
                  <div className="grid grid-cols-[1fr_5.5rem] gap-2 mt-2">
                    <Inp label="" value={pf.name} onChange={e => setPf({ ...pf, name: e.target.value })} placeholder="ОТРУБИ фасованные 20 кг" />
                    <Inp label="" type="number" value={pf.price_kg} onChange={e => setPf({ ...pf, price_kg: e.target.value })} placeholder="тг/кг" />
                  </div>
                  <Btn size="sm" variant="secondary" onClick={addProduct}>+ Добавить товар</Btn>
                </div>
              </div>
              <div className="flex gap-2 mt-4">
                <Btn onClick={saveClient}>Сохранить</Btn>
                <Btn variant="secondary" onClick={() => setShowAdd(false)}>Отмена</Btn>
              </div>
            </Modal>
          )}
          <div className="space-y-2">
            {kgdClients.length === 0 && <div className="text-center py-10 text-gray-400">Клиентов пока нет — добавь первого.</div>}
            {[...kgdClients].sort((a, b) => (a.name || "").localeCompare(b.name || "", "ru")).map(c => (
              <div key={c.id} className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-bold text-gray-900">{c.name}</div>
                    {c.bin && <div className="text-sm text-gray-500">БИН/ИИН {c.bin}</div>}
                    {c.address && <div className="text-sm text-gray-500 flex items-center gap-1.5"><Icon name="pin" size={13} />{c.address}</div>}
                    {(c.products || []).length > 0 && <div className="flex flex-wrap gap-1 mt-2">{c.products.map((p, i) => <span key={i} className="bg-amber-50 text-amber-800 text-xs px-2 py-0.5 rounded-full">{p.name} — {fmt(p.price_kg)} тг/кг</span>)}</div>}
                  </div>
                  {canManage && <div className="flex gap-1 flex-shrink-0"><Btn size="sm" variant="secondary" onClick={() => openEditClient(c)}><Icon name="pencil" size={15} /></Btn><Btn size="sm" variant="danger" onClick={() => deleteKgdClient(c)}><Icon name="trash" size={15} /></Btn></div>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {view === "history" && (() => {
        const queued = kgdQueueRead();
        const list = [...kgdDocs].sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
        const fmtAt = iso => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" }) + " " + d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }); };
        const sumAll = list.reduce((s, d) => s + (d.total || 0), 0);
        const kgAll = list.reduce((s, d) => s + (d.totalKg || 0), 0);
        const card = (d, isQueued) => (
          <div key={d.id} className={`rounded-2xl p-4 border ${isQueued ? "bg-amber-50 border-amber-200" : "bg-white border-gray-100 shadow-sm"}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-bold text-gray-900">{d.clientName}{d.deal ? <span className="font-normal text-gray-500"> · сделка #{d.deal}</span> : ""}</div>
                <div className="text-xs text-gray-500">{isQueued ? "⏳ ждёт отправки" : fmtAt(d.at)}{d.by ? ` · ${d.by}` : ""}{d.kind ? ` · ${d.kind}` : ""}</div>
                <div className="text-sm text-gray-600 mt-1">{(d.rows || []).map((r, i) => <div key={i}>• {r.name} — {fmt(r.kg)} кг{r.price_kg ? ` × ${fmt(r.price_kg)} тг` : ""}</div>)}</div>
              </div>
              <div className="text-right flex-shrink-0">
                <div className="font-bold text-gray-900">{fmt(d.total)} тг</div>
                <div className="text-xs text-gray-500">{fmt(d.totalKg)} кг</div>
                {isSenior && !isQueued && <button onClick={async () => { if (confirm("Удалить запись из истории?")) { try { await dbDelete("kgd_docs", d.id); reload("kgd_docs"); } catch (e) { alert("⚠️ " + ((e && e.message) || e)); } } }} className="text-red-400 hover:text-red-600 text-sm mt-1">✕</button>}
              </div>
            </div>
          </div>
        );
        return (
          <div className="space-y-3">
            <div className="bg-blue-50 border border-blue-100 rounded-2xl p-4 text-sm text-blue-800">
              {isSenior ? "История всех менеджеров: кто, когда и что выбил." : "Твоя история сформированных документов."} Эти данные <b>не попадают</b> в склад и отчёты компании.
            </div>
            {list.length > 0 && (
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-emerald-50 rounded-xl p-3"><div className="text-xs text-emerald-700">Всего документов</div><div className="text-lg font-bold text-emerald-800">{list.length}</div></div>
                <div className="bg-amber-50 rounded-xl p-3"><div className="text-xs text-amber-700">Общий объём / сумма</div><div className="text-sm font-bold text-amber-800">{fmt(kgAll)} кг · {fmt(sumAll)} тг</div></div>
              </div>
            )}
            {queued.map(d => card(d, true))}
            {list.length === 0 && queued.length === 0 && <div className="text-center py-10 text-gray-400">Пока пусто — сформируй первый документ.</div>}
            {list.map(d => card(d, false))}
          </div>
        );
      })()}
    </div>
  );
}

function ContractsTab({ clients }) {
  const taRef = useRef(null);
  const backRef = useRef(null);
  const [source, setSource] = useState("client"); // client | text
  const [clientId, setClientId] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parseErr, setParseErr] = useState("");
  const [parsed, setParsed] = useState(null);
  const [tplKey, setTplKey] = useState("postoplata");
  const [template, setTemplate] = useState(CONTRACT_TEMPLATES[0].text);
  const [result, setResult] = useState("");

  // Данные «Покупателя»: из выбранного клиента или из разобранного текста
  const c = clients.find(x => x.id === clientId);
  const party = source === "client" ? c : parsed;

  // Поле договора растягивается под весь текст (без внутренней прокрутки) — чтобы подсветка не отставала
  useEffect(() => { const ta = taRef.current; if (ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; } }, [result]);

  const pickTemplate = key => { setTplKey(key); const t = CONTRACT_TEMPLATES.find(x => x.key === key); setTemplate(t ? t.text : ""); setResult(""); };
  const doParse = async () => {
    if (!pasteText.trim()) return;
    setParsing(true); setParseErr(""); setParsed(null); setResult("");
    try { setParsed(await parseClientWithAI(pasteText)); }
    catch (e) { setParseErr(e.message); }
    setParsing(false);
  };
  const fill = () => {
    const P = party;
    if (!P) { alert(source === "client" ? "Сначала выбери клиента." : "Сначала вставь текст и нажми «Разобрать»."); return; }
    const fields = {
      "{{org}}": P.org_name || P.name || "", "{{bin}}": P.bin || "", "{{director}}": P.director || "",
      "{{legal_address}}": P.legal_address || P.address || "", "{{phone}}": P.contact || "",
      "{{email}}": P.email || "", "{{bank}}": P.bank || "", "{{iik}}": P.iik || "", "{{bik}}": P.bik || "",
    };
    let t = template;
    Object.entries(fields).forEach(([k, v]) => { t = t.split(k).join(v || "〔ВПИШИТЕ〕"); });
    // «действующего на основании …» у Покупателя: если основание неизвестно — убираем фразу целиком
    const basis = (P.basis || "").trim();
    t = t.split(", действующего на основании 〔ВПИШИТЕ: Устава / Свидетельства〕").join(basis ? `, действующего на основании ${basis}` : "");
    setResult(t);
  };
  const printContract = () => {
    if (!result) return;
    const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    // Каждая строка — свой блок; «г. Город … дата» разводим по краям (город слева, дата справа)
    const body = result.split("\n").map(l => {
      const m = l.match(/^(г\..*?)\s{2,}(\S.*)$/);
      if (m) return `<div style="display:flex;justify-content:space-between"><span>${esc(m[1])}</span><span>${esc(m[2])}</span></div>`;
      return `<div>${esc(l) || "&nbsp;"}</div>`;
    }).join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Договор</title><style>@page{margin:18mm}body{font-family:'Times New Roman',serif;font-size:11pt;line-height:1.45;color:#000;text-align:justify;margin:0}</style></head><body>${body}</body></html>`;
    // Печать через скрытый фрейм — не открываем новую вкладку (иначе на айфоне из неё не выйти)
    const old = document.getElementById("print-frame");
    if (old) old.remove();
    const iframe = document.createElement("iframe");
    iframe.id = "print-frame";
    iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow.document;
    doc.open(); doc.write(html); doc.close();
    setTimeout(() => { try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch (e) {} setTimeout(() => iframe.remove(), 3000); }, 400);
  };
  const partyName = party ? (party.org_name || party.name || "клиент") : "клиент";
  const requisites = party ? [
    `Наименование: ${party.org_name || party.name || "—"}`, `БИН/ИИН: ${party.bin || "—"}`, `Директор: ${party.director || "—"}`,
    `Юр. адрес: ${party.legal_address || party.address || "—"}`, `Телефон: ${party.contact || "—"}`, `Email: ${party.email || "—"}`,
    `Банк: ${party.bank || "—"}`, `ИИК: ${party.iik || "—"}`, `БИК: ${party.bik || "—"}`,
  ].join("\n") : "";

  return (
    <div className="space-y-4">
      <div className="bg-blue-50 border border-blue-100 rounded-2xl p-4 text-sm text-blue-800">Данные Покупателя берутся из клиента или из вставленного текста. Метки <b>〔…〕</b> — впиши вручную перед печатью (номер, дата, <b>пункт 2.2</b>). Чего не нашлось — тоже отметится 〔ВПИШИТЕ〕.</div>

      <div className="flex gap-2">
        <button onClick={() => { setSource("client"); setResult(""); }} className={`flex-1 py-2 rounded-lg text-sm font-medium inline-flex items-center justify-center gap-1.5 ${source === "client" ? "bg-amber-500 text-white" : "bg-gray-100 text-gray-600"}`}><Icon name="user" size={15} />Из клиентов</button>
        <button onClick={() => { setSource("text"); setResult(""); }} className={`flex-1 py-2 rounded-lg text-sm font-medium inline-flex items-center justify-center gap-1.5 ${source === "text" ? "bg-amber-500 text-white" : "bg-gray-100 text-gray-600"}`}><Icon name="clipboard" size={15} />Вставить текст</button>
      </div>

      {source === "client"
        ? <Sel label="Клиент" value={clientId} onChange={e => { setClientId(e.target.value); setResult(""); }} options={[{ value: "", label: "— выбери клиента —" }, ...clients.map(c => ({ value: c.id, label: c.name + (c.org_name ? ` (${c.org_name})` : "") }))]} />
        : (
          <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-4">
            <div className="text-sm font-medium text-gray-700 mb-1">Вставь данные контрагента</div>
            <textarea value={pasteText} onChange={e => setPasteText(e.target.value)} rows={3} placeholder="напр.: ТОО «Алтын Дән», БИН 123..., в лице директора Иванова И.И., адрес ..., Kaspi Bank, ИИК KZ..., БИК ..." className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-amber-300" />
            {parseErr && <div className="text-xs text-red-500 mt-1">{parseErr}</div>}
            <button onClick={doParse} disabled={parsing || !pasteText.trim()} className="mt-2 w-full bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded-lg font-medium px-4 py-2 text-sm">{parsing ? "Разбираю..." : "✨ Разобрать"}</button>
          </div>
        )}
      <Sel label="Тип договора" value={tplKey} onChange={e => pickTemplate(e.target.value)} options={CONTRACT_TEMPLATES.map(t => ({ value: t.key, label: t.name }))} />

      {party && (
        <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-4">
          <div className="flex items-center justify-between mb-2"><div className="font-bold text-gray-800">Реквизиты {source === "text" ? "(из текста)" : "клиента"}</div><Btn size="sm" variant="secondary" onClick={() => copyToClipboard(requisites)}><Icon name="copy" size={15} />Копировать</Btn></div>
          <pre className="text-sm text-gray-700 whitespace-pre-wrap font-sans">{requisites}</pre>
        </div>
      )}

      <Btn onClick={fill} disabled={!party}><Icon name="file" size={16} />Сформировать договор</Btn>

      {result && (
        <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-4">
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <div className="font-bold text-gray-800">Готовый договор</div>
            <div className="flex gap-2 flex-wrap">
              <Btn size="sm" onClick={printContract}>🖨 Печать</Btn>
              <Btn size="sm" variant="secondary" onClick={() => copyToClipboard(result)}><Icon name="copy" size={15} />Копировать</Btn>
              <Btn size="sm" variant="secondary" onClick={() => downloadDocx(`Договор_${partyName}.docx`, result)}>⬇️ Скачать Word</Btn>
            </div>
          </div>
          <div className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 mb-2">Можно править прямо здесь: <mark style={{ background: "#fde68a" }}>жёлтым</mark> подсвечены метки 〔…〕, которые нужно заполнить (особенно <b>пункт 2.2</b>, номер и дату). В печать подсветка не идёт.</div>
          <div className="relative bg-gray-50 rounded-xl">
            <div ref={backRef} aria-hidden="true" className="absolute inset-0 rounded-xl p-3 text-sm font-sans pointer-events-none" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: "1.5", color: "transparent", border: "1px solid transparent", boxSizing: "border-box", overflow: "hidden" }} dangerouslySetInnerHTML={{ __html: result.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/(〔[^〕]*〕)/g, '<mark style="background:#fde68a;color:transparent;border-radius:3px">$1</mark>') + "\n" }} />
            <textarea ref={taRef} value={result} onChange={e => setResult(e.target.value)} rows={4} className="relative w-full text-sm text-gray-800 font-sans bg-transparent rounded-xl p-3 border border-gray-200 focus:outline-none focus:ring-2 focus:ring-amber-300" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: "1.5", boxSizing: "border-box", overflow: "hidden", resize: "none" }} />
          </div>
        </div>
      )}
    </div>
  );
}

function ReactivateTab({ clients, orders }) {
  const today = Date.now();
  const rows = [];
  clients.forEach(c => {
    // клиента с активной заявкой не дёргаем — он уже в работе
    if (orders.some(o => o.clientId === c.id && (o.status === "новая" || o.status === "в пути"))) return;
    const dates = [...new Set(orders.filter(o => o.clientId === c.id && o.status === "отгружена").map(o => o.date))].sort();
    if (dates.length < 3) return; // мало истории — график не определить
    const ms = dates.map(d => new Date(d).getTime());
    let sum = 0; for (let i = 1; i < ms.length; i++) sum += ms[i] - ms[i - 1];
    const avgDays = sum / (ms.length - 1) / 86400000;
    const last = dates[dates.length - 1];
    const daysSince = Math.floor((today - ms[ms.length - 1]) / 86400000);
    // выбился из графика: молчит дольше, чем в ~1.5 раза против своего интервала
    if (avgDays > 0 && daysSince > avgDays * 1.5 && daysSince >= Math.max(Math.round(avgDays) + 2, 4)) {
      rows.push({ c, avgDays: Math.max(1, Math.round(avgDays)), daysSince, last, ratio: daysSince / avgDays, count: dates.length });
    }
  });
  rows.sort((a, b) => b.ratio - a.ratio);
  const waLink = c => "https://wa.me/" + String(c.contact || "").replace(/\D/g, "") + "?text=" + encodeURIComponent(`Здравствуйте${c.contact_name ? ", " + c.contact_name : ""}! Давно не заказывали муку — подготовить вам заявку?`);

  return (
    <div className="space-y-4">
      <div className="bg-blue-50 border border-blue-100 rounded-2xl p-4 text-sm text-blue-800">Клиенты, которые брали муку регулярно, но сейчас задержались <b>дольше своего обычного графика</b>. Можно напомнить и предложить заявку. Те, у кого уже есть активная заявка, сюда не попадают.</div>
      {rows.length === 0 ? (
        <div className="text-center py-12 text-gray-400">Никто не выбивается из своего графика 👍</div>
      ) : rows.map(({ c, avgDays, daysSince, last, count }) => (
        <div key={c.id} className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="font-bold text-gray-900">{c.name}{c.org_name ? <span className="text-sm text-gray-500 font-normal"> · {c.org_name}</span> : ""}</div>
              <div className="text-sm text-gray-600 mt-0.5">Обычно берёт <b>~раз в {avgDays} дн.</b> (за {count} заказов)</div>
              <div className="text-sm text-gray-600">Последний заказ: {last.split("-").reverse().join(".")} — <span className="text-red-600 font-medium">{daysSince} дн. назад</span></div>
            </div>
            <span className="text-xs font-bold bg-red-100 text-red-700 px-2 py-1 rounded-full whitespace-nowrap">+{Math.max(0, daysSince - avgDays)} дн.</span>
          </div>
          {c.contact && (
            <div className="flex gap-2 mt-3 items-center flex-wrap">
              <a href={waLink(c)} target="_blank" rel="noreferrer" className="bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-medium px-4 py-2 rounded-lg inline-flex items-center gap-1.5"><Icon name="chat" size={15} />Написать в WhatsApp</a>
              <span className="text-xs text-gray-400 inline-flex items-center gap-1"><Icon name="phone" size={12} />{c.contact}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function DebtsTab({ orders, clients, payments = [], reload, canEdit = true }) {
  const [open, setOpen] = useState({});
  const [reconcile, setReconcile] = useState(false); // режим «акт сверки»: отмечаем компании галочками
  const [selected, setSelected] = useState({});
  const [payClient, setPayClient] = useState(null); // клиент, которому вносим оплату в счёт долга
  const [payForm, setPayForm] = useState({ amount: "", method: "Наличные", date: TODAY(), note: "" });
  const [savingPay, setSavingPay] = useState(false);
  // долг = отгружено и не оплачено (новые/в пути в долг НЕ идут)
  const unpaid = orders.filter(o => o.status === "отгружена" && !o.paid && o.bags * o.bag_kg * (o.price_per_kg || 0) > 0);
  const byClient = {};
  unpaid.forEach(o => {
    const k = o.clientId || ("nm:" + (o.clientName || "")); // по id — чтобы тёзки не слипались
    if (!byClient[k]) { const c = clients.find(x => x.id === o.clientId); byClient[k] = { key: k, clientId: o.clientId, name: o.clientName || "?", org: c?.org_name || "", total: 0, byDate: {} }; }
    const sum = o.bags * o.bag_kg * (o.price_per_kg || 0);
    byClient[k].total += sum;
    const d = (byClient[k].byDate[o.date] = byClient[k].byDate[o.date] || { kg: 0, sum: 0, items: [] });
    d.kg += o.bags * o.bag_kg; d.sum += sum; d.items.push(o);
  });
  // Ручные оплаты «в счёт долга» — сумма и список по каждому клиенту
  const paidByClient = {}, paysByClient = {};
  (payments || []).forEach(p => { const k = p.clientId || ("nm:" + (p.clientName || "")); paidByClient[k] = (paidByClient[k] || 0) + (p.amount || 0); (paysByClient[k] = paysByClient[k] || []).push(p); });
  // net = отгружено-неоплачено − внесённые оплаты (может уйти в переплату)
  Object.values(byClient).forEach(c => { c.paid = paidByClient[c.key] || 0; c.net = c.total - c.paid; });
  // клиенты, у кого оплат больше, чем незакрытых отгрузок (или оплаты без открытых долгов) — показываем как переплату
  const list = Object.values(byClient).sort((a, b) => b.net - a.net);
  const grand = list.reduce((s, c) => s + Math.max(0, c.net), 0);

  const markPaid = async (c, date, method) => {
    try {
      await Promise.all(orders.filter(o => (o.clientId ? o.clientId === c.clientId : o.clientName === c.name) && o.date === date && o.status === "отгружена").map(o => dbUpsert("orders", { ...o, paid: true, pay_method: method })));
      await reload("orders");
    } catch (e) { alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз."); }
  };
  const openPay = c => { setPayClient(c); setPayForm({ amount: "", method: "Наличные", date: TODAY(), note: "" }); };
  const savePay = async () => {
    if (!payForm.amount || Number(payForm.amount) <= 0) return;
    setSavingPay(true);
    try {
      await dbUpsert("payments", { id: uid(), clientId: payClient.clientId || "", clientName: payClient.name, date: payForm.date, amount: Number(payForm.amount), method: payForm.method, note: payForm.note.trim() });
      setPayClient(null); await reload("payments");
    } catch (e) {
      const m = String((e && e.message) || e);
      alert(/payments|PGRST205/i.test(m) ? "Нужно один раз создать таблицу «payments» в Supabase — попроси инструкцию." : "⚠️ Не сохранилось: " + m);
    } finally { setSavingPay(false); }
  };
  const delPayment = async id => { if (!confirm("Удалить эту оплату? Долг клиента вырастет обратно.")) return; try { await dbDelete("payments", id); await reload("payments"); } catch (e) { alert("⚠️ " + ((e && e.message) || e)); } };

  const selectedList = list.filter(c => selected[c.key]);
  const copyReconcile = () => {
    const lines = selectedList.map(c => {
      const cl = clients.find(x => x.id === c.clientId);
      const nm = cl?.org_name || c.org || c.name;
      return `${nm}${cl?.bin ? ` — БИН ${cl.bin}` : " — БИН не указан"}`;
    });
    copyToClipboard(lines.join("\n"));
  };

  return (
    <div className="space-y-4">
      <div className="bg-gradient-to-br from-rose-50 to-red-50 border border-rose-100 rounded-2xl p-4 flex items-center justify-between">
        <div className="font-display font-semibold text-gray-800 flex items-center gap-1.5"><Icon name="wallet" size={17} />Общий долг клиентов</div>
        <div className="text-2xl font-display font-semibold text-red-600">{fmt(grand)} тг</div>
      </div>
      <div className="text-xs text-gray-400">Долг появляется только после статуса «Доставлено». Пока заявка новая или в пути — долга нет. «Внести оплату» — когда клиент присылает сумму в счёт общего долга.</div>
      {list.length > 0 && !reconcile && (
        <button onClick={() => setReconcile(true)} className="w-full bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 rounded-xl px-4 py-2.5 text-sm font-medium inline-flex items-center justify-center gap-1.5"><Icon name="file" size={15} />Акт сверки — выбрать компании и скопировать список для бухгалтера</button>
      )}
      {reconcile && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-2">
          <div className="text-sm text-amber-800">Отметь галочками компании для акта сверки — скопируется список «название — БИН» для бухгалтера.</div>
          <div className="flex gap-2 flex-wrap">
            <Btn size="sm" onClick={copyReconcile} disabled={!selectedList.length}><Icon name="copy" size={15} />Скопировать ({selectedList.length})</Btn>
            <Btn size="sm" variant="secondary" onClick={() => setSelected(Object.fromEntries(list.map(c => [c.key, true])))}>Выбрать все</Btn>
            <Btn size="sm" variant="secondary" onClick={() => { setReconcile(false); setSelected({}); }}>✕ Готово</Btn>
          </div>
        </div>
      )}
      {list.length === 0 ? (
        <div className="text-center py-12 text-gray-400">Долгов нет — всё оплачено 👍</div>
      ) : list.map(c => {
        const dates = Object.keys(c.byDate).sort((a, b) => b.localeCompare(a));
        const isOpen = open[c.key];
        const pays = (paysByClient[c.key] || []).slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
        const settled = c.net <= 0;
        return (
          <div key={c.key} className={`bg-white border rounded-2xl shadow-sm overflow-hidden ${reconcile && selected[c.key] ? "border-amber-400 ring-1 ring-amber-300" : settled ? "border-emerald-200" : "border-gray-100"}`}>
            <button onClick={() => reconcile ? setSelected(s => ({ ...s, [c.key]: !s[c.key] })) : setOpen(o => ({ ...o, [c.key]: !o[c.key] }))} className="w-full flex items-center justify-between p-4 text-left">
              <div className="flex items-center gap-3 min-w-0">
                {reconcile && <span className={`w-5 h-5 flex-shrink-0 rounded-md border-2 flex items-center justify-center text-white text-xs font-bold ${selected[c.key] ? "bg-amber-500 border-amber-500" : "border-gray-300"}`}>{selected[c.key] ? "✓" : ""}</span>}
                <div>
                  <div className="font-bold text-gray-900">{c.name}{c.org && <span className="text-sm text-gray-500 font-normal"> · {c.org}</span>}</div>
                  <div className="text-xs text-gray-400">{dates.length} {dates.length === 1 ? "отгрузка не оплачена" : "отгрузок не оплачено"}{c.paid > 0 ? ` · внесено ${fmt(c.paid)} тг` : ""}</div>
                </div>
              </div>
              <div className="text-right">
                {settled
                  ? <div className="font-bold text-emerald-600">{c.net < 0 ? `переплата ${fmt(-c.net)}` : "оплачено ✓"}</div>
                  : <div className="font-bold text-red-600">{fmt(c.net)} тг</div>}
                {!reconcile && <div className="text-xs text-gray-400">{isOpen ? "▲ свернуть" : "▼ открыть"}</div>}
              </div>
            </button>
            {isOpen && (
              <div className="px-4 pb-4 space-y-2 border-t border-gray-50 pt-3">
                {c.paid > 0 && (
                  <div className="bg-emerald-50 rounded-xl p-3 text-sm">
                    <div className="flex justify-between"><span className="text-gray-600">Отгружено не оплачено</span><b>{fmt(c.total)} тг</b></div>
                    <div className="flex justify-between text-emerald-700"><span>− внесено оплат</span><b>{fmt(c.paid)} тг</b></div>
                    <div className="flex justify-between border-t border-emerald-200 mt-1 pt-1"><span className="font-medium">Остаток долга</span><b className={c.net > 0 ? "text-red-600" : "text-emerald-600"}>{c.net > 0 ? fmt(c.net) + " тг" : (c.net < 0 ? "переплата " + fmt(-c.net) : "0 тг")}</b></div>
                  </div>
                )}
                {canEdit && <Btn size="sm" onClick={() => openPay(c)}><Icon name="cash" size={15} />Внести оплату в счёт долга</Btn>}
                {pays.length > 0 && (
                  <div className="space-y-1">
                    {pays.map(p => (
                      <div key={p.id} className="flex items-center justify-between text-xs bg-white border border-gray-100 rounded-lg px-3 py-1.5">
                        <span className="text-gray-600 inline-flex items-center gap-1"><Icon name="cash" size={13} className="text-emerald-600" />{(p.date || "").split("-").reverse().join(".")} · {p.method || "оплата"}{p.note ? ` · ${p.note}` : ""}</span>
                        <span className="flex items-center gap-2"><b className="text-emerald-600">{fmt(p.amount)} тг</b>{canEdit && <button onClick={() => delPayment(p.id)} className="text-red-400 hover:text-red-600" title="Удалить оплату">✕</button>}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="text-xs font-semibold text-gray-400 pt-1">Отгрузки:</div>
                {dates.map(date => {
                  const d = c.byDate[date];
                  return (
                    <div key={date} className="bg-gray-50 rounded-xl p-3">
                      <div className="flex items-center justify-between text-sm">
                        <div><b>{date.split("-").reverse().join(".")}</b> · {fmt(d.kg)} кг</div>
                        <div className="font-bold text-gray-800">{fmt(d.sum)} тг</div>
                      </div>
                      <div className="text-xs text-gray-500 mt-1">{d.items.map((o, i) => `${i ? ", " : ""}${o.brand} ${o.grade} ${o.bag_kg}кг×${o.bags}`).join("")}</div>
                      {canEdit && <div className="flex gap-2 mt-2 flex-wrap">{PAY_METHODS.map(([m, ic]) => <Btn key={m} size="sm" variant={m === "Наличные" ? "primary" : "secondary"} onClick={() => markPaid(c, date, m)}>{ic} {m}</Btn>)}</div>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {payClient && (
        <Modal title={`Оплата — ${payClient.name}`} onClose={() => setPayClient(null)}>
          <div className="text-xs text-gray-500 mb-3">Клиент прислал сумму в счёт общего долга. Она уменьшит его долг, конкретные отгрузки отмечать не нужно.</div>
          <div className="space-y-3">
            <Inp label="Сколько прислал, тг" type="number" value={payForm.amount} onChange={e => setPayForm({ ...payForm, amount: e.target.value })} />
            <div>
              <div className="text-sm font-medium text-gray-700 mb-1">Как оплатил</div>
              <div className="flex gap-2 flex-wrap">{PAY_METHODS.map(([m, ic]) => <button key={m} onClick={() => setPayForm({ ...payForm, method: m })} className={`px-3 py-1.5 rounded-lg text-sm font-medium ${payForm.method === m ? "bg-amber-500 text-white" : "bg-gray-100 text-gray-600"}`}>{ic} {m}</button>)}</div>
            </div>
            <Inp label="Дата" type="date" value={payForm.date} onChange={e => setPayForm({ ...payForm, date: e.target.value })} />
            <Inp label="Заметка (по желанию)" value={payForm.note} onChange={e => setPayForm({ ...payForm, note: e.target.value })} placeholder="напр. частично, остаток на след. неделе" />
          </div>
          <div className="flex gap-2 mt-4">
            <Btn onClick={savePay} disabled={!payForm.amount || savingPay}>{savingPay ? "Сохраняю…" : "Записать оплату"}</Btn>
            <Btn variant="secondary" onClick={() => setPayClient(null)}>Отмена</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

function KaragandaTab({ orders, clients, reload, canEdit = true }) {
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);
  const blankPos = { brand: BRANDS[0], grade: GRADES[0], bag_kg: 50, bags: "", price_per_kg: "" };
  const [form, setForm] = useState({ clientId: "", date: TODAY(), note: "", positions: [{ ...blankPos }] });
  const priceFor = (client, brand, grade, bag_kg) => (client?.prices || []).find(p => p.brand === brand && p.grade === grade && p.bag_kg === Number(bag_kg))?.price_per_kg || null;
  const openAdd = () => { setForm({ clientId: "", date: TODAY(), note: "", positions: [{ ...blankPos }] }); setShowAdd(true); };
  const updatePos = (i, field, value) => setForm(f => ({ ...f, positions: f.positions.map((p, idx) => idx === i ? { ...p, [field]: value } : p) }));
  const addPos = () => setForm(f => ({ ...f, positions: [...f.positions, { ...blankPos }] }));
  const removePos = i => setForm(f => ({ ...f, positions: f.positions.filter((_, idx) => idx !== i) }));

  const list = orders.filter(o => o.fromKaraganda);
  const byDate = {};
  list.forEach(o => { (byDate[o.date] = byDate[o.date] || []).push(o); });
  const dates = Object.keys(byDate).sort((a, b) => b.localeCompare(a));
  const totalKg = list.reduce((s, o) => s + o.bags * o.bag_kg, 0);

  const save = async () => {
    const valid = form.positions.filter(p => Number(p.bags) > 0);
    if (!form.clientId || valid.length === 0) { alert("Выбери клиента и укажи хотя бы одну позицию с мешками."); return; }
    setSaving(true);
    const client = clients.find(c => c.id === form.clientId);
    try {
      for (const p of valid) {
        const price = p.price_per_kg || priceFor(client, p.brand, p.grade, Number(p.bag_kg)) || 0;
        await dbUpsert("orders", { id: uid(), date: form.date, clientId: form.clientId, clientName: client?.name || "", brand: p.brand, grade: p.grade, bag_kg: Number(p.bag_kg), bags: Number(p.bags), price_per_kg: Number(price), status: "в пути", fromKaraganda: true, note: form.note });
      }
      setShowAdd(false); await reload("orders");
    } catch (e) { alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз."); }
    setSaving(false);
  };
  // Караганда: статус НЕ трогает склад Астаны. «Отгружено» → сумма вешается клиенту в долг.
  const setGroupStatus = async (ordersArr, status) => {
    try { await Promise.all(ordersArr.map(o => dbUpsert("orders", { ...o, status }))); await reload("orders"); }
    catch (e) { alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз."); }
  };
  const del = async o => { if (!confirm("Удалить эту отгрузку из Караганды?")) return; try { await dbDelete("orders", o.id); await reload("orders"); } catch (e) { alert("⚠️ Не удалилось: " + (e && e.message ? e.message : e)); } };

  return (
    <div className="space-y-4">
      <div className="bg-orange-50 border border-orange-100 rounded-2xl p-4 text-sm text-orange-800">
        Склад <b>Караганда</b>. Фуры идут <b>напрямую клиентам</b>. Записываешь как <b>«в пути»</b>; когда отправили — жмёшь <b>«Отгружено»</b>, и сумма идёт клиенту в долг и в отчёт. Склад в Астане <b>не трогается</b>.
      </div>
      <div className="flex items-center justify-between">
        <div className="text-sm text-gray-500">Всего отправлено: <b>{fmt(totalKg)} кг</b></div>
        {canEdit && <Btn onClick={openAdd}>+ Отгрузка</Btn>}
      </div>

      {showAdd && (
        <Modal title="Отгрузка из Караганды" onClose={() => setShowAdd(false)}>
          <div className="space-y-3">
            <Sel label="Клиент" value={form.clientId} onChange={e => setForm({ ...form, clientId: e.target.value })} options={[{ value: "", label: "— выбери клиента —" }, ...clients.map(c => ({ value: c.id, label: c.name + (c.org_name ? ` (${c.org_name})` : "") }))]} />
            <div className="grid grid-cols-2 gap-3">
              <Inp label="Дата отправки" type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
              <Inp label="Примечание (фура)" value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} placeholder="напр. фура №2, Олжас" />
            </div>
            <div className="text-sm font-medium text-gray-700 pt-1">Что отправляем:</div>
            {form.positions.map((p, i) => (
              <div key={i} className="border border-gray-200 rounded-xl p-3 relative">
                {form.positions.length > 1 && <button onClick={() => removePos(i)} className="absolute top-2 right-2 text-red-400 hover:text-red-600 text-lg leading-none" title="Убрать позицию">✕</button>}
                <div className="grid grid-cols-2 gap-2">
                  <Sel label="Бренд" value={p.brand} onChange={e => updatePos(i, "brand", e.target.value)} options={BRANDS} />
                  <Sel label="Сорт" value={p.grade} onChange={e => updatePos(i, "grade", e.target.value)} options={GRADES} />
                  <Sel label="Фасовка" value={p.bag_kg} onChange={e => updatePos(i, "bag_kg", e.target.value)} options={WEIGHTS.map(w => ({ value: w, label: w + " кг" }))} />
                  <Inp label="Мешков" type="number" value={p.bags} onChange={e => updatePos(i, "bags", e.target.value)} />
                  <div className="col-span-2"><Inp label="Цена тг/кг" type="number" placeholder="авто из базы" value={p.price_per_kg || ""} onChange={e => updatePos(i, "price_per_kg", e.target.value)} /></div>
                </div>
              </div>
            ))}
            <button onClick={addPos} className="w-full border-2 border-dashed border-gray-200 rounded-xl py-2.5 text-sm font-medium text-gray-500 hover:bg-gray-50">+ ещё вид муки</button>
          </div>
          <div className="flex gap-2 mt-4">
            <Btn onClick={save} disabled={saving}>{saving ? "Сохраняю..." : "Записать отгрузку"}</Btn>
            <Btn variant="secondary" onClick={() => setShowAdd(false)}>Отмена</Btn>
          </div>
        </Modal>
      )}

      {dates.length === 0 ? (
        <div className="text-center py-12 text-gray-400">Отгрузок из Караганды пока нет.</div>
      ) : dates.map(date => {
        const day = byDate[date];
        const dayKg = day.reduce((s, o) => s + o.bags * o.bag_kg, 0);
        // внутри даты — по клиенту (одна отправка клиенту)
        const groups = {};
        day.forEach(o => { const k = o.clientId || ("nm:" + (o.clientName || "")); (groups[k] = groups[k] || { clientName: o.clientName, orders: [] }).orders.push(o); });
        return (
          <div key={date} className="bg-white border border-gray-100 rounded-2xl shadow-sm p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="font-display font-semibold text-gray-800 flex items-center gap-1.5"><Icon name="truck" size={16} />{date.split("-").reverse().join(".")}</div>
              <div className="text-sm text-gray-500">{fmt(dayKg)} кг</div>
            </div>
            <div className="space-y-3">
              {Object.values(groups).map((g, gi) => {
                const statuses = [...new Set(g.orders.map(o => o.status))];
                const st = statuses.length === 1 ? statuses[0] : "частично";
                const shipped = st === "отгружена";
                return (
                  <div key={gi} className={`rounded-xl p-3 border ${shipped ? "bg-emerald-50 border-emerald-200" : "bg-gray-50 border-gray-100"}`}>
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="font-medium text-gray-900 flex items-center gap-1.5">{shipped && <span className="text-emerald-600">✓</span>}{g.clientName}</span>
                      {shipped ? <span className="text-xs font-bold bg-emerald-600 text-white px-2.5 py-1 rounded-full whitespace-nowrap">✓ Отгружено</span> : <Badge color="yellow">в пути</Badge>}
                    </div>
                    <div className="space-y-0.5">
                      {g.orders.map(o => (
                        <div key={o.id} className="text-sm text-gray-600 flex items-center gap-2 flex-wrap">
                          <span className="bg-amber-100 text-amber-900 font-semibold px-2 py-0.5 rounded-md whitespace-nowrap inline-flex items-center gap-1"><Icon name="box" size={13} />{o.bags} меш. × {o.bag_kg} кг</span>
                          <span>= <b>{fmt(o.bags * o.bag_kg)} кг</b> · {o.brand} {o.grade}{o.price_per_kg ? ` · ${fmt(o.bags * o.bag_kg * o.price_per_kg)} тг` : ""}</span>
                          {canEdit && <button onClick={() => del(o)} className="text-red-300 hover:text-red-600 ml-auto" title="Удалить позицию">✕</button>}
                        </div>
                      ))}
                    </div>
                    {g.orders[0].note && <div className="text-xs text-gray-400 mt-1 flex items-center gap-1"><Icon name="note" size={12} />{g.orders[0].note}</div>}
                    {canEdit && (
                      <div className="mt-2">
                        {shipped
                          ? <Btn size="sm" variant="secondary" onClick={() => setGroupStatus(g.orders, "в пути")}>↩ Вернуть в путь</Btn>
                          : <Btn size="sm" onClick={() => setGroupStatus(g.orders, "отгружена")}>✓ Отгружено (в долг клиенту)</Btn>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Форма редактирования позиций заявки (клиент+дата). Меняем сорт/кол-во/цену, удаляем и добавляем позиции.
function EditGroupModal({ group, clients, reload, onClose }) {
  const base = group.orders[0];
  const [positions, setPositions] = useState(group.orders.map(o => ({ id: o.id, brand: o.brand, grade: o.grade, bag_kg: o.bag_kg, bags: o.bags, price_per_kg: o.price_per_kg ?? "", trial: !!o.trial })));
  const [note, setNote] = useState(group.orders.map(o => o.note).find(Boolean) || "");
  const [date, setDate] = useState(base.date); // дата доставки — можно поправить, если поставили не на то число
  const [saving, setSaving] = useState(false);
  const priceFor = (client, brand, grade, bag_kg) => (client?.prices || []).find(p => p.brand === brand && p.grade === grade && p.bag_kg === Number(bag_kg))?.price_per_kg || null;
  const upd = (i, f, v) => setPositions(ps => ps.map((p, idx) => idx === i ? { ...p, [f]: v } : p));
  const add = () => setPositions(ps => [...ps, { id: null, brand: BRANDS[0], grade: GRADES[0], bag_kg: 50, bags: "", price_per_kg: "", trial: false }]);
  const rm = i => setPositions(ps => ps.filter((_, idx) => idx !== i));
  const save = async () => {
    const valid = positions.filter(p => Number(p.bags) > 0);
    if (valid.length === 0) { alert("Оставь хотя бы одну позицию (или закрой и удали заявку целиком)."); return; }
    setSaving(true);
    const client = clients.find(c => c.id === base.clientId);
    const grpDriver = group.orders.find(o => o.driverId)?.driverId || ""; // водитель заявки (с любой позиции)
    const grpPickup = group.orders.some(o => o.pickup); // самовывоз
    const grpLoader = group.orders.find(o => o.loaderId)?.loaderId || ""; // грузчик заявки
    const grpWatch = group.orders.some(o => o.pickupWatch); // самовывоз только под контролем (без погрузки)
    // Фото (накладные) и отметку доставки собираем со всей заявки и переносим на первую позицию — чтобы не потерять при удалении позиции
    const allPhotos = [...new Set(group.orders.flatMap(o => o.photos || []))];
    const anyDelivered = group.orders.some(o => o.delivered_by_driver);
    try {
      // Позиции сохраняем разом; фото/отметку доставки цепляем только к первой (carry на индексе 0)
      await Promise.all(valid.map((p, idx) => {
        const price = p.trial ? 0 : (p.price_per_kg !== "" && p.price_per_kg != null ? Number(p.price_per_kg) : (priceFor(client, p.brand, p.grade, Number(p.bag_kg)) || 0));
        const carry = idx === 0 ? { photos: allPhotos, delivered_by_driver: anyDelivered } : {};
        if (p.id) {
          const orig = group.orders.find(o => o.id === p.id);
          return dbUpsert("orders", { ...orig, date, brand: p.brand, grade: p.grade, bag_kg: Number(p.bag_kg), bags: Number(p.bags), price_per_kg: price, note, ...carry });
        }
        return dbUpsert("orders", { id: uid(), date, clientId: base.clientId, clientName: base.clientName, brand: p.brand, grade: p.grade, bag_kg: Number(p.bag_kg), bags: Number(p.bags), price_per_kg: price, status: base.status, driverId: grpDriver, pickup: grpPickup, loaderId: grpLoader, pickupWatch: grpWatch, trial: !!p.trial, fromKaraganda: !!base.fromKaraganda, note, ...carry });
      }));
      const keep = new Set(valid.filter(p => p.id).map(p => p.id));
      await Promise.all(group.orders.filter(o => !keep.has(o.id)).map(o => dbDelete("orders", o.id)));
      onClose(); await reload("orders");
    } catch (e) { alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз."); }
    setSaving(false);
  };
  return (
    <Modal title={`${group.clientName || "Заявка"} — изменить`} onClose={onClose}>
      <div className="space-y-3">
        <div className="text-xs text-gray-500">Измени дату, сорт/количество/цену, удали лишнюю позицию (✕) или добавь новую.</div>
        <Inp label="Дата доставки" type="date" value={date} onChange={e => setDate(e.target.value)} />
        {positions.map((p, i) => (
          <div key={i} className="border border-gray-200 rounded-xl p-3 relative">
            <button onClick={() => rm(i)} className="absolute top-2 right-2 text-red-400 hover:text-red-600 text-lg leading-none" title="Удалить позицию">✕</button>
            <div className="grid grid-cols-2 gap-2">
              <Sel label="Бренд" value={p.brand} onChange={e => upd(i, "brand", e.target.value)} options={BRANDS} />
              <Sel label="Сорт" value={p.grade} onChange={e => upd(i, "grade", e.target.value)} options={GRADES} />
              <Sel label="Фасовка" value={p.bag_kg} onChange={e => upd(i, "bag_kg", e.target.value)} options={WEIGHTS.map(w => ({ value: w, label: w + " кг" }))} />
              <Inp label="Мешков" type="number" value={p.bags} onChange={e => upd(i, "bags", e.target.value)} />
              {p.trial
                ? <div className="col-span-2 text-xs text-orange-600 font-medium">на пробу (бесплатно)</div>
                : <div className="col-span-2"><Inp label="Цена тг/кг" type="number" placeholder="авто из базы" value={p.price_per_kg || ""} onChange={e => upd(i, "price_per_kg", e.target.value)} /></div>}
            </div>
          </div>
        ))}
        <button onClick={add} className="w-full border-2 border-dashed border-gray-200 rounded-xl py-2.5 text-sm font-medium text-gray-500 hover:bg-gray-50">+ ещё позиция</button>
        <Inp label="Заметка (видит водитель)" value={note} onChange={e => setNote(e.target.value)} placeholder="напр. с отлёжкой (лежать месяц), оставить у охраны" />
      </div>
      <div className="flex gap-2 mt-4">
        <Btn onClick={save} disabled={saving}>{saving ? "Сохраняю..." : "Сохранить"}</Btn>
        <Btn variant="secondary" onClick={onClose}>Отмена</Btn>
      </div>
    </Modal>
  );
}

// 📝 ОБЩИЙ блокнот на главной: заметки в базе — видят и правят все администраторы.
// Пишешь ты — видит коллега, и наоборот. Автоподхват чужих правок, пока сам не печатаешь.
function NotesBlock({ notes = [], me = "", canEdit = true, reload = () => {} }) {
  const shared = notes.find(n => n.id === "shared") || null;
  const serverText = shared ? (shared.text || "") : "";
  const [text, setText] = useState(serverText);
  const [open, setOpen] = useState(!!serverText.trim());
  const focusedRef = useRef(false);
  const timerRef = useRef(null);
  const [savedFlash, setSavedFlash] = useState(false);

  // Чужие правки подтягиваем, только когда сам не печатаешь (чтобы не перебивать ввод)
  useEffect(() => {
    if (!focusedRef.current) { setText(serverText); if (serverText.trim()) setOpen(true); }
  }, [serverText, shared && shared.at]);

  // Разовый перенос старых личных заметок (localStorage) в общие, если общие пусты
  useEffect(() => {
    if (!canEdit) return;
    try {
      const local = localStorage.getItem("sklad_notes") || "";
      if (local.trim() && !serverText.trim()) { setText(local); setOpen(true); saveNow(local); localStorage.removeItem("sklad_notes"); }
    } catch {}
  }, []); // один раз при монтировании

  const saveNow = async (v) => {
    try { await dbUpsert("notes", { id: "shared", text: v, at: new Date().toISOString(), by: me }); reload("notes"); setSavedFlash(true); setTimeout(() => setSavedFlash(false), 1200); }
    catch (e) {
      const msg = String((e && e.message) || e);
      if (/notes/i.test(msg) || /PGRST205/.test(msg)) alert("Чтобы заметки были общими для всех, нужно один раз создать таблицу «notes» в Supabase. Скажи — пришлю инструкцию.");
      else alert("⚠️ Не сохранилось: " + msg);
    }
  };
  const onChange = e => { const v = e.target.value; setText(v); clearTimeout(timerRef.current); timerRef.current = setTimeout(() => saveNow(v), 700); };
  const clearAll = () => { if (confirm("Очистить общие заметки для всех?")) { setText(""); saveNow(""); } };
  const fmtAt = iso => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }) + " " + d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }); };
  const hasNotes = !!text.trim();

  if (!open && !hasNotes) return (
    <button onClick={() => setOpen(true)} className="w-full text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-xl py-2.5 font-medium hover:bg-amber-100 inline-flex items-center justify-center gap-1.5"><Icon name="note" size={15} />Общие заметки — открыть</button>
  );
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="font-display font-semibold text-amber-900 flex items-center gap-1.5"><Icon name="note" size={16} />Общие заметки</div>
        <div className="flex gap-3 text-xs items-center">
          {savedFlash && <span className="text-emerald-600">✓ сохранено</span>}
          {canEdit && hasNotes && <button onClick={clearAll} className="text-gray-400 hover:text-red-500">очистить</button>}
          {!hasNotes && <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600">свернуть</button>}
        </div>
      </div>
      <textarea
        value={text}
        readOnly={!canEdit}
        onFocus={() => { focusedRef.current = true; }}
        onBlur={() => { focusedRef.current = false; }}
        onChange={onChange}
        rows={5}
        placeholder={"Пиши что угодно — видят все:\n• Сегафредо — доложить +2 мешка, заменить испорченные\n• Мамыр — перезвонить насчёт оплаты\n• заказать поддоны"}
        className="w-full bg-white border border-amber-100 rounded-xl px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-amber-300"
        style={{ whiteSpace: "pre-wrap" }}
      />
      <div className="text-xs text-gray-400 mt-1">{shared && shared.by ? `Видят все · последним правил(а): ${shared.by}${shared.at ? ` · ${fmtAt(shared.at)}` : ""}` : "Видят все администраторы · сохраняется автоматически"}</div>
    </div>
  );
}

function TodayTab({ orders, clients, drivers = [], stock = [], notes = [], me = "", reload, applyLocal = () => {}, driverFilter = null, canEdit = true, openSignal = 0, role = "director" }) {
  const isRep = role === "rep";
  const brigadirs = drivers.filter(d => d.salary_type === "brigadir"); // торгпред кидает заявки на бригадира
  const soleBrigadir = brigadirs.length === 1 ? brigadirs[0].id : ""; // если бригадир один — ставим по умолчанию
  // Торгпред назначает только бригадиру (он дальше распределяет младшим); остальные — любого водителя
  const driverPickOptions = (isRep ? brigadirs : drivers).map(d => ({ value: d.id, label: d.name + (d.salary_type === "brigadir" ? " (бригадир)" : "") }));
  const [aiText, setAiText] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState(null);
  const [aiDriver, setAiDriver] = useState(""); // водитель (или грузчик при самовывозе) для разобранной заявки
  const [aiPickup, setAiPickup] = useState(false); // самовывоз: клиент забирает сам, выбираем грузчика
  const [aiError, setAiError] = useState("");
  const [saving, setSaving] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [savingManual, setSavingManual] = useState(false);
  const [editGroup, setEditGroup] = useState(null);
  const [form, setForm] = useState({ clientId: "", brand: BRANDS[0], grade: GRADES[0], bag_kg: 50, bags: "", date: TODAY(), driverId: "", price_per_kg: "", isSample: false, sampleName: "", trial: false, note: "", pickup: false, loaderId: "", pickupWatch: false, oneOff: false, oneOffName: "", payMethod: "Нал", oneOffAddress: "", gis_link: "", coords: null });
  // Позиции разовой продажи (несколько сортов/цен за раз) + определение точки 2ГИС
  const ooBlank = { brand: BRANDS[0], grade: GRADES[0], bag_kg: 50, bags: "", price_per_kg: "" };
  const [ooPos, setOoPos] = useState([{ ...ooBlank }]);
  const [ooResolving, setOoResolving] = useState(false);
  const [ooErr, setOoErr] = useState("");
  const updOo = (i, k, v) => setOoPos(ps => ps.map((p, j) => j === i ? { ...p, [k]: v } : p));
  const ooResolve = async () => {
    setOoResolving(true); setOoErr("");
    try {
      const direct = parseCoordsFromGisLink(form.gis_link);
      const coords = direct || await resolveGisCoords(form.gis_link);
      setForm(f => ({ ...f, coords }));
    } catch (e) { setOoErr(e.message); }
    setOoResolving(false);
  };
  // Открыть форму заявки по сигналу с кнопки «+»
  useEffect(() => { if (openSignal) { setShowManual(true); if (isRep && soleBrigadir) { setForm(f => ({ ...f, driverId: f.driverId || soleBrigadir })); setAiDriver(a => a || soleBrigadir); } } }, [openSignal]);

  const local = orders.filter(o => !o.fromKaraganda); // карагандинские отгрузки тут не показываем
  const loadRows = local.filter(o => o.foreignLoad); // сводная загрузка чужих заявок (торгпред) — только тоннаж/число
  const vis = (driverFilter != null ? local.filter(o => o.driverId === driverFilter || o.loaderId === driverFilter) : local).filter(o => !o.foreignLoad);
  const groupCount = list => new Set(list.map(o => (o.clientId || "nm:" + (o.clientName || "")) + "|" + o.date)).size;
  const todayList = vis.filter(o => o.date === TODAY());
  const tomorrowList = vis.filter(o => o.date === TOMORROW());

  const todayGroups = (() => {
    const m = {};
    todayList.forEach(o => {
      const k = o.clientId || ("nm:" + (o.clientName || ""));
      if (!m[k]) m[k] = { key: k, clientId: o.clientId, clientName: o.clientName, isTrial: false, orders: [] };
      m[k].orders.push(o); if (o.trial) m[k].isTrial = true;
    });
    // Отвезённые — вниз, неотвезённые — сверху
    return Object.values(m).sort((a, b) => (a.orders.every(o => o.status === "отгружена") ? 1 : 0) - (b.orders.every(o => o.status === "отгружена") ? 1 : 0));
  })();

  const sc = { "новая": "blue", "в пути": "yellow", "отгружена": "green", "отменена": "red", "частично": "gray" };
  const priceFor = (client, brand, grade, bag_kg) => (client?.prices || []).find(p => p.brand === brand && p.grade === grade && p.bag_kg === Number(bag_kg))?.price_per_kg || null;

  const handleAI = async () => {
    if (!aiText.trim()) return;
    setAiLoading(true); setAiError(""); setAiResult(null);
    try {
      const parsed = await parseOrderWithAI(aiText, clients);
      const mapped = parsed.map(p => {
        const q = (p.clientName || "").toLowerCase().trim();
        // Ступенчатый поиск: имя → организация/контакт → адрес (если в заявке писали адресом)
        let matchBy = "имя";
        let matches = clients.filter(c => c.name.toLowerCase().includes(q) || q.includes(c.name.toLowerCase()));
        if (!matches.length) { matchBy = "организация"; matches = clients.filter(c => (c.org_name || "").toLowerCase().includes(q) || (c.contact_name || "").toLowerCase() === q); }
        if (!matches.length && q.length >= 4) { matchBy = "адрес"; matches = clients.filter(c => c.address && (c.address.toLowerCase().includes(q) || q.includes(c.address.toLowerCase()))); }
        const chosen = matches.length === 1 ? matches[0] : null; // если совпало несколько (тёзки/похожие адреса) — пусть выберет вручную
        return { ...p, trial: !!p.trial, matchBy, matchOptions: matches, clientId: chosen?.id || null, clientFound: chosen?.name || p.clientName, price_per_kg: p.trial ? 0 : (chosen ? priceFor(chosen, p.brand, p.grade, p.bag_kg) : null) };
      });
      setAiResult(mapped);
      setAiDriver(""); setAiPickup(false); // водителя/самовывоз выбираем вручную каждый раз
    } catch { setAiError("Не удалось разобрать. Попробуй ещё раз."); }
    setAiLoading(false);
  };
  const chooseClient = (i, clientId) => setAiResult(prev => prev.map((it, idx) => {
    if (idx !== i) return it;
    const c = clients.find(x => x.id === clientId);
    return { ...it, clientId, clientFound: c?.name || it.clientFound, price_per_kg: it.trial ? 0 : (c ? priceFor(c, it.brand, it.grade, it.bag_kg) : null) };
  }));
  const confirmAI = async () => {
    const ambiguous = aiResult.find(p => (p.matchOptions || []).length > 1 && !p.clientId);
    if (ambiguous) { alert(`Выбери, какой именно клиент «${ambiguous.clientFound}» — их несколько с таким названием.`); return; }
    if (!aiPickup && !aiDriver) { alert("Сначала выбери водителя — кто повезёт эту заявку."); return; } // при самовывозе грузчика можно определить позже
    setSaving(true);
    try {
      for (const p of aiResult) {
        await dbUpsert("orders", { id: uid(), date: p.date, clientId: p.clientId, clientName: p.clientFound, brand: p.brand, grade: p.grade, bag_kg: p.bag_kg, bags: p.bags, price_per_kg: p.trial ? 0 : p.price_per_kg, trial: !!p.trial, note: p.note || "", pickup: aiPickup, driverId: aiPickup ? "" : aiDriver, loaderId: aiPickup ? aiDriver : "", status: "новая" });
      }
      setAiResult(null); setAiText(""); setAiDriver(""); setAiPickup(false); await reload("orders");
    } catch (e) { setAiError("Ошибка: " + (e && e.message ? e.message : e)); }
    setSaving(false);
  };

  // Смена статуса доставки — оптимистично (экран сразу), запись в фоне
  const notifyErr = e => alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз.");
  // Железный учёт: одно движение склада на позицию (id = mv_<id заявки>) — не задваивается, отмена = точный откат
  const busyRef = useRef(new Set()); // замок: группа, по которой уже идёт сохранение
  // У торгпреда (isRep) движение склада пишет СЕРВЕР при сохранении заявки: прав на таблицу
  // stock у роли rep нет, запись из браузера дала бы ложную ошибку «Нет прав на изменение».
  const shipStock = o => isRep ? Promise.resolve() : dbUpsert("stock", { id: "mv_" + o.id, date: TODAY(), brand: o.brand, grade: o.grade, weight_kg: -(o.bags * o.bag_kg), bags: -o.bags, bag_kg: o.bag_kg, note: `Отгрузка: ${o.clientName}` });
  const unshipStock = async o => {
    if (isRep) return; // откат тоже делает сервер
    if (stock.some(s => s.id === "mv_" + o.id)) return dbDelete("stock", "mv_" + o.id);
    return dbUpsert("stock", { id: uid(), date: TODAY(), brand: o.brand, grade: o.grade, weight_kg: o.bags * o.bag_kg, bags: o.bags, bag_kg: o.bag_kg, note: `Возврат: ${o.clientName}` });
  };
  const setGroupStatus = async (g, status) => {
    if (busyRef.current.has(g.key)) return; // пока первое нажатие сохраняется, второе игнорируем
    busyRef.current.add(g.key);
    const ids = new Set(g.orders.map(o => o.id));
    applyLocal("orders", os => os.map(o => ids.has(o.id) ? { ...o, status } : o));
    try {
      await Promise.all(g.orders.map(async o => {
        if (o.status === status) return;
        await dbUpsert("orders", { ...o, status });
        if (o.fromKaraganda) return; // карагандинские отгрузки склад Астаны не трогают
        if (status === "отгружена" && o.status !== "отгружена") await shipStock(o);
        else if (status !== "отгружена" && o.status === "отгружена") await unshipStock(o);
      }));
      reload("stock");
    } catch (e) { notifyErr(e); reload("orders"); reload("stock"); }
    finally { busyRef.current.delete(g.key); }
  };
  // Перенести доставку на другую дату (если сегодня не получилось отгрузить)
  const rescheduleGroup = async (g, date) => {
    if (!date) return;
    const ids = new Set(g.orders.map(o => o.id));
    applyLocal("orders", os => os.map(o => ids.has(o.id) ? { ...o, date } : o));
    try { await Promise.all(g.orders.map(o => dbUpsert("orders", { ...o, date }))); } catch (e) { notifyErr(e); reload("orders"); }
  };
  const deleteGroup = async g => {
    const shipped = g.orders.some(o => o.status === "отгружена" && !o.fromKaraganda);
    if (!confirm(`Удалить заявку «${g.clientName || "Клиент"}» на сегодня (${g.orders.length} поз.)?${shipped ? "\nЗаявка была отгружена — мука вернётся на склад." : ""}`)) return;
    const ids = new Set(g.orders.map(o => o.id));
    applyLocal("orders", os => os.filter(o => !ids.has(o.id)));
    try { await Promise.all(g.orders.map(o => dbDelete("orders", o.id))); reload("stock"); } catch (e) { notifyErr(e); reload("orders"); reload("stock"); }
  };

  // Разовый покупатель понравился → одним нажатием заводим его в базу клиентов
  // (имя, адрес, точка 2ГИС и цены из проданных позиций), а его заявки привязываем к карточке
  const addOneOffToClients = async g => {
    if (!confirm(`Добавить «${g.clientName}» в базу клиентов?`)) return;
    try {
      const o0 = g.orders[0];
      const id = uid();
      const prices = [];
      g.orders.forEach(o => { if ((o.price_per_kg || 0) > 0 && !prices.some(p => p.brand === o.brand && p.grade === o.grade && p.bag_kg === Number(o.bag_kg))) prices.push({ brand: o.brand, grade: o.grade, bag_kg: Number(o.bag_kg), price_per_kg: Number(o.price_per_kg) }); });
      await dbUpsert("clients", { id, name: g.clientName || "Клиент", org_name: "", contact_name: "", address: o0.oneOffAddress || "", contact: "", gis_link: o0.gis_link || "", coords: o0.coords || null, default_bag_kg: Number(o0.bag_kg) || "", default_brand: o0.brand || "", prices });
      await Promise.all(g.orders.map(o => dbUpsert("orders", { ...o, clientId: id })));
      await reload("clients"); await reload("orders");
      alert(`✓ «${g.clientName}» теперь в базе клиентов. Дополни карточку (телефон, реквизиты) во вкладке «Клиенты».`);
    } catch (e) { notifyErr(e); }
  };

  // Добавить заявку вручную (форма та же, что была в «Заявках»)
  const addManual = async () => {
    // Единичная реализация: разовый покупатель не из базы, за деньги, можно несколько позиций.
    // Забрал сам — сразу отгружено и склад списан; если выбран водитель — обычная доставка (склад спишется при отгрузке).
    if (form.oneOff) {
      const valid = ooPos.filter(p => Number(p.bags) > 0);
      if (!valid.length) { alert("Укажи, сколько мешков."); return; }
      if (valid.some(p => !p.price_per_kg)) { alert("Укажи цену тг/кг для каждой позиции — реализация идёт за деньги."); return; }
      setSavingManual(true);
      const buyer = form.oneOffName.trim() || "Разовый покупатель";
      const instant = !form.driverId; // забрал сам
      try {
        for (const p of valid) {
          const kg = Number(p.bags) * Number(p.bag_kg);
          const orderId = uid();
          await dbUpsert("orders", {
            id: orderId, date: form.date, brand: p.brand, grade: p.grade,
            bag_kg: Number(p.bag_kg), bags: Number(p.bags), driverId: form.driverId || "",
            price_per_kg: Number(p.price_per_kg), status: instant ? "отгружена" : "новая",
            oneOff: true, paid: true, pay_method: form.payMethod, note: form.note || "",
            clientId: null, clientName: buyer,
            oneOffAddress: form.oneOffAddress || "", gis_link: form.gis_link || "", coords: form.coords || null,
          });
          // id движения привязан к заявке — отмена вернёт остаток точным откатом, дубля не будет
          if (instant) await dbUpsert("stock", { id: "mv_" + orderId, date: TODAY(), brand: p.brand, grade: p.grade, weight_kg: -kg, bags: -Number(p.bags), bag_kg: Number(p.bag_kg), note: `Реализация: ${buyer}` });
        }
        setShowManual(false);
        setForm(f => ({ ...f, bags: "", price_per_kg: "", note: "", oneOffName: "", driverId: "", oneOffAddress: "", gis_link: "", coords: null }));
        setOoPos([{ ...ooBlank }]); setOoErr("");
        await reload("orders"); if (instant) await reload("stock");
      } catch (e) { alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз."); }
      setSavingManual(false);
      return;
    }
    const isTrial = form.trial && !form.isSample;
    if (isTrial && !form.clientId) { alert("Выбери клиента для пробы."); return; }
    setSavingManual(true);
    const client = form.isSample ? null : clients.find(c => c.id === form.clientId);
    // Проба клиенту (trial) — всегда бесплатно. Пробник новой компании (isSample) — по введённой
    // цене: пусто/0 = бесплатно, иначе платный пробник. Обычная заявка — цена из поля или из базы.
    const price = isTrial ? 0
      : form.isSample ? Math.max(0, Number(form.price_per_kg) || 0)
      : Math.max(0, Number(form.price_per_kg) || (client ? priceFor(client, form.brand, form.grade, Number(form.bag_kg)) : 0));
    // если у клиента на эту дату уже назначен водитель — наследуем его (чтобы новая позиция не «потерялась» у водителя)
    const inheritedDriver = (!form.isSample && form.clientId) ? (orders.find(o => o.clientId === form.clientId && o.date === form.date && o.driverId)?.driverId || "") : "";
    try {
      await dbUpsert("orders", {
        id: uid(), date: form.date, brand: form.brand, grade: form.grade,
        bag_kg: Number(form.bag_kg), bags: Number(form.bags),
        driverId: form.pickup ? "" : (form.driverId || inheritedDriver),
        pickup: !!form.pickup, loaderId: form.pickup ? (form.loaderId || "") : "", pickupWatch: !!form.pickup && !!form.pickupWatch,
        price_per_kg: Number(price), status: "новая",
        isSample: form.isSample, trial: isTrial, note: form.note || "",
        clientId: form.isSample ? null : form.clientId,
        clientName: form.isSample ? (form.sampleName || "Проба") : (client?.name || ""),
      });
      setShowManual(false); setForm(f => ({ ...f, bags: "", price_per_kg: "", note: "" })); await reload("orders");
    } catch (e) { alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз."); }
    setSavingManual(false);
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-4"><div className="text-sm text-gray-500">Заявки сегодня</div><div className="text-3xl font-display font-semibold text-gray-900">{groupCount(todayList)}</div></div>
        <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-4"><div className="text-sm text-gray-500">На завтра</div><div className="text-3xl font-display font-semibold text-gray-900">{groupCount(tomorrowList)}</div></div>
      </div>

      <NotesBlock notes={notes} me={me} canEdit={canEdit} reload={reload} />

      {canEdit && (
      <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-4">
        <div className="font-display font-semibold text-gray-800 mb-2 flex items-center gap-1.5"><Icon name="chat" size={17} />Разобрать заявку из WhatsApp</div>
        <textarea value={aiText} onChange={e => setAiText(e.target.value)} rows={3} placeholder="Вставь сюда сообщение из WhatsApp, напр.: Сегафредо 500 кг высший сорт на завтра" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-amber-300" />
        {aiError && <div className="text-sm text-red-500 mt-2">{aiError}</div>}
        <div className="mt-2 flex gap-2">
          <button onClick={handleAI} disabled={aiLoading || !aiText.trim()} style={{ flex: 2 }} className="bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded-lg font-medium px-4 py-2.5 text-sm inline-flex items-center justify-center gap-1.5">{aiLoading ? "Разбираю..." : <><Icon name="chat" size={16} />Разобрать</>}</button>
          <button onClick={() => setShowManual(true)} style={{ flex: 1 }} className="bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg font-medium px-3 py-2.5 text-sm whitespace-nowrap inline-flex items-center justify-center gap-1.5"><Icon name="pencil" size={15} />Вручную</button>
        </div>
        {aiResult && (
          <div className="mt-3 border-t border-gray-100 pt-3 space-y-2">
            {aiResult.map((p, i) => (
              <div key={i} className="bg-gray-50 rounded-xl p-3 text-sm">
                <div className="flex items-center gap-2 flex-wrap"><span className="font-semibold">{p.clientFound}</span>{(p.matchOptions || []).length === 0 && <Badge color="red">Не в базе</Badge>}{p.clientId && p.matchBy === "адрес" && <Badge color="yellow">найден по адресу — проверь</Badge>}{p.trial && <Badge color="yellow">на пробу</Badge>}</div>
                {p.clientId && (() => {
                  const c = clients.find(x => x.id === p.clientId);
                  return c && (c.org_name || c.address) ? <div className="text-xs text-gray-500 mt-0.5">{c.org_name || ""}{c.org_name && c.address ? " · " : ""}{c.address || ""}</div> : null;
                })()}
                <div className="mt-1">
                  {(p.matchOptions || []).length > 1 && <div className="text-xs text-orange-600 mb-1">⚠️ Несколько похожих клиентов — выбери, какая именно организация:</div>}
                  <select value={p.clientId || ""} onChange={e => chooseClient(i, e.target.value)} className={`w-full border rounded-lg px-2 py-1.5 text-xs ${(p.matchOptions || []).length > 1 && !p.clientId ? "border-orange-300 bg-orange-50" : "border-gray-200 text-gray-500"}`}>
                    <option value="">— клиент не выбран —</option>
                    {[...clients].sort((a, b) => (a.name || "").localeCompare(b.name || "", "ru")).map(c => <option key={c.id} value={c.id}>{c.name}{c.org_name ? ` (${c.org_name})` : ""}{c.address ? ` — ${c.address}` : ""}</option>)}
                  </select>
                </div>
                <div className="text-gray-600 mt-1">{p.brand} · {p.grade} · {p.bag_kg}кг × {p.bags} = {fmt(p.bags * p.bag_kg)} кг</div>
                <div className="text-gray-600">Дата: {p.date} · {p.trial ? <span className="text-orange-600 font-medium">бесплатно</span> : (p.price_per_kg ? fmt(p.price_per_kg) + " тг/кг" : <span className="text-red-500">цена не найдена</span>)}</div>
                {p.note && <div className="text-amber-800 bg-amber-50 rounded px-2 py-1 mt-1 text-xs flex items-center gap-1"><Icon name="note" size={12} />{p.note}</div>}
              </div>
            ))}
            <label className="flex items-center gap-2 cursor-pointer bg-sky-50 rounded-lg px-3 py-2">
              <input type="checkbox" checked={aiPickup} onChange={e => { setAiPickup(e.target.checked); setAiDriver(""); }} className="w-4 h-4 accent-sky-500" />
              <span className="text-sm font-medium text-gray-700 flex items-center gap-1.5"><Icon name="bag" size={16} className="text-sky-600 shrink-0" />Самовывоз — клиент забирает сам (выбери грузчика)</span>
            </label>
            {(() => { const ok = aiPickup || aiDriver; return (
            <div className={`rounded-xl p-3 border ${ok ? "bg-gray-50 border-gray-100" : "bg-orange-50 border-orange-200"}`}>
              <div className={`text-sm font-medium mb-1 ${ok ? "text-gray-700" : "text-orange-700"}`}>{aiPickup ? "Кто отгрузит (грузчик)?" : (isRep ? "Кому передать (бригадир)?" : "Кто повезёт?")} {!ok && "— выбери перед подтверждением"}</div>
              <select value={aiDriver} onChange={e => setAiDriver(e.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-300">
                <option value="">{aiPickup ? "— определить позже —" : (isRep ? "— выбери бригадира —" : "— выбери водителя —")}</option>
                {(isRep && !aiPickup ? brigadirs : drivers).map(d => <option key={d.id} value={d.id}>{d.name}{d.salary_type === "brigadir" ? " (бригадир)" : ""}</option>)}
              </select>
            </div>
            ); })()}
            <div className="flex gap-2">
              <button onClick={confirmAI} disabled={saving || (!aiPickup && !aiDriver)} className="flex-1 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded-lg font-medium px-4 py-2.5 text-sm">{saving ? "Сохраняю..." : (aiPickup || aiDriver) ? "Добавить все" : "Сначала выбери водителя"}</button>
              <button onClick={() => { setAiResult(null); setAiDriver(""); setAiPickup(false); }} className="bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg font-medium px-4 py-2.5 text-sm">Отмена</button>
            </div>
          </div>
        )}
      </div>
      )}

      <div>
        <h4 className="font-semibold text-gray-700 mb-2">Доставки сегодня</h4>
        {(() => {
          const dl = loadRows.filter(o => o.date === TODAY() && (o.kg > 0 || o.count > 0));
          if (!dl.length) return null;
          const tKg = dl.reduce((s, o) => s + (o.kg || 0), 0), tCnt = dl.reduce((s, o) => s + (o.count || 0), 0);
          return (
            <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 mb-3">
              <div className="flex items-center justify-between mb-2 gap-2">
                <span className="font-semibold text-slate-700 text-sm flex items-center gap-1.5"><Icon name="truck" size={16} />Загрузка водителей</span>
                <span className="text-xs text-slate-500">{tCnt} заявок · {fmt(tKg)} кг</span>
              </div>
              <div className="space-y-1">
                {dl.sort((a, b) => (b.kg || 0) - (a.kg || 0)).map(o => {
                  const dr = drivers.find(d => d.id === o.driverId);
                  return <div key={o.id} className="flex items-center justify-between text-sm bg-white rounded-lg px-3 py-1.5"><span className="text-slate-700 inline-flex items-center gap-1">{dr ? <><Icon name="truck" size={13} />{dr.name}</> : "— не распределено —"}</span><span className="text-slate-500">{o.count} заявок · <b className="text-slate-700">{fmt(o.kg)} кг</b></span></div>;
                })}
              </div>
              <div className="text-[11px] text-slate-400 mt-1.5">Другие заявки — только объём, чтобы видеть загрузку водителя. Кому и что везут — не показывается.</div>
            </div>
          );
        })()}
        {todayGroups.length === 0 ? (
          <div className="text-center py-8 text-gray-400 bg-white border border-gray-100 rounded-2xl">На сегодня доставок нет.</div>
        ) : (
          <div className="space-y-2">
            {todayGroups.map((g, gi, arr) => {
              const statuses = [...new Set(g.orders.map(o => o.status))];
              const st = statuses.length === 1 ? statuses[0] : "частично";
              const shipped = st === "отгружена";
              const allNew = g.orders.every(o => o.status === "новая");
              const allRoute = g.orders.every(o => o.status === "в пути");
              const prevShipped = gi > 0 && arr[gi - 1].orders.every(o => o.status === "отгружена");
              const shippedCount = arr.filter(x => x.orders.every(o => o.status === "отгружена")).length;
              const isPickup = g.orders.some(o => o.pickup);
              const isWatch = isPickup && g.orders.some(o => o.pickupWatch); // самовывоз только под контролем
              const isOneOff = g.orders.some(o => o.oneOff);
              const worker = drivers.find(d => d.id === (isPickup ? g.orders.find(o => o.loaderId)?.loaderId : g.orders.find(o => o.driverId)?.driverId));
              return (
                <Fragment key={g.key}>
                {shipped && !prevShipped && <div className="text-xs font-semibold text-emerald-600 pt-2 pb-1">— ✓ Отвезено ({shippedCount}) —</div>}
                <div className={`rounded-2xl p-4 border ${shipped ? "bg-emerald-50 border-emerald-300" : "bg-white border-gray-100 shadow-sm"}`}>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="font-semibold text-gray-900 flex items-center gap-1.5 flex-wrap">{shipped && <span className="text-emerald-600"><Icon name="check" size={18} stroke={2.4} /></span>}{g.clientName || "Клиент"}{g.isTrial && <span className="text-xs font-medium text-orange-700 bg-orange-100 px-2 py-0.5 rounded-full inline-flex items-center gap-1"><Icon name="gift" size={12} />на пробу</span>}{isPickup && <span className={`text-xs font-medium px-2 py-0.5 rounded-full inline-flex items-center gap-1 ${isWatch ? "text-purple-700 bg-purple-100" : "text-sky-700 bg-sky-100"}`}><Icon name={isWatch ? "eye" : "bag"} size={12} />{isWatch ? "Самовывоз · контроль" : "Самовывоз"}</span>}{isOneOff && <span className="text-xs font-medium text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full inline-flex items-center gap-1"><Icon name="coin" size={12} />разовая</span>}{g.orders.some(o => o.from_client) && <span className="text-xs font-medium text-blue-700 bg-blue-100 px-2 py-0.5 rounded-full inline-flex items-center gap-1"><Icon name="globe" size={12} />от клиента</span>}{g.orders.some(o => o.created_by_role === "rep") && <span className="text-xs font-medium text-violet-700 bg-violet-100 px-2 py-0.5 rounded-full inline-flex items-center gap-1"><Icon name="user" size={12} />торгпред: {g.orders.find(o => o.created_by_role === "rep")?.created_by_name || "?"}</span>}</span>
                    {shipped ? <span className="text-xs font-bold bg-emerald-600 text-white px-3 py-1 rounded-full whitespace-nowrap">✓ Отгружено</span> : <Badge color={sc[st] || "gray"}>{st}</Badge>}
                  </div>
                  <div className="space-y-1">
                    {mergedPositions(g.orders).map((m, mi) => (
                      <div key={mi} className="flex items-center gap-2 flex-wrap text-sm">
                        <span className="bg-amber-100 text-amber-900 font-semibold px-2 py-0.5 rounded-md whitespace-nowrap inline-flex items-center gap-1"><Icon name="box" size={13} />{m.bags} меш. × {m.bag_kg} кг</span>
                        <span className="text-gray-600">= <b>{fmt(m.bags * m.bag_kg)} кг</b> · {m.brand} {m.grade}{m.trial ? " · на пробу" : ""}</span>
                      </div>
                    ))}
                  </div>
                  {[...new Set(g.orders.map(o => o.note).filter(Boolean))].map((n, ni) => <div key={ni} className="text-sm font-semibold text-amber-900 bg-amber-100 border border-amber-300 rounded-lg px-3 py-2 mt-1.5 flex items-start gap-1.5"><span className="text-amber-700 mt-0.5"><Icon name="note" size={15} /></span><span className="break-words">{n}</span></div>)}
                  {(!isOneOff || worker) && <div className="text-xs text-gray-500 mt-1 flex items-center gap-1"><Icon name={isPickup ? (isWatch ? "eye" : "bag") : "truck"} size={14} />{isPickup ? (isWatch ? "Контроль: " : "Грузчик: ") : "Водитель: "}<b className={worker ? "text-gray-700" : "text-orange-600"}>{worker?.name || (isPickup ? "определить позже" : "не назначен")}</b></div>}
                  {(() => { const cl = clients.find(c => c.id === g.clientId); const wh = cl?.work_hours || g.orders[0].work_hours || clientTime(cl); return wh ? <div className="mt-1.5 inline-flex items-center gap-1.5 text-sm font-bold text-sky-800 bg-sky-100 border border-sky-300 rounded-lg px-3 py-1.5"><Icon name="clock" size={16} />Работает: {wh}</div> : null; })()}
                  {isOneOff && g.orders[0].oneOffAddress && <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-1"><Icon name="pin" size={13} />{g.orders[0].oneOffAddress}</div>}
                  {(() => {
                    // Куда, как пройти и маршрут — чтобы понимать направление движения водителя
                    const client = clients.find(c => c.id === g.clientId);
                    const addr = client?.address || g.orders[0].address || g.orders[0].oneOffAddress || "";
                    const access = client?.access_note || "";
                    const gis = client?.gis_link || g.orders[0].gis_link || "";
                    const co = (client ? (client.coords || parseCoordsFromGisLink(client.gis_link) || parseCoordsFromText(client.coords_manual)) : g.orders[0].coords) || null;
                    if (!addr && !access && !gis && !co) return null;
                    return (<>
                      <div className="flex items-center gap-2 flex-wrap mt-1 text-xs">
                        {addr && !isOneOff && <span className="text-gray-500 inline-flex items-center gap-1"><Icon name="pin" size={13} />{addr}</span>}
                        {gis && <a href={gis} target="_blank" rel="noreferrer" className="bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full inline-flex items-center gap-1"><Icon name="pin" size={12} />2ГИС</a>}
                      </div>
                      {access && <div className="text-xs text-sky-800 bg-sky-50 border border-sky-100 rounded-lg px-2 py-1 mt-1 flex items-start gap-1"><span className="mt-0.5"><Icon name="door" size={13} /></span><span className="break-words">{access}</span></div>}
                    </>);
                  })()}
                  {canEdit && !g.orders.some(o => o.foreign) && (
                    <div className="mt-3 space-y-2">
                      <div className="flex gap-2 flex-wrap items-center">
                        {allNew && !isPickup && !isOneOff && <Btn size="sm" variant="secondary" onClick={() => setGroupStatus(g, "в пути")}><Icon name="truck" size={15} />В путь</Btn>}
                        {(allNew || allRoute) && <Btn size="sm" onClick={() => setGroupStatus(g, "отгружена")}><Icon name="check" size={15} stroke={2.4} />{isPickup ? "Отгрузить" : "Доставлено"}</Btn>}
                        {shipped && <Btn size="sm" variant="secondary" onClick={() => setGroupStatus(g, (isPickup || isOneOff) ? "новая" : "в пути")}>↩ {(isPickup || isOneOff) ? "Отменить" : "Не доставлено"}</Btn>}
                        {isOneOff && !g.clientId && <Btn size="sm" variant="secondary" onClick={() => addOneOffToClients(g)}><Icon name="plus" size={15} />В клиенты</Btn>}
                        {g.orders.some(o => !o.trial && !o.isSample) && <Btn size="sm" variant="secondary" onClick={() => softInvoiceFromOrders(g, clients.find(c => c.id === g.clientId))}><Icon name="receipt" size={15} />Накладная</Btn>}
                        <Btn size="sm" variant="secondary" onClick={() => setEditGroup(g)}><Icon name="pencil" size={15} />Изменить</Btn>
                        <Btn size="sm" variant="danger" onClick={() => deleteGroup(g)}><Icon name="trash" size={15} /></Btn>
                      </div>
                      {!shipped && (
                        <div className="flex items-center gap-2 text-xs text-gray-500 flex-wrap pt-1 border-t border-gray-50">
                          <span className="inline-flex items-center gap-1"><Icon name="calendar" size={13} />Перенести:</span>
                          <input type="date" className="border border-gray-200 rounded-lg px-2 py-1 text-xs" value={g.orders[0].date} onChange={e => rescheduleGroup(g, e.target.value)} />
                          <button className="text-amber-600 hover:text-amber-700 font-medium" onClick={() => rescheduleGroup(g, TOMORROW())}>→ на завтра</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                </Fragment>
              );
            })}
          </div>
        )}
      </div>

      {showManual && (
        <Modal title={form.oneOff ? "Единичная реализация" : form.isSample ? "Пробник" : form.trial ? "На пробу клиенту" : "Новая заявка"} onClose={() => setShowManual(false)}>
          {!form.isSample && !form.oneOff && (
            <label className="flex items-center gap-2 mb-2 cursor-pointer bg-orange-50 rounded-lg px-3 py-2">
              <input type="checkbox" checked={form.trial} onChange={e => setForm({ ...form, trial: e.target.checked })} className="w-4 h-4 accent-orange-500" />
              <span className="text-sm font-medium text-gray-700 flex items-center gap-1.5"><Icon name="gift" size={16} className="text-orange-500 shrink-0" />На пробу — клиенту из базы (бесплатно, маршрут строится, без накладной)</span>
            </label>
          )}
          {!form.trial && !form.oneOff && (
            <label className="flex items-center gap-2 mb-2 cursor-pointer bg-amber-50 rounded-lg px-3 py-2">
              <input type="checkbox" checked={form.isSample} onChange={e => setForm({ ...form, isSample: e.target.checked, trial: false })} className="w-4 h-4 accent-amber-500" />
              <span className="text-sm font-medium text-gray-700 flex items-center gap-1.5"><Icon name="flask" size={16} className="text-amber-600 shrink-0" />Проба новой компании — нет в базе (бесплатно или по цене, без маршрута)</span>
            </label>
          )}
          {!form.trial && !form.isSample && (
            <label className="flex items-center gap-2 mb-2 cursor-pointer bg-emerald-50 rounded-lg px-3 py-2">
              <input type="checkbox" checked={form.oneOff} onChange={e => setForm({ ...form, oneOff: e.target.checked, pickup: false, driverId: "", clientId: "", date: TODAY() })} className="w-4 h-4 accent-emerald-500" />
              <span className="text-sm font-medium text-gray-700 flex items-center gap-1.5"><Icon name="coin" size={16} className="text-emerald-600 shrink-0" />Единичная реализация — покупатель не из базы, за деньги (несколько сортов, можно с доставкой)</span>
            </label>
          )}
          {!form.isSample && !form.oneOff && (
            <label className="flex items-center gap-2 mb-3 cursor-pointer bg-sky-50 rounded-lg px-3 py-2">
              <input type="checkbox" checked={form.pickup} onChange={e => setForm({ ...form, pickup: e.target.checked, driverId: "", pickupWatch: false })} className="w-4 h-4 accent-sky-500" />
              <span className="text-sm font-medium text-gray-700 flex items-center gap-1.5"><Icon name="bag" size={16} className="text-sky-600 shrink-0" />Самовывоз — клиент забирает сам (вместо водителя выбери грузчика)</span>
            </label>
          )}
          {form.oneOff ? (
            <div className="space-y-3">
              <Inp label="Покупатель (можно не заполнять)" value={form.oneOffName} onChange={e => setForm({ ...form, oneOffName: e.target.value })} placeholder="Разовый покупатель" />
              <div>
                <p className="text-sm font-medium text-gray-700 mb-2">Что купил</p>
                {ooPos.map((p, i) => (
                  <div key={i} className="border border-gray-200 rounded-xl p-3 mb-2 relative">
                    {ooPos.length > 1 && <button onClick={() => setOoPos(ps => ps.filter((_, j) => j !== i))} className="absolute top-2 right-2 text-red-400 hover:text-red-600 text-lg leading-none" title="Убрать позицию">✕</button>}
                    <div className="grid grid-cols-2 gap-2">
                      <Sel label="Бренд" value={p.brand} onChange={e => updOo(i, "brand", e.target.value)} options={BRANDS} />
                      <Sel label="Сорт" value={p.grade} onChange={e => updOo(i, "grade", e.target.value)} options={GRADES} />
                      <Sel label="Фасовка" value={p.bag_kg} onChange={e => updOo(i, "bag_kg", e.target.value)} options={WEIGHTS.map(w => ({ value: w, label: w + " кг" }))} />
                      <Inp label="Мешков" type="number" value={p.bags} onChange={e => updOo(i, "bags", e.target.value)} />
                      <div className="col-span-2"><Inp label="Цена тг/кг" type="number" placeholder="обязательно" value={p.price_per_kg} onChange={e => updOo(i, "price_per_kg", e.target.value)} /></div>
                    </div>
                  </div>
                ))}
                <button onClick={() => setOoPos(ps => [...ps, { ...ooBlank }])} className="w-full border-2 border-dashed border-gray-200 rounded-xl py-2.5 text-sm font-medium text-gray-500 hover:bg-gray-50">+ ещё сорт / цена</button>
              </div>
              <Inp label="Адрес доставки (если повезём)" value={form.oneOffAddress} onChange={e => setForm({ ...form, oneOffAddress: e.target.value })} placeholder="Астана, ул. Абая 10" />
              <div>
                <Inp label="Ссылка 2ГИС на адрес" value={form.gis_link} onChange={e => setForm({ ...form, gis_link: e.target.value, coords: null })} placeholder="https://2gis.kz/astana/geo/..." />
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <Btn size="sm" variant="secondary" onClick={ooResolve} disabled={ooResolving || !form.gis_link}>{ooResolving ? "Ищу точку..." : "Определить точку"}</Btn>
                  {form.coords
                    ? <span className="text-xs text-emerald-600 font-medium">✓ точка найдена — встанет в маршрут водителя</span>
                    : <span className="text-xs text-gray-400">без точки заявка в маршрут не попадёт</span>}
                </div>
                {ooErr && <div className="text-xs text-red-500 mt-1">{ooErr}</div>}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Inp label="Дата" type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
                <Sel label="Кто повезёт" value={form.driverId} onChange={e => setForm({ ...form, driverId: e.target.value })} options={[{ value: "", label: isRep ? "— выбери бригадира —" : "— забрал сам —" }, ...driverPickOptions]} />
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">Оплата</label>
                <div className="flex gap-2 mt-1">
                  <button onClick={() => setForm({ ...form, payMethod: "Нал" })} className={`flex-1 py-2 rounded-lg text-sm font-medium ${form.payMethod === "Нал" ? "bg-emerald-500 text-white" : "bg-gray-100 text-gray-600"}`}>Нал</button>
                  <button onClick={() => setForm({ ...form, payMethod: "Безнал" })} className={`flex-1 py-2 rounded-lg text-sm font-medium ${form.payMethod === "Безнал" ? "bg-emerald-500 text-white" : "bg-gray-100 text-gray-600"}`}>Безнал</button>
                </div>
              </div>
              <Inp label="Заметка" value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} placeholder="напр. позвонить перед приездом" />
            </div>
          ) : (
          <div className="grid grid-cols-2 gap-3">
            {form.isSample
              ? <div className="col-span-2"><Inp label="Кому (название компании)" value={form.sampleName} onChange={e => setForm({ ...form, sampleName: e.target.value })} placeholder="Кафе Достык" /></div>
              : <div className="col-span-2"><Sel label="Клиент" value={form.clientId} onChange={e => setForm({ ...form, clientId: e.target.value })} options={[{ value: "", label: "— выбери клиента —" }, ...clients.map(c => ({ value: c.id, label: c.name + (c.org_name ? ` (${c.org_name})` : "") }))]} /></div>}
            <Sel label="Бренд" value={form.brand} onChange={e => setForm({ ...form, brand: e.target.value })} options={BRANDS} />
            <Sel label="Сорт" value={form.grade} onChange={e => setForm({ ...form, grade: e.target.value })} options={GRADES} />
            <Sel label="Фасовка" value={form.bag_kg} onChange={e => setForm({ ...form, bag_kg: e.target.value })} options={WEIGHTS.map(w => ({ value: w, label: w + " кг" }))} />
            <Inp label="Мешков" type="number" value={form.bags} onChange={e => setForm({ ...form, bags: e.target.value })} />
            {!form.trial && <Inp label={form.isSample ? "Цена тг/кг (0 = бесплатно)" : "Цена тг/кг"} type="number" min="0" placeholder={form.isSample ? "0 = бесплатно" : "авто из базы"} value={form.price_per_kg || ""} onChange={e => setForm({ ...form, price_per_kg: e.target.value })} />}
            <Inp label={form.pickup ? "Дата" : "Дата доставки"} type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
            {form.pickup
              ? <div className="col-span-2 space-y-2">
                  <Sel label={form.pickupWatch ? "Кто проследит (контроль)" : "Грузчик (кто отгрузит)"} value={form.loaderId} onChange={e => setForm({ ...form, loaderId: e.target.value })} options={[{ value: "", label: "— определить позже —" }, ...drivers.map(d => ({ value: d.id, label: d.name }))]} />
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setForm({ ...form, pickupWatch: false })} className={`flex-1 py-2 rounded-lg text-sm font-medium inline-flex items-center justify-center gap-1.5 ${!form.pickupWatch ? "bg-sky-500 text-white" : "bg-gray-100 text-gray-600"}`}><Icon name="bag" size={15} />Грузим сами</button>
                    <button type="button" onClick={() => setForm({ ...form, pickupWatch: true })} className={`flex-1 py-2 rounded-lg text-sm font-medium inline-flex items-center justify-center gap-1.5 ${form.pickupWatch ? "bg-purple-500 text-white" : "bg-gray-100 text-gray-600"}`}><Icon name="eye" size={15} />Только контроль</button>
                  </div>
                  {form.pickupWatch && <p className="text-xs text-purple-700 bg-purple-50 rounded-lg px-2 py-1">Клиент грузит сам, наш человек только следит, что забрали. Заявку он видит, но оплата за погрузку не начисляется.</p>}
                </div>
              : <div className="col-span-2"><Sel label={isRep ? "Бригадир (он распределит)" : "Водитель"} value={form.driverId} onChange={e => setForm({ ...form, driverId: e.target.value })} options={[{ value: "", label: isRep ? "— выбери бригадира —" : "— назначить позже —" }, ...driverPickOptions]} /></div>}
            <div className="col-span-2"><Inp label={form.pickup ? "Заметка (видит грузчик)" : "Заметка (видит водитель)"} value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} placeholder="напр. с отлёжкой (лежать месяц), оставить у охраны" /></div>
          </div>
          )}
          <div className="flex gap-2 mt-4">
            <Btn onClick={addManual} disabled={savingManual}>{savingManual ? "Сохраняю..." : "Добавить"}</Btn>
            <Btn variant="secondary" onClick={() => setShowManual(false)}>Отмена</Btn>
          </div>
        </Modal>
      )}
      {editGroup && <EditGroupModal key={editGroup.key} group={editGroup} clients={clients} reload={reload} onClose={() => setEditGroup(null)} />}
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState("today");
  const [user, setUser] = useState(null);
  const [data, setData] = useState({ clients: [], stock: [], orders: [], drivers: [], trucks: [], users: [], expenses: [], logins: [], notes: [], kgd_clients: [], kgd_docs: [], cashbox: [], payments: [], crm: [], lab: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastSync, setLastSync] = useState(null);
  const [fabOpen, setFabOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [dark, setDark] = useState(() => { try { return document.documentElement.classList.contains("dark"); } catch { return false; } });
  const toggleTheme = () => { const el = document.documentElement; const on = !el.classList.contains("dark"); el.classList.toggle("dark", on); try { localStorage.setItem("darad_theme", on ? "dark" : "light"); } catch {} const m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute("content", on ? "#1B1815" : "#651107"); setDark(on); };
  const [syncing, setSyncing] = useState(false); // ручное обновление: крутим значок и показываем ✓
  const [syncDone, setSyncDone] = useState(false);
  const [updateReady, setUpdateReady] = useState(false); // на сервере вышла новая версия приложения
  const [offline, setOffline] = useState(false); // нет связи — работаем на сохранённых данных
  const [openOrderSignal, setOpenOrderSignal] = useState(0);
  const [openExpenseSignal, setOpenExpenseSignal] = useState(0);
  const goTab = id => { setTab(id); setMoreOpen(false); setFabOpen(false); };

  const reload = useCallback(async (table) => {
    try { const rows = await dbGetAll(table); setData(prev => ({ ...prev, [table]: rows })); setLastSync(new Date().toLocaleTimeString("ru-RU")); }
    catch (e) { setError("Ошибка: " + e.message); }
  }, []);
  // Мгновенное локальное обновление (оптимистично) — экран меняется сразу, не дожидаясь сервера
  const applyLocal = useCallback((table, fn) => setData(prev => ({ ...prev, [table]: fn(prev[table] || []) })), []);

  const reloadAll = useCallback(async (showSpinner = false) => {
    if (!authToken) { if (showSpinner) setLoading(false); return; }
    if (showSpinner) setLoading(true);
    setError("");
    try {
      // Все таблицы одним запросом (быстрее, особенно на «холодном» старте)
      const d = (await apiData("loadAll")).data || {};
      if (!authToken) { setUser(null); if (showSpinner) setLoading(false); return; } // сессия истекла во время загрузки → на вход
      setData(prev => {
        const next = { clients: d.clients || [], stock: d.stock || [], orders: d.orders || [], drivers: d.drivers || [], trucks: d.trucks || [], users: d.users || [], expenses: d.expenses || [], logins: d.logins || [], notes: d.notes || [], kgd_clients: d.kgd_clients || [], kgd_docs: d.kgd_docs || [], cashbox: d.cashbox || [], payments: d.payments || [], crm: d.crm || [], lab: d.lab || [] };
        applyWarehouse(next.notes); // подхватываем сохранённый адрес склада
        // Если данные не изменились — не трогаем экран (иначе телефон перерисовывает всё каждые полминуты и подтормаживает)
        const same = Object.keys(next).every(k => JSON.stringify(prev[k]) === JSON.stringify(next[k]));
        // Сохраняем копию для офлайна (нужно менеджерам Караганды в поле)
        try { localStorage.setItem("sklad_cache", JSON.stringify(next)); } catch {}
        return same ? prev : next;
      });
      setOffline(false);
      setLastSync(new Date().toLocaleTimeString("ru-RU"));
    } catch (e) {
      // apiData сбрасывает токен на 401 (сессия истекла / доступ закрыт) → выкидываем на экран входа
      if (!authToken) { setUser(null); if (showSpinner) setLoading(false); return; }
      // Нет сети — поднимаем последние сохранённые данные и работаем офлайн
      const isOffline = /offline|Failed to fetch|NetworkError|Сервер не/i.test(String(e.message || e)) || !navigator.onLine;
      if (isOffline) {
        setOffline(true);
        try { const c = JSON.parse(localStorage.getItem("sklad_cache") || "null"); if (c) setData(prev => (prev.kgd_clients?.length || prev.orders?.length) ? prev : c); } catch {}
      } else setError("Нет связи с базой: " + e.message);
    }
    if (showSpinner) setLoading(false);
  }, []);

  // На старте: поднять сохранённые данные (чтобы офлайн сразу было что показать)
  useEffect(() => {
    try { const c = JSON.parse(localStorage.getItem("sklad_cache") || "null"); if (c) { setData(c); applyWarehouse(c.notes); } } catch {}
  }, []);

  // На старте: восстановить сессию из токена (без обращения к базе)
  useEffect(() => {
    const t = localStorage.getItem("sklad_token");
    const p = t ? decodeToken(t) : null;
    if (p && (!p.exp || Date.now() < p.exp)) {
      authToken = t;
      setUser({ id: p.uid, name: p.name, role: p.role, driverId: p.driverId || "" });
    } else { setAuthToken(null); setLoading(false); }
  }, []);

  // Когда вошли — грузим данные и обновляем раз в 30 сек
  useEffect(() => { if (user) reloadAll(true); }, [user]);
  useEffect(() => {
    if (!user) return;
    // обновляем только когда вкладка открыта — экономим трафик/лимиты, когда сайт свёрнут
    const t = setInterval(() => { if (document.visibilityState === "visible") reloadAll(false); }, 60000);
    return () => clearInterval(t);
  }, [user]);

  // Проверка обновлений: если на сервере вышла новая версия — показываем плашку «обновить».
  // Иначе водители неделями сидят на старой версии, не перезагружая приложение.
  useEffect(() => {
    const current = document.querySelector('script[src*="/assets/index-"]')?.getAttribute("src");
    if (!current) return;
    const check = async () => {
      try {
        const html = await (await fetch("/", { cache: "no-store" })).text();
        const m = html.match(/\/assets\/index-[a-z0-9]+\.js/);
        if (m && m[0] !== current) setUpdateReady(true);
      } catch {}
    };
    const t = setInterval(check, 5 * 60000);
    return () => clearInterval(t);
  }, []);

  // При входе переключить на первую доступную для роли вкладку
  useEffect(() => {
    if (!user) return;
    const allowed = TABS_BY_ROLE[user.role] || [];
    if (!allowed.includes(tab)) setTab(allowed[0] || "calendar");
  }, [user]);

  // Ручное обновление с видимой реакцией: значок крутится, по завершении — зелёная галочка
  const manualRefresh = async () => {
    if (syncing) return;
    setSyncing(true); setSyncDone(false);
    await reloadAll(false);
    setSyncing(false); setSyncDone(true);
    setTimeout(() => setSyncDone(false), 2000);
  };

  const logout = () => { setAuthToken(null); localStorage.removeItem("sklad_uid"); setData({ clients: [], stock: [], orders: [], drivers: [], trucks: [], users: [], expenses: [], logins: [], notes: [], kgd_clients: [], kgd_docs: [], cashbox: [], payments: [], crm: [] }); setUser(null); setLoading(false); };

  if (loading) return <div className="min-h-screen bg-gray-50 flex items-center justify-center"><Spinner /></div>;
  if (!user) return <LoginScreen onLogin={setUser} />;

  const isDirector = user.role === "director";
  const isRep = user.role === "rep"; // торговый представитель: правит только своих клиентов/заявки/оплаты
  // 🧮 «Ревизия» — только у разработчика (Альяса): по имени входа ИЛИ по галочке «Разработчик» (метка «р») на аккаунте.
  const myRecord = (data.users || []).find(u => u.id === user.id) || {};
  const isDev = isDirector && (/^\s*(альяс|alyas)/i.test(user.name || "") || myRecord.dev === true);
  const allowedTabs = (TABS_BY_ROLE[user.role] || []).filter(id => id !== "revision" || isDev);
  // Нижняя панель: основные разделы для роли (что есть в доступе), остальное — под «Ещё»
  const primaryNav = (PRIMARY_NAV[user.role] || []).filter(id => allowedTabs.includes(id));
  const moreNav = allowedTabs.filter(id => !primaryNav.includes(id));
  // Считаем новые ЗАЯВКИ (по клиенту+дате), а не отдельные позиции
  const newOrders = new Set(data.orders.filter(o => o.status === "новая").map(o => (o.clientId || "nm:" + (o.clientName || "")) + "|" + o.date)).size;

  return (
    <div className="min-h-screen bg-gray-50 font-sans">
      <div className="bg-white border-b border-gray-100 px-4 py-4 sticky top-0 z-40 shadow-sm">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2.5 min-w-0">
            <img src="/icon-192.png" alt="Darad" className="w-9 h-9 rounded-lg flex-shrink-0" />
            <div className="min-w-0">
              <h1 className="text-xl font-display font-semibold text-gray-900 leading-tight">Darad</h1>
              <p className="text-xs text-gray-400 flex items-center gap-1"><span className="truncate">{user.name} · {ROLES[user.role] || user.role}</span>{lastSync && <span className="flex items-center gap-1 flex-shrink-0"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block"></span>{lastSync}</span>}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button onClick={manualRefresh} disabled={syncing} title="Обновить" className={`flex items-center justify-center w-8 h-8 rounded-full border transition-all active:scale-90 ${syncDone ? "bg-emerald-50 border-emerald-300 text-emerald-600" : syncing ? "bg-amber-50 border-amber-300 text-amber-600" : "bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100 hover:text-gray-700"}`}>
              <Icon name={syncDone ? "check" : "refresh"} size={16} className={syncing ? "animate-spin" : ""} />
            </button>
            <button onClick={toggleTheme} className="text-gray-400 hover:text-gray-600 w-8 h-8 flex items-center justify-center rounded-full" title={dark ? "Светлая тема" : "Тёмная тема"} aria-label="Сменить тему"><Icon name={dark ? "sun" : "moon"} size={19} /></button>
            <button onClick={logout} className="text-gray-400 hover:text-red-500 w-8 h-8 flex items-center justify-center rounded-full" title="Выйти" aria-label="Выйти"><Icon name="logout" size={19} /></button>
          </div>
        </div>
      </div>
      {updateReady && (
        <button onClick={() => window.location.reload()} className="w-full bg-amber-500 text-white text-sm font-bold px-4 py-2.5 text-center">
          ✨ Вышло обновление приложения — нажми здесь, чтобы обновиться
        </button>
      )}
      {offline && (
        <div className="bg-gray-700 text-white text-sm px-4 py-2 text-center">
          📴 Нет связи — работаем на сохранённых данных. Документы формируются, изменения не сохраняются.
        </div>
      )}
      {error && <div className="bg-red-50 border-b border-red-200 px-4 py-2 text-sm text-red-600 text-center">{error}</div>}
      <div className="max-w-2xl mx-auto px-4 py-5 pb-28">
        {allowedTabs.includes(tab) && (
          <>
            {tab === "today" && <TodayTab orders={data.orders} clients={data.clients} drivers={data.drivers} stock={data.stock} notes={data.notes} me={user.name} role={user.role} reload={reload} applyLocal={applyLocal} driverFilter={user.role === "driver" ? (user.driverId || "") : null} canEdit={isDirector || isRep} openSignal={openOrderSignal} />}
            {tab === "calendar" && <CalendarTab orders={data.orders} drivers={data.drivers} clients={data.clients} stock={data.stock} reload={reload} applyLocal={applyLocal} canEdit={isDirector || isRep} showPrices={user.role !== "driver" && user.role !== "brigadir"} driverFilter={user.role === "driver" ? (user.driverId || "") : null} driverMode={user.role === "driver"} foremanMode={user.role === "brigadir"} serverStock={isRep} />}
            {tab === "mysalary" && <MySalaryTab drivers={data.drivers} orders={data.orders} myDriverId={user.driverId || ""} />}
            {tab === "stock" && <StockTab stock={data.stock} orders={data.orders} trucks={data.trucks} expenses={data.expenses} reload={reload} canEdit={isDirector} />}
            {tab === "lab" && <LabTab lab={data.lab} reload={reload} canEdit={isDirector} />}
            {tab === "revision" && isDev && <RevisionTab stock={data.stock} notes={data.notes} reload={reload} applyLocal={applyLocal} />}
            {tab === "supply" && <TrucksTab trucks={data.trucks} reload={reload} canEdit={isDirector} />}
            {tab === "karaganda" && <KaragandaTab orders={data.orders} clients={data.clients} reload={reload} canEdit={isDirector} />}
            {tab === "kgdm" && <KgdManagersTab kgdClients={data.kgd_clients} kgdDocs={data.kgd_docs} reload={reload} canManage={isDirector || user.role === "kgdmanager" || user.role === "kgdsenior"} isSenior={isDirector || user.role === "kgdsenior"} me={user.name} />}
            {tab === "debts" && <DebtsTab orders={data.orders} clients={data.clients} payments={data.payments} reload={reload} canEdit={isDirector || isRep} />}
            {tab === "contracts" && <ContractsTab clients={data.clients} />}
            {tab === "invoice" && <SoftInvoiceTab clients={data.clients} orders={data.orders} />}
            {tab === "reactivate" && <ReactivateTab clients={data.clients} orders={data.orders} />}
            {tab === "clients" && <ClientsTab clients={data.clients} orders={data.orders} payments={data.payments} users={data.users} notes={data.notes} role={user.role} myUid={user.id} reload={reload} canEdit={isDirector || isRep} />}
            {tab === "crm" && <CrmTab crm={data.crm} clients={data.clients} reload={reload} />}
            {tab === "drivers" && <DriversTab drivers={data.drivers} orders={data.orders} expenses={data.expenses} users={data.users} reload={reload} canEdit={isDirector} />}
            {tab === "expenses" && <ExpensesTab expenses={data.expenses} reload={reload} openSignal={openExpenseSignal} canEdit={isDirector} />}
            {tab === "cashbox" && <CashboxTab cashbox={data.cashbox} reload={reload} canEdit={isDirector} />}
            {tab === "reports" && <ReportsTab orders={data.orders} drivers={data.drivers} stock={data.stock} expenses={data.expenses} payments={data.payments} clients={data.clients} users={data.users} role={user.role} reload={reload} canEdit={isDirector} />}
            {tab === "access" && <UsersTab users={data.users} drivers={data.drivers} logins={data.logins} notes={data.notes} reload={reload} currentUser={user} />}
          </>
        )}
      </div>

      {(isDirector || isRep) && (
        <>
          {fabOpen && (
            <div className="fixed inset-0 z-40" onClick={() => setFabOpen(false)} style={{ background: "rgba(0,0,0,0.35)" }}>
              <div className="max-w-2xl mx-auto px-4 relative h-full">
                <div className="absolute right-4 bottom-40 flex flex-col items-end gap-3" onClick={e => e.stopPropagation()}>
                  {isDirector && <button onClick={() => { setFabOpen(false); setAssistantOpen(true); }} className="flex items-center gap-2"><span className="bg-white shadow rounded-full px-3 py-1.5 text-sm font-semibold text-amber-700">ИИ-помощник</span><span className="w-12 h-12 rounded-full bg-gradient-to-br from-amber-500 to-orange-500 text-white flex items-center justify-center shadow-lg ring-2 ring-amber-200"><Icon name="sparkle" size={22} /></span></button>}
                  <button onClick={() => goTab("today")} className="flex items-center gap-2"><span className="bg-white shadow rounded-full px-3 py-1.5 text-sm font-medium text-gray-700">Разобрать из WhatsApp</span><span className="w-11 h-11 rounded-full bg-amber-500 text-white flex items-center justify-center shadow-lg"><Icon name="chat" size={20} /></span></button>
                  <button onClick={() => { goTab("today"); setOpenOrderSignal(n => n + 1); }} className="flex items-center gap-2"><span className="bg-white shadow rounded-full px-3 py-1.5 text-sm font-medium text-gray-700">Заявка вручную</span><span className="w-11 h-11 rounded-full bg-amber-500 text-white flex items-center justify-center shadow-lg"><Icon name="pencil" size={20} /></span></button>
                  {isDirector && <button onClick={() => { goTab("expenses"); setOpenExpenseSignal(n => n + 1); }} className="flex items-center gap-2"><span className="bg-white shadow rounded-full px-3 py-1.5 text-sm font-medium text-gray-700">Расход</span><span className="w-11 h-11 rounded-full bg-amber-500 text-white flex items-center justify-center shadow-lg"><Icon name="expense" size={20} /></span></button>}
                </div>
              </div>
            </div>
          )}
          <button onClick={() => setFabOpen(v => !v)} className="fixed z-40 right-4 bottom-24 w-14 h-14 rounded-full bg-amber-500 hover:bg-amber-600 text-white flex items-center justify-center shadow-xl transition-transform" style={{ transform: fabOpen ? "rotate(45deg)" : "none" }} aria-label="Добавить"><Icon name="plus" size={28} stroke={2.2} /></button>
          {isDirector && assistantOpen && <AssistantModal onClose={() => setAssistantOpen(false)} orders={data.orders} reload={reload} />}
        </>
      )}

      <nav className="fixed bottom-0 left-0 right-0 z-30 bg-white border-t border-gray-100">
        <div className="max-w-2xl mx-auto flex justify-between px-2 py-1.5">
          {primaryNav.map(id => (
            <button key={id} onClick={() => goTab(id)} className={`flex-1 flex flex-col items-center gap-1 py-1 ${tab === id ? "text-amber-600" : "text-gray-400"}`}>
              <Icon name={NAV_ICON[id]} size={22} stroke={tab === id ? 2 : 1.7} />
              <span className="text-[10px] font-medium">{NAV_SHORT[id]}</span>
            </button>
          ))}
          {moreNav.length > 0 && (
            <button onClick={() => setMoreOpen(true)} className={`flex-1 flex flex-col items-center gap-1 py-1 ${moreNav.includes(tab) ? "text-amber-600" : "text-gray-400"}`}>
              <Icon name="dots" size={22} />
              <span className="text-[10px] font-medium">Ещё</span>
            </button>
          )}
        </div>
      </nav>

      {moreOpen && (
        <div className="fixed inset-0 z-40 flex items-end" onClick={() => setMoreOpen(false)} style={{ background: "rgba(0,0,0,0.4)" }}>
          <div className="bg-white w-full rounded-t-2xl max-w-2xl mx-auto p-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3"><h3 className="font-display font-semibold text-gray-800">Ещё</h3><button onClick={() => setMoreOpen(false)} className="text-gray-400"><Icon name="close" size={22} /></button></div>
            <div className="grid grid-cols-3 gap-3">
              {moreNav.map(id => (
                <button key={id} onClick={() => goTab(id)} className={`flex flex-col items-center gap-2 rounded-2xl border p-4 ${tab === id ? "border-amber-300 bg-amber-50 text-amber-700" : "border-gray-100 bg-gray-50 text-gray-600"}`}>
                  <span className={`w-10 h-10 rounded-xl flex items-center justify-center ${tab === id ? "bg-amber-100 text-amber-700" : "bg-white text-amber-600"}`}><Icon name={NAV_ICON[id]} size={22} /></span>
                  <span className="text-xs font-medium text-gray-700 text-center">{NAV_SHORT[id]}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
