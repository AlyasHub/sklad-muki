import { useState, useEffect, useCallback } from "react";

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
function nakladnayaText(g, client) {
  const head = (client && client.org_name) || g.clientName || "Клиент";
  const billable = g.orders.filter(o => !o.trial && !o.isSample); // бесплатные пробы в накладную не идут
  if (!billable.length) return null;
  const lines = billable.map(o => `${fmt(o.bags * o.bag_kg)} кг ${o.grade} ${o.brand}${o.price_per_kg ? ` — ${fmt(o.price_per_kg)} тг/кг` : ""}`);
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

// Шифрование пароля (SHA-256) — пароли не хранятся в открытом виде
async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}
const ROLES = { director: "Директор", accountant: "Бухгалтер", driver: "Водитель" };
// Какие вкладки видит каждая роль
const TABS_BY_ROLE = {
  director: ["today", "calendar", "stock", "clients", "reports", "orders", "supply", "drivers", "expenses", "access"],
  accountant: ["today", "calendar", "reports"],
  driver: ["calendar"],
};
// Что показываем в нижней панели (остальное — под «Ещё»)
const PRIMARY_NAV = {
  director: ["today", "calendar", "stock", "clients", "reports"],
  accountant: ["today", "calendar", "reports"],
  driver: ["calendar"],
};
const NAV_ICON = { today: "🏠", calendar: "📅", stock: "🏭", clients: "🏢", reports: "📊", orders: "📋", supply: "🚚", drivers: "🚛", expenses: "💸", access: "⚙️" };
const NAV_SHORT = { today: "Сегодня", calendar: "Календарь", stock: "Склад", clients: "Клиенты", reports: "Отчёты", orders: "Заявки", supply: "Поставки", drivers: "Водители", expenses: "Расходы", access: "Доступ" };
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
      clients: clients.map(c => ({ name: c.name, org_name: c.org_name, default_bag_kg: c.default_bag_kg, default_brand: c.default_brand })),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Не удалось разобрать заявку");
  return JSON.parse(data.raw);
}

