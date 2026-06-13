import { useState, useEffect, useCallback } from "react";

const SUPA_URL = "https://lemcpwgmsvsvrrxpzjgx.supabase.co";
const SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxlbWNwd2dtc3ZzdnJyeHB6amd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyNTQ2NTksImV4cCI6MjA5NjgzMDY1OX0._kKF72KmwW89rg9kq54h3PQxyspGhnUZCbgbukEAHJw";
const H = { "Content-Type": "application/json", "apikey": SUPA_KEY, "Authorization": `Bearer ${SUPA_KEY}` };

async function dbGetAll(table) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${table}?select=*`, { headers: H });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()).map(r => r.data);
}
async function dbUpsert(table, item) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...H, "Prefer": "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ id: item.id, data: item }),
  });
  if (!res.ok) throw new Error(await res.text());
}
async function dbDelete(table, id) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${table}?id=eq.${id}`, { method: "DELETE", headers: H });
  if (!res.ok) throw new Error(await res.text());
}

const TODAY = () => new Date().toISOString().split("T")[0];
const TOMORROW = () => new Date(Date.now() + 86400000).toISOString().split("T")[0];
const fmt = n => Number(n).toLocaleString("ru-RU");
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const BRANDS = ["ДАРАД", "ДАЛА НАН"];
const GRADES = ["Высший сорт", "Первый сорт"];
const WEIGHTS = [5, 10, 25, 50];
const DELIVERY_TIMES = ["В течение дня", "Утром (8–12)", "Днём (12–17)", "Вечером (17–21)"];

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
  const all = [WAREHOUSE, ...points];
  const coords = all.map(p => `${p.lon},${p.lat}`).join("|");
  return `https://2gis.kz/astana/routeService?type=car&points=${coords}`;
}

