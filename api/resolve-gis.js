// Серверная функция Vercel: по ссылке 2ГИС определяет координаты места.
// Браузер не может фетчить 2gis.kz напрямую (CORS), поэтому делаем это на сервере.

export default async function handler(req, res) {
  const { url } = req.query;
  if (!url || !String(url).includes("2gis")) {
    return res.status(400).json({ error: "Нужна ссылка 2ГИС" });
  }

  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      redirect: "follow",
    });
    const finalUrl = r.url || "";
    const html = await r.text();
    const text = decodeURIComponent(finalUrl) + "\n" + html;

    const candidates = [];
    const push = (lon, lat) => {
      lon = parseFloat(lon);
      lat = parseFloat(lat);
      // Границы Астаны/Казахстана: lat 48–55, lon 65–80
      if (lat > 48 && lat < 55 && lon > 65 && lon < 80) candidates.push({ lat, lon });
    };

    let m;
    // m=lon,lat (центр карты)
    const re1 = /[?&]m=([\d.]+)(?:,|%2C)([\d.]+)/g;
    while ((m = re1.exec(text))) push(m[1], m[2]);
    // directions points: |lon,lat;
    const re2 = /[|]([\d.]+)(?:,|%2C)([\d.]+)(?:;|%3B)/g;
    while ((m = re2.exec(text))) push(m[1], m[2]);
    // "lon":x,"lat":y
    const re3 = /"lon":\s*([\d.]+)\s*,\s*"lat":\s*([\d.]+)/g;
    while ((m = re3.exec(text))) push(m[1], m[2]);
    // "lat":y,"lon":x
    const re4 = /"lat":\s*([\d.]+)\s*,\s*"lon":\s*([\d.]+)/g;
    while ((m = re4.exec(text))) push(m[2], m[1]);
    // "point":{"lat":y,"lon":x}
    const re5 = /"point"\s*:\s*\{\s*"lat":\s*([\d.]+)\s*,\s*"lon":\s*([\d.]+)/g;
    while ((m = re5.exec(text))) push(m[2], m[1]);

    if (candidates.length === 0) {
      return res.status(404).json({ error: "Координаты не найдены на странице" });
    }

    // Берём самую часто встречающуюся пару координат
    const counts = {};
    candidates.forEach(c => {
      const k = `${c.lat.toFixed(6)},${c.lon.toFixed(6)}`;
      counts[k] = (counts[k] || 0) + 1;
    });
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    const [lat, lon] = best.split(",").map(Number);

    res.setHeader("Cache-Control", "s-maxage=86400");
    return res.status(200).json({ lat, lon });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
