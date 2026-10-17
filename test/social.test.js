// Tests for the social layer: photos, likes, comments, usernames, privacy, editing, share links.
// Run with: npm test   (in-memory SQLite stands in for Postgres; Cloudinary is never contacted)
process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const db = require("../db");
const { createApp } = require("../server");

let server, base;
const destroyed = [];
const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const CLOUD = "demo-cloud";
const img = (uid, name = "a1", kind = "posts") => ({
  url: `https://res.cloudinary.com/${CLOUD}/image/upload/v1/saathride/${kind}/${uid}/${name}.jpg`,
  public_id: `saathride/${kind}/${uid}/${name}`, width: 1200, height: 900,
});

class Client {
  constructor() { this.cookie = ""; }
  async req(method, path, body) {
    const res = await fetch(base + path, {
      method, headers: { "Content-Type": "application/json", ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}), redirect: "manual",
    });
    for (const c of res.headers.getSetCookie?.() || []) { const [pair] = c.split(";"); this.cookie = pair.endsWith("=") ? "" : pair; }
    const text = await res.text();
    let data = {}; try { data = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, data, text, headers: res.headers };
  }
  get(p) { return this.req("GET", p); } post(p, b) { return this.req("POST", p, b); }
  patch(p, b) { return this.req("PATCH", p, b); } del(p) { return this.req("DELETE", p); }
}
async function signup(name, extra = {}) {
  const c = new Client();
  const r = await c.post("/api/auth/signup", { name, email: `${name.toLowerCase().replace(/\W/g, "")}@example.com`, password: "password123", ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  c.user = r.data.user; return c;
}
const tripBody = (o = {}) => ({ origin: "Gol Bazar", destination: "IIT Kharagpur", depart_date: day(1), depart_time: "08:15", vehicle_type: "bike", seats_total: 1, contribution_inr: 30, description: "Spare seat, anyone going to campus?", ...o });
const post = async (c, o) => { const r = await c.post("/api/trips", tripBody(o)); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.trip; };

test.before(async () => {
  process.env.CLOUDINARY_CLOUD_NAME = CLOUD; process.env.CLOUDINARY_API_KEY = "key123"; process.env.CLOUDINARY_API_SECRET = "s3cret";
  await db.migrate();
  server = createApp({ limits: { auth: 9999, write: 9999, trip: 9999, interest: 9999, like: 9999, comment: 9999, upload: 9999, api: 999999 }, destroyImage: async (id) => { destroyed.push(id); } }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test("config + upload signing: needs login, matches Cloudinary's algorithm, 503 when unconfigured", async () => {
  const anon = new Client();
  assert.deepEqual((await anon.get("/api/config")).data, { uploads: true, max_images: 5, caption_max: 500, calls: false, calls_status: "not_configured", geo: false, map: false, map_token: "", map_status: "not_configured", ai: false, ai_status: "not_configured" });
  assert.equal((await anon.post("/api/uploads/sign", {})).status, 401);

  const u = await signup("Sign Tester");
  const r = await u.post("/api/uploads/sign", { kind: "post" });
  assert.equal(r.status, 200);
  const { timestamp, folder, signature, allowed_formats, api_key, upload_url, transformation } = r.data;
  assert.equal(transformation, "c_limit,w_2048,h_2048", "uploads are size-capped by a signed transformation");
  assert.equal(folder, `saathride/posts/${u.user.id}`);
  assert.equal(api_key, "key123");
  assert.equal(upload_url, `https://api.cloudinary.com/v1_1/${CLOUD}/image/upload`);
  const expected = crypto.createHash("sha1").update(`allowed_formats=${allowed_formats}&folder=${folder}&timestamp=${timestamp}&transformation=${transformation}s3cret`).digest("hex");
  assert.equal(signature, expected);
  assert.ok(!JSON.stringify(r.data).includes("s3cret"), "API secret must never be sent to the browser");
  assert.equal((await u.post("/api/uploads/sign", { kind: "avatar" })).data.folder, `saathride/avatars/${u.user.id}`);

  const saved = process.env.CLOUDINARY_API_SECRET; process.env.CLOUDINARY_API_SECRET = "";
  assert.equal((await u.post("/api/uploads/sign", {})).status, 503);
  assert.equal((await anon.get("/api/config")).data.uploads, false);
  assert.equal((await u.post("/api/trips", tripBody({ images: [img(u.user.id)] }))).status, 400, "images refused when storage isn't configured");
  assert.equal((await u.post("/api/trips", tripBody())).status, 201, "posting without photos still works");
  process.env.CLOUDINARY_API_SECRET = saved;
});

test("posts with photos: stored, validated, ownership of upload folder enforced", async () => {
  const a = await signup("Photo Owner"), b = await signup("Photo Other");
  const good = await a.post("/api/trips", tripBody({ vehicle_model: "Pulsar 150", images: [img(a.user.id, "p1"), img(a.user.id, "p2")] }));
  assert.equal(good.status, 201);
  const t = good.data.trip;
  assert.equal(t.images.length, 2); assert.equal(t.vehicle_model, "Pulsar 150");
  assert.equal(t.images[0].url, img(a.user.id, "p1").url);
  assert.equal(t.like_count, 0); assert.equal(t.comment_count, 0); assert.equal(t.share_path, `/p/${t.id}`);

  const bad = async (images) => (await a.post("/api/trips", tripBody({ images, origin: "X" + Math.random() }))).status;
  assert.equal(await bad([img(b.user.id)]), 400, "can't attach another user's upload folder");
  assert.equal(await bad([{ ...img(a.user.id), url: "https://evil.example/x.jpg" }]), 400, "foreign host rejected");
  assert.equal(await bad([{ ...img(a.user.id), url: `https://res.cloudinary.com/other-cloud/image/upload/v1/saathride/posts/${a.user.id}/a1.jpg` }]), 400, "foreign cloud rejected");
  assert.equal(await bad([{ ...img(a.user.id), url: img(a.user.id, "different").url }]), 400, "url must match public_id");
  assert.equal(await bad([{ ...img(a.user.id), public_id: `saathride/posts/${a.user.id}/../x` }]), 400);
  assert.equal(await bad(Array.from({ length: 6 }, (_, i) => img(a.user.id, "m" + i))), 400, "max 5 photos");
  assert.equal(await bad("nope"), 400);
  assert.equal(await bad([null]), 400);

  const feed = (await b.get("/api/trips")).data.trips.find((x) => x.id === t.id);
  assert.equal(feed.images.length, 2, "feed includes photos");
});

test("likes: one per person, idempotent, unlike, per-viewer flag, login required", async () => {
  const o = await signup("Like Owner"), f = await signup("Like Fan"), g = await signup("Like Other");
  const t = await post(o);
  assert.equal((await new Client().post(`/api/trips/${t.id}/like`)).status, 401);
  assert.equal((await f.post("/api/trips/999999/like")).status, 404);
  let r = await f.post(`/api/trips/${t.id}/like`); assert.deepEqual([r.data.liked, r.data.like_count], [true, 1]);
  r = await f.post(`/api/trips/${t.id}/like`); assert.deepEqual([r.data.liked, r.data.like_count], [true, 1], "double like doesn't double count");
  r = await g.post(`/api/trips/${t.id}/like`); assert.equal(r.data.like_count, 2);
  const seenByF = (await f.get(`/api/trips/${t.id}`)).data.trip, seenByAnon = (await new Client().get(`/api/trips/${t.id}`)).data.trip;
  assert.deepEqual([seenByF.liked, seenByF.like_count, seenByAnon.liked, seenByAnon.like_count], [true, 2, false, 2]);
  r = await f.del(`/api/trips/${t.id}/like`); assert.deepEqual([r.data.liked, r.data.like_count], [false, 1]);
  r = await f.del(`/api/trips/${t.id}/like`); assert.equal(r.data.like_count, 1, "double unlike is harmless");
  assert.equal((await db.one("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM trip_likes WHERE trip_id=$1", [t.id])).n, 1);
});

test("comments: validation, list, counts, delete permissions", async () => {
  const o = await signup("Comment Owner"), c1 = await signup("Commenter One"), c2 = await signup("Commenter Two");
  const t = await post(o);
  assert.equal((await new Client().post(`/api/trips/${t.id}/comments`, { body: "hi" })).status, 401);
  assert.equal((await c1.post(`/api/trips/${t.id}/comments`, { body: "   " })).status, 400);
  assert.equal((await c1.post("/api/trips/999999/comments", { body: "hi" })).status, 404);
  const a = await c1.post(`/api/trips/${t.id}/comments`, { body: "What time at the gate? <b>x</b>" });
  assert.equal(a.status, 201); assert.equal(a.data.comment_count, 1); assert.equal(a.data.comment.user.username, c1.user.username);
  const long = await c2.post(`/api/trips/${t.id}/comments`, { body: "z".repeat(1000) });
  assert.equal(long.data.comment.body.length, 300, "comment trimmed to 300 chars");

  const list = (await new Client().get(`/api/trips/${t.id}/comments`)).data;
  assert.equal(list.comments.length, 2); assert.equal(list.comment_count, 2);
  assert.equal(list.comments[0].body, "What time at the gate? <b>x</b>", "stored raw; the UI escapes it");
  assert.ok(list.comments.every((x) => x.mine === false && x.can_delete === false), "anonymous viewer can't delete");
  const mineView = (await c1.get(`/api/trips/${t.id}/comments`)).data.comments;
  assert.deepEqual(mineView.map((x) => [x.mine, x.can_delete]), [[true, true], [false, false]]);
  assert.equal((await o.get(`/api/trips/${t.id}/comments`)).data.comments.every((x) => x.can_delete), true, "post owner can moderate");
  assert.equal((await c1.get(`/api/trips/${t.id}`)).data.trip.comment_count, 2);

  assert.equal((await c2.del(`/api/comments/${a.data.comment.id}`)).status, 403, "can't delete someone else's comment");
  assert.equal((await c1.del(`/api/comments/${a.data.comment.id}`)).data.comment_count, 1);
  assert.equal((await o.del(`/api/comments/${long.data.comment.id}`)).data.comment_count, 0, "owner can remove comments on their post");
  assert.equal((await c1.del("/api/comments/999999")).status, 404);
});

test("edit own post: fields, photos add/remove (+cleanup), permissions, validation", async () => {
  const o = await signup("Edit Owner"), x = await signup("Edit Stranger");
  const t = await post(o, { images: [img(o.user.id, "e1"), img(o.user.id, "e2")] });
  assert.equal((await x.patch(`/api/trips/${t.id}`, { description: "hijack" })).status, 403);
  assert.equal((await new Client().patch(`/api/trips/${t.id}`, { description: "x" })).status, 401);

  const first = t.images[0];
  destroyed.length = 0;
  const r = await o.patch(`/api/trips/${t.id}`, {
    origin: "Salt Lake", destination: "Garia", depart_time: "09:30", depart_date: day(3), vehicle_model: "Activa 6G",
    description: "Updated caption", recurring: ["Mon", "Fri"], contribution_inr: null, remove_image_ids: [first.id], add_images: [img(o.user.id, "e3")],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const e = r.data.trip;
  assert.deepEqual([e.origin, e.destination, e.depart_time, e.vehicle_model, e.description, e.contribution_inr], ["Salt Lake", "Garia", "09:30", "Activa 6G", "Updated caption", null]);
  assert.deepEqual(e.recurring, ["Mon", "Fri"]);
  assert.deepEqual(e.images.map((i) => i.url), [img(o.user.id, "e2").url, img(o.user.id, "e3").url]);
  assert.deepEqual(destroyed, [`saathride/posts/${o.user.id}/e1`], "removed photo is deleted from storage");

  assert.equal((await o.patch(`/api/trips/${t.id}`, { depart_date: day(-2) })).status, 400, "can't move to the past");
  assert.equal((await o.patch(`/api/trips/${t.id}`, { origin: "garia" })).status, 400, "origin must differ from destination");
  assert.equal((await o.patch(`/api/trips/${t.id}`, { depart_time: "25:00" })).status, 400);
  assert.equal((await o.patch(`/api/trips/${t.id}`, { add_images: Array.from({ length: 5 }, (_, i) => img(o.user.id, "z" + i)) })).status, 400, "5 total max");
  assert.equal((await o.patch(`/api/trips/${t.id}`, { add_images: [img(x.user.id)] })).status, 400);
  assert.equal((await o.patch(`/api/trips/${t.id}`, { status: "cancelled" })).data.trip.status, "cancelled");
});

test("delete own post: cascades, cleans storage, blocked when travellers are confirmed", async () => {
  const o = await signup("Del Owner"), rider = await signup("Del Rider"), x = await signup("Del Stranger");
  const t = await post(o, { images: [img(o.user.id, "d1")] });
  await rider.post(`/api/trips/${t.id}/like`); await rider.post(`/api/trips/${t.id}/comments`, { body: "hi" });
  assert.equal((await x.del(`/api/trips/${t.id}`)).status, 403);

  const t2 = await post(o, { origin: "A2", destination: "B2" });
  const int = await rider.post(`/api/trips/${t2.id}/interest`, { message: "hi" });
  assert.equal(int.status, 201);
  const reqId = (await o.get(`/api/trips/${t2.id}`)).data.interests[0].id;
  await o.post(`/api/interests/${reqId}/accept`);
  assert.equal((await o.del(`/api/trips/${t2.id}`)).status, 400, "confirmed traveller -> must cancel instead");

  destroyed.length = 0;
  assert.equal((await o.del(`/api/trips/${t.id}`)).status, 200);
  assert.equal((await o.get(`/api/trips/${t.id}`)).status, 404);
  assert.deepEqual(destroyed, [`saathride/posts/${o.user.id}/d1`]);
  for (const tbl of ["trip_likes", "trip_comments", "trip_images"]) assert.equal((await db.one(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM ${tbl} WHERE trip_id=$1`, [t.id])).n, 0, tbl);
});

test("usernames: auto-generated, unique, validated, editable, lookup by @username", async () => {
  const a = await signup("Neha Rao"), b = await signup("Neha Rao2", { email: "neharao@other.com" });
  assert.match(a.user.username, /^[a-z0-9_.]{3,20}$/);
  assert.notEqual(a.user.username, b.user.username);
  const r = await a.patch("/api/me", { username: "Neha_R" });
  assert.equal(r.status, 200); assert.equal(r.data.user.username, "neha_r");
  assert.equal((await b.patch("/api/me", { username: "neha_r" })).status, 409, "taken");
  assert.equal((await b.patch("/api/me", { username: "NEHA_R" })).status, 409, "case-insensitive");
  for (const bad of ["ab", "has space", "a".repeat(21), "bad!name", "admin", ".dots", "dots.", "a..b"]) assert.equal((await b.patch("/api/me", { username: bad })).status, 400, bad);
  const p = await b.get("/api/users/@neha_r"); assert.equal(p.status, 200); assert.equal(p.data.user.id, a.user.id);
  assert.equal((await b.get("/api/users/neha_r")).data.user.id, a.user.id);
  assert.equal((await b.get("/api/users/nobody_here")).status, 404);
  assert.equal((await new Client().get("/api/users/neha_r")).status, 401, "profiles need login");
  assert.ok(!("email" in p.data.user) && !("phone" in p.data.user) && !("gender" in p.data.user));
});

test("privacy switches hide college / areas / interests from others, never from yourself", async () => {
  const o = await signup("Priv Owner", { college: "IIT Kharagpur" }), v = await signup("Priv Viewer");
  await o.patch("/api/me", { travel_areas: "Gol Bazar", interests: "chess" });
  const t = await post(o);
  let pub = (await v.get(`/api/users/${o.user.id}`)).data;
  assert.equal(pub.user.college, "IIT Kharagpur"); assert.deepEqual(pub.user.interests, ["chess"]);
  assert.equal((await v.get(`/api/trips/${t.id}`)).data.trip.owner.college, "IIT Kharagpur");

  const set = await o.patch("/api/me", { show_college: false, show_travel_areas: false, show_interests: false });
  assert.deepEqual([set.data.user.show_college, set.data.user.show_travel_areas, set.data.user.show_interests], [false, false, false]);
  pub = (await v.get(`/api/users/${o.user.id}`)).data;
  assert.equal(pub.user.college, ""); assert.deepEqual(pub.user.travel_areas, []); assert.deepEqual(pub.user.interests, []);
  assert.equal((await v.get(`/api/trips/${t.id}`)).data.trip.owner.college, "", "hidden on posts too");
  assert.equal(pub.posts[0].owner.college, "");
  const own = (await o.get(`/api/users/${o.user.id}`)).data.user;
  assert.equal(own.college, "IIT Kharagpur"); assert.deepEqual(own.interests, ["chess"]);
});

test("avatar: set from own folder only, replaced/removed images are cleaned up", async () => {
  const a = await signup("Ava Tar"), b = await signup("Ava Other");
  assert.equal((await a.patch("/api/me", { avatar: img(b.user.id, "me", "avatars") })).status, 400, "someone else's folder");
  assert.equal((await a.patch("/api/me", { avatar: img(a.user.id, "me", "posts") })).status, 400, "must be the avatars folder");
  const r = await a.patch("/api/me", { avatar: img(a.user.id, "me1", "avatars") });
  assert.equal(r.status, 200); assert.equal(r.data.user.avatar_url, img(a.user.id, "me1", "avatars").url);
  assert.equal((await b.get(`/api/users/${a.user.id}`)).data.user.avatar_url, img(a.user.id, "me1", "avatars").url);
  destroyed.length = 0;
  await a.patch("/api/me", { avatar: img(a.user.id, "me2", "avatars") });
  assert.deepEqual(destroyed, [`saathride/avatars/${a.user.id}/me1`]);
  destroyed.length = 0;
  const gone = await a.patch("/api/me", { avatar: null });
  assert.equal(gone.data.user.avatar_url, null); assert.deepEqual(destroyed, [`saathride/avatars/${a.user.id}/me2`]);
});

test("profile page data: posts (not cancelled), saved list is private to its owner", async () => {
  const o = await signup("Prof Owner"), v = await signup("Prof Viewer");
  const open = await post(o, { origin: "P1", destination: "Q1" });
  const closed = await post(o, { origin: "P2", destination: "Q2" });
  const cancelled = await post(o, { origin: "P3", destination: "Q3" });
  await o.patch(`/api/trips/${closed.id}`, { status: "closed" }); await o.patch(`/api/trips/${cancelled.id}`, { status: "cancelled" });
  const d = (await v.get(`/api/users/${o.user.id}`)).data;
  assert.deepEqual(d.posts.map((p) => p.id).sort(), [open.id, closed.id].sort());
  assert.equal(d.trips_posted, 2);
  await v.post(`/api/trips/${open.id}/save`);
  assert.deepEqual((await v.get("/api/me/trips")).data.saved.map((x) => x.id), [open.id]);
  assert.deepEqual((await o.get("/api/me/trips")).data.saved, [], "other people's saves are not visible to the poster");
  assert.ok(!JSON.stringify(d).includes("saved_by"));
});

test("share link /p/:id: link-preview tags are escaped, image resized, then redirects to the app", async () => {
  const o = await signup("Share Owner");
  const t = await post(o, { description: `"><script>alert(1)</script> hi`, images: [img(o.user.id, "s1")] });
  const r = await new Client().get(`/p/${t.id}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /og:image" content="https:\/\/res\.cloudinary\.com\/demo-cloud\/image\/upload\/c_fill,w_1200,h_630,q_auto,f_auto\//);
  assert.match(r.text, new RegExp(`url=/#/trip/${t.id}`));
  assert.ok(!r.text.includes("<script>alert(1)"), "description must be escaped");
  assert.match(r.text, /Gol Bazar → IIT Kharagpur/);
  const miss = await new Client().get("/p/999999"); assert.equal(miss.status, 302); assert.equal(miss.headers.get("location"), "/");
  const nonNumeric = await new Client().get("/p/abc"); assert.equal(nonNumeric.status, 200, "falls through to the SPA");
});

test("feed: newest-first sort, soonest-first default, like/comment counts", async () => {
  const o = await signup("Feed Owner"), v = await signup("Feed Viewer");
  const a = await post(o, { origin: "FA", destination: "FB", depart_date: day(5) });
  const b = await post(o, { origin: "FC", destination: "FD", depart_date: day(2) });
  const byNew = (await v.get("/api/trips?sort=new")).data.trips.map((t) => t.id);
  assert.ok(byNew.indexOf(b.id) < byNew.indexOf(a.id), "newest post first");
  const bySoon = (await v.get("/api/trips")).data.trips.map((t) => t.id);
  assert.ok(bySoon.indexOf(b.id) < bySoon.indexOf(a.id), "soonest departure first by default");
  await v.post(`/api/trips/${a.id}/like`); await v.post(`/api/trips/${a.id}/comments`, { body: "nice" });
  const f = (await v.get("/api/trips")).data.trips.find((t) => t.id === a.id);
  assert.deepEqual([f.like_count, f.comment_count, f.liked], [1, 1, true]);
});
