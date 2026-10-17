// SaathRide — frontend SPA (vanilla JS, hash routing). All data comes from /api; nothing is hardcoded.
const $ = (s) => document.querySelector(s);
const view = $("#app");
let me = null;
let poll = null;
let feedState = { offset: 0 };
let commentState = { offset: 0 };
let notifState = { offset: 0 };
let config = { uploads: false, max_images: 5, caption_max: 500, calls: false };
const badges = { notifications: 0, messages: 0 };
let syncTimer = null;

// ---------- helpers ----------
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method, credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && me && !path.startsWith("/api/auth/")) { me = null; renderNav(); }
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), 3400);
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const initials = (n) => String(n).split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
// Cloudinary delivery URL with on-the-fly resize + best format (only for our own https Cloudinary URLs).
const cl = (url, w, square = false) => (typeof url === "string" && url.startsWith("https://res.cloudinary.com/") && url.includes("/image/upload/")
  ? url.replace("/image/upload/", `/image/upload/${square ? `c_fill,g_auto,w_${w},h_${w}` : `c_limit,w_${w}`},q_auto,f_auto/`) : "");
const avatar = (u, size = "") => (u.avatar_url && cl(u.avatar_url, 128, true)
  ? `<img class="avatar ${size}" src="${esc(cl(u.avatar_url, 128, true))}" alt="" loading="lazy" />`
  : `<span class="avatar ${size} c${(u.avatar_color || 0) % 8}" aria-hidden="true">${esc(initials(u.name))}</span>`);

