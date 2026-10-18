// SaathRide — journey matching and cost estimates. Pure functions (no I/O) so the rules are easy to test.
// Every reason we show is backed by data we actually have:
//   basis "route"         → measured against the trip's stored road route
//   basis "straight_line" → distance between two points as the crow flies
//   basis "name"          → place names match (no coordinates available)
//   basis "time" / "seats" / "date" → from the post itself
// We only say a route "passes" or "covers" something when a stored road route supports it.
const { haversineKm, bearingDeg, nearestOnLine } = require("./geo");

const NEAR_KM = 2, AREA_KM = 5, ROUTE_KM = 1.5;
const hasPt = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
const km = (n) => (n < 1 ? `${Math.max(100, Math.round(n * 10) * 100)} m` : `${n.toFixed(n < 10 ? 1 : 0)} km`);
const minutesOf = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; };
const fmtClock = (t) => { const [h, m] = String(t).split(":").map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9ऀ-ॿ ]+/g, " ").replace(/\s+/g, " ").trim();
const STOP = new Set(["the", "near", "road", "rd", "station", "city", "main", "gate", "of", "and", "to", "at", "in"]);
function nameMatch(a, b) {
  const A = norm(a), B = norm(b);
  if (!A || !B) return false;
  if (A.includes(B) || B.includes(A)) return true;
  const wa = A.split(" ").filter((w) => w.length > 2 && !STOP.has(w)), wb = new Set(B.split(" ").filter((w) => w.length > 2 && !STOP.has(w)));
  return wa.length > 0 && wa.filter((w) => wb.has(w)).length >= Math.min(2, wa.length);
}

/**
 * Score one trip for a traveller's query. Returns null when it isn't a reasonable match.
 * trip: { depart_date, depart_time, seats_left, origin, destination, geo: { origin, dest, coords } }
 * q:    { from: {label, lat?, lng?}?, to: {...}?, date?, time?, flex? (minutes, default 60) }
 */
function scoreTrip(trip, q) {
  const reasons = [];
  let score = 0, placeHit = false;
  const g = trip.geo || {};
  const route = Array.isArray(g.coords) && g.coords.length > 1 ? g.coords : null;
  const from = q.from || null, to = q.to || null;

  // ----- destination -----
  let toOnRoute = null;
  if (to) {
    if (hasPt(to) && hasPt(g.dest)) {
      const d = haversineKm(to, g.dest);
      if (d <= NEAR_KM) { score += 40; placeHit = true; reasons.push({ kind: "destination", basis: "straight_line", text: d < 0.15 ? "Same destination as yours" : `Same destination area — about ${km(d)} from where you're going` }); }
      else if (d <= AREA_KM) { score += 25; placeHit = true; reasons.push({ kind: "destination", basis: "straight_line", text: `Ends about ${km(d)} from your destination` }); }
      else if (route) {
        const n = nearestOnLine(to, route);
        if (n && n.km <= ROUTE_KM) { toOnRoute = n; score += 28; placeHit = true; reasons.push({ kind: "destination", basis: "route", text: `Its route passes about ${km(n.km)} from your destination` }); }
      }
    } else if (!hasPt(to) && to.label && nameMatch(trip.destination, to.label)) {
      score += 30; placeHit = true; reasons.push({ kind: "destination", basis: "name", text: `Destination matches “${to.label}”` });
    }
  }
  // ----- pickup -----
  let fromOnRoute = null;
  if (from) {
    if (hasPt(from) && hasPt(g.origin)) {
      const d = haversineKm(from, g.origin);
      if (d <= NEAR_KM) { score += 25; placeHit = true; reasons.push({ kind: "pickup", basis: "straight_line", text: d < 0.15 ? "Starts where you're starting" : `Starts about ${km(d)} from you` }); }
      else if (d <= AREA_KM) { score += 12; placeHit = true; reasons.push({ kind: "pickup", basis: "straight_line", text: `Starts about ${km(d)} from your pickup area` }); }
      else if (route) {
        const n = nearestOnLine(from, route);
        if (n && n.km <= ROUTE_KM && n.along < 0.95) { fromOnRoute = n; score += 20; placeHit = true; reasons.push({ kind: "pickup", basis: "route", text: `Its route passes about ${km(n.km)} from your pickup area` }); }
      }
    } else if (!hasPt(from) && from.label && nameMatch(trip.origin, from.label)) {
      score += 12; placeHit = true; reasons.push({ kind: "pickup", basis: "name", text: `Starts at “${trip.origin}”` });
    }
  }
  // Whole-journey overlap only when the road route supports both ends in the right order.
  if (route && hasPt(from) && hasPt(to)) {
    const a = fromOnRoute || nearestOnLine(from, route), b = toOnRoute || nearestOnLine(to, route);
    if (a && b && a.km <= ROUTE_KM && b.km <= ROUTE_KM && a.along < b.along) { score += 15; reasons.push({ kind: "overlap", basis: "route", text: "Its road route covers your whole journey, in the same direction" }); }
  } else if (!placeHit && hasPt(from) && hasPt(to) && hasPt(g.origin) && hasPt(g.dest)) {
    // No route stored: we can only compare overall directions, and we say so.
    const diff = Math.abs(((bearingDeg(from, to) - bearingDeg(g.origin, g.dest)) + 540) % 360 - 180);
    if (diff <= 25 && haversineKm(from, g.origin) <= 15) { score += 8; placeHit = true; reasons.push({ kind: "direction", basis: "straight_line", text: "Heading in a similar direction (straight-line estimate, not a road route)" }); }
  }
  if ((from || to) && !placeHit) return null;

  // ----- date & time -----
  if (q.date) {
    if (trip.depart_date !== q.date) return null;
    reasons.push({ kind: "date", basis: "date", text: "Same day" }); score += 5;
  }
  if (q.time) {
    const flex = Math.max(10, Math.min(240, Number(q.flex) || 60));
    const diff = minutesOf(trip.depart_time) - minutesOf(q.time);
    if (Math.abs(diff) > flex) return null;
    score += Math.round(20 * (1 - Math.abs(diff) / flex));
    reasons.push({ kind: "time", basis: "time", text: diff === 0 ? `Leaves at ${fmtClock(trip.depart_time)} — your preferred time` : `Leaves at ${fmtClock(trip.depart_time)} — ${Math.abs(diff)} min ${diff > 0 ? "after" : "before"} your preferred time` });
  }
  // ----- seats -----
  if (trip.seats_left === 0) return null;
  if (trip.seats_left != null) reasons.push({ kind: "seats", basis: "seats", text: `${trip.seats_left} seat${trip.seats_left === 1 ? "" : "s"} left` });
  return { score, reasons };
}

