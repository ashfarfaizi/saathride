// Safety & social features: email notifications, Saath Circle, safety sessions (check-ins, missed check-in
// escalation, SOS, share links), QR boarding, safety cases + suspension, women-only matching, Journey Memories,
// and the Saath AI agent's permission-gated join requests. Email (Brevo) and Claude are local fakes.
process.env.NODE_ENV = "test";
process.env.BREVO_API_KEY = "test-brevo-key";
process.env.EMAIL_FROM = "SaathRide <alerts@example.com>";
process.env.APP_URL = "https://saathride.test";
process.env.ADMIN_EMAILS = "admin@example.com";
process.env.CRON_SECRET = "cron-test-secret";
const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const { createApp } = require("../server");

let server, base;
const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const mails = [];
async function fakeMail(url, opts) {
  const body = JSON.parse(opts.body);
  mails.push({ to: body.to[0].email, subject: body.subject, text: body.textContent, html: body.htmlContent });
  return { ok: true, json: async () => ({ messageId: "x" }) };
}
const mailTo = (addr) => mails.filter((m) => m.to === addr);
let aiScript = [];
async function fakeClaude() { const next = aiScript.shift(); return next ? { ok: true, json: async () => next } : { ok: false, status: 500, text: async () => "" }; }

class Client {
  constructor() { this.cookie = ""; }
  async req(method, p, body, headers = {}) {
    const res = await fetch(base + p, { method, redirect: "manual", headers: { "Content-Type": "application/json", ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers }, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
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
  c.email = extra.email || `${name.toLowerCase().replace(/\W/g, "")}${++n}@example.com`;
  const r = await c.post("/api/auth/signup", { name, password: "password123", ...extra, email: c.email });
  assert.equal(r.status, 201, JSON.stringify(r.data)); c.user = r.data.user; return c;
}
const trip = async (c, o = {}) => { const r = await c.post("/api/trips", { origin: "Garia", destination: "Salt Lake Sector V", depart_date: day(1), depart_time: "08:30", vehicle_type: "car", seats_total: 3, contribution_inr: 120, ...o }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.trip; };
async function join(owner, rider, tripId) {
  assert.equal((await rider.post(`/api/trips/${tripId}/interest`, { message: "hi" })).status, 201);
  const req = (await owner.get(`/api/trips/${tripId}`)).data.interests.find((i) => i.user.id === rider.user.id);
  assert.equal((await owner.post(`/api/interests/${req.id}/accept`)).status, 200);
}
// The contact clicks their email link and presses Accept (plain HTML form, no account).
async function contactResponds(contactEmail, action) {
  const invite = mailTo(contactEmail).find((m) => /Saath Circle|trusted contact/.test(m.subject));
  const link = invite.text.match(/https:\/\/saathride\.test\/c\/([\w-]+)/)[1];
  const page = await fetch(`${base}/c/${link}`); assert.equal(page.status, 200);
  const r = await fetch(`${base}/c/${link}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `action=${action}` });
  assert.equal(r.status, 200); return link;
}
const past = (ms) => new Date(Date.now() - ms).toISOString();
const sweep = () => fetch(`${base}/api/cron/safety-sweep`, { method: "POST", headers: { Authorization: "Bearer cron-test-secret" } }).then((r) => r.json());

test.before(async () => {
  await db.migrate();
  server = createApp({ mailFetch: fakeMail, aiFetch: fakeClaude, mapSdk: null,
    limits: { auth: 9999, write: 9999, trip: 9999, interest: 9999, api: 999999, ai: 9999, aiDay: 9999, match: 9999 } }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test("email: confirmation link, then notification copies go only to confirmed addresses and respect the switch", async () => {
  const owner = await signup("Mail Owner");
  const confirm = mailTo(owner.email).find((m) => /Confirm your email/.test(m.subject));
  assert.ok(confirm, "signup sends a confirmation email");
  const rider = await signup("Mail Rider");
  const t = await trip(owner);
  await rider.post(`/api/trips/${t.id}/interest`, { message: "hello" });
  assert.equal(mailTo(owner.email).filter((m) => /request/i.test(m.subject)).length, 0, "unconfirmed: in-app only");
  const tok = confirm.text.match(/verify-email\?token=([^\s]+)/)[1];
  const v = await fetch(`${base}/api/auth/verify-email?token=${tok}`, { redirect: "manual" });
  assert.equal(v.status, 302); assert.match(v.headers.get("location"), /email=confirmed/);
  assert.equal((await owner.get("/api/me")).data.user.email_verified, true);
  await rider.del(`/api/trips/${t.id}/interest`); await rider.post(`/api/trips/${t.id}/interest`, { message: "again" });
  const reqMail = mailTo(owner.email).find((m) => /request to join/i.test(m.subject));
  assert.ok(reqMail, "confirmed: email copy sent"); assert.ok(!reqMail.text.includes("again"), "emails never quote message text");
  await owner.put("/api/me/notification-prefs", { prefs: { email: false } });
  const before = mailTo(owner.email).length;
  const t2 = await trip(owner, { depart_time: "10:00" });
  await rider.post(`/api/trips/${t2.id}/interest`, {});
  assert.equal(mailTo(owner.email).length, before, "email switch off → no more emails");
});

test("Saath Circle: invite, consent, limits, revoke", async () => {
  const u = await signup("Circle Owner");
  assert.equal((await u.post("/api/circle", { name: "Me", email: u.email })).status, 400, "not yourself");
  assert.equal((await u.post("/api/circle", { name: "Ma", email: "not-an-email" })).status, 400);
  const add = await u.post("/api/circle", { name: "Ma", email: "ma@example.com", relation: "Mother" });
  assert.equal(add.status, 201); assert.equal(add.data.contact.status, "pending"); assert.equal(add.data.invited, true);
  const invite = mailTo("ma@example.com")[0];
  assert.match(invite.subject, /added you as a trusted contact/); assert.match(invite.text, /won't get any further emails/);
  assert.equal((await u.post("/api/circle", { name: "Ma again", email: "MA@example.com" })).status, 409);
  await contactResponds("ma@example.com", "accept");
  const list = (await u.get("/api/circle")).data.contacts;
  assert.equal(list[0].status, "active");
  assert.ok((await u.get("/api/notifications")).data.notifications.some((x) => /joined your Saath Circle/.test(x.title)));
  for (let i = 0; i < 4; i++) assert.equal((await u.post("/api/circle", { name: `C${i}`, email: `c${i}@example.com` })).status, 201);
  assert.equal((await u.post("/api/circle", { name: "Six", email: "six@example.com" })).status, 400, "max 5");
  await contactResponds("c0@example.com", "decline");
  assert.equal((await u.post(`/api/circle/${(await u.get("/api/circle")).data.contacts.find((c) => c.email === "c0@example.com").id}/resend`)).status, 400, "respect a decline");
  const other = await signup("Nosy");
  assert.equal((await other.get("/api/circle")).data.contacts.length, 0, "contacts are private");
  await u.del(`/api/circle/${list[0].id}`);
  assert.ok(!(await u.get("/api/circle")).data.contacts.some((c) => c.email === "ma@example.com"));
});

test("safety session: check-ins, missed check-in asks the traveller first, then the circle; arrival ends and wipes location", async () => {
  const u = await signup("Safe Traveller");
  const c = (await u.post("/api/circle", { name: "Roommate", email: "roomie@example.com" })).data.contact;
  const pend = (await u.post("/api/circle", { name: "Pending Pal", email: "pending@example.com" })).data.contact;
  // contacts escalation needs at least one accepted contact
  assert.equal((await u.post("/api/safety/sessions", { label: "Home", eta_minutes: 40, contact_ids: [pend.id] })).status, 400);
  await contactResponds("roomie@example.com", "accept");
  const start = await u.post("/api/safety/sessions", { label: "Office → Home", eta_minutes: 40, contact_ids: [c.id, pend.id] });
  assert.equal(start.status, 201, JSON.stringify(start.data));
  const s = start.data.session;
  assert.equal(s.due_kind, "departure"); assert.equal(start.data.contacts_emailed, 1, "only accepted contacts get emails");
  assert.ok(!mailTo("pending@example.com").some((m) => /safety session/.test(m.subject)));
  const shareTok = s.share_url.split("/s/")[1];
  assert.equal((await u.post("/api/safety/sessions", { label: "Again", eta_minutes: 30, contact_ids: [c.id] })).status, 409, "one at a time");
  // live location reaches the share link while active
  await u.post(`/api/safety/sessions/${s.id}/location`, { lat: 22.57612345, lng: 88.43312345 });
  const shared = await new Client().get(`/api/safety/share/${shareTok}`);
  assert.equal(shared.status, 200); assert.equal(shared.data.name, "Safe"); assert.deepEqual([shared.data.location.lat, shared.data.location.lng], [22.57612, 88.43312]);
  assert.equal(shared.data.share_url, undefined, "contacts don't get owner-only fields");
  // departure check-in → midway due next (40 min trip)
  const dep = (await u.post(`/api/safety/sessions/${s.id}/checkin`, { stage: "departure" })).data.session;
  assert.equal(dep.due_kind, "midway");
  assert.ok(mailTo("roomie@example.com").some((m) => /has set off/.test(m.subject)));
  // the midway check-in is missed: watcher asks the traveller first
  await db.query("UPDATE safety_sessions SET due_at = $2 WHERE id = $1", [s.id, past(6 * 60_000)]);
  assert.equal((await sweep()).prompted, 1);
  assert.equal((await u.get("/api/safety/active")).data.session.missed_stage, 1);
  assert.ok((await u.get("/api/notifications")).data.notifications.some((x) => /Are you OK/.test(x.title)));
  assert.ok(!mailTo("roomie@example.com").some((m) => /missed/.test(m.subject)), "circle not told yet");
  assert.equal((await sweep()).escalated, 0, "they get 10 minutes to answer");
  // no answer → the circle is told, carefully worded
  await db.query("UPDATE safety_sessions SET missed_at = $2 WHERE id = $1", [s.id, past(11 * 60_000)]);
  assert.equal((await sweep()).escalated, 1);
  const alert = mailTo("roomie@example.com").find((m) => /missed a safety check-in/.test(m.subject));
  assert.ok(alert); assert.match(alert.text, /doesn't necessarily mean something is wrong/); assert.match(alert.text, /call 112/);
  assert.match(alert.text, /Stop these emails: https:\/\/saathride\.test\/c\//, "contacts can always opt out");
  // the traveller answers → circle told they're OK
  const ok = (await u.post(`/api/safety/sessions/${s.id}/checkin`, { stage: "ok" })).data.session;
  assert.equal(ok.missed_stage, 0);
  assert.ok(mailTo("roomie@example.com").some((m) => /checked in — they're OK/.test(m.subject)));
  // extend and arrive
  assert.equal((await u.post(`/api/safety/sessions/${s.id}/extend`, { minutes: 7 })).status, 400);
  assert.equal((await u.post(`/api/safety/sessions/${s.id}/extend`, { minutes: 15 })).status, 200);
  const done = (await u.post(`/api/safety/sessions/${s.id}/checkin`, { stage: "arrival" })).data.session;
  assert.equal(done.status, "arrived"); assert.equal(done.location, null);
  assert.ok(mailTo("roomie@example.com").some((m) => /arrived safely/.test(m.subject)));
  const row = await db.one("SELECT last_lat, last_lng FROM safety_sessions WHERE id = $1", [s.id]);
  assert.equal(row.last_lat, null, "location wiped at the end");
  const after = await new Client().get(`/api/safety/share/${shareTok}`);
  assert.equal(after.status, 200); assert.equal(after.data.location, null); assert.equal(after.data.status, "arrived");
  await db.query("UPDATE safety_sessions SET ended_at = $2 WHERE id = $1", [s.id, past(3 * 3600_000)]);
  assert.equal((await new Client().get(`/api/safety/share/${shareTok}`)).status, 404, "links expire");
  // someone else can't touch the session
  const intruder = await signup("Intruder");
  assert.equal((await intruder.post(`/api/safety/sessions/${s.id}/checkin`, { stage: "ok" })).status, 404);
  // cron hook is secret
  assert.equal((await fetch(`${base}/api/cron/safety-sweep`, { method: "POST" })).status, 404);
});

test("“only remind me” plan never emails the circle; SOS always alerts accepted contacts", async () => {
  const u = await signup("Self Planner");
  const c = (await u.post("/api/circle", { name: "Brother", email: "bro@example.com" })).data.contact;
  await contactResponds("bro@example.com", "accept");
  const s = (await u.post("/api/safety/sessions", { label: "Late class", eta_minutes: 15, contact_ids: [], escalation: "self" })).data.session;
  await db.query("UPDATE safety_sessions SET due_at = $2 WHERE id = $1", [s.id, past(6 * 60_000)]); await sweep();
  await db.query("UPDATE safety_sessions SET missed_at = $2 WHERE id = $1", [s.id, past(11 * 60_000)]); await sweep();
  assert.ok(!mailTo("bro@example.com").some((m) => /missed/.test(m.subject)));
  assert.ok((await u.get("/api/notifications")).data.notifications.some((x) => /Still there/.test(x.title)));
  await u.post(`/api/safety/sessions/${s.id}/end`, {});
  // SOS with no session running: alert goes to every accepted contact with a live link
  const sos = await u.post("/api/safety/sos", { lat: 22.5, lng: 88.3 });
  assert.equal(sos.status, 200); assert.equal(sos.data.contacts_alerted, 1); assert.equal(sos.data.emergency_number, "112");
  const m = mailTo("bro@example.com").find((x) => /^SOS from Self/.test(x.subject));
  assert.ok(m); assert.match(m.text, /call 112/); assert.match(m.text, /https:\/\/saathride\.test\/#\/s\//);
  assert.ok(c.id);
});

test("QR boarding: only confirmed passengers, wrong code warns, right code updates the safety session", async () => {
  const owner = await signup("Board Owner"), rider = await signup("Board Rider"), stranger = await signup("Board Stranger");
  const t = await trip(owner, { vehicle_model: "Grey Swift" });
  assert.equal((await rider.get(`/api/trips/${t.id}/boarding`)).status, 404, "only the owner sees the code");
  const b = (await owner.get(`/api/trips/${t.id}/boarding`)).data;
  assert.match(b.code, /^[A-HJ-NP-Z2-9]{6}$/); assert.equal(b.url, `https://saathride.test/#/board/${t.id}/${b.code}`);
  assert.equal((await owner.get(`/api/trips/${t.id}/boarding`)).data.code, b.code, "stable");
  assert.equal((await stranger.post(`/api/trips/${t.id}/board`, { code: b.code })).status, 403);
  await join(owner, rider, t.id);
  const c = (await rider.post("/api/circle", { name: "Dad", email: "dad@example.com" })).data.contact;
  await contactResponds("dad@example.com", "accept");
  const s = (await rider.post("/api/safety/sessions", { trip_id: t.id, eta_minutes: 50, contact_ids: [c.id] })).data.session;
  assert.equal(s.label, "Garia → Salt Lake Sector V"); assert.equal(s.trip.with, "Board Owner");
  const wrong = await rider.post(`/api/trips/${t.id}/board`, { code: "AAAAAA" });
  assert.equal(wrong.status, 400); assert.match(wrong.data.error, /Don't board/);
  const ok = await rider.post(`/api/trips/${t.id}/board`, { code: b.code.toLowerCase() });
  assert.equal(ok.status, 200); assert.equal(ok.data.session_updated, true);
  assert.ok((await rider.get("/api/safety/active")).data.session.boarded_at);
  assert.ok(mailTo("dad@example.com").some((m) => /boarded the expected vehicle/.test(m.subject) && /Grey Swift/.test(m.text)));
  assert.equal((await owner.get(`/api/trips/${t.id}/boarding`)).data.boarded[0].name, "Board Rider");
  assert.ok((await owner.get("/api/notifications")).data.notifications.some((x) => /confirmed boarding/.test(x.title)));
  assert.equal((await stranger.post("/api/safety/sessions", { trip_id: t.id, eta_minutes: 30, escalation: "self" })).status, 400, "sessions only for your own journeys");
});

test("safety cases: severity, team alert, reporter updates, outcome required, suspension", async () => {
  const admin = await signup("Safety Admin", { email: "admin@example.com" });
  const victim = await signup("Case Reporter"), bad = await signup("Case Subject");
  const t = await trip(bad);
  await victim.post(`/api/trips/${t.id}/interest`, { message: "can I join?" });
  const conv = (await victim.get("/api/conversations")).data.conversations[0];
  assert.equal((await victim.post("/api/safety/cases", { category: "made_up", description: "x".repeat(20) })).status, 400);
  assert.equal((await victim.post("/api/safety/cases", { category: "threat", description: "short" })).status, 400);
  const r = await victim.post("/api/safety/cases", { category: "threat", conversation_id: conv.id, trip_id: t.id, description: "He said he'd come to my hostel if I didn't pay.", evidence: [{ kind: "note", value: "Happened after 9pm" }, { kind: "link", value: "javascript:alert(1)" }], block: true });
  assert.equal(r.status, 201); assert.equal(r.data.case.severity, "critical"); assert.equal(r.data.case.target, "within 1 hour"); assert.equal(r.data.blocked, true);
  const teamMail = mailTo("admin@example.com").find((m) => /\[CRITICAL\] Safety case/.test(m.subject));
  assert.ok(teamMail); assert.ok(!teamMail.text.includes("hostel"), "case details stay in the app");
  const low = await victim.post("/api/safety/cases", { category: "other", subject_id: bad.user.id, description: "Profile photo looks fake to me." });
  assert.equal(low.data.case.severity, "low");
  // team only
  assert.equal((await victim.get("/api/admin/cases")).status, 404);
  const list = (await admin.get("/api/admin/cases")).data.cases;
  assert.deepEqual(list.map((c) => c.severity), ["critical", "low"], "most severe first");
  const detail = (await admin.get(`/api/admin/cases/${r.data.case.id}`)).data.case;
  assert.equal(detail.subject.id, bad.user.id); assert.deepEqual(detail.evidence, [{ kind: "note", value: "Happened after 9pm" }], "unsafe links dropped");
  assert.ok(detail.conversation.some((m) => m.body === "can I join?"), "attached conversation shared with the team");
  assert.equal(detail.subject.prior_cases.length, 1);
  // workflow
  assert.equal((await admin.patch(`/api/admin/cases/${r.data.case.id}`, { status: "triaged", assign_to_me: true, note: "Calling reporter" })).status, 200);
  assert.equal((await admin.patch(`/api/admin/cases/${r.data.case.id}`, { status: "action_taken" })).status, 400, "outcome required");
  await admin.patch(`/api/admin/cases/${r.data.case.id}`, { message_to_reporter: "We've received this and are reviewing it now." });
  const sus = await admin.patch(`/api/admin/cases/${r.data.case.id}`, { status: "action_taken", outcome: "Account suspended after review.", suspend_subject: true });
  assert.equal(sus.status, 200);
  const mine = (await victim.get("/api/safety/cases/mine")).data.cases.find((c) => c.id === r.data.case.id);
  assert.equal(mine.status_label, "Action taken"); assert.equal(mine.outcome, "Account suspended after review.");
  assert.ok(mine.updates.some((u) => /reviewing it now/.test(u.body))); assert.ok(!mine.updates.some((u) => /Calling reporter/.test(u.body)), "internal notes stay internal");
  // suspension: can't act, can't log in, open journeys cancelled with notice
  assert.equal((await bad.get("/api/me/trips")).status, 403);
  assert.equal((await new Client().post("/api/auth/login", { email: bad.email, password: "password123" })).status, 403);
  assert.equal((await db.one("SELECT status FROM trips WHERE id = $1", [t.id])).status, "cancelled");
  assert.ok((await victim.get("/api/notifications")).data.notifications.some((x) => /cancelled/.test(x.title)));
  await admin.patch(`/api/admin/cases/${r.data.case.id}`, { suspend_subject: false });
  assert.equal((await new Client().post("/api/auth/login", { email: bad.email, password: "password123" })).status, 200, "suspension can be lifted");
});

test("women's section: women-only matching", async () => {
  const w1 = await signup("Woman Driver", { gender: "female" }), w2 = await signup("Woman Rider", { gender: "female" }), m = await signup("Man Rider", { gender: "male" });
  await trip(w1, { women_only: true, origin: "Jadavpur", destination: "Park Street" });
  await trip(w1, { origin: "Jadavpur", destination: "Park Street", depart_time: "09:00" });
  const body = { to: { label: "Park Street" }, date: day(1), women_only: true };
  const wr = (await w2.post("/api/match", body)).data.results;
  assert.equal(wr.length, 1); assert.equal(wr[0].trip.women_only, true);
  assert.equal((await m.post("/api/match", body)).data.results.length, 0, "men never see women-only journeys");
  assert.equal((await w2.post("/api/match", { ...body, women_only: false })).data.results.length, 2);
});

test("Journey Memories: after the trip, participants only; private by default; each member controls their profile", async () => {
  const owner = await signup("Mem Owner", { college: "Jadavpur University" }), rider = await signup("Mem Rider", { college: "Presidency University" }), outsider = await signup("Mem Outsider");
  const future = await trip(owner, { depart_date: day(2) });
  await join(owner, rider, future.id);
  assert.equal((await rider.post(`/api/trips/${future.id}/memory`, { title: "x" })).status, 400, "only after the journey");
  const t = await trip(owner, { depart_date: day(0), depart_time: "00:05", origin: "Howrah", destination: "Esplanade" });
  await join(owner, rider, t.id);
  assert.equal((await outsider.post(`/api/trips/${t.id}/memory`, {})).status, 404);
  assert.equal((await rider.get(`/api/trips/${t.id}/memory`)).data.can_create, true);
  const mem = (await rider.post(`/api/trips/${t.id}/memory`, { title: "Rainy ride", highlight: "Shared an umbrella at Howrah 🌧️" })).data.memory;
  assert.equal(mem.visibility, "participants"); assert.equal(mem.members.length, 2); assert.equal(mem.highlights.length, 1);
  assert.equal((await rider.post(`/api/trips/${t.id}/memory`, {})).status, 409, "one shared memory per journey");
  assert.ok((await owner.get("/api/notifications")).data.notifications.some((x) => /made a memory/.test(x.title)));
  assert.equal((await outsider.get(`/api/memories/${mem.id}`)).status, 404, "private to participants");
  assert.equal((await new Client().get(`/api/memories/${mem.id}`)).status, 404);
  assert.equal((await owner.put(`/api/memories/${mem.id}/profile`, { show: true })).status, 400, "private memories can't go on profiles");
  assert.equal((await owner.patch(`/api/memories/${mem.id}`, { visibility: "public" })).status, 403, "only the creator changes visibility");
  await rider.patch(`/api/memories/${mem.id}`, { visibility: "public" });
  assert.equal((await outsider.get(`/api/memories/${mem.id}`)).status, 200, "public now");
  assert.equal((await outsider.get(`/api/users/${owner.user.id}/journeys`)).data.memories.length, 0, "not on the owner's profile until they choose");
  await owner.put(`/api/memories/${mem.id}/profile`, { show: true });
  await owner.post(`/api/memories/${mem.id}/highlights`, { body: "Best chai stop ever" });
  const j = (await outsider.get(`/api/users/${owner.user.id}/journeys`)).data;
  assert.equal(j.memories.length, 1); assert.equal(j.memories[0].title, "Rainy ride");
  assert.deepEqual(j.communities, ["Presidency University"], "communities travelled with");
  assert.equal((await outsider.post(`/api/memories/${mem.id}/highlights`, { body: "hi" })).status, 404, "only members add highlights");
  await rider.patch(`/api/memories/${mem.id}`, { visibility: "participants" });
  assert.equal((await outsider.get(`/api/users/${owner.user.id}/journeys`)).data.memories.length, 0, "back to private removes it from profiles");
  assert.equal((await owner.get(`/api/users/${owner.user.id}/journeys`)).data.memories.length, 1, "you always see your own");
});

test("Saath AI agent: understands intent, ranks a preferred vehicle first, drafts but never sends requests", async () => {
  const d1 = await signup("Car Driver"), d2 = await signup("Bike Rider Owner"), me = await signup("Agent User");
  const car = await trip(d1, { origin: "Gol Bazar", destination: "IIT Kharagpur", depart_time: "08:10", vehicle_type: "car" });
  const bike = await trip(d2, { origin: "Gol Bazar", destination: "IIT Kharagpur", depart_time: "08:20", vehicle_type: "bike", seats_total: 1 });
  await trip(d2, { origin: "Gol Bazar", destination: "IIT Kharagpur", depart_time: "11:00", vehicle_type: "bike", seats_total: 1 });
  const r = (await me.post("/api/ai/chat", { message: "Find someone going to IIT Kharagpur tomorrow morning. I'd prefer a motorcycle ride and can leave between 8 and 8:30." })).data;
  assert.equal(r.mode, "basic");
  assert.deepEqual(r.cards.map((c) => c.trip.id), [bike.id, car.id], "motorcycle first, car still shown, 11:00 outside the window");
  assert.ok(r.cards[0].reasons.some((x) => /Motorcycle, as you prefer/.test(x.text)));
  assert.ok(r.cards[0].reasons.some((x) => /inside your 8:00 AM–8:30 AM window/.test(x.text)));
  assert.equal(r.actions.length, 1); assert.equal(r.actions[0].type, "join_request"); assert.equal(r.actions[0].trip_id, bike.id);
  assert.match(r.reply, /Nothing is sent until you tap/);
  assert.equal((await db.one("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM interests WHERE user_id = $1", [me.user.id])).n, 0, "no request sent by the agent");
  // the member taps Send → the normal endpoint sends it
  assert.equal((await me.post(`/api/trips/${bike.id}/interest`, { message: r.actions[0].note })).status, 201);
  // AI mode: the model can only propose; it can't send
  process.env.ANTHROPIC_API_KEY = "test-key";
  try {
    aiScript = [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "propose_join_request", input: { trip_id: car.id, note: "Hi! Heading to campus too — can I join?" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "I've prepared a request to the car driver — tap Send request to send it." }] },
    ];
    const a = (await me.post("/api/ai/chat", { message: "ask the car driver if I can join" })).data;
    assert.equal(a.mode, "ai"); assert.equal(a.actions[0].trip_id, car.id); assert.equal(a.actions[0].note, "Hi! Heading to campus too — can I join?");
    assert.equal((await db.one("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM interests WHERE user_id = $1 AND trip_id = $2", [me.user.id, car.id])).n, 0);
    aiScript = [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t2", name: "propose_join_request", input: { trip_id: bike.id } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] },
    ];
    assert.equal((await me.post("/api/ai/chat", { message: "ask the bike owner" })).data.actions.length, 0, "no duplicate draft when a request already exists");
  } finally { delete process.env.ANTHROPIC_API_KEY; }
});