async function parseOrderWithAI(text, clients) {
  // Разбор идёт через нашу серверную функцию /api/parse-order — ключ Anthropic живёт там, не в браузере
  const res = await fetch("/api/parse-order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      tomorrow: TOMORROW(),
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

const TABS = [{ id: "orders", label: "📋 Заявки" }, { id: "calendar", label: "📅 Календарь" }, { id: "stock", label: "🏭 Склад" }, { id: "clients", label: "🏢 Клиенты" }, { id: "drivers", label: "🚛 Водители" }, { id: "reports", label: "📊 Отчёты" }];

function CalendarTab({ orders, drivers, clients }) {
  const [cursor, setCursor] = useState(new Date());
  const [selected, setSelected] = useState(TODAY());

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const monthNames = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
  const dayNames = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

  const firstDay = new Date(year, month, 1);
  const startOffset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const kgByDate = {};
  const countByDate = {};
  orders.forEach(o => {
    const kg = o.bags * o.bag_kg;
    kgByDate[o.date] = (kgByDate[o.date] || 0) + kg;
    countByDate[o.date] = (countByDate[o.date] || 0) + 1;
  });

  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    cells.push(ds);
  }

  const sc = { "новая": "blue", "в пути": "yellow", "отгружена": "green", "отменена": "red" };
  const dayOrders = orders.filter(o => o.date === selected).sort((a, b) => (a.clientName || "").localeCompare(b.clientName || ""));
  const dayKg = dayOrders.reduce((s, o) => s + o.bags * o.bag_kg, 0);

  const prevMonth = () => setCursor(new Date(year, month - 1, 1));
  const nextMonth = () => setCursor(new Date(year, month + 1, 1));

  return (
    <div className="space-y-5">
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
        {dayOrders.length === 0 ? (
          <div className="text-center py-10 text-gray-400">На это число отгрузок нет</div>
        ) : (
          <div className="space-y-2">
            {dayOrders.map(o => {
              const driver = drivers.find(d => d.id === o.driverId);
              const client = clients.find(c => c.id === o.clientId);
              return (
                <div key={o.id} className="bg-white border border-gray-100 rounded-xl px-4 py-3 text-sm shadow-sm">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <span className="font-bold text-gray-900">{o.clientName || "Клиент"}</span>
                    <Badge color={sc[o.status] || "gray"}>{o.status}</Badge>
                  </div>
                  <div className="text-gray-500 mt-1">{o.brand} {o.grade} {o.bag_kg}кг × {o.bags} = <b>{fmt(o.bags * o.bag_kg)} кг</b>{o.price_per_kg ? ` · ${fmt(o.bags * o.bag_kg * o.price_per_kg)} тг` : ""}</div>
                  <div className="text-xs text-gray-400 mt-0.5 flex items-center gap-2 flex-wrap">
                    {driver ? `🚛 ${driver.name}` : "🚛 водитель не назначен"}
                    {client?.delivery_time && <span className="bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full">⏰ {client.delivery_time}</span>}
                    {client?.gis_link && <a href={client.gis_link} target="_blank" rel="noreferrer" className="bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full">📍 2ГИС</a>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {dayOrders.length > 0 && (() => {
        const points = dayOrders.map(o => {
          const client = clients.find(c => c.id === o.clientId);
          if (!client) return null;
          const coords = client.coords || parseCoordsFromGisLink(client.gis_link) || parseCoordsFromText(client.coords_manual);
          if (!coords) return null;
          return { ...coords, name: o.clientName, delivery_time: client.delivery_time };
        }).filter(Boolean);

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
    </div>
  );
}

function OrdersTab({ clients, drivers, orders, reload }) {
  const [aiText, setAiText] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState(null);
  const [aiError, setAiError] = useState("");
  const [showManual, setShowManual] = useState(false);
  const [saving, setSaving] = useState(false);
  const [filterDate, setFilterDate] = useState(TODAY());
  const [form, setForm] = useState({ clientId: "", brand: BRANDS[0], grade: GRADES[0], bag_kg: 50, bags: "", date: TOMORROW(), driverId: "", price_per_kg: "" });

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
        return { ...p, clientId: found?.id || null, clientFound: found?.name || p.clientName, price_per_kg: found ? getPrice(found, p.brand, p.grade, p.bag_kg) : null };
      }));
    } catch { setAiError("Не удалось разобрать. Попробуй ещё раз."); }
    setAiLoading(false);
  };

  const confirmAI = async () => {
    setSaving(true);
    try {
      for (const p of aiResult) {
        await dbUpsert("orders", { id: uid(), date: p.date, clientId: p.clientId, clientName: p.clientFound, brand: p.brand, grade: p.grade, bag_kg: p.bag_kg, bags: p.bags, price_per_kg: p.price_per_kg, driverId: "", status: "новая" });
      }
      setAiResult(null); setAiText(""); await reload("orders");
    } catch (e) { setAiError("Ошибка: " + e.message); }
    setSaving(false);
  };

  const addManual = async () => {
    setSaving(true);
    const client = clients.find(c => c.id === form.clientId);
    const price = form.price_per_kg || (client ? getPrice(client, form.brand, form.grade, Number(form.bag_kg)) : 0);
    try {
      await dbUpsert("orders", { id: uid(), ...form, bags: Number(form.bags), bag_kg: Number(form.bag_kg), price_per_kg: Number(price), status: "новая", clientName: client?.name || "" });
      setShowManual(false); await reload("orders");
    } catch { }
    setSaving(false);
  };

  const updateStatus = async (o, status) => {
    await dbUpsert("orders", { ...o, status });
    if (status === "отгружена") {
      const kg = o.bags * o.bag_kg;
      await dbUpsert("stock", { id: uid(), date: TODAY(), brand: o.brand, grade: o.grade, weight_kg: -kg, bags: -o.bags, bag_kg: o.bag_kg, note: `Отгрузка: ${o.clientName}` });
      await reload("stock");
    }
    await reload("orders");
  };

  const assignDriver = async (o, driverId) => { await dbUpsert("orders", { ...o, driverId }); await reload("orders"); };
  const deleteOrder = async id => { await dbDelete("orders", id); await reload("orders"); };

  const filtered = orders.filter(o => !filterDate || o.date === filterDate);
  const totalKg = filtered.reduce((s, o) => s + o.bags * o.bag_kg, 0);
  const totalSum = filtered.reduce((s, o) => s + o.bags * o.bag_kg * (o.price_per_kg || 0), 0);
  const sc = { "новая": "blue", "в пути": "yellow", "отгружена": "green", "отменена": "red" };

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
              <div className="flex items-center gap-2"><span className="font-semibold">{p.clientFound}</span>{!p.clientId && <Badge color="red">Не в базе</Badge>}</div>
              <div className="text-gray-600">{p.brand} · {p.grade} · {p.bag_kg}кг × {p.bags} = {fmt(p.bags * p.bag_kg)} кг</div>
              <div className="text-gray-600">Дата: {p.date} · Цена: {p.price_per_kg ? fmt(p.price_per_kg) + " тг/кг" : <span className="text-red-500">не найдена</span>}</div>
            </div>
          ))}
          <div className="flex gap-2">
            <Btn onClick={confirmAI} disabled={saving}>{saving ? "Сохраняю..." : "Добавить все"}</Btn>
            <Btn variant="secondary" onClick={() => setAiResult(null)}>Отмена</Btn>
          </div>
        </div>
      )}

      {showManual && (
        <Modal title="Новая заявка" onClose={() => setShowManual(false)}>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2"><Sel label="Клиент" value={form.clientId} onChange={e => setForm({ ...form, clientId: e.target.value })} options={[{ value: "", label: "— выбери клиента —" }, ...clients.map(c => ({ value: c.id, label: c.name }))]} /></div>
            <Sel label="Бренд" value={form.brand} onChange={e => setForm({ ...form, brand: e.target.value })} options={BRANDS} />
            <Sel label="Сорт" value={form.grade} onChange={e => setForm({ ...form, grade: e.target.value })} options={GRADES} />
            <Sel label="Фасовка" value={form.bag_kg} onChange={e => setForm({ ...form, bag_kg: e.target.value })} options={WEIGHTS.map(w => ({ value: w, label: w + " кг" }))} />
            <Inp label="Мешков" type="number" value={form.bags} onChange={e => setForm({ ...form, bags: e.target.value })} />
            <Inp label="Цена тг/кг" type="number" placeholder="авто из базы" value={form.price_per_kg || ""} onChange={e => setForm({ ...form, price_per_kg: e.target.value })} />
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
          {[...filtered].sort((a, b) => a.date.localeCompare(b.date)).map(o => {
            const driver = drivers.find(d => d.id === o.driverId);
            const kg = o.bags * o.bag_kg; const sum = kg * (o.price_per_kg || 0);
            return (
              <div key={o.id} className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap"><span className="font-bold text-gray-900">{o.clientName || "Клиент"}</span><Badge color={sc[o.status] || "gray"}>{o.status}</Badge></div>
                    <div className="text-sm text-gray-500 mt-1">{o.brand} · {o.grade} · {o.bag_kg}кг × {o.bags} = <b>{fmt(kg)} кг</b></div>
                    <div className="text-sm text-gray-500">{o.price_per_kg ? `${fmt(o.price_per_kg)} тг/кг · ${fmt(sum)} тг` : "Цена не указана"}</div>
                    <div className="text-xs text-gray-400 mt-1">📅 {o.date}{driver ? ` · 🚛 ${driver.name}` : ""}</div>
                  </div>
                  <div className="flex gap-1 flex-wrap">
                    {o.status === "новая" && <><Btn size="sm" variant="secondary" onClick={() => updateStatus(o, "в пути")}>В путь</Btn><select className="border border-gray-200 rounded-lg px-2 py-1 text-xs" value={o.driverId || ""} onChange={e => assignDriver(o, e.target.value)}><option value="">Водитель</option>{drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></>}
                    {o.status === "в пути" && <Btn size="sm" onClick={() => updateStatus(o, "отгружена")}>✓ Доставлено</Btn>}
                    <Btn size="sm" variant="danger" onClick={() => deleteOrder(o.id)}>✕</Btn>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StockTab({ stock, reload }) {
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ date: TODAY(), brand: BRANDS[0], grade: GRADES[0], bag_kg: 50, bags: "", price_per_kg: "", note: "" });

  const addArrival = async () => {
    setSaving(true);
    try {
      await dbUpsert("stock", { id: uid(), ...form, bags: Number(form.bags), bag_kg: Number(form.bag_kg), weight_kg: Number(form.bags) * Number(form.bag_kg), price_per_kg: Number(form.price_per_kg) });
      setShowAdd(false); await reload("stock");
    } catch { }
    setSaving(false);
  };

  const balances = {};
  stock.forEach(s => {
    const k = `${s.brand}|${s.grade}|${s.bag_kg}`;
    if (!balances[k]) balances[k] = { brand: s.brand, grade: s.grade, bag_kg: s.bag_kg, kg: 0, bags: 0 };
    balances[k].kg += s.weight_kg; balances[k].bags += s.bags;
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between"><h3 className="font-bold text-gray-800">Остатки на складе</h3><Btn onClick={() => setShowAdd(true)}>+ Приход фуры</Btn></div>
      {showAdd && (
        <Modal title="Приход муки" onClose={() => setShowAdd(false)}>
          <div className="grid grid-cols-2 gap-3">
            <Inp label="Дата" type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
            <Sel label="Бренд" value={form.brand} onChange={e => setForm({ ...form, brand: e.target.value })} options={BRANDS} />
            <Sel label="Сорт" value={form.grade} onChange={e => setForm({ ...form, grade: e.target.value })} options={GRADES} />
            <Sel label="Фасовка" value={form.bag_kg} onChange={e => setForm({ ...form, bag_kg: e.target.value })} options={WEIGHTS.map(w => ({ value: w, label: w + " кг" }))} />
            <Inp label="Мешков" type="number" value={form.bags} onChange={e => setForm({ ...form, bags: e.target.value })} />
            <Inp label="Цена закупки тг/кг" type="number" value={form.price_per_kg} onChange={e => setForm({ ...form, price_per_kg: e.target.value })} />
            <div className="col-span-2"><Inp label="Примечание" value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} /></div>
          </div>
          <div className="flex gap-2 mt-4">
            <Btn onClick={addArrival} disabled={saving}>{saving ? "Сохраняю..." : "Добавить приход"}</Btn>
            <Btn variant="secondary" onClick={() => setShowAdd(false)}>Отмена</Btn>
          </div>
        </Modal>
      )}
      <div className="grid grid-cols-1 gap-3">
        {Object.values(balances).map((b, i) => (
          <div key={i} className={`rounded-2xl p-4 border ${b.kg <= 0 ? "bg-red-50 border-red-200" : "bg-white border-gray-100 shadow-sm"}`}>
            <div className="flex items-center justify-between">
              <div><div className="font-bold text-gray-900">{b.brand} · {b.grade}</div><div className="text-sm text-gray-500">Мешки по {b.bag_kg} кг</div></div>
              <div className="text-right"><div className={`text-2xl font-bold ${b.kg <= 0 ? "text-red-600" : "text-emerald-600"}`}>{fmt(Math.max(0, b.kg))} кг</div><div className="text-sm text-gray-400">{Math.max(0, b.bags)} мешков</div></div>
            </div>
          </div>
        ))}
        {Object.keys(balances).length === 0 && <div className="text-center py-12 text-gray-400">Склад пуст.</div>}
      </div>
      <div>
        <h4 className="font-semibold text-gray-700 mb-3">История движений</h4>
        <div className="space-y-2">
          {[...stock].reverse().slice(0, 20).map(s => (
            <div key={s.id} className="flex items-center justify-between bg-white border border-gray-100 rounded-xl px-4 py-3 text-sm">
              <div><span className={s.weight_kg > 0 ? "text-emerald-600 font-medium" : "text-red-500 font-medium"}>{s.weight_kg > 0 ? "▲ Приход" : "▼ Расход"}</span><span className="text-gray-600 ml-2">{s.brand} {s.grade} {s.bag_kg}кг</span>{s.note && <span className="text-gray-400 ml-2">· {s.note}</span>}</div>
              <div className="text-right"><div className="font-medium">{s.weight_kg > 0 ? "+" : ""}{fmt(s.weight_kg)} кг</div><div className="text-gray-400">{s.date}</div></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ClientsTab({ clients, reload }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolveErr, setResolveErr] = useState("");
  const [form, setForm] = useState({ name: "", address: "", contact: "", prices: [] });
  const [pf, setPf] = useState({ brand: BRANDS[0], grade: GRADES[0], bag_kg: 50, price_per_kg: "" });

  const openEdit = c => { setEditId(c.id); setResolveErr(""); setForm({ name: c.name, org_name: c.org_name || "", contact_name: c.contact_name || "", address: c.address, contact: c.contact || "", default_bag_kg: c.default_bag_kg || "", default_brand: c.default_brand || "", gis_link: c.gis_link || "", coords: c.coords || null, coords_manual: c.coords_manual || "", delivery_time: c.delivery_time || "", prices: c.prices || [] }); setShowAdd(true); };
  const openNew = () => { setEditId(null); setResolveErr(""); setForm({ name: "", org_name: "", contact_name: "", address: "", contact: "", default_bag_kg: "", default_brand: "", gis_link: "", coords: null, coords_manual: "", delivery_time: "", prices: [] }); setShowAdd(true); };

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
    try { await dbUpsert("clients", { id: editId || uid(), ...form }); setShowAdd(false); await reload("clients"); } catch { }
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
            <Sel label="Предпочтительное время доставки" value={form.delivery_time} onChange={e => setForm({ ...form, delivery_time: e.target.value })} options={[{ value: "", label: "— не указано —" }, ...DELIVERY_TIMES.map(t => ({ value: t, label: t }))]} />
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
        {clients.map(c => (
          <div key={c.id} className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm">
            <div className="flex items-start justify-between">
              <div>
                <div className="font-bold text-gray-900">{c.name}</div>
                {c.org_name && <div className="text-sm text-gray-500">🏢 {c.org_name}</div>}
                {c.contact_name && <div className="text-sm text-gray-500">👤 {c.contact_name}</div>}
                {c.address && <div className="text-sm text-gray-500">📍 {c.address}</div>}
                {c.contact && <div className="text-sm text-gray-500">📱 {c.contact}</div>}
                {(c.default_bag_kg || c.default_brand) && <div className="text-xs text-amber-700 bg-amber-50 rounded-lg px-2 py-1 mt-1 inline-block">📦 {c.default_brand || "—"} · {c.default_bag_kg ? c.default_bag_kg + " кг мешки" : "фасовка не указана"}</div>}
                {(c.prices || []).length > 0 && <div className="flex flex-wrap gap-1 mt-2">{c.prices.map((p, i) => <span key={i} className="bg-amber-50 text-amber-800 text-xs px-2 py-0.5 rounded-full">{p.brand} {p.grade} {p.bag_kg}кг — {fmt(p.price_per_kg)}тг</span>)}</div>}
              </div>
              <div className="flex gap-1"><Btn size="sm" variant="secondary" onClick={() => openEdit(c)}>✏️</Btn><Btn size="sm" variant="danger" onClick={() => deleteClient(c.id)}>✕</Btn></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DriversTab({ drivers, orders, reload }) {
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", rate_per_kg: "" });

  const saveDriver = async () => {
    setSaving(true);
    try { await dbUpsert("drivers", { id: uid(), name: form.name, rate_per_kg: Number(form.rate_per_kg) }); setShowAdd(false); setForm({ name: "", rate_per_kg: "" }); await reload("drivers"); } catch { }
    setSaving(false);
  };
  const deleteDriver = async id => { await dbDelete("drivers", id); await reload("drivers"); };
  const earnings = {};
  orders.filter(o => o.status === "отгружена" && o.driverId).forEach(o => { const d = drivers.find(x => x.id === o.driverId); if (d) earnings[o.driverId] = (earnings[o.driverId] || 0) + o.bags * o.bag_kg * d.rate_per_kg; });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between"><h3 className="font-bold text-gray-800">Водители</h3><Btn onClick={() => setShowAdd(true)}>+ Водитель</Btn></div>
      {showAdd && (<Modal title="Новый водитель" onClose={() => setShowAdd(false)}>
        <div className="space-y-3"><Inp label="Имя" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /><Inp label="Ставка тг/кг" type="number" value={form.rate_per_kg} onChange={e => setForm({ ...form, rate_per_kg: e.target.value })} /></div>
        <div className="flex gap-2 mt-4"><Btn onClick={saveDriver} disabled={saving}>{saving ? "Сохраняю..." : "Сохранить"}</Btn><Btn variant="secondary" onClick={() => setShowAdd(false)}>Отмена</Btn></div>
      </Modal>)}
      <div className="space-y-3">
        {drivers.length === 0 && <div className="text-center py-12 text-gray-400">Водителей нет.</div>}
        {drivers.map(d => {
          const kg = orders.filter(o => o.driverId === d.id && o.status === "отгружена").reduce((s, o) => s + o.bags * o.bag_kg, 0);
          return <div key={d.id} className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm"><div className="flex items-center justify-between"><div><div className="font-bold text-gray-900">🚛 {d.name}</div><div className="text-sm text-gray-500">Ставка: {fmt(d.rate_per_kg)} тг/кг</div>{kg > 0 && <div className="text-sm text-emerald-600 font-medium mt-1">Доставлено: {fmt(kg)} кг · К оплате: {fmt(earnings[d.id] || 0)} тг</div>}</div><Btn size="sm" variant="danger" onClick={() => deleteDriver(d.id)}>✕</Btn></div></div>;
        })}
      </div>
    </div>
  );
}

function ReportsTab({ orders, drivers }) {
  const [period, setPeriod] = useState("month");
  const [view, setView] = useState("product");
  const now = new Date();
  const filterFn = o => { const d = new Date(o.date); if (period === "week") { const w = new Date(now); w.setDate(w.getDate() - 7); return d >= w; } if (period === "month") return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); if (period === "3month") { const m = new Date(now); m.setMonth(m.getMonth() - 3); return d >= m; } return true; };
  const filtered = orders.filter(filterFn);
  const delivered = filtered.filter(o => o.status === "отгружена");
  const allDelivered = orders.filter(o => o.status === "отгружена");
  const totalKg = delivered.reduce((s, o) => s + o.bags * o.bag_kg, 0);
  const totalRev = delivered.reduce((s, o) => s + o.bags * o.bag_kg * (o.price_per_kg || 0), 0);
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
      <div className="flex gap-2 flex-wrap">
        {[["week", "7 дней"], ["month", "Месяц"], ["3month", "3 месяца"], ["all", "Всё время"]].map(([v, l]) => (
          <button key={v} onClick={() => setPeriod(v)} className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${period === v ? "bg-amber-500 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>{l}</button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-gradient-to-br from-emerald-50 to-green-100 rounded-2xl p-4"><div className="text-xs text-emerald-700 font-medium">Отгружено</div><div className="text-2xl font-bold text-emerald-800">{fmt(totalKg)} кг</div></div>
        <div className="bg-gradient-to-br from-amber-50 to-orange-100 rounded-2xl p-4"><div className="text-xs text-amber-700 font-medium">Выручка</div><div className="text-2xl font-bold text-amber-800">{fmt(totalRev)} тг</div></div>
        <div className="bg-gradient-to-br from-blue-50 to-blue-100 rounded-2xl p-4"><div className="text-xs text-blue-700 font-medium">Заявок</div><div className="text-2xl font-bold text-blue-800">{delivered.length}</div></div>
        <div className="bg-gradient-to-br from-purple-50 to-purple-100 rounded-2xl p-4"><div className="text-xs text-purple-700 font-medium">Водителям</div><div className="text-2xl font-bold text-purple-800">{fmt(totalPay)} тг</div></div>
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
      <div><h4 className="font-semibold text-gray-700 mb-3">Маршрутный лист</h4>{filtered.length === 0 ? <div className="text-center py-8 text-gray-400">Нет заявок</div> : <div className="space-y-2">{[...filtered].sort((a, b) => a.date.localeCompare(b.date)).map(o => { const driver = drivers.find(d => d.id === o.driverId); return (<div key={o.id} className="bg-white border border-gray-100 rounded-xl px-4 py-3 text-sm"><div className="flex items-center justify-between flex-wrap gap-2"><div><span className="font-medium">{o.clientName}</span><span className="text-gray-400 ml-2">{o.date}</span></div><Badge color={{ "новая": "blue", "в пути": "yellow", "отгружена": "green", "отменена": "red" }[o.status] || "gray"}>{o.status}</Badge></div><div className="text-gray-500 mt-1">{o.brand} {o.grade} {o.bag_kg}кг × {o.bags} = {fmt(o.bags * o.bag_kg)}кг{driver ? ` · 🚛 ${driver.name}` : ""}</div></div>); })}</div>}</div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState("orders");
  const [data, setData] = useState({ clients: [], stock: [], orders: [], drivers: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastSync, setLastSync] = useState(null);

  const reload = useCallback(async (table) => {
    try { const rows = await dbGetAll(table); setData(prev => ({ ...prev, [table]: rows })); setLastSync(new Date().toLocaleTimeString("ru-RU")); }
    catch (e) { setError("Ошибка: " + e.message); }
  }, []);

  const reloadAll = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    setError("");
    try {
      const [clients, stock, orders, drivers] = await Promise.all(["clients", "stock", "orders", "drivers"].map(dbGetAll));
      setData({ clients, stock, orders, drivers }); setLastSync(new Date().toLocaleTimeString("ru-RU"));
    } catch (e) { setError("Нет связи с базой: " + e.message); }
    if (showSpinner) setLoading(false);
  }, []);

  useEffect(() => { reloadAll(true); }, []);
  useEffect(() => { const t = setInterval(() => reloadAll(false), 30000); return () => clearInterval(t); }, []);

  const newOrders = data.orders.filter(o => o.status === "новая").length;

  return (
    <div className="min-h-screen bg-gray-50 font-sans">
      <div className="bg-white border-b border-gray-100 px-4 py-4 sticky top-0 z-40 shadow-sm">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-xl font-black text-gray-900">🌾 Склад Муки</h1>
            <p className="text-xs text-gray-400">{lastSync ? `🟢 Синхронизировано в ${lastSync}` : "Загрузка..."}</p>
          </div>
          <div className="flex items-center gap-2">
            {newOrders > 0 && <div className="bg-amber-500 text-white text-sm font-bold px-3 py-1.5 rounded-full">{newOrders} новых</div>}
            <button onClick={reloadAll} className="text-gray-400 hover:text-gray-600 text-lg">🔄</button>
          </div>
        </div>
      </div>
      {error && <div className="bg-red-50 border-b border-red-200 px-4 py-2 text-sm text-red-600 text-center">{error}</div>}
      <div className="bg-white border-b border-gray-100 sticky top-16 z-30">
        <div className="max-w-2xl mx-auto flex overflow-x-auto">
          {TABS.map(t => <button key={t.id} onClick={() => setTab(t.id)} className={`flex-shrink-0 px-4 py-3 text-sm font-medium border-b-2 transition-all whitespace-nowrap ${tab === t.id ? "border-amber-500 text-amber-600" : "border-transparent text-gray-500 hover:text-gray-700"}`}>{t.label}</button>)}
        </div>
      </div>
      <div className="max-w-2xl mx-auto px-4 py-5">
        {loading ? <Spinner /> : (
          <>
            {tab === "orders" && <OrdersTab clients={data.clients} drivers={data.drivers} orders={data.orders} reload={reload} />}
            {tab === "calendar" && <CalendarTab orders={data.orders} drivers={data.drivers} clients={data.clients} />}
            {tab === "stock" && <StockTab stock={data.stock} reload={reload} />}
            {tab === "clients" && <ClientsTab clients={data.clients} reload={reload} />}
            {tab === "drivers" && <DriversTab drivers={data.drivers} orders={data.orders} reload={reload} />}
            {tab === "reports" && <ReportsTab orders={data.orders} drivers={data.drivers} />}
          </>
        )}
      </div>
    </div>
  );
}