const I = (d) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICON = {
  heart: I('<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>'),
  chat: I('<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/>'),
  send: I('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>'),
  bookmark: I('<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>'),
  more: I('<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>'),
  home: I('<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>'),
  compass: I('<circle cx="12" cy="12" r="10"/><polygon points="16.2 7.8 14.1 14.1 7.8 16.2 9.9 9.9 16.2 7.8"/>'),
  plus: I('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  inbox: I('<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z"/>'),
  call: I('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>'),
  mic: I('<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>'),
  micOff: I('<line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.1 2.1M15 9.3V4a3 3 0 0 0-5.9-.6"/><path d="M17 16.9A7 7 0 0 1 5 12v-2m14 0v2c0 .8-.1 1.5-.4 2.2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>'),
  hangup: I('<path d="M10.7 13.3a16 16 0 0 0 3.4 2.6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-3.3-2.6m-2.5-3.2A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9"/><line x1="23" y1="1" x2="1" y2="23"/>'),
  pin: I('<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>'),
  rupee: I('<path d="M6 3h12M6 8h12M6 13l8.5 8M6 13h3a5 5 0 0 0 0-10"/>'),
  share: I('<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>'),
  shield: I('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
  spark: I('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>'),
  map: I('<polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>'),
  list: I('<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>'),
  nav: I('<polygon points="3 11 22 2 13 21 11 13 3 11"/>'),
  check2: I('<polyline points="18 7 9.5 15.5 6 12"/><polyline points="22 7 13.5 15.5"/>'),
  bell: I('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>'),
  user: I('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  search: I('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  clock: I('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
  users: I('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>'),
  repeat: I('<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'),
  layers: I('<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>'),
  x: I('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  left: I('<polyline points="15 18 9 12 15 6"/>'), right: I('<polyline points="9 18 15 12 9 6"/>'),
  camera: I('<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>'),
};
const VEHICLES = { car: ["🚗", "Car"], bike: ["🏍️", "Bike"], scooty: ["🛵", "Scooty"], cab: ["🚕", "Cab share"], auto: ["🛺", "Auto share"], public: ["🚆", "Bus / metro / train"] };
const SEAT_MAX = { car: 8, cab: 6, auto: 3, bike: 2, scooty: 2 };
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const AVATAR_COUNT = 8;

function fmtTime(t) { const [h, m] = t.split(":").map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; }
function fmtDate(s) {
  const [y, mo, d] = s.split("-").map(Number);
  const date = new Date(y, mo - 1, d), today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((date - today) / 864e5);
  if (diff === 0) return "Today"; if (diff === 1) return "Tomorrow";
  return date.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
}
function ago(iso) {
  const t = new Date(String(iso).includes("T") ? iso : String(iso).replace(" ", "T") + "Z").getTime();
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return "just now"; if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`; return `${Math.round(m / 1440)}d ago`;
}
const stars = (u) => (u.rating ? `· <span class="stars">★ ${u.rating}</span> (${u.rating_count})` : "");
const routeLine = (o, d) => `<div class="route"><span class="dot origin"></span><span class="place">${esc(o)}</span><span class="dash"></span><span class="dot dest"></span><span class="place">${esc(d)}</span></div>`;
const eduChip = (u) => (u.edu_email ? `<span class="chip" title="Signed up with a college email address. SaathRide has not verified this.">🎓 College email (unverified)</span>` : "");
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const likeLabel = (n) => (n ? plural(n, "like") : "No likes yet");

// ---------- nav ----------
function renderNav() {
  const route = (location.hash.slice(1).split("?")[0] || "/");
  const items = [
    ["/", "home", "Home"], ["/explore", "compass", "Explore"], ["/post", "plus", "Create", "create"],
    ["/inbox", "inbox", "Inbox"], ["/notifications", "bell", "Notifications"], ["/profile", "user", "Profile"],
  ];
  const active = (href) => route === href || (href === "/" && route.startsWith("/trip/")) || (href === "/post" && route.startsWith("/edit/")) || (href === "/profile" && route === "/me") || (href === "/inbox" && route.startsWith("/inbox/"));
  $("#nav").innerHTML = items.map(([href, icon, label, cls = ""]) =>
    `<a href="#${href}" class="${cls} ${active(href) ? "active" : ""}" ${active(href) ? 'aria-current="page"' : ""}>${ICON[icon]}${navBadge(href)}<span>${label}</span></a>`).join("");
  $("#authbox").innerHTML = me ? "" : `<a class="btn small ghost" href="#/login">Log in</a><a class="btn small" href="#/signup">Sign up</a>`;
}

function navBadge(href) {
  const n = href === "/inbox" ? badges.messages : href === "/notifications" ? badges.notifications : 0;
  return n ? `<span class="badge nav-badge" aria-label="${n} unread">${n > 99 ? "99+" : n}</span>` : "";
}
function setBadges(d) {
  const changed = d.messages_unread !== badges.messages || d.notifications_unread !== badges.notifications;
  badges.messages = d.messages_unread ?? badges.messages; badges.notifications = d.notifications_unread ?? badges.notifications;
  if (changed) renderNav();
  return changed;
}

// ---------- background sync: badges + incoming calls (polling; works on serverless hosting) ----------
async function sync() {
  if (!me) return;
  try {
    const d = await api("/api/sync");
    const changed = setBadges(d);
    if (d.incoming_call) Call.incoming(d.incoming_call);
    if (changed && parseHash().path.startsWith("/inbox")) refreshConvoList();
  } catch { /* offline: try again next tick */ }
}
function startSync() {
  clearInterval(syncTimer);
  if (!me) return;
  sync();
  let ticks = 0;
  syncTimer = setInterval(() => { ticks++; if (document.hidden === true && !Call.state && ticks % 6) return; sync(); }, 5000);   // every 5s, every 30s in a background tab
}

// ---------- dialogs ----------
function dialog({ title, html, submitLabel, onSubmit }) {
  const d = $("#dlg");
  d.innerHTML = `<form class="dlg-form" method="dialog"><h3>${esc(title)}</h3>${html}<div class="dlg-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn">${esc(submitLabel)}</button></div></form>`;
  const form = d.querySelector("form");
  d.querySelector("[data-close]").onclick = () => d.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const b = form.querySelector(".dlg-actions .btn:not(.ghost)"); b.disabled = true;
    try { await onSubmit(Object.fromEntries(new FormData(form))); d.close(); }
    catch (err) { toast(err.message); b.disabled = false; }
  };
  d.showModal();
}

// ---------- post card ----------
const tripCache = new Map();

function interestControl(t, detail = false) {
  if (!me) return `<a class="btn" href="#/login">👋 I'm interested</a>`;
  if (t.is_owner) return detail ? `<span class="status">Your post</span>` : `<a class="btn ghost" href="#/trip/${t.id}">Manage${t.pending_count ? ` <span class="badge">${t.pending_count} new</span>` : ""}</a>`;
  if (t.my_interest === "pending") return `<span class="status pending">⏳ Request sent</span><button class="btn ghost small" data-act="withdraw" data-id="${t.id}">Withdraw</button>`;
  if (t.my_interest === "accepted") return `<span class="status ok">✓ You're confirmed</span><button class="btn ghost small" data-act="withdraw" data-id="${t.id}">Leave trip</button>`;
  if (t.my_interest === "declined") return `<span class="status no">Request declined</span>`;
  if (t.status !== "open") return `<span class="status">Trip ${esc(t.status)}</span>`;
  if (t.is_full) return `<span class="status">No seats left</span>`;
  return `<button class="btn" data-act="interest" data-id="${t.id}">👋 I'm interested</button>`;
}

function tripChips(t) {
  const [emoji, label] = VEHICLES[t.vehicle_type] || ["", t.vehicle_type];
  return `<div class="chips">
    <span class="chip">${emoji} ${esc(label)}${t.vehicle_model ? ` · ${esc(t.vehicle_model)}` : ""}</span>
    ${t.seats_total == null ? "" : `<span class="chip">${ICON.users} ${t.seats_left} of ${t.seats_total} seat${t.seats_total === 1 ? "" : "s"} free</span>`}
    ${t.contribution_inr == null ? "" : `<span class="chip cost">${t.contribution_inr === 0 ? "Free ride" : `≈ ₹${t.contribution_inr} shared cost`}</span>`}
    ${t.recurring.length ? `<span class="chip">${ICON.repeat} ${esc(t.recurring.join(" · "))}</span>` : ""}
    ${t.women_only ? `<span class="chip women">Women only</span>` : ""}
    <span class="chip" data-icount>${t.interest_count} interested</span>
    ${t.status !== "open" ? `<span class="chip warn">${esc(t.status)}</span>` : ""}
  </div>`;
}

function mediaHtml(t, detail) {
  const [emoji] = VEHICLES[t.vehicle_type] || [""];
  const n = t.images.length;
  const body = n
    ? `<div class="slides" tabindex="0" aria-label="Photos of this journey">${t.images.map((im, i) =>
        `<img src="${esc(cl(im.url, detail ? 1100 : 800))}" alt="${esc(`Photo ${i + 1} of ${n}: ${t.origin} to ${t.destination}`)}" loading="${i ? "lazy" : "eager"}" ${im.width && im.height ? `width="${im.width}" height="${im.height}"` : ""} />`).join("")}</div>
      ${n > 1 ? `<span class="count" data-count>1/${n}</span><button class="slide-btn prev" data-act="slide" data-dir="-1" aria-label="Previous photo" type="button">${ICON.left}</button><button class="slide-btn next" data-act="slide" data-dir="1" aria-label="Next photo" type="button">${ICON.right}</button>` : ""}`
    : `<div class="noimg c${(t.owner.avatar_color || 0) % 8}" role="img" aria-label="${esc(`${t.origin} to ${t.destination}`)}"><span class="big" aria-hidden="true">${emoji}</span></div>`;
  return `<div class="media" data-media="${t.id}">${body}<span class="stub">${esc(fmtDate(t.depart_date))} · ${esc(fmtTime(t.depart_time))}</span><div class="ribbon">${routeLine(t.origin, t.destination)}</div></div>`;
}

function postMenu(t) {
  return `<details class="menu"><summary aria-label="More options">${ICON.more}</summary><div class="menu-list">
    ${me ? `<button type="button" data-act="sendpost" data-id="${t.id}">Send in a message</button>` : ""}
    ${t.is_owner ? `<a href="#/edit/${t.id}">Edit post</a><button type="button" class="danger" data-act="delete" data-id="${t.id}">Delete post</button>`
      : `<button type="button" data-act="report" data-id="${t.id}">Report post</button>`}</div></details>`;
}

function postCard(t, detail = false) {
  tripCache.set(t.id, t);
  const o = t.owner;
  return `<article class="post" data-trip="${t.id}">
    <header class="post-head">
      <a class="who" href="#/u/${o.id}">${avatar(o)}<span><strong>${esc(o.name)}</strong><small>@${esc(o.username)}${o.college ? ` · ${esc(o.college)}` : ""} ${stars(o)}</small></span></a>
      ${postMenu(t)}
    </header>
    ${detail ? mediaHtml(t, true) : `${mediaHtml(t, false)}`}
    <div class="post-actions">
      <button class="act like" data-act="like" data-id="${t.id}" aria-pressed="${t.liked}" aria-label="${t.liked ? "Unlike" : "Like"} this post" type="button">${ICON.heart}</button>
      ${detail ? `<button class="act" data-act="focuscomment" aria-label="Write a comment" type="button">${ICON.chat}</button>` : `<a class="act" href="#/trip/${t.id}?c=1" aria-label="View comments">${ICON.chat}</a>`}
      <button class="act" data-act="share" data-id="${t.id}" aria-label="Share this post" type="button">${ICON.send}</button>
      <span class="spacer"></span>
      <button class="act save" data-act="save" data-id="${t.id}" aria-pressed="${t.saved}" aria-label="${t.saved ? "Unsave" : "Save"} this post" type="button">${ICON.bookmark}</button>
    </div>
    <div class="post-body">
      <div class="likes" data-likes>${likeLabel(t.like_count)}</div>
      ${t.description ? `<p class="caption"><a href="#/u/${o.id}"><strong>${esc(o.username)}</strong></a> ${esc(t.description)}</p>` : ""}
      ${tripChips(t)}
      ${detail ? "" : `<a class="view-comments" href="#/trip/${t.id}?c=1" data-ccount>${t.comment_count ? `View ${t.comment_count === 1 ? "1 comment" : `all ${t.comment_count} comments`}` : "Add a comment"}</a>`}
      <div class="interest-bar" data-interest>${interestControl(t, detail)}</div>
      <div class="post-time">${esc(ago(t.created_at))}</div>
    </div>
  </article>`;
}

function tile(t) {
  tripCache.set(t.id, t);
  const first = t.images[0];
  const [emoji] = VEHICLES[t.vehicle_type] || [""];
  return `<a class="tile" href="#/trip/${t.id}" aria-label="${esc(`${t.origin} to ${t.destination}, ${fmtDate(t.depart_date)} ${fmtTime(t.depart_time)}`)}">
    ${first ? `<img src="${esc(cl(first.url, 500, true))}" alt="" loading="lazy" />` : `<span class="noimg c${(t.owner.avatar_color || 0) % 8}"><span class="big" aria-hidden="true">${emoji}</span></span>`}
    ${t.status !== "open" ? `<span class="state">${esc(t.status)}</span>` : ""}
    ${t.images.length > 1 ? `<span class="multi" title="${t.images.length} photos">${ICON.layers}</span>` : ""}
    <span class="tile-meta"><span class="tile-route">${esc(t.origin)} → ${esc(t.destination)}</span><span class="tile-time">${esc(fmtDate(t.depart_date))} · ${esc(fmtTime(t.depart_time))}</span></span>
  </a>`;
}

// Update a visible post in place (keeps photo-carousel scroll position).
function patchTrip(t) {
  tripCache.set(t.id, t);
  document.querySelectorAll(`[data-trip="${t.id}"]`).forEach((el) => {
    const like = el.querySelector('[data-act="like"]');
    if (like) { like.setAttribute("aria-pressed", String(t.liked)); like.setAttribute("aria-label", `${t.liked ? "Unlike" : "Like"} this post`); }
    const save = el.querySelector('[data-act="save"]');
    if (save) { save.setAttribute("aria-pressed", String(t.saved)); save.setAttribute("aria-label", `${t.saved ? "Unsave" : "Save"} this post`); }
    const likes = el.querySelector("[data-likes]"); if (likes) likes.textContent = likeLabel(t.like_count);
    const ic = el.querySelector("[data-icount]"); if (ic) ic.textContent = `${t.interest_count} interested`;
    const cc = el.querySelector("[data-ccount]"); if (cc) cc.textContent = t.comment_count ? `View ${t.comment_count === 1 ? "1 comment" : `all ${t.comment_count} comments`}` : "Add a comment";
    const bar = el.querySelector("[data-interest]"); if (bar) bar.innerHTML = interestControl(t, location.hash.startsWith("#/trip/"));
  });
}
function refreshTrip(t) {
  tripCache.set(t.id, t);
  if (location.hash.startsWith("#/trip/")) return route();
  patchTrip(t);
}

document.addEventListener("scroll", (e) => { // photo counter "2/5" follows the carousel
  const el = e.target;
  if (!el || !el.classList || !el.classList.contains("slides")) return;
  const c = el.parentElement.querySelector("[data-count]");
  if (c) c.textContent = `${Math.round(el.scrollLeft / el.clientWidth) + 1}/${el.children.length}`;
}, true);

document.addEventListener("click", async (e) => {
  document.querySelectorAll("details.menu[open]").forEach((d) => { if (!d.contains(e.target)) d.removeAttribute("open"); });
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const menu = btn.closest("details.menu"); if (menu) menu.removeAttribute("open");
  const { act } = btn.dataset; const id = Number(btn.dataset.id);
  const guard = async (fn) => { btn.disabled = true; try { await fn(); } catch (err) { toast(err.message); } finally { btn.disabled = false; } };
  if (!me && ["interest", "save", "report", "withdraw", "like", "delete", "startChat", "sendpost"].includes(act)) { toast("Log in to do that"); location.hash = "#/login"; return; }

  if (act === "like") {
    guard(async () => {
      const t = tripCache.get(id); const r = await api(`/api/trips/${id}/like`, { method: t.liked ? "DELETE" : "POST" });
      patchTrip({ ...t, liked: r.liked, like_count: r.like_count });
    });
  } else if (act === "interest") {
    dialog({
      title: "Say you're interested",
      html: `<p class="notice">This doesn't reserve a seat. The trip owner reviews requests and decides.</p>
             <div class="field"><label for="im">Add a note (optional)</label><textarea id="im" name="message" rows="3" maxlength="200" placeholder="e.g. I'll be at the main gate — can you pick me up there?"></textarea></div>`,
      submitLabel: "Send request",
      onSubmit: async (f) => { const { trip } = await api(`/api/trips/${id}/interest`, { method: "POST", body: { message: f.message } }); toast("Request sent ✓"); if (chat.id && location.hash.startsWith("#/inbox/")) { reloadChatHeader(); pollMessages(); } else refreshTrip(trip); },
    });
  } else if (act === "withdraw") {
    if (!confirm("Withdraw your request for this trip?")) return;
    guard(async () => { const { trip } = await api(`/api/trips/${id}/interest`, { method: "DELETE" }); toast("Request withdrawn"); if (chat.id && location.hash.startsWith("#/inbox/")) { reloadChatHeader(); pollMessages(); } else refreshTrip(trip); });
  } else if (act === "save") {
    guard(async () => {
      const t = tripCache.get(id); const saved = !t.saved;
      await api(`/api/trips/${id}/save`, { method: saved ? "POST" : "DELETE" });
      patchTrip({ ...t, saved }); toast(saved ? "Saved to your profile" : "Removed from saved");
    });
  } else if (act === "share") {
    const t = tripCache.get(id); const url = `${location.origin}${t.share_path}`;
    const title = `${t.origin} → ${t.destination} on SaathRide`;
    try {
      if (navigator.share) await navigator.share({ title, text: title, url });
      else { await navigator.clipboard.writeText(url); toast("Link copied"); }
    } catch (err) { if (err && err.name !== "AbortError") { try { await navigator.clipboard.writeText(url); toast("Link copied"); } catch { prompt("Copy this link", url); } } }
  } else if (act === "delete") {
    if (!confirm("Delete this post for good? Its photos, likes and comments will be removed.")) return;
    guard(async () => { await api(`/api/trips/${id}`, { method: "DELETE" }); toast("Post deleted"); location.hash = "#/profile"; });
  } else if (act === "report") {
    dialog({
      title: "Report this post",
      html: `<div class="field"><label for="rr">What's wrong?</label><select id="rr" name="reason" required><option value="">Choose a reason</option><option value="spam">Spam or ad</option><option value="unsafe">Looks unsafe</option><option value="harassment">Harassment</option><option value="fake">Fake or misleading</option><option value="inappropriate">Inappropriate content</option><option value="other">Something else</option></select></div>
             <div class="field"><label for="rd">Details (optional)</label><textarea id="rd" name="details" rows="3" maxlength="300"></textarea></div>`,
      submitLabel: "Send report",
      onSubmit: async (f) => { await api(`/api/trips/${id}/report`, { method: "POST", body: f }); toast("Thanks — we'll review this."); },
    });
  } else if (act === "slide") {
    const s = btn.parentElement.querySelector(".slides"); if (s) s.scrollBy({ left: Number(btn.dataset.dir) * s.clientWidth, behavior: "smooth" });
  } else if (act === "focuscomment") {
    const i = $("#commentInput"); if (i) { i.scrollIntoView({ block: "center", behavior: "smooth" }); i.focus(); } else { toast("Log in to comment"); location.hash = "#/login"; }
  } else if (act === "delcomment") {
    if (!confirm("Delete this comment?")) return;
    guard(async () => { const r = await api(`/api/comments/${id}`, { method: "DELETE" }); setCommentCount(r.comment_count); loadComments(false); });
  } else if (act === "cmore") {
    loadComments(true);
  } else if (act === "accept" || act === "decline") {
    if (act === "decline" && btn.dataset.accepted && !confirm("Remove this person from the trip?")) return;
    guard(async () => { await api(`/api/interests/${id}/${act}`, { method: "POST" }); toast(act === "accept" ? "Request accepted" : "Request declined"); if (chat.id && location.hash.startsWith("#/inbox/")) { reloadChatHeader(); pollMessages(); } else route(); });
  } else if (act === "msg" || act === "startChat") {
    startConversation(Number(btn.dataset.trip), Number(btn.dataset.with) || null);
  } else if (act === "sendpost") {
    sendPostDialog(id);
  } else if (act === "startCall") {
    Call.start(Number(btn.dataset.conv));
  } else if (act === "callAccept") { Call.accept();
  } else if (act === "callDecline") { Call.decline();
  } else if (act === "callEnd") { Call.end();
  } else if (act === "callMute") { Call.toggleMute();
  } else if (act === "callClose") { Call.set(null);
  } else if (act === "callAudio") { if (Call.room) Call.room.startAudio().then(() => { Call.audioBlocked = false; Call.render(); }).catch(() => {});
  } else if (act === "quick") { quickPrompt(btn.dataset.q);
  } else if (act === "shareTrip") { shareTripDialog();
  } else if (act === "retrySend") { retrySend(Number(btn.dataset.tmp));
  } else if (act === "olderMsgs") { olderMessages();
  } else if (act === "reloadChat") { if (chat.id) openChat(chat.id);
  } else if (act === "reloadInbox") { loadConvos(false);
  } else if (act === "moreConvos") { loadConvos(true);
  } else if (act === "openNotif") { openNotif(btn);
  } else if (act === "notifMore") { loadNotifs(true);
  } else if (act === "reloadNotifs") { loadNotifs(false);
  } else if (act === "blockUser") {
    const target = Number(btn.dataset.id);
    if (!confirm("Block this member? They won't be able to message you, call you or ask to join your trips, and you won't see their posts. They aren't told.")) return;
    guard(async () => { await api(`/api/block/${target}`, { method: "POST" }); toast("Blocked"); route(); });
  } else if (act === "unblockUser") {
    const target = Number(btn.dataset.id);
    guard(async () => { await api(`/api/block/${target}`, { method: "DELETE" }); toast("Unblocked"); if (location.hash === "#/me") viewEditProfile(); else route(); });
  } else if (act === "reportUser") {
    const target = Number(btn.dataset.id), conv = btn.dataset.conv || null;
    dialog({
      title: "Report this member",
      html: `<p class="muted small">Reports are private. We don't share your name with them and we don't copy your messages into the report.</p>
             <div class="field mt8"><label for="ru">What's wrong?</label><select id="ru" name="reason" required><option value="">Choose a reason</option><option value="harassment">Harassment or threats</option><option value="unsafe">Made me feel unsafe</option><option value="spam">Spam or scam</option><option value="fake">Fake profile</option><option value="inappropriate">Inappropriate content</option><option value="other">Something else</option></select></div>
             <div class="field"><label for="rud">Details (optional)</label><textarea id="rud" name="details" rows="3" maxlength="500"></textarea></div>
             <label class="check"><input type="checkbox" name="block" checked /> Also block them</label>`,
      submitLabel: "Send report",
      onSubmit: async (f) => { const r = await api(`/api/users/${target}/report`, { method: "POST", body: { reason: f.reason, details: f.details, block: !!f.block, conversation_id: conv ? Number(conv) : undefined } }); toast(r.blocked ? "Reported and blocked." : "Thanks — we'll review this."); route(); },
    });
  } else if (act === "rate") {
    const s = Number(btn.closest(".request").querySelector("select").value);
    guard(async () => { await api(`/api/trips/${btn.dataset.trip}/rate`, { method: "POST", body: { ratee_id: id, stars: s } }); toast("Thanks for rating!"); route(); });
  } else if (act === "more") {
    loadFeed(true);
  }
});

// double-tap / double-click a photo to like it
document.addEventListener("dblclick", async (e) => {
  const media = e.target.closest && e.target.closest("[data-media]");
  if (!media) return;
  const id = Number(media.dataset.media), t = tripCache.get(id);
  if (!me) { toast("Log in to like posts"); return; }
  if (!t || t.liked) return;
  const pop = document.createElement("span"); pop.className = "heart-pop"; pop.innerHTML = ICON.heart; media.appendChild(pop); setTimeout(() => pop.remove(), 700);
  try { const r = await api(`/api/trips/${id}/like`, { method: "POST" }); patchTrip({ ...t, liked: r.liked, like_count: r.like_count }); } catch (err) { toast(err.message); }
});

// ---------- routing helpers ----------
function parseHash() {
  const [path, qs] = (location.hash.slice(1) || "/").split("?");
  return { path: path || "/", params: Object.fromEntries(new URLSearchParams(qs || "")) };
}
const notFound = (msg) => { view.innerHTML = `<div class="card empty">${esc(msg)}<p class="mt12"><a class="btn" href="#/">Back to home</a></p></div>`; };

// ---------- home feed ----------
function viewHome(params) {
  const sort = params.sort === "new" ? "new" : "soon";
  const scope = me && me.college && params.scope === "community" ? "community" : "";
  view.innerHTML = `
    ${me ? "" : `<section class="welcome"><h1>Who's travelling your way?</h1>
      <p>Share a journey with a photo, see who's heading the same direction, and chat before you travel together.</p>
      <div class="row"><a class="btn" href="#/signup">Join SaathRide</a><a class="btn ghost" href="#/login">Log in</a></div></section>`}
    <div class="page-head"><h1>${me ? "Home" : "Heading out soon"}</h1>
      <div class="seg" role="group" aria-label="Sort posts">
        <a href="#/" ${sort === "soon" && !scope ? 'aria-current="true"' : ""}>Leaving soon</a><a href="#/?sort=new" ${sort === "new" && !scope ? 'aria-current="true"' : ""}>Newest</a>${me && me.college ? `<a href="#/?scope=community" ${scope ? 'aria-current="true"' : ""} title="${esc(me.college)}">My community</a>` : ""}</div></div>
    ${me && !scope ? `<div id="recs"></div>` : ""}
    ${scope ? `<p class="muted small mb8">Journeys from people who list <strong>${esc(me.college)}</strong> (self-declared, not verified) · <a href="#/community">See the community</a></p>` : ""}
    <div id="feed" class="stack" aria-live="polite"><div class="skeleton"></div></div>
    <div id="more" class="row mt16"></div>`;
  feedState = {
    offset: 0, params: scope ? { sort, scope } : { sort }, target: "#feed", render: (t) => postCard(t),
    empty: `<div class="card empty"><p><strong>No journeys posted yet.</strong></p><p class="mt8">Be the first — share where you're headed and let people find you.</p><p class="mt12"><a class="btn" href="#/${me ? "post" : "signup"}">${me ? "Share a journey" : "Join SaathRide"}</a></p></div>`,
  };
  loadFeed(false);
  if (me && !scope) loadRecommendations();
}

async function loadFeed(append) {
  const feed = $(feedState.target || "#feed"); if (!feed) return;
  const q = new URLSearchParams(feedState.params); q.set("offset", append ? feedState.offset : 0);
  try {
    const { trips, has_more, next_offset } = await api(`/api/trips?${q}`);
    feedState.offset = next_offset;
    const html = trips.map(feedState.render).join("");
    if (append) feed.insertAdjacentHTML("beforeend", html);
    else feed.innerHTML = html || feedState.empty;
    $("#more").innerHTML = has_more ? `<button class="btn ghost" data-act="more">Load more</button>` : "";
  } catch (err) { feed.innerHTML = `<div class="card empty">${esc(err.message)}</div>`; }
}

// (Explore lives in discover.js)

// ---------- time helpers for chat ----------
const toDate = (v) => new Date(String(v).includes("T") ? v : String(v).replace(" ", "T") + "Z");
const clock = (v) => toDate(v).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
function dayLabel(v) {
  const d = toDate(v), t = new Date(); t.setHours(0, 0, 0, 0);
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  const diff = Math.round((t - x) / 864e5);
  if (diff === 0) return "Today"; if (diff === 1) return "Yesterday";
  return d.toLocaleDateString("en-IN", { weekday: diff < 7 ? "long" : undefined, day: "numeric", month: "short", year: d.getFullYear() === t.getFullYear() ? undefined : "numeric" });
}
function shortWhen(v) {   // inbox list: 9:41 PM · Yesterday · Mon · 12 Oct
  const d = toDate(v), t = new Date(); t.setHours(0, 0, 0, 0);
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  const diff = Math.round((t - x) / 864e5);
  if (diff === 0) return clock(v); if (diff === 1) return "Yesterday";
  if (diff < 7) return d.toLocaleDateString("en-IN", { weekday: "short" });
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}
const STATUS_LABEL = { pending: ["pending", "Request pending"], accepted: ["ok", "Confirmed"], declined: ["no", "Declined"], withdrawn: ["", "Withdrawn"] };
const statusPill = (st) => (st && STATUS_LABEL[st] ? `<span class="status ${STATUS_LABEL[st][0]} tiny">${STATUS_LABEL[st][1]}</span>` : "");
const safeLink = (l) => (typeof l === "string" && /^#\/[\w/?=&.-]*$/.test(l) ? l : "");

// ---------- inbox ----------
const inboxState = { q: "", filter: "all", convos: [], offset: 0, hasMore: false, loading: false };

async function viewInbox(convId = null) {
  if (!me) return needLogin();
  view.className = "wide";
  const listHtml = `
    <div class="inbox-list-head">
      <div class="row between"><h1>Messages</h1><a class="btn ghost small" href="#/notifications">${ICON.bell} Activity${badges.notifications ? ` <span class="badge">${badges.notifications}</span>` : ""}</a></div>
      <label class="search-wrap">${ICON.search}<input type="search" id="inboxSearch" placeholder="Search people or places" value="${esc(inboxState.q)}" aria-label="Search conversations" autocomplete="off" /></label>
      <div class="seg mt8" role="tablist"><a href="#/inbox" data-filter="all" ${inboxState.filter === "all" ? 'aria-current="true"' : ""}>All</a><a href="#/inbox" data-filter="unread" ${inboxState.filter === "unread" ? 'aria-current="true"' : ""}>Unread</a></div>
    </div>
    <div id="reqStrip"></div>
    <div id="convoList" class="convo-list" aria-live="polite">${Array.from({ length: 4 }, () => `<div class="convo-skel"><span></span><div><i></i><i></i></div></div>`).join("")}</div>
    <div id="convoMore"></div>`;
  view.innerHTML = `<div class="inbox ${convId ? "has-chat" : ""}">
      <aside class="inbox-list" aria-label="Conversations">${listHtml}</aside>
      <section class="inbox-chat" id="chatPane" aria-label="Conversation">${convId ? `<div class="chat-loading">Loading conversation…</div>` : `<div class="chat-empty">${ICON.chat}<h2>Your messages</h2><p>Pick a conversation, or open a journey and tap <strong>Message</strong> to ask about pickup, timing or cost before you decide to travel together.</p></div>`}</section>
    </div>`;
  const input = $("#inboxSearch");
  let deb;
  input.addEventListener("input", () => { clearTimeout(deb); deb = setTimeout(() => { inboxState.q = input.value.trim(); loadConvos(false); }, 250); });
  view.querySelectorAll("[data-filter]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); inboxState.filter = a.dataset.filter; view.querySelectorAll("[data-filter]").forEach((b) => b.setAttribute("aria-current", String(b === a))); loadConvos(false); }));
  loadReqStrip();
  await loadConvos(false);
  if (convId) openChat(convId);
}

async function loadReqStrip() {
  try {
    const d = await api("/api/me/trips");
    const waitingForYou = d.posted.reduce((n, t) => n + (t.pending_count || 0), 0);
    const mine = d.interested.filter((t) => t.my_interest === "pending").length;
    const confirmed = d.interested.filter((t) => t.my_interest === "accepted" && t.status !== "cancelled").length;
    const firstPending = d.posted.find((t) => t.pending_count);
    const items = [];
    if (waitingForYou) items.push(`<a class="req-chip hot" href="#/trip/${firstPending.id}">👋 <b>${waitingForYou}</b> request${waitingForYou === 1 ? "" : "s"} on your posts waiting for you</a>`);
    if (mine) items.push(`<a class="req-chip" href="#/profile">⏳ Your requests: <b>${mine}</b> waiting for a reply</a>`);
    if (confirmed) items.push(`<span class="req-chip ok">✓ Confirmed on <b>${confirmed}</b> trip${confirmed === 1 ? "" : "s"}</span>`);
    $("#reqStrip").innerHTML = items.length ? `<div class="req-strip">${items.join("")}</div>` : "";
  } catch { /* strip is optional */ }
}

async function loadConvos(append) {
  if (inboxState.loading) return; inboxState.loading = true;
  const box = $("#convoList");
  try {
    const qs = new URLSearchParams({ offset: append ? inboxState.offset : 0 });
    if (inboxState.q) qs.set("q", inboxState.q);
    if (inboxState.filter === "unread") qs.set("filter", "unread");
    const d = await api(`/api/conversations?${qs}`);
    inboxState.convos = append ? inboxState.convos.concat(d.conversations) : d.conversations;
    inboxState.offset = d.next_offset; inboxState.hasMore = d.has_more;
    renderConvos();
  } catch (err) {
    box.innerHTML = `<div class="empty small-empty"><p>Couldn't load your conversations.</p><p class="muted">${esc(err.message)}</p><button class="btn ghost small mt8" data-act="reloadInbox">Try again</button></div>`;
  } finally { inboxState.loading = false; }
}
function refreshConvoList() { if ($("#convoList")) loadConvos(false); }

function renderConvos() {
  const box = $("#convoList"); if (!box) return;
  const active = (location.hash.match(/^#\/inbox\/(\d+)/) || [])[1];
  if (!inboxState.convos.length) {
    box.innerHTML = inboxState.q || inboxState.filter === "unread"
      ? `<div class="empty small-empty"><p>No conversations match${inboxState.q ? ` “${esc(inboxState.q)}”` : ""}.</p></div>`
      : `<div class="empty small-empty"><p><strong>No conversations yet.</strong></p><p class="muted mt8">Open a journey and tap <strong>Message</strong> to ask the owner about it — or say you're interested. Owners can message people who ask to join.</p><p class="mt12"><a class="btn small" href="#/">Browse journeys</a></p></div>`;
  } else {
    box.innerHTML = inboxState.convos.map((c) => {
      const lm = c.last_message;
      const preview = !lm ? "No messages yet — say hi 👋" : lm.kind === "event" ? lm.body : lm.kind === "trip" ? `${lm.mine ? "You" : esc(c.other.name.split(" ")[0])} shared a journey` : `${lm.mine ? "You: " : ""}${lm.body}`;
      return `<a class="convo ${c.unread_count ? "unread" : ""} ${String(c.id) === active ? "active" : ""}" href="#/inbox/${c.id}" ${String(c.id) === active ? 'aria-current="true"' : ""}>
        ${avatar(c.other)}
        <span class="convo-main">
          <span class="convo-top"><strong>${esc(c.other.name)}</strong><time>${esc(shortWhen(lm ? lm.created_at : c.last_activity_at))}</time></span>
          <span class="convo-trip">${esc(c.trip.origin)} → ${esc(c.trip.destination)} · ${esc(fmtDate(c.trip.depart_date))}${c.trip.status === "cancelled" ? " · cancelled" : ""}</span>
          <span class="convo-bottom"><span class="convo-preview">${lm && lm.kind === "trip" ? preview : esc(preview)}</span>${c.unread_count ? `<span class="badge" aria-label="${c.unread_count} unread">${c.unread_count}</span>` : statusPill(c.interest_status)}</span>
        </span></a>`;
    }).join("");
  }
  const more = $("#convoMore"); if (more) more.innerHTML = inboxState.hasMore ? `<button class="btn ghost small block" data-act="moreConvos">Load more</button>` : "";
}

// ---------- one conversation ----------
const chat = { id: null, conv: null, lastId: 0, firstId: 0, hasOlder: false, timer: null, otherRead: 0, sending: 0 };

async function openChat(id) {
  clearInterval(chat.timer);
  Object.assign(chat, { id: Number(id), conv: null, lastId: 0, firstId: 0, hasOlder: false, otherRead: 0 });
  const pane = $("#chatPane");
  let d;
  try { d = await api(`/api/conversations/${id}`); } catch (err) {
    pane.innerHTML = `<div class="chat-empty">${ICON.chat}<h2>Conversation unavailable</h2><p>${esc(err.message)}</p><p class="mt12"><a class="btn ghost small" href="#/inbox">Back to messages</a></p></div>`;
    return;
  }
  const c = chat.conv = d.conversation;
  chat.otherRead = c.other_last_read_id;
  pane.innerHTML = `
    <header class="chat-head">
      <a class="icon-btn back" href="#/inbox" aria-label="Back to messages">${ICON.left}</a>
      <a class="chat-who" href="#/u/${c.other.id}">${avatar(c.other, "sm")}<span><strong>${esc(c.other.name)}</strong><small>@${esc(c.other.username)}</small></span></a>
      <span class="spacer"></span>
      ${callButton(c)}
      <details class="menu"><summary aria-label="Conversation options">${ICON.more}</summary><div class="menu-list">
        <a href="#/u/${c.other.id}">View profile</a><a href="#/trip/${c.trip.id}">View journey</a>
        <button type="button" data-act="${c.blocked_by_me ? "unblockUser" : "blockUser"}" data-id="${c.other.id}">${c.blocked_by_me ? "Unblock" : "Block"} ${esc(c.other.name.split(" ")[0])}</button>
        <button type="button" class="danger" data-act="reportUser" data-id="${c.other.id}" data-conv="${c.id}">Report</button></div></details>
    </header>
    <div id="tripCtx">${tripContext(c)}</div>
    <div class="chat-log" id="chatLog" role="log" aria-live="polite" aria-label="Messages"><p class="muted center">Loading messages…</p></div>
    <div id="chatFoot">${chatFooter(c)}</div>`;
  wireComposer();
  await loadMessages();
  chat.timer = setInterval(pollMessages, 3000);
}

function callButton(c) {
  if (!config.calls || !c.calls_enabled) return "";
  return `<button class="icon-btn call-btn" type="button" data-act="startCall" data-conv="${c.id}" ${c.call_eligible ? "" : "disabled"} aria-label="Voice call" title="${c.call_eligible ? "Voice call — your number stays private" : "Calling unlocks once you've both sent a message"}">${ICON.call}</button>`;
}

function tripContext(c) {
  const t = c.trip, st = c.interest && c.interest.status;
  const seats = t.seats_total == null ? "" : t.seats_left ? `${plural(t.seats_left, "seat")} left` : "No seats left";
  const [emoji] = VEHICLES[t.vehicle_type] || [""];
  let actions = "", note = "";
  if (t.status === "cancelled") note = `<span class="status no tiny">Trip cancelled</span>`;
  else if (c.role === "member") {
    if (st === "pending") { actions = `<button class="btn ghost small" data-act="withdraw" data-id="${t.id}">Withdraw request</button>`; note = `${statusPill(st)} <span class="muted small">The owner decides — a request doesn't reserve a seat.</span>`; }
    else if (st === "accepted") { actions = `<button class="btn ghost small" data-act="withdraw" data-id="${t.id}">Leave trip</button>`; note = `${statusPill(st)} <span class="muted small">Agree a public pickup point here.</span>`; }
    else if (st === "declined") note = statusPill(st);
    else if (t.status === "open" && t.seats_left !== 0) { actions = `<button class="btn small" data-act="interest" data-id="${t.id}">👋 Ask to join</button>`; note = `<span class="muted small">Chat first, then ask to join. Asking doesn't guarantee a seat.</span>`; }
    else note = `<span class="muted small">${t.seats_left === 0 ? "No seats left" : "Not taking requests"}</span>`;
  } else {
    if (st === "pending") { actions = `<button class="btn small" data-act="accept" data-id="${c.interest.id}">Accept</button><button class="btn ghost small" data-act="decline" data-id="${c.interest.id}">Decline</button>`; note = `${statusPill(st)} <span class="muted small">${esc(c.other.name.split(" ")[0])} asked to join.</span>`; }
    else if (st === "accepted") { actions = `<button class="btn ghost small" data-act="decline" data-id="${c.interest.id}" data-accepted="1">Remove from trip</button>`; note = statusPill(st); }
    else if (st) note = statusPill(st);
    else note = `<span class="muted small">${esc(c.other.name.split(" ")[0])} hasn't asked to join yet.</span>`;
  }
  return `<div class="trip-ctx">
    <a class="trip-ctx-main" href="#/trip/${t.id}">
      ${t.cover && cl(t.cover, 96, true) ? `<img src="${esc(cl(t.cover, 96, true))}" alt="" />` : `<span class="trip-ctx-emoji" aria-hidden="true">${emoji}</span>`}
      <span class="grow"><span class="trip-ctx-route">${esc(t.origin)} → ${esc(t.destination)}</span>
      <span class="muted small">${esc(fmtDate(t.depart_date))} · ${esc(fmtTime(t.depart_time))}${seats ? ` · ${seats}` : ""}${t.contribution_inr != null ? ` · ₹${t.contribution_inr} share` : ""}</span></span>
    </a>
    <div class="trip-ctx-actions">${note}<span class="spacer"></span>${actions}</div>
  </div>`;
}

function chatFooter(c) {
  if (!c.can_send) return `<div class="chat-closed">${ICON.shield} ${esc(c.closed_reason)}</div>`;
  return `<div class="quick" role="group" aria-label="Quick prompts">
      <button type="button" class="quick-chip" data-act="quick" data-q="pickup">${ICON.pin} Pickup point</button>
      <button type="button" class="quick-chip" data-act="quick" data-q="time">${ICON.clock} Departure time</button>
      <button type="button" class="quick-chip" data-act="quick" data-q="cost">${ICON.rupee} Share cost</button>
      <button type="button" class="quick-chip" data-act="shareTrip">${ICON.share} Share a journey</button>
    </div>
    <form class="composer-bar" id="composer">
      <textarea id="msgInput" name="body" rows="1" maxlength="1000" placeholder="Message ${esc(c.other.name.split(" ")[0])}…" aria-label="Write a message"></textarea>
      <button class="send-btn" aria-label="Send">${ICON.send}</button>
    </form>
    <p class="chat-safety">Only you two can read this. Meet in public places and keep your exact address and phone number private.</p>`;
}

function wireComposer() {
  const form = $("#composer"); if (!form) return;
  const input = $("#msgInput");
  form.addEventListener("submit", (e) => { e.preventDefault(); sendText(); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendText(); } });
  input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; });
}

function msgHtml(m) {
  if (m.kind === "event") return `<div class="msg-event" data-mid="${m.id}"><span>${esc(m.body)}</span><time>${esc(clock(m.created_at))}</time></div>`;
  const trip = m.shared_trip;
  const card = trip ? (trip.removed ? `<div class="share-card removed">This journey is no longer available</div>`
    : `<a class="share-card" href="#/trip/${trip.id}">${trip.cover && cl(trip.cover, 320) ? `<img src="${esc(cl(trip.cover, 320))}" alt="" loading="lazy" />` : `<span class="share-emoji">${(VEHICLES[trip.vehicle_type] || ["🧭"])[0]}</span>`}
        <span class="share-meta"><b>${esc(trip.origin)} → ${esc(trip.destination)}</b><small>${esc(fmtDate(trip.depart_date))} · ${esc(fmtTime(trip.depart_time))} · ${esc(trip.owner_name)}${trip.status !== "open" ? ` · ${esc(trip.status)}` : ""}</small></span></a>`) : "";
  return `<div class="msg ${m.mine ? "mine" : ""} ${m.pending ? "pending" : ""} ${m.failed ? "failed" : ""}" data-mid="${m.id}">
    ${card}${m.body ? `<div class="msg-body">${esc(m.body)}</div>` : ""}
    <div class="msg-time">${m.failed ? `Not sent · <button type="button" class="link-btn" data-act="retrySend" data-tmp="${m.id}">Retry</button>` : m.pending ? "Sending…" : esc(clock(m.created_at))}</div></div>`;
}
function renderLog(msgs, { prepend = false } = {}) {
  const log = $("#chatLog"); if (!log) return;
  if (!prepend && !chat.lastId && !msgs.length) {
    log.innerHTML = `<div class="chat-start">${avatar(chat.conv.other, "lg")}<p><strong>${esc(chat.conv.other.name)}</strong></p><p class="muted small">Start by asking about the pickup point, timing or how you'll split costs.</p></div>`;
    return;
  }
  let html = "", lastDay = prepend ? "" : log._lastDay || "";
  for (const m of msgs) {
    const dl = dayLabel(m.created_at);
    if (dl !== lastDay) { html += `<div class="day-sep"><span>${esc(dl)}</span></div>`; lastDay = dl; }
    html += msgHtml(m);
  }
  if (prepend) { log.insertAdjacentHTML("afterbegin", html); return; }
  if (!chat.lastId) log.innerHTML = (chat.hasOlder ? `<button class="btn ghost small older" data-act="olderMsgs">Earlier messages</button>` : "") + html;
  else log.insertAdjacentHTML("beforeend", html);
  log._lastDay = lastDay;
}
function updateSeen() {
  const log = $("#chatLog"); if (!log || !log.querySelectorAll) return;
  log.querySelectorAll(".seen").forEach((e) => e.remove && e.remove());
  const mine = [...log.querySelectorAll(".msg.mine[data-mid]")].filter((e) => Number(e.dataset.mid) > 0);
  const last = mine[mine.length - 1];
  if (last && Number(last.dataset.mid) <= chat.otherRead) last.insertAdjacentHTML("afterend", `<div class="seen">${ICON.check2} Seen</div>`);
}
const nearBottom = (log) => !log.scrollHeight || log.scrollHeight - log.scrollTop - log.clientHeight < 120;
function scrollBottom() { const log = $("#chatLog"); if (log) log.scrollTop = log.scrollHeight || 0; }

async function loadMessages() {
  try {
    const d = await api(`/api/conversations/${chat.id}/messages`);
    chat.hasOlder = d.has_older;
    chat.firstId = d.messages.length ? d.messages[0].id : 0;
    renderLog(d.messages);
    if (d.messages.length) chat.lastId = d.messages[d.messages.length - 1].id;
    applyState(d.state);
    scrollBottom(); updateSeen(); markRead();
  } catch (err) { const log = $("#chatLog"); if (log) log.innerHTML = `<div class="empty small-empty"><p>Couldn't load messages.</p><p class="muted">${esc(err.message)}</p><button class="btn ghost small mt8" data-act="reloadChat">Try again</button></div>`; }
}
async function pollMessages() {
  if (!$("#chatLog") || !chat.id || chat.sending) return;
  try {
    const d = await api(`/api/conversations/${chat.id}/messages?after=${chat.lastId}`);
    const log = $("#chatLog"), stick = nearBottom(log);
    const fresh = d.messages.filter((m) => !(log.querySelector && log.querySelector(`[data-mid="${m.id}"]`)));
    if (fresh.length) {
      if (!chat.lastId) log.innerHTML = "";
      renderLog(fresh); chat.lastId = d.messages[d.messages.length - 1].id;
      if (stick) scrollBottom();
      if (fresh.some((m) => m.kind === "event")) reloadChatHeader();
      markRead();
    }
    applyState(d.state); updateSeen();
  } catch (err) { if (/not found/i.test(err.message)) clearInterval(chat.timer); }
}
async function olderMessages() {
  if (!chat.firstId) return;
  try {
    const d = await api(`/api/conversations/${chat.id}/messages?before=${chat.firstId}`);
    const log = $("#chatLog"); const btn = log.querySelector(".older"); if (btn && btn.remove) btn.remove();
    const h = log.scrollHeight;
    renderLog(d.messages, { prepend: true });
    if (d.has_older) log.insertAdjacentHTML("afterbegin", `<button class="btn ghost small older" data-act="olderMsgs">Earlier messages</button>`);
    if (d.messages.length) chat.firstId = d.messages[0].id;
    log.scrollTop = log.scrollHeight - h;
  } catch (err) { toast(err.message); }
}
function applyState(st) {
  if (!st || !chat.conv) return;
  chat.otherRead = st.other_last_read_id;
  const statusChanged = (chat.conv.interest ? chat.conv.interest.status : null) !== st.interest_status || chat.conv.trip.status !== st.trip_status;
  if (chat.conv.can_send !== st.can_send || statusChanged) reloadChatHeader();
}
async function reloadChatHeader() {
  try {
    const d = await api(`/api/conversations/${chat.id}`);
    const prevSend = chat.conv && chat.conv.can_send;
    chat.conv = d.conversation;
    $("#tripCtx").innerHTML = tripContext(chat.conv);
    if (prevSend !== chat.conv.can_send) { $("#chatFoot").innerHTML = chatFooter(chat.conv); wireComposer(); }
    const cb = view.querySelector(".call-btn"); if (cb && cb.outerHTML !== undefined) cb.outerHTML = callButton(chat.conv);
    refreshConvoList(); loadReqStrip();
  } catch { /* keep current */ }
}
async function markRead() {
  try { const r = await api(`/api/conversations/${chat.id}/read`, { method: "POST", body: { up_to: chat.lastId } }); setBadges({ messages_unread: r.messages_unread, notifications_unread: badges.notifications }); updateConvoUnread(chat.id); } catch { /* ignore */ }
}
function updateConvoUnread(id) { const c = inboxState.convos.find((x) => x.id === id); if (c && c.unread_count) { c.unread_count = 0; renderConvos(); } }

let tmpId = 0;
const pendingSends = new Map();
async function sendText() {
  const input = $("#msgInput"); if (!input) return;
  const text = input.value.trim(); if (!text) return;
  input.value = ""; input.style.height = "auto";
  await sendMessage({ body: text });
}
async function sendMessage(payload) {
  const tmp = -(++tmpId);
  const draft = { id: tmp, mine: true, pending: true, kind: payload.kind || "text", body: payload.body || "", created_at: new Date().toISOString(), shared_trip: payload.preview || null };
  pendingSends.set(tmp, payload);
  const log = $("#chatLog");
  if (!chat.lastId && log) log.innerHTML = "";
  renderLog([draft]); scrollBottom();
  chat.sending++;
  try {
    const { message } = await api(`/api/conversations/${chat.id}/messages`, { method: "POST", body: { body: payload.body, kind: payload.kind, trip_id: payload.trip_id } });
    const el = log && log.querySelector && log.querySelector(`[data-mid="${tmp}"]`);
    if (el && el.outerHTML !== undefined) el.outerHTML = msgHtml(message);
    chat.lastId = Math.max(chat.lastId, message.id);
    pendingSends.delete(tmp);
    if (!chat.conv.call_eligible && chat.conv.calls_enabled) reloadChatHeader();
    const c = inboxState.convos.find((x) => x.id === chat.id);
    if (c) { c.last_message = { ...message, body: message.body || "", mine: true }; inboxState.convos = [c, ...inboxState.convos.filter((x) => x !== c)]; renderConvos(); }
  } catch (err) {
    const el = log && log.querySelector && log.querySelector(`[data-mid="${tmp}"]`);
    if (el && el.outerHTML !== undefined) el.outerHTML = msgHtml({ ...draft, pending: false, failed: true });
    toast(err.message);
  } finally { chat.sending--; updateSeen(); }
}
function retrySend(tmp) {
  const p = pendingSends.get(tmp); if (!p) return;
  pendingSends.delete(tmp);
  const el = $("#chatLog").querySelector(`[data-mid="${tmp}"]`); if (el && el.remove) el.remove();
  sendMessage(p);
}
function quickPrompt(kind) {
  const input = $("#msgInput"); if (!input || !chat.conv) return;
  const t = chat.conv.trip;
  const text = kind === "pickup" ? "Could we meet at a public spot for pickup? I was thinking: "
    : kind === "time" ? `Is ${fmtTime(t.depart_time)} on ${fmtDate(t.depart_date)} still the plan? `
    : t.contribution_inr != null ? `You mentioned ₹${t.contribution_inr} for sharing costs — is that per person, and do you prefer UPI or cash? ` : "How would you like to split the fuel/fare? ";
  input.value = (input.value ? input.value.trim() + " " : "") + text;
  if (input.focus) { input.focus(); input.setSelectionRange && input.setSelectionRange(input.value.length, input.value.length); }
}

// Share one of your journeys (or a saved one) into the open conversation.
async function shareTripDialog() {
  let d; try { d = await api("/api/me/trips"); } catch (err) { return toast(err.message); }
  const seen = new Set();
  const opts = [...d.posted.filter((t) => t.status === "open"), ...d.saved].filter((t) => !seen.has(t.id) && seen.add(t.id)).slice(0, 20);
  if (!opts.length) return toast("Post a journey or save one first, then you can share it here.");
  dialog({
    title: "Share a journey",
    html: `<div class="pick-list">${opts.map((t, i) => `<label class="pick"><input type="radio" name="trip_id" value="${t.id}" ${i ? "" : "checked"} /><span><b>${esc(t.origin)} → ${esc(t.destination)}</b><small>${esc(fmtDate(t.depart_date))} · ${esc(fmtTime(t.depart_time))}${t.is_owner ? " · your post" : ` · ${esc(t.owner.name)}`}</small></span></label>`).join("")}</div>
      <div class="field mt12"><label for="sn">Add a note (optional)</label><input id="sn" name="body" maxlength="300" placeholder="e.g. I'm doing the return trip too" /></div>`,
    submitLabel: "Share",
    onSubmit: async (f) => {
      const t = opts.find((x) => String(x.id) === String(f.trip_id));
      await sendMessage({ kind: "trip", trip_id: Number(f.trip_id), body: (f.body || "").trim(), preview: t ? { id: t.id, origin: t.origin, destination: t.destination, depart_date: t.depart_date, depart_time: t.depart_time, status: t.status, owner_name: t.owner.name, vehicle_type: t.vehicle_type, cover: t.images[0] ? t.images[0].url : null } : null });
    },
  });
}
// From a post card: send it to one of your conversations.
async function sendPostDialog(tripId) {
  let d; try { d = await api("/api/conversations"); } catch (err) { return toast(err.message); }
  const list = d.conversations.filter((c) => !c.blocked_by_me).slice(0, 15);
  if (!list.length) return toast("You don't have any conversations yet.");
  dialog({
    title: "Send in a message",
    html: `<div class="pick-list">${list.map((c, i) => `<label class="pick"><input type="radio" name="conv" value="${c.id}" ${i ? "" : "checked"} />${avatar(c.other, "sm")}<span><b>${esc(c.other.name)}</b><small>${esc(c.trip.origin)} → ${esc(c.trip.destination)}</small></span></label>`).join("")}</div>
      <div class="field mt12"><label for="spn">Add a note (optional)</label><input id="spn" name="body" maxlength="300" /></div>`,
    submitLabel: "Send",
    onSubmit: async (f) => { await api(`/api/conversations/${f.conv}/messages`, { method: "POST", body: { kind: "trip", trip_id: tripId, body: (f.body || "").trim() } }); toast("Sent ✓"); },
  });
}

async function startConversation(tripId, withId) {
  if (!me) return needLogin();
  try {
    const r = await api(`/api/trips/${tripId}/conversation`, { method: "POST", body: withId ? { with: withId } : {} });
    location.hash = `#/inbox/${r.conversation_id}`;
  } catch (err) { toast(err.message); }
}

// ---------- notifications ----------
const NOTIF_ICON = { interest_request: "👋", interest_accepted: "✅", interest_declined: "✖️", interest_withdrawn: "↩️", new_message: "💬", trip_changed: "📝", trip_cancelled: "🚫", trip_completed: "🏁", call_missed: "📞" };
async function viewNotifications() {
  if (!me) return needLogin();
  view.innerHTML = `
    <div class="page-head"><h1>Activity</h1><button class="btn ghost small" id="notifReadAll" ${badges.notifications ? "" : "disabled"}>Mark all as read</button></div>
    <div id="notifList" class="card notif-card"><div class="notif skel"></div><div class="notif skel"></div><div class="notif skel"></div></div>
    <div id="notifMore" class="mt12"></div>`;
  $("#notifReadAll").addEventListener("click", async () => {
    try { await api("/api/notifications/read-all", { method: "POST" }); setBadges({ notifications_unread: 0, messages_unread: badges.messages }); loadNotifs(false); } catch (err) { toast(err.message); }
  });
  await loadNotifs(false);
}
async function loadNotifs(append) {
  const box = $("#notifList");
  try {
    const d = await api(`/api/notifications?limit=20&offset=${append ? notifState.offset : 0}`);
    notifState.offset = d.next_offset;
    const html = d.notifications.map(notifRow).join("");
    if (append) box.insertAdjacentHTML("beforeend", html);
    else box.innerHTML = html || `<div class="empty"><p><strong>Nothing here yet.</strong></p><p class="muted mt8">Requests to join your journeys, replies to your requests, new messages, missed calls and trip changes will show up here.</p></div>`;
    $("#notifMore").innerHTML = d.has_more ? `<button class="btn ghost small block" data-act="notifMore">Show older</button>` : "";
  } catch (err) { box.innerHTML = `<div class="empty"><p>Couldn't load activity.</p><p class="muted">${esc(err.message)}</p><button class="btn ghost small mt8" data-act="reloadNotifs">Try again</button></div>`; }
}
function notifRow(n) {
  const link = safeLink(n.link);
  return `<button type="button" class="notif ${n.read ? "" : "unread"}" data-act="openNotif" data-id="${n.id}" data-link="${esc(link)}" data-read="${n.read ? 1 : 0}">
    <span class="notif-icon">${n.actor ? avatar(n.actor, "sm") : ""}<span class="notif-emoji" aria-hidden="true">${NOTIF_ICON[n.type] || "🔔"}</span></span>
    <span class="grow"><b>${esc(n.title)}</b><span class="muted small">${esc(n.body)}</span><time class="smaller">${esc(ago(n.created_at))}</time></span>
    ${n.read ? "" : `<span class="dot" aria-label="Unread"></span>`}</button>`;
}
async function openNotif(btn) {
  const { id, link, read } = btn.dataset;
  if (read !== "1") {
    try { const r = await api(`/api/notifications/${id}/read`, { method: "POST" }); setBadges({ notifications_unread: r.unread, messages_unread: badges.messages }); } catch { /* still navigate */ }
  }
  if (link) location.hash = link; else { btn.classList.remove("unread"); btn.dataset.read = "1"; }
}

// ---------- voice calls (LiveKit, loaded only when a call starts) ----------
const CALL_FAIL_TEXT = {
  permission_denied: "Microphone access is blocked. Allow it for this site in your browser settings, then try again.",
  no_microphone: "No microphone was found on this device.",
  unsupported: "This browser can't make voice calls. Try a recent Chrome, Safari, Edge or Firefox.",
  connection_failed: "Couldn't connect the call. Check your internet connection and try again.",
  sdk: "The calling service couldn't load. Please try again in a moment.",
};
const Call = {
  state: null, call: null, room: null, muted: false, startedAt: 0, tick: null, poll: null, dismissed: new Set(), ending: false,

  async loadSdk() {
    if (window.LivekitClient) return window.LivekitClient;
    await new Promise((resolve, reject) => {
      const s = document.createElement("script"); s.src = "/vendor/livekit-client.js"; s.async = true;
      s.onload = resolve; s.onerror = () => reject(Object.assign(new Error("sdk"), { code: "sdk" }));
      document.head.appendChild(s);
    });
    if (!window.LivekitClient) throw Object.assign(new Error("sdk"), { code: "sdk" });
    return window.LivekitClient;
  },
  async checkMic() {
    if (typeof navigator === "undefined" || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof RTCPeerConnection === "undefined") throw Object.assign(new Error("unsupported"), { code: "unsupported" });
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); }
    catch (e) { throw Object.assign(new Error(e.name), { code: e.name === "NotAllowedError" || e.name === "SecurityError" ? "permission_denied" : e.name === "NotFoundError" ? "no_microphone" : "connection_failed" }); }
  },

  render() {
    const layer = $("#callLayer"); if (!layer) return;
    const c = this.call, st = this.state;
    if (!st) { layer.hidden = true; layer.innerHTML = ""; return; }
    const o = (c && c.other) || { name: "", avatar_color: 0 };
    const first = esc((o.name || "").split(" ")[0]);
    const lines = {
      checking: ["Checking your microphone…", ""], outgoing: [`Calling ${first}…`, "Ringing — they need to accept the call."],
      incoming: [`${esc(o.name)} is calling`, "Voice call on SaathRide"], connecting: ["Connecting…", ""],
      connected: [`On call with ${first}`, `<span id="callTimer">${this.elapsed()}</span>`], reconnecting: ["Reconnecting…", "Hold on, your connection dropped."],
      ended: ["Call ended", this.startedAt ? this.elapsed() : ""], declined: [`${first} declined the call`, "You can keep chatting by message."],
      missed: ["No answer", `${first} didn't pick up. Try messaging instead.`], cancelled: ["Call cancelled", ""],
      failed: ["Call failed", esc(CALL_FAIL_TEXT[this.reason] || CALL_FAIL_TEXT.connection_failed)],
    }[st] || ["", ""];
    const live = ["connected", "reconnecting"].includes(st);
    const finished = ["ended", "declined", "missed", "cancelled", "failed"].includes(st);
    layer.hidden = false;
    layer.innerHTML = `<div class="call-card ${st}" role="dialog" aria-modal="false" aria-live="assertive" aria-label="Voice call">
      <div class="call-avatar ${["outgoing", "incoming"].includes(st) ? "ringing" : ""}">${avatar(o, "lg")}</div>
      <div class="call-title">${lines[0]}</div><div class="call-sub">${lines[1]}</div>
      ${this.audioBlocked && live ? `<button class="btn small mt8" data-act="callAudio">Tap to hear audio</button>` : ""}
      <div class="call-controls">
        ${st === "incoming" ? `<button class="round decline" data-act="callDecline" aria-label="Decline">${ICON.hangup}</button><button class="round accept" data-act="callAccept" aria-label="Accept">${ICON.call}</button>` : ""}
        ${live ? `<button class="round ${this.muted ? "muted" : ""}" data-act="callMute" aria-pressed="${this.muted}" aria-label="${this.muted ? "Unmute" : "Mute"}">${this.muted ? ICON.micOff : ICON.mic}</button>` : ""}
        ${["outgoing", "connecting", "checking"].includes(st) || live ? `<button class="round decline" data-act="callEnd" aria-label="End call">${ICON.hangup}</button>` : ""}
        ${finished ? `<button class="btn ghost small" data-act="callClose">Close</button>` : ""}
      </div>
      <p class="call-privacy">${ICON.shield} Your phone number is never shared.</p>
    </div>`;
  },
  set(state, extra = {}) { Object.assign(this, extra); this.state = state; this.render(); },
  elapsed() { if (!this.startedAt) return "00:00"; const s = Math.floor((Date.now() - this.startedAt) / 1000); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; },

  async start(convId) {
    if (this.state && !this.isFinished()) return toast("You're already in a call");
    this.reset();
    this.set("checking", { call: { other: chat.conv && chat.conv.id === convId ? chat.conv.other : null } });
    try { await this.checkMic(); await this.loadSdk(); } catch (e) { return this.set("failed", { reason: e.code }); }
    let r;
    try { r = await api(`/api/conversations/${convId}/calls`, { method: "POST" }); } catch (err) { this.set(null); return toast(err.message); }
    this.set("outgoing", { call: r.call });
    this.watch();
    try { await this.connect(r.livekit); } catch (e) { this.fail("connection_failed"); }
  },
  incoming(call) {
    if (this.dismissed.has(call.id) || (this.call && this.call.id === call.id)) return;
    if (this.state && !this.isFinished()) return;   // already busy: they'll see it as missed
    this.reset(); this.set("incoming", { call }); this.watch();
    try { if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate([300, 200, 300]); } catch { /* optional */ }
  },
  async accept() {
    const id = this.call.id;
    this.set("connecting");
    try { await this.checkMic(); await this.loadSdk(); } catch (e) {
      api(`/api/calls/${id}/fail`, { method: "POST", body: { reason: e.code === "sdk" ? "connection_failed" : e.code } }).catch(() => {});
      return this.set("failed", { reason: e.code });
    }
    let r;
    try { r = await api(`/api/calls/${id}/accept`, { method: "POST" }); } catch (err) { this.set("failed", { reason: "connection_failed" }); return toast(err.message); }
    this.call = r.call;
    try { await this.connect(r.livekit); this.connected(); } catch { this.fail("connection_failed"); }
  },
  async decline() { const id = this.call.id; this.dismissed.add(id); this.set(null); this.stopWatch(); try { await api(`/api/calls/${id}/decline`, { method: "POST" }); } catch { /* ignore */ } },
  async connect({ url, token }) {
    const LK = await this.loadSdk();
    const room = this.room = new LK.Room({ adaptiveStream: false, dynacast: false, audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const E = LK.RoomEvent;
    room.on(E.TrackSubscribed, (track) => { if (track.kind === "audio") { const el = track.attach(); el.setAttribute("data-call-audio", ""); el.hidden = true; document.body.appendChild(el); } });
    room.on(E.TrackUnsubscribed, (track) => { track.detach().forEach((el) => el.remove()); });
    room.on(E.ParticipantConnected, () => { if (this.state === "outgoing" || this.state === "connecting") this.connected(); });
    room.on(E.ParticipantDisconnected, () => { if (room.remoteParticipants && room.remoteParticipants.size === 0 && this.state === "connected") this.finish("ended", true); });
    room.on(E.Reconnecting, () => { if (this.state === "connected") this.set("reconnecting"); });
    room.on(E.Reconnected, () => { if (this.state === "reconnecting") this.set("connected"); });
    room.on(E.Disconnected, () => { if (!this.ending && !this.isFinished()) this.fail("connection_failed"); });
    room.on(E.AudioPlaybackStatusChanged, () => { this.audioBlocked = !room.canPlaybackAudio; this.render(); });
    await room.connect(url, token);
    await room.localParticipant.setMicrophoneEnabled(true);
    try { await room.startAudio(); } catch { /* needs a tap; banner shown */ }
    if (room.remoteParticipants && room.remoteParticipants.size > 0) this.connected();
  },
  connected() {
    if (this.state === "connected") return;
    this.startedAt = this.startedAt || Date.now();
    this.set("connected");
    clearInterval(this.tick); this.tick = setInterval(() => { const t = $("#callTimer"); if (t) t.textContent = this.elapsed(); }, 1000);
  },
  async toggleMute() {
    if (!this.room) return;
    this.muted = !this.muted;
    try { await this.room.localParticipant.setMicrophoneEnabled(!this.muted); } catch { this.muted = !this.muted; toast("Couldn't change the microphone"); }
    this.render();
  },
  async end() {
    const id = this.call && this.call.id;
    this.finish(this.state === "outgoing" || this.state === "checking" ? "cancelled" : "ended");
    if (id) try { await api(`/api/calls/${id}/end`, { method: "POST" }); } catch { /* server will time out the call */ }
  },
  fail(reason) {
    const id = this.call && this.call.id;
    if (id) api(`/api/calls/${id}/fail`, { method: "POST", body: { reason } }).catch(() => {});
    this.finish("failed", false, reason);
  },
  finish(state, remote = false, reason = "") {
    this.ending = true; this.stopWatch(); clearInterval(this.tick);
    if (this.room) { try { this.room.disconnect(); } catch { /* ignore */ } this.room = null; }
    document.querySelectorAll("[data-call-audio]").forEach((el) => el.remove());
    if (this.call) this.dismissed.add(this.call.id);
    this.set(state, { reason });
    if (state === "ended" || state === "cancelled") setTimeout(() => { if (this.state === state) this.set(null); }, 2500);
  },
  // While ringing or connected, follow the server's view of the call so either side sees declines/hang-ups.
  watch() {
    this.stopWatch();
    this.poll = setInterval(async () => {
      if (!this.call) return;
      try {
        const { call } = await api(`/api/calls/${this.call.id}`);
        if (call.status === "active" && this.state === "outgoing") this.set("connecting");
        if (["declined", "missed", "cancelled", "failed", "ended"].includes(call.status) && !this.isFinished()) {
          if (this.state === "incoming") { this.dismissed.add(call.id); return this.finish(call.status === "cancelled" ? "missed" : call.status); }
          this.finish(call.status === "failed" ? "failed" : call.status, true, call.end_reason === "permission_denied" ? "connection_failed" : "");
        }
      } catch { /* keep going */ }
    }, 2000);
  },
  stopWatch() { clearInterval(this.poll); this.poll = null; },
  isFinished() { return ["ended", "declined", "missed", "cancelled", "failed", null].includes(this.state); },
  reset() { this.stopWatch(); clearInterval(this.tick); Object.assign(this, { call: null, room: null, muted: false, startedAt: 0, ending: false, reason: "", audioBlocked: false }); },
};
if (typeof window.addEventListener === "function") window.addEventListener("pagehide", () => {
  if (Call.call && Call.state && !Call.isFinished()) fetch(`/api/calls/${Call.call.id}/end`, { method: "POST", keepalive: true, credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
});

// ---------- post detail ----------
async function viewTrip(id, params = {}) {
  let data;
  try { data = await api(`/api/trips/${id}`); } catch (err) { return notFound(err.message); }
  const t = data.trip; tripCache.set(t.id, t);
  view.innerHTML = `
    <p class="mt8"><a href="#/">← Back</a></p>
    <div class="stack mt12">
      ${postCard(t, true)}
      <div id="tripExtras" class="stack"></div>
      <section class="card" id="comments">
        <h3 id="ccount">Comments (${t.comment_count})</h3>
        <div id="commentList" aria-live="polite"></div><div id="cmore" class="mt8"></div>
        ${me ? `<form class="comment-form" id="commentForm"><input id="commentInput" name="body" maxlength="300" placeholder="Ask about pickup, timing or cost…" autocomplete="off" aria-label="Add a comment" required /><button class="btn small">Post</button></form>`
             : `<p class="muted mt12"><a href="#/login">Log in</a> to comment.</p>`}
      </section>
      ${t.is_owner ? ownerPanel(t, data.interests) : ""}
      ${!t.is_owner && me ? `<section class="card ask-card">
        <div class="row between"><div><h3>Questions about this journey?</h3>
          <p class="muted small">${t.my_interest === "accepted" ? "The owner has confirmed you for this trip. Agree the pickup point in chat." : t.my_interest === "pending" ? "Your request is waiting for the owner. Expressing interest doesn't guarantee a seat." : t.my_interest === "declined" ? "The owner declined this request." : "Message the owner privately about pickup, timing or cost before you decide."}</p></div>
          ${data.conversation_id ? `<a class="btn ghost" href="#/inbox/${data.conversation_id}">${ICON.chat} Open chat</a>` : t.my_interest === "declined" || t.status !== "open" ? "" : `<button class="btn ghost" data-act="startChat" data-trip="${t.id}">${ICON.chat} Message ${esc(t.owner.name.split(" ")[0])}</button>`}</div>
      </section>` : ""}
      <section id="rating" class="card" hidden></section>
    </div>`;
  if (t.is_owner) wireOwnerForm(t);
  tripExtras(t);
  loadComments(false).then(() => { if (params.c) { const i = $("#commentInput"); if (i) { i.scrollIntoView({ block: "center" }); i.focus(); } } });
  const form = $("#commentForm");
  if (form) form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("#commentInput"), text = input.value.trim(); if (!text) return;
    const b = form.querySelector("button"); b.disabled = true;
    try {
      const r = await api(`/api/trips/${t.id}/comments`, { method: "POST", body: { body: text } });
      input.value = "";
      const ph = $("#commentList [data-empty]"); if (ph) ph.remove?.();
      $("#commentList").insertAdjacentHTML("beforeend", commentRow(r.comment));
      setCommentCount(r.comment_count);
    } catch (err) { toast(err.message); } finally { b.disabled = false; }
  });
  if (t.status === "completed" && me && (t.is_owner || t.my_interest === "accepted")) loadRating(t);
}

const commentRow = (c) => `<div class="comment">
  <a href="#/u/${c.user.id}">${avatar(c.user, "sm")}</a>
  <div class="grow"><a href="#/u/${c.user.id}"><strong>${esc(c.user.username)}</strong></a> ${esc(c.body)}
    <div class="meta">${esc(ago(c.created_at))}${c.can_delete ? `<button class="link-btn" type="button" data-act="delcomment" data-id="${c.id}">Delete</button>` : ""}</div></div></div>`;

function setCommentCount(n) {
  const h = $("#ccount"); if (h) h.textContent = `Comments (${n})`;
  const m = (location.hash.match(/^#\/trip\/(\d+)/) || [])[1];
  const t = m && tripCache.get(Number(m)); if (t) tripCache.set(t.id, { ...t, comment_count: n });
}
async function loadComments(append) {
  const box = $("#commentList"); if (!box) return;
  const m = (location.hash.match(/^#\/trip\/(\d+)/) || [])[1]; if (!m) return;
  const offset = append ? commentState.offset : 0;
  try {
    const d = await api(`/api/trips/${m}/comments?offset=${offset}`);
    commentState = { offset: d.next_offset };
    const html = d.comments.map(commentRow).join("");
    if (append) box.insertAdjacentHTML("beforeend", html);
    else box.innerHTML = html || `<p class="muted" data-empty>No comments yet.${me ? " Start the conversation." : ""}</p>`;
    $("#cmore").innerHTML = d.has_more ? `<button class="btn ghost small" type="button" data-act="cmore">Show more comments</button>` : "";
    setCommentCount(d.comment_count);
  } catch (err) { box.innerHTML = `<p class="muted">${esc(err.message)}</p>`; }
}

function ownerPanel(t, interests = []) {
  const reqs = interests.map((r) => `
    <div class="request">
      <a href="#/u/${r.user.id}">${avatar(r.user)}</a>
      <div class="grow">
        <a href="#/u/${r.user.id}"><strong>${esc(r.user.name)}</strong></a> <span class="status ${r.status === "accepted" ? "ok" : r.status === "pending" ? "pending" : "no"}">${esc(r.status)}</span>
        <div class="muted small">${esc(r.user.college || "")} ${stars(r.user)} · ${esc(ago(r.created_at))}</div>
        ${r.message ? `<blockquote>${esc(r.message)}</blockquote>` : ""}
      </div>
      <div class="row">
        ${r.status === "pending" ? `<button class="btn small" data-act="accept" data-id="${r.id}">Accept</button><button class="btn ghost small" data-act="decline" data-id="${r.id}">Decline</button>` : ""}
        ${r.status === "accepted" ? `<button class="btn ghost small" data-act="decline" data-id="${r.id}" data-accepted="1">Remove</button>` : ""}
        ${r.conversation_id ? `<a class="btn ghost small" href="#/inbox/${r.conversation_id}">${ICON.chat} Chat</a>` : `<button class="btn ghost small" data-act="startChat" data-trip="${t.id}" data-with="${r.user.id}">${ICON.chat} Message</button>`}
      </div>
    </div>`).join("");
  const locked = ["completed", "cancelled"].includes(t.status);
  return `
    <section class="card"><div class="row between"><h3>Manage this trip</h3><a class="btn ghost small" href="#/edit/${t.id}">Edit post</a></div>
      <form id="manageForm" class="mt12">
        <div class="row2">
          <div class="field"><label for="m_s">Status</label><select id="m_s" name="status" ${locked ? "disabled" : ""}>
            ${["open", "closed", "completed", "cancelled"].map((s) => `<option value="${s}" ${t.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
          ${t.seats_total == null ? "" : `<div class="field"><label for="m_n">Seats available</label><input id="m_n" type="number" name="seats_total" min="${t.confirmed_count}" max="${SEAT_MAX[t.vehicle_type] || 8}" value="${t.seats_total}" ${locked ? "disabled" : ""}/></div>`}
        </div>
        <button class="btn small">Save changes</button>
        <p class="muted small mt8">"Closed" hides the trip from the feed. Marking a trip completed lets travellers rate each other.</p>
      </form>
    </section>
    <section class="card"><h3>Interested people (${interests.length})</h3>
      <div class="mt8">${reqs || `<p class="muted">No requests yet — share your trip!</p>`}</div>
    </section>`;
}
function wireOwnerForm(t) {
  const f = $("#manageForm");
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = {};
    for (const [k, v] of new FormData(f)) body[k] = k === "seats_total" ? Number(v) : v;
    if (f.status.disabled) delete body.status;
    try { await api(`/api/trips/${t.id}`, { method: "PATCH", body }); toast("Trip updated"); route(); } catch (err) { toast(err.message); }
  });
}

async function loadRating(t) {
  try {
    const { people } = await api(`/api/trips/${t.id}/participants`);
    if (!people.length) return;
    const box = $("#rating"); box.hidden = false;
    box.innerHTML = `<h3>Rate your co-travellers</h3>` + people.map((p) => `
      <div class="request">${avatar(p, "sm")}<div class="grow"><strong>${esc(p.name)}</strong></div>
      ${p.rated ? `<span class="status ok">Rated ✓</span>` : `<label class="small" for="st${p.id}">Stars</label><select id="st${p.id}"><option value="5">5 ★</option><option value="4">4 ★</option><option value="3">3 ★</option><option value="2">2 ★</option><option value="1">1 ★</option></select><button class="btn small" data-act="rate" data-trip="${t.id}" data-id="${p.id}">Rate</button>`}</div>`).join("");
  } catch { /* not available */ }
}

// ---------- photos: resize in the browser, upload straight to Cloudinary ----------
async function compressImage(file) {
  if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) throw new Error("Please choose a JPG, PNG or WebP photo");
  if (file.size > 25 * 1024 * 1024) throw new Error("That photo is too large (max 25 MB)");
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { throw new Error("Couldn't read that photo. Try a different one."); }
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
  canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.85));
  if (!blob) throw new Error("Couldn't process that photo");
  return { blob, w, h };
}
async function uploadMany(items, kind, onProgress) {
  const sig = await api("/api/uploads/sign", { method: "POST", body: { kind } });
  const out = [];
  for (const [i, it] of items.entries()) {
    if (onProgress) onProgress(i + 1, items.length);
    const fd = new FormData();
    fd.append("file", it.blob, "photo.jpg");
    if (sig.max_bytes && it.blob.size > sig.max_bytes) throw new Error("That photo is still too large after resizing. Try a smaller one.");
    for (const k of ["api_key", "timestamp", "signature", "folder", "allowed_formats", "transformation"]) if (sig[k] !== undefined) fd.append(k, sig[k]);
    let data = {};
    try { const res = await fetch(sig.upload_url, { method: "POST", body: fd }); data = await res.json().catch(() => ({})); if (!res.ok) data.secure_url = null; }
    catch { throw new Error("Couldn't reach the photo server. Check your connection and try again."); }
    if (!data.secure_url) throw new Error((data.error && data.error.message) || "Photo upload failed. Please try again.");
    out.push({ url: data.secure_url, public_id: data.public_id, width: data.width, height: data.height });
  }
  return out;
}

// ---------- create / edit a post ----------
async function viewComposer(editId) {
  if (!me) return needLogin();
  let t = null;
  if (editId) {
    try { t = (await api(`/api/trips/${editId}`)).trip; } catch (err) { return notFound(err.message); }
    if (!t.is_owner) return notFound("You can only edit your own posts.");
  }
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const pending = [], removed = new Set(); let seq = 0;
  const vehicleOpts = Object.entries(VEHICLES).map(([k, [e, l]]) => `<option value="${k}" ${k === (t ? t.vehicle_type : me.vehicle_type || "car") ? "selected" : ""}>${e} ${l}</option>`).join("");
  const max = config.max_images;
  view.innerHTML = `
    <div class="composer"><h1>${t ? "Edit your post" : "Share your journey"}</h1>
    <form id="postForm" class="card">
      <div class="field"><span class="label">Photos <span class="muted">(optional · up to ${max})</span></span>
        ${config.uploads
          ? `<div class="photo-drop"><input id="photoInput" type="file" accept="image/jpeg,image/png,image/webp" multiple hidden /><button type="button" class="btn ghost" id="pickPhotos">${ICON.camera} Add photos</button><p>Your vehicle, the route, the meeting spot. Photos are resized on your phone before upload.</p></div>`
          : `<p class="notice">Photo uploads aren't switched on for this server yet, so you can post without photos for now.</p>`}
        <div class="thumbs" id="thumbs" aria-live="polite"></div></div>
      <div class="field"><label for="t_x">Caption <span class="muted">(max ${config.caption_max} characters)</span></label>
        <textarea id="t_x" name="description" rows="3" maxlength="${config.caption_max}" placeholder="Heading to campus tomorrow at 8:15. One spare seat — anyone going my way?">${esc(t ? t.description : "")}</textarea><div class="counter" id="cap_n"></div></div>
      <div class="row2">
        <div class="field"><label for="t_o">Starting from</label><input id="t_o" name="origin" required maxlength="80" placeholder="e.g. Gol Bazar" value="${esc(t ? t.origin : "")}" /></div>
        <div class="field"><label for="t_d">Going to</label><input id="t_d" name="destination" required maxlength="80" placeholder="e.g. IIT Kharagpur" value="${esc(t ? t.destination : "")}" /></div>
      </div>
      <p class="muted small route-hint">Use a landmark or area — please don't enter your exact home address.</p>
      <div class="row2">
        <div class="field"><label for="t_dt">Date</label><input id="t_dt" type="date" name="depart_date" min="${t && t.depart_date < today ? t.depart_date : today}" value="${esc(t ? t.depart_date : today)}" required /></div>
        <div class="field"><label for="t_tm">Departure time</label><input id="t_tm" type="time" name="depart_time" required value="${esc(t ? t.depart_time : "")}" /></div>
      </div>
      <div class="row2">
        <div class="field"><label for="t_v">Vehicle</label><select id="t_v" name="vehicle_type" ${t ? "disabled" : ""}>${vehicleOpts}</select></div>
        <div class="field"><label for="t_m">Make / model <span class="muted">(optional)</span></label><input id="t_m" name="vehicle_model" maxlength="60" placeholder="e.g. Pulsar 150" value="${esc(t ? t.vehicle_model : "")}" /></div>
      </div>
      <div class="row2">
        <div class="field" id="seatField"><label for="t_s">Seats available</label><input id="t_s" type="number" name="seats_total" min="${t ? t.confirmed_count : 1}" value="${t && t.seats_total != null ? t.seats_total : 1}" /></div>
        <div class="field"><label for="t_c">Shared cost per person (₹, optional)</label><input id="t_c" type="number" name="contribution_inr" min="0" max="5000" placeholder="e.g. 40" value="${t && t.contribution_inr != null ? t.contribution_inr : ""}" /></div>
      </div>
      <div class="field"><span class="label">Repeats on <span class="muted">(leave empty for a one-time trip)</span></span>
        <div class="checks">${DAYS.map((d) => `<label class="check"><input type="checkbox" name="recurring" value="${d}" ${t && t.recurring.includes(d) ? "checked" : ""} /> ${d}</label>`).join("")}</div></div>
      ${!t && me.gender === "female" ? `<div class="field"><label class="check"><input type="checkbox" name="women_only" /> Women-only trip</label></div>` : ""}
      <p class="form-error" id="formError" role="alert"></p>
      <div class="row">
        <button class="btn" id="publishBtn">${t ? "Save changes" : "Publish"}</button>
        <a class="btn ghost" href="${t ? `#/trip/${t.id}` : "#/"}">Cancel</a>
        <span class="spacer"></span>
        ${t ? `<button type="button" class="btn danger small" data-act="delete" data-id="${t.id}">Delete post</button>` : ""}
      </div>
      <p class="upload-status" id="upStatus" role="status"></p>
      <p class="muted small mt12">SaathRide is for sharing journeys and costs, not for running a taxi service.</p>
    </form></div>`;

  const vSel = $("#t_v"), seat = $("#seatField");
  const syncSeats = () => { const m = SEAT_MAX[vSel.value]; seat.hidden = !m; const inp = $("#t_s"); inp.disabled = !m; if (m) { inp.max = m; if (Number(inp.value) > m) inp.value = m; } };
  vSel.addEventListener("change", syncSeats); syncSeats();
  const cap = $("#t_x"), capN = $("#cap_n");
  const countCap = () => { capN.textContent = `${cap.value.length}/${config.caption_max}`; };
  cap.addEventListener("input", countCap); countCap();

  const kept = () => (t ? t.images.filter((im) => !removed.has(im.id)) : []);
  const total = () => kept().length + pending.length;
  const renderThumbs = () => {
    const all = [...kept().map((im) => ({ key: `old:${im.id}`, src: cl(im.url, 240, true) })), ...pending.map((p) => ({ key: `new:${p.id}`, src: p.url }))];
    $("#thumbs").innerHTML = all.map((x, i) => `<div class="thumb"><img src="${esc(x.src)}" alt="Photo ${i + 1}" />${i === 0 ? '<span class="first">Cover</span>' : ""}<button type="button" data-rm="${esc(x.key)}" aria-label="Remove photo ${i + 1}">${ICON.x}</button></div>`).join("");
  };
  renderThumbs();
  $("#thumbs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-rm]"); if (!b) return;
    const [kind, rid] = b.dataset.rm.split(":");
    if (kind === "old") removed.add(Number(rid));
    else { const i = pending.findIndex((p) => p.id === Number(rid)); if (i >= 0) { URL.revokeObjectURL(pending[i].url); pending.splice(i, 1); } }
    renderThumbs();
  });
  if (config.uploads) {
    const input = $("#photoInput");
    $("#pickPhotos").addEventListener("click", () => input.click());
    input.addEventListener("change", async () => {
      const files = [...input.files]; input.value = "";
      for (const f of files) {
        if (total() >= max) { toast(`You can add up to ${max} photos`); break; }
        try { const c = await compressImage(f); pending.push({ id: ++seq, blob: c.blob, url: URL.createObjectURL(c.blob) }); } catch (err) { toast(err.message); }
      }
      renderThumbs();
    });
  }

  wirePlacePickers(["t_o", "t_d"]);
  $("#postForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#publishBtn"), errBox = $("#formError"), status = $("#upStatus");
    errBox.textContent = ""; btn.disabled = true;
    try {
      const fd = new FormData(e.target);
      let uploaded = [];
      if (pending.length) uploaded = await uploadMany(pending, "post", (i, n) => { status.textContent = `Uploading photo ${i} of ${n}…`; });
      status.textContent = t ? "Saving…" : "Publishing…";
      const body = {
        origin: fd.get("origin"), destination: fd.get("destination"), depart_date: fd.get("depart_date"), depart_time: fd.get("depart_time"),
        vehicle_model: fd.get("vehicle_model"), description: fd.get("description"), recurring: fd.getAll("recurring"),
        contribution_inr: fd.get("contribution_inr") === "" ? null : Number(fd.get("contribution_inr")),
      };
      if (!$("#t_s").disabled) body.seats_total = Number($("#t_s").value);
      if (pickedPoint("t_o")) body.origin_point = pickedPoint("t_o");
      if (pickedPoint("t_d")) body.dest_point = pickedPoint("t_d");
      if (t) { body.add_images = uploaded; body.remove_image_ids = [...removed]; }
      else { body.vehicle_type = vSel.value; body.women_only = !!fd.get("women_only"); body.images = uploaded; if (body.contribution_inr === null) delete body.contribution_inr; if ($("#t_s").disabled) delete body.seats_total; }
      const { trip } = await api(t ? `/api/trips/${t.id}` : "/api/trips", { method: t ? "PATCH" : "POST", body });
      pending.forEach((p) => URL.revokeObjectURL(p.url));
      toast(t ? "Post updated ✓" : "Posted 🎉");
      location.hash = `#/trip/${trip.id}`;
    } catch (err) { errBox.textContent = err.message; toast(err.message); btn.disabled = false; status.textContent = ""; }
  });
}

// ---------- profiles ----------
async function viewProfile(key, params = {}) {
  if (!me) return needLogin();
  let data;
  try { data = await api(`/api/users/${encodeURIComponent(key)}`); } catch (err) { return notFound(err.message); }
  const u = data.user, own = me.id === u.id;
  const tab = own && params.tab === "saved" ? "saved" : "posts";
  let list = data.posts;
  if (tab === "saved") { try { list = (await api("/api/me/trips")).saved; } catch (err) { list = []; } }
  const base = own ? "#/profile" : `#/u/${u.id}`;
  const chips = (arr) => arr.length ? `<div class="chips">${arr.map((x) => `<span class="chip">${esc(VEHICLES[x] ? VEHICLES[x][0] + " " + VEHICLES[x][1] : x)}</span>`).join("")}</div>` : "";
  const hasAbout = u.travel_areas.length || u.interests.length || u.travel_modes.length;
  view.innerHTML = `
    <div class="card">
      <div class="profile-head">${avatar(u, "lg")}
        <div class="grow"><h1>${esc(u.name)}</h1><p class="handle">@${esc(u.username)}</p>
          ${u.college ? `<p class="muted">${esc(u.college)}</p>` : ""}</div>
        ${own ? `<a class="btn ghost" href="#/me">Edit profile</a>` : `<div class="row profile-actions"><button class="btn ghost small" data-act="${u.blocked_by_me ? "unblockUser" : "blockUser"}" data-id="${u.id}">${ICON.shield} ${u.blocked_by_me ? "Unblock" : "Block"}</button><button class="btn ghost small" data-act="reportUser" data-id="${u.id}">${ICON.more} Report</button></div>`}
      </div>
      ${u.bio ? `<p class="mt16 bio">${esc(u.bio)}</p>` : ""}
      <div class="profile-stats">
        <div class="stat"><b>${data.trips_posted}</b><span>post${data.trips_posted === 1 ? "" : "s"}</span></div>
        ${u.rating ? `<div class="stat"><b>★ ${u.rating}</b><span>${plural(u.rating_count, "rating")}</span></div>` : ""}
        <div class="stat"><b>${esc(new Date(String(u.member_since).replace(" ", "T")).toLocaleDateString("en-IN", { month: "short", year: "numeric" }))}</b><span>joined</span></div>
      </div>
      <div class="chips">${eduChip(u)}</div>
      ${hasAbout ? `${u.travel_areas.length ? `<div class="kv"><h4>Travel areas</h4>${chips(u.travel_areas)}</div>` : ""}
        ${u.interests.length ? `<div class="kv"><h4>Interests</h4>${chips(u.interests)}</div>` : ""}
        ${u.travel_modes.length ? `<div class="kv"><h4>Usually travels by</h4>${chips(u.travel_modes)}</div>` : ""}` : ""}
    </div>
    ${own ? `<div class="tabs" role="tablist"><a href="${base}" role="tab" aria-selected="${tab === "posts"}">Posts</a><a href="${base}?tab=saved" role="tab" aria-selected="${tab === "saved"}">Saved</a></div>` : `<h2 class="sec-title">Posts</h2>`}
    ${list.length ? `<div class="profile-grid">${list.map(tile).join("")}</div>`
      : `<div class="card empty">${tab === "saved" ? "Posts you save show up here — only you can see this list." : own ? `You haven't shared a journey yet.<p class="mt12"><a class="btn" href="#/post">Share your first journey</a></p>` : "No posts yet."}</div>`}`;
}

function viewEditProfile() {
  if (!me) return needLogin();
  const modes = Object.entries(VEHICLES).map(([k, [e, l]]) => `<label class="check"><input type="checkbox" name="travel_modes" value="${k}" ${me.travel_modes.includes(k) ? "checked" : ""}/> ${e} ${l}</label>`).join("");
  const sw = Array.from({ length: AVATAR_COUNT }, (_, i) => `<label><input type="radio" name="avatar_color" value="${i}" ${me.avatar_color === i ? "checked" : ""} aria-label="Avatar colour ${i + 1}"/><span class="avatar c${i}" aria-hidden="true">${esc(initials(me.name))}</span></label>`).join("");
  const on = (v) => (v ? "checked" : "");
  view.innerHTML = `
    <div class="row between"><h1 class="page-title">Edit profile</h1><a href="#/profile">View profile</a></div>
    <form id="profileForm" class="card">
      <div class="field"><span class="label">Profile photo</span>
        <div class="avatar-edit"><span id="avPreview">${avatar(me, "lg")}</span>
          ${config.uploads ? `<div class="row"><input id="avInput" type="file" accept="image/jpeg,image/png,image/webp" hidden /><button type="button" class="btn ghost small" id="avPick">${ICON.camera} Change photo</button>${me.avatar_url ? `<button type="button" class="btn ghost small" id="avRemove">Remove</button>` : ""}</div>`
            : `<p class="muted small">Photo uploads aren't switched on yet — pick a colour for your initials instead.</p>`}</div>
        <div class="swatches mt8" role="radiogroup" aria-label="Avatar colour">${sw}</div></div>
      <div class="row2">
        <div class="field"><label for="p_n">Display name</label><input id="p_n" name="name" value="${esc(me.name)}" required minlength="2" maxlength="60" /></div>
        <div class="field"><label for="p_u">Username</label><input id="p_u" name="username" value="${esc(me.username)}" required minlength="3" maxlength="20" pattern="[A-Za-z0-9_.]{3,20}" autocapitalize="none" autocomplete="off" /></div>
      </div>
      <div class="field"><label for="p_c">College / university / workplace</label><input id="p_c" name="college" value="${esc(me.college)}" maxlength="100" /></div>
      <div class="field"><label for="p_b">Short bio</label><textarea id="p_b" name="bio" rows="3" maxlength="300">${esc(me.bio)}</textarea></div>
      <div class="field"><label for="p_a">General travel areas <span class="muted">(comma separated — areas, not addresses)</span></label><input id="p_a" name="travel_areas" value="${esc(me.travel_areas.join(", "))}" placeholder="Gol Bazar, Salt Lake" /></div>
      <div class="field"><label for="p_i">Interests &amp; hobbies <span class="muted">(comma separated)</span></label><input id="p_i" name="interests" value="${esc(me.interests.join(", "))}" placeholder="chess, football, podcasts" /></div>
      <div class="field"><span class="label">Preferred travel modes</span><div class="checks">${modes}</div></div>

      <h2 class="sec-title">Privacy</h2>
      <p class="muted small">Choose what other members can see on your profile and posts. You always see everything.</p>
      <div class="checks stacked mt8">
        <label class="check"><input type="checkbox" name="show_college" ${on(me.show_college)} /> Show my college / workplace</label>
        <label class="check"><input type="checkbox" name="show_travel_areas" ${on(me.show_travel_areas)} /> Show my travel areas</label>
        <label class="check"><input type="checkbox" name="show_interests" ${on(me.show_interests)} /> Show my interests</label>
      </div>
      <h2 class="sec-title">Private details</h2>
      <p class="muted small">Only you can see these. They're never shown on your profile.</p>
      <div class="row2 mt12">
        <div class="field"><label for="p_g">Gender</label><select id="p_g" name="gender">${[["unspecified", "Prefer not to say"], ["female", "Female"], ["male", "Male"], ["other", "Other"]].map(([v, l]) => `<option value="${v}" ${me.gender === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        <div class="field"><label for="p_p">Phone</label><input id="p_p" name="phone" value="${esc(me.phone)}" inputmode="tel" /></div>
      </div>
      <p class="muted small">Gender is only used to allow or restrict women-only trips. Your phone number is never shown to other members — not even during voice calls.</p>
      <h2 class="sec-title">Notifications</h2>
      <div id="prefsBox" class="muted small">Loading…</div>
      <h2 class="sec-title">Blocked members</h2>
      <div id="blockedList" class="muted small">Loading…</div>
      <p class="form-error" id="formError" role="alert"></p>
      <div class="row mt16"><button class="btn" id="saveProfile">Save profile</button><button type="button" class="btn ghost" id="logoutBtn">Log out</button></div>
      <p class="upload-status" id="upStatus" role="status"></p>
    </form>`;

  let newAvatar = null, removeAvatar = false;
  if (config.uploads) {
    const input = $("#avInput");
    $("#avPick").addEventListener("click", () => input.click());
    input.addEventListener("change", async () => {
      const f = input.files[0]; input.value = ""; if (!f) return;
      try { const c = await compressImage(f); newAvatar = c; removeAvatar = false; $("#avPreview").innerHTML = `<img class="avatar lg" src="${esc(URL.createObjectURL(c.blob))}" alt="New profile photo preview" />`; }
      catch (err) { toast(err.message); }
    });
    const rm = $("#avRemove");
    if (rm) rm.addEventListener("click", () => { removeAvatar = true; newAvatar = null; $("#avPreview").innerHTML = avatar({ name: me.name, avatar_color: me.avatar_color }, "lg"); });
  }
  $("#profileForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#saveProfile"), errBox = $("#formError"), status = $("#upStatus");
    errBox.textContent = ""; btn.disabled = true;
    const fd = new FormData(e.target);
    try {
      const body = { name: fd.get("name"), username: fd.get("username"), college: fd.get("college"), bio: fd.get("bio"), travel_areas: fd.get("travel_areas"), interests: fd.get("interests"),
        travel_modes: fd.getAll("travel_modes"), avatar_color: Number(fd.get("avatar_color")), gender: fd.get("gender"), phone: fd.get("phone"),
        show_college: !!fd.get("show_college"), show_travel_areas: !!fd.get("show_travel_areas"), show_interests: !!fd.get("show_interests") };
      if (newAvatar) { status.textContent = "Uploading photo…"; body.avatar = (await uploadMany([newAvatar], "avatar"))[0]; }
      else if (removeAvatar) body.avatar = null;
      me = (await api("/api/me", { method: "PATCH", body })).user; status.textContent = "";
      toast("Profile saved ✓"); renderNav(); viewEditProfile();
    } catch (err) { errBox.textContent = err.message; toast(err.message); status.textContent = ""; btn.disabled = false; }
  });
  loadSettingsExtras();
  api("/api/blocks").then((d) => {
    $("#blockedList").innerHTML = d.blocked.length ? d.blocked.map((u) => `<div class="request">${avatar(u, "sm")}<div class="grow"><strong>${esc(u.name)}</strong> <span class="muted">@${esc(u.username)}</span></div><button type="button" class="btn ghost small" data-act="unblockUser" data-id="${u.id}">Unblock</button></div>`).join("")
      : "You haven't blocked anyone. Blocked members can't message, call or send you requests, and you won't see their posts.";
  }).catch(() => { $("#blockedList").textContent = "Couldn't load your blocked list."; });
  $("#logoutBtn").addEventListener("click", async () => { await api("/api/auth/logout", { method: "POST" }).catch(() => {}); me = null; clearInterval(syncTimer); badges.messages = badges.notifications = 0; Call.set(null); renderNav(); toast("Logged out"); location.hash = "#/"; });
}

// ---------- auth ----------
function needLogin() { sessionStorage.setItem("returnTo", location.hash); location.hash = "#/login"; }
function afterAuth() { const r = sessionStorage.getItem("returnTo"); sessionStorage.removeItem("returnTo"); location.hash = r && r !== "#/login" && r !== "#/signup" ? r : "#/"; }

function viewLogin() {
  view.innerHTML = `
    <h1 class="page-title">Log in</h1>
    <form id="loginForm" class="card narrow">
      <div class="field"><label for="l_e">Email</label><input id="l_e" type="email" name="email" autocomplete="email" required /></div>
      <div class="field"><label for="l_p">Password</label><input id="l_p" type="password" name="password" autocomplete="current-password" required /></div>
      <button class="btn">Log in</button>
      <p class="muted mt12">New here? <a href="#/signup">Create an account</a></p>
    </form>`;
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try { me = (await api("/api/auth/login", { method: "POST", body: Object.fromEntries(new FormData(e.target)) })).user; renderNav(); startSync(); toast(`Welcome back, ${me.name.split(" ")[0]}!`); afterAuth(); }
    catch (err) { toast(err.message); }
  });
}

function viewSignup() {
  view.innerHTML = `
    <h1 class="page-title">Join SaathRide</h1>
    <form id="signupForm" class="card narrow">
      <div class="field"><label for="s_n">Name</label><input id="s_n" name="name" required minlength="2" maxlength="60" autocomplete="name" /></div>
      <div class="field"><label for="s_e">Email</label><input id="s_e" type="email" name="email" required autocomplete="email" />
        <p class="muted small mt8">A college email adds a "College email" label to your profile. SaathRide doesn't verify it yet.</p></div>
      <div class="field"><label for="s_p">Password <span class="muted">(at least 8 characters)</span></label><input id="s_p" type="password" name="password" minlength="8" maxlength="72" required autocomplete="new-password" /></div>
      <div class="field"><label for="s_c">College / university / workplace <span class="muted">(optional)</span></label><input id="s_c" name="college" maxlength="100" /></div>
      <div class="field"><label for="s_g">Gender <span class="muted">(private — used only for women-only trips)</span></label>
        <select id="s_g" name="gender"><option value="unspecified">Prefer not to say</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></select></div>
      <button class="btn">Create account</button>
      <p class="muted small mt12">Already a member? <a href="#/login">Log in</a></p>
    </form>`;
  $("#signupForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try { me = (await api("/api/auth/signup", { method: "POST", body: Object.fromEntries(new FormData(e.target)) })).user; renderNav(); startSync(); toast("Welcome to SaathRide!"); location.hash = "#/me"; }
    catch (err) { toast(err.message); }
  });
}

// ---------- router ----------
function route() {
  clearInterval(poll); clearInterval(chat.timer); chat.id = null;
  view.className = "";
  const { path, params } = parseHash();
  renderNav();
  let m;
  if (path === "/") viewHome(params);
  else if (path === "/explore") viewExplore(params);
  else if (path === "/inbox") viewInbox();
  else if ((m = path.match(/^\/inbox\/(\d+)$/))) viewInbox(Number(m[1]));
  else if (path === "/notifications") viewNotifications();
  else if (path === "/community") viewCommunity(params);
  else if (path === "/admin") viewAdmin();
  else if ((m = path.match(/^\/trip\/(\d+)$/))) viewTrip(m[1], params);
  else if ((m = path.match(/^\/edit\/(\d+)$/))) viewComposer(m[1]);
  else if (path === "/profile") { if (!me) needLogin(); else viewProfile(me.id, params); }
  else if ((m = path.match(/^\/u\/(@?[\w.]+)$/))) viewProfile(m[1], params);
  else if (path === "/me") viewEditProfile();
  else if (path === "/post") viewComposer(null);
  else if (path === "/mine") location.hash = "#/profile";
  else if (path === "/login") viewLogin();
  else if (path === "/signup") viewSignup();
  else viewHome({});
  renderAiFab();
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);

(async function init() {
  try { config = { ...config, ...(await api("/api/config")) }; } catch { /* keep defaults */ }
  try { me = (await api("/api/me")).user; } catch { me = null; }
  route();
  startSync();
})();
