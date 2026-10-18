-- SaathRide — upgrade for databases created by an earlier version (Postgres only; safe to re-run).
-- `npm run migrate` runs schema.sql first, then this file.
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_public_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS show_college INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS show_travel_areas INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS show_interests INTEGER NOT NULL DEFAULT 1;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS vehicle_model TEXT NOT NULL DEFAULT '';
UPDATE users SET username = 'user' || CAST(id AS TEXT) WHERE username IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (username);

-- ---- Part 2: messaging, notifications, calls (safe to re-run) ----
ALTER TABLE messages ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'text';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS shared_trip_id INTEGER REFERENCES trips(id) ON DELETE SET NULL;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS ref TEXT NOT NULL DEFAULT '';
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
CREATE INDEX IF NOT EXISTS idx_notifications_ref ON notifications (user_id, ref);
-- Threads created before conversations existed become conversations (no messages are invented).
INSERT INTO conversations (trip_id, owner_id, member_id, created_by, last_activity_at)
  SELECT m.trip_id, t.owner_id, m.thread_user_id, m.thread_user_id, MAX(m.created_at)
  FROM messages m JOIN trips t ON t.id = m.trip_id
  GROUP BY m.trip_id, t.owner_id, m.thread_user_id
  ON CONFLICT (trip_id, member_id) DO NOTHING;

-- ---- Parts 3–4: maps, route matching, saved routes, trip updates, notification preferences (safe to re-run) ----
ALTER TABLE trips ADD COLUMN IF NOT EXISTS origin_lat DOUBLE PRECISION;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS origin_lng DOUBLE PRECISION;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS dest_lat DOUBLE PRECISION;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS dest_lng DOUBLE PRECISION;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS route_distance_m INTEGER;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS route_duration_s INTEGER;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS route_geom TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_prefs TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_users_college ON users (LOWER(college));

-- ---- Email notifications (safe to re-run) ----
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;

-- ---- Safety team: account suspension (safe to re-run) ----
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
