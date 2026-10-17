// Parts 3–4: map data, route matching, Saath AI, saved routes, recommendations, communities, people search,
// trip updates, notification preferences and report review. The map service (Mapbox) and the AI service (Claude API)
// are replaced by local fakes — these tests check OUR logic and authorization, not the external services.
process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const { createApp } = require("../server");
const { scoreTrip, estimateContribution } = require("../matching");
const { haversineKm } = require("../geo");

let server, base;
const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

// ---- fake Mapbox ----
const PLACES = {
  "howrah station": [88.342, 22.583], "iit kharagpur": [87.310, 22.316], "gol bazar": [87.325, 22.336],
  "salt lake sector v": [88.433, 22.576], "park street": [88.352, 22.553], "uluberia": [88.033, 22.503], "bagnan": [87.97, 22.47],
};
const geoCalls = [];
async function fakeMapbox(url) {
  geoCalls.push(url);
  assert.ok(url.includes("access_token=pk.test-map-token"), "server sends the key to Mapbox");
  const u = new URL(url);
  if (u.pathname.startsWith("/geocoding/")) {
    const q = decodeURIComponent(u.pathname.split("/").pop().replace(".json", "")).toLowerCase();
    const k = Object.keys(PLACES).find((p) => q.includes(p) || p.includes(q));
    return { ok: true, json: async () => ({ features: k ? [{ text: k.replace(/\b\w/g, (c) => c.toUpperCase()), place_name: `${k}, West Bengal, India`, center: PLACES[k] }] : [] }) };
  }
  if (u.pathname.startsWith("/directions/")) {
    const [a, b] = u.pathname.split("/").pop().split(";").map((p) => p.split(",").map(Number));
    const coords = Array.from({ length: 21 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / 20, a[1] + ((b[1] - a[1]) * i) / 20]);
    const km = haversineKm({ lng: a[0], lat: a[1] }, { lng: b[0], lat: b[1] }) * 1.15;
    return { ok: true, json: async () => ({ routes: [{ distance: km * 1000, duration: km * 90, geometry: { coordinates: coords } }] }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
}
// ---- fake Claude API ----
let aiScript = [], aiRequests = [];
async function fakeClaude(url, opts) {
  aiRequests.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
  const next = aiScript.shift();
  if (!next) return { ok: false, status: 500, text: async () => "no script" };
  if (next.status) return { ok: false, status: next.status, text: async () => "err" };
  return { ok: true, json: async () => next };
}

class Client {
  constructor() { this.cookie = ""; }
  async req(method, p, body) {
    const res = await fetch(base + p, { method, headers: { "Content-Type": "application/json", ...(this.cookie ? { Cookie: this.cookie } : {}) }, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
    for (const c of res.headers.getSetCookie?.() || []) { const [pair] = c.split(";"); this.cookie = pair.endsWith("=") ? "" : pair; }
    const text = await res.text(); let data = {}; try { data = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, data, text, headers: res.headers };
  }
  get(p) { return this.req("GET", p); } post(p, b) { return this.req("POST", p, b); } put(p, b) { return this.req("PUT", p, b); }
  patch(p, b) { return this.req("PATCH", p, b); } del(p) { return this.req("DELETE", p); }
}
let n = 0;
async function signup(name, extra = {}) {
  const c = new Client();
  c.email = `${name.toLowerCase().replace(/\W/g, "")}${++n}@example.com`;
  const r = await c.post("/api/auth/signup", { name, email: c.email, password: "password123", ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.data)); c.user = r.data.user; return c;
}
const trip = async (c, o) => { const r = await c.post("/api/trips", { depart_date: day(1), depart_time: "08:00", vehicle_type: "car", seats_total: 3, contribution_inr: 150, ...o }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.trip; };
const mapOn = () => { process.env.MAPBOX_TOKEN = "pk.test-map-token"; };
const mapOff = () => { delete process.env.MAPBOX_TOKEN; };

test.before(async () => {
  mapOff(); delete process.env.ANTHROPIC_API_KEY;
  await db.migrate();
  server = createApp({ geoFetch: fakeMapbox, aiFetch: fakeClaude, mapSdk: { js: __filename, css: __filename },
    limits: { auth: 9999, write: 9999, trip: 9999, interest: 9999, api: 999999, geo: 9999, match: 9999, ai: 9999, aiDay: 9999, route: 9999, search: 9999, update: 9999 } }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test("matching rules: only claims what the data supports", () => {
  const route = Array.from({ length: 11 }, (_, i) => [88.342 + ((87.31 - 88.342) * i) / 10, 22.583 + ((22.316 - 22.583) * i) / 10]);
  const t = { depart_date: day(1), depart_time: "08:00", seats_left: 2, origin: "Howrah Station", destination: "IIT Kharagpur",
    geo: { origin: { lat: 22.583, lng: 88.342 }, dest: { lat: 22.316, lng: 87.31 }, coords: route } };
  const along = { lat: route[3][1] + 0.004, lng: route[3][0] };
  const m = scoreTrip(t, { from: { label: "x", ...along }, to: { label: "IIT", lat: 22.318, lng: 87.312 }, time: "08:20" });
  const kinds = m.reasons.map((r) => `${r.kind}:${r.basis}`);
  assert.ok(kinds.includes("pickup:route") && kinds.includes("destination:straight_line") && kinds.includes("overlap:route"), kinds.join());
  assert.match(m.reasons.find((r) => r.kind === "time").text, /20 min before/);
  // without a stored road route we never claim the route passes or overlaps
  const noRoute = scoreTrip({ ...t, geo: { ...t.geo, coords: null } }, { from: { label: "x", ...along }, to: { label: "IIT", lat: 22.318, lng: 87.312 } });
  assert.ok(!noRoute.reasons.some((r) => r.basis === "route"));
  // reversed direction does not count as overlap
  const rev = scoreTrip(t, { from: { label: "IIT", lat: 22.318, lng: 87.312 }, to: { label: "x", ...along } });
  assert.ok(!rev || !rev.reasons.some((r) => r.kind === "overlap"));
  // far away / wrong time / full / wrong date → no match
  assert.equal(scoreTrip(t, { to: { label: "Delhi", lat: 28.6, lng: 77.2 } }), null);
  assert.equal(scoreTrip(t, { to: { label: "IIT", lat: 22.316, lng: 87.31 }, time: "11:00" }), null);
  assert.equal(scoreTrip({ ...t, seats_left: 0 }, { to: { label: "IIT", lat: 22.316, lng: 87.31 } }), null);
  assert.equal(scoreTrip(t, { to: { label: "IIT", lat: 22.316, lng: 87.31 }, date: day(3) }), null);
  // names only (no coordinates anywhere)
  const named = scoreTrip({ ...t, geo: {} }, { to: { label: "iit kharagpur" } });
  assert.equal(named.reasons[0].basis, "name");
});

test("contribution estimates state their assumptions", () => {
  const car = estimateContribution({ distance_km: 120, vehicle_type: "car", people: 4, fuel_price: 100 });
  assert.equal(car.total_inr, 800); assert.equal(car.per_person_inr, 200); assert.equal(car.estimated, true);
  assert.ok(car.assumptions.some((a) => /15 km per litre/.test(a)) && car.assumptions.some((a) => /₹100\/litre/.test(a)));
  const rough = estimateContribution({ distance_km: 10, basis: "straight_line", vehicle_type: "bike", people: 2, fuel_price: 100 });
  assert.equal(rough.road_km, 13); assert.match(rough.assumptions[0], /straight-line/);
  assert.equal(estimateContribution({ distance_km: 10, vehicle_type: "public" }).available, false);
  assert.equal(estimateContribution({ distance_km: 0 }), null);
});

test("trips get approximate coordinates + a road route when the map service is configured", async () => {
  mapOn();
  try {
    const o = await signup("Map Owner");
    const t = await trip(o, { origin: "Howrah Station", destination: "IIT Kharagpur" });
    assert.deepEqual(t.geo.origin, { lat: 22.583, lng: 88.342 }); assert.ok(t.geo.has_route); assert.ok(t.geo.distance_m > 100000);
    const r = (await new Client().get(`/api/trips/${t.id}/route`)).data;
    assert.equal(r.coords.length, 21); assert.ok(r.straight_km > 100); assert.equal(r.estimated, true);
    // a point picked in the composer wins over geocoding; coordinates are rounded (~100 m)
    const t2 = await trip(o, { origin: "My lane", destination: "Park Street", origin_point: { lat: 22.5761234, lng: 88.4334567 }, depart_time: "09:00" });
    assert.deepEqual(t2.geo.origin, { lat: 22.576, lng: 88.433 });
    assert.equal((await o.post("/api/trips", { origin: "A b", destination: "C d", depart_date: day(1), depart_time: "08:00", vehicle_type: "car", seats_total: 1, origin_point: { lat: 200, lng: 1 } })).status, 400);
    // editing the destination re-maps the route
    const e = (await o.patch(`/api/trips/${t2.id}`, { destination: "Howrah Station" })).data.trip;
    assert.deepEqual(e.geo.dest, { lat: 22.583, lng: 88.342 });
    // map listing + filters
    const mapped = (await new Client().get("/api/trips?mapped=1")).data.trips.map((x) => x.id);
    assert.ok(mapped.includes(t.id) && mapped.includes(t2.id));
    assert.equal((await new Client().get("/api/trips?min_seats=9")).status, 400);
    // place search goes through the server (key never sent to the browser) and is cached
    const before = geoCalls.length;
    const s = (await o.get("/api/geo/search?q=park street")).data;
    assert.equal(s.enabled, true); assert.equal(s.places[0].lat, 22.553);
    await o.get("/api/geo/search?q=park street");
    assert.equal(geoCalls.length, before + 1, "second identical search served from cache");
    const cfg = (await new Client().get("/api/config")).data;
    assert.equal(cfg.geo, true); assert.equal(cfg.map, true); assert.equal(cfg.map_token, "pk.test-map-token");
    assert.match((await fetch(base + "/")).headers.get("content-security-policy"), /api\.mapbox\.com/);
  } finally { mapOff(); }
  // a secret (sk.) token is never sent to browsers
  process.env.MAPBOX_TOKEN = "sk.secret";
  try { assert.equal((await new Client().get("/api/config")).data.map_token, ""); } finally { mapOff(); }
  // without a key: posting still works, just without coordinates
  const o2 = await signup("Plain Owner");
  const p = await trip(o2, { origin: "Gol Bazar", destination: "IIT Kharagpur Main Gate" });
  assert.equal(p.geo.origin, null); assert.equal(p.geo.has_route, false);
  assert.deepEqual((await o2.get("/api/geo/search?q=gol")).data, { enabled: false, places: [] });
});

test("route matching API: reasons, filters, privacy and authorization", async () => {
  mapOn();
  try {
    const o = await signup("Match Owner"), wo = await signup("Women Owner", { gender: "female" }), rider = await signup("Match Rider"), blocker = await signup("Match Blocker");
    const a = await trip(o, { origin: "Howrah Station", destination: "IIT Kharagpur", depart_time: "07:30" });
    const full = await trip(o, { origin: "Howrah Station", destination: "IIT Kharagpur", depart_time: "07:40", seats_total: 1 });
    const iv = await rider.post(`/api/trips/${full.id}/interest`); assert.equal(iv.status, 201);
    const fid = (await o.get(`/api/trips/${full.id}`)).data.interests[0].id; await o.post(`/api/interests/${fid}/accept`);
    const w = await trip(wo, { origin: "Howrah Station", destination: "IIT Kharagpur", depart_time: "07:45", women_only: true });
    const b = await trip(blocker, { origin: "Howrah Station", destination: "IIT Kharagpur", depart_time: "07:50" });
    await blocker.post(`/api/block/${rider.user.id}`);
    const far = await trip(o, { origin: "Salt Lake Sector V", destination: "Park Street", depart_time: "07:30" });

    assert.equal((await new Client().post("/api/match", { to: { label: "IIT" } })).status, 401);
    assert.equal((await rider.post("/api/match", {})).status, 400);
    const r = (await rider.post("/api/match", { from: { label: "Uluberia" }, to: { label: "IIT Kharagpur" }, date: day(1), time: "08:00", flex: 60 })).data;
    const ids = r.results.map((x) => x.trip.id);
    assert.ok(ids.includes(a.id), "compatible journey is found");
    for (const [id, why] of [[full.id, "full"], [w.id, "women-only"], [b.id, "blocked"], [far.id, "other route"]]) assert.ok(!ids.includes(id), `${why} excluded`);
    const top = r.results.find((x) => x.trip.id === a.id);
    assert.ok(top.reasons.some((x) => x.kind === "pickup" && x.basis === "route"), JSON.stringify(top.reasons));
    assert.ok(top.reasons.some((x) => x.kind === "destination"));
    assert.ok(!("coords" in top.trip.geo), "route geometry isn't bulk-sent");
    assert.equal(r.from.lat, 22.503, "typed places are resolved server-side");
    // own trips never recommended to yourself
    assert.ok(!(await o.post("/api/match", { to: { label: "IIT Kharagpur" } })).data.results.some((x) => x.trip.owner.id === o.user.id));
  } finally { mapOff(); }
});

test("Saath AI basic mode (no key): real data only, captions, estimates, empty results", async () => {
  const o = await signup("Ai Owner", { college: "IIT Kharagpur" }), u = await signup("Ai User");
  const t = await trip(o, { origin: "Gol Bazar", destination: "Nalanda Complex", depart_date: day(1), depart_time: "08:30", vehicle_type: "bike", seats_total: 1 });
  assert.equal((await new Client().post("/api/ai/chat", { message: "hi" })).status, 401);
  assert.equal((await u.post("/api/ai/chat", { message: "" })).status, 400);
  assert.equal((await u.post("/api/ai/chat", { message: "x".repeat(601) })).status, 400);

  const s = (await u.post("/api/ai/chat", { message: "Find people going to Nalanda Complex tomorrow morning" })).data;
  assert.equal(s.mode, "basic"); assert.match(s.notice, /basic mode/);
  assert.deepEqual(s.cards.map((c) => c.trip.id), [t.id]); assert.ok(s.cards[0].reasons.length);
  assert.match(s.reply, /found 1 journey/);
  const none = (await u.post("/api/ai/chat", { message: "Show trips to Darjeeling tomorrow" })).data;
  assert.equal(none.cards.length, 0); assert.match(none.reply, /No open journeys/); assert.match(none.reply, /post|save/i);
  const cap = (await o.post("/api/ai/chat", { message: "Help me write a caption for my motorcycle trip" })).data;
  assert.match(cap.reply, /Gol Bazar → Nalanda Complex/); assert.equal(cap.cards.length, 0);
  const est = (await u.post("/api/ai/chat", { message: "estimate the contribution for 22 km by car for 3 people" })).data;
  assert.ok(est.estimate && est.estimate.per_person_inr > 0); assert.match(est.reply, /Assumptions/);
  const ctx = (await u.post("/api/ai/chat", { message: "Help me estimate the contribution for this route", trip_id: t.id })).data;
  assert.match(ctx.reply, /need a route|Rough estimate/, "no map distance → asks instead of inventing");
  assert.ok(!JSON.stringify(s).includes("password_hash") && !JSON.stringify(s).includes("@example.com"));
});

test("Saath AI with the Claude API: tools run on real data, cards only from tool results, failures fall back", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
  try {
    const o = await signup("Claude Owner"), u = await signup("Claude User");
    const t = await trip(o, { origin: "Gol Bazar", destination: "Vikramshila Hall", depart_date: day(1), depart_time: "08:15" });
    aiRequests = [];
    aiScript = [
      { stop_reason: "tool_use", content: [{ type: "text", text: "Let me look." }, { type: "tool_use", id: "tu1", name: "find_journeys", input: { to: "Vikramshila Hall", date: day(1), time: "08:00", flex_minutes: 120 } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Claude found one journey tomorrow at 8:15 AM. Also trip #99999 has 4 seats!" }] },
    ];
    const r = (await u.post("/api/ai/chat", { message: "Find people going to IIT Kharagpur tomorrow morning", history: [{ role: "assistant", text: "Hi!" }, { role: "user", text: "hello" }, { role: "assistant", text: "Hey" }] })).data;
    assert.equal(r.mode, "ai"); assert.match(r.reply, /one journey/);
    assert.deepEqual(r.cards.map((c) => c.trip.id), [t.id], "cards come only from tool results — the invented #99999 never becomes a card");
    assert.equal(aiRequests.length, 2);
    assert.equal(aiRequests[0].headers["x-api-key"], "sk-ant-test-key"); assert.equal(aiRequests[0].body.model, process.env.AI_MODEL || "claude-haiku-5-5");
    assert.equal(aiRequests[0].body.messages[0].role, "user", "history is trimmed to start with a user turn");
    const toolResult = JSON.parse(aiRequests[1].body.messages.at(-1).content[0].content);
    assert.equal(toolResult.journeys[0].trip_id, t.id); assert.ok(!JSON.stringify(toolResult).includes("@example.com"), "no emails sent to the AI");
    assert.ok(!JSON.stringify(r).includes("sk-ant-test-key"), "key never returned");

    aiScript = [{ status: 529 }];
    const f = (await u.post("/api/ai/chat", { message: "Find people going to Vikramshila Hall tomorrow" })).data;
    assert.equal(f.mode, "basic"); assert.match(f.notice, /couldn't reach/); assert.deepEqual(f.cards.map((c) => c.trip.id), [t.id]);
    assert.equal((await u.get("/api/config")).data.ai, true);
  } finally { delete process.env.ANTHROPIC_API_KEY; }
});

test("AI usage limits", async () => {
  const s = createApp({ limits: { ai: 2, aiDay: 100, api: 9999, auth: 99 } }).listen(0);
  try {
    const b = `http://127.0.0.1:${s.address().port}`;
    const su = await fetch(b + "/api/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Limit User", email: `limit${Date.now()}@example.com`, password: "password123" }) });
    const cookie = su.headers.getSetCookie()[0].split(";")[0];
    const ask = () => fetch(b + "/api/ai/chat", { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ message: "hello" }) });
    assert.equal((await ask()).status, 200); assert.equal((await ask()).status, 200); assert.equal((await ask()).status, 429);
  } finally { s.close(); }
});

test("saved routes: CRUD, ownership, opt-in alerts and recommendations", async () => {
  mapOn();
  try {
    const me = await signup("Route Saver"), other = await signup("Route Other"), poster = await signup("Route Poster", { college: "Jadavpur University" });
    assert.equal((await me.post("/api/routes", { name: "Office" })).status, 400);
    const r = (await me.post("/api/routes", { name: "Office", from: { label: "Uluberia" }, to: { label: "IIT Kharagpur" }, depart_time: "08:00", days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "Xyz"] })).data.route;
    assert.equal(r.to.lat, 22.316); assert.equal(r.days.length, 7); assert.equal(r.notify, true);
    assert.equal((await other.patch(`/api/routes/${r.id}`, { name: "mine" })).status, 404);
    assert.equal((await other.del(`/api/routes/${r.id}`)).status, 404);
    assert.equal((await other.get("/api/routes")).data.routes.length, 0);
    assert.equal((await me.patch(`/api/routes/${r.id}`, { depart_time: "25:00" })).status, 400);

    const t = await trip(poster, { origin: "Howrah Station", destination: "IIT Kharagpur", depart_time: "08:10" });
    await trip(poster, { origin: "Salt Lake Sector V", destination: "Park Street", depart_time: "08:10" });
    await new Promise((res) => setTimeout(res, 150));
    const alerts = (await me.get("/api/notifications")).data.notifications.filter((x) => x.type === "route_match");
    assert.equal(alerts.length, 1); assert.equal(alerts[0].link, `#/trip/${t.id}`); assert.match(alerts[0].title, /Office/);
    assert.ok(!(await other.get("/api/notifications")).data.notifications.some((x) => x.type === "route_match"));

    const rec = (await me.get("/api/recommendations")).data;
    const hit = rec.items.find((i) => i.trip.id === t.id);
    assert.ok(hit, "matching journey recommended"); assert.match(hit.because, /Office/); assert.ok(hit.reasons.length);
    await me.patch(`/api/routes/${r.id}`, { notify: false });
    await trip(poster, { origin: "Howrah Station", destination: "IIT Kharagpur", depart_time: "08:20" });
    await new Promise((res) => setTimeout(res, 150));
    assert.equal((await me.get("/api/notifications")).data.notifications.filter((x) => x.type === "route_match").length, 1, "alerts off → no new alert");
    assert.equal((await me.del(`/api/routes/${r.id}`)).status, 200);
  } finally { mapOff(); }
});

test("communities and people search respect privacy and blocks", async () => {
  const a = await signup("Comm Anika", { college: "NIT Durgapur" }), b = await signup("Comm Bose", { college: "  nit durgapur " }), hidden = await signup("Comm Hidden", { college: "NIT Durgapur" }), blk = await signup("Comm Blocker", { college: "NIT Durgapur" });
  await hidden.patch("/api/me", { show_college: false });
  await blk.post(`/api/block/${a.user.id}`);
  const bt = await trip(b, { origin: "City Centre", destination: "Station Road", depart_time: "10:00" });
  const c = (await a.get("/api/community")).data;
  const names = c.members.map((m) => m.name);
  assert.ok(names.includes("Comm Anika") && names.includes("Comm Bose"), names.join());
  assert.ok(!names.includes("Comm Hidden"), "hidden college → not listed"); assert.ok(!names.includes("Comm Blocker"), "blocked → not listed");
  assert.ok(c.trips.some((t) => t.id === bt.id)); assert.equal(c.is_mine, true);
  assert.ok(!JSON.stringify(c).includes("@example.com"));
  assert.ok((await a.get("/api/trips?scope=community")).data.trips.some((t) => t.id === bt.id), "community feed filter");
  const rec = (await a.get("/api/recommendations")).data;
  assert.ok(rec.items.some((i) => i.trip.id === bt.id && /community/.test(i.because)));

  const s = (await a.get("/api/users/search?q=comm")).data.users.map((u) => u.name);
  assert.ok(s.includes("Comm Bose") && s.includes("Comm Hidden")); assert.ok(!s.includes("Comm Blocker") && !s.includes("Comm Anika"));
  assert.equal((await a.get("/api/users/search?q=durgapur")).data.users.filter((u) => u.name === "Comm Hidden").length, 0, "can't find people by a college they hid");
  assert.equal((await new Client().get("/api/users/search?q=comm")).status, 401);
});

test("trip updates: owner-only, travellers-only, short-lived, and notification preferences", async () => {
  const o = await signup("Upd Owner"), r = await signup("Upd Rider"), x = await signup("Upd Stranger");
  const t = await trip(o, { origin: "Hostel Gate", destination: "Tech Park", depart_date: day(0) === day(0) ? day(1) : day(1) });
  await r.post(`/api/trips/${t.id}/interest`);
  const iid = (await o.get(`/api/trips/${t.id}`)).data.interests[0].id; await o.post(`/api/interests/${iid}/accept`);
  assert.equal((await r.post(`/api/trips/${t.id}/updates`, { kind: "late", minutes: 10 })).status, 403);
  assert.equal((await o.post(`/api/trips/${t.id}/updates`, { kind: "teleport" })).status, 400);
  assert.equal((await o.post(`/api/trips/${t.id}/updates`, { kind: "note" })).status, 400);
  const u = await o.post(`/api/trips/${t.id}/updates`, { kind: "late", minutes: 10, note: "traffic at the flyover" });
  assert.equal(u.status, 201); assert.equal(u.data.update.body, "Running about 10 min late — traffic at the flyover"); assert.equal(u.data.notified, 1);
  assert.equal((await r.get(`/api/trips/${t.id}/updates`)).data.updates.length, 1);
  assert.deepEqual((await x.get(`/api/trips/${t.id}/updates`)).data, { updates: [], can_view: false });
  assert.ok((await r.get("/api/notifications")).data.notifications.some((n) => n.type === "trip_update"));
  await db.query("UPDATE trip_updates SET expires_at = $1", [new Date(Date.now() - 1000).toISOString()]);
  assert.equal((await r.get(`/api/trips/${t.id}/updates`)).data.updates.length, 0, "updates expire");
  const later = await trip(o, { origin: "Hostel Gate", destination: "Tech Park", depart_date: day(5) });
  assert.equal((await o.post(`/api/trips/${later.id}/updates`, { kind: "leaving" })).status, 400, "only on the day of travel");

  // notification preferences
  assert.equal((await r.get("/api/me/notification-prefs")).data.prefs.trip_updates, true);
  assert.equal((await r.put("/api/me/notification-prefs", { prefs: { trip_updates: false, bogus: false } })).data.prefs.trip_updates, false);
  const before = (await r.get("/api/notifications")).data.notifications.length;
  await o.post(`/api/trips/${t.id}/updates`, { kind: "leaving" });
  assert.equal((await r.get("/api/notifications")).data.notifications.length, before, "switched-off category is not delivered");
  await r.put("/api/me/notification-prefs", { prefs: { trips: false } });
  await o.patch(`/api/trips/${t.id}`, { status: "cancelled" });
  assert.ok((await r.get("/api/notifications")).data.notifications.some((n) => n.type === "trip_cancelled"), "cancellations always delivered");
});

test("report review is only for ADMIN_EMAILS accounts", async () => {
  const admin = await signup("Real Admin"), user = await signup("Normal User"), bad = await signup("Bad Actor");
  const t = await trip(bad, { origin: "Spam Road", destination: "Scam Street" });
  await user.post(`/api/trips/${t.id}/report`, { reason: "spam" });
  await user.post(`/api/users/${bad.user.id}/report`, { reason: "harassment", details: "rude" });
  assert.equal((await admin.get("/api/admin/reports")).status, 404, "no admins configured → hidden");
  process.env.ADMIN_EMAILS = `someone@else.com, ${admin.email.toUpperCase()}`;
  try {
    assert.equal((await user.get("/api/admin/reports")).status, 404);
    assert.equal((await admin.get("/api/me")).data.user.is_admin, true); assert.equal((await user.get("/api/me")).data.user.is_admin, false);
    const r = (await admin.get("/api/admin/reports")).data;
    assert.equal(r.trip_reports[0].trip_id, t.id); assert.equal(r.user_reports[0].reported_id, bad.user.id);
    assert.equal((await user.post(`/api/admin/reports/user/${r.user_reports[0].id}`, { status: "resolved" })).status, 404);
    assert.equal((await admin.post(`/api/admin/reports/user/${r.user_reports[0].id}`, { status: "resolved" })).data.status, "resolved");
    assert.equal((await admin.post(`/api/admin/reports/nope/1`, { status: "resolved" })).status, 404);
  } finally { delete process.env.ADMIN_EMAILS; }
});
