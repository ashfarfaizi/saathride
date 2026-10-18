// SaathRide — safety: Saath Circle (trusted contacts), in-trip safety sessions (live share link, check-ins,
// SOS, overdue handling), QR boarding confirmation, and the safety response case queue.
//
// Principles:
// - Everything is opt-in. Contacts must accept before they get anything and can opt out any time;
//   members choose who sees each session and can stop sharing at any moment.
// - Live location is held only as the latest point of an active session and wiped when it ends.
// - A missed check-in is never treated as proof of an emergency: the traveller is asked first, and only
//   then is their chosen plan followed — with wording that says exactly that.
// - SaathRide is not an emergency service. Every alert tells people to call 112 if they think someone is in danger.
const crypto = require("crypto");
const { iso } = require("./messaging");

const MAX_CONTACTS = 5;
const GRACE_MS = 5 * 60_000;        // a check-in counts as missed 5 min after it falls due
const RESPOND_MS = 10 * 60_000;     // then the traveller has 10 min to answer before their plan is followed
const OVERDUE_MS = 15 * 60_000;     // arrival check-in is "overdue" 15 min after the expected time
const AUTO_END_MS = 12 * 3600_000;  // forgotten sessions end themselves 12 h after the expected arrival
const SHARE_AFTER_END_MS = 2 * 3600_000; // contacts can still see the final status (no location) for 2 h
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Categories, default severity and what the team commits to. Admins can adjust severity per case.
const CASE_CATEGORIES = {
  threat:            { label: "Threats or violence",            severity: "critical" },
  sexual_misconduct: { label: "Sexual harassment or assault",   severity: "critical" },
  stalking:          { label: "Stalking or unwanted contact",   severity: "high" },
  harassment:        { label: "Harassment or abuse",            severity: "high" },
  dangerous_driving: { label: "Dangerous driving",              severity: "high" },
  impersonation:     { label: "Impersonation or fake profile",  severity: "medium" },
  fraud:             { label: "Scam or money demand",           severity: "medium" },
  other:             { label: "Something else",                 severity: "low" },
};
const SEVERITIES = ["critical", "high", "medium", "low"];
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const RESPONSE_TARGET = { critical: "within 1 hour", high: "within 12 hours", medium: "within 2 days", low: "within 5 days" };
const CASE_STATUSES = ["new", "triaged", "investigating", "action_taken", "closed"];
const STATUS_LABEL = { new: "Received", triaged: "Reviewed", investigating: "Being investigated", action_taken: "Action taken", closed: "Closed" };

