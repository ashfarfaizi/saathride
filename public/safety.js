// SaathRide — safety & social screens: Safety hub (safety mode, SOS, check-ins, Saath Circle, my reports),
// the trusted-contact share page, QR boarding, the women's section, Journey Memories, and the safety team's
// case queue. Loaded after app.js and discover.js and uses their helpers (api, esc, dialog, MapKit, …).

Object.assign(ICON, {
  women: I('<circle cx="12" cy="8" r="5"/><line x1="12" y1="13" x2="12" y2="22"/><line x1="9" y1="18" x2="15" y2="18"/>'),
  sos: I('<circle cx="12" cy="12" r="10"/><line x1="12" y1="7" x2="12" y2="13"/><circle cx="12" cy="16.5" r="0.6"/>'),
  phone: I('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>'),
  qr: I('<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>'),
  camera2: I('<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>'),
  check: I('<polyline points="20 6 9 17 4 12"/>'),
  users: I('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>'),
});

const safe = { session: null, loaded: false, watchId: null, lastSent: 0, timer: null, shareTimer: null };
const EVENT_LABEL = {
  started: "Safety mode started", checkin_departure: "Checked in — set off", checkin_midway: "Checked in — halfway, OK", checkin_ok: "Checked in — OK",
  arrived: "Arrived safely", missed_prompt: "Missed a check-in — asked to respond", missed_escalated: "No response — Saath Circle told",
  missed_reminder: "No response — reminded again", extended: "Arrival time extended", boarded: "Confirmed boarding the expected vehicle",
  sos: "SOS pressed", ended_by_user: "Safety mode ended", auto_ended: "Ended automatically", location_on: "Live location on", location_off: "Live location off",
};
const tclock = (v) => (v ? new Date(v).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }) : "");
const minsFrom = (v) => Math.round((new Date(v).getTime() - Date.now()) / 60000);
const DUE_LABEL = { departure: "I've set off", midway: "Halfway — I'm OK", arrival: "I've arrived" };

