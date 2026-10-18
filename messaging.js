// SaathRide — private conversations, notifications, blocking, member reports and voice calls.
// Everything here is scoped to the signed-in user: a conversation, message, notification or call is only
// ever returned to the people it belongs to, and anything else answers 404 so ids can't be probed.
// Message text is never logged.
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const MESSAGE_MAX = 1000;
const RING_SECONDS = 40;              // an unanswered call becomes "missed" after this
const STALE_CALL_MS = 4 * 3600_000;   // an "active" call nobody ended is closed after 4h
const NOTIF_TYPES = new Set([
  "interest_request", "interest_accepted", "interest_declined", "interest_withdrawn",
  "new_message", "trip_changed", "trip_cancelled", "trip_completed", "call_missed", "trip_update", "route_match",
  "safety_checkin", "safety_circle", "safety_boarded", "case_update", "memory_created", "memory_highlight",
]);
// Safety prompts, case updates and cancellations always reach the member — they can't be switched off.
const ALWAYS_DELIVERED = new Set(["trip_cancelled", "safety_checkin", "safety_circle", "safety_boarded", "case_update"]);
// Notification categories members can switch off (Edit profile → Notifications).
const NOTIF_CATEGORY = {
  interest_request: "requests", interest_accepted: "requests", interest_declined: "requests", interest_withdrawn: "requests",
  new_message: "messages", trip_changed: "trips", trip_cancelled: "trips", trip_completed: "trips", trip_update: "trip_updates",
  route_match: "route_matches", call_missed: "calls",
  safety_checkin: "safety", safety_circle: "safety", safety_boarded: "safety", case_update: "safety",
  memory_created: "memories", memory_highlight: "memories",
};
const parsePrefs = (s) => { try { const o = JSON.parse(s || "{}"); return o && typeof o === "object" ? o : {}; } catch { return {}; } };
const REPORT_REASONS = ["spam", "unsafe", "harassment", "fake", "inappropriate", "other"];

// Timestamps come back as Date (pg) or "YYYY-MM-DD HH:MM:SS" UTC text (SQLite in tests): always send ISO.
function iso(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  return s.includes("T") ? s : s.replace(" ", "T") + "Z";
}
const ms = (v) => (v == null ? 0 : Date.parse(iso(v)));
const nowIso = () => new Date().toISOString();

// ---------- LiveKit (optional) ----------
function livekitEnv() {
  return { url: process.env.LIVEKIT_URL || "", key: process.env.LIVEKIT_API_KEY || "", secret: process.env.LIVEKIT_API_SECRET || "" };
}
function findLivekitSdk() {
  for (const id of ["livekit-client/dist/livekit-client.umd.js", "livekit-client"]) {
    try { const p = require.resolve(id); if (/\.c?js$/.test(p)) return p; } catch { /* not installed */ }
  }
  return null;
}
// Origins the browser must be allowed to connect to for LiveKit signalling (added to the CSP).
function livekitConnectSources() {
  const { url } = livekitEnv();
  try {
    const u = new URL(url);
    if (!/^wss?:$/.test(u.protocol)) return [];
    const out = [`${u.protocol}//${u.host}`, `${u.protocol === "wss:" ? "https:" : "http:"}//${u.host}`];
    if (u.hostname.endsWith(".livekit.cloud")) out.push("wss://*.livekit.cloud", "https://*.livekit.cloud");
    return out;
  } catch { return []; }
}

