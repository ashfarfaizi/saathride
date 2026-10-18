# SaathRide 🛵

**Who's travelling your way?** A photo-first social network for students and young professionals heading in the same direction. Share a journey with photos, see who's going your way, like and comment, say you're interested, view profiles, and chat privately before deciding whether to travel together.

SaathRide is a coordination platform, **not a transport operator**. Profiles and trips are **not verified** — the app says so, and a college email address only adds an "unverified" label.

Stack: Node 22 · Express 5 · PostgreSQL on **Neon** · photos on **Cloudinary** · maps on **MapLibre + OpenStreetMap** (no key) · Saath AI on the **Claude API** · voice calls on **LiveKit** · vanilla HTML/CSS/JS · deploys to **Vercel**.

Only the database and `JWT_SECRET` are required. Photos, maps, AI and calls are optional: each one switches itself off cleanly (and the UI says so) until its keys are added.

---

## 1. Create the Neon database (one time, ~5 minutes)

1. Go to <https://neon.tech> → **Sign up** (GitHub / Google / email). The free plan is enough.
2. **Create project** → name it `saathride` → choose a region and set `regions` in `vercel.json` to the matching Vercel region so functions sit next to the database (every query is a round trip). The live deployment uses Neon **Washington, D.C. (us-east-1)** with Vercel **`iad1`**; for an India-only audience, Neon **Singapore** with Vercel **`sin1`** is lower latency. → **Create**.
3. On the project dashboard click **Connect**. Pick branch `main`, database `neondb`, and keep **Connection pooling ON** (the host will contain `-pooler`).
4. Copy the connection string. It looks like  
   `postgresql://neondb_owner:PASSWORD@ep-xxxx-pooler.ap-south-1.aws.neon.tech/neondb?sslmode=require`  
   (click *Show password* so the real password is included). **Treat it like a password — never commit it or paste it in chat.**

## 1b. Photo storage — Cloudinary (one time, ~5 minutes)

Vercel's filesystem is read-only and Postgres isn't for image bytes, so photos live in Cloudinary. The browser uploads **directly** to Cloudinary using a short-lived signature from this server; the database only stores the URL and size.