// ---------------- router ----------------
window.extraRoute = (path, params) => {
  let m;
  if (path === "/settings") {
    if (params.email === "confirmed") toast("Email confirmed ✓ — you'll now get email alerts");
    else if (params.email === "invalid") toast("That confirmation link has expired. Send a new one from Settings.");
    location.replace("#/me"); return true;
  }
  if (path === "/safety") { viewSafety(params); return true; }
  if (path === "/safety/report") { viewSafetyReport(params); return true; }
  if ((m = path.match(/^\/s\/([\w-]{10,64})$/))) { viewShare(m[1]); return true; }
  if ((m = path.match(/^\/board\/(\d+)\/([A-Za-z0-9]{4,12})$/))) { viewBoard(Number(m[1]), m[2]); return true; }
  if (path === "/women") { viewWomen(params); return true; }
  if ((m = path.match(/^\/memory\/(\d+)$/))) { viewMemory(Number(m[1])); return true; }
  if (path === "/admin/cases") { viewCases(params); return true; }
  if ((m = path.match(/^\/admin\/cases\/(\d+)$/))) { viewCase(Number(m[1])); return true; }
  return false;
};
window.afterRoute = (path) => {
  clearInterval(safe.shareTimer);
  if (path === "/" && me) {
    const strip = `<div class="quick-links">
      <a class="req-chip" href="#/safety">${ICON.shield} Safety mode & Saath Circle</a>
      ${me.gender === "female" ? `<a class="req-chip" href="#/women">${ICON.women} Women's space</a>` : ""}
      <button type="button" class="req-chip" data-act="openAi" data-q="">${ICON.spark} Tell Saath AI your plan</button></div>`;
    setTimeout(() => { if (location.hash === "" || location.hash === "#/" || location.hash.startsWith("#/?")) view.insertAdjacentHTML("afterbegin", strip); }, 0);
  }
  renderSafetyBar();
};

// ---------------- active session: banner, live location, reminders ----------------
async function refreshSession() {
  if (!me) { safe.session = null; return null; }
  try { safe.session = (await api("/api/safety/active")).session; } catch { /* keep last */ }
  safe.loaded = true;
  manageLocation();
  renderSafetyBar();
  return safe.session;
}
function renderSafetyBar() {
  let bar = document.querySelector("#safetyBar");
  const s = safe.session;
  if (!s || location.hash.startsWith("#/safety") || location.hash.startsWith("#/s/")) { if (bar) bar.hidden = true; return; }
  if (!bar) { bar = document.createElement("div"); bar.id = "safetyBar"; bar.className = "safety-bar"; bar.setAttribute("role", "status"); document.body.appendChild(bar); }
  const due = s.due_at && minsFrom(s.due_at) <= 0;
  bar.hidden = false;
  bar.className = `safety-bar ${s.missed_stage || s.overdue ? "alert" : due ? "due" : ""}`;
  bar.innerHTML = `<a href="#/safety">${ICON.shield}<span><b>${s.missed_stage ? "Are you OK? Tap to check in" : due ? "Check-in due" : "Safety mode on"}</b>
      <small>${esc(s.label)} · arriving ~${tclock(s.expected_arrival)}${s.share_location ? " · sharing location" : ""}</small></span></a>
    <button type="button" class="sos-mini" data-act="sos" aria-label="SOS">SOS</button>`;
}
function manageLocation() {
  const s = safe.session, want = s && s.share_location && navigator.geolocation;
  if (!want) { if (safe.watchId != null) { navigator.geolocation.clearWatch(safe.watchId); safe.watchId = null; } return; }
  if (safe.watchId != null) return;
  safe.watchId = navigator.geolocation.watchPosition((pos) => {
    if (!safe.session || Date.now() - safe.lastSent < 20000) return;
    safe.lastSent = Date.now();
    api(`/api/safety/sessions/${safe.session.id}/location`, { method: "POST", body: { lat: pos.coords.latitude, lng: pos.coords.longitude } }).catch(() => {});
  }, () => { /* permission denied or unavailable: check-ins still work */ }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 });
}
// Keep the session fresh while the app is open (check-in prompts also arrive as notifications and emails).
safe.timer = setInterval(() => { if (me) refreshSession(); }, 30000);
setTimeout(() => { if (me) refreshSession(); }, 1200);

function currentPosition(timeout = 6000) {
  return new Promise((res) => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude }), () => res(null), { enableHighAccuracy: true, timeout, maximumAge: 30000 });
  });
}
async function sendSos() {
  const d = $("#dlg");
  d.innerHTML = `<div class="dlg-form sos-dlg"><h3>${ICON.sos} Emergency</h3>
    <p>If you're in danger, <b>call 112 now</b> — it's free and works from any phone.</p>
    <a class="btn danger big" href="tel:112">${ICON.phone} Call 112</a>
    <p class="muted small mt12">SOS also alerts your Saath Circle by email with your live location link. SaathRide isn't an emergency service.</p>
    <div class="dlg-actions"><button type="button" class="btn ghost" data-close>Close</button><button type="button" class="btn" id="sosSend">Alert my Saath Circle</button></div></div>`;
  d.querySelector("[data-close]").onclick = () => d.close();
  d.querySelector("#sosSend").onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = "Sending…";
    const pos = await currentPosition(5000);
    try {
      const r = await api("/api/safety/sos", { method: "POST", body: pos || {} });
      safe.session = r.session; manageLocation();
      e.target.textContent = r.contacts_alerted ? `Alerted ${plural(r.contacts_alerted, "contact")} ✓` : "No accepted contacts to alert";
      if (!r.contacts_alerted) d.querySelector(".sos-dlg").insertAdjacentHTML("beforeend", `<p class="notice mt8">Nobody in your Saath Circle has accepted yet, so no one was emailed. Call 112 if you need help.</p>`);
      if (location.hash.startsWith("#/safety")) viewSafety({});
    } catch (err) { toast(err.message); e.target.disabled = false; e.target.textContent = "Alert my Saath Circle"; }
  };
  d.showModal();
}

// ---------------- Safety hub ----------------
async function viewSafety(params) {
  if (!me) return needLogin();
  const tab = ["circle", "reports"].includes(params.tab) ? params.tab : "now";
  view.innerHTML = `<div class="row between"><h1 class="page-title">Safety</h1><button type="button" class="btn danger" data-act="sos">${ICON.sos} SOS</button></div>
    <div class="tabs" role="tablist"><a href="#/safety" role="tab" aria-selected="${tab === "now"}">Safety mode</a><a href="#/safety?tab=circle" role="tab" aria-selected="${tab === "circle"}">Saath Circle</a><a href="#/safety?tab=reports" role="tab" aria-selected="${tab === "reports"}">My reports</a></div>
    <div id="safetyBody"><div class="skeleton"></div></div>`;
  if (tab === "circle") return circleTab();
  if (tab === "reports") return reportsTab();
  return safetyNowTab(params);
}

async function safetyNowTab(params) {
  const box = $("#safetyBody"), seq = routeSeq;
  let data, circle;
  try { [data, circle] = await Promise.all([api("/api/safety/active"), api("/api/circle")]); } catch (err) { box.innerHTML = `<div class="card empty">${esc(err.message)}</div>`; return; }
  if (stale(seq)) return;
  safe.session = data.session; manageLocation();
  if (data.session) return renderActive(box, data.session);
  let trip = null;
  if (params.trip) { try { trip = (await api(`/api/trips/${Number(params.trip)}`)).trip; } catch { trip = null; } }
  const accepted = circle.contacts.filter((c) => c.status === "active");
  const pending = circle.contacts.filter((c) => c.status === "pending");
  box.innerHTML = `
    <section class="card">
      <h2>Start safety mode</h2>
      <p class="muted">Share this journey with people you trust. They get a private link with your check-ins${navigator.geolocation ? " and live location" : ""} until you arrive. Nothing is shared until you start.</p>
      <form id="startForm" class="mt12">
        <div class="field"><label for="sf_label">What's the journey?</label><input id="sf_label" maxlength="80" value="${esc(trip ? `${trip.origin} → ${trip.destination}` : "")}" placeholder="e.g. Office → Hostel" required /></div>
        ${trip ? `<p class="muted small">Linked to your journey with ${esc(trip.owner.name)} (${esc(VEHICLES[trip.vehicle_type] ? VEHICLES[trip.vehicle_type][1] : trip.vehicle_type)}${trip.vehicle_model ? `, ${esc(trip.vehicle_model)}` : ""}).</p>` : ""}
        <div class="field"><label for="sf_eta">How long should it take?</label><select id="sf_eta">${[[15, "15 min"], [30, "30 min"], [45, "45 min"], [60, "1 hour"], [90, "1½ hours"], [120, "2 hours"], [180, "3 hours"], [240, "4 hours"], [360, "6 hours"]].map(([v, l]) => `<option value="${v}" ${v === 45 ? "selected" : ""}>${l}</option>`).join("")}</select>
          <p class="muted small">We'll ask you to check in when you set off, halfway (longer trips) and when you arrive.</p></div>
        <fieldset class="field"><legend>Who can follow it?</legend>
          ${circle.contacts.length ? circle.contacts.map((c) => `<label class="check"><input type="checkbox" name="contact" value="${c.id}" ${c.status === "active" ? "checked" : "disabled"}/> ${esc(c.name)}${c.relation ? ` <span class="muted">(${esc(c.relation)})</span>` : ""} ${c.status === "pending" ? `<span class="status pending">hasn't accepted yet</span>` : c.status === "declined" ? `<span class="status no">declined</span>` : ""}</label>`).join("")
            : `<p class="notice">Your Saath Circle is empty. <a href="#/safety?tab=circle">Add a trusted contact</a> — or start with “Only remind me”.</p>`}
          ${pending.length ? `<p class="muted small">Contacts get updates only after they accept your invitation email.</p>` : ""}
        </fieldset>
        <fieldset class="field"><legend>If I miss a check-in</legend>
          <label class="check"><input type="radio" name="esc" value="contacts" ${accepted.length ? "checked" : "disabled"}/> Ask me first, then tell my Saath Circle if I don't answer in 10 minutes</label>
          <label class="check"><input type="radio" name="esc" value="self" ${accepted.length ? "" : "checked"}/> Only remind me</label>
          <p class="muted small">A missed check-in isn't treated as an emergency — we always ask you first, and messages to your circle say so.</p></fieldset>
        ${navigator.geolocation ? `<label class="check"><input type="checkbox" id="sf_loc" checked/> Share my live location with them while safety mode is on</label>` : ""}
        <div class="row mt12"><button class="btn">${ICON.shield} Start safety mode</button></div>
      </form>
    </section>
    ${safetyTips()}
    ${data.recent.length ? `<section class="card"><h3>Recent</h3>${data.recent.map((r) => `<div class="request"><div class="grow"><b>${esc(r.label)}</b><div class="muted small">${esc(fmtDate(r.started_at.slice(0, 10)))} · ${r.status === "arrived" ? "Arrived safely ✓" : "Ended"}</div></div></div>`).join("")}</section>` : ""}`;
  $("#startForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button.btn"); btn.disabled = true;
    const body = { label: $("#sf_label").value.trim(), eta_minutes: Number($("#sf_eta").value), contact_ids: [...e.target.querySelectorAll("input[name=contact]:checked")].map((x) => Number(x.value)),
      escalation: (e.target.querySelector("input[name=esc]:checked") || {}).value || "self", share_location: !!($("#sf_loc") && $("#sf_loc").checked), ...(trip ? { trip_id: trip.id } : {}) };
    try {
      const r = await api("/api/safety/sessions", { method: "POST", body });
      safe.session = r.session; manageLocation();
      toast(r.contacts_emailed ? `Safety mode on — ${plural(r.contacts_emailed, "contact")} notified` : "Safety mode on");
      renderActive(box, r.session);
    } catch (err) { toast(err.message); btn.disabled = false; }
  });
}
function safetyTips() {
  return `<section class="card tips"><h3>Travel safely</h3><ul>
    <li>Meet at public landmarks — never share your exact home address in posts or chats.</li>
    <li>Check the vehicle and the person match the post. On a confirmed journey, scan the owner's <b>boarding QR</b> before you get in.</li>
    <li>Keep chats inside SaathRide until you've travelled together.</li>
    <li>Trust your instincts — you can cancel at any time. Profiles are self-declared and not verified.</li>
    <li>Emergency: <a href="tel:112"><b>112</b></a> (all emergencies) · Women helpline <a href="tel:181"><b>181</b></a></li></ul>
    <p class="mt8"><a class="btn ghost small" href="#/safety/report">${ICON.shield} Report a safety concern</a></p></section>`;
}
function renderActive(box, s) {
  safe.session = s; renderSafetyBar();
  const dueNow = s.due_at && minsFrom(s.due_at) <= 0;
  const dueText = s.due_kind ? (dueNow ? "due now" : `due ~${tclock(s.due_at)}`) : "";
  box.innerHTML = `
    ${s.missed_stage || s.overdue ? `<section class="card alert-card"><h2>Are you OK?</h2><p>${s.overdue ? "You haven't checked in as arrived." : "You missed a check-in."} ${s.missed_stage === 2 ? (s.escalation === "contacts" ? "We've let your Saath Circle know — check in so they know you're safe." : "") : s.escalation === "contacts" ? "If you don't respond soon we'll let your Saath Circle know." : ""}</p>
      <div class="row mt8"><button type="button" class="btn big" data-act="checkin" data-stage="ok">${ICON.check} I'm OK</button><button type="button" class="btn ghost" data-act="checkin" data-stage="arrival">I've arrived</button></div></section>` : ""}
    <section class="card safety-live">
      <div class="row between"><div><span class="status ok">● Safety mode on</span><h2 class="mt8">${esc(s.label)}</h2>
        <p class="muted">Started ${tclock(s.started_at)} · arriving ~<b>${tclock(s.expected_arrival)}</b>${s.trip ? ` · with ${esc(s.trip.with)} (${esc(s.trip.vehicle)})` : ""}</p></div></div>
      <div class="checkins">
        ${["departure", "midway", "arrival"].map((k) => { const done = k === "departure" ? s.departed_at : k === "midway" ? s.midway_done_at : null; const skip = k === "midway" && !s.midway_done_at && s.due_kind === "arrival" && !s.events.some((e) => e.kind === "checkin_midway");
          return `<div class="ck ${done ? "done" : s.due_kind === k ? "next" : ""} ${skip && k === "midway" ? "skip" : ""}"><span>${done ? ICON.check : ""}</span><small>${{ departure: "Set off", midway: "Halfway", arrival: "Arrived" }[k]}</small></div>`; }).join("")}
      </div>
      ${s.due_kind ? `<p class="mt12"><b>Next check-in:</b> ${esc({ departure: "when you set off", midway: "halfway", arrival: "when you arrive" }[s.due_kind])} — ${dueText}</p>` : ""}
      <div class="row mt12 wrap">
        ${s.due_kind && s.due_kind !== "arrival" ? `<button type="button" class="btn" data-act="checkin" data-stage="${s.due_kind}">${ICON.check} ${DUE_LABEL[s.due_kind]}</button>` : ""}
        <button type="button" class="btn ${s.due_kind === "arrival" ? "" : "ghost"}" data-act="checkin" data-stage="arrival">${ICON.check} I've arrived</button>
        ${s.trip && !s.boarded_at ? `<button type="button" class="btn ghost" data-act="boardPrompt" data-id="${s.trip.id}">${ICON.qr} Confirm boarding</button>` : ""}
      </div>
      ${s.boarded_at ? `<p class="mt8 ok-text">${ICON.check} Boarding confirmed at ${tclock(s.boarded_at)}</p>` : ""}
      <div class="row mt12 wrap"><span class="muted small">Running late?</span>${[15, 30, 60].map((m) => `<button type="button" class="btn ghost small" data-act="extend" data-min="${m}">+${m} min</button>`).join("")}</div>
    </section>
    <section class="card">
      <h3>Who's following</h3>
      ${s.contacts.length ? `<p>${s.contacts.map((c) => `${esc(c.name)}${c.status !== "active" ? ` <span class="muted small">(hasn't accepted)</span>` : ""}`).join(", ")}</p>` : `<p class="muted">Nobody — only you get reminders.</p>`}
      <label class="check mt8"><input type="checkbox" data-act="toggleShare" ${s.share_location ? "checked" : ""}/> Share my live location</label>
      ${s.share_location && !navigator.geolocation ? `<p class="muted small">This browser can't share location — check-ins still work.</p>` : ""}
      <div class="row mt8"><button type="button" class="btn ghost small" data-act="copyShare" data-url="${esc(s.share_url)}">Copy their link</button></div>
      <p class="muted small mt8">Escalation: ${s.escalation === "contacts" ? "ask me first, then tell my circle" : "only remind me"}.</p>
    </section>
    <section class="card"><h3>Timeline</h3><ol class="timeline">${s.events.slice().reverse().map((e) => `<li><b>${esc(EVENT_LABEL[e.kind] || e.kind)}</b>${e.note ? ` <span class="muted">· ${esc(e.note)}</span>` : ""}<small>${tclock(e.at)}</small></li>`).join("")}</ol>
      <button type="button" class="btn ghost small mt12" data-act="endSession">End safety mode</button></section>`;
}

async function circleTab() {
  const box = $("#safetyBody");
  let d; try { d = await api("/api/circle"); } catch (err) { box.innerHTML = `<div class="card empty">${esc(err.message)}</div>`; return; }
  const badge = (c) => c.status === "active" ? `<span class="status ok">Accepted</span>` : c.status === "pending" ? `<span class="status pending">Invited</span>` : `<span class="status no">Declined</span>`;
  box.innerHTML = `
    <section class="card"><h2>${ICON.users} Saath Circle</h2>
      <p class="muted">Up to ${d.max} people you trust — family, friends, roommates. They only hear from SaathRide when you share a safety session with them, check in, arrive, miss a check-in, or press SOS. They must accept first and can stop any time.</p>
      ${!d.email ? `<p class="notice mt8">Email isn't switched on for this site yet, so invitations and alerts can't be sent. The site owner can turn it on (see README → Email).</p>` : ""}
      <div class="mt12">${d.contacts.map((c) => `<div class="request"><div class="grow"><b>${esc(c.name)}</b>${c.relation ? ` <span class="muted">· ${esc(c.relation)}</span>` : ""}<div class="muted small">${esc(c.email)}</div></div>${badge(c)}
          ${c.status === "pending" ? `<button type="button" class="btn ghost small" data-act="circleResend" data-id="${c.id}">Resend</button>` : ""}<button type="button" class="btn ghost small" data-act="circleRemove" data-id="${c.id}" aria-label="Remove ${esc(c.name)}">Remove</button></div>`).join("") || `<p class="muted">No trusted contacts yet.</p>`}</div>
      ${d.contacts.length < d.max ? `<form id="circleForm" class="mt16"><h3>Add someone</h3>
        <div class="row2"><div class="field"><label for="cf_n">Name</label><input id="cf_n" maxlength="60" required placeholder="e.g. Maa" /></div>
          <div class="field"><label for="cf_r">Relation <span class="muted">(optional)</span></label><input id="cf_r" maxlength="40" placeholder="e.g. Mother, roommate" /></div></div>
        <div class="field"><label for="cf_e">Their email</label><input id="cf_e" type="email" maxlength="254" required placeholder="name@example.com" /></div>
        <p class="muted small">We'll email them once to ask if they're happy to be your trusted contact. If they don't accept, they won't hear from us again.</p>
        <button class="btn">Send invitation</button></form>` : ""}
    </section>`;
  const f = $("#circleForm");
  if (f) f.addEventListener("submit", async (e) => {
    e.preventDefault(); const b = f.querySelector("button"); b.disabled = true;
    try {
      const r = await api("/api/circle", { method: "POST", body: { name: $("#cf_n").value, email: $("#cf_e").value, relation: $("#cf_r").value } });
      toast(r.invited ? `Invitation sent to ${r.contact.name}` : `${r.contact.name} added — email isn't on yet, so no invitation was sent`); circleTab();
    } catch (err) { toast(err.message); b.disabled = false; }
  });
}

