// SaathRide — Express 5 backend (works locally and as a Vercel serverless function).
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const path = require("path");
const db = require("./db");
const { createMessaging, livekitConnectSources } = require("./messaging");
const { createGeo } = require("./geo");
const { createExplore, findMapSdk, mapStyleUrl, mapConnectSources } = require("./explore");
const { createAi } = require("./ai");
const { createSocial } = require("./social");

const IS_TEST = process.env.NODE_ENV === "test";
const IS_PROD = process.env.NODE_ENV === "production" || !!process.env.VERCEL;
const TZ = process.env.APP_TIMEZONE || "Asia/Kolkata";
// JWT_SECRET is recommended. If it's missing in production we derive a stable secret from DATABASE_URL (which is
// itself secret), so a fresh deploy works; set JWT_SECRET to decouple sessions from the database password.
const JWT_SECRET = process.env.JWT_SECRET || (IS_TEST ? "test-secret"
  : process.env.DATABASE_URL ? crypto.createHash("sha256").update("saathride-jwt:" + process.env.DATABASE_URL).digest("hex")
  : IS_PROD ? null : "dev-only-secret-change-me");
const COOKIE = "sr_token";
const WEEK = 7 * 24 * 3600;

// ---------- constants ----------
const VEHICLES = ["car", "bike", "scooty", "cab", "auto", "public"]; // 'public' = bus/metro/train group, no seats
const SEAT_VEHICLES = { car: 8, cab: 6, auto: 3, bike: 2, scooty: 2 };
const GENDERS = ["female", "male", "other", "unspecified"];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const REPORT_REASONS = ["spam", "unsafe", "harassment", "fake", "inappropriate", "other"];
const EDU_SUFFIXES = [".ac.in", ".edu.in", ".edu", ".ac.uk"];
const MAX_IMAGES = 5;
const CAPTION_MAX = 500;
const RESERVED_USERNAMES = new Set(["admin", "administrator", "saathride", "support", "help", "root", "system", "moderator", "api", "me", "null", "undefined"]);

// ---------- image storage (Cloudinary, signed direct uploads) ----------
// Photos never pass through this server: the browser uploads straight to Cloudinary using a short-lived
// signature from /api/uploads/sign. We only store the resulting URL + metadata after checking they belong to us.
const cloud = () => ({ name: process.env.CLOUDINARY_CLOUD_NAME || "", key: process.env.CLOUDINARY_API_KEY || "", secret: process.env.CLOUDINARY_API_SECRET || "" });
const uploadsEnabled = () => { const c = cloud(); return !!(c.name && c.key && c.secret); };
const ALLOWED_FORMATS = "jpg,jpeg,png,webp";
const sha1 = (str) => crypto.createHash("sha1").update(str).digest("hex");
function signParams(params) { // Cloudinary: sort keys, join k=v with &, append API secret, SHA-1
  const base = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
  return sha1(base + cloud().secret);
}
async function destroyCloudinaryImage(publicId) { // best-effort cleanup; never throws
  try {
    if (!uploadsEnabled() || !publicId) return;
    const c = cloud(), timestamp = Math.floor(Date.now() / 1000);
    const body = new URLSearchParams({ public_id: publicId, timestamp: String(timestamp), api_key: c.key, signature: signParams({ public_id: publicId, timestamp }) });
    await fetch(`https://api.cloudinary.com/v1_1/${c.name}/image/destroy`, { method: "POST", body, signal: AbortSignal.timeout(8000) });
  } catch (err) { console.error("cloudinary destroy failed:", err.message); }
}
// Validate image descriptors sent by the client: they must be OUR Cloudinary account and the caller's own folder.
function checkImages(list, userId, kind, max) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw bad("Images must be a list");
  if (list.length > max) throw bad(`You can add up to ${max} photo${max === 1 ? "" : "s"}`);
  if (list.length && !uploadsEnabled()) throw bad("Photo uploads aren't set up on this server yet");
  const c = cloud();
  const prefix = `saathride/${kind}/${userId}/`;
  return list.map((im) => {
    if (!im || typeof im !== "object") throw bad("Invalid image");
    const url = typeof im.url === "string" ? im.url : "", pid = typeof im.public_id === "string" ? im.public_id : "";
    if (url.length > 500 || pid.length > 200 || !pid.startsWith(prefix) || pid.includes("..") || !/^[\w\-./]+$/.test(pid)) throw bad("Invalid image");
    if (!url.startsWith(`https://res.cloudinary.com/${c.name}/image/upload/`) || !url.includes(pid)) throw bad("Invalid image");
    const dim = (v) => (Number.isInteger(v) && v > 0 && v <= 20000 ? v : null);
    return { url, public_id: pid, width: dim(im.width), height: dim(im.height) };
  });
}
const isUnique = (err) => err && (err.code === "23505" || /UNIQUE constraint/i.test(err.message || ""));

// ---------- helpers ----------
const todayStr = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"))
  && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
const isTime = (s) => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const isEduEmail = (email) => { const d = email.split("@")[1] || ""; return EDU_SUFFIXES.some((s) => d.endsWith(s)); };
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => "\\" + c);
const clean = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max) : "");

const USERNAME_RE = /^[a-z0-9](?:[a-z0-9_.]{1,18})[a-z0-9]$/;
function checkUsername(v) {
  const u = clean(v, 30).toLowerCase();
  if (!USERNAME_RE.test(u) || u.includes("..")) throw bad("Username must be 3–20 characters: letters, numbers, dot or underscore");
  if (RESERVED_USERNAMES.has(u)) throw bad("That username isn't available");
  return u;
}
async function freeUsername(seed) {
  let base = String(seed || "").toLowerCase().replace(/[^a-z0-9_.]/g, "").replace(/^[._]+|[._]+$/g, "").replace(/\.{2,}/g, ".").slice(0, 16);
  if (base.length < 3) base = (base + "rider").slice(0, 16);
  if (RESERVED_USERNAMES.has(base)) base += "1";
  for (let i = 0; i < 8; i++) {
    const cand = i === 0 ? base : `${base}${Math.floor(100 + Math.random() * 9900)}`.slice(0, 20);
    if (!(await db.one("SELECT 1 AS x FROM users WHERE username = $1", [cand]))) return cand;
  }
  return `${base.slice(0, 10)}${Date.now().toString(36)}`.slice(0, 20);
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

function intParam(v) {
  if (!/^\d{1,9}$/.test(String(v))) throw new HttpError(404, "Not found");
  return Number(v);
}
function listOf(v, maxItems, maxLen) {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  const seen = new Set();
  for (const item of arr) {
    const s = clean(String(item), maxLen).replace(/,/g, " ").trim();
    if (s) seen.add(s);
    if (seen.size >= maxItems) break;
  }
  return [...seen];
}
const splitCsv = (s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);

// ---------- auth tokens (httpOnly cookie) ----------
function getCookie(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}
function setAuthCookie(res, userId) {
  if (!JWT_SECRET) throw new HttpError(500, "Server is not configured (JWT_SECRET missing)");
  const token = jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: WEEK });
  res.append("Set-Cookie", `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${WEEK}${IS_PROD ? "; Secure" : ""}`);
}
const clearAuthCookie = (res) =>
  res.append("Set-Cookie", `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${IS_PROD ? "; Secure" : ""}`);

function readUser(req) {
  if (!JWT_SECRET) return null;
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : getCookie(req, COOKIE);
  if (!token) return null;
  try { const p = jwt.verify(token, JWT_SECRET); return Number.isInteger(p.id) ? { id: p.id } : null; } catch { return null; }
}
const optionalAuth = (req, _res, next) => { req.user = readUser(req); next(); };
const auth = (req, _res, next) => {
  req.user = readUser(req);
  if (!req.user) return next(new HttpError(401, "Please log in to continue"));
  next();
};

// ---------- rate limiting (in-memory, per server instance) ----------
function limiter({ windowMs, max, key, message }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    const k = key ? key(req) : req.ip;
    let e = hits.get(k);
    if (!e || e.reset <= now) { e = { count: 0, reset: now + windowMs }; hits.set(k, e); }
    if (++e.count > max) {
      res.set("Retry-After", String(Math.ceil((e.reset - now) / 1000)));
      return next(new HttpError(429, message || "Too many requests. Please slow down and try again shortly."));
    }
    next();
  };
}

// ---------- row shaping ----------
const avgRating = (r) => (r.rating_count ? Math.round(Number(r.rating_avg) * 10) / 10 : null);
const RATING_COLS = `(SELECT AVG(stars) FROM ratings r WHERE r.ratee_id = u.id) AS rating_avg,
  CAST((SELECT COUNT(*) FROM ratings r WHERE r.ratee_id = u.id) AS INTEGER) AS rating_count`;

