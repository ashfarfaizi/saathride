# SaathRide 🛵🚗

**Same route. Shared ride. New friends.**

Fuel-share carpooling for students and young professionals in India. Drivers post their route, riders request a seat, everyone splits the fuel. Built with Node.js + Express + SQLite (backend) and vanilla HTML/CSS/JS (frontend). No external database or services needed — it runs entirely on your laptop.

## Run it (3 commands)

You need Node.js 18+ installed (download from nodejs.org).

```bash
npm install     # install dependencies
node seed.js    # create demo users & rides (run once)
npm start       # start the app
```

Then open **http://localhost:3000** in your browser.

### Demo accounts (all use password `password123`)

| Email | Who | Notes |
|---|---|---|
| aarav@coep.ac.in | Aarav (driver, car) | Verified, has recurring Mumbai→Pune ride |
| priya@cusat.ac.in | Priya (driver, car) | Verified, posts a women-only ride |
| rohan@gmail.com | Rohan (driver, scooty) | Unverified (non-college email) |
| sneha@iitb.ac.in | Sneha (rider) | Verified, no vehicle |

Tip: open two different browsers (or one normal + one incognito window), log in as a driver in one and a rider in the other, and walk through the full flow — request seat → approve → chat → complete → rate.

## What's built in

- **Auth** — signup/login with JWT, passwords hashed with bcrypt
- **✓ Verified badge** — automatic if you sign up with a college email (.ac.in / .edu)
- **Post a ride** — route, date, time, seats, fuel share (₹), vehicle type, recurring days (e.g. "Mon, Fri"), notes
- **Search rides** — by origin, destination, date, women-only filter
- **Women-only rides** — only female drivers can post them, only female riders can join (enforced server-side)
- **Seat requests** — rider requests, driver approves/rejects, seat count updates live
- **Ride chat** — group chat between driver and riders (polls every 3 seconds)
- **Complete & rate** — driver marks ride completed, riders rate the driver 1–5 stars
- **My rides** — rides you're offering and rides you've joined

## Project structure

```
saathride/
├── server.js    # Express API — auth, rides, bookings, chat, ratings
├── db.js        # SQLite schema (users, rides, bookings, messages, ratings)
├── seed.js      # Demo data
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js   # single-page frontend
└── package.json
```

## Deploying online (free options)

SQLite means zero database setup, which is perfect for a pilot:

1. **Render.com** — create a free Web Service, connect your GitHub repo, build command `npm install`, start command `npm start`. Set env var `JWT_SECRET` to a long random string.
2. **Railway.app** — similar one-click deploy from GitHub.

For a real launch beyond a pilot, migrate SQLite → PostgreSQL (Supabase free tier) — the SQL schema in `db.js` transfers almost as-is.

## Roadmap ideas (v2)

- Real OTP-based college email verification (send a code, not just domain check)
- Live GPS tracking + share trip with parents (Google Maps SDK)
- UPI payment integration (Razorpay)
- Emergency SOS button wired to trusted contacts
- Push notifications (booking approved, ride starting)
- React Native mobile app reusing this exact API

## Important legal note (India)

Private vehicles can't operate as commercial taxis without permits. Keep the platform strictly **cost-sharing**: fuel share should cover expenses, not generate driver profit. Before launching publicly, get your terms of service reviewed and check your state's Motor Vehicles rules on carpooling. This project is a starting point, not legal advice.