async function reportsTab() {
  const box = $("#safetyBody");
  let d; try { d = await api("/api/safety/cases/mine"); } catch (err) { box.innerHTML = `<div class="card empty">${esc(err.message)}</div>`; return; }
  box.innerHTML = `<section class="card"><div class="row between"><h2>My safety reports</h2><a class="btn small" href="#/safety/report">Report a concern</a></div>
    <p class="muted small">Only you and the SaathRide safety team can see these. You'll be notified when there's an update.</p>
    ${d.cases.map((c) => `<div class="case-row mt12"><div class="row between"><b>#${c.id} · ${esc(c.category_label)}</b><span class="status ${c.status === "closed" || c.status === "action_taken" ? "ok" : "pending"}">${esc(c.status_label)}</span></div>
      <div class="muted small">Reported ${esc(ago(c.created_at))} · first response target ${esc(c.target)}</div>
      ${c.outcome ? `<p class="mt8"><b>Outcome:</b> ${esc(c.outcome)}</p>` : ""}
      ${c.updates.length ? `<ol class="timeline mt8">${c.updates.map((u) => `<li>${esc(u.body)}<small>${esc(ago(u.at))}</small></li>`).join("")}</ol>` : ""}</div>`).join("") || `<p class="muted mt12">You haven't reported anything.</p>`}
  </section>`;
}

// ---------------- report a safety concern ----------------
async function viewSafetyReport(params) {
  if (!me) return needLogin();
  let opts, subject = null; const seq = routeSeq;
  try { opts = await api("/api/safety/case-options"); } catch (err) { return notFound(err.message); }
  if (params.user) { try { subject = (await api(`/api/users/${Number(params.user)}`)).user; } catch { subject = null; } }
  if (stale(seq)) return;
  view.innerHTML = `<p class="mt8"><a href="#/safety?tab=reports">← Safety</a></p>
    <h1 class="page-title">Report a safety concern</h1>
    <div class="notice">${ICON.phone} If you're in danger right now, <a href="tel:112"><b>call 112</b></a>. This form goes to the SaathRide safety team, who aren't an emergency service.</div>
    <form id="caseForm" class="card mt12">
      ${subject ? `<p>About <b>${esc(subject.name)}</b> <span class="muted">@${esc(subject.username)}</span></p>` : ""}
      ${params.conv ? `<p class="muted small">The conversation you were in will be shared with the safety team so they can review it.</p>` : ""}
      <fieldset class="field"><legend>What happened?</legend>
        ${opts.categories.map((c) => `<label class="check"><input type="radio" name="category" value="${c.key}" required/> ${esc(c.label)} <span class="muted small">· reviewed ${esc(c.target)}</span></label>`).join("")}</fieldset>
      <div class="field"><label for="cs_d">Tell us what happened</label><textarea id="cs_d" rows="5" maxlength="3000" required placeholder="What happened, when and where. Include anything that helps us understand — you don't need to share more than you're comfortable with."></textarea></div>
      <div class="row2"><div class="field"><label for="cs_on">When <span class="muted">(optional)</span></label><input id="cs_on" type="date" /></div>
        <div class="field"><label for="cs_link">Link to evidence <span class="muted">(optional, https)</span></label><input id="cs_link" type="url" maxlength="300" placeholder="https://…" /></div></div>
      <div class="field"><label for="cs_ev">Other details <span class="muted">(optional)</span></label><textarea id="cs_ev" rows="2" maxlength="500" placeholder="e.g. vehicle number, what was said, witnesses"></textarea></div>
      ${subject ? `<label class="check"><input type="checkbox" id="cs_block" checked/> Also block ${esc(subject.name.split(" ")[0])} so they can't contact me</label>` : ""}
      <p class="form-error" id="caseErr" role="alert"></p>
      <button class="btn mt12">Send to the safety team</button>
    </form>`;
  $("#caseForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const b = e.target.querySelector("button.btn"); b.disabled = true;
    const evidence = [];
    if ($("#cs_ev").value.trim()) evidence.push({ kind: "note", value: $("#cs_ev").value.trim() });
    if ($("#cs_link").value.trim()) evidence.push({ kind: "link", value: $("#cs_link").value.trim() });
    try {
      const r = await api("/api/safety/cases", { method: "POST", body: { category: (e.target.querySelector("input[name=category]:checked") || {}).value, description: $("#cs_d").value,
        happened_on: $("#cs_on").value, evidence, subject_id: subject ? subject.id : undefined, conversation_id: params.conv ? Number(params.conv) : undefined, trip_id: params.trip ? Number(params.trip) : undefined,
        block: !!($("#cs_block") && $("#cs_block").checked) } });
      view.innerHTML = `<div class="card mt16"><h1 class="page-title">Thank you — report #${r.case.id} received</h1>
        <p>The safety team aims to respond <b>${esc(r.case.target)}</b>. You'll get a notification${me.email_verified ? " and an email" : ""} when there's an update.</p>
        ${r.blocked ? `<p class="mt8">${ICON.check} You've blocked them — they can't message you or see your posts.</p>` : ""}
        <p class="notice mt12">If you feel unsafe at any point, call <a href="tel:112"><b>112</b></a>.</p>
        <div class="row mt12"><a class="btn" href="#/safety?tab=reports">See my reports</a><a class="btn ghost" href="#/">Home</a></div></div>`;
    } catch (err) { $("#caseErr").textContent = err.message; b.disabled = false; }
  });
}

// ---------------- trusted contact's view (no login) ----------------
async function viewShare(token) {
  const draw = async () => {
    let s;
    try { s = await api(`/api/safety/share/${token}`); }
    catch (err) { clearInterval(safe.shareTimer); view.innerHTML = `<div class="card empty"><h2>This link has ended</h2><p class="mt8">${esc(err.message)}. Safety links stop working a couple of hours after the journey ends.</p></div>`; return; }
    const active = s.status === "active";
    const statusLine = s.sos_at && active ? `<div class="card alert-card"><h2>${ICON.sos} ${esc(s.name)} pressed SOS at ${tclock(s.sos_at)}</h2><p>Call ${esc(s.name)} now. If you can't reach them or think they're in danger, <a href="tel:112"><b>call 112</b></a> and share the location below.</p></div>`
      : s.missed_stage && active ? `<div class="card alert-card warn"><h2>${esc(s.name)} ${s.overdue ? "hasn't checked in as arrived" : "missed a check-in"}</h2><p>This doesn't necessarily mean something is wrong. Try calling ${esc(s.name)}. If you can't reach them and you're worried, call <a href="tel:112"><b>112</b></a>.</p></div>` : "";
    view.innerHTML = `<h1 class="page-title">${esc(s.name)}'s journey</h1>
      ${statusLine}
      <section class="card">
        <span class="status ${active ? "ok" : ""}">${active ? "● Live" : s.status === "arrived" ? "✓ Arrived safely" : "Ended"}</span>
        <h2 class="mt8">${esc(s.label)}</h2>
        <p class="muted">Started ${tclock(s.started_at)} · expected ~<b>${tclock(s.expected_arrival)}</b>${s.trip ? ` · with ${esc(s.trip.with)} (${esc(s.trip.vehicle)})` : ""}</p>
        ${s.boarded_at ? `<p class="ok-text mt8">${ICON.check} Confirmed boarding the expected vehicle at ${tclock(s.boarded_at)}</p>` : ""}
        ${s.last_checkin_at ? `<p class="mt8">Last check-in: <b>${tclock(s.last_checkin_at)}</b></p>` : ""}
      </section>
      ${s.location ? `<section class="card"><div class="row between"><h3>Last known location</h3><small class="muted">${esc(ago(s.location.at))}</small></div>
        <div id="shareMap" class="map small-map"><div class="map-msg">Loading map…</div></div>
        <a class="btn ghost small mt8" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${s.location.lat},${s.location.lng}">${ICON.nav} Open in Google Maps</a></section>` : active ? `<p class="muted mt12">Live location isn't being shared right now — check-ins still update here.</p>` : ""}
      <section class="card"><h3>Updates</h3><ol class="timeline">${s.events.slice().reverse().map((e) => `<li><b>${esc(EVENT_LABEL[e.kind] || e.kind)}</b><small>${tclock(e.at)}</small></li>`).join("")}</ol></section>
      <p class="muted small mt12">This page refreshes automatically. SaathRide isn't an emergency service — in an emergency call <a href="tel:112">112</a>.</p>`;
    if (s.location && config.map) {
      try {
        const map = await MapKit.create($("#shareMap"), { center: [s.location.lng, s.location.lat], zoom: 14 });
        MapKit.marker(MapKit.pin("origin", s.name)).setLngLat([s.location.lng, s.location.lat]).addTo(map);
      } catch (e) { const m = $("#shareMap"); if (m) m.innerHTML = `<div class="map-msg"><p>${esc(mapFailText(e))}</p></div>`; }
    } else if ($("#shareMap")) $("#shareMap").hidden = true;
    if (!active) clearInterval(safe.shareTimer);
  };
  view.innerHTML = `<div class="skeleton"></div>`;
  await draw();
  clearInterval(safe.shareTimer);
  safe.shareTimer = setInterval(() => { if (location.hash === `#/s/${token}`) draw(); else clearInterval(safe.shareTimer); }, 20000);
}