function Badge({ color, children }) {
  const c = { green: "bg-emerald-100 text-emerald-800", yellow: "bg-amber-100 text-amber-800", blue: "bg-blue-100 text-blue-800", red: "bg-red-100 text-red-800", gray: "bg-gray-100 text-gray-600" };
  return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${c[color]}`}>{children}</span>;
}
function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.5)" }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-screen overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <h3 className="text-lg font-bold text-gray-900">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">&times;</button>
        </div>
        <div className="p-5">{children}</div>
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

const TABS = [{ id: "today", label: "🏠 Сегодня" }, { id: "calendar", label: "📅 Календарь" }, { id: "stock", label: "🏭 Склад" }, { id: "clients", label: "🏢 Клиенты" }, { id: "reports", label: "📊 Отчёты" }, { id: "orders", label: "📋 Все заявки" }, { id: "supply", label: "🚚 Поставки" }, { id: "drivers", label: "🚛 Водители" }, { id: "expenses", label: "💸 Расходы" }, { id: "access", label: "⚙️ Доступ" }];

function CalendarTab({ orders, drivers, clients, stock = [], reload, canEdit = true, showPrices = true, driverFilter = null, driverMode = false }) {
  const [cursor, setCursor] = useState(new Date());
  const [selected, setSelected] = useState(TODAY());
  const [uploadingId, setUploadingId] = useState(null);
  const [photoView, setPhotoView] = useState(null);

  // Водитель видит только свои отгрузки
  const vis = driverFilter != null ? orders.filter(o => o.driverId === driverFilter) : orders;

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
      await dbUpsert("orders", { ...o, photos: [...(o.photos || []), url] });
      await reload("orders");
    } catch (e) { alert("⚠️ Не удалось загрузить фото: " + e.message + "\nПроверь интернет и попробуй ещё раз."); }
    setUploadingId(null);
  };
  // Директор подтверждает доставку → списание со склада
  const confirmDelivery = async o => {
    try {
      await dbUpsert("orders", { ...o, confirmed: true, status: "отгружена" });
      if (o.status !== "отгружена") {
        const kg = o.bags * o.bag_kg;
        await dbUpsert("stock", { id: uid(), date: TODAY(), brand: o.brand, grade: o.grade, weight_kg: -kg, bags: -o.bags, bag_kg: o.bag_kg, note: `Отгрузка: ${o.clientName}` });
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
      const kg = o.bags * o.bag_kg;
      await dbUpsert("orders", { ...o, status });
      if (status === "отгружена" && o.status !== "отгружена") {
        await dbUpsert("stock", { id: uid(), date: TODAY(), brand: o.brand, grade: o.grade, weight_kg: -kg, bags: -o.bags, bag_kg: o.bag_kg, note: `Отгрузка: ${o.clientName}` });
        await reload("stock");
      } else if (status !== "отгружена" && o.status === "отгружена") {
        await dbUpsert("stock", { id: uid(), date: TODAY(), brand: o.brand, grade: o.grade, weight_kg: kg, bags: o.bags, bag_kg: o.bag_kg, note: `Возврат (отмена отгрузки): ${o.clientName}` });
        await reload("stock");
      }
      await reload("orders");
    } catch (e) { notifyErr(e); }
  };
  const assignDriver = async (o, driverId) => { try { await dbUpsert("orders", { ...o, driverId }); await reload("orders"); } catch (e) { notifyErr(e); } };
  const deleteOrder = async (id) => { try { await dbDelete("orders", id); await reload("orders"); } catch (e) { notifyErr(e); } };

  // Действия на всю заявку клиента (несколько позиций сразу)
  const assignDriverGroup = async (g, driverId) => { try { for (const o of g.orders) await dbUpsert("orders", { ...o, driverId }); await reload("orders"); } catch (e) { notifyErr(e); } };
  const deleteGroup = async g => { if (!confirm(`Удалить всю заявку «${g.clientName}» (${g.orders.length} поз.)?`)) return; try { for (const o of g.orders) await dbDelete("orders", o.id); await reload("orders"); } catch (e) { notifyErr(e); } };
  const setGroupStatus = async (g, status) => {
    try {
      for (const o of g.orders) {
        if (o.status === status) continue;
        const kg = o.bags * o.bag_kg;
        await dbUpsert("orders", { ...o, status });
        if (status === "отгружена" && o.status !== "отгружена") await dbUpsert("stock", { id: uid(), date: TODAY(), brand: o.brand, grade: o.grade, weight_kg: -kg, bags: -o.bags, bag_kg: o.bag_kg, note: `Отгрузка: ${o.clientName}` });
        else if (status !== "отгружена" && o.status === "отгружена") await dbUpsert("stock", { id: uid(), date: TODAY(), brand: o.brand, grade: o.grade, weight_kg: kg, bags: o.bags, bag_kg: o.bag_kg, note: `Возврат: ${o.clientName}` });
      }
      await reload("stock"); await reload("orders");
    } catch (e) { notifyErr(e); }
  };
  const confirmGroup = async g => {
    try {
      for (const o of g.orders) {
        if (o.confirmed && o.status === "отгружена") continue;
        await dbUpsert("orders", { ...o, confirmed: true, status: "отгружена" });
        if (o.status !== "отгружена") { const kg = o.bags * o.bag_kg; await dbUpsert("stock", { id: uid(), date: TODAY(), brand: o.brand, grade: o.grade, weight_kg: -kg, bags: -o.bags, bag_kg: o.bag_kg, note: `Отгрузка: ${o.clientName}` }); }
      }
      await reload("stock"); await reload("orders");
    } catch (e) { notifyErr(e); }
  };
  const driverMarkGroup = async (g, val) => { try { for (const o of g.orders) await dbUpsert("orders", { ...o, delivered_by_driver: val, delivered_at: val ? new Date().toISOString() : o.delivered_at }); await reload("orders"); } catch (e) { notifyErr(e); } };

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
  vis.forEach(o => {
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
    return Object.values(m);
  })();

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
    orders.filter(o => o.status === "новая" || o.status === "в пути").forEach(o => { const k = `${o.brand}|${o.grade}|${o.bag_kg}`; need[k] = (need[k] || 0) + Number(o.bags || 0); });
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
        {dayOrders.length === 0 ? (
          <div className="text-center py-10 text-gray-400">На это число отгрузок нет</div>
        ) : (
          <div className="space-y-2">
            {dayGroups.map(g => {
              const client = clients.find(c => c.id === g.clientId);
              const driver = drivers.find(d => d.id === g.orders[0].driverId);
              const statuses = [...new Set(g.orders.map(o => o.status))];
              const gStatus = statuses.length === 1 ? statuses[0] : "частично";
              const gKg = g.orders.reduce((s, o) => s + o.bags * o.bag_kg, 0);
              const gSum = g.orders.reduce((s, o) => s + o.bags * o.bag_kg * (o.price_per_kg || 0), 0);
              const gPhotos = g.orders.flatMap(o => o.photos || []);
              const allDelivered = g.orders.every(o => o.delivered_by_driver);
              const anyClaim = g.orders.some(o => o.delivered_by_driver);
              const allConfirmed = g.orders.every(o => o.confirmed);
              const allShipped = g.orders.every(o => o.status === "отгружена");
              const firstId = g.orders[0].id;
              return (
                <div key={g.key} className="bg-white border border-gray-100 rounded-xl px-4 py-3 text-sm shadow-sm">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <span className="font-bold text-gray-900">{g.clientName || "Клиент"}{g.isSample && " 🧪"}{g.isTrial && <Badge color="yellow">🎁 на пробу</Badge>}</span>
                    <Badge color={sc[gStatus] || "gray"}>{gStatus}</Badge>
                  </div>
                  {client?.org_name && <div className="text-xs text-gray-500">🏢 {client.org_name}</div>}
                  <div className="mt-1 space-y-1">
                    {g.orders.map(o => (
                      <div key={o.id} className="text-gray-600 flex items-center gap-2 flex-wrap">
                        <span>• {o.brand} {o.grade}</span>
                        <span className="bg-amber-100 text-amber-900 font-bold px-2 py-0.5 rounded-md whitespace-nowrap">📦 {o.bags} меш. × {o.bag_kg} кг</span>
                        <span>= <b>{fmt(o.bags * o.bag_kg)} кг</b></span>
                        {o.trial ? <span className="text-orange-600 font-medium">🎁 на пробу</span> : (showPrices && o.price_per_kg ? <span className="text-gray-400">· {fmt(o.bags * o.bag_kg * o.price_per_kg)} тг</span> : null)}
                      </div>
                    ))}
                  </div>
                  {g.orders.length > 1 && <div className="text-xs text-gray-500 mt-1">Итого: <b>{fmt(gKg)} кг</b>{showPrices && gSum ? ` · ${fmt(gSum)} тг` : ""}</div>}
                  <div className="text-xs text-gray-400 mt-0.5 flex items-center gap-2 flex-wrap">
                    {clientTime(client) && <span className="bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full">⏰ {clientTime(client)}</span>}
                    {client?.gis_link && <a href={client.gis_link} target="_blank" rel="noreferrer" className="bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full">📍 2ГИС</a>}
                    {(() => { const co = client && (client.coords || parseCoordsFromGisLink(client.gis_link) || parseCoordsFromText(client.coords_manual)); return co ? <a href={buildGisRouteUrl([co])} target="_blank" rel="noreferrer" className="bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-full">🧭 Маршрут сюда</a> : null; })()}
                    {!driverMode && g.orders.some(o => !o.trial && !o.isSample) && <button onClick={() => copyToClipboard(nakladnayaText(g, client))} className="bg-violet-50 text-violet-700 px-2 py-0.5 rounded-full">📋 Для накладной</button>}
                    {g.orders[0].created_by_name && <span>✍️ {g.orders[0].created_by_name}</span>}
                  </div>
                  {gPhotos.length > 0 && (
                    <div className="flex gap-1 flex-wrap mt-2">
                      {gPhotos.map((url, i) => <img key={i} src={url} onClick={() => setPhotoView(url)} className="w-14 h-14 object-cover rounded-lg border border-gray-200 cursor-pointer" alt="фото" />)}
                    </div>
                  )}
                  {anyClaim && !allConfirmed && <div className="text-xs text-amber-600 mt-1">🚚 Водитель отметил «доставил» — ждёт подтверждения</div>}
                  {allConfirmed && <div className="text-xs text-emerald-600 mt-1">✓ Подтверждено</div>}

                  {driverMode ? (
                    <div className="flex items-center gap-2 flex-wrap mt-2 pt-2 border-t border-gray-50">
                      {allDelivered
                        ? <Btn size="sm" variant="secondary" onClick={() => driverMarkGroup(g, false)}>↩ Отменить «доставил»</Btn>
                        : <Btn size="sm" onClick={() => driverMarkGroup(g, true)}>✓ Доставил</Btn>}
                      <label className={`cursor-pointer text-xs rounded-lg px-3 py-1.5 font-medium ${uploadingId === firstId ? "bg-gray-200 text-gray-400" : "bg-gray-100 hover:bg-gray-200 text-gray-700"}`}>
                        {uploadingId === firstId ? "Загрузка..." : "📷 Фото"}
                        <input type="file" accept="image/*" capture="environment" hidden disabled={uploadingId === firstId} onChange={e => { addPhoto(g.orders[0], e.target.files[0]); e.target.value = ""; }} />
                      </label>
                    </div>
                  ) : canEdit ? (
                    <div className="flex items-center gap-2 flex-wrap mt-2 pt-2 border-t border-gray-50">
                      <select className="border border-gray-200 rounded-lg px-2 py-1 text-xs" value={g.orders[0].driverId || ""} onChange={e => assignDriverGroup(g, e.target.value)}>
                        <option value="">🚛 Водитель</option>
                        {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </select>
                      {anyClaim && !allConfirmed
                        ? <Btn size="sm" onClick={() => confirmGroup(g)}>✓ Подтвердить</Btn>
                        : (!allShipped
                          ? <Btn size="sm" onClick={() => setGroupStatus(g, "отгружена")}>✓ Доставлено</Btn>
                          : <Btn size="sm" variant="secondary" onClick={() => setGroupStatus(g, "в пути")}>↩ Не доставлено</Btn>)}
                      <Btn size="sm" variant="danger" onClick={() => deleteGroup(g)}>✕</Btn>
                    </div>
                  ) : (
                    <div className="text-xs text-gray-400 mt-1">{driver ? `🚛 ${driver.name}` : ""}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {!driverMode && dayGroups.filter(g => g.orders.some(o => !o.trial && !o.isSample)).length > 0 && (
          <div className="mt-3">
            <Btn variant="secondary" onClick={() => copyToClipboard(`Накладные на ${selected.split("-").reverse().join(".")}:\n\n` + dayGroups.map(g => nakladnayaText(g, clients.find(c => c.id === g.clientId))).filter(Boolean).join("\n\n"))}>📋 Скопировать все накладные ({dayGroups.filter(g => g.orders.some(o => !o.trial && !o.isSample)).length})</Btn>
          </div>
        )}
      </div>

      {dayOrders.length > 0 && (() => {
        // одна точка на клиента (без дублей, даже если у него несколько позиций)
        const seen = new Set();
        const points = [];
        dayOrders.forEach(o => {
          const client = clients.find(c => c.id === o.clientId);
          if (!client || seen.has(client.id)) return;
          const coords = client.coords || parseCoordsFromGisLink(client.gis_link) || parseCoordsFromText(client.coords_manual);
          if (!coords) return;
          seen.add(client.id);
          points.push({ ...coords, name: o.clientName, delivery_time: clientTime(client) });
        });

        if (points.length === 0) return (
          <div className="bg-gray-50 border border-dashed border-gray-200 rounded-2xl p-4 text-sm text-gray-400 text-center">
            Добавь координаты клиентам чтобы строить маршрут 🗺️
          </div>
        );

        const optimized = optimizeRoute(points);
        const routeUrl = buildGisRouteUrl(optimized);
        const totalDist = [WAREHOUSE, ...optimized].reduce((acc, p, i, arr) => i === 0 ? 0 : acc + distKm(arr[i - 1], p), 0);

        return (
          <div className="bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200 rounded-2xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="font-bold text-gray-800">🗺️ Маршрут на {selected.split("-").reverse().join(".")}</div>
                <div className="text-xs text-gray-500">{points.length} точек · ~{Math.round(totalDist)} км</div>
              </div>
              <a href={routeUrl} target="_blank" rel="noreferrer"
                className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-xl transition-all">
                Открыть в 2ГИС →
              </a>
            </div>
            <div className="space-y-1">
              {[{ name: "📦 Best Mill (склад)", delivery_time: "" }, ...optimized].map((p, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold flex-shrink-0">{i}</span>
                  <span className="text-gray-700">{p.name}</span>
                  {p.delivery_time && <span className="text-xs text-blue-600 ml-auto">⏰ {p.delivery_time}</span>}
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {photoView && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.85)" }} onClick={() => setPhotoView(null)}>
          <img src={photoView} className="max-w-full max-h-full rounded-lg" alt="фото" />
          <button className="absolute top-4 right-4 text-white text-3xl" onClick={() => setPhotoView(null)}>&times;</button>
        </div>
      )}
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
              : <div className="col-span-2"><Sel label="Клиент" value={form.clientId} onChange={e => setForm({ ...form, clientId: e.target.value })} options={[{ value: "", label: "— выбери клиента —" }, ...clients.map(c => ({ value: c.id, label: c.name }))]} /></div>}
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

function StockTab({ stock, orders = [], reload }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);
  const [saving, setSaving] = useState(false);
  const blank = { date: TODAY(), brand: BRANDS[0], grade: GRADES[0], bag_kg: 50, bags: "", price_per_kg: "", note: "", op: "in", reason: WRITEOFF_REASONS[0] };
  const [form, setForm] = useState(blank);

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

  // Сколько мешков «забронировано» заявками, которые ещё НЕ отгружены (новая + в пути).
  // При отгрузке склад списывается автоматически, поэтому здесь только будущий спрос.
  const reserved = {};
  orders.filter(o => o.status === "новая" || o.status === "в пути").forEach(o => {
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
      <div className="flex items-center justify-between"><h3 className="font-bold text-gray-800">Остатки на складе</h3><Btn onClick={openNew}>+ Операция</Btn></div>
      <p className="text-sm text-gray-500">Чтобы внести то, что уже есть на складе — нажми «+ Операция» → «Приход» и укажи текущее число мешков по каждому виду.</p>
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
      <div className="grid grid-cols-1 gap-3">
        {Object.values(balances).map((b, i) => {
          const need = reserved[`${b.brand}|${b.grade}|${b.bag_kg}`] || 0;
          const short = need > Math.max(0, b.bags);
          return (
          <div key={i} className={`rounded-2xl p-4 border ${short ? "bg-red-50 border-red-300" : b.kg <= 0 ? "bg-red-50 border-red-200" : "bg-white border-gray-100 shadow-sm"}`}>
            <div className="flex items-center justify-between">
              <div><div className="font-bold text-gray-900">{b.brand} · {b.grade}</div><div className="text-sm text-gray-500">Мешки по {b.bag_kg} кг</div></div>
              <div className="text-right"><div className={`text-2xl font-bold ${b.kg <= 0 ? "text-red-600" : "text-emerald-600"}`}>{fmt(Math.max(0, b.kg))} кг</div><div className="text-sm text-gray-400">{Math.max(0, b.bags)} мешков</div></div>
            </div>
            {need > 0 && (
              <div className={`text-sm mt-2 ${short ? "text-red-700 font-semibold" : "text-gray-500"}`}>
                📋 В заявках (не отгружено): {need} меш.{short && ` · не хватает ${need - Math.max(0, b.bags)} меш.`}
              </div>
            )}
          </div>
          );
        })}
        {Object.keys(balances).length === 0 && <div className="text-center py-12 text-gray-400">Склад пуст.</div>}
      </div>
      <div>
        <h4 className="font-semibold text-gray-700 mb-3">История движений</h4>
        <div className="space-y-2">
          {[...stock].reverse().slice(0, 30).map(s => (
            <div key={s.id} className="flex items-center justify-between bg-white border border-gray-100 rounded-xl px-4 py-3 text-sm">
              <div className="min-w-0">
                <span className={s.weight_kg > 0 ? "text-emerald-600 font-medium" : "text-red-500 font-medium"}>{s.weight_kg > 0 ? "▲ Приход" : "▼ Расход"}</span>
                <span className="text-gray-600 ml-2">{s.brand} {s.grade} {s.bag_kg}кг</span>
                {s.reason && <span className="text-red-400 ml-2">· {s.reason}</span>}
                {s.note && <span className="text-gray-400 ml-2">· {s.note}</span>}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <div className="text-right"><div className="font-medium">{s.weight_kg > 0 ? "+" : ""}{fmt(s.weight_kg)} кг</div><div className="text-gray-400 text-xs">{s.date}</div></div>
                <button onClick={() => openEdit(s)} className="text-gray-400 hover:text-gray-700" title="Изменить">✏️</button>
                <button onClick={() => deleteMovement(s.id)} className="text-red-400 hover:text-red-600" title="Удалить">✕</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ClientsTab({ clients, orders = [], reload }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolveErr, setResolveErr] = useState("");
  const [historyClient, setHistoryClient] = useState(null);
  const [form, setForm] = useState({ name: "", address: "", contact: "", prices: [] });
  const [pf, setPf] = useState({ brand: BRANDS[0], grade: GRADES[0], bag_kg: 50, price_per_kg: "" });

  // Долг клиента = отгружено и не оплачено
  const clientDebt = c => orders.filter(o => o.clientId === c.id && o.status === "отгружена" && !o.paid).reduce((s, o) => s + o.bags * o.bag_kg * (o.price_per_kg || 0), 0);
  // Отметить поставку (все позиции за дату) оплаченной — с указанием способа (нал/безнал)
  const markPaid = async (clientId, date, paid, method = "") => {
    try {
      for (const o of orders.filter(o => o.clientId === clientId && o.date === date)) await dbUpsert("orders", { ...o, paid, pay_method: paid ? method : "" });
      await reload("orders");
    } catch (e) { alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз."); }
  };

  const openEdit = c => { setEditId(c.id); setResolveErr(""); setForm({ name: c.name, org_name: c.org_name || "", contact_name: c.contact_name || "", address: c.address, contact: c.contact || "", default_bag_kg: c.default_bag_kg || "", default_brand: c.default_brand || "", gis_link: c.gis_link || "", coords: c.coords || null, coords_manual: c.coords_manual || "", delivery_time: c.delivery_time || "", delivery_from: c.delivery_from || "", delivery_to: c.delivery_to || "", prices: c.prices || [] }); setShowAdd(true); };
  const openNew = () => { setEditId(null); setResolveErr(""); setForm({ name: "", org_name: "", contact_name: "", address: "", contact: "", default_bag_kg: "", default_brand: "", gis_link: "", coords: null, coords_manual: "", delivery_time: "", delivery_from: "", delivery_to: "", prices: [] }); setShowAdd(true); };

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

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between"><h3 className="font-bold text-gray-800">Клиенты ({clients.length})</h3><Btn onClick={openNew}>+ Новый клиент</Btn></div>
      {showAdd && (
        <Modal title={editId ? "Редактировать" : "Новый клиент"} onClose={() => setShowAdd(false)}>
          <div className="space-y-3">
            <Inp label="Название заведения" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Мамыр" />
            <Inp label="Организация (ИП / ТОО)" value={form.org_name} onChange={e => setForm({ ...form, org_name: e.target.value })} placeholder="ИП Салават" />
            <Inp label="Имя контакта (кто пишет)" value={form.contact_name} onChange={e => setForm({ ...form, contact_name: e.target.value })} placeholder="Азиз" />
            <Inp label="Адрес доставки" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} />
            <Inp label="WhatsApp" value={form.contact} onChange={e => setForm({ ...form, contact: e.target.value })} />
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
        {clients.map(c => {
          const debt = clientDebt(c);
          return (
          <div key={c.id} className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm">
            <div className="flex items-start justify-between">
              <div>
                <div className="font-bold text-gray-900">{c.name}{debt > 0 && <span className="ml-2 text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full align-middle">долг {fmt(debt)} тг</span>}</div>
                {c.org_name && <div className="text-sm text-gray-500">🏢 {c.org_name}</div>}
                {c.contact_name && <div className="text-sm text-gray-500">👤 {c.contact_name}</div>}
                {c.address && <div className="text-sm text-gray-500">📍 {c.address}</div>}
                {c.contact && <div className="text-sm text-gray-500">📱 {c.contact}</div>}
                {(c.default_bag_kg || c.default_brand) && <div className="text-xs text-amber-700 bg-amber-50 rounded-lg px-2 py-1 mt-1 inline-block">📦 {c.default_brand || "—"} · {c.default_bag_kg ? c.default_bag_kg + " кг мешки" : "фасовка не указана"}</div>}
                {(c.prices || []).length > 0 && <div className="flex flex-wrap gap-1 mt-2">{c.prices.map((p, i) => <span key={i} className="bg-amber-50 text-amber-800 text-xs px-2 py-0.5 rounded-full">{p.brand} {p.grade} {p.bag_kg}кг — {fmt(p.price_per_kg)}тг</span>)}</div>}
              </div>
              <div className="flex gap-1"><Btn size="sm" variant="secondary" onClick={() => openEdit(c)}>✏️</Btn><Btn size="sm" variant="danger" onClick={() => deleteClient(c.id)}>✕</Btn></div>
            </div>
            <Btn size="sm" variant="secondary" onClick={() => setHistoryClient(c)}>📋 История и оплаты</Btn>
          </div>
          );
        })}
      </div>

      {historyClient && (() => {
        const co = orders.filter(o => o.clientId === historyClient.id).sort((a, b) => b.date.localeCompare(a.date));
        const byDate = {};
        co.forEach(o => { (byDate[o.date] = byDate[o.date] || []).push(o); });
        const delivered = co.filter(o => o.status === "отгружена");
        const totalDelivered = delivered.reduce((s, o) => s + o.bags * o.bag_kg * (o.price_per_kg || 0), 0);
        const totalPaid = delivered.filter(o => o.paid).reduce((s, o) => s + o.bags * o.bag_kg * (o.price_per_kg || 0), 0);
        const debt = totalDelivered - totalPaid;
        return (
          <Modal title={`📋 ${historyClient.name}`} onClose={() => setHistoryClient(null)}>
            <div className="text-sm mb-3 space-y-0.5 bg-gray-50 rounded-xl p-3">
              <div>Отгружено всего: <b>{fmt(totalDelivered)} тг</b></div>
              <div className="text-emerald-600">Оплачено: {fmt(totalPaid)} тг</div>
              <div className={debt > 0 ? "text-red-600 font-bold" : "text-gray-500"}>Долг: {fmt(debt)} тг</div>
            </div>
            <div className="space-y-2 max-h-96 overflow-y-auto">
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
                        ? <div className="flex items-center gap-2 flex-wrap"><span className="text-emerald-700 font-medium text-xs">✓ Оплачено{method ? ` · ${method}` : ""}</span><Btn size="sm" variant="ghost" onClick={() => markPaid(historyClient.id, date, false)}>отменить</Btn></div>
                        : <div className="flex gap-2 flex-wrap"><Btn size="sm" onClick={() => markPaid(historyClient.id, date, true, "Нал")}>💵 Нал</Btn><Btn size="sm" variant="secondary" onClick={() => markPaid(historyClient.id, date, true, "Безнал")}>💳 Безнал</Btn></div>}
                    </div>
                  </div>
                );
              })}
              {co.length === 0 && <div className="text-gray-400 text-center py-6">Отгрузок ещё не было</div>}
            </div>
          </Modal>
        );
      })()}
    </div>
  );
}

function DriversTab({ drivers, orders, expenses = [], reload }) {
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", rate_per_kg: "" });
  const [payDriver, setPayDriver] = useState(null);
  const [payAmount, setPayAmount] = useState("");
  const [payDate, setPayDate] = useState(TODAY());
  const [historyDriver, setHistoryDriver] = useState(null);

  const saveDriver = async () => {
    setSaving(true);
    try { await dbUpsert("drivers", { id: uid(), name: form.name, rate_per_kg: Number(form.rate_per_kg) }); setShowAdd(false); setForm({ name: "", rate_per_kg: "" }); await reload("drivers"); } catch (e) { alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз."); }
    setSaving(false);
  };
  const deleteDriver = async id => { if (!confirm("Удалить водителя?")) return; await dbDelete("drivers", id); await reload("drivers"); };

  // Заработал (по доставленным × ставка) и выплачено (расходы кат. «Водители» с этим driverId)
  const earnings = {};
  orders.filter(o => o.status === "отгружена" && o.driverId).forEach(o => { const d = drivers.find(x => x.id === o.driverId); if (d) earnings[o.driverId] = (earnings[o.driverId] || 0) + o.bags * o.bag_kg * (d.rate_per_kg || 0); });
  const paidByDriver = {};
  expenses.filter(x => x.driverId).forEach(x => { paidByDriver[x.driverId] = (paidByDriver[x.driverId] || 0) + (x.amount || 0); });

  const openPay = d => { setPayDriver(d); setPayAmount(String(Math.max(0, Math.round((earnings[d.id] || 0) - (paidByDriver[d.id] || 0))))); setPayDate(TODAY()); };
  const doPay = async () => {
    if (!payAmount) return;
    setSaving(true);
    try { await dbUpsert("expenses", { id: uid(), date: payDate, category: "Водители", driverId: payDriver.id, amount: Number(payAmount), note: `Оплата водителю ${payDriver.name}` }); setPayDriver(null); await reload("expenses"); }
    catch (e) { alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз."); }
    setSaving(false);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between"><h3 className="font-bold text-gray-800">Водители</h3><Btn onClick={() => setShowAdd(true)}>+ Водитель</Btn></div>
      {showAdd && (<Modal title="Новый водитель" onClose={() => setShowAdd(false)}>
        <div className="space-y-3"><Inp label="Имя" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /><Inp label="Ставка тг/кг" type="number" value={form.rate_per_kg} onChange={e => setForm({ ...form, rate_per_kg: e.target.value })} /></div>
        <div className="flex gap-2 mt-4"><Btn onClick={saveDriver} disabled={saving}>{saving ? "Сохраняю..." : "Сохранить"}</Btn><Btn variant="secondary" onClick={() => setShowAdd(false)}>Отмена</Btn></div>
      </Modal>)}
      {payDriver && (<Modal title={`Выплата: ${payDriver.name}`} onClose={() => setPayDriver(null)}>
        <div className="space-y-3">
          <div className="text-sm bg-gray-50 rounded-xl p-3">Заработал: <b>{fmt(earnings[payDriver.id] || 0)} тг</b> · Выплачено: {fmt(paidByDriver[payDriver.id] || 0)} тг · Осталось: <b className="text-red-600">{fmt(Math.max(0, (earnings[payDriver.id] || 0) - (paidByDriver[payDriver.id] || 0)))} тг</b></div>
          <Inp label="Дата" type="date" value={payDate} onChange={e => setPayDate(e.target.value)} />
          <Inp label="Сумма выплаты, тг" type="number" value={payAmount} onChange={e => setPayAmount(e.target.value)} />
        </div>
        <div className="flex gap-2 mt-4"><Btn onClick={doPay} disabled={saving || !payAmount}>{saving ? "Сохраняю..." : "💵 Выплатить"}</Btn><Btn variant="secondary" onClick={() => setPayDriver(null)}>Отмена</Btn></div>
      </Modal>)}
      {historyDriver && (() => {
        const pays = expenses.filter(x => x.driverId === historyDriver.id).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
        const total = pays.reduce((s, x) => s + (x.amount || 0), 0);
        return (<Modal title={`Выплаты: ${historyDriver.name}`} onClose={() => setHistoryDriver(null)}>
          <div className="text-sm mb-3 bg-gray-50 rounded-xl p-3">Всего выплачено: <b>{fmt(total)} тг</b></div>
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {pays.length === 0 && <div className="text-gray-400 text-center py-6">Выплат ещё не было</div>}
            {pays.map(x => <div key={x.id} className="flex items-center justify-between border border-gray-100 rounded-xl px-3 py-2 text-sm"><span className="text-gray-500">{(x.date || "").split("-").reverse().join(".")}</span><span className="font-medium">{fmt(x.amount)} тг</span></div>)}
          </div>
        </Modal>);
      })()}
      <div className="space-y-3">
        {drivers.length === 0 && <div className="text-center py-12 text-gray-400">Водителей нет.</div>}
        {drivers.map(d => {
          const kg = orders.filter(o => o.driverId === d.id && o.status === "отгружена").reduce((s, o) => s + o.bags * o.bag_kg, 0);
          const earned = earnings[d.id] || 0;
          const paid = paidByDriver[d.id] || 0;
          const left = earned - paid;
          return (
            <div key={d.id} className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm">
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-bold text-gray-900">🚛 {d.name}</div>
                  <div className="text-sm text-gray-500">Ставка: {fmt(d.rate_per_kg)} тг/кг · доставлено {fmt(kg)} кг</div>
                  <div className="text-sm mt-1">Заработал: <b>{fmt(earned)} тг</b> · выплачено: <span className="text-emerald-600">{fmt(paid)} тг</span></div>
                  <div className={`text-sm font-bold ${left > 0 ? "text-red-600" : "text-gray-500"}`}>Осталось: {fmt(Math.max(0, left))} тг</div>
                </div>
                <Btn size="sm" variant="danger" onClick={() => deleteDriver(d.id)}>✕</Btn>
              </div>
              <div className="flex gap-2 mt-3">
                <Btn size="sm" onClick={() => openPay(d)}>💵 Выплатить</Btn>
                <Btn size="sm" variant="secondary" onClick={() => setHistoryDriver(d)}>📋 История выплат</Btn>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ReportsTab({ orders, drivers, stock = [], expenses = [] }) {
  const [period, setPeriod] = useState("month");
  const [view, setView] = useState("product");
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
  const recentDel = orders.filter(o => o.status === "отгружена" && new Date(o.date) >= cutoffD);
  const demandWD = {};
  recentDel.forEach(o => { const wd = new Date(o.date).getDay(); const p = `${o.brand} ${o.grade}`; (demandWD[wd] = demandWD[wd] || {})[p] = (demandWD[wd][p] || 0) + o.bags * o.bag_kg; });
  const expectedWk = {};
  for (let i = 1; i <= 7; i++) { const d = new Date(now); d.setDate(d.getDate() + i); const m = demandWD[d.getDay()] || {}; Object.entries(m).forEach(([p, kg]) => { expectedWk[p] = (expectedWk[p] || 0) + kg / 8; }); }
  const stockByProd = {};
  stock.forEach(s => { const p = `${s.brand} ${s.grade}`; stockByProd[p] = (stockByProd[p] || 0) + s.weight_kg; });
  const restock = Object.entries(expectedWk).map(([p, kg]) => ({ p, exp: Math.round(kg), st: Math.round(stockByProd[p] || 0) })).filter(x => x.exp > 0).sort((a, b) => (b.exp - b.st) - (a.exp - a.st));
  const byClientWD = {};
  recentDel.forEach(o => { const c = o.clientName || "?"; const wd = new Date(o.date).getDay(); const k = byClientWD[c] = byClientWD[c] || {}; const v = k[wd] = k[wd] || { kg: 0, days: new Set() }; v.kg += o.bags * o.bag_kg; v.days.add(o.date); });
  const regulars = [];
  Object.entries(byClientWD).forEach(([c, wds]) => { let best = null; Object.entries(wds).forEach(([wd, v]) => { if (!best || v.days.size > best.days.size) best = { wd: +wd, ...v }; }); if (best && best.days.size >= 2) regulars.push({ c, wd: best.wd, avg: Math.round(best.kg / best.days.size) }); });
  regulars.sort((a, b) => b.avg - a.avg);

  const ds = {};
  delivered.forEach(o => { if (!o.driverId) return; const d = drivers.find(x => x.id === o.driverId); if (!d) return; if (!ds[o.driverId]) ds[o.driverId] = { name: d.name, kg: 0, pay: 0 }; const kg = o.bags * o.bag_kg; ds[o.driverId].kg += kg; ds[o.driverId].pay += kg * d.rate_per_kg; });
  const totalPay = Object.values(ds).reduce((s, d) => s + d.pay, 0);
  const bp = {}, bw = {}, bc = {};
  delivered.forEach(o => {
    const kg = o.bags * o.bag_kg; const rev = kg * (o.price_per_kg || 0);
    const pk = `${o.brand} · ${o.grade}`; if (!bp[pk]) bp[pk] = { kg: 0, revenue: 0, orders: 0 }; bp[pk].kg += kg; bp[pk].revenue += rev; bp[pk].orders += 1;
    const wk = `${o.bag_kg} кг мешки`; if (!bw[wk]) bw[wk] = { kg: 0, bags: 0 }; bw[wk].kg += kg; bw[wk].bags += o.bags;
    const ck = o.clientName || "?"; if (!bc[ck]) bc[ck] = { kg: 0, revenue: 0 }; bc[ck].kg += kg; bc[ck].revenue += rev;
  });
  const pl = Object.entries(bp).sort((a, b) => b[1].kg - a[1].kg);
  const wl = Object.entries(bw).sort((a, b) => b[1].kg - a[1].kg);
  const cl = Object.entries(bc).sort((a, b) => b[1].kg - a[1].kg);
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
                <div className="text-xs font-semibold text-gray-500 mb-1">Ожидается на неделю vs склад</div>
                <div className="space-y-0.5 text-sm">
                  {restock.map(x => { const need = x.exp - x.st; return (
                    <div key={x.p} className="flex items-center justify-between">
                      <span>{x.p}</span>
                      <span className={need > 0 ? "text-red-600 font-medium" : "text-gray-500"}>ожид. ~{fmt(x.exp)} · склад {fmt(x.st)}{need > 0 ? ` → докупить ~${fmt(need)} кг` : " ✓"}</span>
                    </div>
                  ); })}
                </div>
              </div>
            )}
          </>
        )}
        <div className="mt-3 pt-3 border-t border-violet-100">
          <Btn size="sm" onClick={getAdvice} disabled={adviceLoading}>{adviceLoading ? "Думаю..." : "🤖 Совет на неделю"}</Btn>
          {advice && <div className="mt-2 bg-white rounded-xl p-3 text-sm text-gray-700 whitespace-pre-wrap">{advice}</div>}
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

function TrucksTab({ trucks, reload }) {
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [f, setF] = useState({ date: TODAY(), driver_name: "", car_number: "", whatsapp: "", logist_phone: "", price: "", note: "" });
  const [items, setItems] = useState([]);
  const [it, setIt] = useState({ brand: BRANDS[0], grade: GRADES[0], bag_kg: 50, tonnes: "" });

  const reset = () => { setF({ date: TODAY(), driver_name: "", car_number: "", whatsapp: "", logist_phone: "", price: "", note: "" }); setItems([]); setIt({ brand: BRANDS[0], grade: GRADES[0], bag_kg: 50, tonnes: "" }); };
  const addItem = () => { if (!it.tonnes) return; setItems([...items, { ...it, bag_kg: Number(it.bag_kg), tonnes: Number(it.tonnes) }]); setIt({ brand: BRANDS[0], grade: GRADES[0], bag_kg: 50, tonnes: "" }); };
  const removeItem = i => setItems(items.filter((_, j) => j !== i));

  const saveTruck = async () => {
    if (items.length === 0) return;
    setSaving(true);
    try { await dbUpsert("trucks", { id: uid(), ...f, price: Number(f.price) || 0, items, status: "запланирована" }); setShowAdd(false); reset(); await reload("trucks"); }
    catch (e) { alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз."); }
    setSaving(false);
  };

  // Смена статуса. При «принята» — позиции падают на склад приходом, а цена фуры идёт в расходы.
  const setTruckStatus = async (t, status) => {
    if (t.status === status) return;
    setSaving(true);
    try {
      if (status === "принята" && t.status !== "принята") {
        for (const item of t.items) { const weight_kg = item.tonnes * 1000; const bags = item.bag_kg > 0 ? Math.round(weight_kg / item.bag_kg) : 0; await dbUpsert("stock", { id: uid(), date: TODAY(), brand: item.brand, grade: item.grade, bag_kg: item.bag_kg, bags, weight_kg, price_per_kg: 0, note: `Приход (фура от ${t.date})` }); }
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

  const totalTonnes = t => t.items.reduce((s, i) => s + i.tonnes, 0);
  const sorted = [...trucks].sort((a, b) => ((a.status === "принята") === (b.status === "принята") ? (b.date || "").localeCompare(a.date || "") : a.status === "принята" ? 1 : -1));
  const waLink = n => "https://wa.me/" + String(n || "").replace(/\D/g, "");

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between"><h3 className="font-bold text-gray-800">Поставки (фуры)</h3><Btn onClick={() => { reset(); setShowAdd(true); }}>+ Запланировать фуру</Btn></div>
      {showAdd && (
        <Modal title="Новая фура" onClose={() => setShowAdd(false)}>
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
                <Inp type="number" placeholder="тонн" value={it.tonnes} onChange={e => setIt({ ...it, tonnes: e.target.value })} />
              </div>
              <Btn size="sm" variant="secondary" onClick={addItem}>+ Добавить позицию</Btn>
              {items.length > 0 && <div className="mt-2 space-y-1">{items.map((p, i) => <div key={i} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 text-sm"><span>{p.brand} · {p.grade} · {p.bag_kg}кг</span><span className="font-medium">{fmt(p.tonnes)} т</span><button className="text-red-400 hover:text-red-600" onClick={() => removeItem(i)}>✕</button></div>)}</div>}
            </div>
            <Inp label="Примечание" value={f.note} onChange={e => setF({ ...f, note: e.target.value })} />
          </div>
          <div className="flex gap-2 mt-4">
            <Btn onClick={saveTruck} disabled={saving || items.length === 0}>{saving ? "Сохраняю..." : "Запланировать"}</Btn>
            <Btn variant="secondary" onClick={() => setShowAdd(false)}>Отмена</Btn>
          </div>
        </Modal>
      )}
      <div className="space-y-3">
        {trucks.length === 0 && <div className="text-center py-12 text-gray-400">Фур пока нет.</div>}
        {sorted.map(t => (
          <div key={t.id} className={`rounded-2xl p-4 border ${t.status === "принята" ? "bg-white border-gray-100 shadow-sm" : "bg-amber-50 border-amber-200"}`}>
            <div className="flex items-center justify-between mb-2">
              <div className="font-bold text-gray-900">🚚 Фура на {t.date} <span className="text-sm font-normal text-gray-500">· {fmt(totalTonnes(t))} т{t.price ? ` · ${fmt(t.price)} тг` : ""}</span></div>
              <Badge color={t.status === "принята" ? "green" : t.status === "в пути" ? "yellow" : "blue"}>{t.status}</Badge>
            </div>
            <div className="space-y-1 text-sm text-gray-600">
              {t.items.map((p, i) => <div key={i}>• {p.brand} {p.grade} {p.bag_kg}кг — {fmt(p.tonnes)} т ({fmt(Math.round(p.tonnes * 1000 / p.bag_kg))} мешков)</div>)}
            </div>
            {(t.driver_name || t.car_number || t.whatsapp || t.logist_phone) && (
              <div className="text-xs text-gray-500 mt-2 space-y-0.5">
                {(t.driver_name || t.car_number) && <div>👤 {t.driver_name}{t.car_number ? ` · 🚛 ${t.car_number}` : ""}</div>}
                {t.whatsapp && <div>📱 <a href={waLink(t.whatsapp)} target="_blank" rel="noreferrer" className="text-emerald-600">{t.whatsapp}</a></div>}
                {t.logist_phone && <div>📞 Логист: {t.logist_phone}</div>}
              </div>
            )}
            {t.note && <div className="text-xs text-gray-400 mt-1">{t.note}</div>}
            {t.status !== "принята" && (
              <div className="flex gap-1 flex-wrap mt-3 items-center">
                <span className="text-xs text-gray-400">Статус:</span>
                {["грузится", "в пути", "разгрузка"].map(s => <button key={s} onClick={() => setTruckStatus(t, s)} className={`text-xs px-2 py-1 rounded-lg ${t.status === s ? "bg-amber-500 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>{s}</button>)}
                <Btn size="sm" onClick={() => setTruckStatus(t, "принята")} disabled={saving}>✓ Принять на склад</Btn>
              </div>
            )}
            <div className="mt-2"><Btn size="sm" variant="danger" onClick={() => deleteTruck(t.id)}>Удалить</Btn></div>
          </div>
        ))}
      </div>
    </div>
  );
}

