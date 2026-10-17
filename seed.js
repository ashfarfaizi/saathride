// DEV ONLY demo data:  npm run seed   (refuses to run when NODE_ENV=production)
// All demo users share the password "password123" — never seed a public production database.
const bcrypt = require("bcryptjs");
const db = require("./db");

(async () => {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed demo accounts with NODE_ENV=production");
  const hash = await bcrypt.hash("password123", 10);
  const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

  const users = [
    ["Aarav Mehta", "aarav@iitkgp.ac.in", "male", "IIT Kharagpur", 1, "car", "Fourth-year, daily campus commute. Chai > coffee.", "Gol Bazar, Campus", "chess, football, chai", "car", 0],
    ["Priya Nair", "priya@jadavpuruniversity.in", "female", "Jadavpur University", 0, "scooty", "MA student. Early bird, always on time.", "Salt Lake, Jadavpur", "books, photography", "scooty,public", 3],
    ["Rohan Das", "rohan@example.com", "male", "Tech Mahindra, Salt Lake", 1, "bike", "Office commuter, Salt Lake ↔ Garia.", "Salt Lake, Garia", "cricket, podcasts", "bike", 5],
    ["Sneha Iyer", "sneha@iitkgp.ac.in", "female", "IIT Kharagpur", 0, null, "Looking for people to share rides to the station.", "Campus, Kharagpur station", "dance, sketching", "public", 6],
  ];
  const ids = {};
  for (const [name, email, gender, college, hasV, vt, bio, areas, interests, modes, color] of users) {
    const rows = await db.query(
      `INSERT INTO users (name,email,password_hash,gender,college,edu_email,has_vehicle,vehicle_type,bio,travel_areas,interests,travel_modes,avatar_color,username)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (email) DO NOTHING RETURNING id`,
      [name, email, hash, gender, college, email.endsWith(".ac.in") ? 1 : 0, hasV, vt, bio, areas, interests, modes, color, email.split("@")[0].replace(/[^a-z0-9]/g, "")]);
    ids[email] = rows[0]?.id ?? (await db.one("SELECT id FROM users WHERE email=$1", [email])).id;
  }
  const { n } = await db.one("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM trips");
  if (n === 0) {
    const ins = (owner, o, d, date, time, v, seats, c, w, rec, desc) => db.query(
      `INSERT INTO trips (owner_id,origin,destination,depart_date,depart_time,vehicle_type,seats_total,contribution_inr,women_only,recurring,description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [ids[owner], o, d, date, time, v, seats, c, w, rec, desc]);
    await ins("aarav@iitkgp.ac.in", "Gol Bazar", "IIT Kharagpur", day(1), "08:15", "car", 2, 40, 0, "Mon,Tue,Wed,Thu,Fri", "Heading to campus from Gol Bazar tomorrow at 8:15 AM. I have two seats available. Anyone going to campus?");
    await ins("priya@jadavpuruniversity.in", "Salt Lake", "Jadavpur University", day(1), "09:00", "scooty", 1, 30, 1, "", "Women-only scooty ride, one pillion seat, helmet provided.");
    await ins("rohan@example.com", "Salt Lake Sector V", "Garia", day(2), "09:00", "bike", 1, 50, 0, "Mon,Wed,Fri", "Leaving for the office in Salt Lake at 9 AM. Anyone travelling in the same direction?");
    await ins("aarav@iitkgp.ac.in", "IIT Kharagpur", "Kharagpur Station", day(3), "17:30", "car", 3, 25, 0, "", "Going to catch the evening train — happy to share the cab fare.");
    await ins("sneha@iitkgp.ac.in", "Kharagpur Station", "IIT Kharagpur", day(2), "06:45", "public", null, null, 0, "", "Arriving by the early train. Anyone want to share an auto to campus?");
    console.log("Seeded demo users and trips.");
  } else console.log("Trips already exist — skipping trip seed.");
  console.log("Demo login: aarav@iitkgp.ac.in / password123");
  await db.close();
})().catch((e) => { console.error("Seed failed:", e.message); process.exit(1); });