// ---------------- QR boarding ----------------
async function viewBoard(tripId, code) {
  if (!me) { sessionStorageSafe("afterLogin", location.hash); return needLogin(); }
  view.innerHTML = `<div class="card mt16"><h1 class="page-title">Confirming your vehicle…</h1></div>`;
  try {
    const r = await api(`/api/trips/${tripId}/board`, { method: "POST", body: { code } });
    view.innerHTML = `<div class="card mt16 board-ok"><div class="big-check">${ICON.check}</div><h1 class="page-title">You're in the right vehicle</h1>
      <p><b>${esc(r.trip.route)}</b> with ${esc(r.trip.owner)} · ${esc(VEHICLES[r.trip.vehicle] ? VEHICLES[r.trip.vehicle][1] : r.trip.vehicle)}${r.trip.vehicle_model ? ` (${esc(r.trip.vehicle_model)})` : ""}</p>
      ${r.session_updated ? `<p class="ok-text mt8">Your Saath Circle has been told you've boarded.</p>` : `<p class="mt8"><a class="btn small" href="#/safety?trip=${tripId}">${ICON.shield} Start safety mode for this ride</a></p>`}
      <p class="muted small mt12">Still check the person matches their profile photo before you set off.</p></div>`;
    refreshSession();
  } catch (err) {
    view.innerHTML = `<div class="card mt16 alert-card"><h1 class="page-title">Don't board yet</h1><p>${esc(err.message)}</p><div class="row mt12"><a class="btn ghost" href="#/trip/${tripId}">Open the journey</a></div></div>`;
  }
}
function sessionStorageSafe(k, v) { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } }
function boardPrompt(tripId) {
  dialog({ title: "Confirm you're boarding the right vehicle",
    html: `<p class="muted">Ask the trip owner to show their boarding QR and scan it with your phone camera — or type the 6-character code under it.</p>
      <div class="field"><label for="bc">Boarding code</label><input id="bc" name="code" maxlength="8" autocomplete="off" autocapitalize="characters" required placeholder="e.g. K7M2QX" /></div>`,
    submitLabel: "Confirm", onSubmit: async (f) => { location.hash = `#/board/${tripId}/${encodeURIComponent(String(f.code).trim().toUpperCase())}`; } });
}
let qrLoad = null;
async function showBoardingQr(tripId) {
  let d; try { d = await api(`/api/trips/${tripId}/boarding`); } catch (err) { return toast(err.message); }
  const url = d.url.startsWith("/") ? location.origin + d.url : d.url;
  let svg = "";
  try {
    if (!window.qrcode) { qrLoad ||= loadAsset("script", { src: "/vendor/qrcode.js" }); await qrLoad; }
    const q = window.qrcode(0, "M"); q.addData(url); q.make(); svg = q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  } catch { svg = ""; }
  const dlg = $("#dlg");
  dlg.innerHTML = `<div class="dlg-form board-dlg"><h3>${ICON.qr} Boarding QR</h3>
    <p class="muted small">Passengers scan this with their phone camera before getting in. It confirms they're boarding <b>your</b> vehicle — and tells their Saath Circle if safety mode is on.</p>
    ${svg ? `<div class="qr-box">${svg}</div>` : `<p class="notice">The QR image couldn't load — passengers can type the code instead.</p>`}
    <p class="board-code">${esc(d.code)}</p>
    ${d.boarded.length ? `<p class="mt8"><b>Boarded:</b> ${d.boarded.map((b) => `${esc(b.name)} <small class="muted">${tclock(b.at)}</small>`).join(", ")}</p>` : `<p class="muted small mt8">No one has confirmed boarding yet.</p>`}
    <div class="dlg-actions"><button type="button" class="btn" data-close>Done</button></div></div>`;
  dlg.querySelector("[data-close]").onclick = () => dlg.close();
  dlg.showModal();
}

// ---------------- trip page: safety tools + memory ----------------
window.tripSafetyExtras = async (t) => {
  const box = $("#tripSafety"); if (!box || !me) return;
  const participant = t.is_owner || t.my_interest === "accepted";
  if (!participant) return;
  const todayIso = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const happened = t.depart_date <= todayIso && t.status !== "cancelled";
  const upcoming = t.depart_date >= todayIso && t.status !== "cancelled";
  let html = "";
  if (upcoming) html += `<section class="card safety-card"><h3>${ICON.shield} Travel safely</h3>
    <p class="muted small">${t.is_owner ? "Show your boarding QR so passengers can confirm they're getting into the right vehicle." : "Scan the owner's boarding QR before you get in, and turn on safety mode so people you trust can follow the ride."}</p>
    <div class="row wrap mt8">${t.is_owner ? `<button type="button" class="btn ghost small" data-act="showQr" data-id="${t.id}">${ICON.qr} Show boarding QR</button>` : `<button type="button" class="btn ghost small" data-act="boardPrompt" data-id="${t.id}">${ICON.qr} Confirm boarding</button>`}
      <a class="btn ghost small" href="#/safety?trip=${t.id}">${ICON.shield} Safety mode</a><button type="button" class="btn ghost small" data-act="sos">${ICON.sos} SOS</button></div></section>`;
  if (happened) {
    let m = null;
    try { m = await api(`/api/trips/${t.id}/memory`); } catch { m = null; }
    if (m && m.memory) html += `<section class="card memory-teaser"><h3>📸 Journey memory</h3><a class="memory-tile" href="#/memory/${m.memory.id}">${m.memory.photos[0] ? `<img src="${esc(m.memory.photos[0].url)}" alt="" loading="lazy"/>` : `<span class="memory-emoji">🛣️</span>`}<span><b>${esc(m.memory.title)}</b><small>${plural(m.memory.highlights.length, "highlight")} · ${plural(m.memory.photos.length, "photo")}</small></span></a></section>`;
    else if (m && m.can_create) html += `<section class="card memory-teaser"><h3>📸 Make it a memory</h3><p class="muted small">Keep the route, a few photos and the best moments — private to the people on this journey unless you choose to share it.</p>
      <button type="button" class="btn small mt8" data-act="newMemory" data-id="${t.id}">Create a journey memory</button></section>`;
  }
  box.innerHTML = html;
};
function newMemoryDialog(tripId) {
  dialog({ title: "Create a journey memory",
    html: `<div class="field"><label for="mt">Title</label><input id="mt" name="title" maxlength="80" placeholder="e.g. Monsoon ride to campus" /></div>
      <div class="field"><label for="mh">A highlight <span class="muted">(optional)</span></label><textarea id="mh" name="highlight" rows="3" maxlength="500" placeholder="The chai stop, the playlist, the view…"></textarea></div>
      <fieldset class="field"><legend>Who can see it?</legend>
        <label class="check"><input type="radio" name="visibility" value="participants" checked/> Only the people on this journey</label>
        <label class="check"><input type="radio" name="visibility" value="public"/> Anyone — and show it on my profile</label></fieldset>
      <p class="muted small">Everyone on the journey can add highlights${config.uploads ? " and photos" : ""}. Each person decides whether a public memory appears on their own profile.</p>`,
    submitLabel: "Create memory",
    onSubmit: async (f) => {
      const r = await api(`/api/trips/${tripId}/memory`, { method: "POST", body: { title: f.title, highlight: f.highlight, visibility: f.visibility, show_on_profile: f.visibility === "public" } });
      location.hash = `#/memory/${r.memory.id}`;
    } });
}