1. <https://cloudinary.com> → **Sign up for free**.
2. Open the **Dashboard**. Copy your **Cloud name**.
3. **Settings → API Keys** → copy the **API Key** and **API Secret**.
4. Put them in `.env` (and in Vercel's Environment Variables):
   ```
   CLOUDINARY_CLOUD_NAME=your-cloud-name
   CLOUDINARY_API_KEY=123456789012345
   CLOUDINARY_API_SECRET=your-secret
   ```
   The secret stays on the server and is never sent to the browser. Nothing needs to be created in Cloudinary: no upload preset, because every upload is signed.
5. Restart `npm run dev`. The post composer now shows **Add photos**. If these variables are missing, the app still works: posts just have no photos and the UI says uploads are off.

Photos are saved under `saathride/posts/<userId>/` and `saathride/avatars/<userId>/`. The server only accepts image URLs from **your** Cloudinary account and from the signed-in user's own folder. Deleting a post or replacing/removing a photo deletes it from Cloudinary (best-effort). If someone uploads photos and then abandons the form, those files stay in Cloudinary; you can clear stragglers from the Media Library.

## 1c. Voice calls — LiveKit (optional, ~5 minutes)

Messaging, the inbox and notifications work without this. Voice calls need a WebRTC media service; SaathRide uses **LiveKit** (free tier is enough to start). Phone numbers are never involved: the browser joins a private LiveKit room with a short-lived token that this server signs.

1. <https://cloud.livekit.io> → sign up → **Create project** (pick a region near your users, e.g. Mumbai/Singapore).
2. In the project: **Settings → API Keys → Create key**. Copy the **WebSocket URL** (looks like `wss://your-project-xxxx.livekit.cloud`), the **API Key** and the **API Secret**.
3. Add to `.env` (and to Vercel → Settings → Environment Variables, then redeploy):
   ```
   LIVEKIT_URL=wss://your-project-xxxx.livekit.cloud
   LIVEKIT_API_KEY=APIxxxxxxxx
   LIVEKIT_API_SECRET=your-secret
   ```
4. Run `npm install` (it installs the `livekit-client` browser SDK, which the server serves from `/vendor/livekit-client.js` so no third-party scripts are loaded). Commit the updated `package-lock.json`.
5. Restart and check <http://localhost:3000/api/config> → `"calls": true, "calls_status": "ready"`. Other values mean: `not_configured` (a variable is missing), `sdk_missing` (run `npm install`), `bad_url` (the URL must start with `wss://`).

Calls work on `https://` sites (Vercel) and on `http://localhost`; browsers block the microphone on other plain-http addresses.

## 1d. Maps, place search and route matching — works with no key

Maps are on out of the box, using free open services that need no account or key:

- **Map display:** [MapLibre GL JS](https://maplibre.org) (open-source, served from `/vendor/maplibre-gl.js`) drawing [OpenFreeMap](https://openfreemap.org) tiles (OpenStreetMap data, free, no key, no usage limits stated). Set `MAP_STYLE_URL` to use any other MapLibre style.
- **Place search:** [Photon](https://photon.komoot.io) (OpenStreetMap), limited to India via a bounding box.
- **Road routes:** the public [OSRM](https://project-osrm.org) server (driving profile).

Both lookups run on the server and are cached in `geo_cache` (searches 30 days, routes 90 days), so each place or route is fetched once. The public Photon and OSRM servers are shared, fair-use services meant for light traffic, not a guaranteed production SLA. If SaathRide grows, either point `PHOTON_URL` / `OSRM_URL` at self-hosted instances, or add a Mapbox key: with `MAPBOX_TOKEN` set, search and routes switch to Mapbox automatically (its free tier is about 100,000 geocoding requests a month; check current pricing). The key stays on the server either way. `GEO_PROVIDER=off` turns lookups off entirely (posting and matching then work by place name only).

Check `/api/config` → `"geo": true, "map": true, "map_status": "ready"`.

**Privacy:** trip locations are the landmarks/areas people pick, rounded to 3 decimals (~100 m). "Use my approximate location" in *Match my route* asks for consent, rounds to ~1 km, is used for that one search and is never stored. There is no live location tracking.

## 1e. Saath AI — Claude API (optional, ~3 minutes)

Without a key Saath AI runs in **basic mode** (rule-based: trip search, matching your saved route, captions, cost estimates). With a key it understands free-form questions.

1. <https://console.anthropic.com> → sign up → **Billing** (add credit) → **API Keys** → **Create Key**.
2. Add to `.env` and Vercel (**server-side only — never in frontend code or the repo**):
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   # optional: AI_MODEL=claude-haiku-5-5   (default; a fast, low-cost model)
   # optional: FUEL_PRICE_INR=104          (₹/litre used in cost estimates)
   ```
3. Check `/api/config` → `"ai": true`.

How it stays honest: the browser only talks to `/api/ai/chat`. The model can only read SaathRide data through server-side tools that apply the signed-in member's normal permissions (blocked members, women-only trips and report-hidden posts are excluded exactly as in the feed). Journey cards under each answer come from those tool results, never from the model's text, so it can't invent trips, people, seats or prices. Cost shares come from a calculator using the trip's mapped road distance and stated assumptions (mileage, fuel price, split), always labelled as estimates. Limits: 20 questions per 10 minutes and 150 per day per member, 600 characters per question, 10 turns of history; chats aren't stored. If the AI service fails or times out, members get a basic-mode answer instead of an error.

## 2. Run locally

```bash
npm install
cp .env.example .env          # Windows: copy .env.example .env
```

Edit `.env`:
- `DATABASE_URL=` → paste the Neon string from step 1.
- `JWT_SECRET=` → run `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` and paste the output.
- `CLOUDINARY_*` → from step 1b (optional but needed for photos).
- `LIVEKIT_*` → from step 1c (optional, only for voice calls).
- `MAPBOX_TOKEN` → step 1d (optional; maps work without it). `ANTHROPIC_API_KEY` → step 1e (optional). `ADMIN_EMAILS` → your email, to review reports at `/#/admin` (optional).

```bash
npm run migrate     # creates / upgrades the tables in Neon (safe to re-run; also upgrades a database from the previous version)
npm run seed        # OPTIONAL demo users + trips (dev only; password "password123")
npm run dev         # http://localhost:3000
```

Check <http://localhost:3000/api/health> → `{"ok":true,"db":true}`.

## 3. Deploy on Vercel

The app is one Express function: `api/index.js` exports the app and `vercel.json` rewrites every path to it, so the API, the static frontend (`public/`, bundled via `includeFiles`) and the map/call browser SDKs (served from `node_modules`) all come from the same function. Nothing is written to local disk: data is in Neon, photos in Cloudinary.

1. Run `npm install` locally and commit `package-lock.json`, then push to GitHub (`.env` is git-ignored).
2. <https://vercel.com/new> → **Import** the GitHub repo → **Framework Preset: Other** (leave build/output settings empty). Node version comes from `package.json` (22.x).
3. **Settings → Environment Variables** — add each for *Production* and *Preview*:

   | Variable | Required? | Where to get it |
   |---|---|---|
   | `DATABASE_URL` | **Yes** | Neon → project → **Connect** → pooled connection string (step 1) |
   | `JWT_SECRET` | Recommended (derived from `DATABASE_URL` if missing) | Any long random string: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
   | `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | For photos | Cloudinary → Dashboard / Settings → API Keys (step 1b) |
   | `MAPBOX_TOKEN` | Optional: Mapbox search & routes instead of the free OSM services | Mapbox → Tokens (step 1d) |
   | `ANTHROPIC_API_KEY` (`AI_MODEL`, `FUEL_PRICE_INR` optional) | For full Saath AI | Anthropic Console → API Keys (step 1e) |
   | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | For voice calls | LiveKit Cloud → Settings → API Keys (step 1c) |
   | `ADMIN_EMAILS` | Optional | Comma-separated emails allowed to review reports |
   | `APP_TIMEZONE` | Optional | Defaults to `Asia/Kolkata` |

4. Database tables: on Vercel the app creates/upgrades its tables automatically on the first request (idempotent, guarded by a Postgres advisory lock; set `AUTO_MIGRATE=0` to turn this off). You can still run `npm run migrate` from your computer instead. Easiest database setup: Vercel project → **Storage → Create Database → Neon** — it adds `DATABASE_URL` for you. If `JWT_SECRET` isn't set, a stable secret is derived from `DATABASE_URL` (set your own to keep sessions independent of the database password).
5. **Deploy** (or push to `main` if the project is already connected). Then check:
   - `https://YOUR-APP.vercel.app/api/health` → `{"ok":true,"db":true}` (a `503` means `DATABASE_URL` is wrong → fix it and **Redeploy**).
   - `https://YOUR-APP.vercel.app/api/config` → shows which optional services are on (`uploads`, `map`, `ai`, `calls`) and why not (`*_status`). It never shows secrets.
   - Errors are in *Deployments → (deployment) → Functions/Logs*. Server logs never include message text, AI prompts or secrets; clients get a generic error for unexpected failures.
6. Environment variable changes only apply after a **Redeploy**.

**Upgrading an existing deployment:** run `npm run migrate` once against your Neon database *before* the new code goes live. For the maps/AI/community update it adds trip coordinates and road-route columns (`origin_lat`, `origin_lng`, `dest_lat`, `dest_lng`, `route_distance_m`, `route_duration_s`, `route_geom`), `users.notif_prefs`, and the tables `geo_cache`, `saved_routes` and `trip_updates`; existing trips simply have no coordinates until edited. For the messaging update it creates `conversations`, `blocked_users`, `user_reports`, `notifications` and `calls`, adds `kind`/`shared_trip_id` to `messages`, and turns existing message threads into conversations (no messages are invented or changed). It adds the new columns (usernames, avatars, privacy switches, vehicle model) and tables (photos, likes, comments); existing users get a username like `user12` that they can change in *Edit profile*. The tables already exist if you ran `npm run migrate` against the same Neon database. **Don't run `npm run seed` on a public production database** (demo accounts share a known password; the script refuses when `NODE_ENV=production`).

*Alternative:* in Vercel → **Storage → Neon**, the integration can create the database and inject `DATABASE_URL` for you. You still need to run `npm run migrate` once with that URL in your `.env`.

## What was wrong with the original Vercel deployment

1. `db.js` opened a SQLite file in the project folder. Vercel's filesystem is read-only (and the `.db` file was git-ignored), so the app crashed on start.
2. `server.js` called `app.listen()` and never exported the app, and there was no `vercel.json` / `api/` entry, so Vercel had nothing to run.
3. `better-sqlite3` is a native module that doesn't suit Vercel.

Fixes: Neon PostgreSQL (`db.js`, `schema.sql`), `api/index.js` + `vercel.json` rewriting every route to the exported Express app, and `server.js` only listening when run directly.

## What's built

- **Auth** – signup/login/logout; bcrypt passwords; session in an `HttpOnly`, `SameSite=Lax` cookie (JWT, 7 days); rate-limited.
- **Home feed** – photo-first cards: swipeable photo carousel (double-tap to like), a ticket-stub departure tag and route ribbon on every photo, author with `@username` and college, caption, vehicle + model, seats, shared cost, recurring days, likes, comments, save, share, report, and *I'm interested*. Sort by *Leaving soon* or *Newest*. Journeys posted without photos show a route card.
- **Create / edit post** – photos (up to 5, resized in the browser, previews, remove, first photo = cover), caption (500 chars), route, date, time, vehicle, make/model, seats, optional cost, recurring days, women-only. Validated on both sides with clear errors. Owners can edit text, add/remove photos, cancel or delete their own posts (deleting is blocked while travellers are confirmed — cancel instead).
- **Social actions (all server-side)** – one like per person per post, comments (300 chars; authors and the post owner can delete), saved posts (private list), report (3 reports hide a post), and share links `/p/<id>` with link-preview tags (title, caption, first photo) that open the post.
- **Profiles** – photo or coloured initials, display name, `@username` (unique, editable), bio, college/workplace, travel areas, interests, travel modes, rating, posts grid, and a private **Saved** tab. Privacy switches hide college, travel areas and interests from other members. Phone, email and gender are never shown to others.
- **Navigation** – mobile bottom bar (Home · Explore · Create · Inbox · Profile) that becomes a left sidebar on desktop. *Explore* is working search/filter results as a photo grid; *Inbox* and *Notifications* have unread badges.
- **Interest workflow** – *I'm interested* → pending request (does **not** hold a seat) → owner accepts/declines → accepted creates a separate confirmed-participant record. Withdraw any time; no duplicates. Owner edits seats/status (can't go below confirmed travellers).
- **Inbox** – social-app style: conversation list with photos, names, the trip each chat is about, last-message preview, time, unread count and request status; search (people or places), All/Unread filter, a strip summarising requests waiting for you and your pending requests; two panes on desktop, list → full-screen chat on phones; loading skeletons, empty and error states with retry.
- **Private conversations** – one conversation per trip between the owner and one other person. Start one from a post (*Message …*) before deciding anything, from *I'm interested* (the request and its note land in the same chat), or as the owner from a request. The chat shows the trip (route, time, seats, cost) with the right actions in place: *Ask to join* / *Withdraw* / *Leave trip* for the rider, *Accept* / *Decline* / *Remove* for the owner, and a reminder that asking doesn't reserve a seat. Quick prompts for pickup point, departure time and cost sharing; share any journey as a card; day separators, "Seen" receipts, optimistic sending with retry, older-message paging. Workflow events (asked to join, accepted, declined, withdrew, trip changed, trip cancelled) appear in the thread. History is stored in Neon and loads after a refresh or on another device. New messages arrive by polling (3 s in an open chat, 5 s for badges).
- **Notifications** – created only by real events: new requests, accepted/declined/removed, withdrawals, new messages (one per conversation until read, without copying the text), trip changes and cancellations, completed trips (rate co-travellers) and missed calls. Mark one or all as read; each opens the relevant chat or trip.
- **Voice calls (optional, LiveKit)** – call button in a conversation once both people have written (or the request is accepted). The other person must accept; states for calling, incoming, connecting, connected (timer), reconnecting, ended, declined, missed (40 s), cancelled and failed; mute and hang-up; microphone-blocked / no-microphone / connection errors are explained and reported so the other side stops waiting. No phone numbers are used or shown. Without LiveKit credentials the button is simply hidden and everything else works.
- **Safety & privacy** – block/unblock from a profile or chat (no messages, calls, requests or feed posts either way; the blocked person isn't told), *Blocked members* list in Edit profile, report a member (optionally block at the same time; message text is never copied into reports). Conversations, messages, notifications and calls answer 404 to anyone outside them; no public endpoint returns messages; message text is never logged.
- **Ratings** – only between people who travelled together, after the trip is completed.
- **Explore map** – Journeys / Match my route / People tabs. Map view with a pin per journey (vehicle emoji), a list beside it (desktop) or a swipeable strip (phone); selecting a pin or card draws the road route with start and destination markers and shows a card with approximate distance and time ("estimate"), *Open post* and *Directions* (opens Google Maps with the route). Filters: destination, date, start area, time window, vehicle, seats needed, women-only, recurring. Map ⇄ list toggle. Place suggestions while typing (in the composer too), via the server.
- **Route matching** – scores upcoming journeys against your from/to, date, time and flexibility, and lists *why* each one fits: same destination area, start near you, route passes near your pickup or destination, route covers your whole journey in the right direction, departure time difference, seats left. Each reason is labelled by its evidence — *road route*, *straight-line estimate* or *name match* — and overlap is only claimed when a stored road route supports it. Full trips, blocked members, your own trips and (for non-female members) women-only trips are excluded.
- **Saath AI** – floating assistant on every main screen (and "Estimate cost share" / "Caption ideas" from a trip). Finds real journeys from natural language ("people going to IIT Kharagpur tomorrow morning", "trips towards my office around 9 AM" — uses your saved routes or college/workplace), explains matches, drafts captions, estimates cost shares with visible assumptions, and suggests next steps when nothing matches.
- **Saved routes & alerts** – save a usual route (days, time) from *Match my route*; get a notification when a fitting journey is posted (opt-in per route); one-tap re-run.
- **Suggested for you** – Home shows journeys that fit your saved routes, then journeys from your community, each with the reason.
- **Communities** – people who list the same college/workplace (self-declared, labelled *not verified*; hidden if they switch off *Show my college*): members and upcoming journeys, plus a *My community* feed filter.
- **People search** – by name, @username or (if shown) college; blocked members excluded.
- **Trip updates** – on the day of travel the owner can send "Leaving now", "Running ~10 min late", "At the pickup point", "Arrived" or a short note to confirmed travellers only; they expire after 12 hours. No live location.
- **Notification settings** – switch off categories (messages, requests, trip changes, trip updates, route alerts, missed calls); trip cancellations are always delivered.
- **Report review** – accounts in `ADMIN_EMAILS` get `/#/admin` to resolve or dismiss post and member reports (dismissing restores a hidden post). Everyone else gets "not found".

## Tests

```bash
npm install
npm test
```

Five suites (47 tests): `api.test.js` (auth, trips, interest workflow, legacy per-trip messages, ratings, rate limits), `social.test.js` (Cloudinary signing incl. the size-capping transformation, photo posts, edit/delete, likes, comments, usernames, privacy, avatars, share links), `messaging.test.js` (conversations, authorization, persistence, inbox, notifications, blocking, reports, call signalling and LiveKit tokens), `discovery.test.js` (matching rules and their evidence labels, cost estimates, trip coordinates and routes, place search and caching, the matching API with exclusions, Saath AI in basic mode and with the Claude API — tool use on real data, cards only from tool results, failure fallback, usage limits — saved routes and alerts, recommendations, communities, people search, trip updates, notification preferences, report review) and `frontend-smoke.test.js` (every screen renders against the real API and escapes hostile text — a stub DOM, **not** a real browser).

`npm test` runs the SQL on Node's built-in SQLite (`test/sqlite-adapter.js`) so it works anywhere. To check against real Postgres, point the suites at a scratch database instead (they create their own tables); they have also been run that way against PostgreSQL 16. External services are never contacted by the tests: Cloudinary, the map services (Mapbox, Photon, OSRM), the Claude API and LiveKit are replaced by local fakes, so after adding real keys, click through photos, the map, Saath AI and a call once on the deployed site.

## Known limits / next up

- Rate limiting is in-memory per serverless instance (best-effort). Use a shared store (e.g. Upstash Redis) for strict limits.
- No email verification, password reset or real identity verification yet.
- Uploads that are abandoned before publishing leave orphan files in Cloudinary (clear them in the Media Library).
- Comments can't be reported individually yet; posts and members can.
- Route matching compares against each trip's single stored road route (driving profile from OSRM or Mapbox; bus/metro trips have no transit routing). Distances/times are estimates. Trips posted before maps were configured have no coordinates until their route is edited.
- Recurring commutes are shown until their listed date passes; there's no automatic "next occurrence" yet — owners repost or edit the date.
- Saath AI chats aren't saved between sessions. Basic mode understands simpler phrasing only.
- Messages, badges and incoming calls use polling (Vercel serverless functions can't hold WebSockets). It's reliable but not instant and costs a request every few seconds per open tab. For instant delivery, add a managed realtime service (e.g. Pusher, Ably or LiveKit data channels) and push a "something changed" ping that triggers the same fetches.
- No push notifications to phones or email when the app is closed; notifications are in-app.
- Calls are 1:1 audio only, and need someone to keep the app open to hear it ring.
- Report review is a simple list for `ADMIN_EMAILS` accounts — no suspensions or bans yet (block + remove content manually in Neon if needed).
- SQLite data from the old version isn't migrated (the old DB file was local demo data only).
