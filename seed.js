// Run once: node seed.js — creates demo users and rides
const bcrypt = require("bcryptjs");
const db = require("./db");

const hash = bcrypt.hashSync("password123", 10);
const insertUser = db.prepare(`INSERT OR IGNORE INTO users
  (name,email,password_hash,phone,gender,college,is_verified,has_vehicle,vehicle_type)
  VALUES (?,?,?,?,?,?,?,?,?)`);

const users = [
  ["Aarav Mehta", "aarav@coep.ac.in", hash, "9800000001", "male", "COEP Pune", 1, 1, "car"],
  ["Priya Nair", "priya@cusat.ac.in", hash, "9800000002", "female", "CUSAT Kochi", 1, 1, "car"],
  ["Rohan Kulkarni", "rohan@gmail.com", hash, "9800000003", "male", "MIT-WPU", 0, 1, "scooty"],
  ["Sneha Iyer", "sneha@iitb.ac.in", hash, "9800000004", "female", "IIT Bombay", 1, 0, null],
];
users.forEach((u) => insertUser.run(...u));

const idOf = (email) => db.prepare("SELECT id FROM users WHERE email=?").get(email).id;
const d = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

const insertRide = db.prepare(`INSERT INTO rides
  (driver_id,origin,destination,depart_date,depart_time,seats_total,price_per_seat,vehicle_type,women_only,recurring,notes)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

if (db.prepare("SELECT COUNT(*) n FROM rides").get().n === 0) {
  insertRide.run(idOf("aarav@coep.ac.in"), "Mumbai", "Pune", d(1), "07:30", 3, 250, "car", 0, "Mon,Fri", "Pickup near Dadar station. Small luggage OK.");
  insertRide.run(idOf("priya@cusat.ac.in"), "Kochi", "Thrissur", d(1), "08:00", 2, 150, "car", 1, "", "Women-only ride. Leaving from Edappally.");
  insertRide.run(idOf("rohan@gmail.com"), "Pune", "Mumbai", d(2), "18:00", 1, 200, "scooty", 0, "", "One pillion seat, helmet provided.");
  insertRide.run(idOf("aarav@coep.ac.in"), "Bangalore", "Mysore", d(3), "06:45", 3, 220, "car", 0, "Sat", "Weekend trip, chai stop at Ramanagara.");
  console.log("Seeded demo users and rides.");
} else {
  console.log("Rides already exist — skipping ride seed.");
}
console.log("Demo login: aarav@coep.ac.in / password123 (all demo users share this password)");