// ---------------- Journey Memory page ----------------
async function viewMemory(id) {
  let m; const seq = routeSeq; try { m = (await api(`/api/memories/${id}`)).memory; } catch (err) { return stale(seq) ? undefined : notFound(err.message); }
  if (stale(seq)) return;
  const owner = m.can_edit;
  view.innerHTML = `<p class="mt8"><a href="#/trip/${m.trip.id}">← Journey</a></p>
    <section class="card memory">
      <div class="row between"><div><p class="muted small">${esc(fmtDate(m.trip.date))} · ${esc(m.trip.vehicle)}${m.trip.distance_km ? ` · ${m.trip.distance_km} km` : ""}</p><h1 class="page-title">${esc(m.title)}</h1><p><b>${esc(m.trip.route)}</b></p></div>
        <span class="status">${m.visibility === "public" ? "Public" : "Only travellers"}</span></div>
      <div class="avatars mt8">${m.members.map((p) => `<a href="#/u/${p.id}" title="${esc(p.name)}">${avatar(p, "sm")}</a>`).join("")}<span class="muted small">${m.members.map((p) => esc(p.name.split(" ")[0])).join(", ")}</span></div>
      ${m.trip.from || m.trip.path ? `<div id="memMap" class="map small-map mt12"><div class="map-msg">Loading route…</div></div>` : ""}
      ${m.photos.length ? `<div class="memory-photos mt12">${m.photos.map((p) => `<figure><img src="${esc(cl(p.url, 640) || p.url)}" alt="Journey photo" loading="lazy"/>${p.mine || owner ? `<button type="button" class="icon-btn" data-act="memPhotoDel" data-id="${m.id}" data-pid="${p.id}" aria-label="Remove photo">✕</button>` : ""}</figure>`).join("")}</div>` : ""}
      ${m.is_member && config.uploads ? `<div class="row mt12"><input type="file" id="memFiles" accept="image/jpeg,image/png,image/webp" multiple hidden/><button type="button" class="btn ghost small" data-act="memPhotos">${ICON.camera2} Add photos</button><span class="muted small" id="memUp"></span></div>` : ""}
    </section>
    <section class="card"><h3>Highlights</h3>
      ${m.highlights.map((h) => `<div class="highlight">${avatar(h.by, "sm")}<div class="grow"><b>${esc(h.by.name.split(" ")[0])}</b> ${esc(h.body)}<small class="muted"> · ${esc(ago(h.at))}</small></div>${h.mine ? `<button type="button" class="link-btn small" data-act="memHlDel" data-id="${m.id}" data-hid="${h.id}">Delete</button>` : ""}</div>`).join("") || `<p class="muted">No highlights yet.</p>`}
      ${m.is_member ? `<form id="hlForm" class="comment-form mt12"><input id="hlInput" maxlength="500" placeholder="Add a moment you remember…" aria-label="Add a highlight" required/><button class="btn small">Add</button></form>` : ""}
    </section>
    ${m.is_member ? `<section class="card"><h3>Sharing</h3>
      ${owner ? `<label class="check"><input type="radio" name="vis" value="participants" data-act="memVis" data-id="${m.id}" ${m.visibility === "participants" ? "checked" : ""}/> Only the people on this journey</label>
        <label class="check"><input type="radio" name="vis" value="public" data-act="memVis" data-id="${m.id}" ${m.visibility === "public" ? "checked" : ""}/> Public</label>` : `<p class="muted small">${m.visibility === "public" ? "This memory is public." : "Only the people on this journey can see it."}</p>`}
      <label class="check mt8"><input type="checkbox" data-act="memProfile" data-id="${m.id}" ${m.show_on_profile ? "checked" : ""} ${m.visibility !== "public" ? "disabled" : ""}/> Show on my profile</label>
      ${m.visibility !== "public" ? `<p class="muted small">Only public memories can appear on profiles.</p>` : ""}
      ${owner ? `<button type="button" class="btn ghost small danger mt12" data-act="memDelete" data-id="${m.id}">Delete memory</button>` : ""}</section>` : ""}`;
  if ((m.trip.from || m.trip.path) && config.map) {
    try {
      const map = await MapKit.create($("#memMap"), { cooperative: true, center: m.trip.from ? [m.trip.from.lng, m.trip.from.lat] : undefined, zoom: 10 });
      if (m.trip.from) MapKit.marker(MapKit.pin("origin", "Start")).setLngLat([m.trip.from.lng, m.trip.from.lat]).addTo(map);
      if (m.trip.to) MapKit.marker(MapKit.pin("dest", "End")).setLngLat([m.trip.to.lng, m.trip.to.lat]).addTo(map);
      MapKit.showRoute(map, m.trip.path, m.trip.from, m.trip.to);
    } catch (e) { const el = $("#memMap"); if (el) el.innerHTML = `<div class="map-msg"><p>${esc(mapFailText(e))}</p></div>`; }
  } else if ($("#memMap")) $("#memMap").hidden = true;
  const f = $("#hlForm");
  if (f) f.addEventListener("submit", async (e) => {
    e.preventDefault(); const b = f.querySelector("button"); b.disabled = true;
    try { await api(`/api/memories/${m.id}/highlights`, { method: "POST", body: { body: $("#hlInput").value } }); viewMemory(m.id); } catch (err) { toast(err.message); b.disabled = false; }
  });
  const files = $("#memFiles");
  if (files) files.addEventListener("change", async () => {
    const list = [...files.files].slice(0, 6); if (!list.length) return;
    const up = $("#memUp");
    try {
      const items = []; for (const fl of list) items.push(await compressImage(fl));
      const photos = await uploadMany(items, "posts", (i, n) => { up.textContent = `Uploading ${i}/${n}…`; });
      await api(`/api/memories/${m.id}/photos`, { method: "POST", body: { photos } });
      viewMemory(m.id);
    } catch (err) { toast(err.message); up.textContent = ""; }
  });
}