function createMessaging({ db, HttpError, bad, clean, sdkPath = findLivekitSdk(), mailer = null }) {
  const lk = () => {
    const e = livekitEnv();
    const urlOk = /^wss:\/\//.test(e.url) || /^ws:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(e.url);
    return { ...e, enabled: !!(urlOk && e.key && e.secret && sdkPath) };
  };
  const callsEnabled = () => lk().enabled;
  // Explains to the UI why calls are off without revealing any secret.
  function callsStatus() {
    const e = livekitEnv();
    if (lk().enabled) return "ready";
    if (!e.url || !e.key || !e.secret) return "not_configured";
    if (!sdkPath) return "sdk_missing";
    return "bad_url";
  }
  function livekitToken({ identity, name, room }) {
    const { key, secret } = lk();
    return jwt.sign(
      { name, video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false, canPublishSources: ["microphone"] } },
      secret, { algorithm: "HS256", issuer: key, subject: identity, jwtid: `${identity}-${crypto.randomBytes(6).toString("hex")}`, expiresIn: 2 * 3600, notBefore: 0 });
  }

  // ---------- blocking ----------
  async function blockState(me, other, q = db) {
    const rows = await q.query("SELECT blocker_id FROM blocked_users WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)", [me, other]);
    return { byMe: rows.some((r) => r.blocker_id === me), byThem: rows.some((r) => r.blocker_id === other) };
  }
  async function assertNotBlocked(me, other) {
    const b = await blockState(me, other);
    if (b.byMe) throw new HttpError(403, "You've blocked this member. Unblock them first.");
    if (b.byThem) throw new HttpError(403, "You can't contact this member.");
  }

  // ---------- notifications (only from real events) ----------
  async function notify(userId, { type, title, body = "", link = "", ref = "", actorId = null }) {
    try {
      if (!NOTIF_TYPES.has(type) || !userId || userId === actorId) return;
      if (actorId && (await blockState(userId, actorId)).byMe) return;        // never notify about someone you blocked
      const u = await db.one("SELECT email, notif_prefs, email_verified_at, last_active_at FROM users WHERE id = $1", [userId]);
      // Members can switch categories off; cancellations of trips they're involved in are always delivered.
      if (!u || (!ALWAYS_DELIVERED.has(type) && parsePrefs(u.notif_prefs)[NOTIF_CATEGORY[type]] === false)) return;
      if (ref) await db.query("DELETE FROM notifications WHERE user_id = $1 AND ref = $2 AND read_at IS NULL", [userId, ref]); // collapse repeats
      await db.query("INSERT INTO notifications (user_id, actor_id, type, title, body, link, ref) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [userId, actorId, type, clean(title, 120), clean(body, 240), clean(link, 120), ref]);
      await emailCopy(userId, u, { type, title, body, link, ref });
    } catch (err) { console.error("notify failed:", err.message); }
  }

  // ---------- email copies of notifications ----------
  // Sent only to confirmed addresses, only for events worth an email, and throttled. Message emails never
  // include the message itself (chats stay in the app) and are skipped while the person is using the app.
  const EMAIL = {
    interest_request: { cta: "Review the request", every: 10 }, interest_accepted: { cta: "Open the trip", every: 2 },
    interest_declined: { cta: "Find another journey", every: 2 }, new_message: { cta: "Open the chat", every: 30 },
    trip_changed: { cta: "See what changed", every: 10 }, trip_cancelled: { cta: "Open SaathRide", every: 2 },
    trip_update: { cta: "Open the trip", every: 5 }, route_match: { cta: "See the journey", every: 60 },
    safety_checkin: { cta: "Check in now", every: 1 }, safety_circle: { cta: "Open Saath Circle", every: 1 },
    case_update: { cta: "See your report", every: 1 }, memory_created: { cta: "See the memory", every: 60 },
  };
  async function emailCopy(userId, u, { type, title, body, link, ref }) {
    const rule = EMAIL[type];
    if (!rule || !mailer || !mailer.enabled() || !u.email || !u.email_verified_at) return;
    if (parsePrefs(u.notif_prefs).email === false) return;
    const now = Date.now();
    if (type === "new_message" && u.last_active_at && now - new Date(u.last_active_at).getTime() < 2 * 60_000) return;
    const key = `${type}:${ref || link}`;
    const since = new Date(now - rule.every * 60_000).toISOString();
    if (await db.one("SELECT id FROM email_log WHERE user_id = $1 AND key = $2 AND sent_at > $3", [userId, key, since])) return;
    await db.query("INSERT INTO email_log (user_id, key, sent_at) VALUES ($1,$2,$3)", [userId, key, new Date(now).toISOString()]);
    const text = type === "new_message" ? "Open the chat to read it — messages stay inside SaathRide." : body || "Open SaathRide to see the details.";
    await mailer.send({ to: u.email, subject: title, heading: title, text, cta: rule.cta, link });
  }

  // ---------- conversations ----------
  async function ensureConversation(tripId, memberId, createdBy, q = db) {
    const trip = await q.one("SELECT owner_id FROM trips WHERE id = $1", [tripId]);
    if (!trip) throw new HttpError(404, "Trip not found");
    if (trip.owner_id === memberId) throw bad("Invalid conversation");
    const now = nowIso();
    await q.query(`INSERT INTO conversations (trip_id, owner_id, member_id, created_by, last_activity_at, created_at) VALUES ($1,$2,$3,$4,$5,$5)
                   ON CONFLICT (trip_id, member_id) DO NOTHING`, [tripId, trip.owner_id, memberId, createdBy, now]);
    return q.one("SELECT * FROM conversations WHERE trip_id = $1 AND member_id = $2", [tripId, memberId]);
  }
  const findConversation = (tripId, memberId, q = db) => q.one("SELECT * FROM conversations WHERE trip_id = $1 AND member_id = $2", [tripId, memberId]);

  async function addMessage(conv, senderId, { kind = "text", body = "", sharedTripId = null }, q = db) {
    const now = nowIso();
    const [m] = await q.query(
      "INSERT INTO messages (trip_id, thread_user_id, sender_id, body, kind, shared_trip_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [conv.trip_id, conv.member_id, senderId, body, kind, sharedTripId, now]);
    const readCol = senderId === conv.owner_id ? "owner_last_read_id" : "member_last_read_id";   // you've "seen" what you sent
    await q.query(`UPDATE conversations SET last_activity_at = $1, ${readCol} = $2 WHERE id = $3`, [now, m.id, conv.id]);
    return { id: m.id, created_at: now };
  }
  // A short line inside the conversation about a real workflow event (request sent, accepted, trip changed…).
  async function postEvent(tripId, memberId, actorId, text, { create = false } = {}) {
    try {
      const conv = create ? await ensureConversation(tripId, memberId, actorId) : await findConversation(tripId, memberId);
      if (conv) await addMessage(conv, actorId, { kind: "event", body: clean(text, 300) });
      return conv;
    } catch (err) { console.error("conversation event failed:", err.message); return null; }
  }
  async function postEventToTrip(tripId, actorId, text) {
    const convs = await db.query("SELECT * FROM conversations WHERE trip_id = $1", [tripId]);
    for (const c of convs) await addMessage(c, actorId, { kind: "event", body: clean(text, 300) }).catch((e) => console.error("event failed:", e.message));
    return convs;
  }

  // Loads a conversation the caller belongs to; anyone else gets 404.
  async function access(me, convId) {
    const c = await db.one(
      `SELECT c.*, t.origin, t.destination, t.depart_date, t.depart_time, t.status AS trip_status, t.seats_total, t.contribution_inr, t.vehicle_type, t.women_only,
              (SELECT i.id FROM interests i WHERE i.trip_id = c.trip_id AND i.user_id = c.member_id) AS interest_id,
              (SELECT i.status FROM interests i WHERE i.trip_id = c.trip_id AND i.user_id = c.member_id) AS interest_status,
              CAST((SELECT COUNT(*) FROM trip_participants p WHERE p.trip_id = c.trip_id AND p.status = 'confirmed') AS INTEGER) AS confirmed_count
       FROM conversations c JOIN trips t ON t.id = c.trip_id WHERE c.id = $1`, [convId]);
    if (!c || (c.owner_id !== me && c.member_id !== me)) throw new HttpError(404, "Conversation not found");
    const role = c.owner_id === me ? "owner" : "member";
    const otherId = role === "owner" ? c.member_id : c.owner_id;
    const blocks = await blockState(me, otherId);
    let closed = "";
    if (blocks.byMe) closed = "You've blocked this member. Unblock them to send messages.";
    else if (blocks.byThem) closed = "You can't reply to this conversation.";
    else if (c.interest_status === "declined") closed = "This request was declined, so the conversation is closed.";
    return { c, role, otherId, blocks, closed };
  }

  async function callEligible(a) {
    if (!callsEnabled() || a.closed) return false;
    if (a.c.interest_status === "accepted") return true;
    const r = await db.one("SELECT CAST(COUNT(DISTINCT sender_id) AS INTEGER) AS n FROM messages WHERE trip_id = $1 AND thread_user_id = $2 AND kind = 'text'", [a.c.trip_id, a.c.member_id]);
    return r.n >= 2;   // both people have written at least once
  }
  const lastReadOf = (c, who) => (who === c.owner_id ? c.owner_last_read_id : c.member_last_read_id);

  async function sharedTrips(ids) {
    const uniq = [...new Set(ids.filter(Boolean))];
    if (!uniq.length) return new Map();
    const ph = uniq.map((_, i) => `$${i + 1}`).join(",");
    const rows = await db.query(`SELECT t.id, t.origin, t.destination, t.depart_date, t.depart_time, t.status, t.vehicle_type, u.name AS owner_name,
        (SELECT im.url FROM trip_images im WHERE im.trip_id = t.id ORDER BY im.position, im.id LIMIT 1) AS cover
      FROM trips t JOIN users u ON u.id = t.owner_id WHERE t.id IN (${ph})`, uniq);
    return new Map(rows.map((r) => [r.id, { id: r.id, origin: r.origin, destination: r.destination, depart_date: r.depart_date, depart_time: r.depart_time, status: r.status, vehicle_type: r.vehicle_type, owner_name: r.owner_name, cover: r.cover || null }]));
  }
  async function messageViews(rows, me) {
    const trips = await sharedTrips(rows.map((m) => m.shared_trip_id));
    return rows.map((m) => ({ id: m.id, kind: m.kind || "text", body: m.body, sender_id: m.sender_id, mine: m.sender_id === me, created_at: iso(m.created_at),
      shared_trip: m.shared_trip_id ? trips.get(m.shared_trip_id) || { id: m.shared_trip_id, removed: true } : (m.kind === "trip" ? { removed: true } : null) }));
  }

  async function detailView(a, me) {
    const { c } = a;
    const other = await db.one("SELECT id, name, username, avatar_url, avatar_color FROM users WHERE id = $1", [a.otherId]);
    const cover = await db.one("SELECT url FROM trip_images WHERE trip_id = $1 ORDER BY position, id LIMIT 1", [c.trip_id]);
    return {
      id: c.id, role: a.role,
      other: { id: other.id, name: other.name, username: other.username, avatar_url: other.avatar_url || null, avatar_color: other.avatar_color },
      trip: { id: c.trip_id, origin: c.origin, destination: c.destination, depart_date: c.depart_date, depart_time: c.depart_time, status: c.trip_status,
        vehicle_type: c.vehicle_type, contribution_inr: c.contribution_inr, women_only: !!c.women_only, cover: cover ? cover.url : null,
        seats_total: c.seats_total, seats_left: c.seats_total == null ? null : Math.max(0, c.seats_total - c.confirmed_count) },
      interest: c.interest_id ? { id: c.interest_id, status: c.interest_status } : null,
      can_send: !a.closed, closed_reason: a.closed,
      blocked_by_me: a.blocks.byMe,
      call_eligible: await callEligible(a), calls_enabled: callsEnabled(),
      other_last_read_id: lastReadOf(c, a.otherId),
      created_at: iso(c.created_at),
    };
  }

  // ---------- calls ----------
  async function tidyCalls(userIds) {
    const ph = userIds.map((_, i) => `$${i + 1}`).join(",");
    const rows = await db.query(`SELECT * FROM calls WHERE status IN ('ringing','active') AND (caller_id IN (${ph}) OR callee_id IN (${ph}))`, userIds);
    const now = Date.now();
    for (const r of rows) {
      if (r.status === "ringing" && now - ms(r.created_at) > RING_SECONDS * 1000) {
        const done = await db.query("UPDATE calls SET status = 'missed', end_reason = 'no_answer', ended_at = $1 WHERE id = $2 AND status = 'ringing' RETURNING id", [nowIso(), r.id]);
        if (done.length) await missedCallNotice(r);
      } else if (r.status === "active" && now - ms(r.answered_at || r.created_at) > STALE_CALL_MS) {
        await db.query("UPDATE calls SET status = 'ended', end_reason = 'stale', ended_at = $1 WHERE id = $2 AND status = 'active'", [nowIso(), r.id]);
      }
    }
  }
  async function missedCallNotice(call) {
    const caller = await db.one("SELECT name FROM users WHERE id = $1", [call.caller_id]);
    await notify(call.callee_id, { type: "call_missed", title: "Missed call", body: `${caller ? caller.name : "Someone"} tried to call you`, link: `#/inbox/${call.conversation_id}`, actorId: call.caller_id, ref: `call:${call.conversation_id}` });
  }
  async function callView(call, me) {
    const otherId = call.caller_id === me ? call.callee_id : call.caller_id;
    const other = await db.one("SELECT id, name, username, avatar_url, avatar_color FROM users WHERE id = $1", [otherId]);
    return { id: call.id, conversation_id: call.conversation_id, status: call.status, end_reason: call.end_reason || "", direction: call.caller_id === me ? "outgoing" : "incoming",
      created_at: iso(call.created_at), answered_at: iso(call.answered_at), ended_at: iso(call.ended_at), ring_seconds: RING_SECONDS,
      other: other ? { id: other.id, name: other.name, username: other.username, avatar_url: other.avatar_url || null, avatar_color: other.avatar_color } : null };
  }
  async function myCall(me, id) {
    await tidyCalls([me]);
    const call = await db.one("SELECT * FROM calls WHERE id = $1", [id]);
    if (!call || (call.caller_id !== me && call.callee_id !== me)) throw new HttpError(404, "Call not found");
    return call;
  }
  async function unreadMessages(me) {
    const r = await db.one(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM messages m JOIN conversations c ON c.trip_id = m.trip_id AND c.member_id = m.thread_user_id
      WHERE (c.owner_id = $1 OR c.member_id = $1) AND m.sender_id <> $1 AND m.id > CASE WHEN c.owner_id = $1 THEN c.owner_last_read_id ELSE c.member_last_read_id END`, [me]);
    return r.n;
  }

  // ---------- routes ----------
  function register(app, { auth, writeLimit, intParam, likeEscape, L }) {
    // Serve the LiveKit browser SDK from our own origin (keeps the CSP 'self'-only for scripts).
    app.get("/vendor/livekit-client.js", (_req, res) => {
      if (!sdkPath) return res.status(404).type("text").send("LiveKit SDK not installed");
      res.set("Cache-Control", "public, max-age=86400").type("application/javascript").sendFile(sdkPath);
    });

    // One cheap poll for badges and incoming calls.
    app.get("/api/sync", auth, async (req, res) => {
      const me = req.user.id;
      await tidyCalls([me]);
      // Coarse "is in the app" marker (at most one write a minute) so message emails aren't sent mid-chat.
      await db.query("UPDATE users SET last_active_at = $2 WHERE id = $1 AND (last_active_at IS NULL OR last_active_at < $3)", [me, new Date().toISOString(), new Date(Date.now() - 60_000).toISOString()]);
      const [n, msgs, incoming, active] = await Promise.all([
        db.one("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL", [me]),
        unreadMessages(me),
        db.one("SELECT * FROM calls WHERE callee_id = $1 AND status = 'ringing' ORDER BY id DESC LIMIT 1", [me]),
        db.one("SELECT * FROM calls WHERE (callee_id = $1 OR caller_id = $1) AND status = 'active' ORDER BY id DESC LIMIT 1", [me]),
      ]);
      const blocked = incoming && (await blockState(me, incoming.caller_id));
      res.json({
        notifications_unread: n.n, messages_unread: msgs,
        incoming_call: incoming && !blocked.byMe && !blocked.byThem ? await callView(incoming, me) : null,
        active_call_id: active ? active.id : null,
      });
    });

    // ----- conversations -----
    app.get("/api/conversations", auth, async (req, res) => {
      const me = req.user.id;
      const params = [me];
      let where = "(c.owner_id = $1 OR c.member_id = $1)";
      const q = clean(typeof req.query.q === "string" ? req.query.q : "", 60).toLowerCase();
      if (q) {
        params.push(`%${likeEscape(q)}%`);
        const p = `$${params.length}`;
        where += ` AND (LOWER(u.name) LIKE ${p} ESCAPE '\\' OR LOWER(u.username) LIKE ${p} ESCAPE '\\' OR LOWER(t.origin) LIKE ${p} ESCAPE '\\' OR LOWER(t.destination) LIKE ${p} ESCAPE '\\')`;
      }
      if (req.query.filter === "unread") where += " AND EXISTS (SELECT 1 FROM messages m3 WHERE m3.trip_id = c.trip_id AND m3.thread_user_id = c.member_id AND m3.sender_id <> $1 AND m3.id > CASE WHEN c.owner_id = $1 THEN c.owner_last_read_id ELSE c.member_last_read_id END)";
      const limit = 30, offset = Math.min(Math.max(parseInt(req.query.offset, 10) || 0, 0), 5000);
      params.push(limit + 1, offset);
      const rows = await db.query(
        `SELECT c.id, c.trip_id, c.owner_id, c.member_id, c.last_activity_at, c.owner_last_read_id, c.member_last_read_id,
                t.origin, t.destination, t.depart_date, t.depart_time, t.status AS trip_status,
                u.id AS other_id, u.name AS other_name, u.username AS other_username, u.avatar_url AS other_avatar_url, u.avatar_color AS other_avatar_color,
                (SELECT i.status FROM interests i WHERE i.trip_id = c.trip_id AND i.user_id = c.member_id) AS interest_status,
                lm.id AS lm_id, lm.body AS lm_body, lm.kind AS lm_kind, lm.sender_id AS lm_sender, lm.created_at AS lm_at,
                CAST((SELECT COUNT(*) FROM messages m WHERE m.trip_id = c.trip_id AND m.thread_user_id = c.member_id AND m.sender_id <> $1
                      AND m.id > CASE WHEN c.owner_id = $1 THEN c.owner_last_read_id ELSE c.member_last_read_id END) AS INTEGER) AS unread_count,
                CASE WHEN EXISTS (SELECT 1 FROM blocked_users b WHERE b.blocker_id = $1 AND b.blocked_id = u.id) THEN 1 ELSE 0 END AS blocked_by_me
         FROM conversations c
         JOIN trips t ON t.id = c.trip_id
         JOIN users u ON u.id = CASE WHEN c.owner_id = $1 THEN c.member_id ELSE c.owner_id END
         LEFT JOIN messages lm ON lm.id = (SELECT MAX(m2.id) FROM messages m2 WHERE m2.trip_id = c.trip_id AND m2.thread_user_id = c.member_id)
         WHERE ${where}
         ORDER BY c.last_activity_at DESC, c.id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
      res.json({
        conversations: rows.slice(0, limit).map((r) => ({
          id: r.id, role: r.owner_id === me ? "owner" : "member", last_activity_at: iso(r.last_activity_at), unread_count: r.unread_count,
          trip: { id: r.trip_id, origin: r.origin, destination: r.destination, depart_date: r.depart_date, depart_time: r.depart_time, status: r.trip_status },
          interest_status: r.interest_status || null, blocked_by_me: !!r.blocked_by_me,
          other: { id: r.other_id, name: r.other_name, username: r.other_username, avatar_url: r.other_avatar_url || null, avatar_color: r.other_avatar_color },
          last_message: r.lm_id ? { id: r.lm_id, kind: r.lm_kind || "text", body: String(r.lm_body || "").slice(0, 140), mine: r.lm_sender === me, created_at: iso(r.lm_at) } : null,
        })),
        has_more: rows.length > limit, next_offset: offset + limit,
      });
    });

    // Start (or reopen) the conversation about a trip. Member: anyone who could ask to join. Owner: pass { with } = someone who asked.
    app.post("/api/trips/:id/conversation", auth, writeLimit("conversation", L.conversation), async (req, res) => {
      const tripId = intParam(req.params.id), me = req.user.id;
      const trip = await db.one("SELECT id, owner_id, status, women_only FROM trips WHERE id = $1", [tripId]);
      if (!trip) throw new HttpError(404, "Trip not found");
      let memberId;
      if (trip.owner_id === me) {
        memberId = intParam((req.body || {}).with);
        if (memberId === me) throw bad("This is your own trip");
        const existing = await findConversation(tripId, memberId);
        const interest = await db.one("SELECT status FROM interests WHERE trip_id = $1 AND user_id = $2", [tripId, memberId]);
        if (!existing && !interest) throw new HttpError(403, "You can message people who have asked about this trip");
      } else {
        memberId = me;
        const existing = await findConversation(tripId, me);
        if (!existing) {
          if (trip.status !== "open") throw bad("This trip isn't taking new conversations");
          if (trip.women_only) {
            const u = await db.one("SELECT gender FROM users WHERE id = $1", [me]);
            if (u.gender !== "female") throw new HttpError(403, "This is a women-only trip");
          }
        }
      }
      await assertNotBlocked(me, trip.owner_id === me ? memberId : trip.owner_id);
      const conv = await ensureConversation(tripId, memberId, me);
      res.status(201).json({ conversation_id: conv.id });
    });

    app.get("/api/conversations/:id", auth, async (req, res) => {
      const a = await access(req.user.id, intParam(req.params.id));
      res.json({ conversation: await detailView(a, req.user.id) });
    });

    app.get("/api/conversations/:id/messages", auth, async (req, res) => {
      const me = req.user.id;
      const a = await access(me, intParam(req.params.id));
      const { c } = a;
      let rows, has_older = false;
      const sel = "SELECT id, sender_id, body, kind, shared_trip_id, created_at FROM messages WHERE trip_id = $1 AND thread_user_id = $2";
      if (req.query.after !== undefined) {
        const after = intParam(req.query.after);
        rows = await db.query(`${sel} AND id > $3 ORDER BY id LIMIT 200`, [c.trip_id, c.member_id, after]);
      } else {
        const before = req.query.before !== undefined ? intParam(req.query.before) : 2_000_000_000;
        const page = await db.query(`${sel} AND id < $3 ORDER BY id DESC LIMIT 51`, [c.trip_id, c.member_id, before]);
        has_older = page.length > 50;
        rows = page.slice(0, 50).reverse();
      }
      res.json({
        messages: await messageViews(rows, me), has_older,
        state: { can_send: !a.closed, closed_reason: a.closed, other_last_read_id: lastReadOf(c, a.otherId), interest_status: c.interest_status || null, trip_status: c.trip_status },
      });
    });

    app.post("/api/conversations/:id/messages", auth, writeLimit("message", L.message, 600_000), async (req, res) => {
      const me = req.user.id;
      const a = await access(me, intParam(req.params.id));
      if (a.closed) throw new HttpError(403, a.closed);
      const b = req.body || {};
      const kind = b.kind === "trip" ? "trip" : "text";
      if (typeof b.body === "string" && b.body.trim().length > MESSAGE_MAX) throw bad(`Messages can be up to ${MESSAGE_MAX} characters`);
      const body = clean(b.body, MESSAGE_MAX);
      let sharedTripId = null;
      if (kind === "trip") {
        sharedTripId = intParam(b.trip_id);
        const t = await db.one("SELECT id FROM trips WHERE id = $1", [sharedTripId]);
        if (!t) throw new HttpError(404, "That trip no longer exists");
      } else if (!body) throw bad("Message can't be empty");
      const m = await addMessage(a.c, me, { kind, body, sharedTripId });
      const sender = await db.one("SELECT name FROM users WHERE id = $1", [me]);
      await notify(a.otherId, { type: "new_message", title: `New message from ${sender.name}`, body: `About ${a.c.origin} → ${a.c.destination}`,
        link: `#/inbox/${a.c.id}`, ref: `conv:${a.c.id}`, actorId: me });
      const [view] = await messageViews([{ id: m.id, sender_id: me, body, kind, shared_trip_id: sharedTripId, created_at: m.created_at }], me);
      res.status(201).json({ message: view });
    });

    app.post("/api/conversations/:id/read", auth, async (req, res) => {
      const me = req.user.id;
      const a = await access(me, intParam(req.params.id));
      const top = await db.one("SELECT MAX(id) AS id FROM messages WHERE trip_id = $1 AND thread_user_id = $2", [a.c.trip_id, a.c.member_id]);
      const want = (req.body || {}).up_to;
      let upTo = top && top.id ? Number(top.id) : 0;
      if (Number.isInteger(want) && want >= 0) upTo = Math.min(upTo, want);
      const col = a.role === "owner" ? "owner_last_read_id" : "member_last_read_id";
      await db.query(`UPDATE conversations SET ${col} = $1 WHERE id = $2 AND ${col} < $1`, [upTo, a.c.id]);
      res.json({ ok: true, messages_unread: await unreadMessages(me) });
    });

    // ----- notifications -----
    app.get("/api/notifications", auth, async (req, res) => {
      const me = req.user.id;
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
      const offset = Math.min(Math.max(parseInt(req.query.offset, 10) || 0, 0), 5000);
      const rows = await db.query(
        `SELECT n.id, n.type, n.title, n.body, n.link, n.read_at, n.created_at, u.id AS actor_id, u.name AS actor_name, u.avatar_url AS actor_avatar_url, u.avatar_color AS actor_avatar_color
         FROM notifications n LEFT JOIN users u ON u.id = n.actor_id WHERE n.user_id = $1 ORDER BY n.id DESC LIMIT $2 OFFSET $3`, [me, limit + 1, offset]);
      res.json({
        notifications: rows.slice(0, limit).map((r) => ({ id: r.id, type: r.type, title: r.title, body: r.body, link: r.link, read: !!r.read_at, created_at: iso(r.created_at),
          actor: r.actor_id ? { id: r.actor_id, name: r.actor_name, avatar_url: r.actor_avatar_url || null, avatar_color: r.actor_avatar_color } : null })),
        has_more: rows.length > limit, next_offset: offset + limit,
      });
    });
    app.get("/api/notifications/unread", auth, async (req, res) => {
      const n = await db.one("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL", [req.user.id]);
      res.json({ unread: n.n });
    });
    app.post("/api/notifications/read-all", auth, async (req, res) => {
      await db.query("UPDATE notifications SET read_at = $1 WHERE user_id = $2 AND read_at IS NULL", [nowIso(), req.user.id]);
      res.json({ ok: true, unread: 0 });
    });
    app.post("/api/notifications/:id/read", auth, async (req, res) => {
      const r = await db.query("UPDATE notifications SET read_at = $1 WHERE id = $2 AND user_id = $3 AND read_at IS NULL RETURNING id", [nowIso(), intParam(req.params.id), req.user.id]);
      if (!r.length && !(await db.one("SELECT id FROM notifications WHERE id = $1 AND user_id = $2", [intParam(req.params.id), req.user.id]))) throw new HttpError(404, "Notification not found");
      const n = await db.one("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL", [req.user.id]);
      res.json({ ok: true, unread: n.n });
    });

    // ----- blocking & member reports -----
    app.post("/api/block/:id", auth, writeLimit("block", 60), async (req, res) => {
      const target = intParam(req.params.id);
      if (target === req.user.id) throw bad("You can't block yourself");
      if (!(await db.one("SELECT id FROM users WHERE id = $1", [target]))) throw new HttpError(404, "Member not found");
      await db.query("INSERT INTO blocked_users (blocker_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [req.user.id, target]);
      // End any call in progress between the two.
      await db.query(`UPDATE calls SET status = CASE WHEN status = 'ringing' THEN 'cancelled' ELSE 'ended' END, end_reason = 'blocked', ended_at = $3
                      WHERE status IN ('ringing','active') AND ((caller_id = $1 AND callee_id = $2) OR (caller_id = $2 AND callee_id = $1))`, [req.user.id, target, nowIso()]);
      res.json({ blocked: true });
    });
    app.delete("/api/block/:id", auth, async (req, res) => {
      await db.query("DELETE FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2", [req.user.id, intParam(req.params.id)]);
      res.json({ blocked: false });
    });
    app.get("/api/blocks", auth, async (req, res) => {
      const rows = await db.query("SELECT u.id, u.name, u.username, u.avatar_url, u.avatar_color FROM blocked_users b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = $1 ORDER BY u.name", [req.user.id]);
      res.json({ blocked: rows.map((r) => ({ ...r, avatar_url: r.avatar_url || null })) });
    });
    app.post("/api/users/:id/report", auth, writeLimit("report", L.report), async (req, res) => {
      const target = intParam(req.params.id), me = req.user.id, b = req.body || {};
      if (target === me) throw bad("You can't report yourself");
      if (!(await db.one("SELECT id FROM users WHERE id = $1", [target]))) throw new HttpError(404, "Member not found");
      if (!REPORT_REASONS.includes(b.reason)) throw bad("Choose a reason for the report");
      let convId = null;
      if (b.conversation_id != null && b.conversation_id !== "") {
        const a = await access(me, intParam(b.conversation_id));
        if (a.otherId !== target) throw bad("That conversation isn't with this member");
        convId = a.c.id;
      }
      const rows = await db.query("INSERT INTO user_reports (reporter_id, reported_id, conversation_id, reason, details) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (reporter_id, reported_id) DO NOTHING RETURNING id",
        [me, target, convId, b.reason, clean(b.details, 500)]);
      if (!rows.length) throw new HttpError(409, "You've already reported this member");
      if (b.block) await db.query("INSERT INTO blocked_users (blocker_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [me, target]);
      res.status(201).json({ ok: true, blocked: !!b.block });
    });

    // ----- voice calls -----
    app.post("/api/conversations/:id/calls", auth, writeLimit("call", L.call), async (req, res) => {
      const me = req.user.id;
      if (!callsEnabled()) throw new HttpError(503, "Voice calling isn't set up on this server yet. Messaging still works.");
      const a = await access(me, intParam(req.params.id));
      if (a.closed) throw new HttpError(403, a.closed);
      if (!(await callEligible(a))) throw new HttpError(403, "Calling unlocks once you've both sent a message (or the request is accepted).");
      await tidyCalls([me, a.otherId]);
      const busy = await db.one("SELECT id, caller_id, callee_id FROM calls WHERE status IN ('ringing','active') AND (caller_id IN ($1,$2) OR callee_id IN ($1,$2)) LIMIT 1", [me, a.otherId]);
      if (busy) throw new HttpError(409, (busy.caller_id === me || busy.callee_id === me) ? "You're already in a call" : "They're on another call right now. Try again shortly.");
      const room = `sr-${a.c.id}-${crypto.randomBytes(9).toString("hex")}`;
      const [call] = await db.query("INSERT INTO calls (conversation_id, caller_id, callee_id, room, status, created_at) VALUES ($1,$2,$3,$4,'ringing',$5) RETURNING *",
        [a.c.id, me, a.otherId, room, nowIso()]);
      const u = await db.one("SELECT name FROM users WHERE id = $1", [me]);
      res.status(201).json({ call: await callView(call, me), livekit: { url: lk().url, token: livekitToken({ identity: `u${me}`, name: u.name, room }) } });
    });
    app.get("/api/calls/:id", auth, async (req, res) => {
      const call = await myCall(req.user.id, intParam(req.params.id));
      res.json({ call: await callView(call, req.user.id) });
    });
    app.post("/api/calls/:id/accept", auth, async (req, res) => {
      const me = req.user.id;
      if (!callsEnabled()) throw new HttpError(503, "Voice calling isn't set up on this server yet.");
      const call = await myCall(me, intParam(req.params.id));
      if (call.callee_id !== me) throw new HttpError(403, "Only the person being called can answer");
      const b = await blockState(me, call.caller_id);
      if (b.byMe || b.byThem) throw new HttpError(403, "This call isn't available");
      const upd = await db.query("UPDATE calls SET status = 'active', answered_at = $1 WHERE id = $2 AND status = 'ringing' RETURNING *", [nowIso(), call.id]);
      if (!upd.length) throw new HttpError(409, call.status === "missed" ? "This call was missed" : `This call has ${call.status === "active" ? "already been answered" : "ended"}`);
      const u = await db.one("SELECT name FROM users WHERE id = $1", [me]);
      res.json({ call: await callView(upd[0], me), livekit: { url: lk().url, token: livekitToken({ identity: `u${me}`, name: u.name, room: call.room }) } });
    });
    app.post("/api/calls/:id/decline", auth, async (req, res) => {
      const me = req.user.id;
      const call = await myCall(me, intParam(req.params.id));
      if (call.callee_id !== me) throw new HttpError(403, "Only the person being called can decline");
      const upd = await db.query("UPDATE calls SET status = 'declined', end_reason = 'declined', ended_at = $1 WHERE id = $2 AND status = 'ringing' RETURNING *", [nowIso(), call.id]);
      res.json({ call: await callView(upd[0] || call, me) });
    });
    app.post("/api/calls/:id/end", auth, async (req, res) => {
      const me = req.user.id;
      const call = await myCall(me, intParam(req.params.id));
      let upd = [];
      if (call.status === "ringing") {
        upd = await db.query("UPDATE calls SET status = 'cancelled', end_reason = 'caller_hung_up', ended_at = $1 WHERE id = $2 AND status = 'ringing' RETURNING *", [nowIso(), call.id]);
        if (upd.length && call.caller_id === me) await missedCallNotice(call);
      } else if (call.status === "active") {
        upd = await db.query("UPDATE calls SET status = 'ended', end_reason = 'hung_up', ended_at = $1 WHERE id = $2 AND status = 'active' RETURNING *", [nowIso(), call.id]);
      }
      res.json({ call: await callView(upd[0] || call, me) });
    });
    // The browser reports a technical failure (microphone blocked, couldn't connect) so the other side stops waiting.
    app.post("/api/calls/:id/fail", auth, async (req, res) => {
      const me = req.user.id;
      const call = await myCall(me, intParam(req.params.id));
      const reason = ["permission_denied", "connection_failed", "no_microphone", "unsupported"].includes((req.body || {}).reason) ? req.body.reason : "connection_failed";
      const upd = await db.query("UPDATE calls SET status = 'failed', end_reason = $1, ended_at = $2 WHERE id = $3 AND status IN ('ringing','active') RETURNING *", [reason, nowIso(), call.id]);
      res.json({ call: await callView(upd[0] || call, me) });
    });
  }

  return { register, notify, blockState, assertNotBlocked, ensureConversation, findConversation, addMessage, postEvent, postEventToTrip, access, callsEnabled, callsStatus, iso };
}

module.exports = { createMessaging, livekitConnectSources, findLivekitSdk, iso, MESSAGE_MAX, NOTIF_CATEGORY, parsePrefs };