const token = () => crypto.randomBytes(18).toString("base64url");
const toMs = (v) => (v == null ? null : new Date(iso(v)).getTime());
const nowIso = () => new Date().toISOString();
const firstName = (n) => String(n || "").trim().split(/\s+/)[0] || "Your contact";
const sameCode = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const fmtTime = (v, TZ) => new Date(iso(v)).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: TZ });
const adminEmails = () => (process.env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

function createSafety({ db, HttpError, bad, clean, chat, mailer, getTrip, TZ, forgetSuspension }) {
  const notify = chat.notify;
  const appUrl = () => mailer.appUrl();
  const shareUrl = (t) => `${appUrl()}/#/s/${t}`;
  const contactFooter = (c) => `You're getting this because ${c.owner_name} added you to their Saath Circle on SaathRide and you accepted. Stop these emails: ${appUrl()}/c/${c.token}\nSaathRide isn't an emergency service — if you think someone is in danger, call 112.`;

  const isAdmin = async (userId) => {
    const list = adminEmails(); if (!list.length) return false;
    const u = await db.one("SELECT email FROM users WHERE id = $1", [userId]);
    return !!u && list.includes(String(u.email).toLowerCase());
  };
  async function requireAdmin(req) { if (!(await isAdmin(req.user.id))) throw new HttpError(404, "Not found"); }

  // ---------------- Saath Circle ----------------
  const contactView = (c) => ({ id: c.id, name: c.name, email: c.email, relation: c.relation, status: c.status, invited_at: iso(c.invited_at), responded_at: iso(c.responded_at) });

  async function sendInvite(c, owner) {
    if (!mailer.enabled()) return { sent: false, reason: mailer.status() };
    return mailer.send({
      to: c.email, subject: `${owner.name} added you as a trusted contact on SaathRide`,
      heading: `${firstName(owner.name)} would like you in their Saath Circle`,
      text: `${owner.name} uses SaathRide to share journeys with people travelling the same way. If you accept, you'll only hear from us when ${firstName(owner.name)} starts a safety session for a trip (with a private link to follow it), checks in, arrives, misses a check-in, or presses SOS. Nothing else, and you can stop any time.`,
      cta: "Review and accept", link: `${appUrl()}/c/${c.token}`,
      footer: `You haven't been signed up for anything. If you don't respond, you won't get any further emails. Not for you? Open the link and choose "No thanks".`,
    });
  }

  // Email the people a session is shared with (accepted contacts only).
  async function emailContacts(sessionId, build) {
    if (!mailer.enabled()) return 0;
    const rows = await db.query(`SELECT c.*, u.name AS owner_name FROM safety_session_contacts sc JOIN trusted_contacts c ON c.id = sc.contact_id
      JOIN users u ON u.id = c.user_id WHERE sc.session_id = $1 AND c.status = 'active'`, [sessionId]);
    let n = 0;
    for (const c of rows) { const m = build(c); const r = await mailer.send({ to: c.email, ...m, footer: contactFooter(c) }); if (r.sent) n++; }
    return n;
  }

  // ---------------- sessions ----------------
  const event = (sessionId, kind, note = "") => db.query("INSERT INTO safety_events (session_id, kind, note, created_at) VALUES ($1,$2,$3,$4)", [sessionId, kind, clean(note, 200), nowIso()]);

  async function sessionView(s, { owner = true } = {}) {
    const events = await db.query("SELECT kind, note, created_at FROM safety_events WHERE session_id = $1 ORDER BY id", [s.id]);
    const trip = s.trip_id ? await db.one(`SELECT t.id, t.origin, t.destination, t.depart_time, t.vehicle_type, t.vehicle_model, u.name AS owner_name
      FROM trips t JOIN users u ON u.id = t.owner_id WHERE t.id = $1`, [s.trip_id]) : null;
    const active = s.status === "active";
    const v = {
      status: s.status, label: s.label, started_at: iso(s.started_at), expected_arrival: iso(s.expected_arrival),
      departed_at: iso(s.departed_at), midway_done_at: iso(s.midway_done_at), boarded_at: iso(s.boarded_at), last_checkin_at: iso(s.last_checkin_at),
      due_kind: active ? s.due_kind : "", due_at: active ? iso(s.due_at) : null, missed_stage: active ? s.missed_stage : 0, sos_at: iso(s.sos_at),
      overdue: active && s.due_kind === "arrival" && Date.now() > toMs(s.expected_arrival) + OVERDUE_MS,
      location: active && s.share_location && s.last_lat != null ? { lat: s.last_lat, lng: s.last_lng, at: iso(s.last_loc_at) } : null,
      ended_at: iso(s.ended_at),
      trip: trip ? { id: trip.id, route: `${trip.origin} → ${trip.destination}`, vehicle: trip.vehicle_type + (trip.vehicle_model ? ` · ${trip.vehicle_model}` : ""), with: trip.owner_name } : null,
      events: events.map((e) => ({ kind: e.kind, note: e.note, at: iso(e.created_at) })),
    };
    if (owner) {
      const contacts = await db.query(`SELECT c.id, c.name, c.status FROM safety_session_contacts sc JOIN trusted_contacts c ON c.id = sc.contact_id WHERE sc.session_id = $1`, [s.id]);
      Object.assign(v, { id: s.id, escalation: s.escalation, share_location: !!s.share_location, share_url: shareUrl(s.share_token), contacts });
    }
    return v;
  }
  const activeSession = (userId) => db.one("SELECT * FROM safety_sessions WHERE user_id = $1 AND status = 'active' ORDER BY id DESC LIMIT 1", [userId]);
  async function ownSession(req, id) {
    const s = await db.one("SELECT * FROM safety_sessions WHERE id = $1 AND user_id = $2", [id, req.user.id]);
    if (!s) throw new HttpError(404, "Safety session not found");
    return s;
  }
  // What's due next after a check-in.
  function nextDue(s, stage) {
    const arrival = toMs(s.expected_arrival), midway = s.midway_at ? toMs(s.midway_at) : null;
    if (stage === "departure") return midway && !s.midway_done_at && midway > Date.now() ? { kind: "midway", at: midway } : { kind: "arrival", at: arrival };
    if (stage === "midway") return { kind: "arrival", at: arrival };
    return null;
  }

  // ---------------- the watcher: missed check-ins & overdue arrivals ----------------
  // Runs from /api/cron/safety-sweep (external scheduler, recommended every 1–2 min), and opportunistically
  // (at most once a minute per server instance) whenever members sync or someone opens a share link.
  let lastSweep = 0;
  async function sweep(now = Date.now()) {
    lastSweep = now;
    const out = { prompted: 0, escalated: 0, ended: 0 };
    // 1) A check-in is overdue → ask the traveller first.
    const due = await db.query(`SELECT s.*, u.name AS user_name FROM safety_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.status = 'active' AND s.missed_stage = 0 AND s.due_at IS NOT NULL AND s.due_at < $1`, [new Date(now - GRACE_MS).toISOString()]);
    for (const s of due) {
      const r = await db.query("UPDATE safety_sessions SET missed_stage = 1, missed_at = $2 WHERE id = $1 AND missed_stage = 0 RETURNING id", [s.id, new Date(now).toISOString()]);
      if (!r.length) continue;   // another instance got there first
      await event(s.id, "missed_prompt", s.due_kind);
      const what = s.due_kind === "arrival" ? "You haven't checked in as arrived yet" : `You missed your ${s.due_kind} check-in`;
      await notify(s.user_id, { type: "safety_checkin", title: "Are you OK? Tap to check in", body: `${what}. If you don't respond in 10 minutes we'll ${s.escalation === "contacts" ? "let your Saath Circle know" : "remind you again"}.`, link: "#/safety", ref: `safety:${s.id}` });
      out.prompted++;
    }
    // 2) No answer → follow the traveller's plan.
    const silent = await db.query(`SELECT s.*, u.name AS user_name FROM safety_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.status = 'active' AND s.missed_stage = 1 AND s.missed_at < $1`, [new Date(now - RESPOND_MS).toISOString()]);
    for (const s of silent) {
      const r = await db.query("UPDATE safety_sessions SET missed_stage = 2 WHERE id = $1 AND missed_stage = 1 RETURNING id", [s.id]);
      if (!r.length) continue;
      if (s.escalation === "contacts") {
        const name = firstName(s.user_name), overdue = s.due_kind === "arrival";
        const n = await emailContacts(s.id, () => ({
          subject: overdue ? `${name} hasn't checked in as arrived` : `${name} missed a safety check-in`,
          heading: overdue ? `${name} hasn't confirmed they arrived` : `${name} missed a check-in`,
          text: `${name} started a safety session${s.label ? ` for "${s.label}"` : ""} and ${overdue ? `was expected around ${fmtTime(s.expected_arrival, TZ)}` : `missed their ${s.due_kind} check-in`}. We asked them to respond and haven't heard back yet. This doesn't necessarily mean something is wrong — phones die and people get busy. Try calling ${name} first. If you can't reach them and you're worried, call 112.`,
          cta: "See their latest status", link: shareUrl(s.share_token),
        }));
        await event(s.id, "missed_escalated", `${n} contact${n === 1 ? "" : "s"} emailed`);
      } else {
        await event(s.id, "missed_reminder", "");
        await notify(s.user_id, { type: "safety_checkin", title: "Still there? Please check in", body: "You chose not to alert your circle automatically. Tap to check in or end the session.", link: "#/safety", ref: `safety:${s.id}` });
      }
      out.escalated++;
    }
    // 3) Forgotten sessions end themselves; location is wiped.
    const stale = await db.query("SELECT id FROM safety_sessions WHERE status = 'active' AND expected_arrival < $1", [new Date(now - AUTO_END_MS).toISOString()]);
    for (const s of stale) { await endSession(s.id, "auto_ended"); out.ended++; }
    return out;
  }
  const maybeSweep = async () => { if (Date.now() - lastSweep > 60_000) { try { await sweep(); } catch (err) { console.error("safety sweep failed:", err.message); } } };

  async function endSession(id, kind, status = "ended") {
    await db.query("UPDATE safety_sessions SET status = $2, ended_at = $3, due_kind = '', due_at = NULL, last_lat = NULL, last_lng = NULL, last_loc_at = NULL WHERE id = $1", [id, status, nowIso()]);
    await event(id, kind);
  }

  // ---------------- cases ----------------
  const parseEvidence = (s) => { try { const a = JSON.parse(s || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } };
  function cleanEvidence(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, 10).map((e) => {
      const kind = ["note", "link"].includes(e && e.kind) ? e.kind : "note";
      let value = clean(e && e.value, kind === "link" ? 300 : 500);
      if (kind === "link" && !/^https:\/\//i.test(value)) value = "";
      return value ? { kind, value } : null;
    }).filter(Boolean);
  }
  async function caseEvent(caseId, actorId, kind, body = "", internal = true) {
    await db.query("INSERT INTO safety_case_events (case_id, actor_id, kind, body, internal, created_at) VALUES ($1,$2,$3,$4,$5,$6)", [caseId, actorId, kind, clean(body, 1000), internal ? 1 : 0, nowIso()]);
    await db.query("UPDATE safety_cases SET updated_at = $2 WHERE id = $1", [caseId, nowIso()]);
  }
  async function alertTeam(c, reporterName) {
    if (!mailer.enabled()) return;
    const admins = adminEmails(); if (!admins.length) return;
    for (const to of admins) {
      await mailer.send({ to, subject: `[${c.severity.toUpperCase()}] Safety case #${c.id}: ${CASE_CATEGORIES[c.category].label}`,
        heading: `New ${c.severity} safety case #${c.id}`,
        text: `${CASE_CATEGORIES[c.category].label}, reported by ${reporterName}. Target first response: ${RESPONSE_TARGET[c.severity]}. Open the case queue to review it — case details stay inside SaathRide.`,
        cta: "Open the case", link: `/#/admin/cases/${c.id}`, footer: "You're getting this because your email is in ADMIN_EMAILS for this SaathRide site." });
    }
  }

  function register(app, { auth, optionalAuth, writeLimit, intParam }) {
    // QR code generator for the boarding QR (MIT, served from our own origin like the other vendor files).
    let qrPath = null; try { qrPath = require.resolve("qrcode-generator/qrcode.js"); } catch { qrPath = null; }
    app.get("/vendor/qrcode.js", (_req, res) => { if (!qrPath) return res.status(404).type("text").send("QR library not installed"); res.set("Cache-Control", "public, max-age=86400").type("application/javascript").sendFile(qrPath); });
    // Opportunistic watcher run (cheap; at most once a minute per instance).
    app.use(async (req, _res, next) => {
      if (req.method === "GET" && (req.path === "/api/sync" || req.path.startsWith("/api/safety/"))) await maybeSweep();
      next();
    });
    // External scheduler hook. Set CRON_SECRET and call with "Authorization: Bearer <secret>".
    app.all("/api/cron/safety-sweep", async (req, res) => {
      const secret = process.env.CRON_SECRET;
      const given = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (!secret || !sameCode(given, secret)) throw new HttpError(404, "Not found");
      res.json({ ok: true, ...(await sweep()) });
    });
    // Keyless heartbeat for free schedulers (GitHub Actions). Safe to expose: it only runs the same
    // throttled sweep the app already runs on normal traffic (at most once a minute) and returns nothing.
    app.all("/api/cron/tick", async (_req, res) => { await maybeSweep(); res.set("Cache-Control", "no-store").json({ ok: true }); });

    // ---- Saath Circle ----
    app.get("/api/circle", auth, async (req, res) => {
      const rows = await db.query("SELECT * FROM trusted_contacts WHERE user_id = $1 ORDER BY id", [req.user.id]);
      res.json({ contacts: rows.map(contactView), max: MAX_CONTACTS, email: mailer.enabled() });
    });
    app.post("/api/circle", auth, writeLimit("circle", 20), async (req, res) => {
      const b = req.body || {};
      const name = clean(b.name, 60), email = clean(b.email, 254).toLowerCase(), relation = clean(b.relation, 40);
      if (name.length < 2) throw bad("Add their name");
      if (!EMAIL_RE.test(email)) throw bad("Enter a valid email address");
      const me = await db.one("SELECT name, email FROM users WHERE id = $1", [req.user.id]);
      if (email === String(me.email).toLowerCase()) throw bad("Add someone else — this is your own email");
      const n = await db.one("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM trusted_contacts WHERE user_id = $1", [req.user.id]);
      if (n.n >= MAX_CONTACTS) throw bad(`You can have up to ${MAX_CONTACTS} trusted contacts`);
      if (await db.one("SELECT id FROM trusted_contacts WHERE user_id = $1 AND email = $2", [req.user.id, email])) throw new HttpError(409, "This person is already in your circle");
      const rows = await db.query("INSERT INTO trusted_contacts (user_id, name, email, relation, token, invited_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *", [req.user.id, name, email, relation, token(), nowIso()]);
      const sent = await sendInvite(rows[0], me);
      res.status(201).json({ contact: contactView(rows[0]), invited: !!sent.sent });
    });
    app.post("/api/circle/:id/resend", auth, writeLimit("circle-resend", 6), async (req, res) => {
      const c = await db.one("SELECT * FROM trusted_contacts WHERE id = $1 AND user_id = $2", [intParam(req.params.id), req.user.id]);
      if (!c) throw new HttpError(404, "Contact not found");
      if (c.status !== "pending") throw bad(c.status === "active" ? "They've already accepted" : "They chose not to be a contact — please respect that");
      if (!mailer.enabled()) throw new HttpError(503, "Email isn't switched on for this site yet");
      const me = await db.one("SELECT name FROM users WHERE id = $1", [req.user.id]);
      const r = await sendInvite(c, me);
      if (!r.sent) throw new HttpError(502, "Couldn't send the invitation right now");
      res.json({ ok: true });
    });
    app.delete("/api/circle/:id", auth, async (req, res) => {
      await db.query("DELETE FROM trusted_contacts WHERE id = $1 AND user_id = $2", [intParam(req.params.id), req.user.id]);
      res.json({ ok: true });
    });
    // The contact's page (no account needed). Plain HTML with a form — works in any mail app's browser.
    const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${title} · SaathRide</title>
      <link rel="stylesheet" href="/styles.css"/></head><body><main class="card narrow" style="margin:40px auto;max-width:520px"><h1 style="font-size:1.3rem">${title}</h1>${body}
      <p class="muted small mt12">SaathRide isn't an emergency service. If you think someone is in danger, call 112.</p></main></body></html>`;
    const esc = (x) => String(x ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    app.get("/c/:token", async (req, res) => {
      const c = await db.one("SELECT c.*, u.name AS owner_name FROM trusted_contacts c JOIN users u ON u.id = c.user_id WHERE c.token = $1", [String(req.params.token)]);
      res.set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer");
      if (!c) return res.status(404).type("html").send(page("Link not found", "<p>This link is no longer valid — the invitation may have been withdrawn.</p>"));
      const who = esc(c.owner_name), state = c.status === "active" ? `<p class="notice">You're currently a trusted contact for ${who}.</p>` : c.status === "declined" ? `<p class="notice">You chose not to be a trusted contact for ${who}. You won't get emails.</p>` : "";
      res.type("html").send(page(`${who}'s Saath Circle`, `${state}
        <p>${who} would like you as a trusted contact on SaathRide. You'll only get an email when they start a safety session for a trip (with a private link to follow it until they arrive), check in or arrive, miss a check-in, or press SOS.</p>
        <p class="muted small">We never send marketing, and we don't share your email with anyone. You can change your mind with this same link at any time.</p>
        <form method="post" class="row mt12">${c.status !== "active" ? `<button class="btn" name="action" value="accept">Accept</button>` : ""}${c.status !== "declined" ? `<button class="btn ghost" name="action" value="decline">${c.status === "active" ? "Stop being a contact" : "No thanks"}</button>` : ""}</form>`));
    });
    app.post("/c/:token", require("express").urlencoded({ extended: false, limit: "2kb" }), async (req, res) => {
      const c = await db.one("SELECT c.*, u.name AS owner_name FROM trusted_contacts c JOIN users u ON u.id = c.user_id WHERE c.token = $1", [String(req.params.token)]);
      if (!c) return res.status(404).type("html").send(page("Link not found", "<p>This link is no longer valid.</p>"));
      const action = (req.body || {}).action === "accept" ? "active" : "declined";
      await db.query("UPDATE trusted_contacts SET status = $2, responded_at = $3 WHERE id = $1", [c.id, action, nowIso()]);
      await notify(c.user_id, { type: "safety_circle", title: action === "active" ? `${c.name} joined your Saath Circle` : `${c.name} isn't available as a trusted contact`, body: action === "active" ? "They'll get updates when you share a safety session with them." : "They won't receive any safety updates. You can add someone else.", link: "#/safety", ref: `circle:${c.id}` });
      res.set("Cache-Control", "no-store").type("html").send(page(action === "active" ? "Thank you" : "Done", action === "active"
        ? `<p>You're now a trusted contact for ${esc(c.owner_name)}. We'll only email you about their safety sessions.</p>`
        : `<p>You won't receive any emails about ${esc(c.owner_name)}'s journeys.</p>`));
    });

    // ---- safety sessions ----
    app.get("/api/safety/active", auth, async (req, res) => {
      const s = await activeSession(req.user.id);
      const recent = await db.query("SELECT * FROM safety_sessions WHERE user_id = $1 AND status <> 'active' ORDER BY id DESC LIMIT 5", [req.user.id]);
      res.json({ session: s ? await sessionView(s) : null, recent: await Promise.all(recent.map((r) => sessionView(r))) });
    });
    app.post("/api/safety/sessions", auth, writeLimit("safety-start", 20), async (req, res) => {
      const b = req.body || {}, me = req.user.id;
      if (await activeSession(me)) throw new HttpError(409, "You already have a safety session running. End it before starting another.");
      let tripId = null, label = clean(b.label, 80);
      if (b.trip_id != null) {
        tripId = Number(b.trip_id);
        const t = await db.one(`SELECT t.id, t.origin, t.destination, t.owner_id FROM trips t WHERE t.id = $1 AND (t.owner_id = $2 OR EXISTS
          (SELECT 1 FROM interests i WHERE i.trip_id = t.id AND i.user_id = $2 AND i.status = 'accepted'))`, [tripId, me]);
        if (!t) throw bad("You can only start a safety session for a journey you're part of");
        label = label || `${t.origin} → ${t.destination}`;
      }
      const minutes = Number(b.eta_minutes);
      if (!Number.isInteger(minutes) || minutes < 5 || minutes > 24 * 60) throw bad("Choose how long the journey should take (5 minutes to 24 hours)");
      const ids = Array.isArray(b.contact_ids) ? [...new Set(b.contact_ids.map(Number).filter(Number.isInteger))].slice(0, MAX_CONTACTS) : [];
      const contacts = ids.length ? await db.query(`SELECT id, status FROM trusted_contacts WHERE user_id = $1 AND id IN (${ids.map((_, i) => `$${i + 2}`).join(",")})`, [me, ...ids]) : [];
      if (contacts.length !== ids.length) throw bad("Choose contacts from your Saath Circle");
      const escalation = b.escalation === "self" ? "self" : "contacts";
      if (escalation === "contacts" && !contacts.some((c) => c.status === "active")) throw bad("Pick at least one contact who has accepted — or choose “Only remind me”");
      const now = Date.now(), arrival = now + minutes * 60_000;
      const midway = minutes >= 20 ? now + Math.round(minutes / 2) * 60_000 : null;
      const rows = await db.query(`INSERT INTO safety_sessions (user_id, trip_id, label, share_token, escalation, share_location, started_at, expected_arrival, midway_at, due_kind, due_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'departure',$10) RETURNING *`,
        [me, tripId, label || "My journey", token(), escalation, b.share_location === false ? 0 : 1, new Date(now).toISOString(), new Date(arrival).toISOString(),
          midway ? new Date(midway).toISOString() : null, new Date(now + 10 * 60_000).toISOString()]);
      const s = rows[0];
      for (const c of contacts) await db.query("INSERT INTO safety_session_contacts (session_id, contact_id) VALUES ($1,$2)", [s.id, c.id]);
      await event(s.id, "started", `${contacts.length} contact${contacts.length === 1 ? "" : "s"}`);
      const user = await db.one("SELECT name FROM users WHERE id = $1", [me]);
      const n = await emailContacts(s.id, () => ({
        subject: `${firstName(user.name)} started a safety session`, heading: `${firstName(user.name)} is sharing a journey with you`,
        text: `${s.label}. Expected to arrive around ${fmtTime(s.expected_arrival, TZ)}. You can follow their check-ins${s.share_location ? " and live location" : ""} until they arrive — we'll email you when they do, or if they miss a check-in.`,
        cta: "Follow the journey", link: shareUrl(s.share_token),
      }));
      res.status(201).json({ session: await sessionView(s), contacts_emailed: n });
    });
    app.post("/api/safety/sessions/:id/checkin", auth, writeLimit("safety-checkin", 120), async (req, res) => {
      const s = await ownSession(req, intParam(req.params.id));
      if (s.status !== "active") throw bad("This safety session has ended");
      const stage = ["departure", "midway", "arrival", "ok"].includes((req.body || {}).stage) ? req.body.stage : null;
      if (!stage) throw bad("Unknown check-in");
      const now = nowIso(), wasEscalated = s.missed_stage === 2, user = await db.one("SELECT name FROM users WHERE id = $1", [req.user.id]);
      const name = firstName(user.name);
      if (stage === "arrival") {
        await db.query("UPDATE safety_sessions SET last_checkin_at = $2, missed_stage = 0 WHERE id = $1", [s.id, now]);
        await endSession(s.id, "arrived", "arrived");
        await emailContacts(s.id, () => ({ subject: `${name} arrived safely`, heading: `${name} has arrived`, text: `${name} checked in as arrived${s.label ? ` (${s.label})` : ""}. The safety session has ended and location sharing has stopped.`, cta: "See the summary", link: shareUrl(s.share_token) }));
      } else {
        // departure/midway move the plan forward; "ok" answers a prompt. Either way, any missed state clears.
        const patch = stage === "departure" ? { departed_at: now } : stage === "midway" ? { midway_done_at: now } : {};
        let due = stage === "ok" ? (s.due_kind === "departure" ? nextDue(s, "departure") : { kind: s.due_kind, at: toMs(s.due_at) }) : nextDue(s, stage);
        // Answering an overdue-arrival prompt gives 15 more minutes before we ask again.
        if (due && due.at < Date.now()) due = { kind: due.kind, at: Date.now() + 15 * 60_000 };
        const sets = { ...patch, last_checkin_at: now, missed_stage: 0, missed_at: null, due_kind: due ? due.kind : "", due_at: due ? new Date(due.at).toISOString() : null };
        const keys = Object.keys(sets);
        await db.query(`UPDATE safety_sessions SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`, [s.id, ...keys.map((k) => sets[k])]);
        await event(s.id, `checkin_${stage}`);
        if (stage === "departure") await emailContacts(s.id, () => ({ subject: `${name} has set off`, heading: `${name} checked in at departure`, text: `${s.label}. Expected to arrive around ${fmtTime(s.expected_arrival, TZ)}.`, cta: "Follow the journey", link: shareUrl(s.share_token) }));
        if (wasEscalated) await emailContacts(s.id, () => ({ subject: `${name} checked in — they're OK`, heading: `${name} has checked in`, text: `${name} responded and says they're OK. Thanks for looking out for them.`, cta: "See their status", link: shareUrl(s.share_token) }));
      }
      res.json({ session: await sessionView(await db.one("SELECT * FROM safety_sessions WHERE id = $1", [s.id])) });
    });
    app.post("/api/safety/sessions/:id/extend", auth, writeLimit("safety-extend", 30), async (req, res) => {
      const s = await ownSession(req, intParam(req.params.id));
      if (s.status !== "active") throw bad("This safety session has ended");
      const m = Number((req.body || {}).minutes);
      if (![10, 15, 30, 60].includes(m)) throw bad("Choose 10, 15, 30 or 60 minutes");
      const base = Math.max(toMs(s.expected_arrival), Date.now());
      const arrival = new Date(base + m * 60_000).toISOString();
      await db.query(`UPDATE safety_sessions SET expected_arrival = $2, missed_stage = 0, missed_at = NULL,
        due_at = CASE WHEN due_kind = 'arrival' THEN $2 ELSE due_at END WHERE id = $1`, [s.id, arrival]);
      await event(s.id, "extended", `+${m} min`);
      res.json({ session: await sessionView(await db.one("SELECT * FROM safety_sessions WHERE id = $1", [s.id])) });
    });
    app.post("/api/safety/sessions/:id/location", auth, writeLimit("safety-loc", 600), async (req, res) => {
      const s = await ownSession(req, intParam(req.params.id));
      if (s.status !== "active" || !s.share_location) return res.json({ ok: false });
      const lat = Number((req.body || {}).lat), lng = Number((req.body || {}).lng);
      if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) throw bad("Invalid location");
      await db.query("UPDATE safety_sessions SET last_lat = $2, last_lng = $3, last_loc_at = $4 WHERE id = $1", [s.id, Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5, nowIso()]);
      res.json({ ok: true });
    });
    app.post("/api/safety/sessions/:id/sharing", auth, async (req, res) => {
      const s = await ownSession(req, intParam(req.params.id));
      const on = !!(req.body || {}).share_location;
      await db.query(`UPDATE safety_sessions SET share_location = $2${on ? "" : ", last_lat = NULL, last_lng = NULL, last_loc_at = NULL"} WHERE id = $1`, [s.id, on ? 1 : 0]);
      await event(s.id, on ? "location_on" : "location_off");
      res.json({ ok: true });
    });
    app.post("/api/safety/sessions/:id/end", auth, async (req, res) => {
      const s = await ownSession(req, intParam(req.params.id));
      if (s.status === "active") {
        await endSession(s.id, "ended_by_user");
        const user = await db.one("SELECT name FROM users WHERE id = $1", [req.user.id]);
        await emailContacts(s.id, () => ({ subject: `${firstName(user.name)} ended their safety session`, heading: `${firstName(user.name)} ended the safety session`, text: `${firstName(user.name)} stopped sharing${s.label ? ` "${s.label}"` : ""}. Location sharing has stopped.`, cta: "See the summary", link: shareUrl(s.share_token) }));
      }
      res.json({ ok: true });
    });
    // SOS: alert the session's contacts (or the whole accepted circle when no session is running) straight away.
    app.post("/api/safety/sos", auth, writeLimit("safety-sos", 10), async (req, res) => {
      const me = req.user.id;
      const user = await db.one("SELECT name FROM users WHERE id = $1", [me]);
      const name = firstName(user.name);
      let s = await activeSession(me);
      const b = req.body || {};
      if (!s) {
        // No session: open a short one so contacts get a live link, shared with every accepted contact.
        const contacts = await db.query("SELECT id FROM trusted_contacts WHERE user_id = $1 AND status = 'active'", [me]);
        const now = Date.now();
        const rows = await db.query(`INSERT INTO safety_sessions (user_id, label, share_token, escalation, share_location, started_at, expected_arrival, due_kind)
          VALUES ($1,'SOS',$2,'contacts',1,$3,$4,'') RETURNING *`, [me, token(), new Date(now).toISOString(), new Date(now + 60 * 60_000).toISOString()]);
        s = rows[0];
        for (const c of contacts) await db.query("INSERT INTO safety_session_contacts (session_id, contact_id) VALUES ($1,$2)", [s.id, c.id]);
      }
      const lat = Number(b.lat), lng = Number(b.lng);
      if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && b.lat != null) await db.query("UPDATE safety_sessions SET last_lat = $2, last_lng = $3, last_loc_at = $4, share_location = 1 WHERE id = $1", [s.id, lat, lng, nowIso()]);
      await db.query("UPDATE safety_sessions SET sos_at = $2 WHERE id = $1", [s.id, nowIso()]);
      await event(s.id, "sos");
      const n = await emailContacts(s.id, () => ({
        subject: `SOS from ${name} — please check on them now`, heading: `${name} pressed SOS on SaathRide`,
        text: `${name} pressed the SOS button just now${s.label && s.label !== "SOS" ? ` during "${s.label}"` : ""}. Please call ${name} right away. If you can't reach them, or you think they're in danger, call 112 and share the location from the link below.`,
        cta: "See their location and status", link: shareUrl(s.share_token),
      }));
      res.json({ ok: true, contacts_alerted: n, emergency_number: "112", session: await sessionView(await db.one("SELECT * FROM safety_sessions WHERE id = $1", [s.id])) });
    });
    // What a trusted contact sees (no account; the link is the key). Location only while active.
    app.get("/api/safety/share/:token", optionalAuth, async (req, res) => {
      const s = await db.one("SELECT s.*, u.name AS user_name FROM safety_sessions s JOIN users u ON u.id = s.user_id WHERE s.share_token = $1", [String(req.params.token)]);
      if (!s || (s.status !== "active" && Date.now() - toMs(s.ended_at) > SHARE_AFTER_END_MS)) throw new HttpError(404, "This safety link has expired");
      res.set("Cache-Control", "no-store");
      res.json({ name: firstName(s.user_name), ...(await sessionView(s, { owner: false })) });
    });

    // ---- QR boarding confirmation ----
    app.get("/api/trips/:id/boarding", auth, async (req, res) => {
      const id = intParam(req.params.id);
      const t = await db.one("SELECT id, owner_id FROM trips WHERE id = $1", [id]);
      if (!t || t.owner_id !== req.user.id) throw new HttpError(404, "Trip not found");
      let row = await db.one("SELECT code FROM trip_boarding_codes WHERE trip_id = $1", [id]);
      if (!row) {
        const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no 0/O or 1/I
        const code = Array.from(crypto.randomBytes(6), (x) => alphabet[x % alphabet.length]).join("");
        await db.query("INSERT INTO trip_boarding_codes (trip_id, code, created_at) VALUES ($1,$2,$3) ON CONFLICT (trip_id) DO NOTHING", [id, code, nowIso()]);
        row = await db.one("SELECT code FROM trip_boarding_codes WHERE trip_id = $1", [id]);
      }
      const boarded = await db.query("SELECT b.user_id, u.name, b.boarded_at FROM trip_boardings b JOIN users u ON u.id = b.user_id WHERE b.trip_id = $1 ORDER BY b.boarded_at", [id]);
      res.json({ code: row.code, url: `${appUrl() || ""}/#/board/${id}/${row.code}`, boarded: boarded.map((r) => ({ id: r.user_id, name: r.name, at: iso(r.boarded_at) })) });
    });
    app.post("/api/trips/:id/board", auth, writeLimit("board", 20), async (req, res) => {
      const id = intParam(req.params.id), me = req.user.id;
      const trip = await getTrip(id, me);
      if (!trip) throw new HttpError(404, "Trip not found");
      const ok = await db.one("SELECT id FROM interests WHERE trip_id = $1 AND user_id = $2 AND status = 'accepted'", [id, me]);
      if (!ok) throw new HttpError(403, "Only confirmed passengers can confirm boarding for this journey");
      const row = await db.one("SELECT code FROM trip_boarding_codes WHERE trip_id = $1", [id]);
      const given = clean((req.body || {}).code, 12).toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!row || !sameCode(given, row.code)) throw new HttpError(400, "This code doesn't match this journey. Don't board — check the vehicle and driver with the trip owner in chat.");
      await db.query("INSERT INTO trip_boardings (trip_id, user_id, boarded_at) VALUES ($1,$2,$3) ON CONFLICT (trip_id, user_id) DO NOTHING", [id, me, nowIso()]);
      const s = await activeSession(me);
      if (s && (!s.trip_id || s.trip_id === id)) {
        await db.query("UPDATE safety_sessions SET boarded_at = $2, trip_id = COALESCE(trip_id, $3) WHERE id = $1", [s.id, nowIso(), id]);
        await event(s.id, "boarded", `${trip.vehicle_type}${trip.vehicle_model ? ` · ${trip.vehicle_model}` : ""} with ${trip.owner.name}`);
        const user = await db.one("SELECT name FROM users WHERE id = $1", [me]);
        await emailContacts(s.id, () => ({ subject: `${firstName(user.name)} boarded the expected vehicle`, heading: `${firstName(user.name)} confirmed boarding`,
          text: `${firstName(user.name)} scanned the trip code and confirmed they're in the expected vehicle (${trip.vehicle_type}${trip.vehicle_model ? `, ${trip.vehicle_model}` : ""}) with ${trip.owner.name}.`, cta: "Follow the journey", link: shareUrl(s.share_token) }));
      }
      const user = await db.one("SELECT name FROM users WHERE id = $1", [me]);
      await notify(trip.owner.id, { type: "safety_boarded", title: `${user.name} confirmed boarding`, body: `${trip.origin} → ${trip.destination}`, link: `#/trip/${id}`, ref: `board:${id}:${me}`, actorId: me });
      res.json({ ok: true, trip: { id, route: `${trip.origin} → ${trip.destination}`, vehicle: trip.vehicle_type, vehicle_model: trip.vehicle_model, owner: trip.owner.name }, session_updated: !!s });
    });

    // ---- safety cases (reporters) ----
    app.get("/api/safety/case-options", auth, (_req, res) => res.json({ categories: Object.entries(CASE_CATEGORIES).map(([k, v]) => ({ key: k, ...v, target: RESPONSE_TARGET[v.severity] })) }));
    app.post("/api/safety/cases", auth, writeLimit("case", 10, 24 * 3600_000), async (req, res) => {
      const b = req.body || {}, me = req.user.id;
      const category = Object.hasOwn(CASE_CATEGORIES, b.category) ? b.category : null;
      if (!category) throw bad("Choose what happened");
      const description = clean(b.description, 3000);
      if (description.length < 10) throw bad("Tell us a little about what happened (at least a sentence)");
      let subjectId = b.subject_id != null ? Number(b.subject_id) : null;
      if (subjectId === me) throw bad("You can't report yourself");
      if (subjectId != null && !(await db.one("SELECT id FROM users WHERE id = $1", [subjectId]))) throw bad("That member wasn't found");
      const tripId = b.trip_id != null && (await db.one("SELECT id FROM trips WHERE id = $1", [Number(b.trip_id)])) ? Number(b.trip_id) : null;
      // A conversation can be attached only by someone in it (the reporter shares it with the team).
      let convId = null;
      if (b.conversation_id != null) {
        const cv = await db.one("SELECT id, owner_id, member_id FROM conversations WHERE id = $1", [Number(b.conversation_id)]);
        if (!cv || (cv.owner_id !== me && cv.member_id !== me)) throw bad("You can only attach your own conversations");
        convId = cv.id; if (subjectId == null) subjectId = cv.owner_id === me ? cv.member_id : cv.owner_id;
      }
      const severity = CASE_CATEGORIES[category].severity;
      const rows = await db.query(`INSERT INTO safety_cases (reporter_id, subject_id, trip_id, conversation_id, category, severity, description, evidence, happened_on, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING *`,
        [me, subjectId, tripId, convId, category, severity, description, JSON.stringify(cleanEvidence(b.evidence)), /^\d{4}-\d{2}-\d{2}$/.test(b.happened_on || "") ? b.happened_on : "", nowIso()]);
      const c = rows[0];
      await caseEvent(c.id, me, "created", `${CASE_CATEGORIES[category].label} · ${severity}`, false);
      if (b.block && subjectId) await db.query("INSERT INTO blocked_users (blocker_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [me, subjectId]);
      const reporter = await db.one("SELECT name FROM users WHERE id = $1", [me]);
      if (severity === "critical" || severity === "high") await alertTeam(c, reporter.name);
      res.status(201).json({ case: { id: c.id, category, severity, status: c.status, target: RESPONSE_TARGET[severity] }, blocked: !!(b.block && subjectId) });
    });
    app.get("/api/safety/cases/mine", auth, async (req, res) => {
      const rows = await db.query("SELECT * FROM safety_cases WHERE reporter_id = $1 ORDER BY id DESC LIMIT 30", [req.user.id]);
      const out = [];
      for (const c of rows) {
        const ev = await db.query("SELECT kind, body, created_at FROM safety_case_events WHERE case_id = $1 AND internal = 0 ORDER BY id", [c.id]);
        out.push({ id: c.id, category: c.category, category_label: CASE_CATEGORIES[c.category].label, status: c.status, status_label: STATUS_LABEL[c.status], target: RESPONSE_TARGET[c.severity], created_at: iso(c.created_at), outcome: c.status === "action_taken" || c.status === "closed" ? c.outcome : "", updates: ev.map((e) => ({ kind: e.kind, body: e.body, at: iso(e.created_at) })) });
      }
      res.json({ cases: out });
    });

    // ---- safety cases (team: ADMIN_EMAILS only; 404 for everyone else) ----
    app.get("/api/admin/cases", auth, async (req, res) => {
      await requireAdmin(req);
      const open = req.query.status !== "all";
      const rows = await db.query(`SELECT c.*, r.name AS reporter_name, s.name AS subject_name, s.username AS subject_username
        FROM safety_cases c LEFT JOIN users r ON r.id = c.reporter_id LEFT JOIN users s ON s.id = c.subject_id
        ${open ? "WHERE c.status <> 'closed'" : ""} ORDER BY c.id DESC LIMIT 200`, []);
      rows.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || toMs(a.created_at) - toMs(b.created_at));
      res.json({ cases: rows.map((c) => ({ id: c.id, category: c.category, category_label: CASE_CATEGORIES[c.category].label, severity: c.severity, status: c.status,
        reporter: c.reporter_name, subject: c.subject_name ? { id: c.subject_id, name: c.subject_name, username: c.subject_username } : null,
        created_at: iso(c.created_at), updated_at: iso(c.updated_at), target: RESPONSE_TARGET[c.severity],
        overdue: c.status === "new" && Date.now() - toMs(c.created_at) > ({ critical: 1, high: 12, medium: 48, low: 120 }[c.severity]) * 3600_000 })),
        statuses: CASE_STATUSES, severities: SEVERITIES, categories: CASE_CATEGORIES });
    });
    app.get("/api/admin/cases/:id", auth, async (req, res) => {
      await requireAdmin(req);
      const c = await db.one(`SELECT c.*, r.name AS reporter_name, r.username AS reporter_username, s.name AS subject_name, s.username AS subject_username, s.suspended_at AS subject_suspended
        FROM safety_cases c LEFT JOIN users r ON r.id = c.reporter_id LEFT JOIN users s ON s.id = c.subject_id WHERE c.id = $1`, [intParam(req.params.id)]);
      if (!c) throw new HttpError(404, "Case not found");
      const [events, prior, messages, trip] = await Promise.all([
        db.query("SELECT e.*, u.name AS actor_name FROM safety_case_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.case_id = $1 ORDER BY e.id", [c.id]),
        c.subject_id ? db.query("SELECT id, category, severity, status, created_at FROM safety_cases WHERE subject_id = $1 AND id <> $2 ORDER BY id DESC LIMIT 10", [c.subject_id, c.id]) : [],
        // Shared by the reporter when they attached the conversation.
        c.conversation_id ? db.query(`SELECT m.sender_id, u.name AS sender_name, m.kind, m.body, m.created_at FROM conversations cv
          JOIN messages m ON m.trip_id = cv.trip_id AND m.thread_user_id = cv.member_id LEFT JOIN users u ON u.id = m.sender_id
          WHERE cv.id = $1 ORDER BY m.id DESC LIMIT 40`, [c.conversation_id]) : [],
        c.trip_id ? db.one("SELECT id, origin, destination, depart_date, depart_time, vehicle_type, vehicle_model, owner_id FROM trips WHERE id = $1", [c.trip_id]) : null,
      ]);
      const userReports = c.subject_id ? await db.one("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM user_reports WHERE reported_id = $1", [c.subject_id]) : { n: 0 };
      res.json({ case: {
        id: c.id, category: c.category, category_label: CASE_CATEGORIES[c.category].label, severity: c.severity, status: c.status, description: c.description,
        evidence: parseEvidence(c.evidence), happened_on: c.happened_on, outcome: c.outcome, created_at: iso(c.created_at), target: RESPONSE_TARGET[c.severity],
        reporter: c.reporter_id ? { id: c.reporter_id, name: c.reporter_name, username: c.reporter_username } : null,
        subject: c.subject_id ? { id: c.subject_id, name: c.subject_name, username: c.subject_username, suspended: !!c.subject_suspended, prior_cases: prior.map((p) => ({ ...p, created_at: iso(p.created_at) })), member_reports: userReports.n } : null,
        trip: trip ? { ...trip, route: `${trip.origin} → ${trip.destination}` } : null,
        conversation: messages.reverse().map((m) => ({ from: m.sender_name || "SaathRide", kind: m.kind, body: m.body, at: iso(m.created_at) })),
        events: events.map((e) => ({ kind: e.kind, body: e.body, internal: !!e.internal, by: e.actor_name, at: iso(e.created_at) })),
      } });
    });
    app.patch("/api/admin/cases/:id", auth, async (req, res) => {
      await requireAdmin(req);
      const id = intParam(req.params.id), b = req.body || {}, me = req.user.id;
      const c = await db.one("SELECT * FROM safety_cases WHERE id = $1", [id]);
      if (!c) throw new HttpError(404, "Case not found");
      if (b.status != null) {
        if (!CASE_STATUSES.includes(b.status)) throw bad("Unknown status");
        if (b.status !== c.status) {
          const outcome = clean(b.outcome, 1000);
          if ((b.status === "action_taken" || b.status === "closed") && !outcome && !c.outcome) throw bad("Write the outcome before closing or recording action");
          await db.query("UPDATE safety_cases SET status = $2, outcome = CASE WHEN $3 = '' THEN outcome ELSE $3 END WHERE id = $1", [id, b.status, outcome]);
          await caseEvent(id, me, "status", `${STATUS_LABEL[b.status]}${outcome ? ` — ${outcome}` : ""}`, false);
          if (c.reporter_id) await notify(c.reporter_id, { type: "case_update", title: `Your safety report #${id}: ${STATUS_LABEL[b.status]}`, body: outcome || "Open SaathRide to see the latest on your report.", link: "#/safety?tab=reports", ref: `case:${id}` });
        }
      }
      if (b.severity != null && b.severity !== c.severity) {
        if (!SEVERITIES.includes(b.severity)) throw bad("Unknown severity");
        await db.query("UPDATE safety_cases SET severity = $2 WHERE id = $1", [id, b.severity]);
        await caseEvent(id, me, "severity", `${c.severity} → ${b.severity}`);
      }
      if (b.assign_to_me) { await db.query("UPDATE safety_cases SET assignee_id = $2 WHERE id = $1", [id, me]); await caseEvent(id, me, "assign", "Assigned to self"); }
      if (b.note) await caseEvent(id, me, "note", clean(b.note, 1000));
      if (b.message_to_reporter && c.reporter_id) {
        const msg = clean(b.message_to_reporter, 1000);
        await caseEvent(id, me, "message_to_reporter", msg, false);
        await notify(c.reporter_id, { type: "case_update", title: `Update on your safety report #${id}`, body: msg, link: "#/safety?tab=reports", ref: `case:${id}` });
      }
      if (b.suspend_subject != null && c.subject_id) {
        const on = !!b.suspend_subject;
        await db.query("UPDATE users SET suspended_at = $2 WHERE id = $1", [c.subject_id, on ? nowIso() : null]);
        if (forgetSuspension) forgetSuspension(c.subject_id);
        await caseEvent(id, me, on ? "suspended" : "unsuspended", on ? "Account suspended; open journeys cancelled" : "Suspension lifted");
        if (on) {
          const trips = await db.query("SELECT id, origin, destination FROM trips WHERE owner_id = $1 AND status = 'open'", [c.subject_id]);
          for (const t of trips) {
            await db.query("UPDATE trips SET status = 'cancelled' WHERE id = $1", [t.id]);
            const riders = await db.query("SELECT user_id FROM interests WHERE trip_id = $1 AND status IN ('pending','accepted')", [t.id]);
            for (const r of riders) await notify(r.user_id, { type: "trip_cancelled", title: "A journey you joined was cancelled", body: `${t.origin} → ${t.destination} was cancelled by the SaathRide safety team. Please make other plans.`, link: `#/`, ref: `trip:${t.id}` });
          }
        }
      }
      res.json({ ok: true });
    });
  }

  return { register, sweep, maybeSweep, CASE_CATEGORIES, RESPONSE_TARGET };
}

module.exports = { createSafety, CASE_CATEGORIES, RESPONSE_TARGET, GRACE_MS, RESPOND_MS };
