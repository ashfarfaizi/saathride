// SaathRide — Express backend
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-production";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- helpers ----------
const EDU_DOMAINS = [".ac.in", ".edu.in", ".edu", ".iitb.ac.in", ".ac.uk"];
const isEduEmail = (email) => EDU_DOMAINS.some((d) => email.toLowerCase().endsWith(d));

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Login required" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Session expired. Log in again." });
  }
}

function publicUser(u) {
  if (!u) return null;
  const { password_hash, ...rest } = u;
  const agg = db
    .prepare("SELECT AVG(stars) avg, COUNT(*) n FROM ratings WHERE ratee_id=?")
    .get(u.id);
  rest.rating = agg.n ? Math.round(agg.avg * 10) / 10 : null;
  rest.rating_count = agg.n;
  return rest;
}

// ---------- auth ----------
app.post("/api/auth/signup", (req, res) => {
  const { name, email, password, phone, gender, college, has_vehicle, vehicle_type } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: "Name, email and password are required" });
  if (password.length < 6)
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  const exists = db.prepare("SELECT id FROM users WHERE email=?").get(email.toLowerCase());
  if (exists) return res.status(409).json({ error: "An account with this email already exists" });

  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare(
      `INSERT INTO users (name,email,password_hash,phone,gender,college,is_verified,has_vehicle,vehicle_type)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(
      name.trim(),
      email.toLowerCase().trim(),
      hash,
      phone || "",
      gender || "unspecified",
      college || "",
      isEduEmail(email) ? 1 : 0,
      has_vehicle ? 1 : 0,
      vehicle_type || null
    );
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(info.lastInsertRowid);
  const token = jwt.sign({ id: user.id, name: user.name }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, user: publicUser(user) });
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email=?").get((email || "").toLowerCase());
  if (!user || !bcrypt.compareSync(password || "", user.password_hash))
    return res.status(401).json({ error: "Wrong email or password" });
  const token = jwt.sign({ id: user.id, name: user.name }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, user: publicUser(user) });
});

app.get("/api/me", auth, (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  res.json({ user: publicUser(user) });
});

// ---------- rides ----------
app.post("/api/rides", auth, (req, res) => {
  const me = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  const { origin, destination, depart_date, depart_time, seats_total, price_per_seat,
          vehicle_type, women_only, recurring, notes } = req.body;
  if (!origin || !destination || !depart_date || !depart_time || !seats_total || price_per_seat == null)
    return res.status(400).json({ error: "Fill in route, date, time, seats and fuel share" });
  if (women_only && me.gender !== "female")
    return res.status(400).json({ error: "Only female drivers can post women-only rides" });
  const info = db
    .prepare(
      `INSERT INTO rides (driver_id,origin,destination,depart_date,depart_time,seats_total,
        price_per_seat,vehicle_type,women_only,recurring,notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(req.user.id, origin.trim(), destination.trim(), depart_date, depart_time,
         Number(seats_total), Number(price_per_seat), vehicle_type || "car",
         women_only ? 1 : 0, recurring || "", notes || "");
  res.json({ ride: getRide(info.lastInsertRowid) });
});

function getRide(id) {
  const ride = db.prepare("SELECT * FROM rides WHERE id=?").get(id);
  if (!ride) return null;
  ride.driver = publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(ride.driver_id));
  const approved = db
    .prepare("SELECT COUNT(*) n FROM bookings WHERE ride_id=? AND status='approved'")
    .get(id).n;
  ride.seats_left = ride.seats_total - approved;
  return ride;
}

app.get("/api/rides", (req, res) => {
  const { origin, destination, date, women_only } = req.query;
  let sql = "SELECT id FROM rides WHERE status='open'";
  const params = [];
  if (origin) { sql += " AND origin LIKE ?"; params.push(`%${origin}%`); }
  if (destination) { sql += " AND destination LIKE ?"; params.push(`%${destination}%`); }
  if (date) { sql += " AND depart_date = ?"; params.push(date); }
  if (women_only === "1") sql += " AND women_only = 1";
  sql += " ORDER BY depart_date, depart_time LIMIT 50";
  const rides = db.prepare(sql).all(...params).map((r) => getRide(r.id));
  res.json({ rides });
});

app.get("/api/rides/:id", (req, res) => {
  const ride = getRide(req.params.id);
  if (!ride) return res.status(404).json({ error: "Ride not found" });
  ride.bookings = db
    .prepare("SELECT * FROM bookings WHERE ride_id=?")
    .all(ride.id)
    .map((b) => ({ ...b, rider: publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(b.rider_id)) }));
  res.json({ ride });
});

