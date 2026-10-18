-- SaathRide — PostgreSQL schema (Neon). Safe to run repeatedly: `npm run migrate`.
-- Written to stay portable: the local test suite runs the same SQL on SQLite.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  phone         TEXT,                                   -- private, never returned to other users
  gender        TEXT NOT NULL DEFAULT 'unspecified',    -- private; only used for women-only trips
  college       TEXT NOT NULL DEFAULT '',               -- college / university / workplace (self-declared)
  edu_email     INTEGER NOT NULL DEFAULT 0,             -- 1 = signed up with an education-domain email (NOT verified)
  has_vehicle   INTEGER NOT NULL DEFAULT 0,
  vehicle_type  TEXT,
  bio           TEXT NOT NULL DEFAULT '',
  travel_areas  TEXT NOT NULL DEFAULT '',               -- comma separated, general areas only
  interests     TEXT NOT NULL DEFAULT '',               -- comma separated
  travel_modes  TEXT NOT NULL DEFAULT '',               -- comma separated
  avatar_color  INTEGER NOT NULL DEFAULT 0,             -- 0..7, picks an avatar colour
  username      TEXT,                                   -- lowercase handle, unique (index in schema_upgrade.sql)
  avatar_url    TEXT,                                   -- Cloudinary image URL (NULL = coloured initials)
  avatar_public_id TEXT,
  show_college  INTEGER NOT NULL DEFAULT 1,             -- privacy: show college/workplace on public profile + posts
  show_travel_areas INTEGER NOT NULL DEFAULT 1,
  show_interests INTEGER NOT NULL DEFAULT 1,
  notif_prefs   TEXT NOT NULL DEFAULT '',               -- JSON of switched-off notification categories
  email_verified_at TIMESTAMPTZ,                        -- set when the member clicks the confirmation link
  last_active_at TIMESTAMPTZ,                           -- coarse (≤1/min) — skip message emails while someone is in the app
  suspended_at  TIMESTAMPTZ,                            -- set by the safety team; blocks sign-in and all actions
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trips (
  id              SERIAL PRIMARY KEY,
  owner_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  origin          TEXT NOT NULL,
  destination     TEXT NOT NULL,
  depart_date     TEXT NOT NULL,                        -- YYYY-MM-DD
  depart_time     TEXT NOT NULL,                        -- HH:MM (24h)
  vehicle_type    TEXT NOT NULL,
  vehicle_model   TEXT NOT NULL DEFAULT '',             -- optional, e.g. 'Pulsar 150'
  seats_total     INTEGER CHECK (seats_total IS NULL OR (seats_total >= 0 AND seats_total <= 20)),  -- NULL = seats not applicable
  contribution_inr INTEGER CHECK (contribution_inr IS NULL OR contribution_inr >= 0),               -- optional cost share
  women_only      INTEGER NOT NULL DEFAULT 0,
  recurring       TEXT NOT NULL DEFAULT '',             -- e.g. 'Mon,Wed,Fri'; '' = one-time
  description     TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','completed','cancelled')),
  origin_lat      DOUBLE PRECISION,                     -- approximate (3 decimals ≈ 100 m) landmark/area, never a home address
  origin_lng      DOUBLE PRECISION,
  dest_lat        DOUBLE PRECISION,
  dest_lng        DOUBLE PRECISION,
  route_distance_m INTEGER,                             -- road route from the map service (NULL = not mapped)
  route_duration_s INTEGER,
  route_geom      TEXT NOT NULL DEFAULT '',             -- JSON [[lng,lat],...] simplified road route
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trips_feed  ON trips (status, depart_date, depart_time);
CREATE INDEX IF NOT EXISTS idx_trips_owner ON trips (owner_id);

-- An interest request: "I'd like to travel with you". Does NOT hold a seat.
CREATE TABLE IF NOT EXISTS interests (
  id         SERIAL PRIMARY KEY,
  trip_id    INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message    TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','withdrawn')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (trip_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_interests_user ON interests (user_id);

-- Confirmed participation, kept separate from interest requests. Only the trip owner's
-- "accept" creates a row here, and seats_left = seats_total - confirmed rows.
CREATE TABLE IF NOT EXISTS trip_participants (
  id         SERIAL PRIMARY KEY,
  trip_id    INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','left','removed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (trip_id, user_id)
);

-- Messages inside a conversation, keyed by (trip_id, thread_user_id) = (conversations.trip_id, conversations.member_id).
CREATE TABLE IF NOT EXISTS messages (
  id             SERIAL PRIMARY KEY,
  trip_id        INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  thread_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- the non-owner side of the thread
  sender_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body           TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'text',   -- 'text' | 'trip' (a shared post) | 'event' (request accepted, trip changed…)
  shared_trip_id INTEGER REFERENCES trips(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (trip_id, thread_user_id, id);

CREATE TABLE IF NOT EXISTS saved_trips (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_id    INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, trip_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id          SERIAL PRIMARY KEY,
  trip_id     INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL,
  details     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (trip_id, reporter_id)
);

CREATE TABLE IF NOT EXISTS ratings (
  id         SERIAL PRIMARY KEY,
  trip_id    INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  rater_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ratee_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stars      INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment    TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (trip_id, rater_id, ratee_id)
);


-- Photos on a post (stored in Cloudinary; we keep only URL + metadata).
CREATE TABLE IF NOT EXISTS trip_images (
  id         SERIAL PRIMARY KEY,
  trip_id    INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  public_id  TEXT NOT NULL,
  width      INTEGER,
  height     INTEGER,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trip_images_trip ON trip_images (trip_id, position, id);

-- One private conversation per (trip, member): the trip owner and one other person.
-- Started by the member from a post ("Ask a question"), by expressing interest, or by the owner from a request.
CREATE TABLE IF NOT EXISTS conversations (
  id                  SERIAL PRIMARY KEY,
  trip_id             INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  owner_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- the trip owner
  member_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- the other person (= messages.thread_user_id)
  created_by          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_last_read_id  INTEGER NOT NULL DEFAULT 0,                                -- highest message id the owner has seen
  member_last_read_id INTEGER NOT NULL DEFAULT 0,
  last_activity_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (trip_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_conversations_owner  ON conversations (owner_id, last_activity_at);
CREATE INDEX IF NOT EXISTS idx_conversations_member ON conversations (member_id, last_activity_at);

-- Blocking: neither side can message, call or send requests to the other.
CREATE TABLE IF NOT EXISTS blocked_users (
  blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_blocked_users_blocked ON blocked_users (blocked_id);

-- Reports about a member (separate from post reports). Message content is never copied in.
CREATE TABLE IF NOT EXISTS user_reports (
  id              SERIAL PRIMARY KEY,
  reporter_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  reason          TEXT NOT NULL,
  details         TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'open',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (reporter_id, reported_id)
);

-- In-app notifications, only ever created by real events. `ref` groups repeats (e.g. 'conv:12').
CREATE TABLE IF NOT EXISTS notifications (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  link        TEXT NOT NULL DEFAULT '',              -- in-app route, e.g. #/trip/123 or #/inbox/45
  ref         TEXT NOT NULL DEFAULT '',
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, id);

-- Voice calls between the two people in a conversation (media goes through LiveKit, never this server).
CREATE TABLE IF NOT EXISTS calls (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  caller_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  callee_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'ringing' CHECK (status IN ('ringing','active','ended','declined','missed','cancelled','failed')),
  end_reason      TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at     TIMESTAMPTZ,
  ended_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls (callee_id, status);
CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls (caller_id, status);

CREATE TABLE IF NOT EXISTS trip_likes (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_id    INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, trip_id)                        -- one like per person per post
);
CREATE INDEX IF NOT EXISTS idx_trip_likes_trip ON trip_likes (trip_id);

CREATE TABLE IF NOT EXISTS trip_comments (
  id         SERIAL PRIMARY KEY,
  trip_id    INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trip_comments_trip ON trip_comments (trip_id, id);

-- Cache of map-service answers (place search, road routes) to stay inside free quotas.
-- One row per email sent, for throttling (e.g. one message email per conversation per 30 min).
CREATE TABLE IF NOT EXISTS email_log (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_log ON email_log (user_id, key, sent_at);

CREATE TABLE IF NOT EXISTS geo_cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A member's regular journeys (e.g. Hostel → Office, weekdays 9:00). Used for matching and opt-in alerts.
CREATE TABLE IF NOT EXISTS saved_routes (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  origin_label TEXT NOT NULL DEFAULT '',
  origin_lat   DOUBLE PRECISION,
  origin_lng   DOUBLE PRECISION,
  dest_label   TEXT NOT NULL,
  dest_lat     DOUBLE PRECISION,
  dest_lng     DOUBLE PRECISION,
  depart_time  TEXT NOT NULL DEFAULT '',        -- HH:MM or '' = any time
  days         TEXT NOT NULL DEFAULT '',        -- 'Mon,Tue' or '' = any day
  notify       INTEGER NOT NULL DEFAULT 1,      -- tell me when a matching journey is posted
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_saved_routes_user ON saved_routes (user_id);

-- Short-lived trip updates from the owner ("running 10 min late"). Seen by confirmed travellers only; no locations.
CREATE TABLE IF NOT EXISTS trip_updates (
  id         SERIAL PRIMARY KEY,
  trip_id    INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trip_updates_trip ON trip_updates (trip_id, id);

-- ================= Safety: Saath Circle, safety sessions, boarding, cases =================
-- Trusted contacts. They must accept (link in an email) before they receive anything, and can opt out any time.
CREATE TABLE IF NOT EXISTS trusted_contacts (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  relation    TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','declined')),
  token       TEXT NOT NULL UNIQUE,                 -- the contact's accept / opt-out link
  invited_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  UNIQUE (user_id, email)
);
CREATE INDEX IF NOT EXISTS idx_trusted_contacts_user ON trusted_contacts (user_id);

-- One optional safety session per journey. Live location is kept only as the latest point and wiped when it ends.
CREATE TABLE IF NOT EXISTS safety_sessions (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_id          INTEGER REFERENCES trips(id) ON DELETE SET NULL,
  label            TEXT NOT NULL DEFAULT '',
  share_token      TEXT NOT NULL UNIQUE,            -- private link for the chosen contacts
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','arrived','ended')),
  escalation       TEXT NOT NULL DEFAULT 'contacts' CHECK (escalation IN ('contacts','self')),
  share_location   INTEGER NOT NULL DEFAULT 1,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expected_arrival TIMESTAMPTZ NOT NULL,
  midway_at        TIMESTAMPTZ,                     -- when the midway check-in falls due (NULL once done)
  departed_at      TIMESTAMPTZ,
  midway_done_at   TIMESTAMPTZ,
  boarded_at       TIMESTAMPTZ,
  last_checkin_at  TIMESTAMPTZ,
  due_kind         TEXT NOT NULL DEFAULT '',        -- what we're waiting for: departure | midway | arrival
  due_at           TIMESTAMPTZ,
  missed_stage     INTEGER NOT NULL DEFAULT 0,      -- 0 fine · 1 asked the traveller · 2 told the circle
  missed_at        TIMESTAMPTZ,
  sos_at           TIMESTAMPTZ,
  last_lat         DOUBLE PRECISION,
  last_lng         DOUBLE PRECISION,
  last_loc_at      TIMESTAMPTZ,
  ended_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_safety_sessions_user ON safety_sessions (user_id, status);
CREATE INDEX IF NOT EXISTS idx_safety_sessions_due ON safety_sessions (status, due_at);
CREATE TABLE IF NOT EXISTS safety_session_contacts (
  session_id  INTEGER NOT NULL REFERENCES safety_sessions(id) ON DELETE CASCADE,
  contact_id  INTEGER NOT NULL REFERENCES trusted_contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, contact_id)
);
CREATE TABLE IF NOT EXISTS safety_events (
  id          SERIAL PRIMARY KEY,
  session_id  INTEGER NOT NULL REFERENCES safety_sessions(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_safety_events_session ON safety_events (session_id, id);

-- QR boarding confirmation: the driver shows a code; a confirmed passenger scans it to confirm the right vehicle.
CREATE TABLE IF NOT EXISTS trip_boarding_codes (
  trip_id     INTEGER PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS trip_boardings (
  trip_id     INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  boarded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, user_id)
);

-- Safety response: every safety report becomes a tracked case with severity, evidence and a history.
CREATE TABLE IF NOT EXISTS safety_cases (
  id              SERIAL PRIMARY KEY,
  reporter_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  subject_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  trip_id         INTEGER REFERENCES trips(id) ON DELETE SET NULL,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  category        TEXT NOT NULL,
  severity        TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  status          TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','triaged','investigating','action_taken','closed')),
  description     TEXT NOT NULL DEFAULT '',
  evidence        TEXT NOT NULL DEFAULT '[]',       -- JSON: [{ kind: 'note'|'link'|'message', value }]
  happened_on     TEXT NOT NULL DEFAULT '',
  assignee_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  outcome         TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_safety_cases_status ON safety_cases (status, severity);
CREATE INDEX IF NOT EXISTS idx_safety_cases_reporter ON safety_cases (reporter_id);
CREATE TABLE IF NOT EXISTS safety_case_events (
  id          SERIAL PRIMARY KEY,
  case_id     INTEGER NOT NULL REFERENCES safety_cases(id) ON DELETE CASCADE,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,                        -- created | status | severity | assign | note | evidence | message_to_reporter
  body        TEXT NOT NULL DEFAULT '',
  internal    INTEGER NOT NULL DEFAULT 1,           -- 0 = visible to the reporter
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_safety_case_events_case ON safety_case_events (case_id, id);

-- ================= Journey Memories =================
CREATE TABLE IF NOT EXISTS journey_memories (
  id          SERIAL PRIMARY KEY,
  trip_id     INTEGER NOT NULL UNIQUE REFERENCES trips(id) ON DELETE CASCADE,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  visibility  TEXT NOT NULL DEFAULT 'participants' CHECK (visibility IN ('participants','public')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Each participant decides separately whether a public memory appears on their own profile.
CREATE TABLE IF NOT EXISTS memory_members (
  memory_id       INTEGER NOT NULL REFERENCES journey_memories(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  show_on_profile INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (memory_id, user_id)
);
CREATE TABLE IF NOT EXISTS memory_highlights (
  id          SERIAL PRIMARY KEY,
  memory_id   INTEGER NOT NULL REFERENCES journey_memories(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_memory_highlights ON memory_highlights (memory_id, id);
CREATE TABLE IF NOT EXISTS memory_photos (
  id          SERIAL PRIMARY KEY,
  memory_id   INTEGER NOT NULL REFERENCES journey_memories(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  public_id   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_memory_photos ON memory_photos (memory_id, id);
