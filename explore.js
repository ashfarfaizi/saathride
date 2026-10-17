// SaathRide — Explore map support: place search, trip routes, journey matching, map SDK delivery.
const { validLat, validLng, round3, haversineKm } = require("./geo");
const { rankTrips } = require("./matching");

function findMapSdk() {
  const out = {};
  for (const [k, id] of [["js", "mapbox-gl/dist/mapbox-gl.js"], ["css", "mapbox-gl/dist/mapbox-gl.css"]]) {
    try { out[k] = require.resolve(id); } catch { /* not installed */ }
  }
  return out.js && out.css ? out : null;
}
// Only a public (pk.) token may ever reach the browser.
const publicMapToken = () => {
  const t = process.env.MAPBOX_PUBLIC_TOKEN || process.env.MAPBOX_TOKEN || "";
  return t.startsWith("pk.") ? t : "";
};
const mapConnectSources = () => (publicMapToken() ? ["https://api.mapbox.com", "https://events.mapbox.com", "https://*.tiles.mapbox.com"] : []);

// Parse a place given by the client: { label, lat?, lng? }.
function placeParam(v, clean) {
  if (!v || typeof v !== "object") return null;
  const label = clean(v.label, 120);
  const lat = Number(v.lat), lng = Number(v.lng);
  const hasPt = v.lat !== undefined && v.lat !== null && v.lat !== "" && validLat(lat) && validLng(lng);
  if (!label && !hasPt) return null;
  return hasPt ? { label, lat: round3(lat), lng: round3(lng) } : { label };
}

