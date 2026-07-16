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
  return data;
}
async function dbGetAll(table) { return (await apiData("list", table)).rows || []; }
async function dbUpsert(table, item) { await apiData("upsert", table, { item }); }
async function dbDelete(table, id) { await apiData("delete", table, { id }); }

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
const ROLES = { director: "Администратор", viewer: "Директор", accountant: "Бухгалтер", driver: "Водитель" };
// Какие вкладки видит каждая роль
const TABS_BY_ROLE = {
  director: ["today", "calendar", "stock", "clients", "reactivate", "reports", "debts", "contracts", "invoice", "supply", "karaganda", "drivers", "expenses", "access"],
  viewer: ["today", "calendar", "stock", "clients", "reactivate", "reports", "debts", "karaganda", "supply", "drivers", "expenses"], // директор — только просмотр
  accountant: ["today", "calendar", "reports"],
  driver: ["calendar"],
};
// Что показываем в нижней панели (остальное — под «Ещё»)
const PRIMARY_NAV = {
  director: ["today", "calendar", "stock", "clients", "reports"],
  viewer: ["today", "calendar", "stock", "clients", "reports"],
  accountant: ["today", "calendar", "reports"],
  driver: ["calendar"],
};
const NAV_ICON = { today: "🏠", calendar: "📅", stock: "🏭", clients: "🏢", reactivate: "🔔", reports: "📊", debts: "💰", contracts: "📄", invoice: "🧾", orders: "📋", supply: "🚚", karaganda: "🏬", drivers: "🚛", expenses: "💸", access: "⚙️" };
const NAV_SHORT = { today: "Сегодня", calendar: "Календарь", stock: "Склад", clients: "Клиенты", reactivate: "Напомнить", reports: "Отчёты", debts: "Долги", contracts: "Договоры", invoice: "Накладная", orders: "Заявки", supply: "Поставки", karaganda: "Караганда", drivers: "Рабочие", expenses: "Расходы", access: "Доступ" };
const BRANDS = ["ДАРАД", "ДАЛА НАН"];
const GRADES = ["Высший сорт", "Первый сорт"];
const WEIGHTS = [5, 10, 25, 50];
const DELIVERY_TIMES = ["В течение дня", "Утром (8–12)", "Днём (12–17)", "Вечером (17–21)"];
const WRITEOFF_REASONS = ["Брак", "Порча", "Пересортица", "Возврат", "Прочее"];
const EXPENSE_CATS = ["Фура/Поставка", "Водители", "Грузчики", "Поддоны/Склад", "Аренда", "Зарплата", "Прочее"];

const WAREHOUSE = { lat: 51.17833, lon: 71.460803 };

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
  const res = await fetch(`/api/resolve-gis?url=${encodeURIComponent(link)}`);
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

