// Part 2: conversations, messages, inbox, notifications, blocking, member reports and voice-call signalling.
// Runs against the real Express app with the same SQL on in-memory SQLite (see test/sqlite-adapter.js).
// LiveKit is never contacted: we check the call state machine and the access tokens we mint.
process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const jwt = require("jsonwebtoken");
const db = require("../db");
const { createApp } = require("../server");

let server, base;
const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const fakeSdk = path.join(os.tmpdir(), `lk-sdk-${process.pid}.js`);
fs.writeFileSync(fakeSdk, "window.LivekitClient = {};");
const LK = { LIVEKIT_URL: "wss://saathride-test.livekit.cloud", LIVEKIT_API_KEY: "APItestkey", LIVEKIT_API_SECRET: "test-secret-that-is-long-enough-123456" };
const callsOn = () => Object.assign(process.env, LK);
const callsOff = () => { for (const k of Object.keys(LK)) delete process.env[k]; };

class Client {
  constructor() { this.cookie = ""; }
  async req(method, p, body) {
    const res = await fetch(base + p, {
      method, headers: { "Content-Type": "application/json", ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    });
    for (const c of res.headers.getSetCookie?.() || []) { const [pair] = c.split(";"); this.cookie = pair.endsWith("=") ? "" : pair; }
    const text = await res.text(); let data = {}; try { data = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, data, text, headers: res.headers };
  }
  get(p) { return this.req("GET", p); } post(p, b) { return this.req("POST", p, b); }
  patch(p, b) { return this.req("PATCH", p, b); } del(p) { return this.req("DELETE", p); }
}
let n = 0;
async function signup(name, extra = {}) {
  const c = new Client();
  const r = await c.post("/api/auth/signup", { name, email: `${name.toLowerCase().replace(/\W/g, "")}${++n}@example.com`, password: "password123", ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  c.user = r.data.user; c.email = `${name.toLowerCase().replace(/\W/g, "")}${n}@example.com`; return c;
}
const tripBody = (o = {}) => ({ origin: "Gol Bazar", destination: "IIT Kharagpur", depart_date: day(2), depart_time: "08:15", vehicle_type: "car", seats_total: 2, contribution_inr: 60, ...o });
async function newTrip(owner, o) { const r = await owner.post("/api/trips", tripBody(o)); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.trip; }
async function startConv(c, tripId, body) { const r = await c.post(`/api/trips/${tripId}/conversation`, body); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.conversation_id; }
const texts = (msgs) => msgs.filter((m) => m.kind === "text").map((m) => m.body);
const notifs = async (c) => (await c.get("/api/notifications?limit=50")).data.notifications;

test.before(async () => {
  callsOff();
  await db.migrate();
  server = createApp({ livekitSdk: fakeSdk, limits: { auth: 9999, write: 9999, trip: 9999, interest: 9999, message: 9999, report: 9999, conversation: 9999, call: 9999, api: 999999 } }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); try { fs.unlinkSync(fakeSdk); } catch { /* ignore */ } });

test("1. start a conversation from a trip: idempotent, rules, and only the two people can see it", async () => {
  const owner = await signup("Conv Owner"), rider = await signup("Conv Rider"), stranger = await signup("Conv Stranger");
  const t = await newTrip(owner);
  assert.equal((await new Client().post(`/api/trips/${t.id}/conversation`)).status, 401);
  const id = await startConv(rider, t.id);
  assert.equal(await startConv(rider, t.id), id, "starting again returns the same conversation");
  assert.equal((await rider.get(`/api/trips/${t.id}`)).data.conversation_id, id);

  const d = (await rider.get(`/api/conversations/${id}`)).data.conversation;
  assert.equal(d.role, "member"); assert.equal(d.other.id, owner.user.id); assert.equal(d.trip.id, t.id); assert.equal(d.can_send, true);
  assert.equal(d.interest, null, "talking first doesn't create a request");
  assert.ok(!("email" in d.other) && !("phone" in d.other), "no private contact details");
  assert.equal((await owner.get(`/api/conversations/${id}`)).data.conversation.role, "owner");

  for (const p of [`/api/conversations/${id}`, `/api/conversations/${id}/messages`]) assert.equal((await stranger.get(p)).status, 404, `${p} hidden from others`);
  assert.equal((await stranger.post(`/api/conversations/${id}/messages`, { body: "hi" })).status, 404);
  assert.equal((await stranger.post(`/api/conversations/${id}/read`)).status, 404);
  assert.equal((await new Client().get(`/api/conversations/${id}/messages`)).status, 401);
  assert.equal((await owner.post(`/api/trips/${t.id}/conversation`, { with: stranger.user.id })).status, 403, "owner can only message people who asked");
  assert.equal((await owner.post(`/api/trips/${t.id}/conversation`, { with: rider.user.id })).data.conversation_id, id, "owner reaches the same thread");
  assert.equal((await owner.post(`/api/trips/${t.id}/conversation`, {})).status, 404);

  const wo = await signup("WO Owner", { gender: "female" });
  const wt = await newTrip(wo, { women_only: true });
  assert.equal((await rider.post(`/api/trips/${wt.id}/conversation`)).status, 403, "women-only trips");
  assert.equal((await owner.patch(`/api/trips/${t.id}`, { status: "closed" })).status, 200);
  assert.equal((await stranger.post(`/api/trips/${t.id}/conversation`)).status, 400, "closed trips take no new conversations");
  assert.equal(await startConv(rider, t.id), id, "but existing ones still open");
});

test("2+3. send, receive, poll with ?after, paginate, and history survives a fresh login", async () => {
  const owner = await signup("Hist Owner"), rider = await signup("Hist Rider");
  const t = await newTrip(owner);
  const id = await startConv(rider, t.id);
  const s1 = await rider.post(`/api/conversations/${id}/messages`, { body: "Hi! Can you pick me up at the main gate?" });
  assert.equal(s1.status, 201); assert.equal(s1.data.message.mine, true); assert.equal(s1.data.message.kind, "text");
  assert.equal((await rider.post(`/api/conversations/${id}/messages`, { body: "   " })).status, 400);
  assert.equal((await rider.post(`/api/conversations/${id}/messages`, { body: "x".repeat(1001) })).status, 400);
  assert.equal((await rider.post(`/api/conversations/${id}/messages`, { body: 42 })).status, 400);
  const s2 = await owner.post(`/api/conversations/${id}/messages`, { body: "Sure — 8:10 at the gate. ₹60 each for fuel?" });
  assert.equal(s2.status, 201);

  const poll = (await rider.get(`/api/conversations/${id}/messages?after=${s1.data.message.id}`)).data;
  assert.deepEqual(texts(poll.messages), ["Sure — 8:10 at the gate. ₹60 each for fuel?"]);
  assert.equal(poll.messages[0].mine, false);
  assert.equal((await rider.get(`/api/conversations/${id}/messages?after=abc`)).status, 404);

  // a fresh session (like a page refresh / new device) reads the same history from the database
  const again = new Client();
  assert.equal((await again.post("/api/auth/login", { email: rider.email, password: "password123" })).status, 200);
  const hist = (await again.get(`/api/conversations/${id}/messages`)).data;
  assert.deepEqual(texts(hist.messages), ["Hi! Can you pick me up at the main gate?", "Sure — 8:10 at the gate. ₹60 each for fuel?"]);
  assert.ok(hist.messages.every((m) => /T.*Z$/.test(m.created_at)), "timestamps are ISO");
  const ownerHist = (await owner.get(`/api/conversations/${id}/messages`)).data.messages;
  assert.deepEqual(ownerHist.map((m) => m.mine), [false, true]);

  for (let i = 0; i < 55; i++) await rider.post(`/api/conversations/${id}/messages`, { body: `msg ${i}` });
  const page1 = (await rider.get(`/api/conversations/${id}/messages`)).data;
  assert.equal(page1.messages.length, 50); assert.equal(page1.has_older, true); assert.equal(page1.messages.at(-1).body, "msg 54");
  const page2 = (await rider.get(`/api/conversations/${id}/messages?before=${page1.messages[0].id}`)).data;
  assert.equal(page2.messages.length, 7); assert.equal(page2.has_older, false);
});

test("inbox: list, last message preview, unread counts, read receipts, search, unread filter", async () => {
  const owner = await signup("Inbox Owner Ana"), r1 = await signup("Inbox Bilal"), r2 = await signup("Inbox Chitra");
  const t1 = await newTrip(owner, { origin: "Salt Lake", destination: "Park Street" });
  const t2 = await newTrip(owner, { origin: "Howrah", destination: "Sealdah" });
  const c1 = await startConv(r1, t1.id), c2 = await startConv(r2, t2.id);
  await r1.post(`/api/conversations/${c1}/messages`, { body: "first" });
  await r2.post(`/api/conversations/${c2}/messages`, { body: "hello from chitra" });
  await r2.post(`/api/conversations/${c2}/messages`, { body: "are you still going?" });

  const list = (await owner.get("/api/conversations")).data.conversations;
  assert.deepEqual(list.map((c) => c.id), [c2, c1], "most recent first");
  assert.equal(list[0].unread_count, 2); assert.equal(list[0].last_message.body, "are you still going?"); assert.equal(list[0].last_message.mine, false);
  assert.equal(list[0].other.name, "Inbox Chitra"); assert.equal(list[0].trip.origin, "Howrah"); assert.equal(list[0].role, "owner");
  assert.equal((await owner.get("/api/sync")).data.messages_unread, 3);

  assert.deepEqual((await owner.get("/api/conversations?q=bilal")).data.conversations.map((c) => c.id), [c1]);
  assert.deepEqual((await owner.get("/api/conversations?q=sealdah")).data.conversations.map((c) => c.id), [c2]);
  assert.deepEqual((await owner.get("/api/conversations?q=%25")).data.conversations, [], "LIKE wildcards are escaped");
  assert.equal((await r1.get("/api/conversations")).data.conversations.length, 1, "riders only see their own");

  const r = await owner.post(`/api/conversations/${c2}/read`);
  assert.equal(r.data.messages_unread, 1);
  assert.deepEqual((await owner.get("/api/conversations?filter=unread")).data.conversations.map((c) => c.id), [c1]);
  const seen = (await r2.get(`/api/conversations/${c2}/messages`)).data.state.other_last_read_id;
  const last = (await r2.get(`/api/conversations/${c2}/messages`)).data.messages.at(-1).id;
  assert.equal(seen, last, "sender can see the message was read");
  assert.equal((await new Client().get("/api/conversations")).status, 401);
});

test("share a travel post inside a conversation", async () => {
  const owner = await signup("Share Owner"), rider = await signup("Share Rider");
  const t = await newTrip(owner), other = await newTrip(owner, { origin: "Return leg", destination: "Gol Bazar", depart_time: "18:00" });
  const id = await startConv(rider, t.id);
  const s = await owner.post(`/api/conversations/${id}/messages`, { kind: "trip", trip_id: other.id, body: "I'm also doing the return trip" });
  assert.equal(s.status, 201);
  assert.equal(s.data.message.shared_trip.id, other.id); assert.equal(s.data.message.shared_trip.origin, "Return leg");
  const got = (await rider.get(`/api/conversations/${id}/messages`)).data.messages.find((m) => m.kind === "trip");
  assert.equal(got.shared_trip.destination, "Gol Bazar"); assert.equal(got.body, "I'm also doing the return trip");
  assert.equal((await owner.post(`/api/conversations/${id}/messages`, { kind: "trip", trip_id: 999999 })).status, 404);
  assert.equal((await owner.post(`/api/conversations/${id}/messages`, { kind: "trip" })).status, 404);
});

test("interest workflow inside the conversation: request, note, accept, decline closes, withdraw", async () => {
  const owner = await signup("Flow Owner"), rider = await signup("Flow Rider"), rider2 = await signup("Flow Rider Two");
  const t = await newTrip(owner, { seats_total: 1 });
  const pre = await startConv(rider, t.id);
  await rider.post(`/api/conversations/${pre}/messages`, { body: "Is the 8:15 time fixed?" });
  const ir = await rider.post(`/api/trips/${t.id}/interest`, { message: "I'll wait at the gate" });
  assert.equal(ir.status, 201); assert.equal(ir.data.trip.seats_left, 1, "a request doesn't hold a seat");

  let msgs = (await owner.get(`/api/conversations/${pre}/messages`)).data.messages;
  assert.deepEqual(msgs.map((m) => m.kind), ["text", "event", "text"], "same conversation: talk first, then request");
  assert.match(msgs[1].body, /doesn't reserve a seat/);
  assert.equal(msgs[2].body, "I'll wait at the gate");
  const conv = (await owner.get(`/api/conversations/${pre}`)).data.conversation;
  assert.equal(conv.interest.status, "pending");
  const n1 = (await notifs(owner)).find((x) => x.type === "interest_request");
  assert.equal(n1.link, `#/inbox/${pre}`); assert.match(n1.body, /Flow Rider asked to join/); assert.equal(n1.actor.id, rider.user.id);

  // interest without talking first creates the conversation
  await rider2.post(`/api/trips/${t.id}/interest`);
  const view = (await owner.get(`/api/trips/${t.id}`)).data;
  const req2 = view.interests.find((i) => i.user.id === rider2.user.id);
  assert.ok(req2.conversation_id, "request opens a conversation");

  await owner.post(`/api/interests/${conv.interest.id}/accept`);
  msgs = (await rider.get(`/api/conversations/${pre}/messages`)).data.messages;
  assert.match(msgs.at(-1).body, /Accepted the request/);
  assert.equal((await notifs(rider)).find((x) => x.type === "interest_accepted").link, `#/inbox/${pre}`);

  await owner.post(`/api/interests/${req2.id}/decline`);
  const closed = (await rider2.get(`/api/conversations/${req2.conversation_id}`)).data.conversation;
  assert.equal(closed.can_send, false); assert.match(closed.closed_reason, /declined/);
  assert.equal((await rider2.post(`/api/conversations/${req2.conversation_id}/messages`, { body: "please?" })).status, 403);
  assert.ok((await notifs(rider2)).some((x) => x.type === "interest_declined"));

  await rider.del(`/api/trips/${t.id}/interest`);
  const w = (await notifs(owner)).find((x) => x.type === "interest_withdrawn");
  assert.match(w.title, /left your trip/);
  assert.match((await owner.get(`/api/conversations/${pre}/messages`)).data.messages.at(-1).body, /Left the trip/);
  assert.equal((await rider.post(`/api/interests/${conv.interest.id}/accept`)).status, 403, "only the owner manages requests");
});

test("notifications: messages collapse, mark read, read-all, ownership, trip changes and cancellation", async () => {
  const owner = await signup("Note Owner"), rider = await signup("Note Rider"), talker = await signup("Note Talker"), other = await signup("Note Other");
  const t = await newTrip(owner);
  const id = await startConv(rider, t.id);
  await rider.post(`/api/conversations/${id}/messages`, { body: "one" });
  await rider.post(`/api/conversations/${id}/messages`, { body: "two" });
  let list = await notifs(owner);
  assert.equal(list.filter((x) => x.type === "new_message").length, 1, "unread message notifications collapse per conversation");
  const nm = list.find((x) => x.type === "new_message");
  assert.equal(nm.link, `#/inbox/${id}`); assert.ok(!/one|two/.test(nm.body + nm.title), "notification doesn't copy message text");
  assert.equal((await owner.get("/api/notifications/unread")).data.unread, 1);

  assert.equal((await other.post(`/api/notifications/${nm.id}/read`)).status, 404, "can't touch someone else's notification");
  assert.ok(!(await notifs(other)).some((x) => x.id === nm.id));
  assert.equal((await owner.post(`/api/notifications/${nm.id}/read`)).data.unread, 0);
  assert.equal((await owner.post(`/api/notifications/${nm.id}/read`)).status, 200, "idempotent");
  assert.equal((await new Client().get("/api/notifications")).status, 401);

  // trip changes reach confirmed / pending people; cancellation also reaches people who only talked
  await rider.post(`/api/trips/${t.id}/interest`);
  await startConv(talker, t.id);
  assert.equal((await owner.patch(`/api/trips/${t.id}`, { depart_time: "09:00" })).status, 200);
  const ch = (await notifs(rider)).find((x) => x.type === "trip_changed");
  assert.match(ch.body, /08:15 → 09:00/); assert.equal(ch.link, `#/trip/${t.id}`);
  assert.ok(!(await notifs(talker)).some((x) => x.type === "trip_changed"), "people who only chatted don't get every edit");
  assert.match((await rider.get(`/api/conversations/${id}/messages`)).data.messages.at(-1).body, /Trip updated: departure 08:15 → 09:00/);
  await owner.patch(`/api/trips/${t.id}`, { description: "just a caption edit" });
  assert.equal((await notifs(rider)).filter((x) => x.type === "trip_changed").length, 1, "caption edits are not announced");

  await owner.patch(`/api/trips/${t.id}`, { status: "cancelled" });
  assert.ok((await notifs(rider)).some((x) => x.type === "trip_cancelled"));
  assert.ok((await notifs(talker)).some((x) => x.type === "trip_cancelled"));
  assert.ok(!(await notifs(other)).some((x) => x.type === "trip_cancelled"), "uninvolved members get nothing");
  assert.ok(!(await notifs(owner)).some((x) => x.type === "trip_cancelled"), "no notification for your own action");

  await owner.post("/api/notifications/read-all");
  assert.equal((await owner.get("/api/sync")).data.notifications_unread, 0);
});

test("4. blocking and safety: no messages, requests, calls or feed visibility; reports", async () => {
  callsOn();
  try {
    const owner = await signup("Safe Owner"), rider = await signup("Safe Rider");
    const t = await newTrip(owner);
    const id = await startConv(rider, t.id);
    await rider.post(`/api/conversations/${id}/messages`, { body: "hi" });
    await owner.post(`/api/conversations/${id}/messages`, { body: "hello" });

    assert.equal((await owner.post(`/api/block/${owner.user.id}`)).status, 400);
    assert.equal((await owner.post(`/api/block/${rider.user.id}`)).status, 200);
    assert.equal((await owner.post(`/api/block/${rider.user.id}`)).status, 200, "idempotent");
    assert.deepEqual((await owner.get("/api/blocks")).data.blocked.map((b) => b.id), [rider.user.id]);
    assert.equal((await owner.get(`/api/users/${rider.user.id}`)).data.user.blocked_by_me, true);

    const rv = (await rider.get(`/api/conversations/${id}`)).data.conversation;
    assert.equal(rv.can_send, false); assert.ok(!/block/i.test(rv.closed_reason), "the blocked person isn't told they were blocked");
    assert.equal(rv.call_eligible, false);
    assert.equal((await rider.post(`/api/conversations/${id}/messages`, { body: "?" })).status, 403);
    assert.equal((await owner.post(`/api/conversations/${id}/messages`, { body: "?" })).status, 403);
    assert.equal((await rider.post(`/api/conversations/${id}/calls`)).status, 403);
    assert.equal((await rider.post(`/api/trips/${t.id}/interest`)).status, 403);
    const t2 = await newTrip(owner, { origin: "Blocked feed", destination: "Nowhere" });
    assert.equal((await rider.post(`/api/trips/${t2.id}/conversation`)).status, 403);
    assert.equal((await rider.get("/api/trips?origin=Blocked feed")).data.trips.length, 0, "blocked owner's posts leave your feed");
    assert.equal((await new Client().get("/api/trips?origin=Blocked feed")).data.trips.length, 1);
    assert.ok(!(await notifs(owner)).some((x) => x.type === "interest_request"));

    assert.equal((await owner.del(`/api/block/${rider.user.id}`)).data.blocked, false);
    assert.equal((await rider.post(`/api/conversations/${id}/messages`, { body: "thanks" })).status, 201, "unblocking restores messaging");

    // member reports
    assert.equal((await rider.post(`/api/users/${owner.user.id}/report`, { reason: "nope" })).status, 400);
    assert.equal((await rider.post(`/api/users/${rider.user.id}/report`, { reason: "spam" })).status, 400);
    const stranger = await signup("Safe Stranger");
    assert.equal((await stranger.post(`/api/users/${owner.user.id}/report`, { reason: "spam", conversation_id: id })).status, 404, "can't attach someone else's conversation");
    const rep = await rider.post(`/api/users/${owner.user.id}/report`, { reason: "harassment", details: "rude", conversation_id: id, block: true });
    assert.equal(rep.status, 201); assert.equal(rep.data.blocked, true);
    assert.equal((await rider.post(`/api/users/${owner.user.id}/report`, { reason: "spam" })).status, 409);
    const stored = await db.one("SELECT * FROM user_reports WHERE reporter_id = $1", [rider.user.id]);
    assert.equal(stored.reason, "harassment"); assert.equal(stored.conversation_id, id);
    assert.ok(!Object.values(stored).some((v) => v === "hi" || v === "hello"), "no message text copied into reports");
  } finally { callsOff(); }
});

test("private messages never appear on public endpoints", async () => {
  const owner = await signup("Leak Owner"), rider = await signup("Leak Rider");
  const t = await newTrip(owner);
  const id = await startConv(rider, t.id);
  const secret = "my flat is B-204, call me on 98xxxxxx";
  await rider.post(`/api/conversations/${id}/messages`, { body: secret });
  const anon = new Client();
  for (const p of [`/api/trips/${t.id}`, "/api/trips", `/api/trips/${t.id}/comments`, `/p/${t.id}`]) {
    const r = await anon.get(p); assert.ok(!r.text.includes(secret), `${p} must not include messages`);
  }
  for (const p of [`/api/users/${rider.user.id}`, `/api/trips/${t.id}`, "/api/me/trips"]) {
    const r = await owner.get(p); assert.ok(!r.text.includes(secret), `${p} must not include messages`);
  }
});

test("6. voice calls: off without credentials; when configured, ring → accept → end with scoped tokens", async () => {
  const owner = await signup("Call Owner"), rider = await signup("Call Rider"), third = await signup("Call Third");
  const t = await newTrip(owner);
  const id = await startConv(rider, t.id);
  await rider.post(`/api/conversations/${id}/messages`, { body: "hi" });

  // not configured: messaging still works, calls clearly unavailable
  assert.equal((await rider.get("/api/config")).data.calls, false);
  assert.equal((await rider.get(`/api/conversations/${id}`)).data.conversation.calls_enabled, false);
  assert.equal((await rider.post(`/api/conversations/${id}/calls`)).status, 503);

  callsOn();
  try {
    assert.equal((await rider.get("/api/config")).data.calls, true);
    assert.match((await fetch(base + "/")).headers.get("content-security-policy"), /connect-src 'self' https:\/\/api\.cloudinary\.com wss:\/\/saathride-test\.livekit\.cloud/);
    assert.equal((await fetch(base + "/vendor/livekit-client.js")).status, 200);
    assert.equal((await rider.get(`/api/conversations/${id}`)).data.conversation.call_eligible, false, "needs a reply first");
    assert.equal((await rider.post(`/api/conversations/${id}/calls`)).status, 403);
    await owner.post(`/api/conversations/${id}/messages`, { body: "hello" });
    assert.equal((await rider.get(`/api/conversations/${id}`)).data.conversation.call_eligible, true);

    const c = await rider.post(`/api/conversations/${id}/calls`);
    assert.equal(c.status, 201, JSON.stringify(c.data));
    assert.equal(c.data.call.status, "ringing"); assert.equal(c.data.call.direction, "outgoing"); assert.equal(c.data.livekit.url, LK.LIVEKIT_URL);
    const tok = jwt.verify(c.data.livekit.token, LK.LIVEKIT_API_SECRET);
    assert.equal(tok.iss, LK.LIVEKIT_API_KEY); assert.equal(tok.sub, `u${rider.user.id}`); assert.equal(tok.name, "Call Rider");
    assert.equal(tok.video.roomJoin, true); assert.deepEqual(tok.video.canPublishSources, ["microphone"]);
    assert.match(tok.video.room, new RegExp(`^sr-${id}-[0-9a-f]{18}$`));
    assert.ok(!JSON.stringify(tok).includes("@example.com"), "no email/phone inside the token");
    const callId = c.data.call.id;

    assert.equal((await rider.post(`/api/conversations/${id}/calls`)).status, 409, "one call at a time");
    assert.equal((await third.get(`/api/calls/${callId}`)).status, 404);
    assert.equal((await third.post(`/api/calls/${callId}/accept`)).status, 404);
    assert.equal((await rider.post(`/api/calls/${callId}/accept`)).status, 403, "caller can't answer their own call");

    const sync = (await owner.get("/api/sync")).data;
    assert.equal(sync.incoming_call.id, callId); assert.equal(sync.incoming_call.other.name, "Call Rider"); assert.equal(sync.incoming_call.direction, "incoming");
    assert.equal((await rider.get("/api/sync")).data.incoming_call, null);

    const acc = await owner.post(`/api/calls/${callId}/accept`);
    assert.equal(acc.status, 200); assert.equal(acc.data.call.status, "active");
    const tok2 = jwt.verify(acc.data.livekit.token, LK.LIVEKIT_API_SECRET);
    assert.equal(tok2.video.room, tok.video.room, "same room"); assert.equal(tok2.sub, `u${owner.user.id}`);
    assert.equal((await owner.post(`/api/calls/${callId}/accept`)).status, 409);
    assert.equal((await rider.get(`/api/calls/${callId}`)).data.call.status, "active");
    assert.equal((await owner.post(`/api/calls/${callId}/end`)).data.call.status, "ended");
    assert.equal((await rider.get(`/api/calls/${callId}`)).data.call.status, "ended");

    // declined
    const c2 = (await owner.post(`/api/conversations/${id}/calls`)).data.call;
    assert.equal((await owner.post(`/api/calls/${c2.id}/decline`)).status, 403);
    assert.equal((await rider.post(`/api/calls/${c2.id}/decline`)).data.call.status, "declined");

    // caller hangs up while ringing → callee gets a missed-call notification
    const c3 = (await owner.post(`/api/conversations/${id}/calls`)).data.call;
    assert.equal((await owner.post(`/api/calls/${c3.id}/end`)).data.call.status, "cancelled");
    assert.ok((await notifs(rider)).some((x) => x.type === "call_missed" && x.link === `#/inbox/${id}`));

    // nobody answers → missed after the ring window
    const c4 = (await rider.post(`/api/conversations/${id}/calls`)).data.call;
    await db.query("UPDATE calls SET created_at = $1 WHERE id = $2", [new Date(Date.now() - 60_000).toISOString(), c4.id]);
    assert.equal((await rider.get(`/api/calls/${c4.id}`)).data.call.status, "missed");
    assert.equal((await owner.post(`/api/calls/${c4.id}/accept`)).status, 409);

    // microphone blocked / connection failure is reported so the other side stops waiting
    const c5 = (await rider.post(`/api/conversations/${id}/calls`)).data.call;
    const f = await owner.post(`/api/calls/${c5.id}/fail`, { reason: "permission_denied" });
    assert.equal(f.data.call.status, "failed"); assert.equal(f.data.call.end_reason, "permission_denied");

    // blocking ends a ringing call and stops new ones
    const c6 = (await rider.post(`/api/conversations/${id}/calls`)).data.call;
    await owner.post(`/api/block/${rider.user.id}`);
    assert.equal((await rider.get(`/api/calls/${c6.id}`)).data.call.status, "cancelled");
    assert.equal((await rider.post(`/api/conversations/${id}/calls`)).status, 403);
  } finally { callsOff(); }
});

test("calls are unavailable when the LiveKit SDK isn't installed", async () => {
  callsOn();
  const s2 = createApp({ livekitSdk: null }).listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${s2.address().port}/api/config`);
    const cfg = await r.json();
    assert.equal(cfg.calls, false); assert.equal(cfg.calls_status, "sdk_missing");
    assert.equal((await fetch(`http://127.0.0.1:${s2.address().port}/vendor/livekit-client.js`)).status, 404);
  } finally { s2.close(); callsOff(); }
});
