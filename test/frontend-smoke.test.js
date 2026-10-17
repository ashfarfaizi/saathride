// Smoke test for public/app.js: runs the real frontend script in a stub DOM against the real API
// and checks every view renders without throwing and escapes hostile text. NOT a visual/browser test.
process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const db = require("../db");
const { createApp } = require("../server");

const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const XSS = `<img src=x onerror=alert(1)>`;
let server, base;

class El {
  constructor(sel) { this.sel = sel; this.innerHTML = ""; this.hidden = false; this.textContent = ""; this.value = ""; this.files = []; this.disabled = false; this.style = {}; }
  querySelector(s) { return new El(s); } querySelectorAll() { return []; }
  addEventListener() {} showModal() {} close() {} scrollIntoView() {} setAttribute() {} insertAdjacentHTML(_, h) { this.innerHTML += h; }
}
function makeFrontend(cookie) {
  const els = {};
  const get = (sel) => (els[sel] ||= new El(sel));
  const errors = [];
  const ctx = {
    console, URLSearchParams, FormData, Date, Math, Number, String, Object, Array, Promise, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    document: { querySelector: get, querySelectorAll: () => [], addEventListener() {}, head: new El("head"), body: new El("body") },
    window: { addEventListener() {}, scrollTo() {} },
    location: { hash: "" }, sessionStorage: { _: {}, getItem(k) { return this._[k] ?? null; }, setItem(k, v) { this._[k] = v; }, removeItem(k) { delete this._[k]; } },
    confirm: () => true, alert() {},
    fetch: (url, opts = {}) => fetch(base + url, { ...opts, headers: { ...(opts.headers || {}), ...(cookie ? { Cookie: cookie } : {}) } }),
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8"), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public", "discover.js"), "utf8"), ctx);
  return { ctx, els, errors };
}
const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));
async function go(fe, hash) { fe.ctx.location.hash = hash; fe.ctx.route(); await wait(); }

async function apiClient(name, extra = {}) {
  const post = async (p, b, cookie) => { const r = await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(b) }); return { r, data: await r.json() }; };
  const { r, data } = await post("/api/auth/signup", { name, email: `${name.toLowerCase().replace(/\W/g, "")}@example.com`, password: "password123", ...extra });
  const cookie = r.headers.getSetCookie()[0].split(";")[0];
  return { cookie, user: data.user, post: (p, b) => post(p, b, cookie) };
}