app.post("/api/rides/:id/complete", auth, (req, res) => {
  const ride = db.prepare("SELECT * FROM rides WHERE id=?").get(req.params.id);
  if (!ride) return res.status(404).json({ error: "Ride not found" });
  if (ride.driver_id !== req.user.id)
    return res.status(403).json({ error: "Only the driver can complete a ride" });
  db.prepare("UPDATE rides SET status='completed' WHERE id=?").run(ride.id);
  res.json({ ok: true });
});

// ---------- bookings ----------
app.post("/api/rides/:id/book", auth, (req, res) => {
  const ride = getRide(req.params.id);
  if (!ride || ride.status !== "open") return res.status(404).json({ error: "Ride not available" });
  if (ride.driver_id === req.user.id)
    return res.status(400).json({ error: "You can't book your own ride" });
  if (ride.seats_left < 1) return res.status(400).json({ error: "No seats left" });
  const me = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  if (ride.women_only && me.gender !== "female")
    return res.status(403).json({ error: "This is a women-only ride" });
  try {
    db.prepare("INSERT INTO bookings (ride_id, rider_id) VALUES (?,?)").run(ride.id, req.user.id);
  } catch {
    return res.status(409).json({ error: "You already requested this ride" });
  }
  res.json({ ok: true });
});

app.post("/api/bookings/:id/:action", auth, (req, res) => {
  const { id, action } = req.params;
  if (!["approve", "reject"].includes(action))
    return res.status(400).json({ error: "Unknown action" });
  const booking = db.prepare("SELECT * FROM bookings WHERE id=?").get(id);
  if (!booking) return res.status(404).json({ error: "Booking not found" });
  const ride = getRide(booking.ride_id);
  if (ride.driver_id !== req.user.id)
    return res.status(403).json({ error: "Only the driver can manage requests" });
  if (action === "approve" && ride.seats_left < 1)
    return res.status(400).json({ error: "No seats left" });
  db.prepare("UPDATE bookings SET status=? WHERE id=?")
    .run(action === "approve" ? "approved" : "rejected", id);
  res.json({ ok: true });
});

app.get("/api/me/rides", auth, (req, res) => {
  const driving = db
    .prepare("SELECT id FROM rides WHERE driver_id=? ORDER BY depart_date DESC")
    .all(req.user.id)
    .map((r) => getRide(r.id));
  const riding = db
    .prepare("SELECT ride_id, status FROM bookings WHERE rider_id=? ORDER BY id DESC")
    .all(req.user.id)
    .map((b) => ({ booking_status: b.status, ...getRide(b.ride_id) }));
  res.json({ driving, riding });
});

// ---------- chat ----------
app.get("/api/rides/:id/messages", auth, (req, res) => {
  const ride = db.prepare("SELECT * FROM rides WHERE id=?").get(req.params.id);
  if (!ride) return res.status(404).json({ error: "Ride not found" });
  const allowed =
    ride.driver_id === req.user.id ||
    db.prepare("SELECT id FROM bookings WHERE ride_id=? AND rider_id=? AND status IN ('requested','approved')")
      .get(ride.id, req.user.id);
  if (!allowed) return res.status(403).json({ error: "Request a seat to join the ride chat" });
  const msgs = db
    .prepare(`SELECT m.*, u.name AS sender_name FROM messages m
              JOIN users u ON u.id = m.sender_id WHERE m.ride_id=? ORDER BY m.id`)
    .all(ride.id);
  res.json({ messages: msgs });
});

app.post("/api/rides/:id/messages", auth, (req, res) => {
  const body = (req.body.body || "").trim();
  if (!body) return res.status(400).json({ error: "Message can't be empty" });
  db.prepare("INSERT INTO messages (ride_id, sender_id, body) VALUES (?,?,?)")
    .run(req.params.id, req.user.id, body.slice(0, 500));
  res.json({ ok: true });
});

// ---------- ratings ----------
app.post("/api/rides/:id/rate", auth, (req, res) => {
  const { ratee_id, stars, comment } = req.body;
  const ride = db.prepare("SELECT * FROM rides WHERE id=?").get(req.params.id);
  if (!ride || ride.status !== "completed")
    return res.status(400).json({ error: "You can rate only after the ride is completed" });
  try {
    db.prepare("INSERT INTO ratings (ride_id, rater_id, ratee_id, stars, comment) VALUES (?,?,?,?,?)")
      .run(ride.id, req.user.id, ratee_id, Number(stars), comment || "");
  } catch {
    return res.status(409).json({ error: "You already rated this person for this ride" });
  }
  res.json({ ok: true });
});

app.use((req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

if (require.main === module) {
  app.listen(PORT, () => console.log(`SaathRide running → http://localhost:${PORT}`));
}

module.exports = app;
