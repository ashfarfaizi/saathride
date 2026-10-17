// SaathRide — places and routes (Mapbox Geocoding + Directions), called only from the server.
// Results are cached in the database to save quota. Without MAPBOX_TOKEN everything still works:
// trips just have no coordinates, the map stays off and matching falls back to place names.
// Coordinates are rounded to 3 decimals (~100 m) — enough for a landmark, never a doorstep.

const round3 = (n) => Math.round(n * 1000) / 1000;
const validLat = (v) => typeof v === "number" && Number.isFinite(v) && v >= -90 && v <= 90;
const validLng = (v) => typeof v === "number" && Number.isFinite(v) && v >= -180 && v <= 180;

function haversineKm(a, b) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function bearingDeg(a, b) {
  const toRad = (d) => (d * Math.PI) / 180, toDeg = (r) => (r * 180) / Math.PI;
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
// Shortest distance from point p to a polyline [[lng,lat],...], plus how far along the line (0..1) that closest point is.
function nearestOnLine(p, coords) {
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const kx = 111.32 * Math.cos((p.lat * Math.PI) / 180), ky = 110.57;   // local equirectangular projection, km
  const P = [p.lng * kx, p.lat * ky];
  let best = { km: Infinity, along: 0 }, total = 0;
  const seg = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const A = [coords[i][0] * kx, coords[i][1] * ky], B = [coords[i + 1][0] * kx, coords[i + 1][1] * ky];
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
    seg.push({ A, B, len, start: total }); total += len;
  }
  for (const s of seg) {
    let t = 0;
    if (s.len > 0) t = Math.max(0, Math.min(1, ((P[0] - s.A[0]) * (s.B[0] - s.A[0]) + (P[1] - s.A[1]) * (s.B[1] - s.A[1])) / (s.len * s.len)));
    const X = [s.A[0] + t * (s.B[0] - s.A[0]), s.A[1] + t * (s.B[1] - s.A[1])];
    const d = Math.hypot(P[0] - X[0], P[1] - X[1]);
    if (d < best.km) best = { km: d, along: total ? (s.start + t * s.len) / total : 0 };
  }
  return best;
}
// Keep at most `max` points so stored routes stay small.
function thin(coords, max = 160) {
  if (coords.length <= max) return coords.map((c) => [round3(c[0]), round3(c[1])]);
  const step = (coords.length - 1) / (max - 1), out = [];
  for (let i = 0; i < max; i++) { const c = coords[Math.round(i * step)]; out.push([round3(c[0]), round3(c[1])]); }
  return out;
}

function createGeo({ db, token = () => process.env.MAPBOX_TOKEN || "", fetchImpl = (...a) => fetch(...a), country = () => process.env.MAPBOX_COUNTRY || "in" } = {}) {
  const enabled = () => !!token();
  async function cached(key, fn, maxAgeDays = 30) {
    try {
      const row = await db.one("SELECT value, created_at FROM geo_cache WHERE key = $1", [key]);
      if (row) {
        const age = Date.now() - Date.parse(String(row.created_at).includes("T") || row.created_at instanceof Date ? row.created_at : String(row.created_at).replace(" ", "T") + "Z");
        if (!(age > maxAgeDays * 864e5)) return JSON.parse(row.value);
      }
    } catch { /* cache miss */ }
    const value = await fn();
    if (value !== null) {
      try {
        await db.query("DELETE FROM geo_cache WHERE key = $1", [key]);
        await db.query("INSERT INTO geo_cache (key, value, created_at) VALUES ($1,$2,$3)", [key, JSON.stringify(value), new Date().toISOString()]);
      } catch (err) { console.error("geo cache write failed:", err.message); }
    }
    return value;
  }
  async function getJson(url) {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(7000) });
    if (!res.ok) throw new Error(`map service responded ${res.status}`);
    return res.json();
  }

  // Place search (autocomplete). Returns [{ label, name, lat, lng }].
  async function search(q, { near } = {}) {
    const query = String(q || "").trim().slice(0, 80);
    if (!enabled() || query.length < 2) return [];
    const prox = near && validLat(near.lat) && validLng(near.lng) ? `&proximity=${round3(near.lng)},${round3(near.lat)}` : "";
    const key = `s:${country()}:${query.toLowerCase()}${prox}`;
    return cached(key, async () => {
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?autocomplete=true&limit=6&language=en&types=poi,neighborhood,locality,place,district,address${country() ? `&country=${country()}` : ""}${prox}&access_token=${encodeURIComponent(token())}`;
      const data = await getJson(url);
      return (data.features || []).map((f) => {
        const c = f.center || (f.geometry && f.geometry.coordinates) || [];
        return { label: String(f.place_name || f.text || "").slice(0, 140), name: String(f.text || f.place_name || "").slice(0, 80), lat: round3(c[1]), lng: round3(c[0]) };
      }).filter((p) => validLat(p.lat) && validLng(p.lng));
    });
  }
  async function geocode(q, opts) { const r = await search(q, opts); return r[0] || null; }

  // Road route between two points. Returns { distance_m, duration_s, coords } or null.
  async function route(a, b) {
    if (!enabled() || !a || !b) return null;
    const key = `r:${round3(a.lng)},${round3(a.lat)};${round3(b.lng)},${round3(b.lat)}`;
    return cached(key, async () => {
      const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${round3(a.lng)},${round3(a.lat)};${round3(b.lng)},${round3(b.lat)}?geometries=geojson&overview=simplified&access_token=${encodeURIComponent(token())}`;
      const data = await getJson(url);
      const r = data.routes && data.routes[0];
      if (!r || !r.geometry) return null;
      return { distance_m: Math.round(r.distance), duration_s: Math.round(r.duration), coords: thin(r.geometry.coordinates) };
    }, 90);
  }
  return { enabled, search, geocode, route };
}

module.exports = { createGeo, haversineKm, bearingDeg, nearestOnLine, thin, round3, validLat, validLng };
