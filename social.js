// SaathRide — community & discovery features: college/workplace communities, saved routes (with opt-in
// alerts), recommendations, people search, short-lived trip updates, notification preferences, report review.
const { scoreTrip, rankTrips } = require("./matching");
const { round3 } = require("./geo");
const { parsePrefs, NOTIF_CATEGORY } = require("./messaging");

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const UPDATE_KINDS = {
  on_time: () => "On time — leaving as planned",
  leaving: () => "Leaving now",
  waiting: () => "At the pickup point",
  late: (m) => `Running about ${m} min late`,
  arrived: () => "Arrived",
  note: () => "",
};
// "safety" isn't switchable (those always arrive), so it isn't offered as a preference.
const PREF_KEYS = [...new Set(Object.values(NOTIF_CATEGORY))].filter((k) => k !== "safety").concat("email");   // "email": master switch for email copies
const normCollege = (s) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
const adminEmails = () => (process.env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

function createSocial({ db, HttpError, bad, clean, chat, explore, candidates, getTrip, tripViews, TRIP_SELECT, WOMEN_GATE, todayStr, TZ, publicProfile, RATING_COLS }) {
  const notify = chat.notify;
  const isAdmin = async (userId) => {
    const list = adminEmails(); if (!list.length) return false;
    const u = await db.one("SELECT email FROM users WHERE id = $1", [userId]);
    return !!u && list.includes(String(u.email).toLowerCase());
  };

  // ---------- saved routes ----------
  const routeView = (r) => ({ id: r.id, name: r.name, from: r.origin_label ? { label: r.origin_label, lat: r.origin_lat, lng: r.origin_lng } : null,
    to: { label: r.dest_label, lat: r.dest_lat, lng: r.dest_lng }, depart_time: r.depart_time, days: r.days ? r.days.split(",") : [], notify: !!r.notify });
  const routeQuery = (r) => ({
    from: r.origin_label ? (r.origin_lat != null ? { label: r.origin_label, lat: r.origin_lat, lng: r.origin_lng } : { label: r.origin_label }) : null,
    to: r.dest_lat != null ? { label: r.dest_label, lat: r.dest_lat, lng: r.dest_lng } : { label: r.dest_label },
    time: r.depart_time || null, flex: 60,
  });
  const weekday = (date) => DAY_NAMES[new Date(date + "T12:00:00Z").getUTCDay()];
  const dayFits = (r, trip) => !r.days || r.days.split(",").includes(weekday(trip.depart_date)) || (trip.recurring || []).some((d) => r.days.split(",").includes(d));

  async function placeFromBody(v, required) {
    if (!v || typeof v !== "object" || !clean(v.label, 120)) { if (required) throw bad("Choose where this route goes"); return null; }
    const p = { label: clean(v.label, 120) };
    if (v.lat !== undefined && v.lat !== null && v.lat !== "") { const pt = explore.pointParam(v); p.lat = round3(pt.lat); p.lng = round3(pt.lng); }
    else { const r = await explore.resolvePlace(p); if (r && r.lat !== undefined) { p.lat = r.lat; p.lng = r.lng; } }
    return p;
  }

  // A new journey was posted: tell members whose saved route it fits (if they asked for alerts).
  async function onTripCreated(trip) {
    if (!trip || trip.status !== "open") return 0;
    const row = await db.one("SELECT route_geom, women_only FROM trips WHERE id = $1", [trip.id]);
    let coords = null; try { coords = row.route_geom ? JSON.parse(row.route_geom) : null; } catch { coords = null; }
    const t = { ...trip, geo: { ...trip.geo, coords } };
    const routes = await db.query(`SELECT r.*, u.gender FROM saved_routes r JOIN users u ON u.id = r.user_id
      WHERE r.notify = 1 AND r.user_id <> $1 ORDER BY r.id DESC LIMIT 1000`, [trip.owner.id]);
    let sent = 0;
    const done = new Set();
    for (const r of routes) {
      if (done.has(r.user_id) || (row.women_only && r.gender !== "female") || !dayFits(r, t)) continue;
      const m = scoreTrip(t, routeQuery(r));
      if (!m) continue;
      const b = await chat.blockState(r.user_id, trip.owner.id);
      if (b.byMe || b.byThem) continue;
      done.add(r.user_id);
      await notify(r.user_id, { type: "route_match", title: `New journey for “${r.name}”`, body: `${trip.origin} → ${trip.destination}, ${trip.depart_date} at ${trip.depart_time}: ${m.reasons[0].text}`, link: `#/trip/${trip.id}`, actorId: trip.owner.id, ref: `route:${r.id}:${trip.id}` });
      sent++;
    }
    return sent;
  }

  function register(app, { auth, optionalAuth, writeLimit, intParam, likeEscape, L }) {
    // ----- saved routes -----
    app.get("/api/routes", auth, async (req, res) => {
      const rows = await db.query("SELECT * FROM saved_routes WHERE user_id = $1 ORDER BY id", [req.user.id]);
      res.json({ routes: rows.map(routeView) });
    });
    app.post("/api/routes", auth, writeLimit("route", L.route), async (req, res) => {
      const b = req.body || {};
      const n = await db.one("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM saved_routes WHERE user_id = $1", [req.user.id]);
      if (n.n >= 10) throw bad("You can save up to 10 routes");
      const name = clean(b.name, 40) || "My route";
      const to = await placeFromBody(b.to, true), from = await placeFromBody(b.from, false);
      const time = b.depart_time ? String(b.depart_time) : "";
      if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw bad("Choose a valid time");
      const days = (Array.isArray(b.days) ? b.days : []).filter((d) => DAY_NAMES.includes(d));
      const [r] = await db.query(`INSERT INTO saved_routes (user_id, name, origin_label, origin_lat, origin_lng, dest_label, dest_lat, dest_lng, depart_time, days, notify)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [req.user.id, name, from ? from.label : "", from ? from.lat ?? null : null, from ? from.lng ?? null : null, to.label, to.lat ?? null, to.lng ?? null, time, [...new Set(days)].join(","), b.notify === false ? 0 : 1]);
      res.status(201).json({ route: routeView(r) });
    });
    app.patch("/api/routes/:id", auth, writeLimit("route", L.route), async (req, res) => {
      const id = intParam(req.params.id), b = req.body || {};
      const r = await db.one("SELECT * FROM saved_routes WHERE id = $1 AND user_id = $2", [id, req.user.id]);
      if (!r) throw new HttpError(404, "Route not found");
      const sets = {};
      if ("name" in b) sets.name = clean(b.name, 40) || r.name;
      if ("notify" in b) sets.notify = b.notify ? 1 : 0;
      if ("depart_time" in b) { const t = String(b.depart_time || ""); if (t && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw bad("Choose a valid time"); sets.depart_time = t; }
      if ("days" in b) sets.days = [...new Set((Array.isArray(b.days) ? b.days : []).filter((d) => DAY_NAMES.includes(d)))].join(",");
      const cols = Object.keys(sets);
      if (cols.length) await db.query(`UPDATE saved_routes SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")} WHERE id = $${cols.length + 1}`, [...cols.map((c) => sets[c]), id]);
      res.json({ route: routeView(await db.one("SELECT * FROM saved_routes WHERE id = $1", [id])) });
    });
    app.delete("/api/routes/:id", auth, async (req, res) => {
      const r = await db.query("DELETE FROM saved_routes WHERE id = $1 AND user_id = $2 RETURNING id", [intParam(req.params.id), req.user.id]);
      if (!r.length) throw new HttpError(404, "Route not found");
      res.json({ ok: true });
    });

    // ----- recommendations: saved routes first, then your community -----
    app.get("/api/recommendations", auth, async (req, res) => {
      const me = req.user.id;
      const routes = await db.query("SELECT * FROM saved_routes WHERE user_id = $1 ORDER BY id LIMIT 5", [me]);
      const items = new Map();
      if (routes.length) {
        const pool = await candidates(me, { days: 7 });
        for (const r of routes) {
          const fits = pool.filter((t) => dayFits(r, t));
          for (const { trip, m } of rankTrips(fits, routeQuery(r), 3)) {
            if (!items.has(trip.id)) items.set(trip.id, { trip: explore.stripGeo(trip), because: `Fits your saved route “${r.name}”`, reasons: m.reasons, score: m.score + 100 });
          }
        }
      }
      const meRow = await db.one("SELECT college FROM users WHERE id = $1", [me]);
      if (meRow && normCollege(meRow.college)) {
        const rows = await db.query(`${TRIP_SELECT} WHERE t.status = 'open' AND t.depart_date >= $2 AND t.owner_id <> $1 AND u.show_college = 1 AND ${WOMEN_GATE}
            AND LOWER(TRIM(u.college)) = $3 AND (SELECT COUNT(*) FROM reports rp WHERE rp.trip_id = t.id AND rp.status = 'open') < 3
            AND NOT EXISTS (SELECT 1 FROM blocked_users b WHERE (b.blocker_id = $1 AND b.blocked_id = t.owner_id) OR (b.blocker_id = t.owner_id AND b.blocked_id = $1))
            ORDER BY t.depart_date, t.depart_time LIMIT 6`, [me, todayStr(), normCollege(meRow.college)]);
        for (const t of await tripViews(rows, me)) {
          if (!items.has(t.id) && !(t.women_only && !(await db.one("SELECT 1 AS x FROM users WHERE id = $1 AND gender = 'female'", [me]))))
            items.set(t.id, { trip: t, because: `From your community: ${t.owner.college} (self-declared, not verified)`, reasons: [], score: 0 });
        }
      }
      res.json({ items: [...items.values()].sort((a, b) => b.score - a.score).slice(0, 8).map(({ score, ...x }) => x), has_routes: routes.length > 0, community: meRow && meRow.college ? meRow.college : "" });
    });

    // ----- communities (self-declared college / workplace) -----
    app.get("/api/community", auth, async (req, res) => {
      const me = req.user.id;
      const mine = await db.one("SELECT college FROM users WHERE id = $1", [me]);
      const name = clean(typeof req.query.name === "string" ? req.query.name : mine.college, 100);
      if (!normCollege(name)) return res.json({ name: "", members: [], trips: [], member_count: 0 });
      const key = normCollege(name);
      const block = `NOT EXISTS (SELECT 1 FROM blocked_users b WHERE (b.blocker_id = $1 AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = $1))`;
      const [members, count, trips] = await Promise.all([
        db.query(`SELECT u.*, ${RATING_COLS} FROM users u WHERE u.show_college = 1 AND LOWER(TRIM(u.college)) = $2 AND ${block} ORDER BY u.id DESC LIMIT 30`, [me, key]),
        db.one(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM users u WHERE u.show_college = 1 AND LOWER(TRIM(u.college)) = $2 AND ${block}`, [me, key]),
        db.query(`${TRIP_SELECT} WHERE t.status = 'open' AND t.depart_date >= $3 AND u.show_college = 1 AND LOWER(TRIM(u.college)) = $2 AND ${block} AND ${WOMEN_GATE}
                  AND (SELECT COUNT(*) FROM reports rp WHERE rp.trip_id = t.id AND rp.status = 'open') < 3 ORDER BY t.depart_date, t.depart_time LIMIT 30`, [me, key, todayStr()]),
      ]);
      res.json({ name: members[0] ? members[0].college : name, is_mine: normCollege(mine.college) === key, member_count: count.n,
        members: members.map((u) => { const p = publicProfile(u, u.id === me); return { id: p.id, name: p.name, username: p.username, avatar_url: p.avatar_url, avatar_color: p.avatar_color, bio: p.bio, rating: p.rating }; }),
        trips: await tripViews(trips, me) });
    });

    // ----- people search -----
    app.get("/api/users/search", auth, writeLimit("search", L.search, 60_000), async (req, res) => {
      const me = req.user.id;
      const q = clean(typeof req.query.q === "string" ? req.query.q : "", 60).toLowerCase().replace(/^@/, "");
      if (q.length < 2) return res.json({ users: [] });
      const like = `%${likeEscape(q)}%`;
      const rows = await db.query(`SELECT u.*, ${RATING_COLS},
          CAST((SELECT COUNT(*) FROM trips t WHERE t.owner_id = u.id AND t.status <> 'cancelled') AS INTEGER) AS trips_posted
        FROM users u WHERE u.id <> $1
          AND (LOWER(u.name) LIKE $2 ESCAPE '\\' OR LOWER(u.username) LIKE $2 ESCAPE '\\' OR (u.show_college = 1 AND LOWER(u.college) LIKE $2 ESCAPE '\\'))
          AND NOT EXISTS (SELECT 1 FROM blocked_users b WHERE (b.blocker_id = $1 AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = $1))
        ORDER BY CASE WHEN LOWER(u.username) = $3 THEN 0 WHEN LOWER(u.username) LIKE $4 ESCAPE '\\' THEN 1 ELSE 2 END, u.name LIMIT 20`, [me, like, q, `${likeEscape(q)}%`]);
      res.json({ users: rows.map((u) => { const p = publicProfile(u); return { id: p.id, name: p.name, username: p.username, avatar_url: p.avatar_url, avatar_color: p.avatar_color, college: p.college, bio: p.bio, rating: p.rating, rating_count: p.rating_count, trips_posted: u.trips_posted }; }) });
    });

    // ----- short-lived trip updates (owner → confirmed travellers; no locations) -----
    async function tripAccess(tripId, me) {
      const t = await db.one("SELECT id, owner_id, origin, destination, depart_date, status FROM trips WHERE id = $1", [tripId]);
      if (!t) throw new HttpError(404, "Trip not found");
      const isOwner = t.owner_id === me;
      const isTraveller = isOwner || !!(await db.one("SELECT 1 AS x FROM trip_participants WHERE trip_id = $1 AND user_id = $2 AND status = 'confirmed'", [tripId, me]));
      return { t, isOwner, isTraveller };
    }
    app.get("/api/trips/:id/updates", auth, async (req, res) => {
      const { t, isTraveller } = await tripAccess(intParam(req.params.id), req.user.id);
      if (!isTraveller) return res.json({ updates: [], can_view: false });
      const rows = await db.query("SELECT id, kind, body, created_at, expires_at FROM trip_updates WHERE trip_id = $1 AND expires_at > $2 ORDER BY id DESC LIMIT 10", [t.id, new Date().toISOString()]);
      res.json({ can_view: true, updates: rows.map((r) => ({ id: r.id, kind: r.kind, body: r.body, created_at: chat.iso(r.created_at), expires_at: chat.iso(r.expires_at) })) });
    });
    app.post("/api/trips/:id/updates", auth, writeLimit("update", L.update), async (req, res) => {
      const { t, isOwner } = await tripAccess(intParam(req.params.id), req.user.id);
      if (!isOwner) throw new HttpError(403, "Only the trip owner can post updates");
      if (!["open", "closed"].includes(t.status)) throw bad(`This trip is ${t.status}`);
      const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString("en-CA", { timeZone: TZ });
      if (t.depart_date < day(-1) || t.depart_date > day(1)) throw bad("Trip updates are for the day of travel");
      const b = req.body || {};
      if (!UPDATE_KINDS[b.kind]) throw bad("Choose an update");
      const minutes = Math.max(5, Math.min(120, Math.round(Number(b.minutes) || 10)));
      const note = clean(b.note, 140);
      if (b.kind === "note" && !note) throw bad("Write a short note");
      const text = [UPDATE_KINDS[b.kind](minutes), note].filter(Boolean).join(" — ");
      const now = new Date();
      const [u] = await db.query("INSERT INTO trip_updates (trip_id, user_id, kind, body, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
        [t.id, req.user.id, b.kind, text, now.toISOString(), new Date(now.getTime() + 12 * 3600_000).toISOString()]);
      const people = await db.query("SELECT user_id FROM trip_participants WHERE trip_id = $1 AND status = 'confirmed'", [t.id]);
      for (const p of people) await notify(p.user_id, { type: "trip_update", title: `Trip update: ${t.origin} → ${t.destination}`, body: text, link: `#/trip/${t.id}`, actorId: req.user.id, ref: `trip-upd:${t.id}` });
      res.status(201).json({ update: { id: u.id, kind: b.kind, body: text, created_at: now.toISOString() }, notified: people.length });
    });

    // ----- notification preferences -----
    app.get("/api/me/notification-prefs", auth, async (req, res) => {
      const u = await db.one("SELECT notif_prefs FROM users WHERE id = $1", [req.user.id]);
      const p = parsePrefs(u.notif_prefs);
      res.json({ prefs: Object.fromEntries(PREF_KEYS.map((k) => [k, p[k] !== false])) });
    });
    app.put("/api/me/notification-prefs", auth, writeLimit("prefs", 60), async (req, res) => {
      const b = (req.body || {}).prefs || {};
      if (typeof b !== "object") throw bad("Invalid preferences");
      const out = {};
      for (const k of PREF_KEYS) if (k in b) out[k] = !!b[k];
      const cur = parsePrefs((await db.one("SELECT notif_prefs FROM users WHERE id = $1", [req.user.id])).notif_prefs);
      const merged = { ...cur, ...out };
      await db.query("UPDATE users SET notif_prefs = $1 WHERE id = $2", [JSON.stringify(merged), req.user.id]);
      res.json({ prefs: Object.fromEntries(PREF_KEYS.map((k) => [k, merged[k] !== false])) });
    });

    // ----- report review (only accounts listed in ADMIN_EMAILS) -----
    const adminOnly = async (req) => { if (!(await isAdmin(req.user.id))) throw new HttpError(404, "Not found"); };
    app.get("/api/admin/reports", auth, async (req, res) => {
      await adminOnly(req);
      const [trips, users] = await Promise.all([
        db.query(`SELECT r.id, r.reason, r.details, r.status, r.created_at, r.trip_id, t.origin, t.destination, t.owner_id, o.username AS owner_username, rp.username AS reporter_username,
                    CAST((SELECT COUNT(*) FROM reports x WHERE x.trip_id = r.trip_id AND x.status = 'open') AS INTEGER) AS open_reports
                  FROM reports r JOIN trips t ON t.id = r.trip_id JOIN users o ON o.id = t.owner_id JOIN users rp ON rp.id = r.reporter_id ORDER BY r.status = 'open' DESC, r.id DESC LIMIT 100`),
        db.query(`SELECT r.id, r.reason, r.details, r.status, r.created_at, r.reported_id, u.username AS reported_username, u.name AS reported_name, rp.username AS reporter_username,
                    CAST((SELECT COUNT(*) FROM user_reports x WHERE x.reported_id = r.reported_id AND x.status = 'open') AS INTEGER) AS open_reports
                  FROM user_reports r JOIN users u ON u.id = r.reported_id JOIN users rp ON rp.id = r.reporter_id ORDER BY r.status = 'open' DESC, r.id DESC LIMIT 100`),
      ]);
      const fix = (rows) => rows.map((r) => ({ ...r, created_at: chat.iso(r.created_at) }));
      res.json({ trip_reports: fix(trips), user_reports: fix(users) });
    });
    app.post("/api/admin/reports/:kind/:id", auth, async (req, res) => {
      await adminOnly(req);
      const table = req.params.kind === "trip" ? "reports" : req.params.kind === "user" ? "user_reports" : null;
      if (!table) throw new HttpError(404, "Not found");
      const status = ["open", "resolved", "dismissed"].includes((req.body || {}).status) ? req.body.status : null;
      if (!status) throw bad("Invalid status");
      const r = await db.query(`UPDATE ${table} SET status = $1 WHERE id = $2 RETURNING id`, [status, intParam(req.params.id)]);
      if (!r.length) throw new HttpError(404, "Report not found");
      res.json({ ok: true, status });
    });
  }
  return { register, onTripCreated, isAdmin, PREF_KEYS };
}

module.exports = { createSocial, normCollege };
