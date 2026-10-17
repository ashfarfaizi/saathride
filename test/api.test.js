// Run with: npm test   (uses Node's built-in test runner; DB is in-memory SQLite via test/sqlite-adapter.js)
process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const { createApp } = require("../server");

let server, base;
const dayOffset = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

class Client {
  constructor() { this.cookie = ""; }
  async req(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method, headers: { ...(body !== undefined || method !== "GET" ? { "Content-Type": "application/json" } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : method === "GET" ? undefined : "{}",
    });
    const sc = res.headers.getSetCookie?.() || [];
    for (const c of sc) { const [pair] = c.split(";"); this.cookie = pair.endsWith("=") ? "" : pair; }
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data, headers: res.headers };
  }
  get(p) { return this.req("GET", p); }
  post(p, b = {}) { return this.req("POST", p, b); }
  patch(p, b = {}) { return this.req("PATCH", p, b); }
  del(p) { return this.req("DELETE", p, {}); }
}
async function signup(name, extra = {}) {
  const c = new Client();
  const r = await c.post("/api/auth/signup", { name, email: `${name.toLowerCase().replace(/\s/g, "")}@example.com`, password: "password123", ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  c.user = r.data.user;
  return c;
}
const tripBody = (o = {}) => ({ origin: "Gol Bazar", destination: "IIT Kharagpur", depart_date: dayOffset(1), depart_time: "08:15", vehicle_type: "car", seats_total: 2, contribution_inr: 40, description: "Anyone going to campus?", ...o });

test.before(async () => {
  await db.migrate();
  server = createApp({ limits: { auth: 1000, write: 1000, trip: 1000, interest: 1000, report: 1000, message: 1000, api: 100000 } }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test("health + static + SPA fallback + unknown api", async () => {
  const c = new Client();
  assert.deepEqual((await c.get("/api/health")).data, { ok: true, db: true });
  assert.equal((await fetch(base + "/")).status, 200);
  assert.match(await (await fetch(base + "/some/deep/link")).text(), /<main id="app"/);
  assert.equal((await c.get("/api/nope")).status, 404);
});

test("auth: validation, signup, duplicate, login, me, logout", async () => {
  const c = new Client();
  assert.equal((await c.post("/api/auth/signup", { name: "A", email: "bad", password: "x" })).status, 400);
  assert.equal((await c.post("/api/auth/signup", { name: "Asha Rao", email: "asha@iitkgp.ac.in", password: "short" })).status, 400);
  const ok = await c.post("/api/auth/signup", { name: "Asha Rao", email: "Asha@iitkgp.ac.in", password: "longenough1", phone: "9800000000", gender: "female" });
  assert.equal(ok.status, 201);
  assert.ok(ok.data.user.edu_email && !("password_hash" in ok.data.user) && !("is_verified" in ok.data.user));
  assert.match(c.cookie, /^sr_token=/);
  assert.equal((await new Client().post("/api/auth/signup", { name: "Asha 2", email: "asha@iitkgp.ac.in", password: "longenough1" })).status, 409);
  assert.equal((await c.get("/api/me")).data.user.email, "asha@iitkgp.ac.in");
  await c.post("/api/auth/logout");
  assert.equal((await c.get("/api/me")).data.user, null);
  const l = new Client();
  assert.equal((await l.post("/api/auth/login", { email: "asha@iitkgp.ac.in", password: "wrong" })).status, 401);
  assert.equal((await l.post("/api/auth/login", { email: "nobody@x.com", password: "wrong" })).status, 401);
  assert.equal((await l.post("/api/auth/login", { email: "ASHA@iitkgp.ac.in", password: "longenough1" })).status, 200);
  assert.equal((await l.get("/api/me")).data.user.name, "Asha Rao");
});

test("auth cookie is HttpOnly + SameSite; CSRF protections", async () => {
  const res = await fetch(base + "/api/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Cookie Test", email: "cookie@example.com", password: "password123" }) });
  const sc = res.headers.getSetCookie().join(";");
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Lax/);
  const noJson = await fetch(base + "/api/auth/logout", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" });
  assert.equal(noJson.status, 415);
  const cross = await fetch(base + "/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: "{}" });
  assert.equal(cross.status, 403);
  const tampered = await fetch(base + "/api/me", { headers: { Cookie: "sr_token=garbage" } });
  assert.equal((await tampered.json()).user, null);
});

test("profiles: edit own, public view hides private data, requires login", async () => {
  const a = await signup("Priya Nair", { gender: "female", phone: "9811111111", college: "IIT Kharagpur" });
  const b = await signup("Rohan Das");
  const upd = await a.patch("/api/me", { bio: "Final-year, commute daily", interests: "chess, football , chess", travel_areas: ["Gol Bazar", "Salt Lake"], travel_modes: "car, bike, rocket", avatar_color: 5, id: b.user.id, email: "hack@x.com", password_hash: "x" });
  assert.equal(upd.status, 200);
  assert.deepEqual(upd.data.user.interests, ["chess", "football"]);
  assert.deepEqual(upd.data.user.travel_modes, ["car", "bike"]);
  assert.equal(upd.data.user.avatar_color, 5);
  assert.equal(upd.data.user.email, "priyanair@example.com");           // mass-assignment ignored
  assert.equal((await b.get("/api/me")).data.user.name, "Rohan Das");     // other user unaffected
  assert.equal((await a.patch("/api/me", { avatar_color: 99 })).status, 400);
  assert.equal((await new Client().patch("/api/me", { bio: "x" })).status, 401);
  const pub = await b.get(`/api/users/${a.user.id}`);
  assert.equal(pub.status, 200);
  const s = JSON.stringify(pub.data);
  for (const secret of ["9811111111", "priyanair@example.com", "password", "gender"]) assert.ok(!s.includes(secret), `leaked ${secret}`);
  assert.equal(pub.data.user.bio, "Final-year, commute daily");
  assert.equal((await new Client().get(`/api/users/${a.user.id}`)).status, 401);
  assert.equal((await b.get("/api/users/99999")).status, 404);
  assert.equal((await b.get("/api/users/abc")).status, 404);
});

test("trips: validation, create, feed shows DB data, filters", async () => {
  const owner = await signup("Feed Owner", { gender: "female" });
  const c = new Client();
  assert.equal((await c.post("/api/trips", tripBody())).status, 401);
  const bads = [
    { origin: "" }, { destination: "gol bazar", origin: "Gol Bazar" }, { depart_date: dayOffset(-1) }, { depart_date: "2026-02-31" },
    { depart_time: "25:00" }, { vehicle_type: "rocket" }, { seats_total: 0 }, { seats_total: 9 }, { vehicle_type: "bike", seats_total: 3 }, { contribution_inr: -5 }, { women_only: true, },
  ];
  // women_only is allowed for this female owner, so skip it in the bad list
  for (const b of bads.slice(0, -1)) assert.equal((await owner.post("/api/trips", tripBody(b))).status, 400, JSON.stringify(b));
  const m = await signup("Male User");
  assert.equal((await m.post("/api/trips", tripBody({ women_only: true }))).status, 400);

  const t1 = await owner.post("/api/trips", tripBody());
  assert.equal(t1.status, 201);
  assert.equal(t1.data.trip.seats_left, 2); assert.equal(t1.data.trip.status, "open"); assert.equal(t1.data.trip.owner.name, "Feed Owner");
  assert.equal((await owner.post("/api/trips", tripBody())).status, 409);                            // duplicate post
  await owner.post("/api/trips", tripBody({ origin: "Salt Lake", destination: "Sector V", depart_date: dayOffset(2), depart_time: "09:00", vehicle_type: "public", seats_total: undefined, contribution_inr: undefined, recurring: ["Mon", "Fri", "Xyz"] }));
  await owner.post("/api/trips", tripBody({ origin: "Howrah", destination: "Kolkata Airport", depart_date: dayOffset(1), depart_time: "21:30", vehicle_type: "cab", seats_total: 3, women_only: true }));

  const all = (await new Client().get("/api/trips")).data.trips;
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((t) => t.depart_time), ["08:15", "21:30", "09:00"]);                       // sorted date then time
  const sl = all.find((t) => t.origin === "Salt Lake");
  assert.equal(sl.seats_total, null); assert.deepEqual(sl.recurring, ["Mon", "Fri"]);
  const q = async (qs) => (await new Client().get("/api/trips?" + qs)).data.trips.map((t) => t.origin);
  assert.deepEqual(await q("origin=gol"), ["Gol Bazar"]);
  assert.deepEqual(await q("destination=AIRPORT"), ["Howrah"]);
  assert.deepEqual((await q(`date=${dayOffset(2)}`)), ["Salt Lake"]);
  assert.deepEqual(await q("time_from=20:00"), ["Howrah"]);
  assert.deepEqual(await q("time_from=08:00&time_to=09:30"), ["Gol Bazar", "Salt Lake"]);
  assert.deepEqual(await q("vehicle_type=public"), ["Salt Lake"]);
  assert.deepEqual(await q("women_only=1"), ["Howrah"]);
  assert.deepEqual(await q("recurring=1"), ["Salt Lake"]);
  assert.deepEqual(await q("origin=%25"), []);                                                         // LIKE wildcard is escaped
  assert.equal((await new Client().get("/api/trips?date=nope")).status, 400);
  assert.equal((await new Client().get("/api/trips?vehicle_type=x")).status, 400);
  const detail = await new Client().get(`/api/trips/${t1.data.trip.id}`);
  assert.equal(detail.status, 200); assert.equal(detail.data.interests, undefined);
  assert.equal((await new Client().get("/api/trips/987654")).status, 404);
});

test("interest workflow: request, duplicates, accept, seats, decline, withdraw, persistence", async () => {
  const owner = await signup("Trip Owner");
  const [r1, r2, r3] = [await signup("Rider One"), await signup("Rider Two"), await signup("Rider Three")];
  const { trip } = (await owner.post("/api/trips", tripBody({ origin: "Interest A", destination: "Interest B", seats_total: 1 }))).data;

  assert.equal((await new Client().post(`/api/trips/${trip.id}/interest`)).status, 401);
  assert.equal((await owner.post(`/api/trips/${trip.id}/interest`)).status, 400);                      // own trip
  const i1 = await r1.post(`/api/trips/${trip.id}/interest`, { message: "Can I join at the gate?" });
  assert.equal(i1.status, 201);
  assert.equal(i1.data.trip.my_interest, "pending");
  assert.equal(i1.data.trip.seats_left, 1);                                                            // interest does NOT hold a seat
  assert.equal((await r1.post(`/api/trips/${trip.id}/interest`)).status, 409);                         // duplicate
  await r2.post(`/api/trips/${trip.id}/interest`);

  const ownerView = (await owner.get(`/api/trips/${trip.id}`)).data;
  assert.equal(ownerView.interests.length, 2);
  assert.equal(ownerView.trip.pending_count, 2);
  const [req1, req2] = ownerView.interests;
  assert.equal(req1.message, "Can I join at the gate?");

  // authorization
  assert.equal((await r1.post(`/api/interests/${req2.id}/accept`)).status, 403);                       // other rider
  assert.equal((await r3.post(`/api/interests/${req1.id}/decline`)).status, 403);
  assert.equal((await new Client().post(`/api/interests/${req1.id}/accept`)).status, 401);
  assert.equal((await owner.post(`/api/interests/${req1.id}/explode`)).status, 404);

  // accept uses the only seat; second accept must fail
  const acc = await owner.post(`/api/interests/${req1.id}/accept`);
  assert.equal(acc.status, 200); assert.equal(acc.data.trip.seats_left, 0); assert.equal(acc.data.trip.is_full, true);
  assert.equal((await owner.post(`/api/interests/${req2.id}/accept`)).status, 400);
  assert.equal((await owner.post(`/api/interests/${req1.id}/accept`)).status, 400);                    // already accepted
  assert.equal((await r3.post(`/api/trips/${trip.id}/interest`)).status, 400);                         // full → no new requests

  // state survives "refresh" (fresh sessions re-reading from the DB)
  const fresh = new Client(); await fresh.post("/api/auth/login", { email: "riderone@example.com", password: "password123" });
  assert.equal((await fresh.get(`/api/trips/${trip.id}`)).data.trip.my_interest, "accepted");
  assert.equal((await fresh.get("/api/me/trips")).data.interested[0].id, trip.id);

  // owner raises seats, accepts second; cannot drop below confirmed
  assert.equal((await owner.patch(`/api/trips/${trip.id}`, { seats_total: 2 })).data.trip.seats_left, 1);
  assert.equal((await owner.post(`/api/interests/${req2.id}/accept`)).status, 200);
  assert.equal((await owner.patch(`/api/trips/${trip.id}`, { seats_total: 1 })).status, 400);

  // withdraw frees the seat; re-express allowed after withdraw
  const w = await r1.del(`/api/trips/${trip.id}/interest`);
  assert.equal(w.status, 200); assert.equal(w.data.trip.my_interest, "withdrawn"); assert.equal(w.data.trip.seats_left, 1);
  assert.equal((await r1.del(`/api/trips/${trip.id}/interest`)).status, 400);
  assert.equal((await r1.post(`/api/trips/${trip.id}/interest`)).status, 201);
  assert.equal((await r1.get(`/api/trips/${trip.id}`)).data.trip.my_interest, "pending");

  // decline blocks re-request; declining an accepted rider removes them and frees the seat
  const iv = (await owner.get(`/api/trips/${trip.id}`)).data.interests;
  const r2req = iv.find((i) => i.user.id === r2.user.id);
  const dec = await owner.post(`/api/interests/${r2req.id}/decline`);
  assert.equal(dec.data.trip.seats_left, 2);
  assert.equal((await r2.post(`/api/trips/${trip.id}/interest`)).status, 409);

  // trip status controls
  assert.equal((await r1.patch(`/api/trips/${trip.id}`, { status: "cancelled" })).status, 403);        // non-owner
  assert.equal((await r1.patch(`/api/trips/${trip.id}`, { seats_total: 5 })).status, 403);
  assert.equal((await owner.patch(`/api/trips/${trip.id}`, { status: "closed" })).data.trip.status, "closed");
  assert.equal((await new Client().get("/api/trips?origin=Interest")).data.trips.length, 0);           // closed trips leave the feed
  assert.equal((await r3.post(`/api/trips/${trip.id}/interest`)).status, 400);
  assert.equal((await owner.patch(`/api/trips/${trip.id}`, { status: "bogus" })).status, 400);
});

test("concurrent accepts never over-fill seats", async () => {
  const owner = await signup("Race Owner");
  const riders = await Promise.all(["Race A", "Race B", "Race C", "Race D"].map((n) => signup(n)));
  const { trip } = (await owner.post("/api/trips", tripBody({ origin: "Race X", destination: "Race Y", seats_total: 2 }))).data;
  for (const r of riders) await r.post(`/api/trips/${trip.id}/interest`);
  const ids = (await owner.get(`/api/trips/${trip.id}`)).data.interests.map((i) => i.id);
  const results = await Promise.all(ids.map((id) => owner.post(`/api/interests/${id}/accept`)));
  assert.equal(results.filter((r) => r.status === 200).length, 2);
  assert.equal((await owner.get(`/api/trips/${trip.id}`)).data.trip.seats_left, 0);
});

test("women-only trips: only female members can request", async () => {
  const owner = await signup("Women Owner", { gender: "female" });
  const male = await signup("Some Guy", { gender: "male" });
  const female = await signup("Some Girl", { gender: "female" });
  const { trip } = (await owner.post("/api/trips", tripBody({ origin: "WO A", destination: "WO B", women_only: true }))).data;
  assert.equal((await male.post(`/api/trips/${trip.id}/interest`)).status, 403);
  assert.equal((await female.post(`/api/trips/${trip.id}/interest`)).status, 201);
});

test("save and report (3 reports hide a trip from the feed)", async () => {
  const owner = await signup("Report Owner");
  const users = await Promise.all(["Reporter A", "Reporter B", "Reporter C"].map((n) => signup(n)));
  const { trip } = (await owner.post("/api/trips", tripBody({ origin: "Rep A", destination: "Rep B" }))).data;
  const u = users[0];
  assert.equal((await u.post(`/api/trips/${trip.id}/save`)).status, 200);
  assert.equal((await u.get(`/api/trips/${trip.id}`)).data.trip.saved, true);
  assert.equal((await u.get("/api/me/trips")).data.saved.length, 1);
  assert.equal((await u.del(`/api/trips/${trip.id}/save`)).data.saved, false);
  assert.equal((await u.get("/api/me/trips")).data.saved.length, 0);
  assert.equal((await owner.post(`/api/trips/${trip.id}/report`, { reason: "spam" })).status, 400);   // own trip
  assert.equal((await u.post(`/api/trips/${trip.id}/report`, { reason: "nonsense" })).status, 400);
  for (const r of users) assert.equal((await r.post(`/api/trips/${trip.id}/report`, { reason: "unsafe", details: "test" })).status, 201);
  assert.equal((await u.post(`/api/trips/${trip.id}/report`, { reason: "spam" })).status, 409);
  assert.equal((await new Client().get("/api/trips?origin=Rep A")).data.trips.length, 0);
});

test("private messages: only owner and that interested user; closed after decline", async () => {
  const owner = await signup("Msg Owner");
  const [a, b, stranger] = [await signup("Msg A"), await signup("Msg B"), await signup("Msg Stranger")];
  const { trip } = (await owner.post("/api/trips", tripBody({ origin: "Msg X", destination: "Msg Y" }))).data;
  assert.equal((await a.get(`/api/trips/${trip.id}/messages`)).status, 403);                           // no interest yet
  await a.post(`/api/trips/${trip.id}/interest`); await b.post(`/api/trips/${trip.id}/interest`);
  assert.equal((await a.post(`/api/trips/${trip.id}/messages`, { body: "Hi, where's pickup?" })).status, 201);
  assert.equal((await owner.post(`/api/trips/${trip.id}/messages`, { with: a.user.id, body: "Near the gate" })).status, 201);
  assert.equal((await a.post(`/api/trips/${trip.id}/messages`, { body: "   " })).status, 400);
  const texts = (r) => r.data.messages.filter((m) => m.kind === "text");
  const aMsgs = texts(await a.get(`/api/trips/${trip.id}/messages`));
  assert.deepEqual(aMsgs.map((m) => [m.body, m.mine]), [["Hi, where's pickup?", true], ["Near the gate", false]]);
  assert.equal(texts(await b.get(`/api/trips/${trip.id}/messages`)).length, 0);                         // B can't see A's thread
  assert.equal(texts(await owner.get(`/api/trips/${trip.id}/messages?with=${b.user.id}`)).length, 0);
  assert.equal((await stranger.get(`/api/trips/${trip.id}/messages`)).status, 403);
  assert.equal((await stranger.get(`/api/trips/${trip.id}/messages?with=${a.user.id}`)).status, 403);   // not owner → `with` ignored
  const ia = (await owner.get(`/api/trips/${trip.id}`)).data.interests.find((i) => i.user.id === a.user.id);
  await owner.post(`/api/interests/${ia.id}/decline`);
  assert.equal((await a.post(`/api/trips/${trip.id}/messages`, { body: "still there?" })).status, 403);
  assert.equal((await a.get(`/api/trips/${trip.id}/messages`)).data.can_send, false);
});

test("ratings only between people who travelled together, after completion", async () => {
  const owner = await signup("Rate Owner");
  const [rider, outsider] = [await signup("Rate Rider"), await signup("Rate Outsider")];
  const { trip } = (await owner.post("/api/trips", tripBody({ origin: "Rate A", destination: "Rate B" }))).data;
  await rider.post(`/api/trips/${trip.id}/interest`);
  const iid = (await owner.get(`/api/trips/${trip.id}`)).data.interests[0].id;
  await owner.post(`/api/interests/${iid}/accept`);
  assert.equal((await rider.post(`/api/trips/${trip.id}/rate`, { ratee_id: owner.user.id, stars: 5 })).status, 400);   // not completed
  await owner.patch(`/api/trips/${trip.id}`, { status: "completed" });
  assert.equal((await owner.patch(`/api/trips/${trip.id}`, { status: "open" })).status, 400);                          // terminal
  assert.equal((await outsider.post(`/api/trips/${trip.id}/rate`, { ratee_id: owner.user.id, stars: 1 })).status, 403);
  assert.equal((await rider.post(`/api/trips/${trip.id}/rate`, { ratee_id: owner.user.id, stars: 9 })).status, 400);
  assert.equal((await rider.post(`/api/trips/${trip.id}/rate`, { ratee_id: owner.user.id, stars: 4 })).status, 201);
  assert.equal((await rider.post(`/api/trips/${trip.id}/rate`, { ratee_id: owner.user.id, stars: 5 })).status, 409);
  assert.equal((await rider.get(`/api/users/${owner.user.id}`)).data.user.rating, 4);
  assert.equal((await rider.get(`/api/trips/${trip.id}/participants`)).data.people[0].rated, true);
  assert.equal((await outsider.get(`/api/trips/${trip.id}/participants`)).status, 403);
});

test("rate limiting kicks in on login attempts", async () => {
  const s = createApp({ limits: { auth: 3 } }).listen(0);
  try {
    const url = `http://127.0.0.1:${s.address().port}/api/auth/login`;
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "x@y.com", password: "nope" }) })).status);
    assert.deepEqual(codes, [401, 401, 401, 429, 429]);
  } finally { s.close(); }
});

test("malformed input is handled cleanly", async () => {
  const bad = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
  assert.equal(bad.status, 400);
  const big = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "a".repeat(30000) }) });
  assert.equal(big.status, 413);
  const xss = await signup("Xss Tester");
  const t = await xss.post("/api/trips", tripBody({ origin: "<img src=x onerror=alert(1)>", destination: "Safe Place" }));
  assert.equal(t.status, 201);   // stored as text; the frontend escapes on render
});