test.before(async () => {
  process.env.CLOUDINARY_CLOUD_NAME = "demo-cloud"; process.env.CLOUDINARY_API_KEY = "k"; process.env.CLOUDINARY_API_SECRET = "s";
  await db.migrate(); server = createApp({ limits: { auth: 999, api: 99999, write: 999, trip: 999, interest: 999, comment: 999, like: 999 } }).listen(0); base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test("every view renders with real data, escapes hostile text, and does not throw", async () => {
  const owner = await apiClient("Smoke Owner", { gender: "female", college: XSS });
  const rider = await apiClient("Smoke Rider");
  const pic = `https://res.cloudinary.com/demo-cloud/image/upload/v1/saathride/posts/${owner.user.id}/pic1.jpg`;
  const t = (await owner.post("/api/trips", { origin: XSS, destination: "IIT Kharagpur", depart_date: day(1), depart_time: "08:15", vehicle_type: "car", vehicle_model: XSS, seats_total: 2, contribution_inr: 40, recurring: ["Mon"], description: `Hi ${XSS}`,
    images: [{ url: pic, public_id: `saathride/posts/${owner.user.id}/pic1`, width: 800, height: 600 }] })).data.trip;
  assert.ok(t && t.images.length === 1, "post with photo should be created");
  await rider.post(`/api/trips/${t.id}/interest`, { message: XSS });
  await rider.post(`/api/trips/${t.id}/comments`, { body: `nice ${XSS}` });
  await rider.post(`/api/trips/${t.id}/like`, {});

  // logged-out visitor
  const anon = makeFrontend(null);
  await wait();
  await go(anon, "#/");
  let feed = anon.els["#feed"].innerHTML;
  assert.match(feed, /IIT Kharagpur/); assert.match(feed, /I'm interested/);
  assert.match(feed, /res\.cloudinary\.com\/demo-cloud\/image\/upload\/c_limit,w_800,q_auto,f_auto\//, "photo is served resized");
  assert.match(feed, /class="slides"/); assert.match(feed, /1 like/);
  assert.ok(!feed.includes(XSS), "feed must escape HTML"); assert.match(feed, /&lt;img src=x/);
  assert.match(anon.els["#app"].innerHTML, /Join SaathRide/, "logged-out visitors see the welcome banner");
  await go(anon, "#/?sort=new"); assert.match(anon.els["#feed"].innerHTML, /IIT Kharagpur/);
  await go(anon, "#/explore");
  assert.match(anon.els["#results"].innerHTML, /class="map-item"/, "map view lists journeys beside the map");
  assert.match((anon.els["#exMap"] || {}).innerHTML || "", /switched on|couldn|load/, "map explains when it is not configured: " + JSON.stringify((anon.els["#exMap"] || {}).innerHTML));
  await go(anon, "#/explore?view=list"); assert.match(anon.els["#results"].innerHTML, /class="tile"/);
  await go(anon, "#/explore?view=list&origin=zzz-no-match");
  assert.match(anon.els["#results"].innerHTML, /No journeys match/);
  await go(anon, "#/explore?view=list&vehicle_type=car&time_from=07:00&time_to=09:00&recurring=1");
  assert.match(anon.els["#results"].innerHTML, /IIT Kharagpur/); assert.ok(!anon.els["#results"].innerHTML.includes(XSS));
  await go(anon, `#/trip/${t.id}`);
  assert.match(anon.els["#app"].innerHTML, /to comment/); assert.ok(!anon.els["#app"].innerHTML.includes(XSS));
  assert.match(anon.els["#commentList"].innerHTML, /nice &lt;img/); assert.ok(!anon.els["#commentList"].innerHTML.includes(XSS), "comments are escaped");
  await go(anon, "#/login"); assert.match(anon.els["#app"].innerHTML, /Log in/);
  await go(anon, "#/signup"); assert.match(anon.els["#app"].innerHTML, /Create account/);
  for (const gated of ["#/explore?tab=match", "#/explore?tab=people", "#/community", "#/post", "#/inbox", "#/inbox/1", "#/notifications", "#/profile", `#/edit/${t.id}`, "#/me"]) { await go(anon, gated); assert.equal(anon.ctx.location.hash, "#/login", `${gated} requires login`); }
  assert.match(anon.els["#nav"].innerHTML, /Home/); assert.match(anon.els["#nav"].innerHTML, /Explore/); assert.match(anon.els["#nav"].innerHTML, /Create/); assert.match(anon.els["#nav"].innerHTML, /Inbox/); assert.match(anon.els["#nav"].innerHTML, /Profile/);

  // rider
  const r = makeFrontend(rider.cookie); await wait();
  await go(r, "#/"); assert.match(r.els["#feed"].innerHTML, /Request sent/); assert.match(r.els["#feed"].innerHTML, /aria-pressed="true"[^>]*aria-label="Unlike this post"|aria-label="Unlike this post"/);
  await go(r, `#/trip/${t.id}`); assert.match(r.els["#app"].innerHTML, /waiting for the owner/); assert.match(r.els["#app"].innerHTML, /id="commentForm"/);
  await go(r, `#/u/${owner.user.id}`); assert.match(r.els["#app"].innerHTML, /profile-grid/); assert.match(r.els["#app"].innerHTML, /@smokeowner/);
  assert.ok(!r.els["#app"].innerHTML.includes(XSS)); assert.ok(!/password|@example\.com|gender/.test(r.els["#app"].innerHTML.replace(/Gender|gender/g, "")));
  await go(r, "#/u/@smokeowner"); assert.match(r.els["#app"].innerHTML, /profile-grid/, "profile by @username");
  await go(r, "#/profile"); assert.match(r.els["#app"].innerHTML, /Edit profile/); assert.match(r.els["#app"].innerHTML, /Saved/);
  await go(r, "#/profile?tab=saved"); assert.match(r.els["#app"].innerHTML, /only you can see this list/);
  await go(r, "#/inbox");
  assert.match(r.els["#reqStrip"].innerHTML, /Your requests/); assert.match(r.els["#reqStrip"].innerHTML, /waiting for a reply/);
  const rlist = r.els["#convoList"].innerHTML;
  assert.match(rlist, /Smoke Owner/); assert.match(rlist, /IIT Kharagpur/); assert.ok(!rlist.includes(XSS), "inbox list escapes text");
  const convId = Number((rlist.match(/href="#\/inbox\/(\d+)"/) || [])[1]);
  assert.ok(convId, "conversation from the interest request is listed");
  await go(r, `#/inbox/${convId}`); await wait(300);
  const pane = r.els["#chatPane"].innerHTML;
  assert.match(pane, /Smoke Owner/); assert.match(pane, /data-act="reportUser"/); assert.match(pane, /id="composer"/); assert.match(pane, /Pickup point/);
  assert.match(pane, /Request pending/); assert.match(pane, /doesn't reserve a seat/);
  const log = r.els["#chatLog"].innerHTML;
  assert.match(log, /Asked to join this trip/); assert.match(log, /&lt;img src=x/); assert.ok(!log.includes(XSS), "messages are escaped");
  await go(r, "#/notifications"); assert.match(r.els["#notifList"].innerHTML, /Nothing here yet|notif/);
  await go(r, "#/explore?tab=match&to=IIT%20Kharagpur"); await wait(300);
  assert.match(r.els["#exploreBody"].innerHTML, /Find journeys that fit yours/); assert.match(r.els["#exploreBody"].innerHTML, /approximate location/);
  await go(r, "#/explore?tab=people"); assert.match(r.els["#exploreBody"].innerHTML, /Search by name/);
  await go(r, `#/trip/${t.id}`); await wait(300);
  assert.match(r.els["#tripExtras"].innerHTML, /Open in Maps/); assert.match(r.els["#tripExtras"].innerHTML, /google\.com\/maps\/dir/); assert.match(r.els["#tripExtras"].innerHTML, /Estimate cost share/);
  r.ctx.openAi("Find people going to IIT Kharagpur tomorrow morning"); await wait(400);
  assert.match(r.els["#aiPanel"].innerHTML, /Saath AI/); assert.match(r.els["#aiLog"].innerHTML, /basic mode/i);
  assert.ok(!r.els["#aiLog"].innerHTML.includes(XSS), "AI answer escapes trip text");
  await go(r, "#/"); assert.ok(r.els["#recs"], "home has the suggestions slot");
  await go(r, "#/me"); assert.match(r.els["#app"].innerHTML, /Private details/); assert.match(r.els["#app"].innerHTML, /Privacy/); assert.match(r.els["#app"].innerHTML, /name="username"/);
  await go(r, `#/edit/${t.id}`); assert.match(r.els["#app"].innerHTML, /only edit your own posts/);
  await go(r, "#/mine"); assert.equal(r.ctx.location.hash, "#/profile", "old My trips URL redirects");

  // owner
  const o = makeFrontend(owner.cookie); await wait();
  await go(o, `#/trip/${t.id}`);
  const html = o.els["#app"].innerHTML;
  assert.match(html, /Interested people \(1\)/); assert.match(html, /data-act="accept"/); assert.match(html, /Manage this trip/); assert.match(html, /Delete post/); assert.match(html, /Edit post/);
  assert.ok(!html.includes(XSS), "owner view must escape the requester's note");
  assert.match(o.els["#commentList"].innerHTML, /data-act="delcomment"/, "owner can moderate comments");
  await go(o, "#/post"); assert.match(o.els["#app"].innerHTML, /Women-only trip/); assert.match(o.els["#app"].innerHTML, /Share your journey/); assert.match(o.els["#app"].innerHTML, /id="photoInput"/);
  await go(o, `#/edit/${t.id}`); assert.match(o.els["#app"].innerHTML, /Edit your post/); assert.match(o.els["#app"].innerHTML, /Save changes/); assert.ok(!o.els["#app"].innerHTML.includes(XSS));
  await go(o, "#/inbox"); assert.match(o.els["#reqStrip"].innerHTML, /waiting for you/); assert.match(o.els["#convoList"].innerHTML, /Smoke Rider/);
  await go(o, "#/notifications");
  const nl = o.els["#notifList"].innerHTML;
  assert.match(nl, /New request to join/); assert.match(nl, /data-link="#\/inbox\/\d+"/); assert.match(nl, /class="notif unread"/);
  assert.match(o.els["#nav"].innerHTML, /nav-badge/, "unread badge in the nav");
  await go(o, "#/profile"); assert.match(o.els["#app"].innerHTML, /profile-grid/); assert.ok(!o.els["#app"].innerHTML.includes(XSS));
  await go(o, "#/community"); assert.match(o.els["#app"].innerHTML, /not verified/); assert.ok(!o.els["#app"].innerHTML.includes(XSS), "community page escapes the college name");
  await go(o, "#/?scope=community"); assert.match(o.els["#app"].innerHTML, /My community/);
  await go(o, "#/me"); await wait(300); assert.match(o.els["#prefsBox"].innerHTML, /Join requests/);
  await go(o, "#/admin"); assert.match(o.els["#app"].innerHTML, /not found/i, "report review hidden from non-admins");
});