// `own` = the person viewing is the profile owner (privacy switches only hide things from OTHER people).
function publicProfile(u, own = false) {
  return {
    id: u.id, name: u.name, username: u.username, avatar_url: u.avatar_url || null, bio: u.bio,
    college: own || u.show_college ? u.college : "",
    travel_areas: own || u.show_travel_areas ? splitCsv(u.travel_areas) : [],
    interests: own || u.show_interests ? splitCsv(u.interests) : [],
    travel_modes: splitCsv(u.travel_modes),
    avatar_color: u.avatar_color, edu_email: !!u.edu_email, member_since: u.created_at,
    rating: avgRating(u), rating_count: u.rating_count || 0,
  };
}
const selfProfile = (u) => ({
  ...publicProfile(u, true), email: u.email, phone: u.phone || "", gender: u.gender, has_vehicle: !!u.has_vehicle, vehicle_type: u.vehicle_type,
  show_college: !!u.show_college, show_travel_areas: !!u.show_travel_areas, show_interests: !!u.show_interests,
});
const getUser = (id) => db.one(`SELECT u.*, ${RATING_COLS} FROM users u WHERE u.id = $1`, [id]);

const TRIP_SELECT = `
  SELECT t.*, u.name AS owner_name, u.username AS owner_username, u.avatar_url AS owner_avatar_url,
    CASE WHEN u.show_college = 1 THEN u.college ELSE '' END AS owner_college, u.avatar_color AS owner_avatar, u.edu_email AS owner_edu_email,
    CAST((SELECT COUNT(*) FROM trip_likes l WHERE l.trip_id = t.id) AS INTEGER) AS like_count,
    CAST((SELECT COUNT(*) FROM trip_comments c WHERE c.trip_id = t.id) AS INTEGER) AS comment_count,
    CASE WHEN EXISTS (SELECT 1 FROM trip_likes l WHERE l.trip_id = t.id AND l.user_id = $1) THEN 1 ELSE 0 END AS liked,
    (SELECT AVG(stars) FROM ratings r WHERE r.ratee_id = u.id) AS owner_rating_avg,
    CAST((SELECT COUNT(*) FROM ratings r WHERE r.ratee_id = u.id) AS INTEGER) AS owner_rating_count,
    CAST((SELECT COUNT(*) FROM interests i WHERE i.trip_id = t.id AND i.status IN ('pending','accepted')) AS INTEGER) AS interest_count,
    CAST((SELECT COUNT(*) FROM interests i WHERE i.trip_id = t.id AND i.status = 'pending') AS INTEGER) AS pending_count,
    CAST((SELECT COUNT(*) FROM trip_participants p WHERE p.trip_id = t.id AND p.status = 'confirmed') AS INTEGER) AS confirmed_count,
    (SELECT i.status FROM interests i WHERE i.trip_id = t.id AND i.user_id = $1) AS my_interest,
    CASE WHEN EXISTS (SELECT 1 FROM saved_trips s WHERE s.trip_id = t.id AND s.user_id = $1) THEN 1 ELSE 0 END AS saved
  FROM trips t JOIN users u ON u.id = t.owner_id`;

function tripView(r, viewerId) {
  const seatsLeft = r.seats_total == null ? null : Math.max(0, r.seats_total - r.confirmed_count);
  return {
    id: r.id, origin: r.origin, destination: r.destination, depart_date: r.depart_date, depart_time: r.depart_time,
    vehicle_type: r.vehicle_type, vehicle_model: r.vehicle_model || "", seats_total: r.seats_total, seats_left: seatsLeft, is_full: seatsLeft === 0,
    contribution_inr: r.contribution_inr, women_only: !!r.women_only, recurring: splitCsv(r.recurring),
    description: r.description, status: r.status, created_at: r.created_at,
    interest_count: r.interest_count, confirmed_count: r.confirmed_count,
    pending_count: viewerId === r.owner_id ? r.pending_count : undefined,
    my_interest: r.my_interest || null, saved: !!r.saved, is_owner: viewerId === r.owner_id,
    like_count: r.like_count, comment_count: r.comment_count, liked: !!r.liked, images: [],
    share_path: `/p/${r.id}`,
    geo: {
      origin: r.origin_lat != null ? { lat: Number(r.origin_lat), lng: Number(r.origin_lng) } : null,
      dest: r.dest_lat != null ? { lat: Number(r.dest_lat), lng: Number(r.dest_lng) } : null,
      distance_m: r.route_distance_m ?? null, duration_s: r.route_duration_s ?? null, has_route: !!r.route_geom,
    },
    owner: {
      id: r.owner_id, name: r.owner_name, username: r.owner_username, avatar_url: r.owner_avatar_url || null, college: r.owner_college, avatar_color: r.owner_avatar, edu_email: !!r.owner_edu_email,
      rating: avgRating({ rating_avg: r.owner_rating_avg, rating_count: r.owner_rating_count }), rating_count: r.owner_rating_count,
    },
  };
}
// Attach photos to a list of trip views with ONE query.
async function withImages(views, q = db) {
  if (!views.length) return views;
  const ids = views.map((v) => v.id);
  const rows = await q.query(`SELECT id, trip_id, url, width, height FROM trip_images WHERE trip_id IN (${ids.map((_, i) => `$${i + 1}`).join(",")}) ORDER BY position, id`, ids);
  const by = new Map();
  for (const r of rows) { if (!by.has(r.trip_id)) by.set(r.trip_id, []); by.get(r.trip_id).push({ id: r.id, url: r.url, width: r.width, height: r.height }); }
  for (const v of views) v.images = by.get(v.id) || [];
  return views;
}
const tripViews = (rows, viewerId) => withImages(rows.map((r) => tripView(r, viewerId)));
const getTrip = async (id, viewerId, q = db) => {
  const r = await q.one(`${TRIP_SELECT} WHERE t.id = $2`, [viewerId ?? null, id]);
  return r ? (await withImages([tripView(r, viewerId)], q))[0] : null;
};