// ---------------- profile: journey record ----------------
window.profileJourneys = async (userId, own) => {
  const box = $("#journeyRecord"); if (!box) return;
  let d; try { d = await api(`/api/users/${userId}/journeys`); } catch { return; }
  if (!d.journeys && !d.memories.length) return;
  box.innerHTML = `<section class="card journey-record">
    <div class="row between"><h2>Journeys</h2><span class="muted small">${plural(d.journeys, "journey")} travelled</span></div>
    ${d.communities.length ? `<p class="muted small mt8">Travelled with people from ${d.communities.map(esc).join(" · ")} <span class="muted">(self-declared)</span></p>` : ""}
    ${d.memories.length ? `<div class="memory-strip mt12">${d.memories.map((m) => `<a class="memory-tile" href="#/memory/${m.id}">${m.cover ? `<img src="${esc(cl(m.cover, 320) || m.cover)}" alt="" loading="lazy"/>` : `<span class="memory-emoji">🛣️</span>`}
        <span><b>${esc(m.title)}</b><small>${esc(fmtDate(m.date))} · ${plural(m.members, "traveller")}${own ? ` · ${m.visibility === "public" ? (m.show_on_profile ? "on your profile" : "public, not on profile") : "private"}` : ""}</small></span></a>`).join("")}</div>`
      : own ? `<p class="muted small mt8">After a journey, open it and tap “Create a journey memory” to keep the route, photos and best moments.</p>` : ""}
  </section>`;
};