async function parseOrderWithAI(text, clients) {
  // Разбор идёт через нашу серверную функцию /api/parse-order — ключ Anthropic живёт там, не в браузере
  const res = await fetch("/api/parse-order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      today: TODAY(),
      tomorrow: TOMORROW(),
      weekday: TODAY_WEEKDAY(),
      clients: clients.map(c => ({ name: c.name, org_name: c.org_name, default_bag_kg: c.default_bag_kg, default_brand: c.default_brand, products: (c.prices || []).map(p => ({ brand: p.brand, grade: p.grade, bag_kg: p.bag_kg })) })),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Не удалось разобрать заявку");
  return JSON.parse(data.raw);
}

async function parseClientWithAI(text) {
  const res = await fetch("/api/parse-client", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Не удалось разобрать данные клиента");
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
function Btn({ variant = "primary", size = "md", children, ...p }) {
  const sz = { sm: "px-3 py-1.5 text-xs", md: "px-4 py-2 text-sm", lg: "px-6 py-3 text-base" };
  const vr = { primary: "bg-amber-500 hover:bg-amber-600 text-white", secondary: "bg-gray-100 hover:bg-gray-200 text-gray-700", danger: "bg-red-500 hover:bg-red-600 text-white", ghost: "hover:bg-gray-100 text-gray-600" };
  return <button className={`rounded-lg font-medium transition-all focus:outline-none ${sz[size]} ${vr[variant]}`} {...p}>{children}</button>;
}
function Spinner() {
  return <div className="flex flex-col items-center justify-center py-16 gap-3"><div className="w-8 h-8 border-4 border-amber-400 border-t-transparent rounded-full animate-spin"></div><p className="text-sm text-gray-400">Загружаю данные...</p></div>;
}
function MiniBar({ value, max, color = "bg-amber-400" }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return <div className="flex items-center gap-2 w-full"><div className="flex-1 bg-gray-100 rounded-full h-2.5 overflow-hidden"><div className={`${color} h-2.5 rounded-full`} style={{ width: pct + "%" }} /></div><span className="text-xs text-gray-500 w-8 text-right">{pct}%</span></div>;
}

const TABS = [{ id: "today", label: "🏠 Сегодня" }, { id: "calendar", label: "📅 Календарь" }, { id: "stock", label: "🏭 Склад" }, { id: "clients", label: "🏢 Клиенты" }, { id: "reactivate", label: "🔔 Напомнить" }, { id: "reports", label: "📊 Отчёты" }, { id: "debts", label: "💰 Долги" }, { id: "contracts", label: "📄 Договоры" }, { id: "supply", label: "🚚 Поставки" }, { id: "karaganda", label: "🏬 Караганда" }, { id: "drivers", label: "🚛 Водители" }, { id: "expenses", label: "💸 Расходы" }, { id: "access", label: "⚙️ Доступ" }];

function CalendarTab({ orders, drivers, clients, stock = [], reload, applyLocal = () => {}, canEdit = true, showPrices = true, driverFilter = null, driverMode = false }) {
  const [cursor, setCursor] = useState(new Date());
  const [selected, setSelected] = useState(TODAY());
  const [uploadingId, setUploadingId] = useState(null);
  const [photoView, setPhotoView] = useState(null);
  const [editGroup, setEditGroup] = useState(null);

  // Отгрузки из Караганды идут напрямую клиенту — в маршруты Астаны не лезут, но в календаре видны отдельным блоком
  const local = orders.filter(o => !o.fromKaraganda);
  // Водитель видит только свои отгрузки
  const vis = driverFilter != null ? local.filter(o => o.driverId === driverFilter) : local;
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
  const shipStock = o => dbUpsert("stock", { id: "mv_" + o.id, date: TODAY(), brand: o.brand, grade: o.grade, weight_kg: -(o.bags * o.bag_kg), bags: -o.bags, bag_kg: o.bag_kg, note: `Отгрузка: ${o.clientName}` });
  const unshipStock = async o => {
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
  const deleteOrder = async (id) => { try { await dbDelete("orders", id); await reload("orders"); } catch (e) { notifyErr(e); } };

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
  const deleteGroup = async g => {
    if (!confirm(`Удалить всю заявку «${g.clientName}» (${g.orders.length} поз.)?`)) return;
    const ids = new Set(g.orders.map(o => o.id));
    applyLocal("orders", os => os.filter(o => !ids.has(o.id)));
    try { await Promise.all(g.orders.map(o => dbDelete("orders", o.id))); } catch (e) { notifyErr(e); reload("orders"); }
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
      for (const o of g.orders) await dbUpsert("orders", { ...o, clientId: id });
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
            const kg = kgByDate[ds] || 0;
            const cnt = countByDate[ds] || 0;
            const isToday = ds === TODAY();
            const isSelected = ds === selected;
            return (
              <button key={ds} onClick={() => setSelected(ds)}
                className={`aspect-square rounded-lg flex flex-col items-center justify-center text-sm relative transition-all
                  ${isSelected ? "bg-amber-500 text-white" : cnt > 0 ? "bg-amber-50 hover:bg-amber-100 text-gray-800" : "hover:bg-gray-100 text-gray-600"}
                  ${isToday && !isSelected ? "ring-2 ring-amber-400" : ""}`}>
                <span className={isToday ? "font-bold" : ""}>{dayNum}</span>
                {cnt > 0 && <span className={`text-[9px] leading-none mt-0.5 ${isSelected ? "text-amber-100" : "text-amber-600"}`}>{cnt} зак.</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h4 className="font-semibold text-gray-700">Отгрузки на {selected.split("-").reverse().join(".")}</h4>
          {dayKg > 0 && <span className="text-sm text-gray-500">📦 {fmt(dayKg)} кг</span>}
        </div>
        {!driverMode && dayOrders.length > 0 && (
          <div className="flex gap-2 mb-3">
            <Btn size="sm" variant="secondary" onClick={() => downloadFile(`Отчёт_${selected}.txt`, buildReport(), "text/plain;charset=utf-8")}>📄 Отчёт за день</Btn>
            <Btn size="sm" variant="secondary" onClick={() => downloadFile(`Склад_${selected}.csv`, buildCsv(), "text/csv;charset=utf-8")}>📊 Excel</Btn>
          </div>
        )}
        {dayOrders.length === 0 && karagandaDayGroups.length === 0 ? (
          <div className="text-center py-10 text-gray-400">На это число отгрузок нет</div>
        ) : (
          <div className="space-y-2">
            {dayGroups.map((g, gi, arr) => {
              const client = clients.find(c => c.id === g.clientId);
              const driver = drivers.find(d => d.id === g.orders[0].driverId);
              const isPickup = g.orders.some(o => o.pickup);
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
                    <span className="font-bold text-gray-900 flex items-center gap-1.5">{allShipped && <span className="text-emerald-600 text-lg">✓</span>}{g.clientName || "Клиент"}{g.isSample && " 🧪"}{g.isTrial && <Badge color="yellow">🎁 на пробу</Badge>}{isPickup && <Badge color="blue">🚶 Самовывоз</Badge>}{isOneOff && <Badge color="green">💰 разовая</Badge>}{!isPickup && !isOneOff && allLoaded && !allShipped && <Badge color="blue">📦 в машине</Badge>}</span>
                    {allShipped ? <span className="text-xs font-bold bg-emerald-600 text-white px-3 py-1 rounded-full whitespace-nowrap">✓ Отгружено</span> : <Badge color={sc[gStatus] || "gray"}>{gStatus}</Badge>}
                  </div>
                  {client?.org_name && <div className="text-xs text-gray-500">🏢 {client.org_name}</div>}
                  <div className="mt-1 space-y-1">
                    {mergedPositions(g.orders).map((m, mi) => (
                      <div key={mi} className="text-gray-600 flex items-center gap-2 flex-wrap">
                        <span>• {m.brand} {m.grade}</span>
                        <span className="bg-amber-100 text-amber-900 font-bold px-2 py-0.5 rounded-md whitespace-nowrap">📦 {m.bags} меш. × {m.bag_kg} кг</span>
                        <span>= <b>{fmt(m.bags * m.bag_kg)} кг</b></span>
                        {m.trial ? <span className="text-orange-600 font-medium">🎁 на пробу</span> : (showPrices && m.tg ? <span className="text-gray-400">· {fmt(m.tg)} тг</span> : null)}
                      </div>
                    ))}
                  </div>
                  {g.orders.length > 1 && <div className="text-xs text-gray-500 mt-1">Итого: <b>{fmt(gKg)} кг</b>{showPrices && gSum ? ` · ${fmt(gSum)} тг` : ""}</div>}
                  {[...new Set(g.orders.map(o => o.note).filter(Boolean))].map((n, ni) => <div key={ni} className="text-xs text-amber-900 bg-amber-50 border border-amber-100 rounded-lg px-2 py-1 mt-1">📝 {n}</div>)}
                  {isOneOff && g.orders[0].oneOffAddress && <div className="text-xs text-gray-500 mt-0.5">📍 {g.orders[0].oneOffAddress}</div>}
                  <div className="text-xs text-gray-400 mt-0.5 flex items-center gap-2 flex-wrap">
                    {clientTime(client) && <span className="bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full">⏰ {clientTime(client)}</span>}
                    {(client?.gis_link || g.orders[0].gis_link) && <a href={client?.gis_link || g.orders[0].gis_link} target="_blank" rel="noreferrer" className="bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full">📍 2ГИС</a>}
                    {(() => { const co = client ? (client.coords || parseCoordsFromGisLink(client.gis_link) || parseCoordsFromText(client.coords_manual)) : g.orders[0].coords; return co ? <a href={buildGisRouteUrl([co])} target="_blank" rel="noreferrer" className="bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-full">🧭 Маршрут сюда</a> : null; })()}
                    {!driverMode && g.orders.some(o => !o.trial && !o.isSample) && <button onClick={() => copyToClipboard(nakladnayaText(g, client))} className="bg-violet-50 text-violet-700 px-2 py-0.5 rounded-full">📋 Для накладной</button>}
                    {!driverMode && canEdit && <button onClick={() => setEditGroup(g)} className="bg-gray-100 text-gray-700 px-2 py-0.5 rounded-full">✏️ Изменить</button>}
                    {g.orders[0].created_by_name && <span>✍️ {g.orders[0].created_by_name}</span>}
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
                  {anyClaim && !allConfirmed && <div className="text-xs text-amber-600 mt-1">🚚 Водитель отметил «доставил» — ждёт подтверждения</div>}
                  {allConfirmed && <div className="text-xs text-emerald-600 mt-1">✓ Подтверждено</div>}

                  {driverMode ? (
                    <div className="flex items-center gap-2 flex-wrap mt-2 pt-2 border-t border-gray-50">
                      {!allShipped && (allLoaded
                        ? <Btn size="sm" variant="secondary" onClick={() => loadGroup(g, false)}>↩ Не загружен</Btn>
                        : <Btn size="sm" onClick={() => loadGroup(g, true)}>📦 Загрузил</Btn>)}
                      {allShipped
                        ? <span className="text-sm font-bold text-emerald-700">✓ Доставка подтверждена</span>
                        : (allDelivered
                          ? <Btn size="sm" variant="secondary" onClick={() => driverMarkGroup(g, false)}>↩ Отменить «доставил»</Btn>
                          : <Btn size="sm" onClick={() => driverMarkGroup(g, true)}>✓ Доставил</Btn>)}
                      <label className={`cursor-pointer text-xs rounded-lg px-3 py-1.5 font-medium ${uploadingId === firstId ? "bg-gray-200 text-gray-400" : "bg-gray-100 hover:bg-gray-200 text-gray-700"}`}>
                        {uploadingId === firstId ? "Загрузка..." : "📷 Фото"}
                        <input type="file" accept="image/*" capture="environment" hidden disabled={uploadingId === firstId} onChange={e => { addPhoto(g.orders[0], e.target.files[0]); e.target.value = ""; }} />
                      </label>
                    </div>
                  ) : canEdit ? (
                    (isPickup || isOneOff) ? (
                    <div className="flex items-center gap-2 flex-wrap mt-2 pt-2 border-t border-gray-50">
                      {isPickup && (
                        <select className="border border-gray-200 rounded-lg px-2 py-1 text-xs" value={g.orders[0].loaderId || ""} onChange={e => assignLoaderGroup(g, e.target.value)}>
                          <option value="">📦 Грузчик</option>
                          {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                        </select>
                      )}
                      {!allShipped
                        ? <Btn size="sm" onClick={() => setGroupStatus(g, "отгружена")}>✓ Отгрузить</Btn>
                        : <Btn size="sm" variant="secondary" onClick={() => setGroupStatus(g, "новая")}>↩ Отменить</Btn>}
                      {isOneOff && !g.clientId && <Btn size="sm" variant="secondary" onClick={() => addOneOffToClients(g)}>➕ В клиенты</Btn>}
                      <Btn size="sm" variant="danger" onClick={() => deleteGroup(g)}>✕</Btn>
                    </div>
                    ) : (
                    <div className="flex items-center gap-2 flex-wrap mt-2 pt-2 border-t border-gray-50">
                      <select className="border border-gray-200 rounded-lg px-2 py-1 text-xs" value={g.orders[0].driverId || ""} onChange={e => assignDriverGroup(g, e.target.value)}>
                        <option value="">🚛 Водитель</option>
                        {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </select>
                      {!allShipped && (allLoaded
                        ? <Btn size="sm" variant="secondary" onClick={() => loadGroup(g, false)}>↩ Не загружен</Btn>
                        : <Btn size="sm" variant="secondary" onClick={() => loadGroup(g, true)}>📦 Загрузил</Btn>)}
                      {anyClaim && !allConfirmed
                        ? <Btn size="sm" onClick={() => confirmGroup(g)}>✓ Подтвердить</Btn>
                        : (!allShipped
                          ? <Btn size="sm" onClick={() => setGroupStatus(g, "отгружена")}>✓ Доставлено</Btn>
                          : <Btn size="sm" variant="secondary" onClick={() => setGroupStatus(g, "в пути")}>↩ Не доставлено</Btn>)}
                      <Btn size="sm" variant="danger" onClick={() => deleteGroup(g)}>✕</Btn>
                    </div>
                    )
                  ) : (
                    <div className="text-xs text-gray-400 mt-1">{worker ? `${isPickup ? "📦" : "🚛"} ${worker.name}` : ""}</div>
                  )}
                </div>
                </Fragment>
              );
            })}
          </div>
        )}
        {!driverMode && allDayGroups.filter(g => g.orders.some(o => !o.trial && !o.isSample)).length > 0 && (
          <div className="mt-3">
            <Btn variant="secondary" onClick={() => copyToClipboard(`Накладные на ${selected.split("-").reverse().join(".")}:\n\n` + allDayGroups.map(g => nakladnayaText(g, clients.find(c => c.id === g.clientId))).filter(Boolean).join("\n\n"))}>📋 Скопировать все накладные ({allDayGroups.filter(g => g.orders.some(o => !o.trial && !o.isSample)).length})</Btn>
          </div>
        )}

        {karagandaDayGroups.length > 0 && (
          <div className="mt-5">
            <h4 className="font-semibold text-gray-700 mb-2">🏬 Из Караганды (напрямую клиентам)</h4>
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
                          <span className="bg-amber-100 text-amber-900 font-bold px-2 py-0.5 rounded-md whitespace-nowrap">📦 {m.bags} меш. × {m.bag_kg} кг</span>
                          <span>= <b>{fmt(m.bags * m.bag_kg)} кг</b></span>
                          {showPrices && m.tg ? <span className="text-gray-400">· {fmt(m.tg)} тг</span> : null}
                        </div>
                      ))}
                    </div>
                    <div className="text-xs text-gray-400 mt-1.5 flex items-center gap-2 flex-wrap">
                      {g.orders.some(o => !o.trial && !o.isSample) && <button onClick={() => copyToClipboard(nakladnayaText(g, client))} className="bg-violet-50 text-violet-700 px-2 py-0.5 rounded-full">📋 Для накладной</button>}
                      <span className="text-orange-600">🏬 фура из Караганды</span>
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
                  <button onClick={() => copyToClipboard(all.url)} className="bg-white border border-blue-200 text-blue-700 text-sm font-medium px-3 py-2 rounded-xl">📋 Ссылка</button>
                </div>
              </div>
              <div className="space-y-1">
                {[{ name: "📦 Best Mill (склад)", delivery_time: "" }, ...all.optimized].map((p, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold flex-shrink-0">{i}</span>
                    <span className="text-gray-700">{p.name}</span>
                    {p.delivery_time && <span className="text-xs text-blue-600 ml-auto">⏰ {p.delivery_time}</span>}
                  </div>
                ))}
              </div>
              <div className="text-xs text-gray-400 mt-2">«📋 Ссылка» — скопировать маршрут в 2ГИС и отправить водителю (в т.ч. разовому, не заводя в систему).</div>
            </div>

            {driverBlocks.length > 1 && driverBlocks.map(b => (
              <div key={b.did || "none"} className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm">
                <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                  <div className="font-bold text-gray-800">🚛 {b.name} <span className="text-xs font-normal text-gray-500">· {b.route.optimized.length} точек · ~{Math.round(b.route.dist)} км</span></div>
                  <div className="flex gap-2">
                    <a href={b.route.url} target="_blank" rel="noreferrer" className="bg-blue-50 text-blue-700 text-xs font-medium px-3 py-1.5 rounded-lg">Открыть →</a>
                    <button onClick={() => copyToClipboard(b.route.url)} className="bg-gray-100 text-gray-700 text-xs font-medium px-3 py-1.5 rounded-lg">📋 Ссылка</button>
                  </div>
                </div>
                <div className="text-xs text-gray-600 space-y-0.5">
                  {b.route.optimized.map((p, i) => <div key={i}>{i + 1}. {p.name}{p.delivery_time ? ` · ⏰ ${p.delivery_time}` : ""}</div>)}
                </div>
              </div>
            ))}
          </div>
        );
      })()}

      {photoView && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.85)" }} onClick={() => setPhotoView(null)}>
          <img src={photoView} className="max-w-full max-h-full rounded-lg" alt="фото" />
          <button className="absolute top-4 right-4 text-white text-3xl" onClick={() => setPhotoView(null)}>&times;</button>
        </div>
      )}
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
  const assignDriverGroup = async (g, driverId) => { try { for (const o of g.orders) await dbUpsert("orders", { ...o, driverId }); await reload("orders"); } catch (e) { notifyErr(e); } };
  const deleteGroup = async g => { if (!confirm(`Удалить всю заявку «${g.clientName}» (${g.orders.length} поз.)?`)) return; try { for (const o of g.orders) await dbDelete("orders", o.id); await reload("orders"); } catch (e) { notifyErr(e); } };
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
  const rescheduleGroup = async (g, date) => { if (!date) return; try { for (const o of g.orders) await dbUpsert("orders", { ...o, date }); await reload("orders"); } catch (e) { notifyErr(e); } };

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
        <div className="flex items-center gap-2 mb-2"><span className="text-xl">🤖</span><h3 className="font-bold text-gray-800">Принять заявку из WhatsApp</h3></div>
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
              <div className="flex items-center gap-2"><span className="font-semibold">{p.clientFound}</span>{!p.clientId && <Badge color="red">Не в базе</Badge>}{p.trial && <Badge color="yellow">🎁 на пробу</Badge>}</div>
              <div className="text-gray-600">{p.brand} · {p.grade} · {p.bag_kg}кг × {p.bags} = {fmt(p.bags * p.bag_kg)} кг</div>
              <div className="text-gray-600">Дата: {p.date} · {p.trial ? <span className="text-orange-600 font-medium">🎁 бесплатно (на пробу)</span> : <>Цена: {p.price_per_kg ? fmt(p.price_per_kg) + " тг/кг" : <span className="text-red-500">не найдена</span>}</>}</div>
            </div>
          ))}
          <div className="flex gap-2">
            <Btn onClick={confirmAI} disabled={saving}>{saving ? "Сохраняю..." : "Добавить все"}</Btn>
            <Btn variant="secondary" onClick={() => setAiResult(null)}>Отмена</Btn>
          </div>
        </div>
      )}

      {showManual && (
        <Modal title={form.isSample ? "🧪 Пробник" : form.trial ? "🎁 На пробу клиенту" : "Новая заявка"} onClose={() => setShowManual(false)}>
          {!form.isSample && (
            <label className="flex items-center gap-2 mb-2 cursor-pointer bg-orange-50 rounded-lg px-3 py-2">
              <input type="checkbox" checked={form.trial} onChange={e => setForm({ ...form, trial: e.target.checked })} className="w-4 h-4 accent-orange-500" />
              <span className="text-sm font-medium text-gray-700">🎁 На пробу — клиенту из базы (бесплатно, маршрут строится, без накладной)</span>
            </label>
          )}
          {!form.trial && (
            <label className="flex items-center gap-2 mb-3 cursor-pointer bg-amber-50 rounded-lg px-3 py-2">
              <input type="checkbox" checked={form.isSample} onChange={e => setForm({ ...form, isSample: e.target.checked, trial: false })} className="w-4 h-4 accent-amber-500" />
              <span className="text-sm font-medium text-gray-700">🧪 Проба новой компании — нет в базе (бесплатно, без маршрута)</span>
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
        {filtered.length > 0 && <div className="ml-auto flex gap-4 text-sm text-gray-600"><span>📦 {fmt(totalKg)} кг</span><span>💰 {fmt(totalSum)} тг</span></div>}
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
                    <div className="flex items-center gap-2 flex-wrap"><span className="font-bold text-gray-900">{g.clientName || "Клиент"}</span><Badge color={sc[gStatus] || "gray"}>{gStatus}</Badge>{g.isSample && <Badge color="yellow">🧪 Проба</Badge>}{g.isTrial && <Badge color="yellow">🎁 на пробу</Badge>}</div>
                    <div className="text-sm text-gray-500 mt-1 space-y-0.5">
                      {g.orders.map(o => <div key={o.id} className="flex items-center gap-2 flex-wrap"><span>• {o.brand} · {o.grade}</span><span className="bg-amber-100 text-amber-900 font-bold px-2 py-0.5 rounded-md whitespace-nowrap">📦 {o.bags} меш. × {o.bag_kg} кг</span><span>= <b>{fmt(o.bags * o.bag_kg)} кг</b>{o.trial ? " · 🎁 на пробу" : (o.price_per_kg ? ` · ${fmt(o.bags * o.bag_kg * o.price_per_kg)} тг` : "")}</span></div>)}
                    </div>
                    {g.orders.length > 1 && <div className="text-sm text-gray-500 mt-1">Итого: <b>{fmt(gKg)} кг</b>{gSum ? ` · ${fmt(gSum)} тг` : ""}</div>}
                    <div className="text-xs text-gray-400 mt-1">📅 {g.orders[0].date}{driver ? ` · 🚛 ${driver.name}` : ""}{g.orders[0].created_by_name ? ` · ✍️ ${g.orders[0].created_by_name}` : ""}</div>
                  </div>
                  <div className="flex gap-1 flex-wrap items-center">
                    {allNew && <><Btn size="sm" variant="secondary" onClick={() => setGroupStatus(g, "в пути")}>В путь</Btn><select className="border border-gray-200 rounded-lg px-2 py-1 text-xs" value={g.orders[0].driverId || ""} onChange={e => assignDriverGroup(g, e.target.value)}><option value="">Водитель</option>{drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></>}
                    {allRoute && <Btn size="sm" onClick={() => setGroupStatus(g, "отгружена")}>✓ Доставлено</Btn>}
                    <Btn size="sm" variant="danger" onClick={() => deleteGroup(g)}>✕</Btn>
                  </div>
                </div>
                <div className="flex items-center gap-2 mt-2 pt-2 border-t border-gray-50 text-xs text-gray-500">
                  <span>📅 Перенести:</span>
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

function StockTab({ stock, orders = [], reload, canEdit = true }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);
  const [saving, setSaving] = useState(false);
  const blank = { date: TODAY(), brand: BRANDS[0], grade: GRADES[0], bag_kg: 50, bags: "", price_per_kg: "", note: "", op: "in", reason: WRITEOFF_REASONS[0] };
  const [form, setForm] = useState(blank);
  const [audit, setAudit] = useState(null); // сверка по позиции: {brand, grade, bag_kg}
  const [dupCheck, setDupCheck] = useState(false); // отчёт «дубли списаний»

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
    return out.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
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
                            <span className={`text-right text-xs ${short || negative ? "text-red-700 font-semibold" : "text-gray-500"}`}>{negative ? "⛔ минус — внеси приход" : need > 0 ? (short ? `${need} меш. · не хватает ${need - avail}` : `${need} меш. · своб. ${avail - need}`) : "—"}</span>
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
          <div className="text-xs text-gray-500 mb-3">Сверяю: по каждой связке «клиент + позиция» списано со склада должно быть ровно столько, сколько отгружено по заявкам. <b>Лишнее = дубли</b> — их можно удалить прямо здесь. Учти: если отгруженную заявку потом удалили, её списание остаётся — это не дубль.</div>
          {dupReport.length === 0 ? (
            <div className="bg-emerald-50 text-emerald-700 rounded-xl p-4 text-center font-bold">✓ Всё сходится — лишних списаний не найдено</div>
          ) : dupReport.map((g, gi) => {
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
        </Modal>
      )}

      {audit && (() => {
        const rows = stock
          .filter(s => s.brand === audit.brand && s.grade === audit.grade && String(s.bag_kg) === String(audit.bag_kg))
          .sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.id || "").replace(/^mv_/, "").localeCompare((b.id || "").replace(/^mv_/, "")));
        let run = 0;
        const lines = rows.map(s => { run += s.weight_kg || 0; return { ...s, run }; });
        return (
          <Modal title={`🔍 Сверка: ${audit.brand} ${audit.grade} ${audit.bag_kg}кг`} onClose={() => setAudit(null)}>
            <div className="text-xs text-gray-500 mb-2">Все движения по позиции от первого до последнего. «Остаток» — сколько стало после операции. Если ждёшь приход, а его тут нет — он записан на другой сорт/фасовку (посмотри сверку соседней строки).</div>
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
        <h4 className="font-semibold text-gray-700 mb-3">История движений</h4>
        <div className="space-y-2">
          {[...stock].sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.id || "").replace(/^mv_/, "").localeCompare((a.id || "").replace(/^mv_/, ""))).slice(0, 30).map(s => (
            <div key={s.id} className="flex items-center justify-between bg-white border border-gray-100 rounded-xl px-4 py-3 text-sm">
              <div className="min-w-0">
                <span className={s.weight_kg > 0 ? "text-emerald-600 font-medium" : "text-red-500 font-medium"}>{s.weight_kg > 0 ? "▲ Приход" : "▼ Расход"}</span>
                <span className="text-gray-600 ml-2">{s.brand} {s.grade} {s.bag_kg}кг</span>
                {s.reason && <span className="text-red-400 ml-2">· {s.reason}</span>}
                {s.note && <span className="text-gray-400 ml-2">· {s.note}</span>}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <div className="text-right"><div className="font-medium">{s.weight_kg > 0 ? "+" : ""}{fmt(s.weight_kg)} кг</div><div className="text-gray-400 text-xs">{s.date}</div></div>
                {canEdit && <button onClick={() => openEdit(s)} className="text-gray-400 hover:text-gray-700" title="Изменить">✏️</button>}
                {canEdit && <button onClick={() => deleteMovement(s.id)} className="text-red-400 hover:text-red-600" title="Удалить">✕</button>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ClientsTab({ clients, orders = [], reload, canEdit = true }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolveErr, setResolveErr] = useState("");
  const [historyClient, setHistoryClient] = useState(null);
  const [histPeriod, setHistPeriod] = useState("all");
  const [histFrom, setHistFrom] = useState(TODAY());
  const [histTo, setHistTo] = useState(TODAY());
  const [search, setSearch] = useState("");
  const [staleOnly, setStaleOnly] = useState(false);
  const [form, setForm] = useState({ name: "", address: "", contact: "", prices: [] });
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
  const clientDebt = c => orders.filter(o => o.clientId === c.id && o.status === "отгружена" && !o.paid).reduce((s, o) => s + o.bags * o.bag_kg * (o.price_per_kg || 0), 0);
  // Отметить поставку (все позиции за дату) оплаченной — с указанием способа (нал/безнал)
  const markPaid = async (clientId, date, paid, method = "") => {
    try {
      for (const o of orders.filter(o => o.clientId === clientId && o.date === date)) await dbUpsert("orders", { ...o, paid, pay_method: paid ? method : "" });
      await reload("orders");
    } catch (e) { alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз."); }
  };

  const openEdit = c => { setEditId(c.id); setResolveErr(""); setClientText(""); setClientParseErr(""); setForm({ name: c.name, org_name: c.org_name || "", contact_name: c.contact_name || "", address: c.address, contact: c.contact || "", bin: c.bin || "", director: c.director || "", basis: c.basis || "", legal_address: c.legal_address || "", email: c.email || "", bank: c.bank || "", iik: c.iik || "", bik: c.bik || "", default_bag_kg: c.default_bag_kg || "", default_brand: c.default_brand || "", gis_link: c.gis_link || "", coords: c.coords || null, coords_manual: c.coords_manual || "", delivery_time: c.delivery_time || "", delivery_from: c.delivery_from || "", delivery_to: c.delivery_to || "", prices: c.prices || [] }); setShowAdd(true); };
  const openNew = () => { setEditId(null); setResolveErr(""); setClientText(""); setClientParseErr(""); setForm({ name: "", org_name: "", contact_name: "", address: "", contact: "", bin: "", director: "", basis: "", legal_address: "", email: "", bank: "", iik: "", bik: "", default_bag_kg: "", default_brand: "", gis_link: "", coords: null, coords_manual: "", delivery_time: "", delivery_from: "", delivery_to: "", prices: [] }); setShowAdd(true); };

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
    try { await dbUpsert("clients", { id: editId || uid(), ...form }); setShowAdd(false); await reload("clients"); } catch (e) { alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз."); }
    setSaving(false);
  };
  const deleteClient = async id => { await dbDelete("clients", id); await reload("clients"); };

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
      <div className="flex items-center justify-between"><h3 className="font-bold text-gray-800">Клиенты ({clients.length})</h3>{canEdit && <Btn onClick={openNew}>+ Новый клиент</Btn>}</div>
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
              <div className="text-sm font-medium text-gray-700 mb-1">📋 Вставь все данные — разберу по полям</div>
              <textarea value={clientText} onChange={e => setClientText(e.target.value)} rows={3} placeholder="напр.: ИП Салават, БИН 880101300123, тел +7 701 234 5678, адрес Астана, ул. Абая 10, Kaspi Bank, ИИК KZ12..., БИК CASPKZKA" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-amber-300" />
              {clientParseErr && <div className="text-xs text-red-500 mt-1">{clientParseErr}</div>}
              <button onClick={handleParseClient} disabled={parsingClient || !clientText.trim()} className="mt-2 w-full bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded-lg font-medium px-4 py-2 text-sm">{parsingClient ? "Разбираю..." : "✨ Разобрать и заполнить"}</button>
            </div>
            <Inp label="Название заведения" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Мамыр" />
            <Inp label="Организация (ИП / ТОО)" value={form.org_name} onChange={e => setForm({ ...form, org_name: e.target.value })} placeholder="ИП Салават" />
            <Inp label="Имя контакта (кто пишет)" value={form.contact_name} onChange={e => setForm({ ...form, contact_name: e.target.value })} placeholder="Азиз" />
            <Inp label="Адрес доставки" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} />
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
              <Inp label="Ссылка 2ГИС на адрес" value={form.gis_link} onChange={e => setForm({ ...form, gis_link: e.target.value, coords: null })} placeholder="https://2gis.kz/astana/geo/..." />
              <div className="flex items-center gap-2 mt-2">
                <Btn size="sm" variant="secondary" onClick={handleResolve} disabled={resolving || !form.gis_link}>{resolving ? "Определяю..." : "📍 Определить координаты"}</Btn>
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
        {shown.map(c => {
          const debt = clientDebt(c);
          const last = lastByClient[c.id];
          const days = daysSince(last);
          const stale = days !== null && days >= STALE_DAYS;
          return (
          <div key={c.id} className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm">
            <div className="flex items-start justify-between">
              <div>
                <div className="font-bold text-gray-900">{c.name}{debt > 0 && <span className="ml-2 text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full align-middle">долг {fmt(debt)} тг</span>}{stale && <span className="ml-2 text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full align-middle">⏳ давно</span>}</div>
                {c.org_name && <div className="text-sm text-gray-500">🏢 {c.org_name}</div>}
                {c.contact_name && <div className="text-sm text-gray-500">👤 {c.contact_name}</div>}
                {c.address && <div className="text-sm text-gray-500">📍 {c.address}</div>}
                {c.contact && <div className="text-sm text-gray-500">📱 {c.contact}</div>}
                <div className="text-xs text-gray-500 mt-1">🕒 {last ? `последний заказ ${last.split("-").reverse().join(".")}${days > 0 ? ` (${days} дн. назад)` : " (сегодня)"}` : "ещё не заказывал"}</div>
                {(c.default_bag_kg || c.default_brand) && <div className="text-xs text-amber-700 bg-amber-50 rounded-lg px-2 py-1 mt-1 inline-block">📦 {c.default_brand || "—"} · {c.default_bag_kg ? c.default_bag_kg + " кг мешки" : "фасовка не указана"}</div>}
                {(c.prices || []).length > 0 && <div className="flex flex-wrap gap-1 mt-2">{c.prices.map((p, i) => <span key={i} className="bg-amber-50 text-amber-800 text-xs px-2 py-0.5 rounded-full">{p.brand} {p.grade} {p.bag_kg}кг — {fmt(p.price_per_kg)}тг</span>)}</div>}
              </div>
              {canEdit && <div className="flex gap-1"><Btn size="sm" variant="secondary" onClick={() => openEdit(c)}>✏️</Btn><Btn size="sm" variant="danger" onClick={() => deleteClient(c.id)}>✕</Btn></div>}
            </div>
            <Btn size="sm" variant="secondary" onClick={() => setHistoryClient(c)}>📋 История и оплаты</Btn>
          </div>
          );
        })}
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
        const debtAll = orders.filter(o => o.clientId === historyClient.id && o.status === "отгружена" && !o.paid).reduce((s, o) => s + o.bags * o.bag_kg * (o.price_per_kg || 0), 0);
        const periods = [["day", "День"], ["week", "Неделя"], ["month", "Месяц"], ["3month", "3 мес"], ["all", "Всё"], ["custom", "Свой"]];
        return (
          <Modal title={`📋 ${historyClient.name}`} onClose={() => setHistoryClient(null)}>
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
              <div className={debtAll > 0 ? "text-red-600 font-bold" : "text-gray-500"}>Текущий долг (всего): {fmt(debtAll)} тг</div>
            </div>
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {Object.entries(byDate).map(([date, list]) => {
                const sum = list.reduce((s, o) => s + o.bags * o.bag_kg * (o.price_per_kg || 0), 0);
                const kg = list.reduce((s, o) => s + o.bags * o.bag_kg, 0);
                const allPaid = list.every(o => o.paid);
                const method = list.find(o => o.pay_method)?.pay_method;
                return (
                  <div key={date} className={`border rounded-xl p-3 text-sm ${allPaid ? "border-emerald-200 bg-emerald-50" : "border-gray-100"}`}>
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{date.split("-").reverse().join(".")}</span>
                      <span className="text-gray-500">{fmt(kg)} кг · {fmt(sum)} тг</span>
                    </div>
                    {list.map(o => <div key={o.id} className="text-gray-500 text-xs mt-0.5">• {o.brand} {o.grade} {o.bag_kg}кг × {o.bags} — {o.status}</div>)}
                    <div className="mt-2">
                      {allPaid
                        ? <div className="flex items-center gap-2 flex-wrap"><span className="text-emerald-700 font-medium text-xs">✓ Оплачено{method ? ` · ${method}` : ""}</span>{canEdit && <Btn size="sm" variant="ghost" onClick={() => markPaid(historyClient.id, date, false)}>отменить</Btn>}</div>
                        : (canEdit
                          ? <div className="flex gap-2 flex-wrap"><Btn size="sm" onClick={() => markPaid(historyClient.id, date, true, "Нал")}>💵 Нал</Btn><Btn size="sm" variant="secondary" onClick={() => markPaid(historyClient.id, date, true, "Безнал")}>💳 Безнал</Btn></div>
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

function DriversTab({ drivers, orders, expenses = [], users = [], reload, canEdit = true }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", rate_per_kg: "", load_rate_per_kg: "" });
  const [payDriver, setPayDriver] = useState(null);
  const [payAmount, setPayAmount] = useState("");
  const [payDate, setPayDate] = useState(TODAY());
  const [payExtra, setPayExtra] = useState(false);
  const [detailDriver, setDetailDriver] = useState(null);

  const openNew = () => { setEditId(null); setForm({ name: "", rate_per_kg: "", load_rate_per_kg: "" }); setShowAdd(true); };
  const openEdit = d => { setEditId(d.id); setForm({ name: d.name, rate_per_kg: d.rate_per_kg ?? "", load_rate_per_kg: d.load_rate_per_kg ?? "" }); setShowAdd(true); };
  const saveDriver = async () => {
    setSaving(true);
    try { await dbUpsert("drivers", { id: editId || uid(), name: form.name, rate_per_kg: Number(form.rate_per_kg) || 0, load_rate_per_kg: Number(form.load_rate_per_kg) || 0 }); setShowAdd(false); setEditId(null); setForm({ name: "", rate_per_kg: "", load_rate_per_kg: "" }); await reload("drivers"); } catch (e) { alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз."); }
    setSaving(false);
  };
  const deleteDriver = async id => {
    const linked = (users || []).filter(u => u.driverId === id);
    if (!confirm(`Удалить рабочего${linked.length ? " и его логин? Он больше не сможет войти и его выкинет из приложения." : "?"}`)) return;
    try {
      await dbDelete("drivers", id);
      for (const u of linked) await dbDelete("users", u.id); // закрываем вход
      await reload("drivers"); if (linked.length) await reload("users");
    } catch (e) { alert("⚠️ Не удалилось: " + (e && e.message ? e.message : e)); }
  };

  // Заработок: развоз (доставка × ставка водителя) и отгрузка (самовывоз × ставка грузчика)
  const earnings = {}, loadEarn = {};
  orders.filter(o => o.status === "отгружена").forEach(o => {
    if (o.driverId && !o.pickup) { const d = drivers.find(x => x.id === o.driverId); if (d) earnings[o.driverId] = (earnings[o.driverId] || 0) + o.bags * o.bag_kg * (d.rate_per_kg || 0); }
    if (o.pickup && o.loaderId) { const d = drivers.find(x => x.id === o.loaderId); if (d) loadEarn[o.loaderId] = (loadEarn[o.loaderId] || 0) + o.bags * o.bag_kg * (d.load_rate_per_kg || 0); }
  });
  const totalEarned = id => (earnings[id] || 0) + (loadEarn[id] || 0);
  // Выплаты: зарплата (уменьшает долг) и доплаты за доп. работу (НЕ уменьшают долг)
  const wagePaid = {}, extraPaid = {};
  expenses.filter(x => x.driverId).forEach(x => { const m = x.extra ? extraPaid : wagePaid; m[x.driverId] = (m[x.driverId] || 0) + (x.amount || 0); });
  const remainingOf = id => Math.max(0, Math.round(totalEarned(id) - (wagePaid[id] || 0)));

  const openPay = (d, extra = false) => { setPayDriver(d); setPayExtra(extra); setPayAmount(extra ? "" : String(remainingOf(d.id))); setPayDate(TODAY()); };
  const doPay = async () => {
    if (!payAmount) return;
    setSaving(true);
    try { await dbUpsert("expenses", { id: uid(), date: payDate, category: "Водители", driverId: payDriver.id, amount: Number(payAmount), extra: payExtra, note: `${payExtra ? "Доплата (доп. работа)" : "Зарплата (развоз+отгрузка)"} — ${payDriver.name}` }); setPayDriver(null); await reload("expenses"); }
    catch (e) { alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз."); }
    setSaving(false);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between"><h3 className="font-bold text-gray-800">Рабочие</h3>{canEdit && <Btn onClick={openNew}>+ Рабочий</Btn>}</div>
      <p className="text-sm text-gray-500">Один рабочий может и возить, и грузить. Ставка за развоз — за доставку клиенту (водитель). Ставка за отгрузку — за погрузку в машину клиента при самовывозе (грузчик).</p>
      {showAdd && (<Modal title={editId ? "Изменить рабочего" : "Новый рабочий"} onClose={() => setShowAdd(false)}>
        <div className="space-y-3">
          <Inp label="Имя" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          <Inp label="🚚 Ставка за развоз (водитель), тг/кг" type="number" value={form.rate_per_kg} onChange={e => setForm({ ...form, rate_per_kg: e.target.value })} placeholder="напр. 3" />
          <Inp label="📦 Ставка за отгрузку (грузчик), тг/кг" type="number" value={form.load_rate_per_kg} onChange={e => setForm({ ...form, load_rate_per_kg: e.target.value })} placeholder="напр. 2" />
        </div>
        <div className="flex gap-2 mt-4"><Btn onClick={saveDriver} disabled={saving}>{saving ? "Сохраняю..." : "Сохранить"}</Btn><Btn variant="secondary" onClick={() => setShowAdd(false)}>Отмена</Btn></div>
      </Modal>)}
      {payDriver && (<Modal title={`Выплата: ${payDriver.name}`} onClose={() => setPayDriver(null)}>
        <div className="space-y-3">
          <div className="flex gap-2">
            <button onClick={() => { setPayExtra(false); setPayAmount(String(remainingOf(payDriver.id))); }} className={`flex-1 py-2 rounded-lg text-sm font-medium ${!payExtra ? "bg-amber-500 text-white" : "bg-gray-100 text-gray-600"}`}>Зарплата</button>
            <button onClick={() => { setPayExtra(true); setPayAmount(""); }} className={`flex-1 py-2 rounded-lg text-sm font-medium ${payExtra ? "bg-amber-500 text-white" : "bg-gray-100 text-gray-600"}`}>Доплата (доп. работа)</button>
          </div>
          {payExtra
            ? <div className="text-xs text-amber-700 bg-amber-50 rounded-lg p-2">Доплата НЕ уменьшает остаток по зарплате — это оплата за дополнительную работу.</div>
            : <div className="text-sm bg-gray-50 rounded-xl p-3">Заработал (развоз {fmt(earnings[payDriver.id] || 0)} + отгрузка {fmt(loadEarn[payDriver.id] || 0)}): <b>{fmt(totalEarned(payDriver.id))} тг</b> · выплачено: {fmt(wagePaid[payDriver.id] || 0)} тг · осталось: <b className="text-red-600">{fmt(remainingOf(payDriver.id))} тг</b></div>}
          <Inp label="Дата" type="date" value={payDate} onChange={e => setPayDate(e.target.value)} />
          <Inp label="Сумма выплаты, тг" type="number" value={payAmount} onChange={e => setPayAmount(e.target.value)} />
        </div>
        <div className="flex gap-2 mt-4"><Btn onClick={doPay} disabled={saving || !payAmount}>{saving ? "Сохраняю..." : "💵 Выплатить"}</Btn><Btn variant="secondary" onClick={() => setPayDriver(null)}>Отмена</Btn></div>
      </Modal>)}
      {detailDriver && (() => {
        const d = detailDriver;
        const byDate = {};
        orders.filter(o => o.status === "отгружена" && ((o.driverId === d.id && !o.pickup) || (o.pickup && o.loaderId === d.id))).forEach(o => {
          const rec = byDate[o.date] = byDate[o.date] || { delivKg: 0, loadKg: 0 };
          if (o.pickup) rec.loadKg += o.bags * o.bag_kg; else rec.delivKg += o.bags * o.bag_kg;
        });
        const days = Object.entries(byDate).map(([date, v]) => ({ date, ...v, owed: Math.round(v.delivKg * (d.rate_per_kg || 0) + v.loadKg * (d.load_rate_per_kg || 0)) })).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
        const pays = expenses.filter(x => x.driverId === d.id).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
        return (<Modal title={`🚛 ${d.name} — детали`} onClose={() => setDetailDriver(null)}>
          <div className="space-y-4">
            <div>
              <div className="font-semibold text-gray-700 mb-1">По дням (развоз + отгрузка)</div>
              {days.length === 0 ? <div className="text-gray-400 text-sm">Работы ещё не было</div> : (
                <div className="space-y-1 max-h-60 overflow-y-auto">
                  {days.map(x => <div key={x.date} className="flex items-center justify-between text-sm bg-gray-50 rounded-lg px-3 py-2"><span>{x.date.split("-").reverse().join(".")}{x.delivKg ? ` · 🚚 ${fmt(x.delivKg)}` : ""}{x.loadKg ? ` · 📦 ${fmt(x.loadKg)}` : ""} кг</span><span className="font-medium">должны {fmt(x.owed)} тг</span></div>)}
                </div>
              )}
            </div>
            <div>
              <div className="font-semibold text-gray-700 mb-1">Выплаты</div>
              {pays.length === 0 ? <div className="text-gray-400 text-sm">Выплат ещё не было</div> : (
                <div className="space-y-1 max-h-60 overflow-y-auto">
                  {pays.map(x => <div key={x.id} className="flex items-center justify-between text-sm border border-gray-100 rounded-lg px-3 py-2"><span className="text-gray-500">{(x.date || "").split("-").reverse().join(".")}{x.extra ? <span className="text-amber-700"> · доплата</span> : <span className="text-emerald-600"> · зарплата</span>}</span><span className="font-medium">{fmt(x.amount)} тг</span></div>)}
                </div>
              )}
            </div>
          </div>
        </Modal>);
      })()}
      <div className="space-y-3">
        {drivers.length === 0 && <div className="text-center py-12 text-gray-400">Рабочих нет.</div>}
        {drivers.map(d => {
          const delivKg = orders.filter(o => o.driverId === d.id && !o.pickup && o.status === "отгружена").reduce((s, o) => s + o.bags * o.bag_kg, 0);
          const loadKg = orders.filter(o => o.pickup && o.loaderId === d.id && o.status === "отгружена").reduce((s, o) => s + o.bags * o.bag_kg, 0);
          const eDeliv = earnings[d.id] || 0, eLoad = loadEarn[d.id] || 0;
          const wage = wagePaid[d.id] || 0;
          const extra = extraPaid[d.id] || 0;
          const left = remainingOf(d.id);
          return (
            <div key={d.id} className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm">
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-bold text-gray-900">🚛 {d.name}</div>
                  <div className="text-sm text-gray-500">🚚 развоз {fmt(d.rate_per_kg)} тг/кг · 📦 отгрузка {fmt(d.load_rate_per_kg || 0)} тг/кг</div>
                  <div className="text-sm mt-1">Развоз: <b>{fmt(eDeliv)} тг</b> <span className="text-gray-400">({fmt(delivKg)} кг)</span> · Отгрузка: <b>{fmt(eLoad)} тг</b> <span className="text-gray-400">({fmt(loadKg)} кг)</span></div>
                  <div className="text-sm">Всего заработал: <b>{fmt(eDeliv + eLoad)} тг</b> · выплачено: <span className="text-emerald-600">{fmt(wage)} тг</span></div>
                  <div className={`text-sm font-bold ${left > 0 ? "text-red-600" : "text-gray-500"}`}>Осталось выплатить: {fmt(left)} тг</div>
                  {extra > 0 && <div className="text-xs text-amber-700 mt-0.5">Доплаты (доп. работа): {fmt(extra)} тг</div>}
                </div>
                {canEdit && <div className="flex gap-1"><Btn size="sm" variant="secondary" onClick={() => openEdit(d)}>✏️</Btn><Btn size="sm" variant="danger" onClick={() => deleteDriver(d.id)}>✕</Btn></div>}
              </div>
              <div className="flex gap-2 mt-3 flex-wrap">
                {canEdit && <Btn size="sm" onClick={() => openPay(d, false)}>💵 Выплатить зарплату</Btn>}
                {canEdit && <Btn size="sm" variant="secondary" onClick={() => openPay(d, true)}>+ Доплата</Btn>}
                <Btn size="sm" variant="secondary" onClick={() => setDetailDriver(d)}>📋 Детали</Btn>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ReportsTab({ orders, drivers, stock = [], expenses = [], reload = () => {}, canEdit = true }) {
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
  const debtList = Object.entries(debtByClient).sort((a, b) => b[1] - a[1]);
  const totalDebt = debtList.reduce((s, [, v]) => s + v, 0);
  // Поступления (оплаченные заявки) — всего и по способу нал/безнал
  const paidOrders = orders.filter(o => o.paid && o.bags * o.bag_kg * (o.price_per_kg || 0) > 0);
  const paidTotal = paidOrders.reduce((s, o) => s + o.bags * o.bag_kg * (o.price_per_kg || 0), 0);
  const paidByMethod = {};
  paidOrders.forEach(o => { const m = o.pay_method || "Не указано"; paidByMethod[m] = (paidByMethod[m] || 0) + o.bags * o.bag_kg * (o.price_per_kg || 0); });
  // Расходы за период
  const expInPeriod = expenses.filter(filterFn);
  const expByCat = {};
  expInPeriod.forEach(x => { expByCat[x.category] = (expByCat[x.category] || 0) + (x.amount || 0); });

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
  if (trialCost > 0) expByCat["🎁 На пробу"] = (expByCat["🎁 На пробу"] || 0) + trialCost;
  // Общие расходы = ручные расходы + оценка стоимости проб
  const expTotal = expInPeriod.reduce((s, x) => s + (x.amount || 0), 0) + trialCost;

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

  return (
    <div className="space-y-5">
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
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-gradient-to-br from-emerald-50 to-green-100 rounded-2xl p-4"><div className="text-xs text-emerald-700 font-medium">Отгружено</div><div className="text-2xl font-bold text-emerald-800">{fmt(totalKg)} кг</div></div>
        <div className="bg-gradient-to-br from-amber-50 to-orange-100 rounded-2xl p-4"><div className="text-xs text-amber-700 font-medium">Сумма отгрузок</div><div className="text-2xl font-bold text-amber-800">{fmt(totalRev)} тг</div></div>
        <div className="bg-gradient-to-br from-blue-50 to-blue-100 rounded-2xl p-4"><div className="text-xs text-blue-700 font-medium">Заявок</div><div className="text-2xl font-bold text-blue-800">{ordersCount}</div></div>
        <div className="bg-gradient-to-br from-purple-50 to-purple-100 rounded-2xl p-4"><div className="text-xs text-purple-700 font-medium">Водителям</div><div className="text-2xl font-bold text-purple-800">{fmt(totalPay)} тг</div></div>
      </div>

      {pl.length > 0 && totalKg > 0 && (
        <div className="bg-gradient-to-br from-indigo-50 to-blue-50 border border-indigo-100 rounded-2xl p-4">
          <div className="font-bold text-gray-800 mb-2">🎯 Приоритеты закупа за период</div>
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

      {totalKg > 0 && Object.keys(brandTree).length > 0 && (
        <div className="bg-white border border-gray-100 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-1">
            <div className="font-bold text-gray-800">📊 По брендам, сортам и фасовкам</div>
            <button onClick={downloadGradeDetail} className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg px-3 py-1.5 font-medium">⬇️ Excel</button>
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
              <div className="bg-blue-50 rounded-xl p-3"><div className="text-xs text-blue-700">💰 Средняя цена продаж</div><div className="text-lg font-bold text-blue-800">{fmt(Math.round(repAvgPrice))} тг/кг</div>{repMinPrice !== repMaxPrice && <div className="text-xs text-gray-500">от {fmt(repMinPrice)} до {fmt(repMaxPrice)} тг/кг</div>}</div>
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
            <div className="font-bold text-gray-800">🗑 Брак и списания за период</div>
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
            <div className="font-bold text-gray-800">🎁 На пробу (бесплатно) за период</div>
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
            <div className="font-bold text-gray-800">🏬 Из Караганды (напрямую клиентам)</div>
            <div className="text-right"><div className="text-lg font-bold text-orange-600">{fmt(karagandaKg)} кг</div>{karagandaSum > 0 && <div className="text-xs text-gray-500">{fmt(karagandaSum)} тг</div>}</div>
          </div>
          <div className="text-xs text-gray-500 mt-2">Входит в объём и деньги, но склад Астаны не трогает и в закуп не считается.</div>
        </div>
      )}

      {paidTotal > 0 && (
        <div className="bg-gradient-to-br from-emerald-50 to-green-50 border border-emerald-100 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="font-bold text-gray-800">💵 Приход от клиентов (всего)</div>
            <div className="text-lg font-bold text-emerald-700">{fmt(paidTotal)} тг</div>
          </div>
          <div className="space-y-1 text-sm">
            {Object.entries(paidByMethod).sort((a, b) => b[1] - a[1]).map(([m, v]) => (
              <div key={m} className="flex items-center justify-between">
                <span className="text-gray-600">{m === "Нал" ? "💵 Нал" : m === "Безнал" ? "💳 Безнал" : m}</span>
                <span className="font-medium">{fmt(v)} тг</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {totalDebt > 0 && (
        <div className="bg-gradient-to-br from-rose-50 to-red-50 border border-rose-100 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="font-bold text-gray-800">💰 Долги клиентов (всего)</div>
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
            <div className="font-bold text-gray-800">💸 Расходы за период</div>
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
          <Btn size="sm" onClick={getAdvice} disabled={adviceLoading}>{adviceLoading ? "Думаю..." : "🤖 Совет на неделю"}</Btn>
          {advice && <div className="mt-2 bg-white rounded-xl p-3 text-sm text-gray-700 whitespace-pre-wrap">{cleanAdvice(advice)}</div>}
        </div>
        <div className="mt-3 pt-3 border-t border-violet-100">
          <div className="font-medium text-gray-800 mb-2">🚚 Что взять в фуру</div>
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
            : <div className="mt-2"><Btn size="sm" onClick={planTruck}>🚚 Запланировать эту фуру</Btn></div>)}
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
      {Object.keys(ds).length > 0 && <div><h4 className="font-semibold text-gray-700 mb-3">Расчёт с водителями</h4><div className="space-y-2">{Object.values(ds).map((d, i) => <div key={i} className="bg-white border border-gray-100 rounded-xl px-4 py-3 flex items-center justify-between"><div><div className="font-medium">🚛 {d.name}</div><div className="text-sm text-gray-500">{fmt(d.kg)} кг</div></div><div className="text-emerald-600 font-bold">{fmt(d.pay)} тг</div></div>)}</div></div>}
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
            <div className="text-xs text-gray-400 mt-1">Итого {fmt(kg)} кг{driver ? ` · 🚛 ${driver.name}` : ""}</div>
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

  const itemKg = i => (i.kg != null && i.kg !== "") ? Number(i.kg) : Number(i.tonnes || 0) * 1000; // старые записи были в тоннах
  const reset = () => { setF({ date: TODAY(), driver_name: "", car_number: "", whatsapp: "", logist_phone: "", price: "", note: "" }); setItems([]); setIt({ brand: BRANDS[0], grade: GRADES[0], bag_kg: 50, kg: "" }); setEditItemIdx(null); };
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
        for (const item of t.items) { const weight_kg = itemKg(item); const bags = item.bag_kg > 0 ? Math.round(weight_kg / item.bag_kg) : 0; await dbUpsert("stock", { id: uid(), date: TODAY(), brand: item.brand, grade: item.grade, bag_kg: item.bag_kg, bags, weight_kg, price_per_kg: 0, note: `Приход (фура от ${t.date})` }); }
        if (t.price) await dbUpsert("expenses", { id: uid(), date: TODAY(), category: "Фура/Поставка", amount: Number(t.price), note: `Фура от ${t.date}${t.driver_name ? `, ${t.driver_name}` : ""}` });
        await dbUpsert("trucks", { ...t, status: "принята", accepted_date: TODAY() });
        await reload("stock"); await reload("expenses");
      } else {
        await dbUpsert("trucks", { ...t, status });
      }
      await reload("trucks");
    } catch (e) { alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз."); }
    setSaving(false);
  };
  const deleteTruck = async id => { if (!confirm("Удалить фуру?")) return; await dbDelete("trucks", id); await reload("trucks"); };

  const totalKg = t => (t.items || []).reduce((s, i) => s + itemKg(i), 0);
  const sorted = [...trucks].sort((a, b) => ((a.status === "принята") === (b.status === "принята") ? (b.date || "").localeCompare(a.date || "") : a.status === "принята" ? 1 : -1));
  const waLink = n => "https://wa.me/" + String(n || "").replace(/\D/g, "");

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between"><h3 className="font-bold text-gray-800">Поставки (фуры)</h3>{canEdit && <Btn onClick={openNew}>+ Запланировать фуру</Btn>}</div>
      {showAdd && (
        <Modal title={editId ? "Изменить фуру" : "Новая фура"} onClose={() => setShowAdd(false)}>
          <div className="space-y-3">
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
              {items.length > 0 && <div className="mt-2 space-y-1">{items.map((p, i) => <div key={i} className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm gap-2 ${editItemIdx === i ? "bg-amber-100" : "bg-gray-50"}`}><span className="min-w-0">{p.brand} · {p.grade} · {p.bag_kg}кг</span><span className="font-medium ml-auto whitespace-nowrap">{fmt(itemKg(p))} кг</span><button className="text-gray-400 hover:text-amber-600 flex-shrink-0" title="Изменить" onClick={() => editItem(i)}>✏️</button><button className="text-red-400 hover:text-red-600 flex-shrink-0" title="Удалить" onClick={() => removeItem(i)}>✕</button></div>)}</div>}
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
              <div className="font-bold text-gray-900">🚚 Фура на {t.date} <span className="text-sm font-normal text-gray-500">· {fmt(totalKg(t))} кг{t.price ? ` · ${fmt(t.price)} тг` : ""}</span></div>
              <Badge color={t.status === "принята" ? "green" : t.status === "в пути" ? "yellow" : "blue"}>{t.status}</Badge>
            </div>
            <div className="space-y-1 text-sm text-gray-600">
              {t.items.map((p, i) => <div key={i}>• {p.brand} {p.grade} {p.bag_kg}кг — {fmt(itemKg(p))} кг ({fmt(p.bag_kg > 0 ? Math.round(itemKg(p) / p.bag_kg) : 0)} мешков)</div>)}
            </div>
            {(t.driver_name || t.car_number || t.whatsapp || t.logist_phone) && (
              <div className="text-xs text-gray-500 mt-2 space-y-0.5">
                {(t.driver_name || t.car_number) && <div>👤 {t.driver_name}{t.car_number ? ` · 🚛 ${t.car_number}` : ""}</div>}
                {t.whatsapp && <div>📱 <a href={waLink(t.whatsapp)} target="_blank" rel="noreferrer" className="text-emerald-600">{t.whatsapp}</a></div>}
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
            {canEdit && (
              <div className="mt-2 flex gap-2">
                {t.status !== "принята" && <Btn size="sm" variant="secondary" onClick={() => openEdit(t)}>✏️ Изменить</Btn>}
                <Btn size="sm" variant="danger" onClick={() => deleteTruck(t.id)}>Удалить</Btn>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function UsersTab({ users, drivers, logins = [], reload, currentUser }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({ name: "", username: "", password: "", role: "accountant", driverId: "" });

  const openNew = () => { setEditId(null); setForm({ name: "", username: "", password: "", role: "accountant", driverId: "" }); setErr(""); setShowAdd(true); };
  const openEdit = u => { setEditId(u.id); setForm({ name: u.name, username: u.username, password: "", role: u.role, driverId: u.driverId || "" }); setErr(""); setShowAdd(true); };

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
        driverId: form.role === "driver" ? form.driverId : "",
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
            {form.role === "driver" && (
              <Sel label="Привязать к водителю" value={form.driverId} onChange={e => setForm({ ...form, driverId: e.target.value })} options={[{ value: "", label: "— выбери водителя —" }, ...drivers.map(d => ({ value: d.id, label: d.name }))]} />
            )}
            {form.role === "driver" && drivers.length === 0 && <p className="text-xs text-amber-600">Сначала добавь водителя во вкладке «Водители».</p>}
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
                <div className="font-medium text-gray-900">{u.name} <span className="text-xs text-gray-400">@{u.username}</span></div>
                <div className="text-sm text-gray-500">{ROLES[u.role] || u.role}{linkedDriver ? ` · 🚛 ${linkedDriver.name}` : ""}{u.id === currentUser.id ? " · это вы" : ""}</div>
                {(() => {
                  if (!u.last_seen) return <div className="text-xs text-gray-400 mt-0.5">⚪ ещё не заходил(а)</div>;
                  const mins = Math.floor((Date.now() - Date.parse(u.last_seen)) / 60000);
                  if (mins < 10) return <div className="text-xs text-emerald-600 mt-0.5">🟢 сейчас в приложении</div>;
                  const d = new Date(u.last_seen);
                  return <div className="text-xs text-gray-400 mt-0.5">🕐 был(а) в сети: {d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })} {d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</div>;
                })()}
              </div>
              <div className="flex gap-1">
                <Btn size="sm" variant="secondary" onClick={() => openEdit(u)}>✏️</Btn>
                {u.id !== currentUser.id && <Btn size="sm" variant="danger" onClick={() => deleteUser(u.id)}>✕</Btn>}
              </div>
            </div>
          );
        })}
      </div>

      <LoginLog logins={logins} />
    </div>
  );
}

// Журнал входов: кто и когда заходил в приложение (для администратора)
function LoginLog({ logins }) {
  const [open, setOpen] = useState(true);
  const sorted = [...(logins || [])].sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  const fmt = iso => {
    const d = new Date(iso);
    if (isNaN(d)) return iso || "";
    return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
  };
  return (
    <div className="pt-2">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between bg-white border border-gray-100 rounded-xl px-4 py-3">
        <span className="font-bold text-gray-800">🕐 Кто когда заходил</span>
        <span className="text-sm text-gray-400">{sorted.length} · {open ? "скрыть" : "показать"}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-1">
          {sorted.length === 0 && <p className="text-sm text-gray-400 px-1">Пока нет записей о входах.</p>}
          {sorted.slice(0, 200).map(l => (
            <div key={l.id} className="bg-white border border-gray-100 rounded-lg px-3 py-2 flex items-center justify-between text-sm">
              <div>
                <span className="mr-1" title={l.kind === "login" ? "вход по паролю" : "открыл приложение"}>{l.kind === "login" ? "🔑" : "📱"}</span>
                <span className="font-medium text-gray-900">{l.name || l.username}</span>
                <span className="text-xs text-gray-400 ml-1">· {ROLES[l.role] || l.role}</span>
              </div>
              <span className="text-gray-500">{fmt(l.at)}</span>
            </div>
          ))}
          {sorted.length > 200 && <p className="text-xs text-gray-400 px-1">Показаны последние 200 входов.</p>}
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

function ExpensesTab({ expenses, reload, openSignal = 0, canEdit = true }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);
  const [saving, setSaving] = useState(false);
  const blank = { date: TODAY(), category: EXPENSE_CATS[0], amount: "", note: "" };
  const [form, setForm] = useState(blank);
  // Открыть форму расхода по сигналу с кнопки «+»
  useEffect(() => { if (openSignal) { setEditId(null); setForm(blank); setShowAdd(true); } }, [openSignal]);

  const openNew = () => { setEditId(null); setForm(blank); setShowAdd(true); };
  const openEdit = x => { setEditId(x.id); setForm({ date: x.date, category: x.category, amount: x.amount, note: x.note || "" }); setShowAdd(true); };
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
              <div className="font-medium text-gray-900">{x.category} — {fmt(x.amount)} тг</div>
              <div className="text-xs text-gray-400">{(x.date || "").split("-").reverse().join(".")}{x.note ? ` · ${x.note}` : ""}{x.created_by_name ? ` · ✍️ ${x.created_by_name}` : ""}</div>
            </div>
            {canEdit && <div className="flex gap-1"><Btn size="sm" variant="secondary" onClick={() => openEdit(x)}>✏️</Btn><Btn size="sm" variant="danger" onClick={() => del(x.id)}>✕</Btn></div>}
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

  // Генератор PDF (pdfmake с кириллицей) подгружается один раз при первом скачивании
  const loadPdfMake = () => new Promise((resolve, reject) => {
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
  const [pdfBusy, setPdfBusy] = useState(false);
  const downloadPdf = async () => {
    setPdfBusy(true);
    try {
      const pdfMake = await loadPdfMake();
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
    } catch (e) { alert("⚠️ " + (e.message || e) + "\nПроверь интернет и попробуй ещё раз."); }
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
      <div className="bg-blue-50 border border-blue-100 rounded-2xl p-4 text-sm text-blue-800">🧾 Выбери клиента — подставятся все позиции его прайса с ценами за мешок. Проставь <b>только количество мешков</b> у нужных позиций: в накладную попадут именно они, ровно столько строк. Печать — две копии на листе.</div>
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
      <div className="bg-blue-50 border border-blue-100 rounded-2xl p-4 text-sm text-blue-800">📄 Данные Покупателя берутся из клиента или из вставленного текста. Метки <b>〔…〕</b> — впиши вручную перед печатью (номер, дата, <b>пункт 2.2</b>). Чего не нашлось — тоже отметится 〔ВПИШИТЕ〕.</div>

      <div className="flex gap-2">
        <button onClick={() => { setSource("client"); setResult(""); }} className={`flex-1 py-2 rounded-lg text-sm font-medium ${source === "client" ? "bg-amber-500 text-white" : "bg-gray-100 text-gray-600"}`}>👤 Из клиентов</button>
        <button onClick={() => { setSource("text"); setResult(""); }} className={`flex-1 py-2 rounded-lg text-sm font-medium ${source === "text" ? "bg-amber-500 text-white" : "bg-gray-100 text-gray-600"}`}>📋 Вставить текст</button>
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
          <div className="flex items-center justify-between mb-2"><div className="font-bold text-gray-800">Реквизиты {source === "text" ? "(из текста)" : "клиента"}</div><Btn size="sm" variant="secondary" onClick={() => copyToClipboard(requisites)}>📋 Копировать</Btn></div>
          <pre className="text-sm text-gray-700 whitespace-pre-wrap font-sans">{requisites}</pre>
        </div>
      )}

      <Btn onClick={fill} disabled={!party}>📄 Сформировать договор</Btn>

      {result && (
        <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-4">
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <div className="font-bold text-gray-800">Готовый договор</div>
            <div className="flex gap-2 flex-wrap">
              <Btn size="sm" onClick={printContract}>🖨 Печать</Btn>
              <Btn size="sm" variant="secondary" onClick={() => copyToClipboard(result)}>📋 Копировать</Btn>
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
      <div className="bg-blue-50 border border-blue-100 rounded-2xl p-4 text-sm text-blue-800">🔔 Клиенты, которые брали муку регулярно, но сейчас задержались <b>дольше своего обычного графика</b>. Можно напомнить и предложить заявку. Те, у кого уже есть активная заявка, сюда не попадают.</div>
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
              <a href={waLink(c)} target="_blank" rel="noreferrer" className="bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-medium px-4 py-2 rounded-lg">📲 Написать в WhatsApp</a>
              <span className="text-xs text-gray-400">📱 {c.contact}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function DebtsTab({ orders, clients, reload, canEdit = true }) {
  const [open, setOpen] = useState({});
  const [reconcile, setReconcile] = useState(false); // режим «акт сверки»: отмечаем компании галочками
  const [selected, setSelected] = useState({});
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
  const list = Object.values(byClient).sort((a, b) => b.total - a.total);
  const grand = list.reduce((s, c) => s + c.total, 0);

  const markPaid = async (c, date, method) => {
    try {
      for (const o of orders.filter(o => (o.clientId ? o.clientId === c.clientId : o.clientName === c.name) && o.date === date && o.status === "отгружена")) await dbUpsert("orders", { ...o, paid: true, pay_method: method });
      await reload("orders");
    } catch (e) { alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз."); }
  };

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
        <div className="font-bold text-gray-800">💰 Общий долг клиентов</div>
        <div className="text-2xl font-black text-red-600">{fmt(grand)} тг</div>
      </div>
      <div className="text-xs text-gray-400">Долг появляется только после статуса «Доставлено». Пока заявка новая или в пути — долга нет.</div>
      {list.length > 0 && !reconcile && (
        <button onClick={() => setReconcile(true)} className="w-full bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 rounded-xl px-4 py-2.5 text-sm font-medium">📄 Акт сверки — выбрать компании и скопировать список для бухгалтера</button>
      )}
      {reconcile && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-2">
          <div className="text-sm text-amber-800">Отметь галочками компании для акта сверки — скопируется список «название — БИН» для бухгалтера.</div>
          <div className="flex gap-2 flex-wrap">
            <Btn size="sm" onClick={copyReconcile} disabled={!selectedList.length}>📋 Скопировать ({selectedList.length})</Btn>
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
        return (
          <div key={c.key} className={`bg-white border rounded-2xl shadow-sm overflow-hidden ${reconcile && selected[c.key] ? "border-amber-400 ring-1 ring-amber-300" : "border-gray-100"}`}>
            <button onClick={() => reconcile ? setSelected(s => ({ ...s, [c.key]: !s[c.key] })) : setOpen(o => ({ ...o, [c.key]: !o[c.key] }))} className="w-full flex items-center justify-between p-4 text-left">
              <div className="flex items-center gap-3 min-w-0">
                {reconcile && <span className={`w-5 h-5 flex-shrink-0 rounded-md border-2 flex items-center justify-center text-white text-xs font-bold ${selected[c.key] ? "bg-amber-500 border-amber-500" : "border-gray-300"}`}>{selected[c.key] ? "✓" : ""}</span>}
                <div>
                  <div className="font-bold text-gray-900">{c.name}{c.org && <span className="text-sm text-gray-500 font-normal"> · {c.org}</span>}</div>
                  <div className="text-xs text-gray-400">{dates.length} {dates.length === 1 ? "отгрузка не оплачена" : "отгрузок не оплачено"}</div>
                </div>
              </div>
              <div className="text-right"><div className="font-bold text-red-600">{fmt(c.total)} тг</div>{!reconcile && <div className="text-xs text-gray-400">{isOpen ? "▲ свернуть" : "▼ открыть"}</div>}</div>
            </button>
            {isOpen && (
              <div className="px-4 pb-4 space-y-2 border-t border-gray-50 pt-3">
                {dates.map(date => {
                  const d = c.byDate[date];
                  return (
                    <div key={date} className="bg-gray-50 rounded-xl p-3">
                      <div className="flex items-center justify-between text-sm">
                        <div><b>{date.split("-").reverse().join(".")}</b> · {fmt(d.kg)} кг</div>
                        <div className="font-bold text-gray-800">{fmt(d.sum)} тг</div>
                      </div>
                      <div className="text-xs text-gray-500 mt-1">{d.items.map((o, i) => `${i ? ", " : ""}${o.brand} ${o.grade} ${o.bag_kg}кг×${o.bags}`).join("")}</div>
                      {canEdit && <div className="flex gap-2 mt-2"><Btn size="sm" onClick={() => markPaid(c, date, "Нал")}>💵 Оплатил нал</Btn><Btn size="sm" variant="secondary" onClick={() => markPaid(c, date, "Безнал")}>💳 Безнал</Btn></div>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
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
    try { for (const o of ordersArr) await dbUpsert("orders", { ...o, status }); await reload("orders"); }
    catch (e) { alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз."); }
  };
  const del = async o => { if (!confirm("Удалить эту отгрузку из Караганды?")) return; try { await dbDelete("orders", o.id); await reload("orders"); } catch (e) { alert("⚠️ Не удалилось: " + (e && e.message ? e.message : e)); } };

  return (
    <div className="space-y-4">
      <div className="bg-orange-50 border border-orange-100 rounded-2xl p-4 text-sm text-orange-800">
        🏬 Склад <b>Караганда</b>. Фуры идут <b>напрямую клиентам</b>. Записываешь как <b>«в пути»</b>; когда отправили — жмёшь <b>«Отгружено»</b>, и сумма идёт клиенту в долг и в отчёт. Склад в Астане <b>не трогается</b>.
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
              <div className="font-bold text-gray-800">🚛 {date.split("-").reverse().join(".")}</div>
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
                          <span className="bg-amber-100 text-amber-900 font-bold px-2 py-0.5 rounded-md whitespace-nowrap">📦 {o.bags} меш. × {o.bag_kg} кг</span>
                          <span>= <b>{fmt(o.bags * o.bag_kg)} кг</b> · {o.brand} {o.grade}{o.price_per_kg ? ` · ${fmt(o.bags * o.bag_kg * o.price_per_kg)} тг` : ""}</span>
                          {canEdit && <button onClick={() => del(o)} className="text-red-300 hover:text-red-600 ml-auto" title="Удалить позицию">✕</button>}
                        </div>
                      ))}
                    </div>
                    {g.orders[0].note && <div className="text-xs text-gray-400 mt-1">📝 {g.orders[0].note}</div>}
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
    // Фото (накладные) и отметку доставки собираем со всей заявки и переносим на первую позицию — чтобы не потерять при удалении позиции
    const allPhotos = [...new Set(group.orders.flatMap(o => o.photos || []))];
    const anyDelivered = group.orders.some(o => o.delivered_by_driver);
    let carried = false;
    try {
      for (const p of valid) {
        const price = p.trial ? 0 : (p.price_per_kg !== "" && p.price_per_kg != null ? Number(p.price_per_kg) : (priceFor(client, p.brand, p.grade, Number(p.bag_kg)) || 0));
        const carry = !carried ? { photos: allPhotos, delivered_by_driver: anyDelivered } : {};
        carried = true;
        if (p.id) {
          const orig = group.orders.find(o => o.id === p.id);
          await dbUpsert("orders", { ...orig, brand: p.brand, grade: p.grade, bag_kg: Number(p.bag_kg), bags: Number(p.bags), price_per_kg: price, note, ...carry });
        } else {
          await dbUpsert("orders", { id: uid(), date: base.date, clientId: base.clientId, clientName: base.clientName, brand: p.brand, grade: p.grade, bag_kg: Number(p.bag_kg), bags: Number(p.bags), price_per_kg: price, status: base.status, driverId: grpDriver, pickup: grpPickup, loaderId: grpLoader, trial: !!p.trial, fromKaraganda: !!base.fromKaraganda, note, ...carry });
        }
      }
      const keep = new Set(valid.filter(p => p.id).map(p => p.id));
      for (const o of group.orders) if (!keep.has(o.id)) await dbDelete("orders", o.id);
      onClose(); await reload("orders");
    } catch (e) { alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз."); }
    setSaving(false);
  };
  return (
    <Modal title={`✏️ ${group.clientName || "Заявка"}`} onClose={onClose}>
      <div className="space-y-3">
        <div className="text-xs text-gray-500">Измени сорт/количество/цену, удали лишнюю позицию (✕) или добавь новую.</div>
        {positions.map((p, i) => (
          <div key={i} className="border border-gray-200 rounded-xl p-3 relative">
            <button onClick={() => rm(i)} className="absolute top-2 right-2 text-red-400 hover:text-red-600 text-lg leading-none" title="Удалить позицию">✕</button>
            <div className="grid grid-cols-2 gap-2">
              <Sel label="Бренд" value={p.brand} onChange={e => upd(i, "brand", e.target.value)} options={BRANDS} />
              <Sel label="Сорт" value={p.grade} onChange={e => upd(i, "grade", e.target.value)} options={GRADES} />
              <Sel label="Фасовка" value={p.bag_kg} onChange={e => upd(i, "bag_kg", e.target.value)} options={WEIGHTS.map(w => ({ value: w, label: w + " кг" }))} />
              <Inp label="Мешков" type="number" value={p.bags} onChange={e => upd(i, "bags", e.target.value)} />
              {p.trial
                ? <div className="col-span-2 text-xs text-orange-600 font-medium">🎁 на пробу (бесплатно)</div>
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

function TodayTab({ orders, clients, drivers = [], stock = [], reload, applyLocal = () => {}, driverFilter = null, canEdit = true, openSignal = 0 }) {
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
  const [form, setForm] = useState({ clientId: "", brand: BRANDS[0], grade: GRADES[0], bag_kg: 50, bags: "", date: TODAY(), driverId: "", price_per_kg: "", isSample: false, sampleName: "", trial: false, note: "", pickup: false, loaderId: "", oneOff: false, oneOffName: "", payMethod: "Нал", oneOffAddress: "", gis_link: "", coords: null });
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
  useEffect(() => { if (openSignal) setShowManual(true); }, [openSignal]);

  const local = orders.filter(o => !o.fromKaraganda); // карагандинские отгрузки тут не показываем
  const vis = driverFilter != null ? local.filter(o => o.driverId === driverFilter) : local;
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
        const matches = clients.filter(c => c.name.toLowerCase().includes(p.clientName.toLowerCase()) || p.clientName.toLowerCase().includes(c.name.toLowerCase()));
        const chosen = matches.length === 1 ? matches[0] : null; // если совпало несколько (тёзки) — пусть выберет вручную
        return { ...p, trial: !!p.trial, matchOptions: matches, clientId: chosen?.id || null, clientFound: chosen?.name || p.clientName, price_per_kg: p.trial ? 0 : (chosen ? priceFor(chosen, p.brand, p.grade, p.bag_kg) : null) };
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
  const shipStock = o => dbUpsert("stock", { id: "mv_" + o.id, date: TODAY(), brand: o.brand, grade: o.grade, weight_kg: -(o.bags * o.bag_kg), bags: -o.bags, bag_kg: o.bag_kg, note: `Отгрузка: ${o.clientName}` });
  const unshipStock = async o => {
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
    if (!confirm(`Удалить заявку «${g.clientName || "Клиент"}» на сегодня (${g.orders.length} поз.)?`)) return;
    const ids = new Set(g.orders.map(o => o.id));
    applyLocal("orders", os => os.filter(o => !ids.has(o.id)));
    try { await Promise.all(g.orders.map(o => dbDelete("orders", o.id))); } catch (e) { notifyErr(e); reload("orders"); }
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
      for (const o of g.orders) await dbUpsert("orders", { ...o, clientId: id });
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
    const price = (form.isSample || isTrial) ? 0 : (form.price_per_kg || (client ? priceFor(client, form.brand, form.grade, Number(form.bag_kg)) : 0));
    // если у клиента на эту дату уже назначен водитель — наследуем его (чтобы новая позиция не «потерялась» у водителя)
    const inheritedDriver = (!form.isSample && form.clientId) ? (orders.find(o => o.clientId === form.clientId && o.date === form.date && o.driverId)?.driverId || "") : "";
    try {
      await dbUpsert("orders", {
        id: uid(), date: form.date, brand: form.brand, grade: form.grade,
        bag_kg: Number(form.bag_kg), bags: Number(form.bags),
        driverId: form.pickup ? "" : (form.driverId || inheritedDriver),
        pickup: !!form.pickup, loaderId: form.pickup ? (form.loaderId || "") : "",
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
        <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-4"><div className="text-sm text-gray-500">Заявки сегодня</div><div className="text-3xl font-black text-gray-900">{groupCount(todayList)}</div></div>
        <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-4"><div className="text-sm text-gray-500">На завтра</div><div className="text-3xl font-black text-gray-900">{groupCount(tomorrowList)}</div></div>
      </div>

      {canEdit && (
      <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-4">
        <div className="font-semibold text-gray-800 mb-2">📲 Разобрать заявку из WhatsApp</div>
        <textarea value={aiText} onChange={e => setAiText(e.target.value)} rows={3} placeholder="Вставь сюда сообщение из WhatsApp, напр.: Сегафредо 500 кг высший сорт на завтра" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-amber-300" />
        {aiError && <div className="text-sm text-red-500 mt-2">{aiError}</div>}
        <div className="mt-2 flex gap-2">
          <button onClick={handleAI} disabled={aiLoading || !aiText.trim()} style={{ flex: 2 }} className="bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded-lg font-medium px-4 py-2.5 text-sm">{aiLoading ? "Разбираю..." : "📲 Разобрать"}</button>
          <button onClick={() => setShowManual(true)} style={{ flex: 1 }} className="bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg font-medium px-3 py-2.5 text-sm whitespace-nowrap">✍️ Вручную</button>
        </div>
        {aiResult && (
          <div className="mt-3 border-t border-gray-100 pt-3 space-y-2">
            {aiResult.map((p, i) => (
              <div key={i} className="bg-gray-50 rounded-xl p-3 text-sm">
                <div className="flex items-center gap-2 flex-wrap"><span className="font-semibold">{p.clientFound}</span>{(p.matchOptions || []).length === 0 && <Badge color="red">Не в базе</Badge>}{p.trial && <Badge color="yellow">🎁 на пробу</Badge>}</div>
                {(p.matchOptions || []).length > 1 && (
                  <div className="mt-1">
                    <div className="text-xs text-orange-600 mb-1">⚠️ Несколько клиентов с таким названием — выбери нужного:</div>
                    <select value={p.clientId || ""} onChange={e => chooseClient(i, e.target.value)} className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm">
                      <option value="">— выбери клиента —</option>
                      {p.matchOptions.map(c => <option key={c.id} value={c.id}>{c.name}{c.org_name ? ` (${c.org_name})` : ""}</option>)}
                    </select>
                  </div>
                )}
                <div className="text-gray-600 mt-1">{p.brand} · {p.grade} · {p.bag_kg}кг × {p.bags} = {fmt(p.bags * p.bag_kg)} кг</div>
                <div className="text-gray-600">Дата: {p.date} · {p.trial ? <span className="text-orange-600 font-medium">бесплатно</span> : (p.price_per_kg ? fmt(p.price_per_kg) + " тг/кг" : <span className="text-red-500">цена не найдена</span>)}</div>
                {p.note && <div className="text-amber-800 bg-amber-50 rounded px-2 py-1 mt-1 text-xs">📝 {p.note}</div>}
              </div>
            ))}
            <label className="flex items-center gap-2 cursor-pointer bg-sky-50 rounded-lg px-3 py-2">
              <input type="checkbox" checked={aiPickup} onChange={e => { setAiPickup(e.target.checked); setAiDriver(""); }} className="w-4 h-4 accent-sky-500" />
              <span className="text-sm font-medium text-gray-700">🚶 Самовывоз — клиент забирает сам (выбери грузчика)</span>
            </label>
            {(() => { const ok = aiPickup || aiDriver; return (
            <div className={`rounded-xl p-3 border ${ok ? "bg-gray-50 border-gray-100" : "bg-orange-50 border-orange-200"}`}>
              <div className={`text-sm font-medium mb-1 ${ok ? "text-gray-700" : "text-orange-700"}`}>{aiPickup ? "📦 Кто отгрузит (грузчик)?" : "🚛 Кто повезёт?"} {!ok && "— выбери перед подтверждением"}</div>
              <select value={aiDriver} onChange={e => setAiDriver(e.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-300">
                <option value="">{aiPickup ? "— определить позже —" : "— выбери водителя —"}</option>
                {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
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
              const isOneOff = g.orders.some(o => o.oneOff);
              const worker = drivers.find(d => d.id === (isPickup ? g.orders.find(o => o.loaderId)?.loaderId : g.orders.find(o => o.driverId)?.driverId));
              return (
                <Fragment key={g.key}>
                {shipped && !prevShipped && <div className="text-xs font-semibold text-emerald-600 pt-2 pb-1">— ✓ Отвезено ({shippedCount}) —</div>}
                <div className={`rounded-2xl p-4 border ${shipped ? "bg-emerald-50 border-emerald-300" : "bg-white border-gray-100 shadow-sm"}`}>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="font-bold text-gray-900 flex items-center gap-1.5">{shipped && <span className="text-emerald-600 text-lg">✓</span>}{g.clientName || "Клиент"}{g.isTrial && <span className="text-xs font-medium text-orange-700 bg-orange-100 px-2 py-0.5 rounded-full">🎁 на пробу</span>}{isPickup && <span className="text-xs font-medium text-sky-700 bg-sky-100 px-2 py-0.5 rounded-full">🚶 Самовывоз</span>}{isOneOff && <span className="text-xs font-medium text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full">💰 разовая</span>}</span>
                    {shipped ? <span className="text-xs font-bold bg-emerald-600 text-white px-3 py-1 rounded-full whitespace-nowrap">✓ Отгружено</span> : <Badge color={sc[st] || "gray"}>{st}</Badge>}
                  </div>
                  <div className="space-y-1">
                    {mergedPositions(g.orders).map((m, mi) => (
                      <div key={mi} className="flex items-center gap-2 flex-wrap text-sm">
                        <span className="bg-amber-100 text-amber-900 font-bold px-2 py-0.5 rounded-md whitespace-nowrap">📦 {m.bags} меш. × {m.bag_kg} кг</span>
                        <span className="text-gray-600">= <b>{fmt(m.bags * m.bag_kg)} кг</b> · {m.brand} {m.grade}{m.trial ? " · 🎁 на пробу" : ""}</span>
                      </div>
                    ))}
                  </div>
                  {[...new Set(g.orders.map(o => o.note).filter(Boolean))].map((n, ni) => <div key={ni} className="text-xs text-amber-900 bg-amber-50 border border-amber-100 rounded-lg px-2 py-1 mt-1">📝 {n}</div>)}
                  {(!isOneOff || worker) && <div className="text-xs text-gray-500 mt-1">{isPickup ? "📦 Грузчик: " : "🚛 Водитель: "}<b className={worker ? "text-gray-700" : "text-orange-600"}>{worker?.name || (isPickup ? "определить позже" : "не назначен")}</b></div>}
                  {isOneOff && g.orders[0].oneOffAddress && <div className="text-xs text-gray-500 mt-0.5">📍 {g.orders[0].oneOffAddress}</div>}
                  {canEdit && (
                    <div className="mt-3 space-y-2">
                      <div className="flex gap-2 flex-wrap items-center">
                        {allNew && !isPickup && !isOneOff && <Btn size="sm" variant="secondary" onClick={() => setGroupStatus(g, "в пути")}>🚚 В путь</Btn>}
                        {(allNew || allRoute) && <Btn size="sm" onClick={() => setGroupStatus(g, "отгружена")}>{isPickup ? "✓ Отгрузить" : "✓ Доставлено"}</Btn>}
                        {shipped && <Btn size="sm" variant="secondary" onClick={() => setGroupStatus(g, (isPickup || isOneOff) ? "новая" : "в пути")}>↩ {(isPickup || isOneOff) ? "Отменить" : "Не доставлено"}</Btn>}
                        {isOneOff && !g.clientId && <Btn size="sm" variant="secondary" onClick={() => addOneOffToClients(g)}>➕ В клиенты</Btn>}
                        <Btn size="sm" variant="secondary" onClick={() => setEditGroup(g)}>✏️ Изменить</Btn>
                        <Btn size="sm" variant="danger" onClick={() => deleteGroup(g)}>🗑</Btn>
                      </div>
                      {!shipped && (
                        <div className="flex items-center gap-2 text-xs text-gray-500 flex-wrap pt-1 border-t border-gray-50">
                          <span>📅 Перенести:</span>
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
        <Modal title={form.oneOff ? "💰 Единичная реализация" : form.isSample ? "🧪 Пробник" : form.trial ? "🎁 На пробу клиенту" : "Новая заявка"} onClose={() => setShowManual(false)}>
          {!form.isSample && !form.oneOff && (
            <label className="flex items-center gap-2 mb-2 cursor-pointer bg-orange-50 rounded-lg px-3 py-2">
              <input type="checkbox" checked={form.trial} onChange={e => setForm({ ...form, trial: e.target.checked })} className="w-4 h-4 accent-orange-500" />
              <span className="text-sm font-medium text-gray-700">🎁 На пробу — клиенту из базы (бесплатно, маршрут строится, без накладной)</span>
            </label>
          )}
          {!form.trial && !form.oneOff && (
            <label className="flex items-center gap-2 mb-2 cursor-pointer bg-amber-50 rounded-lg px-3 py-2">
              <input type="checkbox" checked={form.isSample} onChange={e => setForm({ ...form, isSample: e.target.checked, trial: false })} className="w-4 h-4 accent-amber-500" />
              <span className="text-sm font-medium text-gray-700">🧪 Проба новой компании — нет в базе (бесплатно, без маршрута)</span>
            </label>
          )}
          {!form.trial && !form.isSample && (
            <label className="flex items-center gap-2 mb-2 cursor-pointer bg-emerald-50 rounded-lg px-3 py-2">
              <input type="checkbox" checked={form.oneOff} onChange={e => setForm({ ...form, oneOff: e.target.checked, pickup: false, driverId: "", clientId: "", date: TODAY() })} className="w-4 h-4 accent-emerald-500" />
              <span className="text-sm font-medium text-gray-700">💰 Единичная реализация — покупатель не из базы, за деньги (несколько сортов, можно с доставкой)</span>
            </label>
          )}
          {!form.isSample && !form.oneOff && (
            <label className="flex items-center gap-2 mb-3 cursor-pointer bg-sky-50 rounded-lg px-3 py-2">
              <input type="checkbox" checked={form.pickup} onChange={e => setForm({ ...form, pickup: e.target.checked, driverId: "" })} className="w-4 h-4 accent-sky-500" />
              <span className="text-sm font-medium text-gray-700">🚶 Самовывоз — клиент забирает сам (вместо водителя выбери грузчика)</span>
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
                  <Btn size="sm" variant="secondary" onClick={ooResolve} disabled={ooResolving || !form.gis_link}>{ooResolving ? "Ищу точку..." : "📍 Определить точку"}</Btn>
                  {form.coords
                    ? <span className="text-xs text-emerald-600 font-medium">✓ точка найдена — встанет в маршрут водителя</span>
                    : <span className="text-xs text-gray-400">без точки заявка в маршрут не попадёт</span>}
                </div>
                {ooErr && <div className="text-xs text-red-500 mt-1">{ooErr}</div>}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Inp label="Дата" type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
                <Sel label="🚚 Кто повезёт" value={form.driverId} onChange={e => setForm({ ...form, driverId: e.target.value })} options={[{ value: "", label: "— забрал сам —" }, ...drivers.map(d => ({ value: d.id, label: d.name }))]} />
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">Оплата</label>
                <div className="flex gap-2 mt-1">
                  <button onClick={() => setForm({ ...form, payMethod: "Нал" })} className={`flex-1 py-2 rounded-lg text-sm font-medium ${form.payMethod === "Нал" ? "bg-emerald-500 text-white" : "bg-gray-100 text-gray-600"}`}>💵 Нал</button>
                  <button onClick={() => setForm({ ...form, payMethod: "Безнал" })} className={`flex-1 py-2 rounded-lg text-sm font-medium ${form.payMethod === "Безнал" ? "bg-emerald-500 text-white" : "bg-gray-100 text-gray-600"}`}>💳 Безнал</button>
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
            {!form.isSample && !form.trial && <Inp label="Цена тг/кг" type="number" placeholder="авто из базы" value={form.price_per_kg || ""} onChange={e => setForm({ ...form, price_per_kg: e.target.value })} />}
            <Inp label={form.pickup ? "Дата" : "Дата доставки"} type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
            {form.pickup
              ? <div className="col-span-2"><Sel label="📦 Грузчик (кто отгрузит)" value={form.loaderId} onChange={e => setForm({ ...form, loaderId: e.target.value })} options={[{ value: "", label: "— определить позже —" }, ...drivers.map(d => ({ value: d.id, label: d.name }))]} /></div>
              : <div className="col-span-2"><Sel label="🚚 Водитель" value={form.driverId} onChange={e => setForm({ ...form, driverId: e.target.value })} options={[{ value: "", label: "— назначить позже —" }, ...drivers.map(d => ({ value: d.id, label: d.name }))]} /></div>}
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
  const [data, setData] = useState({ clients: [], stock: [], orders: [], drivers: [], trucks: [], users: [], expenses: [], logins: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastSync, setLastSync] = useState(null);
  const [fabOpen, setFabOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [syncing, setSyncing] = useState(false); // ручное обновление: крутим значок и показываем ✓
  const [syncDone, setSyncDone] = useState(false);
  const [updateReady, setUpdateReady] = useState(false); // на сервере вышла новая версия приложения
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
        const next = { clients: d.clients || [], stock: d.stock || [], orders: d.orders || [], drivers: d.drivers || [], trucks: d.trucks || [], users: d.users || [], expenses: d.expenses || [], logins: d.logins || [] };
        // Если данные не изменились — не трогаем экран (иначе телефон перерисовывает всё каждые полминуты и подтормаживает)
        const same = Object.keys(next).every(k => JSON.stringify(prev[k]) === JSON.stringify(next[k]));
        return same ? prev : next;
      });
      setLastSync(new Date().toLocaleTimeString("ru-RU"));
    } catch (e) {
      // apiData сбрасывает токен на 401 (сессия истекла / доступ закрыт) → выкидываем на экран входа
      if (!authToken) { setUser(null); if (showSpinner) setLoading(false); return; }
      setError("Нет связи с базой: " + e.message);
    }
    if (showSpinner) setLoading(false);
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

  const logout = () => { setAuthToken(null); localStorage.removeItem("sklad_uid"); setData({ clients: [], stock: [], orders: [], drivers: [], trucks: [], users: [], expenses: [], logins: [] }); setUser(null); setLoading(false); };

  if (loading) return <div className="min-h-screen bg-gray-50 flex items-center justify-center"><Spinner /></div>;
  if (!user) return <LoginScreen onLogin={setUser} />;

  const isDirector = user.role === "director";
  const allowedTabs = TABS_BY_ROLE[user.role] || [];
  // Нижняя панель: основные разделы для роли (что есть в доступе), остальное — под «Ещё»
  const primaryNav = (PRIMARY_NAV[user.role] || []).filter(id => allowedTabs.includes(id));
  const moreNav = allowedTabs.filter(id => !primaryNav.includes(id));
  // Считаем новые ЗАЯВКИ (по клиенту+дате), а не отдельные позиции
  const newOrders = new Set(data.orders.filter(o => o.status === "новая").map(o => (o.clientId || "nm:" + (o.clientName || "")) + "|" + o.date)).size;

  return (
    <div className="min-h-screen bg-gray-50 font-sans">
      <div className="bg-white border-b border-gray-100 px-4 py-4 sticky top-0 z-40 shadow-sm">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <img src="/icon-192.png" alt="Darad" className="w-9 h-9 rounded-lg flex-shrink-0" />
            <div>
              <h1 className="text-xl font-black text-gray-900">Darad</h1>
              <p className="text-xs text-gray-400">{user.name} · {ROLES[user.role] || user.role}{lastSync ? ` · 🟢 ${lastSync}` : ""}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isDirector && newOrders > 0 && <div className="bg-amber-500 text-white text-sm font-bold px-3 py-1.5 rounded-full">{newOrders} новых</div>}
            <button onClick={manualRefresh} disabled={syncing} title="Обновить" className={`flex items-center gap-1 px-2.5 py-1.5 rounded-full border text-sm font-medium transition-all active:scale-90 ${syncDone ? "bg-emerald-50 border-emerald-300 text-emerald-600" : syncing ? "bg-amber-50 border-amber-300 text-amber-600" : "bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100 hover:text-gray-700"}`}>
              <span className={`inline-block text-base leading-none ${syncing ? "animate-spin" : ""}`}>🔄</span>
              {syncDone && <span className="font-bold">✓</span>}
            </button>
            <button onClick={logout} className="text-gray-400 hover:text-gray-600 text-sm" title="Выйти">Выйти</button>
          </div>
        </div>
      </div>
      {updateReady && (
        <button onClick={() => window.location.reload()} className="w-full bg-amber-500 text-white text-sm font-bold px-4 py-2.5 text-center">
          ✨ Вышло обновление приложения — нажми здесь, чтобы обновиться
        </button>
      )}
      {error && <div className="bg-red-50 border-b border-red-200 px-4 py-2 text-sm text-red-600 text-center">{error}</div>}
      <div className="max-w-2xl mx-auto px-4 py-5 pb-28">
        {allowedTabs.includes(tab) && (
          <>
            {tab === "today" && <TodayTab orders={data.orders} clients={data.clients} drivers={data.drivers} stock={data.stock} reload={reload} applyLocal={applyLocal} driverFilter={user.role === "driver" ? (user.driverId || "") : null} canEdit={isDirector} openSignal={openOrderSignal} />}
            {tab === "calendar" && <CalendarTab orders={data.orders} drivers={data.drivers} clients={data.clients} stock={data.stock} reload={reload} applyLocal={applyLocal} canEdit={isDirector} showPrices={user.role !== "driver"} driverFilter={user.role === "driver" ? (user.driverId || "") : null} driverMode={user.role === "driver"} />}
            {tab === "stock" && <StockTab stock={data.stock} orders={data.orders} reload={reload} canEdit={isDirector} />}
            {tab === "supply" && <TrucksTab trucks={data.trucks} reload={reload} canEdit={isDirector} />}
            {tab === "karaganda" && <KaragandaTab orders={data.orders} clients={data.clients} reload={reload} canEdit={isDirector} />}
            {tab === "debts" && <DebtsTab orders={data.orders} clients={data.clients} reload={reload} canEdit={isDirector} />}
            {tab === "contracts" && <ContractsTab clients={data.clients} />}
            {tab === "invoice" && <SoftInvoiceTab clients={data.clients} orders={data.orders} />}
            {tab === "reactivate" && <ReactivateTab clients={data.clients} orders={data.orders} />}
            {tab === "clients" && <ClientsTab clients={data.clients} orders={data.orders} reload={reload} canEdit={isDirector} />}
            {tab === "drivers" && <DriversTab drivers={data.drivers} orders={data.orders} expenses={data.expenses} users={data.users} reload={reload} canEdit={isDirector} />}
            {tab === "expenses" && <ExpensesTab expenses={data.expenses} reload={reload} openSignal={openExpenseSignal} canEdit={isDirector} />}
            {tab === "reports" && <ReportsTab orders={data.orders} drivers={data.drivers} stock={data.stock} expenses={data.expenses} reload={reload} canEdit={isDirector} />}
            {tab === "access" && <UsersTab users={data.users} drivers={data.drivers} logins={data.logins} reload={reload} currentUser={user} />}
          </>
        )}
      </div>

      {isDirector && (
        <>
          {fabOpen && (
            <div className="fixed inset-0 z-40" onClick={() => setFabOpen(false)} style={{ background: "rgba(0,0,0,0.35)" }}>
              <div className="max-w-2xl mx-auto px-4 relative h-full">
                <div className="absolute right-4 bottom-40 flex flex-col items-end gap-3" onClick={e => e.stopPropagation()}>
                  <button onClick={() => goTab("today")} className="flex items-center gap-2"><span className="bg-white shadow rounded-full px-3 py-1.5 text-sm font-medium text-gray-700">Разобрать из WhatsApp</span><span className="w-11 h-11 rounded-full bg-amber-500 text-white flex items-center justify-center text-lg shadow-lg">📲</span></button>
                  <button onClick={() => { goTab("today"); setOpenOrderSignal(n => n + 1); }} className="flex items-center gap-2"><span className="bg-white shadow rounded-full px-3 py-1.5 text-sm font-medium text-gray-700">Заявка вручную</span><span className="w-11 h-11 rounded-full bg-amber-500 text-white flex items-center justify-center text-lg shadow-lg">✍️</span></button>
                  <button onClick={() => { goTab("expenses"); setOpenExpenseSignal(n => n + 1); }} className="flex items-center gap-2"><span className="bg-white shadow rounded-full px-3 py-1.5 text-sm font-medium text-gray-700">Расход</span><span className="w-11 h-11 rounded-full bg-amber-500 text-white flex items-center justify-center text-lg shadow-lg">💸</span></button>
                </div>
              </div>
            </div>
          )}
          <button onClick={() => setFabOpen(v => !v)} className="fixed z-40 right-4 bottom-24 w-14 h-14 rounded-full bg-amber-500 hover:bg-amber-600 text-white text-3xl leading-none flex items-center justify-center shadow-xl transition-transform" style={{ transform: fabOpen ? "rotate(45deg)" : "none" }} aria-label="Добавить">+</button>
        </>
      )}

      <nav className="fixed bottom-0 left-0 right-0 z-30 bg-white border-t border-gray-100">
        <div className="max-w-2xl mx-auto flex justify-between px-2 py-1.5">
          {primaryNav.map(id => (
            <button key={id} onClick={() => goTab(id)} className={`flex-1 flex flex-col items-center gap-0.5 py-1 ${tab === id ? "text-amber-600" : "text-gray-400"}`}>
              <span className="text-xl leading-none">{NAV_ICON[id]}</span>
              <span className="text-[10px] font-medium">{NAV_SHORT[id]}</span>
            </button>
          ))}
          {moreNav.length > 0 && (
            <button onClick={() => setMoreOpen(true)} className={`flex-1 flex flex-col items-center gap-0.5 py-1 ${moreNav.includes(tab) ? "text-amber-600" : "text-gray-400"}`}>
              <span className="text-xl leading-none">⋯</span>
              <span className="text-[10px] font-medium">Ещё</span>
            </button>
          )}
        </div>
      </nav>

      {moreOpen && (
        <div className="fixed inset-0 z-40 flex items-end" onClick={() => setMoreOpen(false)} style={{ background: "rgba(0,0,0,0.4)" }}>
          <div className="bg-white w-full rounded-t-2xl max-w-2xl mx-auto p-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3"><h3 className="font-bold text-gray-800">Ещё</h3><button onClick={() => setMoreOpen(false)} className="text-gray-400 text-2xl leading-none">&times;</button></div>
            <div className="grid grid-cols-3 gap-3">
              {moreNav.map(id => (
                <button key={id} onClick={() => goTab(id)} className={`flex flex-col items-center gap-1 rounded-2xl border p-4 ${tab === id ? "border-amber-300 bg-amber-50" : "border-gray-100 bg-gray-50"}`}>
                  <span className="text-2xl leading-none">{NAV_ICON[id]}</span>
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