// ---------- app factory ----------
function createApp({ limits = {}, destroyImage = destroyCloudinaryImage, livekitSdk, geoFetch, mapSdk, aiFetch } = {}) {
  const L = { auth: 10, write: 40, api: 400, trip: 20, interest: 30, report: 10, message: 80, like: 400, comment: 60, upload: 60, conversation: 40, call: 30,
    geo: 60, match: 30, ai: 20, aiDay: 150, update: 30, route: 30, search: 60, ...limits };
  const geo = createGeo({ db, ...(geoFetch ? { fetchImpl: geoFetch } : {}) });
  const explore = createExplore({ db, geo, HttpError, bad, clean });
  const sdk = mapSdk !== undefined ? mapSdk : findMapSdk();
  const chat = createMessaging({ db, HttpError, bad, clean, ...(livekitSdk !== undefined ? { sdkPath: livekitSdk } : {}) });
  const { notify } = chat;
  const csp = () => ["default-src 'self'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
    `img-src 'self' data: blob: https://res.cloudinary.com${sdk ? " " + mapConnectSources(sdk).join(" ") : ""}`, `connect-src 'self' https://api.cloudinary.com ${[...livekitConnectSources(), ...mapConnectSources(sdk)].join(" ")}`.trim(),
    sdk ? "worker-src 'self' blob:" : "", sdk ? "child-src blob:" : "",
    "media-src 'self' blob:", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'"].filter(Boolean).join("; ");
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Content-Security-Policy": csp(),
      "Permissions-Policy": "camera=(), geolocation=(self), microphone=(self)",
    });
    next();
  });
  app.use(express.json({ limit: "20kb" }));

  // On Vercel (or AUTO_MIGRATE=1) the schema is created/upgraded on the first request of each instance.
  // Every statement is idempotent and migrate() holds a Postgres advisory lock, so concurrent cold starts are safe.
  if (!IS_TEST && (process.env.AUTO_MIGRATE === "1" || (process.env.VERCEL && process.env.AUTO_MIGRATE !== "0"))) {
    let ready = null;
    app.use(async (req, _res, next) => {
      if (!process.env.DATABASE_URL) return next();
      try { await (ready ||= db.migrate().catch((err) => { ready = null; throw err; })); next(); }
      catch (err) { console.error("auto-migrate failed:", err.message); next(); }
    });
  }

  // CSRF defence in depth (cookie is SameSite=Lax): writes must be same-origin JSON.
  app.use("/api", (req, _res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin) { try { if (new URL(origin).host !== req.headers.host) return next(new HttpError(403, "Cross-origin request blocked")); } catch { return next(new HttpError(403, "Bad origin")); } }
    if (!/^application\/json/i.test(req.headers["content-type"] || "")) return next(new HttpError(415, "Content-Type must be application/json"));
    next();
  });
  app.use("/api", limiter({ windowMs: 60_000, max: L.api }));

  const authLimit = limiter({ windowMs: 15 * 60_000, max: L.auth, message: "Too many attempts. Try again in a few minutes." });
  const byUser = (name) => (req) => `${name}:${req.user ? req.user.id : req.ip}`;
  const writeLimit = (name, max, windowMs = 3600_000) => limiter({ windowMs, max, key: byUser(name), message: "You're doing that too often. Please try again later." });

  // ----- health -----
  app.get("/api/health", async (_req, res) => {
    try { await db.ping(); res.json({ ok: true, db: true }); }
    catch (err) { console.error("health check failed:", err.message); res.status(503).json({ ok: false, db: false }); }
  });

  // public, non-secret capabilities the UI needs (is photo upload configured?)
  app.get("/api/config", (_req, res) => res.json({ uploads: uploadsEnabled(), max_images: MAX_IMAGES, caption_max: CAPTION_MAX, calls: chat.callsEnabled(), calls_status: chat.callsStatus(),
    geo: geo.enabled(), map: !!sdk, map_style: sdk ? mapStyleUrl() : "", map_status: sdk ? "ready" : "sdk_missing",
    ai: ai.enabled(), ai_status: ai.status() }));

  chat.register(app, { auth, writeLimit, intParam, likeEscape, L });

  // Upcoming open journeys a member may join (same visibility rules as the feed), with map data for matching.
  async function candidates(viewerId, { date = null, days = 7, vehicle_type = null, min_seats = null, limit = 300 } = {}) {
    const today = todayStr();
    const params = [viewerId ?? null];
    const where = [`t.status = 'open'`, `(SELECT COUNT(*) FROM reports rp WHERE rp.trip_id = t.id AND rp.status = 'open') < 3`,
      `NOT EXISTS (SELECT 1 FROM blocked_users b WHERE (b.blocker_id = $1 AND b.blocked_id = t.owner_id) OR (b.blocker_id = t.owner_id AND b.blocked_id = $1))`];
    if (viewerId) where.push("t.owner_id <> $1");
    const add = (sql, v) => { params.push(v); where.push(sql.replaceAll("?", `$${params.length}`)); };
    if (date && isDate(date)) add("t.depart_date = ?", date < today ? today : date);
    else { add("t.depart_date >= ?", today); add("t.depart_date <= ?", new Date(Date.now() + days * 864e5).toLocaleDateString("en-CA", { timeZone: TZ })); }
    if (vehicle_type && VEHICLES.includes(vehicle_type)) add("t.vehicle_type = ?", vehicle_type);
    if (viewerId) {
      const me = await db.one("SELECT gender FROM users WHERE id = $1", [viewerId]);
      if (!me || me.gender !== "female") where.push("t.women_only = 0");
    }
    const rows = await db.query(`${TRIP_SELECT} WHERE ${where.join(" AND ")} ORDER BY t.depart_date, t.depart_time LIMIT ${Math.min(limit, 500)}`, params);
    const views = await tripViews(rows, viewerId);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return views.filter((v) => min_seats == null || v.seats_left == null || v.seats_left >= min_seats).map((v) => {
      let coords = null; try { coords = byId.get(v.id).route_geom ? JSON.parse(byId.get(v.id).route_geom) : null; } catch { coords = null; }
      return { ...v, geo: { ...v.geo, coords } };
    });
  }
  explore.register(app, { auth, optionalAuth, writeLimit, intParam, candidates, L, sdk });
  const ai = createAi({ db, HttpError, bad, clean, explore, candidates, getTrip, todayStr, TZ, ...(aiFetch ? { fetchImpl: aiFetch } : {}) });
  ai.register(app, { auth, writeLimit, intParam, L });
  const social = createSocial({ db, HttpError, bad, clean, chat, explore, candidates, getTrip, tripViews, TRIP_SELECT, todayStr, TZ, publicProfile, RATING_COLS });
  social.register(app, { auth, optionalAuth, writeLimit, intParam, likeEscape, L });

  // ----- auth -----
  const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

  app.post("/api/auth/signup", authLimit, async (req, res) => {
    const b = req.body || {};
    const name = clean(b.name, 60);
    const email = clean(b.email, 254).toLowerCase();
    const password = typeof b.password === "string" ? b.password : "";
    if (name.length < 2) throw bad("Please enter your name");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw bad("Please enter a valid email address");
    if (password.length < 8) throw bad("Password must be at least 8 characters");
    if (password.length > 72) throw bad("Password must be at most 72 characters");
    const gender = GENDERS.includes(b.gender) ? b.gender : "unspecified";
    const phone = clean(b.phone, 20);
    if (phone && !/^[+\d][\d\s-]{6,18}$/.test(phone)) throw bad("Phone number looks invalid");
    const vehicle_type = VEHICLES.includes(b.vehicle_type) ? b.vehicle_type : null;
    const hash = await bcrypt.hash(password, 10);
    const username = await freeUsername(email.split("@")[0]);
    const rows = await db.query(
      `INSERT INTO users (name, email, password_hash, phone, gender, college, edu_email, has_vehicle, vehicle_type, avatar_color, username)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (email) DO NOTHING RETURNING id`,
      [name, email, hash, phone || null, gender, clean(b.college, 100), isEduEmail(email) ? 1 : 0, b.has_vehicle ? 1 : 0, b.has_vehicle ? vehicle_type : null, Math.floor(Math.random() * 8), username]
    );
    if (!rows.length) throw new HttpError(409, "An account with this email already exists");
    setAuthCookie(res, rows[0].id);
    res.status(201).json({ user: selfProfile(await getUser(rows[0].id)) });
  });

  app.post("/api/auth/login", authLimit, async (req, res) => {
    const email = clean((req.body || {}).email, 254).toLowerCase();
    const password = typeof (req.body || {}).password === "string" ? req.body.password : "";
    const row = await db.one("SELECT id, password_hash FROM users WHERE email = $1", [email]);
    const ok = await bcrypt.compare(password.slice(0, 72), row ? row.password_hash : DUMMY_HASH);
    if (!row || !ok) throw new HttpError(401, "Wrong email or password");
    setAuthCookie(res, row.id);
    res.json({ user: selfProfile(await getUser(row.id)) });
  });

  app.post("/api/auth/logout", (_req, res) => { clearAuthCookie(res); res.json({ ok: true }); });

  app.get("/api/me", optionalAuth, async (req, res) => {
    const u = req.user && (await getUser(req.user.id));
    res.json({ user: u ? { ...selfProfile(u), is_admin: await social.isAdmin(u.id) } : null });
  });

  // ----- profiles -----
  app.patch("/api/me", auth, writeLimit("profile", L.write), async (req, res) => {
    const b = req.body || {};
    const sets = {};
    if ("name" in b) { const v = clean(b.name, 60); if (v.length < 2) throw bad("Please enter your name"); sets.name = v; }
    if ("bio" in b) sets.bio = clean(b.bio, 300);
    if ("college" in b) sets.college = clean(b.college, 100);
    if ("travel_areas" in b) sets.travel_areas = listOf(b.travel_areas, 8, 40).join(",");
    if ("interests" in b) sets.interests = listOf(b.interests, 10, 30).join(",");
    if ("travel_modes" in b) sets.travel_modes = listOf(b.travel_modes, 6, 20).filter((m) => VEHICLES.includes(m.toLowerCase())).map((m) => m.toLowerCase()).join(",");
    if ("avatar_color" in b) { const n = Number(b.avatar_color); if (!Number.isInteger(n) || n < 0 || n > 7) throw bad("Invalid avatar colour"); sets.avatar_color = n; }
    if ("gender" in b) { if (!GENDERS.includes(b.gender)) throw bad("Invalid gender option"); sets.gender = b.gender; }
    if ("phone" in b) { const v = clean(b.phone, 20); if (v && !/^[+\d][\d\s-]{6,18}$/.test(v)) throw bad("Phone number looks invalid"); sets.phone = v || null; }
    if ("has_vehicle" in b) sets.has_vehicle = b.has_vehicle ? 1 : 0;
    if ("vehicle_type" in b) sets.vehicle_type = VEHICLES.includes(b.vehicle_type) ? b.vehicle_type : null;
    for (const f of ["show_college", "show_travel_areas", "show_interests"]) if (f in b) sets[f] = b[f] ? 1 : 0;
    let oldAvatar = null;
    if ("username" in b) {
      const uname = checkUsername(b.username);
      const taken = await db.one("SELECT id FROM users WHERE username = $1 AND id <> $2", [uname, req.user.id]);
      if (taken) throw new HttpError(409, "That username is taken");
      sets.username = uname;
    }
    if ("avatar" in b) {
      const cur = await db.one("SELECT avatar_public_id FROM users WHERE id = $1", [req.user.id]);
      if (b.avatar === null) { sets.avatar_url = null; sets.avatar_public_id = null; }
      else {
        const [im] = checkImages([b.avatar], req.user.id, "avatars", 1);
        sets.avatar_url = im.url; sets.avatar_public_id = im.public_id;
      }
      if (cur && cur.avatar_public_id && cur.avatar_public_id !== sets.avatar_public_id) oldAvatar = cur.avatar_public_id;
    }
    const cols = Object.keys(sets); // only whitelisted column names above
    if (cols.length) {
      try {
        await db.query(`UPDATE users SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")} WHERE id = $${cols.length + 1}`, [...cols.map((c) => sets[c]), req.user.id]);
      } catch (err) { if (isUnique(err)) throw new HttpError(409, "That username is taken"); throw err; }
    }
    if (oldAvatar) destroyImage(oldAvatar);
    res.json({ user: selfProfile(await getUser(req.user.id)) });
  });

  // ----- photo uploads: short-lived signature for a direct browser -> Cloudinary upload -----
  app.post("/api/uploads/sign", auth, writeLimit("upload", L.upload), (req, res) => {
    if (!uploadsEnabled()) throw new HttpError(503, "Photo uploads aren't set up on this server yet");
    const kind = (req.body || {}).kind === "avatar" ? "avatars" : "posts";
    const c = cloud(), timestamp = Math.floor(Date.now() / 1000);
    const folder = `saathride/${kind}/${req.user.id}`;
    // Signed incoming transformation: Cloudinary shrinks anything larger before storing it (plus the type allow-list above;
    // Cloudinary's own per-file limit — 10 MB on the free plan — rejects oversized uploads).
    const transformation = kind === "avatars" ? "c_limit,w_800,h_800" : "c_limit,w_2048,h_2048";
    const params = { allowed_formats: ALLOWED_FORMATS, folder, timestamp, transformation };
    res.json({
      upload_url: `https://api.cloudinary.com/v1_1/${c.name}/image/upload`,
      api_key: c.key, timestamp, folder, allowed_formats: ALLOWED_FORMATS, transformation, signature: signParams(params), max_bytes: 10 * 1024 * 1024,
    });
  });

  // :id is a numeric id or a @username
  app.get("/api/users/:id", auth, async (req, res) => {
    const key = String(req.params.id).replace(/^@/, "");
    const u = /^\d{1,9}$/.test(key) ? await getUser(Number(key))
      : /^[a-z0-9_.]{3,20}$/i.test(key) ? await db.one(`SELECT u.*, ${RATING_COLS} FROM users u WHERE u.username = $1`, [key.toLowerCase()]) : null;
    if (!u) throw new HttpError(404, "Profile not found");
    const id = u.id, me = req.user.id;
    const visible = `(t.owner_id = $1 OR (SELECT COUNT(*) FROM reports rp WHERE rp.trip_id = t.id AND rp.status = 'open') < 3)`;
    const [postRows, upcomingRows, total] = await Promise.all([
      db.query(`${TRIP_SELECT} WHERE t.owner_id = $2 AND t.status <> 'cancelled' AND ${visible} ORDER BY t.id DESC LIMIT 30`, [me, id]),
      db.query(`${TRIP_SELECT} WHERE t.owner_id = $2 AND t.status = 'open' AND t.depart_date >= $3 AND ${visible} ORDER BY t.depart_date, t.depart_time LIMIT 20`, [me, id, todayStr()]),
      db.one("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM trips WHERE owner_id = $1 AND status <> 'cancelled'", [id]),
    ]);
    const blocks = id === me ? { byMe: false } : await chat.blockState(me, id);
    res.json({ user: { ...publicProfile(u, id === me), blocked_by_me: blocks.byMe }, trips_posted: total.n, posts: await tripViews(postRows, me), upcoming_trips: await tripViews(upcomingRows, me) });
  });

  // ----- trips -----
  app.get("/api/trips", optionalAuth, async (req, res) => {
    const q = req.query;
    const viewer = req.user ? req.user.id : null;
    const params = [viewer];
    const where = [`t.status = 'open'`, `(SELECT COUNT(*) FROM reports rp WHERE rp.trip_id = t.id AND rp.status = 'open') < 3`,
      `NOT EXISTS (SELECT 1 FROM blocked_users b WHERE (b.blocker_id = $1 AND b.blocked_id = t.owner_id) OR (b.blocker_id = t.owner_id AND b.blocked_id = $1))`];
    const add = (sql, v) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
    const str = (v) => (typeof v === "string" ? clean(v, 80) : "");

    if (str(q.origin)) add(`LOWER(t.origin) LIKE ? ESCAPE '\\'`, `%${likeEscape(str(q.origin).toLowerCase())}%`);
    if (str(q.destination)) add(`LOWER(t.destination) LIKE ? ESCAPE '\\'`, `%${likeEscape(str(q.destination).toLowerCase())}%`);
    if (q.date) { if (!isDate(q.date)) throw bad("Invalid date"); add("t.depart_date = ?", q.date); }
    else add("t.depart_date >= ?", todayStr());
    if (q.time_from) { if (!isTime(q.time_from)) throw bad("Invalid start time"); add("t.depart_time >= ?", q.time_from); }
    if (q.time_to) { if (!isTime(q.time_to)) throw bad("Invalid end time"); add("t.depart_time <= ?", q.time_to); }
    if (q.vehicle_type) { if (!VEHICLES.includes(q.vehicle_type)) throw bad("Invalid vehicle type"); add("t.vehicle_type = ?", q.vehicle_type); }
    if (q.women_only === "1") where.push("t.women_only = 1");
    if (q.recurring === "1") where.push("t.recurring <> ''");
    if (q.min_seats) {
      const n = Number(q.min_seats);
      if (!Number.isInteger(n) || n < 1 || n > 8) throw bad("Invalid seat count");
      add(`(t.seats_total IS NULL OR t.seats_total - (SELECT COUNT(*) FROM trip_participants p2 WHERE p2.trip_id = t.id AND p2.status = 'confirmed') >= ?)`, n);
    }
    if (q.mapped === "1") where.push("t.origin_lat IS NOT NULL AND t.dest_lat IS NOT NULL");
    if (q.scope === "community" && viewer) where.push(`EXISTS (SELECT 1 FROM users me2 WHERE me2.id = $1 AND me2.college <> '' AND u.show_college = 1 AND LOWER(TRIM(u.college)) = LOWER(TRIM(me2.college)))`);

    const limit = q.mapped === "1" ? 150 : 20;
    const offset = Math.min(Math.max(parseInt(q.offset, 10) || 0, 0), 10_000);
    params.push(limit + 1, offset);
    const order = q.sort === "new" ? "t.id DESC" : "t.depart_date, t.depart_time, t.id";
    const rows = await db.query(
      `${TRIP_SELECT} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    res.json({ trips: await tripViews(rows.slice(0, limit), viewer), has_more: rows.length > limit, next_offset: offset + limit });
  });

  app.post("/api/trips", auth, writeLimit("trip", L.trip), async (req, res) => {
    const b = req.body || {};
    const origin = clean(b.origin, 80), destination = clean(b.destination, 80);
    if (origin.length < 2 || destination.length < 2) throw bad("Enter where you're starting from and where you're going");
    if (origin.toLowerCase() === destination.toLowerCase()) throw bad("Start and destination must be different");
    if (!isDate(b.depart_date)) throw bad("Choose a valid travel date");
    const today = todayStr();
    if (b.depart_date < today) throw bad("Travel date can't be in the past");
    if (b.depart_date > new Date(Date.now() + 366 * 864e5).toLocaleDateString("en-CA", { timeZone: TZ })) throw bad("Travel date is too far ahead");
    if (!isTime(b.depart_time)) throw bad("Choose a valid departure time");
    if (!VEHICLES.includes(b.vehicle_type)) throw bad("Choose a vehicle type");

    let seats = null;
    if (b.vehicle_type !== "public") {
      seats = Number(b.seats_total);
      if (!Number.isInteger(seats) || seats < 1 || seats > SEAT_VEHICLES[b.vehicle_type]) throw bad(`Seats for a ${b.vehicle_type} must be between 1 and ${SEAT_VEHICLES[b.vehicle_type]}`);
    }
    let contribution = null;
    if (b.contribution_inr !== undefined && b.contribution_inr !== null && b.contribution_inr !== "") {
      contribution = Number(b.contribution_inr);
      if (!Number.isInteger(contribution) || contribution < 0 || contribution > 5000) throw bad("Contribution must be a whole number between 0 and 5000");
    }
    const recurring = listOf(b.recurring, 7, 3).filter((d) => DAYS.includes(d));
    const me = await db.one("SELECT gender FROM users WHERE id = $1", [req.user.id]);
    if (b.women_only && me.gender !== "female") throw bad("Only members who set their gender to female can post women-only trips");

    const dup = await db.one("SELECT id FROM trips WHERE owner_id=$1 AND LOWER(origin)=$2 AND LOWER(destination)=$3 AND depart_date=$4 AND depart_time=$5 AND status IN ('open','closed')",
      [req.user.id, origin.toLowerCase(), destination.toLowerCase(), b.depart_date, b.depart_time]);
    if (dup) throw new HttpError(409, "You've already posted this trip");
    const openCount = await db.one("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM trips WHERE owner_id=$1 AND status='open' AND depart_date >= $2", [req.user.id, today]);
    if (openCount.n >= 15) throw bad("You have 15 open trips already. Complete or cancel some first.");
    const images = checkImages(b.images, req.user.id, "posts", MAX_IMAGES);
    const g = await explore.resolveTripGeo({ origin, destination, originPoint: explore.pointParam(b.origin_point), destPoint: explore.pointParam(b.dest_point) });

    const newId = await db.tx(async (t) => {
      const rows = await t.query(
        `INSERT INTO trips (owner_id, origin, destination, depart_date, depart_time, vehicle_type, vehicle_model, seats_total, contribution_inr, women_only, recurring, description,
                            origin_lat, origin_lng, dest_lat, dest_lng, route_distance_m, route_duration_s, route_geom)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
        [req.user.id, origin, destination, b.depart_date, b.depart_time, b.vehicle_type, clean(b.vehicle_model, 60), seats, contribution, b.women_only ? 1 : 0, recurring.join(","), clean(b.description, CAPTION_MAX),
          g.origin_lat, g.origin_lng, g.dest_lat, g.dest_lng, g.route_distance_m, g.route_duration_s, g.route_geom]);
      for (const [i, im] of images.entries()) {
        await t.query("INSERT INTO trip_images (trip_id, url, public_id, width, height, position) VALUES ($1,$2,$3,$4,$5,$6)", [rows[0].id, im.url, im.public_id, im.width, im.height, i]);
      }
      return rows[0].id;
    });
    const created = await getTrip(newId, req.user.id);
    social.onTripCreated(created).catch((err) => console.error("route alerts failed:", err.message));
    res.status(201).json({ trip: created });
  });

  app.get("/api/trips/:id", optionalAuth, async (req, res) => {
    const id = intParam(req.params.id);
    const viewer = req.user ? req.user.id : null;
    const trip = await getTrip(id, viewer);
    if (!trip) throw new HttpError(404, "Trip not found");
    const out = { trip };
    if (trip.is_owner) {
      const rows = await db.query(
        `SELECT i.id, i.status, i.message, i.created_at, (SELECT c.id FROM conversations c WHERE c.trip_id = i.trip_id AND c.member_id = i.user_id) AS conversation_id, u.id AS uid, u.name, u.username, u.avatar_url, CASE WHEN u.show_college = 1 THEN u.college ELSE '' END AS college, u.bio, u.avatar_color, u.edu_email, ${RATING_COLS}
         FROM interests i JOIN users u ON u.id = i.user_id WHERE i.trip_id = $1 AND i.status <> 'withdrawn'
         ORDER BY CASE i.status WHEN 'pending' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END, i.id`, [id]);
      out.interests = rows.map((r) => ({ id: r.id, status: r.status, message: r.message, created_at: r.created_at, conversation_id: r.conversation_id || null,
        user: { id: r.uid, name: r.name, username: r.username, avatar_url: r.avatar_url || null, college: r.college, avatar_color: r.avatar_color, edu_email: !!r.edu_email, rating: avgRating(r), rating_count: r.rating_count } }));
    }
    else if (viewer) {
      const c = await db.one("SELECT id FROM conversations WHERE trip_id = $1 AND member_id = $2", [id, viewer]);
      out.conversation_id = c ? c.id : null;
    }
    res.json(out);
  });

  // Tell the people involved in a trip about real changes: in their conversations and as notifications.
  async function announceTripChange(before, after, ownerId) {
    try {
      const route = `${after.origin} → ${after.destination}`;
      const involved = await db.query(`SELECT user_id FROM interests WHERE trip_id = $1 AND status IN ('pending','accepted')
                                       UNION SELECT member_id AS user_id FROM conversations WHERE trip_id = $1`, [after.id]);
      const confirmed = new Set((await db.query("SELECT user_id FROM trip_participants WHERE trip_id = $1 AND status = 'confirmed'", [after.id])).map((r) => r.user_id));
      const active = new Set((await db.query("SELECT user_id FROM interests WHERE trip_id = $1 AND status IN ('pending','accepted')", [after.id])).map((r) => r.user_id));
      const ids = [...new Set(involved.map((r) => r.user_id))].filter((u) => u !== ownerId);
      if (before.status !== after.status && after.status === "cancelled") {
        await chat.postEventToTrip(after.id, ownerId, "Trip cancelled by the owner");
        for (const uid of ids) await notify(uid, { type: "trip_cancelled", title: "Trip cancelled", body: `${route} on ${after.depart_date} was cancelled`, link: `#/trip/${after.id}`, actorId: ownerId });
        return;
      }
      if (before.status !== after.status && after.status === "completed") {
        for (const uid of confirmed) await notify(uid, { type: "trip_completed", title: "Trip completed", body: `How did ${route} go? You can now rate your co-travellers.`, link: `#/trip/${after.id}`, actorId: ownerId });
        return;
      }
      const changes = [];
      if (before.origin !== after.origin || before.destination !== after.destination) changes.push(`route is now ${route}`);
      if (before.depart_date !== after.depart_date) changes.push(`date ${before.depart_date} → ${after.depart_date}`);
      if (before.depart_time !== after.depart_time) changes.push(`departure ${before.depart_time} → ${after.depart_time}`);
      if (before.seats_total !== after.seats_total && after.seats_total != null) changes.push(`seats offered: ${after.seats_total}`);
      if (before.contribution_inr !== after.contribution_inr) changes.push(after.contribution_inr == null ? "cost share removed" : `cost share ₹${after.contribution_inr}`);
      if (before.status !== after.status && after.status === "closed") changes.push("no longer taking requests");
      if (before.status !== after.status && after.status === "open" && before.status === "closed") changes.push("taking requests again");
      if (!changes.length) return;
      const text = `Trip updated: ${changes.join("; ")}`;
      await chat.postEventToTrip(after.id, ownerId, text);
      for (const uid of ids) if (confirmed.has(uid) || active.has(uid)) await notify(uid, { type: "trip_changed", title: "Trip updated", body: `${route}: ${changes.join("; ")}`, link: `#/trip/${after.id}`, actorId: ownerId, ref: `trip:${after.id}` });
    } catch (err) { console.error("trip change announcement failed:", err.message); }
  }

  app.patch("/api/trips/:id", auth, writeLimit("trip-edit", L.write), async (req, res) => {
    const id = intParam(req.params.id);
    const b = req.body || {};
    const removedPublicIds = [];
    let geoSets = null;
    if (["origin", "destination", "origin_point", "dest_point"].some((k) => k in b)) {
      const cur = await db.one("SELECT owner_id, origin, destination, origin_lat, origin_lng, dest_lat, dest_lng FROM trips WHERE id = $1", [id]);
      if (cur && cur.owner_id === req.user.id) {
        const o = "origin" in b ? clean(b.origin, 80) : cur.origin, d = "destination" in b ? clean(b.destination, 80) : cur.destination;
        const op = "origin_point" in b ? explore.pointParam(b.origin_point) : o === cur.origin && cur.origin_lat != null ? { lat: cur.origin_lat, lng: cur.origin_lng } : null;
        const dp = "dest_point" in b ? explore.pointParam(b.dest_point) : d === cur.destination && cur.dest_lat != null ? { lat: cur.dest_lat, lng: cur.dest_lng } : null;
        geoSets = await explore.resolveTripGeo({ origin: o, destination: d, originPoint: op, destPoint: dp });
      }
    }
    const result = await db.tx(async (t) => {
      const trip = await t.one("SELECT * FROM trips WHERE id = $1 FOR UPDATE", [id]);
      if (!trip) throw new HttpError(404, "Trip not found");
      if (trip.owner_id !== req.user.id) throw new HttpError(403, "Only the trip owner can change this trip");
      const sets = {};
      if ("status" in b) {
        if (!["open", "closed", "completed", "cancelled"].includes(b.status)) throw bad("Invalid status");
        if (["completed", "cancelled"].includes(trip.status) && b.status !== trip.status) throw bad(`This trip is already ${trip.status}`);
        sets.status = b.status;
      }
      if (["origin", "destination"].some((k) => k in b)) {
        const o = "origin" in b ? clean(b.origin, 80) : trip.origin, d = "destination" in b ? clean(b.destination, 80) : trip.destination;
        if (o.length < 2 || d.length < 2) throw bad("Enter where you're starting from and where you're going");
        if (o.toLowerCase() === d.toLowerCase()) throw bad("Start and destination must be different");
        sets.origin = o; sets.destination = d;
      }
      if ("depart_date" in b) {
        if (!isDate(b.depart_date)) throw bad("Choose a valid travel date");
        if (b.depart_date !== trip.depart_date && b.depart_date < todayStr()) throw bad("Travel date can't be in the past");
        if (b.depart_date > new Date(Date.now() + 366 * 864e5).toLocaleDateString("en-CA", { timeZone: TZ })) throw bad("Travel date is too far ahead");
        sets.depart_date = b.depart_date;
      }
      if ("depart_time" in b) { if (!isTime(b.depart_time)) throw bad("Choose a valid departure time"); sets.depart_time = b.depart_time; }
      if ("vehicle_model" in b) sets.vehicle_model = clean(b.vehicle_model, 60);
      if ("recurring" in b) sets.recurring = listOf(b.recurring, 7, 3).filter((d) => DAYS.includes(d)).join(",");
      if ("seats_total" in b) {
        if (trip.seats_total == null) throw bad("Seats don't apply to this trip");
        const n = Number(b.seats_total);
        const max = SEAT_VEHICLES[trip.vehicle_type] || 8;
        if (!Number.isInteger(n) || n < 0 || n > max) throw bad(`Seats must be between 0 and ${max}`);
        const c = await t.one("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM trip_participants WHERE trip_id=$1 AND status='confirmed'", [id]);
        if (n < c.n) throw bad(`${c.n} traveller(s) are already confirmed, so seats can't go below ${c.n}`);
        sets.seats_total = n;
      }
      if ("description" in b) sets.description = clean(b.description, CAPTION_MAX);
      if (geoSets) Object.assign(sets, geoSets);
      if ("contribution_inr" in b) {
        if (b.contribution_inr === null || b.contribution_inr === "") sets.contribution_inr = null;
        else { const n = Number(b.contribution_inr); if (!Number.isInteger(n) || n < 0 || n > 5000) throw bad("Contribution must be a whole number between 0 and 5000"); sets.contribution_inr = n; }
      }

      // photos: remove some and/or add new ones (max MAX_IMAGES in total)
      const existing = await t.query("SELECT id, public_id FROM trip_images WHERE trip_id=$1", [id]);
      const removeIds = new Set((Array.isArray(b.remove_image_ids) ? b.remove_image_ids : []).map(Number).filter(Number.isInteger));
      const toRemove = existing.filter((e) => removeIds.has(e.id));
      const room = MAX_IMAGES - (existing.length - toRemove.length);
      const added = checkImages(b.add_images, req.user.id, "posts", Math.max(room, 0));
      for (const e of toRemove) { await t.query("DELETE FROM trip_images WHERE id=$1 AND trip_id=$2", [e.id, id]); removedPublicIds.push(e.public_id); }
      if (added.length) {
        const pos = await t.one("SELECT CAST(COALESCE(MAX(position), -1) AS INTEGER) AS p FROM trip_images WHERE trip_id=$1", [id]);
        for (const [i, im] of added.entries()) await t.query("INSERT INTO trip_images (trip_id, url, public_id, width, height, position) VALUES ($1,$2,$3,$4,$5,$6)", [id, im.url, im.public_id, im.width, im.height, pos.p + 1 + i]);
      }

      const cols = Object.keys(sets);
      if (cols.length) {
        await t.query(`UPDATE trips SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")}, updated_at = $${cols.length + 1} WHERE id = $${cols.length + 2}`,
          [...cols.map((c) => sets[c]), new Date().toISOString(), id]);
      }
      return { before: trip, after: await getTrip(id, req.user.id, t) };
    });
    removedPublicIds.forEach((p) => destroyImage(p));
    await announceTripChange(result.before, result.after, req.user.id);
    const out = result.after;
    res.json({ trip: out });
  });

  app.delete("/api/trips/:id", auth, writeLimit("trip-edit", L.write), async (req, res) => {
    const id = intParam(req.params.id);
    const publicIds = await db.tx(async (t) => {
      const trip = await t.one("SELECT owner_id FROM trips WHERE id = $1 FOR UPDATE", [id]);
      if (!trip) throw new HttpError(404, "Trip not found");
      if (trip.owner_id !== req.user.id) throw new HttpError(403, "Only the trip owner can delete this trip");
      const c = await t.one("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM trip_participants WHERE trip_id=$1 AND status='confirmed'", [id]);
      if (c.n > 0) throw bad("People are confirmed on this trip. Cancel it instead, so they're told it's off.");
      const imgs = await t.query("SELECT public_id FROM trip_images WHERE trip_id=$1", [id]);
      await t.query("DELETE FROM trips WHERE id = $1", [id]); // likes, comments, images, interests cascade
      return imgs.map((i) => i.public_id);
    });
    publicIds.forEach((p) => destroyImage(p));
    res.json({ ok: true });
  });

  // ----- likes -----
  async function likeState(tripId, userId) {
    const n = await db.one("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM trip_likes WHERE trip_id = $1", [tripId]);
    const mine = await db.one("SELECT 1 AS x FROM trip_likes WHERE trip_id = $1 AND user_id = $2", [tripId, userId]);
    return { liked: !!mine, like_count: n.n };
  }
  app.post("/api/trips/:id/like", auth, writeLimit("like", L.like), async (req, res) => {
    const id = intParam(req.params.id);
    if (!(await db.one("SELECT id FROM trips WHERE id=$1", [id]))) throw new HttpError(404, "Trip not found");
    await db.query("INSERT INTO trip_likes (user_id, trip_id) VALUES ($1,$2) ON CONFLICT (user_id, trip_id) DO NOTHING", [req.user.id, id]); // idempotent
    res.json(await likeState(id, req.user.id));
  });
  app.delete("/api/trips/:id/like", auth, writeLimit("like", L.like), async (req, res) => {
    const id = intParam(req.params.id);
    await db.query("DELETE FROM trip_likes WHERE user_id=$1 AND trip_id=$2", [req.user.id, id]);
    res.json(await likeState(id, req.user.id));
  });

  // ----- comments -----
  const commentCount = async (tripId) => (await db.one("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM trip_comments WHERE trip_id=$1", [tripId])).n;
  app.get("/api/trips/:id/comments", optionalAuth, async (req, res) => {
    const id = intParam(req.params.id);
    const trip = await db.one("SELECT owner_id FROM trips WHERE id=$1", [id]);
    if (!trip) throw new HttpError(404, "Trip not found");
    const me = req.user ? req.user.id : null;
    const limit = 30, offset = Math.min(Math.max(parseInt(req.query.offset, 10) || 0, 0), 10_000);
    const rows = await db.query(
      `SELECT c.id, c.body, c.created_at, c.user_id, u.name, u.username, u.avatar_url, u.avatar_color
       FROM trip_comments c JOIN users u ON u.id = c.user_id WHERE c.trip_id = $1 ORDER BY c.id LIMIT $2 OFFSET $3`, [id, limit + 1, offset]);
    res.json({
      comments: rows.slice(0, limit).map((r) => ({
        id: r.id, body: r.body, created_at: r.created_at, mine: r.user_id === me, can_delete: me != null && (r.user_id === me || trip.owner_id === me),
        user: { id: r.user_id, name: r.name, username: r.username, avatar_url: r.avatar_url || null, avatar_color: r.avatar_color },
      })),
      has_more: rows.length > limit, next_offset: offset + limit, comment_count: await commentCount(id),
    });
  });
  app.post("/api/trips/:id/comments", auth, writeLimit("comment", L.comment), async (req, res) => {
    const id = intParam(req.params.id);
    if (!(await db.one("SELECT id FROM trips WHERE id=$1", [id]))) throw new HttpError(404, "Trip not found");
    const body = clean((req.body || {}).body, 300);
    if (!body) throw bad("Write something before posting");
    const rows = await db.query("INSERT INTO trip_comments (trip_id, user_id, body) VALUES ($1,$2,$3) RETURNING id", [id, req.user.id, body]);
    const u = await db.one("SELECT name, username, avatar_url, avatar_color FROM users WHERE id=$1", [req.user.id]);
    res.status(201).json({
      comment: { id: rows[0].id, body, created_at: new Date().toISOString(), mine: true, can_delete: true, user: { id: req.user.id, name: u.name, username: u.username, avatar_url: u.avatar_url || null, avatar_color: u.avatar_color } },
      comment_count: await commentCount(id),
    });
  });
  app.delete("/api/comments/:id", auth, writeLimit("comment", L.comment), async (req, res) => {
    const id = intParam(req.params.id);
    const c = await db.one("SELECT c.id, c.user_id, c.trip_id, t.owner_id FROM trip_comments c JOIN trips t ON t.id = c.trip_id WHERE c.id=$1", [id]);
    if (!c) throw new HttpError(404, "Comment not found");
    if (c.user_id !== req.user.id && c.owner_id !== req.user.id) throw new HttpError(403, "You can only delete your own comments (or comments on your own post)");
    await db.query("DELETE FROM trip_comments WHERE id=$1", [id]);
    res.json({ ok: true, comment_count: await commentCount(c.trip_id) });
  });

  // ----- interest workflow -----
  app.post("/api/trips/:id/interest", auth, writeLimit("interest", L.interest), async (req, res) => {
    const id = intParam(req.params.id);
    const trip = await getTrip(id, req.user.id);
    if (!trip) throw new HttpError(404, "Trip not found");
    if (trip.is_owner) throw bad("This is your own trip");
    if (trip.status !== "open") throw bad("This trip isn't accepting requests");
    if (trip.depart_date < todayStr()) throw bad("This trip has already happened");
    if (trip.is_full) throw bad("No seats left on this trip");
    await chat.assertNotBlocked(req.user.id, trip.owner.id);
    if (trip.women_only) {
      const me = await db.one("SELECT gender FROM users WHERE id = $1", [req.user.id]);
      if (me.gender !== "female") throw new HttpError(403, "This is a women-only trip");
    }
    const pending = await db.one("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM interests WHERE user_id=$1 AND status='pending'", [req.user.id]);
    if (pending.n >= 20) throw bad("You have 20 pending requests. Wait for replies or withdraw some first.");
    const rows = await db.query(
      `INSERT INTO interests (trip_id, user_id, message) VALUES ($1,$2,$3)
       ON CONFLICT (trip_id, user_id) DO UPDATE SET status = 'pending', message = $3, updated_at = $4
       WHERE interests.status = 'withdrawn' RETURNING id`,
      [id, req.user.id, clean((req.body || {}).message, 200), new Date().toISOString()]);
    if (!rows.length) {
      const cur = await db.one("SELECT status FROM interests WHERE trip_id=$1 AND user_id=$2", [id, req.user.id]);
      throw new HttpError(409, cur.status === "declined" ? "The trip owner declined your request" : cur.status === "accepted" ? "You're already confirmed on this trip" : "You've already expressed interest");
    }
    // The request opens (or reuses) a private conversation so both sides can talk it through before deciding.
    const note = clean((req.body || {}).message, 200);
    const conv = await chat.postEvent(id, req.user.id, req.user.id, "Asked to join this trip (this doesn't reserve a seat)", { create: true });
    if (conv && note) await chat.addMessage(conv, req.user.id, { kind: "text", body: note });
    const requester = await db.one("SELECT name FROM users WHERE id = $1", [req.user.id]);
    await notify(trip.owner.id, { type: "interest_request", title: "New request to join", body: `${requester.name} asked to join ${trip.origin} → ${trip.destination}`,
      link: conv ? `#/inbox/${conv.id}` : `#/trip/${id}`, actorId: req.user.id });
    res.status(201).json({ trip: await getTrip(id, req.user.id) });
  });

  app.delete("/api/trips/:id/interest", auth, writeLimit("interest", L.interest), async (req, res) => {
    const id = intParam(req.params.id);
    const prev = await db.tx(async (t) => {
      const i = await t.one("SELECT id, status FROM interests WHERE trip_id=$1 AND user_id=$2", [id, req.user.id]);
      if (!i || !["pending", "accepted"].includes(i.status)) throw bad("You have no active request on this trip");
      const now = new Date().toISOString();
      await t.query("UPDATE interests SET status='withdrawn', updated_at=$1 WHERE id=$2", [now, i.id]);
      await t.query("UPDATE trip_participants SET status='left' WHERE trip_id=$1 AND user_id=$2 AND status='confirmed'", [id, req.user.id]);
      return i.status;
    });
    const trip = await getTrip(id, req.user.id);
    const conv = await chat.postEvent(id, req.user.id, req.user.id, prev === "accepted" ? "Left the trip" : "Withdrew the request");
    const who = await db.one("SELECT name FROM users WHERE id = $1", [req.user.id]);
    await notify(trip.owner.id, { type: "interest_withdrawn", title: prev === "accepted" ? "A traveller left your trip" : "Request withdrawn",
      body: `${who.name} ${prev === "accepted" ? "left" : "withdrew their request for"} ${trip.origin} → ${trip.destination}`, link: conv ? `#/inbox/${conv.id}` : `#/trip/${id}`, actorId: req.user.id });
    res.json({ trip });
  });

  app.post("/api/interests/:id/:action", auth, writeLimit("interest-manage", 200), async (req, res) => {
    const id = intParam(req.params.id);
    const { action } = req.params;
    if (!["accept", "decline"].includes(action)) throw new HttpError(404, "Not found");
    const tripId = await db.tx(async (t) => {
      const row = await t.one(
        `SELECT i.id, i.status, i.user_id, i.trip_id, tr.owner_id, tr.seats_total, tr.status AS trip_status
         FROM interests i JOIN trips tr ON tr.id = i.trip_id WHERE i.id = $1 FOR UPDATE OF tr`, [id]);
      if (!row) throw new HttpError(404, "Request not found");
      if (row.owner_id !== req.user.id) throw new HttpError(403, "Only the trip owner can respond to requests");
      const now = new Date().toISOString();
      if (action === "accept") {
        if (row.status !== "pending") throw bad(`This request is ${row.status}`);
        if (!["open", "closed"].includes(row.trip_status)) throw bad(`This trip is ${row.trip_status}`);
        if (row.seats_total != null) {
          const c = await t.one("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM trip_participants WHERE trip_id=$1 AND status='confirmed'", [row.trip_id]);
          if (c.n >= row.seats_total) throw bad("No seats left. Increase available seats first.");
        }
        await t.query(`INSERT INTO trip_participants (trip_id, user_id, status) VALUES ($1,$2,'confirmed')
                       ON CONFLICT (trip_id, user_id) DO UPDATE SET status = 'confirmed'`, [row.trip_id, row.user_id]);
        await t.query("UPDATE interests SET status='accepted', updated_at=$1 WHERE id=$2", [now, id]);
      } else {
        if (!["pending", "accepted"].includes(row.status)) throw bad(`This request is ${row.status}`);
        await t.query("UPDATE interests SET status='declined', updated_at=$1 WHERE id=$2", [now, id]);
        await t.query("UPDATE trip_participants SET status='removed' WHERE trip_id=$1 AND user_id=$2 AND status='confirmed'", [row.trip_id, row.user_id]);
      }
      return { trip_id: row.trip_id, user_id: row.user_id, action, prev: row.status };
    });
    const owner = await db.one("SELECT name FROM users WHERE id = $1", [req.user.id]);
    const tv = await getTrip(tripId.trip_id, req.user.id);
    const route = `${tv.origin} → ${tv.destination}`;
    if (tripId.action === "accept") {
      const conv = await chat.postEvent(tripId.trip_id, tripId.user_id, req.user.id, "Accepted the request — your seat is confirmed", { create: true });
      await notify(tripId.user_id, { type: "interest_accepted", title: "You're confirmed!", body: `${owner.name} accepted your request for ${route}`, link: conv ? `#/inbox/${conv.id}` : `#/trip/${tripId.trip_id}`, actorId: req.user.id });
    } else {
      const wasIn = tripId.prev === "accepted";
      const conv = await chat.postEvent(tripId.trip_id, tripId.user_id, req.user.id, wasIn ? "Removed you from this trip" : "Declined the request");
      await notify(tripId.user_id, { type: "interest_declined", title: wasIn ? "Removed from a trip" : "Request declined", body: `${owner.name} ${wasIn ? "removed you from" : "declined your request for"} ${route}`, link: conv ? `#/inbox/${conv.id}` : `#/trip/${tripId.trip_id}`, actorId: req.user.id });
    }
    res.json({ trip: await getTrip(tripId.trip_id, req.user.id) });
  });

  // ----- my trips -----
  app.get("/api/me/trips", auth, async (req, res) => {
    const me = req.user.id;
    const [posted, interested, saved] = await Promise.all([
      db.query(`${TRIP_SELECT} WHERE t.owner_id = $1 ORDER BY t.depart_date DESC, t.depart_time DESC LIMIT 100`, [me]),
      db.query(`${TRIP_SELECT} WHERE EXISTS (SELECT 1 FROM interests i WHERE i.trip_id = t.id AND i.user_id = $1 AND i.status <> 'withdrawn') ORDER BY t.depart_date DESC, t.depart_time DESC LIMIT 100`, [me]),
      db.query(`${TRIP_SELECT} WHERE EXISTS (SELECT 1 FROM saved_trips s WHERE s.trip_id = t.id AND s.user_id = $1) ORDER BY t.depart_date, t.depart_time LIMIT 100`, [me]),
    ]);
    const [p, i, sv] = await Promise.all([tripViews(posted, me), tripViews(interested, me), tripViews(saved, me)]);
    res.json({ posted: p, interested: i, saved: sv });
  });

  // ----- save / report -----
  app.post("/api/trips/:id/save", auth, writeLimit("save", 200), async (req, res) => {
    const id = intParam(req.params.id);
    if (!(await db.one("SELECT id FROM trips WHERE id=$1", [id]))) throw new HttpError(404, "Trip not found");
    await db.query("INSERT INTO saved_trips (user_id, trip_id) VALUES ($1,$2) ON CONFLICT (user_id, trip_id) DO NOTHING", [req.user.id, id]);
    res.json({ saved: true });
  });
  app.delete("/api/trips/:id/save", auth, async (req, res) => {
    await db.query("DELETE FROM saved_trips WHERE user_id=$1 AND trip_id=$2", [req.user.id, intParam(req.params.id)]);
    res.json({ saved: false });
  });

  app.post("/api/trips/:id/report", auth, writeLimit("report", L.report), async (req, res) => {
    const id = intParam(req.params.id);
    const trip = await db.one("SELECT owner_id FROM trips WHERE id=$1", [id]);
    if (!trip) throw new HttpError(404, "Trip not found");
    if (trip.owner_id === req.user.id) throw bad("You can't report your own trip");
    const reason = (req.body || {}).reason;
    if (!REPORT_REASONS.includes(reason)) throw bad("Choose a reason for the report");
    const rows = await db.query("INSERT INTO reports (trip_id, reporter_id, reason, details) VALUES ($1,$2,$3,$4) ON CONFLICT (trip_id, reporter_id) DO NOTHING RETURNING id",
      [id, req.user.id, reason, clean((req.body || {}).details, 300)]);
    if (!rows.length) throw new HttpError(409, "You've already reported this trip");
    res.status(201).json({ ok: true });
  });

  // ----- legacy per-trip thread endpoints (kept for compatibility; backed by conversations) -----
  async function legacyThread(req) {
    const id = intParam(req.params.id);
    const trip = await db.one("SELECT id, owner_id FROM trips WHERE id=$1", [id]);
    if (!trip) throw new HttpError(404, "Trip not found");
    const isOwner = trip.owner_id === req.user.id;
    const member = isOwner ? intParam(req.query.with ?? (req.body || {}).with) : req.user.id;
    if (member === trip.owner_id) throw bad("Invalid conversation");
    let conv = await chat.findConversation(id, member);
    if (!conv) {
      const interest = await db.one("SELECT status FROM interests WHERE trip_id=$1 AND user_id=$2", [id, member]);
      if (!interest) throw new HttpError(403, "Messaging opens once someone has expressed interest in this trip");
      conv = await chat.ensureConversation(id, member, req.user.id);
    }
    return chat.access(req.user.id, conv.id);
  }
  app.get("/api/trips/:id/messages", auth, async (req, res) => {
    const a = await legacyThread(req);
    const rows = await db.query("SELECT * FROM (SELECT id, sender_id, body, kind, created_at FROM messages WHERE trip_id=$1 AND thread_user_id=$2 ORDER BY id DESC LIMIT 100) m ORDER BY id", [a.c.trip_id, a.c.member_id]);
    res.json({ conversation_id: a.c.id, messages: rows.map((m) => ({ id: m.id, kind: m.kind || "text", body: m.body, created_at: chat.iso(m.created_at), mine: m.sender_id === req.user.id })), can_send: !a.closed });
  });
  app.post("/api/trips/:id/messages", auth, writeLimit("message", L.message, 600_000), async (req, res) => {
    const a = await legacyThread(req);
    if (a.closed) throw new HttpError(403, a.closed);
    const body = clean((req.body || {}).body, 1000);
    if (!body) throw bad("Message can't be empty");
    await chat.addMessage(a.c, req.user.id, { kind: "text", body });
    const sender = await db.one("SELECT name FROM users WHERE id = $1", [req.user.id]);
    await notify(a.otherId, { type: "new_message", title: `New message from ${sender.name}`, body: `About ${a.c.origin} → ${a.c.destination}`, link: `#/inbox/${a.c.id}`, ref: `conv:${a.c.id}`, actorId: req.user.id });
    res.status(201).json({ ok: true, conversation_id: a.c.id });
  });

  // ----- ratings -----
  app.post("/api/trips/:id/rate", auth, writeLimit("rate", 60), async (req, res) => {
    const id = intParam(req.params.id);
    const b = req.body || {};
    const trip = await db.one("SELECT owner_id, status FROM trips WHERE id=$1", [id]);
    if (!trip) throw new HttpError(404, "Trip not found");
    if (trip.status !== "completed") throw bad("You can rate people once the trip is completed");
    const stars = Number(b.stars), ratee = Number(b.ratee_id);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw bad("Choose 1 to 5 stars");
    if (!Number.isInteger(ratee) || ratee === req.user.id) throw bad("Invalid person to rate");
    const took = async (uid) => uid === trip.owner_id || !!(await db.one("SELECT id FROM trip_participants WHERE trip_id=$1 AND user_id=$2 AND status='confirmed'", [id, uid]));
    if (!(await took(req.user.id)) || !(await took(ratee))) throw new HttpError(403, "Only people who travelled together can rate each other");
    const rows = await db.query("INSERT INTO ratings (trip_id, rater_id, ratee_id, stars, comment) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (trip_id, rater_id, ratee_id) DO NOTHING RETURNING id",
      [id, req.user.id, ratee, stars, clean(b.comment, 200)]);
    if (!rows.length) throw new HttpError(409, "You've already rated this person for this trip");
    res.status(201).json({ ok: true });
  });

  // ----- participants (owner only, for rating UI) -----
  app.get("/api/trips/:id/participants", auth, async (req, res) => {
    const id = intParam(req.params.id);
    const trip = await db.one("SELECT owner_id FROM trips WHERE id=$1", [id]);
    if (!trip) throw new HttpError(404, "Trip not found");
    const inTrip = trip.owner_id === req.user.id || await db.one("SELECT id FROM trip_participants WHERE trip_id=$1 AND user_id=$2 AND status='confirmed'", [id, req.user.id]);
    if (!inTrip) throw new HttpError(403, "Only people on this trip can see who's confirmed");
    const rows = await db.query(`SELECT u.id, u.name, u.avatar_color FROM trip_participants p JOIN users u ON u.id = p.user_id WHERE p.trip_id=$1 AND p.status='confirmed'
      UNION SELECT u.id, u.name, u.avatar_color FROM trips t JOIN users u ON u.id = t.owner_id WHERE t.id=$1`, [id]);
    const mine = await db.query("SELECT ratee_id FROM ratings WHERE trip_id=$1 AND rater_id=$2", [id, req.user.id]);
    const rated = new Set(mine.map((r) => r.ratee_id));
    res.json({ people: rows.filter((r) => r.id !== req.user.id).map((r) => ({ ...r, rated: rated.has(r.id) })) });
  });

  // ----- share links: /p/:id serves link-preview tags, then sends people to the app -----
  const escHtml = (x) => String(x ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  app.get("/p/:id", async (req, res, next) => {
    if (!/^\d{1,9}$/.test(req.params.id)) return next();
    const r = await db.one(`SELECT t.id, t.origin, t.destination, t.depart_date, t.depart_time, t.description, t.status, u.name, u.username
                            FROM trips t JOIN users u ON u.id = t.owner_id WHERE t.id = $1`, [Number(req.params.id)]);
    if (!r) return res.redirect(302, "/");
    const img = await db.one("SELECT url FROM trip_images WHERE trip_id = $1 ORDER BY position, id LIMIT 1", [r.id]);
    const origin = `${req.protocol}://${req.get("host")}`;
    const title = `${r.origin} → ${r.destination} · ${r.name} on SaathRide`;
    const desc = (r.description || `Travelling ${r.depart_date} at ${r.depart_time}. See who's heading your way on SaathRide.`).slice(0, 200);
    const pic = img ? img.url.replace("/image/upload/", "/image/upload/c_fill,w_1200,h_630,q_auto,f_auto/") : "";
    const dest = `/#/trip/${r.id}`;
    res.set("Cache-Control", "public, max-age=60").type("html").send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" />
<title>${escHtml(title)}</title><meta name="description" content="${escHtml(desc)}" />
<meta property="og:type" content="website" /><meta property="og:site_name" content="SaathRide" /><meta property="og:title" content="${escHtml(title)}" />
<meta property="og:description" content="${escHtml(desc)}" /><meta property="og:url" content="${escHtml(origin + "/p/" + r.id)}" />
${pic ? `<meta property="og:image" content="${escHtml(pic)}" /><meta name="twitter:card" content="summary_large_image" />` : `<meta name="twitter:card" content="summary" />`}
<meta http-equiv="refresh" content="0;url=${escHtml(dest)}" /></head><body><p><a href="${escHtml(dest)}">Open this journey on SaathRide</a></p></body></html>`);
  });

  // ----- static + fallbacks -----
  app.use("/api", (_req, _res, next) => next(new HttpError(404, "Not found")));
  app.use(express.static(path.join(__dirname, "public"), { maxAge: IS_PROD ? "1h" : 0 }));
  app.use((req, res, next) => (req.method === "GET" ? res.sendFile(path.join(__dirname, "public", "index.html")) : next(new HttpError(404, "Not found"))));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON" });
    if (err.type === "entity.too.large") return res.status(413).json({ error: "Request too large" });
    console.error(`${req.method} ${req.path}:`, err);
    res.status(500).json({ error: "Something went wrong on our side. Please try again." });
  });

  return app;
}

const app = createApp();
module.exports = app;
module.exports.createApp = createApp;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`SaathRide running → http://localhost:${PORT}`));
}