// ---------------- women's section ----------------
async function viewWomen(params) {
  if (!me) return needLogin();
  if (me.gender !== "female") {
    view.innerHTML = `<div class="card mt16"><h1 class="page-title">${ICON.women} Women's space</h1>
      <p>This section — women-only journeys and matching — is for members who've set their gender to female.</p>
      <p class="muted small mt8">Gender is self-declared on SaathRide and isn't verified. If you're a woman, you can set it in <a href="#/me">Edit profile</a>.</p></div>`;
    return;
  }
  view.innerHTML = `<section class="women-hero card"><h1 class="page-title">${ICON.women} Women's space</h1>
      <p>Journeys posted as <b>women-only</b> — visible only to women members, never to men or logged-out visitors, and not even in link previews.</p>
      <div class="row wrap mt12"><a class="btn" href="#/post">${ICON.plus} Post a women-only journey</a><a class="btn ghost" href="#/safety">${ICON.shield} Safety mode</a><a class="btn ghost" href="#/safety?tab=circle">${ICON.users} Saath Circle</a></div>
      <p class="muted small mt12">Tick “Women-only trip” when you post. Gender on SaathRide is self-declared and can't be verified — if someone seems to be misrepresenting themselves, <a href="#/safety/report">report it</a> (impersonation) and the safety team will review it.</p></section>
    <section class="card"><h2>Find a women-only match</h2>
      <form id="wMatch" class="mt8">
        <div class="row2"><div class="field"><label for="w_from">From <span class="muted">(optional)</span></label><input id="w_from" maxlength="120" placeholder="e.g. Jadavpur" /></div>
          <div class="field"><label for="w_to">To</label><input id="w_to" maxlength="120" required placeholder="e.g. Salt Lake Sector V" /></div></div>
        <div class="row2"><div class="field"><label for="w_date">Date</label><input id="w_date" type="date" /></div><div class="field"><label for="w_time">Leaving around</label><input id="w_time" type="time" /></div></div>
        <button class="btn">Find women-only journeys</button></form>
      <div id="wResults" class="mt12"></div></section>
    <section class="card"><h2>Upcoming women-only journeys</h2><div id="wList" class="mt8"><div class="skeleton short"></div></div></section>
    ${safetyTips()}`;
  wirePlacePickers(["w_from", "w_to"]);
  $("#wMatch").addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = $("#wResults"); out.innerHTML = `<div class="skeleton short"></div>`;
    try {
      const r = await api("/api/match", { method: "POST", body: { from: pickedPlace("w_from"), to: pickedPlace("w_to"), date: $("#w_date").value || undefined, time: $("#w_time").value || undefined, women_only: true } });
      for (const x of r.results) tripCache.set(x.trip.id, x.trip);
      out.innerHTML = r.results.length ? r.results.map((x) => `<div class="match-card">${miniCard(x.trip)}${reasonChips(x.reasons)}</div>`).join("")
        : `<p class="muted">No women-only journeys fit yet. Post yours so other women can find you — or widen the time.</p>`;
    } catch (err) { out.innerHTML = `<p class="form-error">${esc(err.message)}</p>`; }
  });
  try {
    const { trips } = await api("/api/trips?women_only=1");
    $("#wList").innerHTML = trips.length ? `<div class="tiles">${trips.map(tile).join("")}</div>` : `<p class="muted">No women-only journeys posted yet — be the first.</p>`;
  } catch (err) { $("#wList").innerHTML = `<p class="muted">${esc(err.message)}</p>`; }
}