function createExplore({ db, geo, HttpError, bad, clean }) {
  // Fill in coordinates (and a road route) for a trip's origin/destination. Best effort: never blocks posting.
  async function resolveTripGeo({ origin, destination, originPoint, destPoint }) {
    const out = { origin_lat: null, origin_lng: null, dest_lat: null, dest_lng: null, route_distance_m: null, route_duration_s: null, route_geom: "" };
    try {
      let a = originPoint, b = destPoint;
      if (!a && geo.enabled()) a = await geo.geocode(origin);
      if (!b && geo.enabled()) b = await geo.geocode(destination, a ? { near: a } : undefined);
      if (a) { out.origin_lat = round3(a.lat); out.origin_lng = round3(a.lng); }
      if (b) { out.dest_lat = round3(b.lat); out.dest_lng = round3(b.lng); }
      if (a && b && geo.enabled()) {
        const r = await geo.route(a, b);
        if (r) { out.route_distance_m = r.distance_m; out.route_duration_s = r.duration_s; out.route_geom = JSON.stringify(r.coords); }
      }
    } catch (err) { console.error("trip geo lookup failed:", err.message); }
    return out;
  }
  // Accept { lat, lng } points sent by the composer (from a picked suggestion).
  function pointParam(v) {
    if (!v || typeof v !== "object") return null;
    const lat = Number(v.lat), lng = Number(v.lng);
    if (!validLat(lat) || !validLng(lng)) throw bad("Invalid map location");
    return { lat, lng };
  }
  // Resolve a traveller's typed place to coordinates when we can.
  async function resolvePlace(p, near) {
    if (!p) return null;
    if (p.lat !== undefined) return p;
    if (!geo.enabled() || !p.label) return p;
    try { const g = await geo.geocode(p.label, near ? { near } : undefined); return g ? { label: p.label, lat: g.lat, lng: g.lng, resolved: g.label } : p; }
    catch { return p; }
  }
  async function match(viewerId, query, candidates, limit = 20) {
    const from = await resolvePlace(query.from);
    const to = await resolvePlace(query.to, from && from.lat !== undefined ? from : undefined);
    const trips = await candidates(viewerId, { date: query.date, vehicle_type: query.vehicle_type, min_seats: query.min_seats });
    const ranked = rankTrips(trips, { from, to, date: query.date, time: query.time, flex: query.flex }, limit);
    return { from, to, results: ranked.map(({ trip, m }) => ({ trip: stripGeo(trip), score: m.score, reasons: m.reasons })) };
  }
  const stripGeo = (t) => { const { geo: g, ...rest } = t; return { ...rest, geo: g ? { origin: g.origin, dest: g.dest, distance_m: g.distance_m, duration_s: g.duration_s, has_route: g.has_route } : null }; };

  function register(app, { auth, optionalAuth, writeLimit, intParam, candidates, L, sdk }) {
    app.get("/vendor/mapbox-gl.js", (_req, res) => { if (!sdk) return res.status(404).type("text").send("Map SDK not installed"); res.set("Cache-Control", "public, max-age=86400").type("application/javascript").sendFile(sdk.js); });
    app.get("/vendor/mapbox-gl.css", (_req, res) => { if (!sdk) return res.status(404).type("text").send("Map SDK not installed"); res.set("Cache-Control", "public, max-age=86400").type("text/css").sendFile(sdk.css); });

    // Place autocomplete for the composer and route search (server-side, so the map key stays private).
    app.get("/api/geo/search", optionalAuth, writeLimit("geo", L.geo, 60_000), async (req, res) => {
      const q = clean(typeof req.query.q === "string" ? req.query.q : "", 80);
      if (!geo.enabled()) return res.json({ enabled: false, places: [] });
      if (q.length < 2) return res.json({ enabled: true, places: [] });
      const near = validLat(Number(req.query.lat)) && validLng(Number(req.query.lng)) ? { lat: Number(req.query.lat), lng: Number(req.query.lng) } : undefined;
      try { res.json({ enabled: true, places: await geo.search(q, { near }) }); }
      catch (err) { console.error("place search failed:", err.message); throw new HttpError(502, "Place search is unavailable right now. Type the area name instead."); }
    });

    // Road route of a trip (for the map preview). Same visibility as the trip itself.
    app.get("/api/trips/:id/route", optionalAuth, async (req, res) => {
      const t = await db.one("SELECT id, origin, destination, origin_lat, origin_lng, dest_lat, dest_lng, route_distance_m, route_duration_s, route_geom FROM trips WHERE id = $1", [intParam(req.params.id)]);
      if (!t) throw new HttpError(404, "Trip not found");
      let coords = null; try { coords = t.route_geom ? JSON.parse(t.route_geom) : null; } catch { coords = null; }
      const o = t.origin_lat != null ? { lat: t.origin_lat, lng: t.origin_lng } : null, d = t.dest_lat != null ? { lat: t.dest_lat, lng: t.dest_lng } : null;
      res.json({ id: t.id, origin: o, dest: d, coords, distance_m: t.route_distance_m, duration_s: t.route_duration_s,
        straight_km: o && d ? Math.round(haversineKm(o, d) * 10) / 10 : null, estimated: true });
    });

    // Which journeys fit my trip? Reasons explain each match; nothing is invented.
    app.post("/api/match", auth, writeLimit("match", L.match, 60_000), async (req, res) => {
      const b = req.body || {};
      const query = {
        from: placeParam(b.from, clean), to: placeParam(b.to, clean),
        date: typeof b.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : null,
        time: typeof b.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(b.time) ? b.time : null,
        flex: Number(b.flex) || 60, vehicle_type: typeof b.vehicle_type === "string" ? b.vehicle_type : null,
        min_seats: Number.isInteger(b.min_seats) ? b.min_seats : null,
      };
      if (!query.from && !query.to) throw bad("Tell us where you're going (and ideally where from)");
      const out = await match(req.user.id, query, candidates);
      res.json({ ...out, map_matching: geo.enabled() });
    });
  }
  const routeBetween = (a, b) => geo.route(a, b).catch(() => null);
  return { register, resolveTripGeo, pointParam, match, resolvePlace, stripGeo, routeBetween };
}

module.exports = { createExplore, findMapSdk, publicMapToken, mapConnectSources, placeParam };
