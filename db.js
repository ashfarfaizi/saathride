// SaathRide — SQLite database setup
const Database = require("better-sqlite3");
const db = new Database(process.env.DB_PATH || "saathride.db");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  phone TEXT,
  gender TEXT DEFAULT 'unspecified',
  college TEXT,
  is_verified INTEGER DEFAULT 0,        -- 1 if college/company email domain
  has_vehicle INTEGER DEFAULT 0,
  vehicle_type TEXT,                    -- 'scooty' | 'bike' | 'car'
  bio TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id INTEGER NOT NULL REFERENCES users(id),
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  depart_date TEXT NOT NULL,            -- YYYY-MM-DD
  depart_time TEXT NOT NULL,            -- HH:MM
  seats_total INTEGER NOT NULL,
  price_per_seat INTEGER NOT NULL,      -- fuel-share in INR
  vehicle_type TEXT NOT NULL,
  women_only INTEGER DEFAULT 0,
  recurring TEXT DEFAULT '',            -- e.g. 'Mon,Fri' or '' for one-time
  notes TEXT DEFAULT '',
  status TEXT DEFAULT 'open',           -- open | completed | cancelled
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ride_id INTEGER NOT NULL REFERENCES rides(id),
  rider_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT DEFAULT 'requested',      -- requested | approved | rejected | cancelled
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(ride_id, rider_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ride_id INTEGER NOT NULL REFERENCES rides(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ride_id INTEGER NOT NULL REFERENCES rides(id),
  rater_id INTEGER NOT NULL REFERENCES users(id),
  ratee_id INTEGER NOT NULL REFERENCES users(id),
  stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5),
  comment TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(ride_id, rater_id, ratee_id)
);
`);

module.exports = db;