function UsersTab({ users, drivers, reload, currentUser }) {
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
  const deleteUser = async id => { await dbDelete("users", id); await reload("users"); };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between"><h3 className="font-bold text-gray-800">Пользователи</h3><Btn onClick={openNew}>+ Добавить</Btn></div>
      <p className="text-sm text-gray-500">Директор — всё. Бухгалтер — просмотр календаря и отчётов с ценами/реквизитами для накладных. Водитель — видит только свои отгрузки (день, что, куда, объём), без цен.</p>
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
              </div>
              <div className="flex gap-1">
                <Btn size="sm" variant="secondary" onClick={() => openEdit(u)}>✏️</Btn>
                {u.id !== currentUser.id && <Btn size="sm" variant="danger" onClick={() => deleteUser(u.id)}>✕</Btn>}
              </div>
            </div>
          );
        })}
      </div>
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

function ExpensesTab({ expenses, reload, openSignal = 0 }) {
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
      <div className="flex items-center justify-between"><h3 className="font-bold text-gray-800">Расходы</h3><Btn onClick={openNew}>+ Расход</Btn></div>
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
            <div className="flex gap-1"><Btn size="sm" variant="secondary" onClick={() => openEdit(x)}>✏️</Btn><Btn size="sm" variant="danger" onClick={() => del(x.id)}>✕</Btn></div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TodayTab({ orders, clients, reload, driverFilter = null, onManual = () => {}, canEdit = true }) {
  const [aiText, setAiText] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState(null);
  const [aiError, setAiError] = useState("");
  const [saving, setSaving] = useState(false);

  const vis = driverFilter != null ? orders.filter(o => o.driverId === driverFilter) : orders;
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
    return Object.values(m);
  })();

  const sc = { "новая": "blue", "в пути": "yellow", "отгружена": "green", "отменена": "red", "частично": "gray" };
  const priceFor = (client, brand, grade, bag_kg) => (client?.prices || []).find(p => p.brand === brand && p.grade === grade && p.bag_kg === Number(bag_kg))?.price_per_kg || null;

  const handleAI = async () => {
    if (!aiText.trim()) return;
    setAiLoading(true); setAiError(""); setAiResult(null);
    try {
      const parsed = await parseOrderWithAI(aiText, clients);
      setAiResult(parsed.map(p => {
        const found = clients.find(c => c.name.toLowerCase().includes(p.clientName.toLowerCase()) || p.clientName.toLowerCase().includes(c.name.toLowerCase()));
        return { ...p, trial: !!p.trial, clientId: found?.id || null, clientFound: found?.name || p.clientName, price_per_kg: p.trial ? 0 : (found ? priceFor(found, p.brand, p.grade, p.bag_kg) : null) };
      }));
    } catch { setAiError("Не удалось разобрать. Попробуй ещё раз."); }
    setAiLoading(false);
  };
  const confirmAI = async () => {
    setSaving(true);
    try {
      for (const p of aiResult) await dbUpsert("orders", { id: uid(), date: p.date, clientId: p.clientId, clientName: p.clientFound, brand: p.brand, grade: p.grade, bag_kg: p.bag_kg, bags: p.bags, price_per_kg: p.trial ? 0 : p.price_per_kg, trial: !!p.trial, driverId: "", status: "новая" });
      setAiResult(null); setAiText(""); await reload("orders");
    } catch (e) { setAiError("Ошибка: " + (e && e.message ? e.message : e)); }
    setSaving(false);
  };

  // Смена статуса доставки — со списанием/возвратом склада, как в Календаре
  const notifyErr = e => alert("⚠️ Не сохранилось: " + (e && e.message ? e.message : e) + "\nПроверь интернет и попробуй ещё раз.");
  const setGroupStatus = async (g, status) => {
    try {
      for (const o of g.orders) {
        if (o.status === status) continue;
        const kg = o.bags * o.bag_kg;
        await dbUpsert("orders", { ...o, status });
        if (status === "отгружена" && o.status !== "отгружена") await dbUpsert("stock", { id: uid(), date: TODAY(), brand: o.brand, grade: o.grade, weight_kg: -kg, bags: -o.bags, bag_kg: o.bag_kg, note: `Отгрузка: ${o.clientName}` });
        else if (status !== "отгружена" && o.status === "отгружена") await dbUpsert("stock", { id: uid(), date: TODAY(), brand: o.brand, grade: o.grade, weight_kg: kg, bags: o.bags, bag_kg: o.bag_kg, note: `Возврат: ${o.clientName}` });
      }
      await reload("stock"); await reload("orders");
    } catch (e) { notifyErr(e); }
  };
  // Перенести доставку на другую дату (если сегодня не получилось отгрузить)
  const rescheduleGroup = async (g, date) => { if (!date) return; try { for (const o of g.orders) await dbUpsert("orders", { ...o, date }); await reload("orders"); } catch (e) { notifyErr(e); } };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-4"><div className="text-sm text-gray-500">Заявки сегодня</div><div className="text-3xl font-black text-gray-900">{groupCount(todayList)}</div></div>
        <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-4"><div className="text-sm text-gray-500">На завтра</div><div className="text-3xl font-black text-gray-900">{groupCount(tomorrowList)}</div></div>
      </div>

      <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-4">
        <div className="font-semibold text-gray-800 mb-2">📲 Разобрать заявку из WhatsApp</div>
        <textarea value={aiText} onChange={e => setAiText(e.target.value)} rows={3} placeholder="Вставь сюда сообщение из WhatsApp, напр.: Сегафредо 500 кг высший сорт на завтра" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-amber-300" />
        {aiError && <div className="text-sm text-red-500 mt-2">{aiError}</div>}
        <div className="mt-2 flex gap-2">
          <button onClick={handleAI} disabled={aiLoading || !aiText.trim()} style={{ flex: 2 }} className="bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded-lg font-medium px-4 py-2.5 text-sm">{aiLoading ? "Разбираю..." : "📲 Разобрать"}</button>
          <button onClick={onManual} style={{ flex: 1 }} className="bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg font-medium px-3 py-2.5 text-sm whitespace-nowrap">✍️ Вручную</button>
        </div>
        {aiResult && (
          <div className="mt-3 border-t border-gray-100 pt-3 space-y-2">
            {aiResult.map((p, i) => (
              <div key={i} className="bg-gray-50 rounded-xl p-3 text-sm">
                <div className="flex items-center gap-2 flex-wrap"><span className="font-semibold">{p.clientFound}</span>{!p.clientId && <Badge color="red">Не в базе</Badge>}{p.trial && <Badge color="yellow">🎁 на пробу</Badge>}</div>
                <div className="text-gray-600">{p.brand} · {p.grade} · {p.bag_kg}кг × {p.bags} = {fmt(p.bags * p.bag_kg)} кг</div>
                <div className="text-gray-600">Дата: {p.date} · {p.trial ? <span className="text-orange-600 font-medium">бесплатно</span> : (p.price_per_kg ? fmt(p.price_per_kg) + " тг/кг" : <span className="text-red-500">цена не найдена</span>)}</div>
              </div>
            ))}
            <div className="flex gap-2">
              <button onClick={confirmAI} disabled={saving} className="flex-1 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded-lg font-medium px-4 py-2.5 text-sm">{saving ? "Сохраняю..." : "Добавить все"}</button>
              <button onClick={() => setAiResult(null)} className="bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg font-medium px-4 py-2.5 text-sm">Отмена</button>
            </div>
          </div>
        )}
      </div>

      <div>
        <h4 className="font-semibold text-gray-700 mb-2">Доставки сегодня</h4>
        {todayGroups.length === 0 ? (
          <div className="text-center py-8 text-gray-400 bg-white border border-gray-100 rounded-2xl">На сегодня доставок нет.</div>
        ) : (
          <div className="space-y-2">
            {todayGroups.map(g => {
              const statuses = [...new Set(g.orders.map(o => o.status))];
              const st = statuses.length === 1 ? statuses[0] : "частично";
              const shipped = st === "отгружена";
              const allNew = g.orders.every(o => o.status === "новая");
              const allRoute = g.orders.every(o => o.status === "в пути");
              return (
                <div key={g.key} className={`rounded-2xl p-4 border ${shipped ? "bg-emerald-50 border-emerald-300" : "bg-white border-gray-100 shadow-sm"}`}>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="font-bold text-gray-900 flex items-center gap-1.5">{shipped && <span className="text-emerald-600 text-lg">✓</span>}{g.clientName || "Клиент"}{g.isTrial && <span className="text-xs font-medium text-orange-700 bg-orange-100 px-2 py-0.5 rounded-full">🎁 на пробу</span>}</span>
                    {shipped ? <span className="text-xs font-bold bg-emerald-600 text-white px-3 py-1 rounded-full whitespace-nowrap">✓ Отгружено</span> : <Badge color={sc[st] || "gray"}>{st}</Badge>}
                  </div>
                  <div className="space-y-1">
                    {g.orders.map(o => (
                      <div key={o.id} className="flex items-center gap-2 flex-wrap text-sm">
                        <span className="bg-amber-100 text-amber-900 font-bold px-2 py-0.5 rounded-md whitespace-nowrap">📦 {o.bags} меш. × {o.bag_kg} кг</span>
                        <span className="text-gray-600">= <b>{fmt(o.bags * o.bag_kg)} кг</b> · {o.brand} {o.grade}</span>
                      </div>
                    ))}
                  </div>
                  {canEdit && (
                    <div className="mt-3 space-y-2">
                      <div className="flex gap-2 flex-wrap">
                        {allNew && <Btn size="sm" variant="secondary" onClick={() => setGroupStatus(g, "в пути")}>🚚 В путь</Btn>}
                        {(allNew || allRoute) && <Btn size="sm" onClick={() => setGroupStatus(g, "отгружена")}>✓ Доставлено</Btn>}
                        {shipped && <Btn size="sm" variant="secondary" onClick={() => setGroupStatus(g, "в пути")}>↩ Не доставлено</Btn>}
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
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState("today");
  const [user, setUser] = useState(null);
  const [data, setData] = useState({ clients: [], stock: [], orders: [], drivers: [], trucks: [], users: [], expenses: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastSync, setLastSync] = useState(null);
  const [fabOpen, setFabOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [openOrderSignal, setOpenOrderSignal] = useState(0);
  const [openExpenseSignal, setOpenExpenseSignal] = useState(0);
  const goTab = id => { setTab(id); setMoreOpen(false); setFabOpen(false); };

  const reload = useCallback(async (table) => {
    try { const rows = await dbGetAll(table); setData(prev => ({ ...prev, [table]: rows })); setLastSync(new Date().toLocaleTimeString("ru-RU")); }
    catch (e) { setError("Ошибка: " + e.message); }
  }, []);

  const reloadAll = useCallback(async (showSpinner = false) => {
    if (!authToken) { if (showSpinner) setLoading(false); return; }
    if (showSpinner) setLoading(true);
    setError("");
    try {
      // Все таблицы одним запросом (быстрее, особенно на «холодном» старте)
      const d = (await apiData("loadAll")).data || {};
      if (!authToken) { setUser(null); if (showSpinner) setLoading(false); return; } // сессия истекла во время загрузки → на вход
      setData({ clients: d.clients || [], stock: d.stock || [], orders: d.orders || [], drivers: d.drivers || [], trucks: d.trucks || [], users: d.users || [], expenses: d.expenses || [] });
      setLastSync(new Date().toLocaleTimeString("ru-RU"));
    } catch (e) { setError("Нет связи с базой: " + e.message); }
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
    const t = setInterval(() => { if (document.visibilityState === "visible") reloadAll(false); }, 30000);
    return () => clearInterval(t);
  }, [user]);

  // При входе переключить на первую доступную для роли вкладку
  useEffect(() => {
    if (!user) return;
    const allowed = TABS_BY_ROLE[user.role] || [];
    if (!allowed.includes(tab)) setTab(allowed[0] || "calendar");
  }, [user]);

  const logout = () => { setAuthToken(null); localStorage.removeItem("sklad_uid"); setData({ clients: [], stock: [], orders: [], drivers: [], trucks: [], users: [], expenses: [] }); setUser(null); setLoading(false); };

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
          <div>
            <h1 className="text-xl font-black text-gray-900">🌾 Darad</h1>
            <p className="text-xs text-gray-400">{user.name} · {ROLES[user.role] || user.role}{lastSync ? ` · 🟢 ${lastSync}` : ""}</p>
          </div>
          <div className="flex items-center gap-2">
            {isDirector && newOrders > 0 && <div className="bg-amber-500 text-white text-sm font-bold px-3 py-1.5 rounded-full">{newOrders} новых</div>}
            <button onClick={() => reloadAll(false)} className="text-gray-400 hover:text-gray-600 text-lg" title="Обновить">🔄</button>
            <button onClick={logout} className="text-gray-400 hover:text-gray-600 text-sm" title="Выйти">Выйти</button>
          </div>
        </div>
      </div>
      {error && <div className="bg-red-50 border-b border-red-200 px-4 py-2 text-sm text-red-600 text-center">{error}</div>}
      <div className="max-w-2xl mx-auto px-4 py-5 pb-28">
        {allowedTabs.includes(tab) && (
          <>
            {tab === "today" && <TodayTab orders={data.orders} clients={data.clients} reload={reload} driverFilter={user.role === "driver" ? (user.driverId || "") : null} canEdit={isDirector} onManual={() => { setTab("orders"); setOpenOrderSignal(n => n + 1); }} />}
            {tab === "orders" && <OrdersTab clients={data.clients} drivers={data.drivers} orders={data.orders} reload={reload} openSignal={openOrderSignal} />}
            {tab === "calendar" && <CalendarTab orders={data.orders} drivers={data.drivers} clients={data.clients} stock={data.stock} reload={reload} canEdit={isDirector} showPrices={user.role !== "driver"} driverFilter={user.role === "driver" ? (user.driverId || "") : null} driverMode={user.role === "driver"} />}
            {tab === "stock" && <StockTab stock={data.stock} orders={data.orders} reload={reload} />}
            {tab === "supply" && <TrucksTab trucks={data.trucks} reload={reload} />}
            {tab === "clients" && <ClientsTab clients={data.clients} orders={data.orders} reload={reload} />}
            {tab === "drivers" && <DriversTab drivers={data.drivers} orders={data.orders} expenses={data.expenses} reload={reload} />}
            {tab === "expenses" && <ExpensesTab expenses={data.expenses} reload={reload} openSignal={openExpenseSignal} />}
            {tab === "reports" && <ReportsTab orders={data.orders} drivers={data.drivers} stock={data.stock} expenses={data.expenses} />}
            {tab === "access" && <UsersTab users={data.users} drivers={data.drivers} reload={reload} currentUser={user} />}
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
                  <button onClick={() => { goTab("orders"); setOpenOrderSignal(n => n + 1); }} className="flex items-center gap-2"><span className="bg-white shadow rounded-full px-3 py-1.5 text-sm font-medium text-gray-700">Заявка вручную</span><span className="w-11 h-11 rounded-full bg-amber-500 text-white flex items-center justify-center text-lg shadow-lg">✍️</span></button>
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