// ---------------- safety team: case queue ----------------
const SEV_CLASS = { critical: "sev-critical", high: "sev-high", medium: "sev-medium", low: "sev-low" };
async function viewCases(params) {
  if (!me) return needLogin();
  let d; const seq = routeSeq; try { d = await api(`/api/admin/cases${params.status === "all" ? "?status=all" : ""}`); } catch { return stale(seq) ? undefined : notFound("Page not found"); }
  if (stale(seq)) return;
  view.innerHTML = `<div class="row between"><h1 class="page-title">Safety cases</h1><a class="btn ghost small" href="#/admin">Post & member reports</a></div>
    <div class="seg"><a href="#/admin/cases" ${params.status !== "all" ? 'aria-current="true"' : ""}>Open</a><a href="#/admin/cases?status=all" ${params.status === "all" ? 'aria-current="true"' : ""}>All</a></div>
    <details class="card mt12"><summary><b>Response process</b></summary>${responseProcess()}</details>
    <section class="card mt12">${d.cases.map((c) => `<a class="case-row link" href="#/admin/cases/${c.id}"><div class="row between"><b>#${c.id} · ${esc(c.category_label)}</b><span class="sev ${SEV_CLASS[c.severity]}">${esc(c.severity)}</span></div>
      <div class="muted small">${esc(c.status.replace("_", " "))} · ${c.subject ? `about ${esc(c.subject.name)} @${esc(c.subject.username)} · ` : ""}by ${esc(c.reporter || "deleted account")} · ${esc(ago(c.created_at))} · target ${esc(c.target)}${c.overdue ? ` · <b class="danger-text">overdue</b>` : ""}</div></a>`).join("") || `<p class="muted">No open cases. 🎉</p>`}</section>`;
}
function responseProcess() {
  return `<ol class="process">
    <li><b>Critical</b> (threats, sexual misconduct) — first response within 1 hour. If anyone may be in immediate danger, tell the reporter to call 112 and consider suspending the account straight away while you investigate.</li>
    <li><b>High</b> (stalking, harassment, dangerous driving) — within 12 hours. Contact the reporter, review the shared conversation and any prior cases, and suspend for credible or repeated behaviour.</li>
    <li><b>Medium</b> (impersonation, scams) — within 2 days. Check the profile and posts; suspend fakes and confirmed scammers.</li>
    <li><b>Low</b> — within 5 days.</li>
    <li>Always: assign the case to yourself, keep internal notes, message the reporter when there's news, and write the outcome before closing. Never share the reporter's identity with the subject. For anything that may be a crime, advise the reporter to contact the police (112) and keep the case record.</li></ol>`;
}
async function viewCase(id) {
  if (!me) return needLogin();
  let c; const seq = routeSeq; try { c = (await api(`/api/admin/cases/${id}`)).case; } catch { return stale(seq) ? undefined : notFound("Case not found"); }
  if (stale(seq)) return;
  view.innerHTML = `<p class="mt8"><a href="#/admin/cases">← Cases</a></p>
    <section class="card"><div class="row between"><h1 class="page-title">#${c.id} · ${esc(c.category_label)}</h1><span class="sev ${SEV_CLASS[c.severity]}">${esc(c.severity)}</span></div>
      <p class="muted small">Status: <b>${esc(c.status.replace("_", " "))}</b> · reported ${esc(ago(c.created_at))}${c.happened_on ? ` · happened ${esc(c.happened_on)}` : ""} · target ${esc(c.target)}</p>
      <p class="mt12 pre">${esc(c.description)}</p>
      ${c.evidence.length ? `<h4 class="mt12">Evidence</h4><ul>${c.evidence.map((e) => `<li>${e.kind === "link" ? `<a href="${esc(e.value)}" target="_blank" rel="noopener noreferrer">${esc(e.value)}</a>` : esc(e.value)}</li>`).join("")}</ul>` : ""}
      <div class="row2 mt12">
        <div><h4>Reporter</h4>${c.reporter ? `<a href="#/u/${c.reporter.id}">${esc(c.reporter.name)}</a> @${esc(c.reporter.username)}` : "Deleted account"}</div>
        <div><h4>About</h4>${c.subject ? `<a href="#/u/${c.subject.id}">${esc(c.subject.name)}</a> @${esc(c.subject.username)}${c.subject.suspended ? ` <span class="status no">suspended</span>` : ""}<div class="muted small">${plural(c.subject.prior_cases.length, "other case")} · ${plural(c.subject.member_reports, "member report")}</div>` : "—"}</div></div>
      ${c.trip ? `<p class="mt8">Journey: <a href="#/trip/${c.trip.id}">${esc(c.trip.route)}</a> · ${esc(c.trip.depart_date)} ${esc(c.trip.depart_time)}</p>` : ""}
    </section>
    ${c.conversation.length ? `<section class="card"><h3>Conversation shared by the reporter</h3><div class="convo-log">${c.conversation.map((m) => `<p><b>${esc(m.from)}</b> <small class="muted">${esc(ago(m.at))}</small><br>${esc(m.body)}</p>`).join("")}</div></section>` : ""}
    <section class="card"><h3>Act</h3>
      <form id="caseAct">
        <div class="row2"><div class="field"><label for="ca_s">Status</label><select id="ca_s">${["new", "triaged", "investigating", "action_taken", "closed"].map((s) => `<option value="${s}" ${s === c.status ? "selected" : ""}>${s.replace("_", " ")}</option>`).join("")}</select></div>
          <div class="field"><label for="ca_v">Severity</label><select id="ca_v">${["critical", "high", "medium", "low"].map((s) => `<option ${s === c.severity ? "selected" : ""}>${s}</option>`).join("")}</select></div></div>
        <div class="field"><label for="ca_o">Outcome <span class="muted">(required to record action or close — the reporter sees it)</span></label><textarea id="ca_o" rows="2" maxlength="1000">${esc(c.outcome)}</textarea></div>
        <div class="field"><label for="ca_n">Internal note</label><textarea id="ca_n" rows="2" maxlength="1000" placeholder="Only the safety team sees this"></textarea></div>
        <div class="field"><label for="ca_m">Message to the reporter</label><textarea id="ca_m" rows="2" maxlength="1000" placeholder="They get this as a notification"></textarea></div>
        ${c.subject ? `<label class="check"><input type="checkbox" id="ca_sus" ${c.subject.suspended ? "checked" : ""}/> Suspend ${esc(c.subject.name)}'s account <span class="muted small">(blocks sign-in, cancels their open journeys and tells the passengers)</span></label>` : ""}
        <div class="row mt12"><button class="btn">Save</button><button type="button" class="btn ghost" data-act="caseAssign" data-id="${c.id}">Assign to me</button></div>
      </form></section>
    <section class="card"><h3>History</h3><ol class="timeline">${c.events.slice().reverse().map((e) => `<li><b>${esc(e.kind.replace(/_/g, " "))}</b> ${esc(e.body)} ${e.internal ? `<span class="muted small">(internal)</span>` : ""}<small>${esc(e.by || "")} · ${esc(ago(e.at))}</small></li>`).join("")}</ol></section>`;
  $("#caseAct").addEventListener("submit", async (e) => {
    e.preventDefault(); const b = e.target.querySelector("button.btn"); b.disabled = true;
    const body = { status: $("#ca_s").value, severity: $("#ca_v").value, outcome: $("#ca_o").value, note: $("#ca_n").value || undefined, message_to_reporter: $("#ca_m").value || undefined };
    if ($("#ca_sus") && $("#ca_sus").checked !== !!c.subject.suspended) {
      if ($("#ca_sus").checked && !confirm(`Suspend ${c.subject.name}? Their open journeys will be cancelled.`)) { b.disabled = false; return; }
      body.suspend_subject = $("#ca_sus").checked;
    }
    try { await api(`/api/admin/cases/${c.id}`, { method: "PATCH", body }); toast("Saved"); viewCase(c.id); } catch (err) { toast(err.message); b.disabled = false; }
  });
}

// ---------------- clicks ----------------
document.addEventListener("click", async (e) => {
  const btn = e.target.closest && e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act, id = Number(btn.dataset.id);
  const s = safe.session;
  if (act === "sos") { if (!me) { toast("Log in to use SOS — or call 112"); return; } sendSos(); }
  else if (act === "checkin" && s) {
    btn.disabled = true;
    try {
      const r = await api(`/api/safety/sessions/${s.id}/checkin`, { method: "POST", body: { stage: btn.dataset.stage } });
      toast(btn.dataset.stage === "arrival" ? "Glad you're there safely ✓" : "Checked in ✓");
      safe.session = r.session.status === "active" ? r.session : null; manageLocation();
      if (location.hash.startsWith("#/safety")) viewSafety({}); else renderSafetyBar();
    } catch (err) { toast(err.message); btn.disabled = false; }
  }
  else if (act === "extend" && s) { try { const r = await api(`/api/safety/sessions/${s.id}/extend`, { method: "POST", body: { minutes: Number(btn.dataset.min) } }); toast(`Arrival moved to ~${tclock(r.session.expected_arrival)}`); renderActive($("#safetyBody"), r.session); } catch (err) { toast(err.message); } }
  else if (act === "toggleShare" && s) {
    try { await api(`/api/safety/sessions/${s.id}/sharing`, { method: "POST", body: { share_location: btn.checked } }); s.share_location = btn.checked; manageLocation(); toast(btn.checked ? "Sharing live location" : "Stopped sharing location"); }
    catch (err) { toast(err.message); btn.checked = !btn.checked; }
  }
  else if (act === "copyShare") { try { await navigator.clipboard.writeText(btn.dataset.url); toast("Link copied — only share it with people you trust"); } catch { prompt("Copy this link:", btn.dataset.url); } }
  else if (act === "endSession" && s) {
    if (!confirm("End safety mode? Your circle will be told and location sharing stops.")) return;
    try { await api(`/api/safety/sessions/${s.id}/end`, { method: "POST", body: {} }); safe.session = null; manageLocation(); toast("Safety mode ended"); viewSafety({}); } catch (err) { toast(err.message); }
  }
  else if (act === "circleRemove") { if (!confirm("Remove this trusted contact? They'll stop getting updates.")) return; try { await api(`/api/circle/${id}`, { method: "DELETE" }); circleTab(); } catch (err) { toast(err.message); } }
  else if (act === "circleResend") { try { await api(`/api/circle/${id}/resend`, { method: "POST", body: {} }); toast("Invitation sent again"); } catch (err) { toast(err.message); } }
  else if (act === "showQr") showBoardingQr(id);
  else if (act === "boardPrompt") boardPrompt(id);
  else if (act === "newMemory") newMemoryDialog(id);
  else if (act === "memPhotos") { const f = $("#memFiles"); if (f) f.click(); }
  else if (act === "memPhotoDel") { try { await api(`/api/memories/${id}/photos/${btn.dataset.pid}`, { method: "DELETE" }); viewMemory(id); } catch (err) { toast(err.message); } }
  else if (act === "memHlDel") { try { await api(`/api/memories/${id}/highlights/${btn.dataset.hid}`, { method: "DELETE" }); viewMemory(id); } catch (err) { toast(err.message); } }
  else if (act === "memVis") { try { await api(`/api/memories/${id}`, { method: "PATCH", body: { visibility: btn.value } }); toast(btn.value === "public" ? "Memory is public" : "Only travellers can see it now"); viewMemory(id); } catch (err) { toast(err.message); } }
  else if (act === "memProfile") { try { await api(`/api/memories/${id}/profile`, { method: "PUT", body: { show: btn.checked } }); toast(btn.checked ? "Shown on your profile" : "Removed from your profile"); } catch (err) { toast(err.message); btn.checked = !btn.checked; } }
  else if (act === "memDelete") { if (!confirm("Delete this memory for everyone on the journey?")) return; try { await api(`/api/memories/${id}`, { method: "DELETE" }); location.hash = "#/profile"; } catch (err) { toast(err.message); } }
  else if (act === "caseAssign") { try { await api(`/api/admin/cases/${id}`, { method: "PATCH", body: { assign_to_me: true } }); toast("Assigned to you"); viewCase(id); } catch (err) { toast(err.message); } }
  else if (act === "resendVerify") { btn.disabled = true; try { const r = await api("/api/me/verify-email", { method: "POST", body: {} }); toast(r.already ? "Already confirmed" : `Confirmation email sent to ${me.email}`); } catch (err) { toast(err.message); btn.disabled = false; } }
});