function rankTrips(trips, q, limit = 20) {
  return trips.map((t) => ({ trip: t, m: scoreTrip(t, q) })).filter((x) => x.m)
    .sort((a, b) => b.m.score - a.m.score || (a.trip.depart_date + a.trip.depart_time).localeCompare(b.trip.depart_date + b.trip.depart_time))
    .slice(0, limit);
}

// ---------- contribution estimate ----------
// Clearly labelled assumptions; the numbers are an estimate to help people agree, not a fare.
const MILEAGE_KMPL = { bike: 45, scooty: 45, car: 15 };
function estimateContribution({ distance_km, basis = "route", vehicle_type = "car", people = 2, fuel_price = Number(process.env.FUEL_PRICE_INR) || 104 }) {
  const d = Number(distance_km);
  if (!Number.isFinite(d) || d <= 0) return null;
  const p = Math.max(1, Math.min(8, Math.round(Number(people) || 2)));
  const roadKm = basis === "route" ? d : d * 1.3;
  const assumptions = [];
  assumptions.push(basis === "route" ? `Road distance ${roadKm.toFixed(1)} km from the trip's mapped route` : `Road distance guessed as straight-line ${d.toFixed(1)} km × 1.3 (no mapped route) — rough`);
  let total, method;
  if (MILEAGE_KMPL[vehicle_type]) {
    const kmpl = MILEAGE_KMPL[vehicle_type];
    total = (roadKm / kmpl) * fuel_price;
    method = "fuel";
    assumptions.push(`Mileage about ${kmpl} km per litre for a ${vehicle_type}`, `Petrol about ₹${fuel_price}/litre (check today's local price)`, `Fuel only — no tolls, parking or wear`);
  } else if (vehicle_type === "cab" || vehicle_type === "auto") {
    const perKm = vehicle_type === "cab" ? 18 : 15, base = vehicle_type === "cab" ? 50 : 30;
    total = base + roadKm * perKm;
    method = "fare";
    assumptions.push(`Typical ${vehicle_type} fare guessed at ₹${base} + ₹${perKm}/km — real app or meter fares vary with time and demand`);
  } else {
    return { available: false, note: "Bus, metro and train fares are fixed by the operator — check the official fare instead of splitting costs.", assumptions };
  }
  assumptions.push(`Split equally between ${p} ${p === 1 ? "person" : "people"}${method === "fuel" ? " (including the rider/driver)" : ""}`);
  const r5 = (n) => Math.max(5, Math.round(n / 5) * 5);
  return { available: true, method, road_km: Math.round(roadKm * 10) / 10, total_inr: r5(total), per_person_inr: r5(total / p), people: p, basis, assumptions, estimated: true };
}

module.exports = { scoreTrip, rankTrips, estimateContribution, nameMatch, fmtClock };
