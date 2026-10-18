// SaathRide — Journey Memories: after a trip, the people who travelled together can keep a shared memory
// (photos, the route, highlights). Private to the participants by default; when made public, each
// participant decides separately whether it appears on their own profile.
const { iso } = require("./messaging");

const MAX_PHOTOS = 12, MAX_HIGHLIGHTS_EACH = 10;
const nowIso = () => new Date().toISOString();
const person = (u) => ({ id: u.id, name: u.name, username: u.username, avatar_url: u.avatar_url || null, avatar_color: u.avatar_color });

function createMemories({ db, HttpError, bad, clean, chat, checkImages, destroyImage, todayStr, TZ, WOMEN_GATE }) {
  const notify = chat.notify;

  // Owner + confirmed passengers of a trip.
  async function participants(tripId) {
    return db.query(`SELECT u.id, u.name, u.username, u.avatar_url, u.avatar_color FROM trips t JOIN users u ON u.id = t.owner_id WHERE t.id = $1
      UNION SELECT u.id, u.name, u.username, u.avatar_url, u.avatar_color FROM interests i JOIN users u ON u.id = i.user_id WHERE i.trip_id = $1 AND i.status = 'accepted'`, [tripId]);
  }
  const isParticipant = async (tripId, userId) => !!userId && (await participants(tripId)).some((p) => p.id === userId);

  async function view(m, viewerId) {
    const [trip, members, highlights, photos] = await Promise.all([
      db.one("SELECT id, origin, destination, depart_date, depart_time, vehicle_type, vehicle_model, route_geom, origin_lat, origin_lng, dest_lat, dest_lng, route_distance_m FROM trips WHERE id = $1", [m.trip_id]),
      db.query("SELECT u.id, u.name, u.username, u.avatar_url, u.avatar_color, mm.show_on_profile FROM memory_members mm JOIN users u ON u.id = mm.user_id WHERE mm.memory_id = $1 ORDER BY u.name", [m.id]),
      db.query("SELECT h.id, h.body, h.created_at, u.id AS uid, u.name, u.username, u.avatar_url, u.avatar_color FROM memory_highlights h JOIN users u ON u.id = h.user_id WHERE h.memory_id = $1 ORDER BY h.id", [m.id]),
      db.query("SELECT id, url, user_id FROM memory_photos WHERE memory_id = $1 ORDER BY id", [m.id]),
    ]);
    let coords = null; try { coords = trip.route_geom ? JSON.parse(trip.route_geom) : null; } catch { coords = null; }
    const me = members.find((x) => x.id === viewerId);
    return {
      id: m.id, title: m.title, visibility: m.visibility, created_at: iso(m.created_at), created_by: m.created_by,
      trip: { id: trip.id, route: `${trip.origin} → ${trip.destination}`, origin: trip.origin, destination: trip.destination, date: trip.depart_date, time: trip.depart_time,
        vehicle: trip.vehicle_type + (trip.vehicle_model ? ` · ${trip.vehicle_model}` : ""), distance_km: trip.route_distance_m ? Math.round(trip.route_distance_m / 100) / 10 : null,
        path: coords, from: trip.origin_lat != null ? { lat: trip.origin_lat, lng: trip.origin_lng } : null, to: trip.dest_lat != null ? { lat: trip.dest_lat, lng: trip.dest_lng } : null },
      members: members.map(person),
      highlights: highlights.map((h) => ({ id: h.id, body: h.body, at: iso(h.created_at), by: person({ id: h.uid, name: h.name, username: h.username, avatar_url: h.avatar_url, avatar_color: h.avatar_color }), mine: h.uid === viewerId })),
      photos: photos.map((p) => ({ id: p.id, url: p.url, mine: p.user_id === viewerId })),
      is_member: !!me, show_on_profile: me ? !!me.show_on_profile : false, can_edit: !!me && (m.created_by === viewerId),
    };
  }
  // Who may see a memory: its members always; anyone else only when it's public (and the trip itself is visible to them).
  async function visibleMemory(id, viewerId) {
    const m = await db.one("SELECT * FROM journey_memories WHERE id = $1", [id]);
    if (!m) return null;
    if (await db.one("SELECT 1 AS x FROM memory_members WHERE memory_id = $1 AND user_id = $2", [id, viewerId ?? -1])) return m;
    if (m.visibility !== "public") return null;
    const ok = await db.one(`SELECT t.id FROM trips t WHERE t.id = $2 AND ${WOMEN_GATE}`, [viewerId ?? null, m.trip_id]);
    return ok ? m : null;
  }
  async function memberMemory(req, id) {
    const m = await db.one("SELECT * FROM journey_memories WHERE id = $1", [id]);
    if (!m || !(await db.one("SELECT 1 AS x FROM memory_members WHERE memory_id = $1 AND user_id = $2", [id, req.user.id]))) throw new HttpError(404, "Memory not found");
    return m;
  }

  function register(app, { auth, optionalAuth, writeLimit, intParam }) {
    // The memory of a trip (members), or whether the viewer could create one.
    app.get("/api/trips/:id/memory", optionalAuth, async (req, res) => {
      const tripId = intParam(req.params.id), viewer = req.user ? req.user.id : null;
      const m = await db.one("SELECT * FROM journey_memories WHERE trip_id = $1", [tripId]);
      if (m) { const v = await visibleMemory(m.id, viewer); return res.json({ memory: v ? await view(v, viewer) : null, can_create: false }); }
      const t = await db.one("SELECT depart_date, status FROM trips WHERE id = $1", [tripId]);
      const can = !!t && t.status !== "cancelled" && t.depart_date <= todayStr() && (await isParticipant(tripId, viewer));
      res.json({ memory: null, can_create: can, reason: !t ? "" : t.depart_date > todayStr() ? "after_trip" : "" });
    });
    app.post("/api/trips/:id/memory", auth, writeLimit("memory", 20), async (req, res) => {
      const tripId = intParam(req.params.id), me = req.user.id, b = req.body || {};
      const t = await db.one("SELECT id, origin, destination, depart_date, status FROM trips WHERE id = $1", [tripId]);
      if (!t || !(await isParticipant(tripId, me))) throw new HttpError(404, "Trip not found");
      if (t.status === "cancelled") throw bad("This journey was cancelled");
      if (t.depart_date > todayStr()) throw bad("You can create a memory once the journey has happened");
      if (await db.one("SELECT id FROM journey_memories WHERE trip_id = $1", [tripId])) throw new HttpError(409, "This journey already has a memory — add your highlights to it");
      const title = clean(b.title, 80) || `${t.origin} → ${t.destination}`;
      const visibility = b.visibility === "public" ? "public" : "participants";
      const photos = checkImages(b.photos, me, "posts", MAX_PHOTOS);
      const rows = await db.query("INSERT INTO journey_memories (trip_id, created_by, title, visibility, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5) RETURNING *", [tripId, me, title, visibility, nowIso()]);
      const m = rows[0], people = await participants(tripId);
      for (const p of people) await db.query("INSERT INTO memory_members (memory_id, user_id, show_on_profile) VALUES ($1,$2,$3)", [m.id, p.id, p.id === me && b.show_on_profile !== false && visibility === "public" ? 1 : 0]);
      const hl = clean(b.highlight, 500);
      if (hl) await db.query("INSERT INTO memory_highlights (memory_id, user_id, body, created_at) VALUES ($1,$2,$3,$4)", [m.id, me, hl, nowIso()]);
      for (const p of photos) await db.query("INSERT INTO memory_photos (memory_id, user_id, url, public_id, created_at) VALUES ($1,$2,$3,$4,$5)", [m.id, me, p.url, p.public_id, nowIso()]);
      const creator = people.find((p) => p.id === me);
      for (const p of people) if (p.id !== me) await notify(p.id, { type: "memory_created", title: `${creator.name} made a memory of your journey`, body: `${title} — add your own highlights and photos.`, link: `#/memory/${m.id}`, ref: `memory:${m.id}`, actorId: me });
      res.status(201).json({ memory: await view(m, me) });
    });
    app.get("/api/memories/:id", optionalAuth, async (req, res) => {
      const viewer = req.user ? req.user.id : null;
      const m = await visibleMemory(intParam(req.params.id), viewer);
      if (!m) throw new HttpError(404, "Memory not found");
      res.json({ memory: await view(m, viewer) });
    });
    app.patch("/api/memories/:id", auth, async (req, res) => {
      const m = await memberMemory(req, intParam(req.params.id)), b = req.body || {};
      if (m.created_by !== req.user.id) throw new HttpError(403, "Only the person who created this memory can change its title or who sees it");
      const title = b.title != null ? clean(b.title, 80) : m.title;
      if (!title) throw bad("Give the memory a title");
      const visibility = b.visibility == null ? m.visibility : b.visibility === "public" ? "public" : "participants";
      await db.query("UPDATE journey_memories SET title = $2, visibility = $3, updated_at = $4 WHERE id = $1", [m.id, title, visibility, nowIso()]);
      if (visibility === "participants") await db.query("UPDATE memory_members SET show_on_profile = 0 WHERE memory_id = $1", [m.id]);
      res.json({ memory: await view({ ...m, title, visibility }, req.user.id) });
    });
    // Each member decides for their own profile.
    app.put("/api/memories/:id/profile", auth, async (req, res) => {
      const m = await memberMemory(req, intParam(req.params.id));
      const show = !!(req.body || {}).show;
      if (show && m.visibility !== "public") throw bad("This memory is private to the people on the journey, so it can't go on your profile");
      await db.query("UPDATE memory_members SET show_on_profile = $3 WHERE memory_id = $1 AND user_id = $2", [m.id, req.user.id, show ? 1 : 0]);
      res.json({ ok: true, show_on_profile: show });
    });
    app.post("/api/memories/:id/highlights", auth, writeLimit("memory-hl", 60), async (req, res) => {
      const m = await memberMemory(req, intParam(req.params.id));
      const body = clean((req.body || {}).body, 500);
      if (body.length < 2) throw bad("Write a highlight first");
      const n = await db.one("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM memory_highlights WHERE memory_id = $1 AND user_id = $2", [m.id, req.user.id]);
      if (n.n >= MAX_HIGHLIGHTS_EACH) throw bad(`You can add up to ${MAX_HIGHLIGHTS_EACH} highlights`);
      await db.query("INSERT INTO memory_highlights (memory_id, user_id, body, created_at) VALUES ($1,$2,$3,$4)", [m.id, req.user.id, body, nowIso()]);
      const me = await db.one("SELECT name FROM users WHERE id = $1", [req.user.id]);
      const others = await db.query("SELECT user_id FROM memory_members WHERE memory_id = $1 AND user_id <> $2", [m.id, req.user.id]);
      for (const o of others) await notify(o.user_id, { type: "memory_highlight", title: `${me.name} added to "${m.title}"`, body: body.slice(0, 120), link: `#/memory/${m.id}`, ref: `memory:${m.id}`, actorId: req.user.id });
      res.status(201).json({ memory: await view(m, req.user.id) });
    });
    app.delete("/api/memories/:id/highlights/:hid", auth, async (req, res) => {
      const m = await memberMemory(req, intParam(req.params.id));
      await db.query("DELETE FROM memory_highlights WHERE id = $1 AND memory_id = $2 AND user_id = $3", [intParam(req.params.hid), m.id, req.user.id]);
      res.json({ memory: await view(m, req.user.id) });
    });
    app.post("/api/memories/:id/photos", auth, writeLimit("memory-photo", 60), async (req, res) => {
      const m = await memberMemory(req, intParam(req.params.id));
      const have = await db.one("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM memory_photos WHERE memory_id = $1", [m.id]);
      const photos = checkImages((req.body || {}).photos, req.user.id, "posts", Math.max(0, MAX_PHOTOS - have.n));
      for (const p of photos) await db.query("INSERT INTO memory_photos (memory_id, user_id, url, public_id, created_at) VALUES ($1,$2,$3,$4,$5)", [m.id, req.user.id, p.url, p.public_id, nowIso()]);
      res.status(201).json({ memory: await view(m, req.user.id) });
    });
    app.delete("/api/memories/:id/photos/:pid", auth, async (req, res) => {
      const m = await memberMemory(req, intParam(req.params.id));
      const p = await db.one("SELECT * FROM memory_photos WHERE id = $1 AND memory_id = $2", [intParam(req.params.pid), m.id]);
      if (!p || (p.user_id !== req.user.id && m.created_by !== req.user.id)) throw new HttpError(404, "Photo not found");
      await db.query("DELETE FROM memory_photos WHERE id = $1", [p.id]);
      await destroyImage(p.public_id);
      res.json({ memory: await view(m, req.user.id) });
    });
    app.delete("/api/memories/:id", auth, async (req, res) => {
      const m = await memberMemory(req, intParam(req.params.id));
      if (m.created_by !== req.user.id) throw new HttpError(403, "Only the person who created this memory can delete it");
      const photos = await db.query("SELECT public_id FROM memory_photos WHERE memory_id = $1", [m.id]);
      await db.query("DELETE FROM journey_memories WHERE id = $1", [m.id]);
      for (const p of photos) await destroyImage(p.public_id);
      res.json({ ok: true });
    });

    // A member's journey record: their public memories (that they chose to show), journeys taken, communities met.
    app.get("/api/users/:id/journeys", optionalAuth, async (req, res) => {
      const id = intParam(req.params.id), viewer = req.user ? req.user.id : null;
      if (viewer && (await db.one("SELECT 1 AS x FROM blocked_users WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)", [viewer, id]))) return res.json({ memories: [], journeys: 0, communities: [] });
      const own = viewer === id;
      const rows = await db.query(`SELECT jm.* FROM journey_memories jm JOIN memory_members mm ON mm.memory_id = jm.id AND mm.user_id = $2 JOIN trips t ON t.id = jm.trip_id
        WHERE ${own ? "mm.user_id = $1" : `jm.visibility = 'public' AND mm.show_on_profile = 1 AND ${WOMEN_GATE}`} ORDER BY t.depart_date DESC, jm.id DESC LIMIT 30`, [viewer, id]);
      const memories = [];
      for (const m of rows) {
        const v = await view(m, viewer);
        memories.push({ id: v.id, title: v.title, visibility: v.visibility, date: v.trip.date, route: v.trip.route, cover: v.photos[0] ? v.photos[0].url : null, members: v.members.length, highlight: v.highlights[0] ? v.highlights[0].body : "", show_on_profile: v.show_on_profile });
      }
      // Journeys that have happened: an earlier day, or today with the departure time passed.
      const today = todayStr(), nowHm = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ });
      const trips = await db.query(`SELECT t.id FROM trips t WHERE (t.depart_date < $2 OR (t.depart_date = $2 AND t.depart_time <= $3)) AND t.status <> 'cancelled'
        AND (t.owner_id = $1 OR EXISTS (SELECT 1 FROM interests i WHERE i.trip_id = t.id AND i.user_id = $1 AND i.status = 'accepted'))`, [id, today, nowHm]);
      // Communities = self-declared colleges/workplaces (shown publicly) of the people they've travelled with.
      const ids = trips.slice(0, 200).map((t) => t.id);
      const comm = ids.length ? await db.query(`SELECT DISTINCT u.college FROM trips t
          JOIN users u ON (u.id = t.owner_id OR u.id IN (SELECT i.user_id FROM interests i WHERE i.trip_id = t.id AND i.status = 'accepted'))
          WHERE t.id IN (${ids.map((_, i) => `$${i + 2}`).join(",")}) AND u.id <> $1 AND u.show_college = 1 AND COALESCE(u.college, '') <> ''`, [id, ...ids]) : [];
      res.json({ memories, journeys: trips.length, communities: [...new Set(comm.map((c) => c.college.trim()))].slice(0, 12) });
    });
  }
  return { register };
}

module.exports = { createMemories };
