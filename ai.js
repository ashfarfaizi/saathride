// SaathRide — "Saath AI" travel assistant.
// The browser talks only to /api/ai/chat; this server calls the Claude API with ANTHROPIC_API_KEY.
// The model can only see SaathRide data through tools that run here with the signed-in member's
// permissions (same rules as the feed). Trip cards shown in the UI come from those tool results,
// never from the model's text, so the assistant can't invent journeys, people, seats or prices.
// Without a key — or when the API fails — a rule-based "basic mode" answers the common requests.
const { estimateContribution, nameMatch, fmtClock } = require("./matching");
const { haversineKm } = require("./geo");

const MAX_MSG = 600, MAX_HISTORY = 10, MAX_ROUNDS = 4;
const VEHICLE_WORDS = [["motorcycle", "bike"], ["motorbike", "bike"], ["bike", "bike"], ["scooty", "scooty"], ["scooter", "scooty"], ["car", "car"], ["cab", "cab"], ["taxi", "cab"], ["auto", "auto"], ["rickshaw", "auto"], ["bus", "public"], ["metro", "public"], ["train", "public"]];
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function createAi({ db, HttpError, bad, clean, explore, candidates, getTrip, todayStr, TZ, fetchImpl = (...a) => fetch(...a) }) {
  const key = () => process.env.ANTHROPIC_API_KEY || "";
  const model = () => process.env.AI_MODEL || "claude-haiku-5-5";
  const enabled = () => !!key();
  const status = () => (enabled() ? "ready" : "not_configured");

  const dayPlus = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString("en-CA", { timeZone: TZ });
  const weekdayToday = () => new Date().toLocaleDateString("en-US", { weekday: "long", timeZone: TZ }).toLowerCase();

  // ---------- data the assistant may use (all scoped to the member) ----------
  async function myPlaces(me) {
    const u = await db.one("SELECT name, college FROM users WHERE id = $1", [me]);
    const routes = await db.query("SELECT id, name, origin_label, origin_lat, origin_lng, dest_label, dest_lat, dest_lng, depart_time, days FROM saved_routes WHERE user_id = $1 ORDER BY id LIMIT 10", [me]);
    return { first_name: (u.name || "").split(" ")[0], college_or_workplace: u.college || "", saved_routes: routes };
  }
  const tripBrief = (t, reasons) => ({
    trip_id: t.id, route: `${t.origin} → ${t.destination}`, date: t.depart_date, time: fmtClock(t.depart_time), vehicle: t.vehicle_type + (t.vehicle_model ? ` (${t.vehicle_model})` : ""),
    seats_left: t.seats_left, cost_share_inr: t.contribution_inr, women_only: t.women_only, recurring: t.recurring, owner_first_name: (t.owner.name || "").split(" ")[0],
    road_km: t.geo && t.geo.distance_m ? Math.round(t.geo.distance_m / 100) / 10 : null, status: t.status, ...(reasons ? { why: reasons.map((r) => r.text) } : {}),
  });

  async function findJourneys(me, a, ctx) {
    let to = a.to ? { label: clean(a.to, 120) } : null, from = a.from ? { label: clean(a.from, 120) } : null;
    // "my office", "college", a saved route's name → the member's own saved places
    const places = await myPlaces(me);
    const pick = (lbl) => {
      if (!lbl) return lbl;
      const l = lbl.label.toLowerCase();
      const r = places.saved_routes.find((x) => l.includes(x.name.toLowerCase()) || x.name.toLowerCase().includes(l.replace(/^my /, "")));
      if (r) return r.dest_lat != null ? { label: r.dest_label, lat: r.dest_lat, lng: r.dest_lng } : { label: r.dest_label };
      if (/\b(my )?(office|work|workplace|college|campus|university)\b/.test(l) && places.college_or_workplace) return { label: places.college_or_workplace };
      return lbl;
    };
    to = pick(to);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(a.date || "") ? a.date : null;
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(a.time || "") ? a.time : null;
    const flex = Math.max(15, Math.min(240, Number(a.flex_minutes) || 90));
    const vehicle_type = typeof a.vehicle_type === "string" ? a.vehicle_type : null;
    const min_seats = Number.isInteger(a.min_seats) ? a.min_seats : null;
    let results;
    if (to || from) results = (await explore.match(me, { from, to, date, time, flex, vehicle_type, min_seats }, candidates, 8)).results;
    else {
      const trips = await candidates(me, { date, vehicle_type, min_seats });
      results = trips.filter((t) => !time || Math.abs(toMin(t.depart_time) - toMin(time)) <= flex).slice(0, 8)
        .map((t) => ({ trip: explore.stripGeo(t), reasons: time ? [{ kind: "time", basis: "time", text: `Leaves at ${fmtClock(t.depart_time)}` }] : [] }));
    }
    for (const r of results) ctx.cards.set(r.trip.id, { trip: r.trip, reasons: r.reasons });
    return { searched: { to: to && to.label, from: from && from.label, date, time, flex_minutes: time ? flex : null }, count: results.length, journeys: results.map((r) => tripBrief(r.trip, r.reasons)) };
  }
  const toMin = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; };

  async function getTripTool(me, a, ctx) {
    const id = Number(a.trip_id);
    if (!Number.isInteger(id)) return { error: "trip_id must be a number" };
    const t = await getTrip(id, me);
    if (!t) return { error: "No such trip" };
    ctx.cards.set(t.id, { trip: explore.stripGeo(t), reasons: [] });
    return tripBrief(t);
  }
  async function estimateTool(me, a, ctx) {
    let distanceKm = null, basis = "route", vehicle = a.vehicle_type || "car", label = "";
    if (a.trip_id) {
      const row = await db.one("SELECT id, origin, destination, vehicle_type, seats_total, origin_lat, origin_lng, dest_lat, dest_lng, route_distance_m FROM trips WHERE id = $1", [Number(a.trip_id)]);
      if (!row) return { error: "No such trip" };
      label = `${row.origin} → ${row.destination}`;
      vehicle = a.vehicle_type || row.vehicle_type;
      if (row.route_distance_m) distanceKm = row.route_distance_m / 1000;
      else if (row.origin_lat != null && row.dest_lat != null) { distanceKm = haversineKm({ lat: row.origin_lat, lng: row.origin_lng }, { lat: row.dest_lat, lng: row.dest_lng }); basis = "straight_line"; }
    } else if (a.from && a.to) {
      label = `${a.from} → ${a.to}`;
      const f = await explore.resolvePlace({ label: clean(a.from, 120) }), t = await explore.resolvePlace({ label: clean(a.to, 120) }, f && f.lat !== undefined ? f : undefined);
      if (f && t && f.lat !== undefined && t.lat !== undefined) {
        const r = await explore.routeBetween(f, t);
        if (r) distanceKm = r.distance_m / 1000; else { distanceKm = haversineKm(f, t); basis = "straight_line"; }
      }
    }
    if (a.distance_km && !distanceKm) { distanceKm = Number(a.distance_km); basis = "user"; }
    if (!distanceKm) return { error: "I couldn't get a distance for this route (map service not configured or place not found). Ask the member for the approximate distance in km." };
    const est = estimateContribution({ distance_km: distanceKm, basis: basis === "user" ? "route" : basis, vehicle_type: vehicle, people: a.people || 2 });
    if (est && basis === "user") est.assumptions[0] = `Distance ${distanceKm} km as given by you`;
    if (est) ctx.estimate = { ...est, route: label, vehicle_type: vehicle };
    return est || { error: "Couldn't estimate" };
  }
  async function myTripsTool(me) {
    const rows = await db.query("SELECT id, origin, destination, depart_date, depart_time, vehicle_type, vehicle_model, seats_total, contribution_inr, recurring, description FROM trips WHERE owner_id = $1 AND status IN ('open','closed') ORDER BY depart_date DESC, id DESC LIMIT 5", [me]);
    return { trips: rows.map((r) => ({ trip_id: r.id, route: `${r.origin} → ${r.destination}`, date: r.depart_date, time: fmtClock(r.depart_time), vehicle: r.vehicle_type + (r.vehicle_model ? ` ${r.vehicle_model}` : ""), seats: r.seats_total, cost_share_inr: r.contribution_inr, recurring: r.recurring, current_caption: r.description })) };
  }

  const TOOLS = [
    { name: "find_journeys", description: "Search real upcoming SaathRide journeys the member could join. Use for any request to find/show/match trips. Resolve relative dates yourself (YYYY-MM-DD). 'morning' ≈ 08:00 with flex 120, 'evening' ≈ 18:00 with flex 120. Place names like 'my office' or a saved route name are resolved from the member's saved places.",
      input_schema: { type: "object", properties: { to: { type: "string", description: "Destination place/area" }, from: { type: "string", description: "Pickup area" }, date: { type: "string", description: "YYYY-MM-DD" }, time: { type: "string", description: "HH:MM 24h preferred departure" }, flex_minutes: { type: "integer" }, vehicle_type: { type: "string", enum: ["car", "bike", "scooty", "cab", "auto", "public"] }, min_seats: { type: "integer" } } } },
    { name: "get_trip", description: "Details of one SaathRide trip by id.", input_schema: { type: "object", properties: { trip_id: { type: "integer" } }, required: ["trip_id"] } },
    { name: "estimate_contribution", description: "Estimate a fair cost share using the trip's mapped road distance (or a mapped route between two places) and explicit assumptions. Always use this instead of guessing numbers.",
      input_schema: { type: "object", properties: { trip_id: { type: "integer" }, from: { type: "string" }, to: { type: "string" }, vehicle_type: { type: "string", enum: ["car", "bike", "scooty", "cab", "auto", "public"] }, people: { type: "integer", description: "People sharing, including the driver/rider" }, distance_km: { type: "number", description: "Only if the member stated the distance" } } } },
    { name: "my_places", description: "The member's saved routes and self-declared college/workplace (for 'my office', 'my usual route').", input_schema: { type: "object", properties: {} } },
    { name: "my_trips", description: "The member's own recent/upcoming posts (for writing captions or estimating their trip).", input_schema: { type: "object", properties: {} } },
  ];
  async function runTool(me, name, input, ctx) {
    try {
      if (name === "find_journeys") return await findJourneys(me, input || {}, ctx);
      if (name === "get_trip") return await getTripTool(me, input || {}, ctx);
      if (name === "estimate_contribution") return await estimateTool(me, input || {}, ctx);
      if (name === "my_places") { const p = await myPlaces(me); return { ...p, saved_routes: p.saved_routes.map((r) => ({ name: r.name, from: r.origin_label, to: r.dest_label, time: r.depart_time, days: r.days })) }; }
      if (name === "my_trips") return await myTripsTool(me);
      return { error: "Unknown tool" };
    } catch (err) { console.error("ai tool failed:", name, err.message); return { error: "Tool failed" }; }
  }

  function systemPrompt(places, contextTrip) {
    return [
      "You are Saath AI, the assistant inside SaathRide — a social app where students and young professionals in India share journeys and find people travelling the same way. SaathRide doesn't operate rides; profiles and trips are NOT verified.",
      `Today is ${weekdayToday()}, ${todayStr()} (timezone ${TZ}). The member's first name is ${places.first_name || "unknown"}${places.college_or_workplace ? `; they list "${places.college_or_workplace}" as their college/workplace (self-declared)` : ""}.`,
      contextTrip ? `They opened you from this trip: ${JSON.stringify(contextTrip)}.` : "",
      "Rules:",
      "- Only mention journeys, people, seats, times and cost shares that came back from your tools. Never invent or guess them. Refer to journeys by route and time; the app shows cards for them automatically.",
      "- If a search returns nothing, say so plainly and suggest concrete next steps: widen the time window, try a nearby area or another day, save the route for alerts, or post their own journey.",
      "- Explain briefly why journeys match, using the 'why' lines from the tool (don't upgrade 'straight-line' estimates into road-route claims).",
      "- For costs, always call estimate_contribution and state that it's an estimate with its key assumptions. Never present it as an official fare.",
      "- For captions, write 3 short, friendly options (under 200 characters each) that mention route, time and what kind of co-traveller is welcome. No exact home addresses, phone numbers or claims of verification.",
      "- Safety tips when relevant: meet at public landmarks, share plans with someone you trust, keep chats in the app. Emergency number in India: 112.",
      "- Keep replies short (under 120 words), warm and practical. Plain text; short bullet lists are fine. No markdown headings.",
    ].filter(Boolean).join("\n");
  }

  async function callClaude(body, timeoutMs = 20000) {
    const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: AbortSignal.timeout(Math.max(2000, timeoutMs)),
      headers: { "content-type": "application/json", "x-api-key": key(), "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    });
    if (!res.ok) { const t = await res.text().catch(() => ""); const e = new Error(`AI service responded ${res.status}`); e.status = res.status; e.detail = t.slice(0, 200); throw e; }
    return res.json();
  }

  async function aiAnswer(me, message, history, contextTrip) {
    const ctx = { cards: new Map(), estimate: null };
    const places = await myPlaces(me);
    const messages = [...history.map((h) => ({ role: h.role, content: h.text })), { role: "user", content: message }];
    let text = "";
    const deadline = Date.now() + 24000;   // stay well inside the hosting time limit (30 s on Vercel)
    for (let round = 0; round <= MAX_ROUNDS; round++) {
      const left = deadline - Date.now();
      if (left < 3000) { const e = new Error("AI request took too long"); e.status = 504; throw e; }
      const out = await callClaude({ model: model(), max_tokens: 700, system: systemPrompt(places, contextTrip), tools: TOOLS, messages }, left);
      const blocks = Array.isArray(out.content) ? out.content : [];
      text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      const uses = blocks.filter((b) => b.type === "tool_use");
      if (out.stop_reason !== "tool_use" || !uses.length || round === MAX_ROUNDS) break;
      messages.push({ role: "assistant", content: blocks });
      const results = [];
      for (const u of uses) results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(await runTool(me, u.name, u.input, ctx)).slice(0, 12000) });
      messages.push({ role: "user", content: results });
    }
    return { mode: "ai", reply: text || "Sorry, I couldn't put an answer together. Try rephrasing?", cards: [...ctx.cards.values()].slice(0, 6), estimate: ctx.estimate };
  }

  // ---------- basic mode (no AI service) ----------
  function parseQuery(text) {
    const t = ` ${text.toLowerCase()} `;
    const q = {};
    if (/\btoday\b|\btonight\b/.test(t)) q.date = dayPlus(0);
    else if (/day after tomorrow/.test(t)) q.date = dayPlus(2);
    else if (/\btomorrow\b|\btmrw\b|\bkal\b/.test(t)) q.date = dayPlus(1);
    else { const d = DAYS.findIndex((x) => t.includes(` ${x}`)); if (d >= 0) { const cur = DAYS.indexOf(weekdayToday()); q.date = dayPlus(((d - cur + 7) % 7) || 7); } }
    const tm = t.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/) || t.match(/\b(?:at|around|by)\s+(\d{1,2})[:.](\d{2})\b/);
    if (tm) { let h = Number(tm[1]) % 12; if (tm[3] === "pm") h += 12; if (!tm[3]) h = Number(tm[1]); q.time = `${String(Math.min(h, 23)).padStart(2, "0")}:${tm[2] || "00"}`; q.flex_minutes = /around|about|approx|~/.test(t) ? 60 : 45; }
    else if (/\bmorning\b/.test(t)) { q.time = "08:30"; q.flex_minutes = 150; }
    else if (/\bafternoon\b/.test(t)) { q.time = "14:00"; q.flex_minutes = 120; }
    else if (/\bevening\b/.test(t)) { q.time = "18:00"; q.flex_minutes = 120; }
    else if (/\bnight\b/.test(t)) { q.time = "21:00"; q.flex_minutes = 90; }
    const stop = "(?=\\s+(?:tomorrow|today|tonight|around|at|on|by|from|this|next|in the|morning|evening|afternoon|night|with|for|leaving|departing|after|before)\\b|[,.?!]|\\s*$)";
    const to = t.match(new RegExp(`(?:going to|heading to|headed to|towards|toward|travelling to|traveling to|trips? to|rides? to|people to|\\bto)\\s+(.+?)${stop}`));
    if (to) q.to = to[1].replace(/^(the)\s+/, "").trim();
    const from = t.match(new RegExp(`\\bfrom\\s+(.+?)${stop.replace("|from", "|to|towards|heading|going")}`));
    if (from) q.from = from[1].trim();
    for (const [w, v] of VEHICLE_WORDS) if (new RegExp(`\\b${w}s?\\b`).test(t)) { q.vehicle_type = v; break; }
    const ppl = t.match(/\b(\d)\s*(?:people|persons|ppl|pax|of us|riders|friends|travellers|travelers)\b/) || t.match(/\b(?:between|among)\s+(\d)\b/);
    if (ppl) q.people = Number(ppl[1]);
    return q;
  }
  function captionOptions(trip, vehicleWord) {
    const v = trip ? trip.vehicle : vehicleWord || "ride";
    const route = trip ? trip.route : "your route";
    const when = trip ? `${trip.date === dayPlus(0) ? "today" : trip.date === dayPlus(1) ? "tomorrow" : trip.date} at ${trip.time}` : "soon";
    return [
      `Heading ${route} ${when} on my ${v} 🛣️ One spare seat — say hi if you're going the same way!`,
      `${route}, ${when}. Riding solo is boring — join me, split the fuel, swap playlists 🎧`,
      `Daily ${v} run: ${route} (${when}). Looking for a punctual co-traveller. Pickup at a public landmark on the way.`,
    ];
  }
  async function basicAnswer(me, message, contextTrip, notice) {
    const ctx = { cards: new Map(), estimate: null };
    const t = message.toLowerCase();
    const q = parseQuery(message);
    let reply;
    if (/caption|write .*(post|description)|describe my|bio for my/.test(t)) {
      const mine = contextTrip && contextTrip.is_owner ? { trip_id: contextTrip.id, route: contextTrip.route, date: contextTrip.date, time: contextTrip.time, vehicle: contextTrip.vehicle } : (await myTripsTool(me)).trips[0];
      const vw = (VEHICLE_WORDS.find(([w]) => t.includes(w)) || [])[0];
      const opts = captionOptions(mine, vw === "motorcycle" || vw === "motorbike" ? "motorcycle" : vw);
      reply = `Here are three caption ideas${mine ? ` for ${mine.route}` : ""}:\n\n• ${opts.join("\n• ")}\n\nEdit them to sound like you — and keep exact addresses out of public captions.`;
    } else if (/estimat|contribution|cost|split|how much|price|fare|fuel/.test(t)) {
      const args = { ...(contextTrip ? { trip_id: contextTrip.id } : {}), ...(q.from && q.to ? { from: q.from, to: q.to } : {}), vehicle_type: q.vehicle_type, people: q.people || 2 };
      const km = t.match(/(\d+(?:\.\d+)?)\s*km/); if (km) args.distance_km = Number(km[1]);
      const est = await estimateTool(me, args, ctx);
      if (est.error) reply = `I need a route to estimate from. Open me from a trip, or ask like “estimate cost from Salt Lake to Howrah by car for 3 people” (or include the distance, e.g. “18 km”).`;
      else if (!est.available) reply = est.note;
      else reply = `Rough estimate${ctx.estimate.route ? ` for ${ctx.estimate.route}` : ""}: about ₹${est.total_inr} in total, so roughly ₹${est.per_person_inr} each for ${est.people}.\n\nAssumptions:\n• ${est.assumptions.join("\n• ")}\n\nAgree the amount together in chat before you travel.`;
    } else if (q.to || q.from || /find|show|search|who|any(one)?|going|trip|ride|journey|match|heading|travel/.test(t)) {
      if (/my destination|my route|my usual|my commute|match my/.test(t) && !q.to) {
        const p = await myPlaces(me);
        const r = p.saved_routes[0];
        if (r) { q.to = r.dest_label; q.from = q.from || r.origin_label || undefined; q.time = q.time || r.depart_time || undefined; if (q.time && !q.flex_minutes) q.flex_minutes = 60; }
      }
      const res = await findJourneys(me, q, ctx);
      const what = [res.searched.to && `to ${res.searched.to}`, res.searched.from && `from ${res.searched.from}`, res.searched.date && `on ${res.searched.date}`, res.searched.time && `around ${fmtClock(res.searched.time)}`].filter(Boolean).join(" ");
      reply = res.count
        ? `I found ${res.count} journey${res.count === 1 ? "" : "s"}${what ? ` ${what}` : ""}. Tap one to see the post — the reasons under each card explain the match.`
        : `No open journeys${what ? ` ${what}` : ""} right now. Try a wider time window or another day, save this route on Explore to get an alert when one is posted, or share your own journey so others can find you.`;
    } else {
      reply = "I can find journeys (“people going to IIT Kharagpur tomorrow morning”), match your saved route, write a caption for your trip, or estimate a fair cost share for a route.";
    }
    return { mode: "basic", notice, reply, cards: [...ctx.cards.values()].slice(0, 6), estimate: ctx.estimate };
  }

  function register(app, { auth, writeLimit, intParam, L }) {
    app.post("/api/ai/chat", auth, writeLimit("ai", L.ai, 600_000), writeLimit("ai-day", L.aiDay, 86_400_000), async (req, res) => {
      const b = req.body || {};
      if (typeof b.message !== "string" || !b.message.trim()) throw bad("Ask me something first");
      if (b.message.length > MAX_MSG) throw bad(`Please keep questions under ${MAX_MSG} characters`);
      const message = clean(b.message, MAX_MSG);
      const history = (Array.isArray(b.history) ? b.history : []).slice(-MAX_HISTORY)
        .filter((h) => h && (h.role === "user" || h.role === "assistant") && typeof h.text === "string" && h.text.trim())
        .map((h) => ({ role: h.role, text: clean(h.text, 1500) }));
      while (history.length && history[0].role !== "user") history.shift();   // API needs user-first, alternating turns
      const alt = []; for (const h of history) { if (alt.length && alt[alt.length - 1].role === h.role) alt[alt.length - 1] = h; else alt.push(h); }
      if (alt.length && alt[alt.length - 1].role === "user") alt.pop();
      let contextTrip = null;
      if (b.trip_id !== undefined && b.trip_id !== null) {
        const t = await getTrip(intParam(b.trip_id), req.user.id);
        if (t) contextTrip = { id: t.id, route: `${t.origin} → ${t.destination}`, date: t.depart_date, time: fmtClock(t.depart_time), vehicle: t.vehicle_type, seats_left: t.seats_left, cost_share_inr: t.contribution_inr, is_owner: t.is_owner };
      }
      if (!enabled()) return res.json(await basicAnswer(req.user.id, message, contextTrip, "Saath AI is in basic mode — the AI service isn't configured on this server yet."));
      try { res.json(await aiAnswer(req.user.id, message, alt, contextTrip)); }
      catch (err) {
        console.error("AI request failed:", err.status || "", err.message);   // never log the member's message
        res.json(await basicAnswer(req.user.id, message, contextTrip, err.status === 429 ? "Saath AI is busy right now — here's a basic answer instead." : "Saath AI couldn't reach the AI service — here's a basic answer instead."));
      }
    });
  }
  return { register, enabled, status, parseQuery, basicAnswer };
}

module.exports = { createAi };
