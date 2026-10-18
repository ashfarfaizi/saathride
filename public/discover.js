// SaathRide — Explore (map + list), route matching, people & communities, recommendations, trip extras,
// place pickers, Saath AI panel, notification settings and report review. Loaded after app.js (shares its helpers).

// ---------- small helpers ----------
const fmtKm = (m) => (m >= 10000 ? `${Math.round(m / 1000)} km` : `${(m / 1000).toFixed(1)} km`);
const fmtDur = (s) => { const m = Math.round(s / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`; };
const BASIS = { route: ["road route", "ok"], straight_line: ["straight-line estimate", "warn"], name: ["name match", ""], time: ["", ""], seats: ["", ""], date: ["", ""] };
function reasonChips(reasons = []) {
  return reasons.length ? `<ul class="reasons">${reasons.map((r) => `<li class="reason ${r.kind}">${esc(r.text)}${BASIS[r.basis] && BASIS[r.basis][0] ? ` <span class="basis ${BASIS[r.basis][1]}">${BASIS[r.basis][0]}</span>` : ""}</li>`).join("")}</ul>` : "";
}
function directionsUrl(t, geo) {
  const g = geo || t.geo || {};
  const mode = t.vehicle_type === "public" ? "transit" : "driving";
  const o = g.origin ? `${g.origin.lat},${g.origin.lng}` : t.origin, d = g.dest ? `${g.dest.lat},${g.dest.lng}` : t.destination;
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(o)}&destination=${encodeURIComponent(d)}&travelmode=${mode}`;
}
function routeFacts(t, r) {
  const g = r || t.geo || {};
  if (g.distance_m) return `≈ ${fmtKm(g.distance_m)} · ${fmtDur(g.duration_s)} by road <span class="basis warn">estimate</span>`;
  if (g.straight_km) return `≈ ${g.straight_km} km straight-line <span class="basis warn">rough estimate</span>`;
  return "";
}
function miniCard(t, extra = "") {
  const [emoji] = VEHICLES[t.vehicle_type] || ["🧭"];
  const pic = t.images && t.images[0] && cl(t.images[0].url, 240, true);
  return `<a class="mini" href="#/trip/${t.id}">
    ${pic ? `<img src="${esc(pic)}" alt="" loading="lazy" />` : `<span class="mini-emoji" aria-hidden="true">${emoji}</span>`}
    <span class="mini-body"><b>${esc(t.origin)} → ${esc(t.destination)}</b>
      <small>${esc(fmtDate(t.depart_date))} · ${esc(fmtTime(t.depart_time))} · ${esc(t.owner.name)}</small>
      <small>${t.seats_left == null ? esc((VEHICLES[t.vehicle_type] || ["", t.vehicle_type])[1]) : t.seats_left ? `${plural(t.seats_left, "seat")} left` : "Full"}${t.contribution_inr != null ? ` · ₹${t.contribution_inr}` : ""}</small>${extra}</span></a>`;
}
function loadAsset(tag, attrs) {
  return new Promise((resolve, reject) => {
    const el = document.createElement(tag);
    Object.assign(el, attrs); el.onload = resolve; el.onerror = () => reject(new Error("load failed"));
    document.head.appendChild(el);
  });
}

// ---------- place picker (autocomplete through our server; the map key stays private) ----------
const placePicks = {};
function wirePlacePickers(ids) {
  if (!config.geo) return;
  for (const id of ids) {
    const input = $(`#${id}`); if (!input || !input.parentElement) continue;
    const list = document.createElement("div"); list.className = "place-list"; list.hidden = true; list.setAttribute("role", "listbox");
    input.parentElement.classList.add("place-field"); input.parentElement.appendChild(list);
    input.setAttribute("autocomplete", "off"); input.setAttribute("aria-autocomplete", "list");
    let deb, items = [];
    input.addEventListener("input", () => {
      delete placePicks[id]; input.parentElement.classList.remove("picked");
      clearTimeout(deb);
      const q = input.value.trim();
      if (q.length < 2) { list.hidden = true; return; }
      deb = setTimeout(async () => {
        try {
          const d = await api(`/api/geo/search?q=${encodeURIComponent(q)}`);
          items = d.places || [];
          list.innerHTML = items.map((p, i) => `<button type="button" role="option" data-i="${i}">${ICON.pin}<span><b>${esc(p.name)}</b><small>${esc(p.label)}</small></span></button>`).join("");
          list.hidden = !items.length;
        } catch { list.hidden = true; }
      }, 250);
    });
    list.addEventListener("click", (e) => {
      const b = e.target.closest("[data-i]"); if (!b) return;
      const p = items[Number(b.dataset.i)];
      input.value = p.name.slice(0, 80); placePicks[id] = { lat: p.lat, lng: p.lng, label: p.label };
      input.parentElement.classList.add("picked"); list.hidden = true;
    });
    input.addEventListener("blur", () => setTimeout(() => { list.hidden = true; }, 200));
  }
}
const pickedPoint = (id) => (placePicks[id] ? { lat: placePicks[id].lat, lng: placePicks[id].lng } : null);
const pickedPlace = (id) => { const el = $(`#${id}`); const v = el ? el.value.trim() : ""; if (!v) return null; return placePicks[id] ? { label: v, lat: placePicks[id].lat, lng: placePicks[id].lng } : { label: v }; };

// ---------- map (MapLibre GL JS served from our own origin + OpenFreeMap tiles — no API key) ----------
const MapKit = {
  async load() {
    if (!config.map) throw new Error(config.map_status === "sdk_missing" ? "sdk" : "not_configured");
    if (window.maplibregl) return window.maplibregl;
    if (!this._p) this._p = Promise.all([loadAsset("link", { rel: "stylesheet", href: "/vendor/maplibre-gl.css" }), loadAsset("script", { src: "/vendor/maplibre-gl.js" })]);
    await this._p;
    if (!window.maplibregl) throw new Error("sdk");
    return window.maplibregl;
  },
  webgl() {
    try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); } catch { return false; }
  },
  async create(el, opts = {}) {
    const gl = await this.load();
    if (!this.webgl()) throw new Error("webgl");
    el.innerHTML = "";
    const map = new gl.Map({ container: el, style: config.map_style, center: opts.center || [88.36, 22.57], zoom: opts.zoom || 8, cooperativeGestures: !!opts.cooperative });
    map.addControl(new gl.NavigationControl({ showCompass: false }), "top-right");
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("tiles")), 15000);
      map.once("load", () => { clearTimeout(t); res(); });
    });
    map.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "route-casing", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": 9 } });
    map.addLayer({ id: "route", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#0e7c66", "line-width": 5 } });
    return map;
  },
  marker(el) { return new window.maplibregl.Marker({ element: el }); },
  bounds(pts) { return pts.reduce((b, c) => b.extend(c), new window.maplibregl.LngLatBounds(pts[0], pts[0])); },
  pin(kind, label = "") {
    const el = document.createElement("button");
    el.type = "button"; el.className = `pin ${kind}`; el.setAttribute("aria-label", label); el.innerHTML = kind === "dest" ? "" : `<span>${esc(label.slice(0, 2))}</span>`;
    return el;
  },
  showRoute(map, coords, origin, dest) {
    const line = coords && coords.length > 1 ? coords : origin && dest ? [[origin.lng, origin.lat], [dest.lng, dest.lat]] : null;
    map.getSource("route").setData({ type: "FeatureCollection", features: line ? [{ type: "Feature", properties: { approx: !coords }, geometry: { type: "LineString", coordinates: line } }] : [] });
    map.setPaintProperty("route", "line-dasharray", coords ? [1, 0] : [2, 2]);
    if (line) map.fitBounds(this.bounds(line), { padding: 60, maxZoom: 13, duration: 600 });
  },
};
const mapFailText = (e) => ({
  not_configured: "The map is switched off on this site. The list below shows the same journeys.",
  sdk: "The map couldn't load. Check your connection — the list below still works.",
  tiles: "The map tiles are taking too long to load. The list below still works.",
  webgl: "Your browser can't show interactive maps (WebGL is off). The list below shows the same journeys.",
}[e.message] || "The map couldn't load right now. The list below still works.");

// ---------- Explore ----------
const exploreState = { map: null, markers: [], trips: [], selected: null, destMarker: null };
function viewExplore(params) {
  const tab = ["match", "people"].includes(params.tab) ? params.tab : "journeys";
  const tabs = [["journeys", "Journeys"], ["match", "Match my route"], ["people", "People"]];
  view.className = tab === "journeys" && params.view !== "list" ? "wide" : "";
  view.innerHTML = `
    <div class="page-head"><h1>Explore</h1>
      ${me ? `<button class="btn ghost small" data-act="openAi" data-q="">${ICON.spark} Ask Saath AI</button>` : ""}</div>
    <div class="tabs explore-tabs" role="tablist">${tabs.map(([k, l]) => `<a role="tab" href="#/explore${k === "journeys" ? "" : `?tab=${k}`}" aria-selected="${tab === k}">${l}</a>`).join("")}</div>
    <div id="exploreBody"></div>`;
  if (tab === "match") return exploreMatch(params);
  if (tab === "people") return explorePeople(params);
  return exploreJourneys(params);
}

function exploreJourneys(p) {
  const mode = p.view === "list" ? "list" : "map";
  const opts = Object.entries(VEHICLES).map(([k, [e, l]]) => `<option value="${k}" ${p.vehicle_type === k ? "selected" : ""}>${e} ${l}</option>`).join("");
  const qs = (extra) => { const q = new URLSearchParams(p); for (const [k, v] of Object.entries(extra)) { if (v == null) q.delete(k); else q.set(k, v); } return `#/explore${q.toString() ? "?" + q : ""}`; };
  const active = ["origin", "destination", "date", "time_from", "time_to", "vehicle_type", "min_seats", "women_only", "recurring"].filter((k) => p[k]).length;
  $("#exploreBody").innerHTML = `
    <form id="filterForm" class="search-bar card">
      <label class="search-wrap grow">${ICON.search}<input id="f_d" name="destination" value="${esc(p.destination || "")}" placeholder="Where to? e.g. IIT Kharagpur" aria-label="Destination" /></label>
      <input type="date" name="date" value="${esc(p.date || "")}" aria-label="Date" class="date-in" />
      <button class="btn">Search</button>
      <details class="more-filters" ${active > (p.destination ? 1 : 0) + (p.date ? 1 : 0) ? "open" : ""}>
        <summary>${ICON.layers} Filters${active ? ` <span class="badge">${active}</span>` : ""}</summary>
        <div class="filters-grid">
          <div class="field"><label for="f_o">From</label><input id="f_o" name="origin" value="${esc(p.origin || "")}" placeholder="e.g. Gol Bazar" /></div>
          <div class="field"><label for="f_tf">Leaving after</label><input id="f_tf" type="time" name="time_from" value="${esc(p.time_from || "")}" /></div>
          <div class="field"><label for="f_tt">Leaving before</label><input id="f_tt" type="time" name="time_to" value="${esc(p.time_to || "")}" /></div>
          <div class="field"><label for="f_v">Vehicle</label><select id="f_v" name="vehicle_type"><option value="">Any</option>${opts}</select></div>
          <div class="field"><label for="f_s">Seats needed</label><select id="f_s" name="min_seats"><option value="">Any</option>${[1, 2, 3, 4].map((n) => `<option value="${n}" ${String(p.min_seats) === String(n) ? "selected" : ""}>${n}+</option>`).join("")}</select></div>
          <div class="checks"><label class="check"><input type="checkbox" name="women_only" value="1" ${p.women_only ? "checked" : ""}/> Women-only</label>
            <label class="check"><input type="checkbox" name="recurring" value="1" ${p.recurring ? "checked" : ""}/> Recurring commutes</label></div>
          <a class="btn ghost small" href="#/explore${mode === "list" ? "?view=list" : ""}">Clear all</a>
        </div>
      </details>
    </form>
    <div class="row between explore-bar">
      <p class="muted small" id="exploreCount">${active ? "Matching journeys" : "Upcoming journeys"}</p>
      <div class="seg" role="group" aria-label="View"><a href="${qs({ view: null })}" ${mode === "map" ? 'aria-current="true"' : ""}>${ICON.map} Map</a><a href="${qs({ view: "list" })}" ${mode === "list" ? 'aria-current="true"' : ""}>${ICON.list} List</a></div>
    </div>
    ${mode === "map" ? `<div class="map-wrap">
        <div class="map-shell"><div id="exMap" class="map" role="region" aria-label="Map of journeys"><div class="map-msg">Loading map…</div></div>
          <div id="mapCard" class="map-card" hidden></div></div>
        <div class="map-side"><div id="mapNote"></div><div id="results" class="map-list" aria-live="polite"><div class="skeleton short"></div></div></div>
      </div>` : `<div id="results" class="tiles" aria-live="polite"><div class="skeleton"></div><div class="skeleton"></div></div><div id="more" class="row mt16"></div>`}`;
  $("#filterForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = new URLSearchParams();
    for (const [k, v] of new FormData(e.target)) if (v) q.set(k, v);
    if (mode === "list") q.set("view", "list");
    const target = "#/explore" + (q.toString() ? "?" + q : "");
    if (location.hash === target) route(); else location.hash = target;
  });
  const filters = { ...p }; delete filters.view; delete filters.tab;
  if (mode === "list") {
    feedState = { offset: 0, params: filters, target: "#results", render: tile,
      empty: `<div class="card empty"><p><strong>No journeys match yet.</strong></p><p class="mt8">Try a wider search — or post your own and let people find you.</p><p class="mt12"><a class="btn" href="#/${me ? "post" : "signup"}">${me ? "Share a journey" : "Join SaathRide"}</a></p></div>` };
    return loadFeed(false);
  }
  loadMapView(filters);
}

async function loadMapView(filters) {
  const res = $("#results");
  let trips = [];
  try { trips = (await api(`/api/trips?${new URLSearchParams({ ...filters, mapped: config.geo ? "1" : "" })}`)).trips; }
  catch (err) { res.innerHTML = `<div class="empty small-empty"><p>Couldn't load journeys.</p><p class="muted">${esc(err.message)}</p><button class="btn ghost small mt8" data-act="reloadRoute">Try again</button></div>`; return; }
  exploreState.trips = trips;
  const count = $("#exploreCount"); if (count) count.textContent = `${plural(trips.length, "journey")}${config.geo ? " on the map" : ""}`;
  res.innerHTML = trips.length ? trips.map((t) => `<div class="map-item" data-trip="${t.id}">${miniCard(t, t.geo && (t.geo.distance_m || t.geo.origin) ? `<small class="facts">${routeFacts(t)}</small>` : "")}<button type="button" class="btn ghost small" data-act="mapFocus" data-id="${t.id}" aria-label="Show on map">${ICON.pin}</button></div>`).join("")
    : `<div class="empty small-empty"><p><strong>No journeys ${Object.keys(filters).length ? "match these filters" : "on the map yet"}.</strong></p><p class="muted mt8">${config.geo ? "Journeys appear here when they're posted with a place picked from suggestions." : ""} Try the list view or widen your search.</p></div>`;
  for (const t of trips) tripCache.set(t.id, t);
  const el = $("#exMap");
  if (exploreState.map) { try { exploreState.map.remove(); } catch { /* already gone */ } exploreState.map = null; }
  exploreState.markers = [];
  try {
    const map = exploreState.map = await MapKit.create(el, { cooperative: true });
    el.classList && el.classList.remove("off");
    exploreState.markers.forEach((m) => m.remove()); exploreState.markers = [];
    const pts = [];
    for (const t of trips) {
      if (!t.geo || !t.geo.origin) continue;
      const pinEl = MapKit.pin("origin", (VEHICLES[t.vehicle_type] || ["•"])[0]);
      pinEl.setAttribute("aria-label", `${t.origin} to ${t.destination}, ${fmtDate(t.depart_date)} ${fmtTime(t.depart_time)}`);
      pinEl.addEventListener("click", () => selectMapTrip(t.id));
      exploreState.markers.push(MapKit.marker(pinEl).setLngLat([t.geo.origin.lng, t.geo.origin.lat]).addTo(map));
      pts.push([t.geo.origin.lng, t.geo.origin.lat]);
      if (t.geo.dest) pts.push([t.geo.dest.lng, t.geo.dest.lat]);
    }
    if (pts.length) map.fitBounds(MapKit.bounds(pts), { padding: 50, maxZoom: 12, duration: 0 });
  } catch (e) {
    el.innerHTML = `<div class="map-msg">${ICON.map}<p>${esc(mapFailText(e))}</p></div>`;
    el.classList && el.classList.add("off");
  }
}
async function selectMapTrip(id) {
  const t = exploreState.trips.find((x) => x.id === id) || tripCache.get(id); if (!t) return;
  exploreState.selected = id;
  document.querySelectorAll(".map-item.active").forEach((e) => e.classList.remove("active"));
  const item = document.querySelector(`.map-item[data-trip="${id}"]`); if (item) { item.classList.add("active"); item.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" }); }
  const card = $("#mapCard");
  let r = null; try { r = await api(`/api/trips/${id}/route`); } catch { /* still show the card */ }
  if (card) {
    card.hidden = false;
    card.innerHTML = `<button class="icon-btn close" type="button" data-act="mapClose" aria-label="Close">${ICON.x}</button>${miniCard(t)}
      <div class="map-card-facts">${routeFacts(t, r) || "Distance not available"}</div>
      <div class="row"><a class="btn small" href="#/trip/${t.id}">Open post</a><a class="btn ghost small" href="${esc(directionsUrl(t, r))}" target="_blank" rel="noopener">${ICON.nav} Directions</a></div>`;
  }
  const map = exploreState.map;
  if (map && r && (r.coords || (r.origin && r.dest))) {
    MapKit.showRoute(map, r.coords, r.origin, r.dest);
    if (exploreState.destMarker) exploreState.destMarker.remove();
    if (r.dest) exploreState.destMarker = MapKit.marker(MapKit.pin("dest", "Destination")).setLngLat([r.dest.lng, r.dest.lat]).addTo(map);
  }
}

// ---------- Match my route ----------
async function exploreMatch(p) {
  if (!me) return needLogin();
  $("#exploreBody").innerHTML = `
    <section class="card match-card">
      <h2 class="h3">Find journeys that fit yours</h2>
      <p class="muted small">We compare destinations, pickup areas, routes, times and seats. Use areas or landmarks — never your exact address.</p>
      <div id="savedRoutes" class="route-chips"></div>
      <form id="matchForm" class="mt12">
        <div class="row2">
          <div class="field"><label for="m_from">From <span class="muted">(optional)</span></label><input id="m_from" maxlength="120" placeholder="e.g. Salt Lake Sector V" value="${esc(p.from || "")}" />
            <button type="button" class="link-btn loc-btn" data-act="useLocation">${ICON.pin} Use my approximate location</button></div>
          <div class="field"><label for="m_to">To</label><input id="m_to" maxlength="120" required placeholder="e.g. IIT Kharagpur" value="${esc(p.to || "")}" /></div>
        </div>
        <div class="row3">
          <div class="field"><label for="m_date">Date</label><input id="m_date" type="date" value="${esc(p.date || "")}" /></div>
          <div class="field"><label for="m_time">Leaving around</label><input id="m_time" type="time" value="${esc(p.time || "")}" /></div>
          <div class="field"><label for="m_flex">Flexibility</label><select id="m_flex">${[[30, "± 30 min"], [60, "± 1 hour"], [120, "± 2 hours"]].map(([v, l]) => `<option value="${v}" ${v === 60 ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        </div>
        <div class="row"><button class="btn">Find matches</button><button type="button" class="btn ghost" data-act="saveRoute">${ICON.bookmark} Save this route</button></div>
        <p class="muted small mt8" id="locNote" hidden></p>
      </form>
    </section>
    <div id="matchResults" class="stack mt16" aria-live="polite"></div>`;
  wirePlacePickers(["m_from", "m_to"]);
  $("#matchForm").addEventListener("submit", (e) => { e.preventDefault(); runMatch(); });
  loadSavedRoutes();
  if (p.to) runMatch();
}
function matchQuery() {
  return { from: pickedPlace("m_from") || (placePicks.m_from_loc && $("#m_from").value === "My approximate location" ? placePicks.m_from_loc : null), to: pickedPlace("m_to"),
    date: $("#m_date").value || undefined, time: $("#m_time").value || undefined, flex: Number($("#m_flex").value) };
}
async function runMatch() {
  const box = $("#matchResults");
  const q = matchQuery();
  if (!q.to) { toast("Where are you going?"); return; }
  box.innerHTML = `<div class="skeleton short"></div><div class="skeleton short"></div>`;
  try {
    const d = await api("/api/match", { method: "POST", body: q });
    const note = !d.map_matching ? `<p class="notice">Map matching is off on this server, so matches use place names and times only.</p>`
      : d.to && d.to.lat === undefined ? `<p class="notice">We couldn't place “${esc(d.to.label)}” on the map, so we matched by name. Picking a suggestion gives better results.</p>` : "";
    box.innerHTML = note + (d.results.length ? d.results.map(({ trip, reasons }) => `<article class="card match">${miniCard(trip)}${reasonChips(reasons)}
        <div class="row"><a class="btn small" href="#/trip/${trip.id}">View journey</a>${trip.geo && trip.geo.origin ? `<a class="btn ghost small" href="${esc(directionsUrl(trip))}" target="_blank" rel="noopener">${ICON.nav} Directions</a>` : ""}</div></article>`).join("")
      : `<div class="card empty"><p><strong>No journeys fit yet.</strong></p><p class="muted mt8">Try a wider time window or another day. Save this route and we'll notify you when a matching journey is posted — or share your own so others can join you.</p>
         <div class="row center-row mt12"><button class="btn ghost" data-act="saveRoute">${ICON.bookmark} Save route &amp; get alerts</button><a class="btn" href="#/post">Share your journey</a></div></div>`);
    for (const r of d.results) tripCache.set(r.trip.id, r.trip);
  } catch (err) { box.innerHTML = `<div class="card empty"><p>${esc(err.message)}</p><button class="btn ghost small mt8" data-act="rematch">Try again</button></div>`; }
}
async function loadSavedRoutes() {
  const box = $("#savedRoutes"); if (!box) return;
  try {
    const { routes } = await api("/api/routes");
    box.innerHTML = routes.length ? `<span class="muted small">Your routes:</span>${routes.map((r) => `<span class="route-chip"><button type="button" data-act="runRoute" data-id="${r.id}">${esc(r.name)}<small>${esc(r.to.label.split(",")[0])}${r.depart_time ? ` · ${esc(fmtTime(r.depart_time))}` : ""}</small></button>
      <button type="button" class="chip-x ${r.notify ? "on" : ""}" data-act="toggleRouteAlert" data-id="${r.id}" data-on="${r.notify ? 1 : 0}" aria-label="${r.notify ? "Turn off alerts" : "Turn on alerts"}" title="${r.notify ? "Alerts on" : "Alerts off"}">${ICON.bell}</button>
      <button type="button" class="chip-x" data-act="deleteRoute" data-id="${r.id}" aria-label="Delete route">${ICON.x}</button></span>`).join("")}` : "";
    box._routes = routes;
  } catch { box.innerHTML = ""; }
}
function saveRouteDialog() {
  const q = matchQuery();
  if (!q.to) return toast("Enter where you're going first");
  dialog({
    title: "Save this route",
    html: `<p class="muted small">${esc(q.from ? q.from.label + " → " : "")}${esc(q.to.label)}${q.time ? ` · around ${esc(fmtTime(q.time))}` : ""}</p>
      <div class="field mt8"><label for="rn">Name</label><input id="rn" name="name" maxlength="40" placeholder="e.g. Office, Home weekend" required /></div>
      <div class="field"><span class="label">Days</span><div class="checks">${DAYS.map((d) => `<label class="check"><input type="checkbox" name="days" value="${d}" ${["Sat", "Sun"].includes(d) ? "" : "checked"}/> ${d}</label>`).join("")}</div></div>
      <label class="check"><input type="checkbox" name="notify" checked /> Notify me when a matching journey is posted</label>`,
    submitLabel: "Save route",
    onSubmit: async (f) => {
      const days = [...document.querySelectorAll("#dlg input[name=days]:checked")].map((x) => x.value);
      await api("/api/routes", { method: "POST", body: { name: f.name, from: q.from, to: q.to, depart_time: q.time || "", days, notify: !!f.notify } });
      toast("Route saved ✓"); loadSavedRoutes();
    },
  });
}
function useApproxLocation() {
  if (typeof navigator === "undefined" || !navigator.geolocation) return toast("Location isn't available in this browser");
  dialog({
    title: "Use your approximate location?",
    html: `<p>We'll ask your browser for your location, round it to about 1 km and use it <strong>only for this search</strong>. It isn't saved or shown to anyone.</p>`,
    submitLabel: "Use approximate location",
    onSubmit: () => new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition((pos) => {
        const lat = Math.round(pos.coords.latitude * 100) / 100, lng = Math.round(pos.coords.longitude * 100) / 100;
        placePicks.m_from_loc = { label: "My approximate location", lat, lng };
        const i = $("#m_from"); i.value = "My approximate location"; delete placePicks.m_from;
        const n = $("#locNote"); n.hidden = false; n.textContent = "Using your location rounded to about 1 km, for this search only.";
        resolve();
      }, (err) => { toast(err.code === 1 ? "Location permission was denied — type an area instead." : "Couldn't get your location — type an area instead."); resolve(); }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
    }),
  });
}

// ---------- People ----------
async function explorePeople(p) {
  if (!me) return needLogin();
  $("#exploreBody").innerHTML = `
    <label class="search-wrap card">${ICON.search}<input id="peopleQ" placeholder="Search by name, @username or college" value="${esc(p.q || "")}" aria-label="Search people" /></label>
    ${me.college ? `<a class="community-link card mt12" href="#/community">${ICON.users}<span><b>${esc(me.college)}</b><small>See people and journeys from your community</small></span>${ICON.right}</a>` : `<p class="muted small mt12"><a href="#/me">Add your college or workplace</a> to join its community.</p>`}
    <div id="peopleList" class="card mt12 people-list"><p class="muted center">Type at least 2 letters to search.</p></div>`;
  const input = $("#peopleQ"); let deb;
  const run = async () => {
    const q = input.value.trim(), box = $("#peopleList");
    if (q.length < 2) { box.innerHTML = `<p class="muted center">Type at least 2 letters to search.</p>`; return; }
    box.innerHTML = `<p class="muted center">Searching…</p>`;
    try {
      const { users } = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
      box.innerHTML = users.length ? users.map(personRow).join("") : `<p class="muted center">No members match “${esc(q)}”.</p>`;
    } catch (err) { box.innerHTML = `<p class="muted center">${esc(err.message)}</p>`; }
  };
  input.addEventListener("input", () => { clearTimeout(deb); deb = setTimeout(run, 250); });
  if (p.q) run();
}
const personRow = (u) => `<a class="person" href="#/u/${u.id}">${avatar(u)}<span class="grow"><b>${esc(u.name)}</b><small>@${esc(u.username)}${u.college ? ` · ${esc(u.college)}` : ""}</small>${u.bio ? `<small class="bio-line">${esc(u.bio)}</small>` : ""}</span>
  <span class="person-meta">${u.rating ? `<span class="stars">★ ${u.rating}</span>` : ""}${u.trips_posted != null ? `<small>${plural(u.trips_posted, "post")}</small>` : ""}</span></a>`;

// ---------- Community ----------
async function viewCommunity(params) {
  if (!me) return needLogin();
  view.innerHTML = `<div class="skeleton short"></div>`;
  let d; try { d = await api(`/api/community${params.name ? `?name=${encodeURIComponent(params.name)}` : ""}`); } catch (err) { return notFound(err.message); }
  if (!d.name) { view.innerHTML = `<div class="card empty"><p><strong>Join your community</strong></p><p class="muted mt8">Add your college, university or workplace to your profile to see people and journeys from there.</p><p class="mt12"><a class="btn" href="#/me">Edit profile</a></p></div>`; return; }
  view.innerHTML = `
    <section class="card community-head">
      <span class="community-badge">${ICON.users}</span>
      <div class="grow"><h1>${esc(d.name)}</h1><p class="muted small">${plural(d.member_count, "member")} · self-declared on profiles, <strong>not verified</strong></p></div>
    </section>
    <h2 class="sec-title">Members</h2>
    <div class="member-strip">${d.members.map((u) => `<a class="member" href="#/u/${u.id}">${avatar(u, "lg")}<span>${esc(u.name.split(" ")[0])}</span></a>`).join("") || `<p class="muted">Nobody else yet.</p>`}</div>
    <h2 class="sec-title">Upcoming journeys</h2>
    ${d.trips.length ? `<div class="tiles">${d.trips.map(tile).join("")}</div>` : `<div class="card empty"><p>No upcoming journeys from this community yet.</p><p class="mt12"><a class="btn" href="#/post">Share yours</a></p></div>`}`;
}

// ---------- Home: suggestions ----------
async function loadRecommendations() {
  const box = $("#recs"); if (!box || !me) return;
  try {
    const d = await api("/api/recommendations");
    if (!d.items.length) {
      box.innerHTML = d.has_routes ? "" : `<a class="card tip" href="#/explore?tab=match">${ICON.spark}<span><b>Get journeys that fit your commute</b><small>Save your usual route and we'll suggest — and alert you about — matching journeys.</small></span>${ICON.right}</a>`;
      return;
    }
    box.innerHTML = `<section class="recs"><div class="row between"><h2 class="h3">Suggested for you</h2><a class="small" href="#/explore?tab=match">Your routes</a></div>
      <div class="rec-strip">${d.items.map((i) => `<div class="rec">${miniCard(i.trip)}<p class="because">${esc(i.because)}</p>${i.reasons.length ? reasonChips(i.reasons.slice(0, 2)) : ""}</div>`).join("")}</div></section>`;
    for (const i of d.items) tripCache.set(i.trip.id, i.trip);
  } catch { box.innerHTML = ""; }
}

// ---------- Trip page extras: route preview, directions, updates, AI ----------
async function tripExtras(t) {
  const box = $("#tripExtras"); if (!box) return;
  const hasGeo = t.geo && (t.geo.origin || t.geo.dest);
  box.innerHTML = `
    <section class="card trip-route">
      <div class="row between"><h3>Route</h3><a class="btn ghost small" href="${esc(directionsUrl(t))}" target="_blank" rel="noopener">${ICON.nav} Open in Maps</a></div>
      <p class="muted small">${routeFacts(t) || "Distance and time aren't available for this journey."}</p>
      ${hasGeo && config.map ? `<div id="tripMap" class="map small-map"><div class="map-msg">Loading map…</div></div>` : ""}
      ${me ? `<div class="row mt12"><button class="btn ghost small" data-act="openAi" data-trip="${t.id}" data-q="Help me estimate the contribution for this route">${ICON.spark} Estimate cost share</button>
        ${t.is_owner ? `<button class="btn ghost small" data-act="openAi" data-trip="${t.id}" data-q="Help me write a caption for this trip">${ICON.spark} Caption ideas</button>` : ""}</div>` : ""}
    </section>
    <section class="card" id="tripUpdates" hidden></section>`;
  if (hasGeo && config.map) {
    try {
      const r = await api(`/api/trips/${t.id}/route`);
      const map = await MapKit.create($("#tripMap"), { cooperative: true, center: r.origin ? [r.origin.lng, r.origin.lat] : undefined, zoom: 10 });
      if (r.origin) MapKit.marker(MapKit.pin("origin", (VEHICLES[t.vehicle_type] || ["•"])[0])).setLngLat([r.origin.lng, r.origin.lat]).addTo(map);
      if (r.dest) MapKit.marker(MapKit.pin("dest", "Destination")).setLngLat([r.dest.lng, r.dest.lat]).addTo(map);
      MapKit.showRoute(map, r.coords, r.origin, r.dest);
    } catch (e) { const m = $("#tripMap"); if (m) m.innerHTML = `<div class="map-msg"><p>${esc(mapFailText(e))}</p></div>`; }
  }
  if (me && (t.is_owner || t.my_interest === "accepted")) loadTripUpdates(t);
}
const UPDATE_BUTTONS = [["leaving", "🚦 Leaving now"], ["late", "⏱️ Running late"], ["waiting", "📍 At pickup point"], ["arrived", "✅ Arrived"], ["note", "✏️ Note"]];
async function loadTripUpdates(t) {
  const box = $("#tripUpdates"); if (!box) return;
  try {
    const d = await api(`/api/trips/${t.id}/updates`);
    if (!d.can_view) return;
    const today = new Date().toLocaleDateString("en-CA"); const near = Math.abs((new Date(t.depart_date) - new Date(today)) / 864e5) <= 1;
    box.hidden = false;
    box.innerHTML = `<h3>Trip updates</h3>
      <p class="muted small">Quick status for confirmed travellers on the day — no live location is shared. Updates disappear after 12 hours.</p>
      ${t.is_owner && near && ["open", "closed"].includes(t.status) ? `<div class="update-btns">${UPDATE_BUTTONS.map(([k, l]) => `<button type="button" class="quick-chip" data-act="tripUpdate" data-kind="${k}" data-trip="${t.id}">${l}</button>`).join("")}</div>` : t.is_owner ? `<p class="muted small">You can post updates on the day of travel.</p>` : ""}
      <div class="updates">${d.updates.length ? d.updates.map((u) => `<div class="update"><b>${esc(u.body)}</b><time>${esc(ago(u.created_at))}</time></div>`).join("") : `<p class="muted small">No updates yet.</p>`}</div>`;
  } catch { /* optional */ }
}
function tripUpdateDialog(tripId, kind) {
  const send = async (body) => { const r = await api(`/api/trips/${tripId}/updates`, { method: "POST", body }); toast(r.notified ? `Sent to ${plural(r.notified, "traveller")}` : "Posted"); const t = tripCache.get(tripId); if (t) loadTripUpdates(t); };
  if (kind === "late") return dialog({ title: "Running late", html: `<div class="field"><label for="ul">About how late?</label><select id="ul" name="minutes">${[5, 10, 15, 20, 30, 45, 60].map((m) => `<option value="${m}" ${m === 10 ? "selected" : ""}>${m} min</option>`).join("")}</select></div><div class="field"><label for="un">Note (optional)</label><input id="un" name="note" maxlength="140" placeholder="e.g. traffic at the flyover" /></div>`, submitLabel: "Send update", onSubmit: (f) => send({ kind, minutes: Number(f.minutes), note: f.note }) });
  if (kind === "note") return dialog({ title: "Send a note", html: `<div class="field"><label for="un2">Note</label><input id="un2" name="note" maxlength="140" required placeholder="e.g. Waiting near the ATM" /></div><p class="muted small">Don't share your exact live location.</p>`, submitLabel: "Send", onSubmit: (f) => send({ kind, note: f.note }) });
  send({ kind }).catch((err) => toast(err.message));
}

// ---------- Saath AI ----------
const ai = { history: [], busy: false, tripId: null };
const AI_SUGGESTIONS = ["Find people going to IIT Kharagpur tomorrow morning", "Show trips heading towards my office around 9 AM", "Which journeys match my destination and departure time?", "Help me write a caption for my motorcycle trip", "Help me estimate the contribution for this route"];
function renderAiFab() {
  const fab = $("#aiFab"); if (!fab) return;
  const path = parseHash().path;
  fab.hidden = !me || path.startsWith("/inbox") || ["/login", "/signup", "/post"].includes(path) || path.startsWith("/edit/");
}
function openAi(q = "", tripId = null) {
  if (!me) return needLogin();
  const panel = $("#aiPanel"); if (!panel) return;
  if (tripId !== ai.tripId) { ai.tripId = tripId; }
  panel.hidden = false; panel.setAttribute("aria-hidden", "false");
  if (!ai.ready) {
    ai.ready = true;
    panel.innerHTML = `<header class="ai-head"><span class="ai-mark">${ICON.spark}</span><div class="grow"><b>Saath AI</b><small id="aiMode">${config.ai ? "Finds real journeys on SaathRide" : "Basic mode"}</small></div>
        <button class="icon-btn" type="button" data-act="aiReset" aria-label="New chat" title="New chat">${ICON.repeat}</button><button class="icon-btn" type="button" data-act="closeAi" aria-label="Close">${ICON.x}</button></header>
      <div class="ai-log" id="aiLog" role="log" aria-live="polite"></div>
      <form class="composer-bar" id="aiForm"><textarea id="aiInput" rows="1" maxlength="600" placeholder="Ask about journeys, costs or captions…" aria-label="Message Saath AI"></textarea><button class="send-btn" aria-label="Send">${ICON.send}</button></form>
      <p class="chat-safety">Saath AI only shows journeys that exist on SaathRide. Costs are estimates — agree them in chat.</p>`;
    $("#aiForm").addEventListener("submit", (e) => { e.preventDefault(); sendAi(); });
    $("#aiInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendAi(); } });
    aiWelcome();
  }
  const ctx = $("#aiCtx"); if (ctx && ctx.remove) ctx.remove();
  if (tripId) { const t = tripCache.get(tripId); if (t) $("#aiLog").insertAdjacentHTML("beforeend", `<div class="ai-ctx" id="aiCtx">${ICON.pin} About: ${esc(t.origin)} → ${esc(t.destination)}</div>`); }
  const input = $("#aiInput"); if (q) { input.value = q; sendAi(); } else if (input.focus) input.focus();
}
function aiWelcome() {
  $("#aiLog").innerHTML = `<div class="ai-msg bot"><p>Hi ${esc(me.name.split(" ")[0])}! I can find journeys going your way, check which ones fit your route and time, help write a caption, or estimate a fair cost share.</p>
    ${config.ai ? "" : `<p class="ai-notice">Running in basic mode — the AI service isn't configured on this server, so I understand simpler questions.</p>`}</div>
    <div class="ai-sugs">${AI_SUGGESTIONS.map((s) => `<button type="button" class="quick-chip" data-act="aiSuggest" data-q="${esc(s)}">${esc(s)}</button>`).join("")}</div>`;
}
async function sendAi() {
  const input = $("#aiInput"), text = input.value.trim();
  if (!text || ai.busy) return;
  input.value = "";
  const log = $("#aiLog");
  const sugs = log.querySelector(".ai-sugs"); if (sugs && sugs.remove) sugs.remove();
  log.insertAdjacentHTML("beforeend", `<div class="ai-msg me"><p>${esc(text)}</p></div><div class="ai-msg bot typing" id="aiTyping"><span></span><span></span><span></span></div>`);
  log.scrollTop = log.scrollHeight || 0;
  ai.busy = true;
  try {
    const r = await api("/api/ai/chat", { method: "POST", body: { message: text, history: ai.history.slice(-10), trip_id: ai.tripId || undefined } });
    ai.history.push({ role: "user", text }, { role: "assistant", text: r.reply });
    const t = $("#aiTyping"); if (t && t.remove) t.remove();
    log.insertAdjacentHTML("beforeend", aiReplyHtml(r));
    for (const c of r.cards || []) tripCache.set(c.trip.id, c.trip);
  } catch (err) {
    const t = $("#aiTyping"); if (t && t.remove) t.remove();
    log.insertAdjacentHTML("beforeend", `<div class="ai-msg bot error"><p>${esc(err.message)}</p><button type="button" class="btn ghost small" data-act="aiRetry" data-q="${esc(text)}">Try again</button></div>`);
  } finally { ai.busy = false; log.scrollTop = log.scrollHeight || 0; }
}
function aiReplyHtml(r) {
  const paras = esc(r.reply).split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
  const est = r.estimate && r.estimate.available ? `<div class="ai-est"><div class="row between"><b>₹${r.estimate.per_person_inr} <small>per person</small></b><span class="basis warn">estimate</span></div>
      <small>≈ ₹${r.estimate.total_inr} total · ${r.estimate.road_km} km · ${r.estimate.people} ${r.estimate.people === 1 ? "person" : "people"}</small>
      <details><summary>Assumptions</summary><ul>${r.estimate.assumptions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></details></div>` : "";
  const cards = (r.cards || []).length ? `<div class="ai-cards">${r.cards.map((c) => `<div class="ai-card">${miniCard(c.trip)}${reasonChips(c.reasons.slice(0, 3))}</div>`).join("")}</div>` : "";
  return `<div class="ai-msg bot">${r.notice ? `<p class="ai-notice">${esc(r.notice)}</p>` : ""}${paras}${est}${cards}</div>`;
}

// ---------- Edit profile: notifications & safety settings ----------
const PREF_LABELS = [["messages", "New messages"], ["requests", "Join requests and replies"], ["trips", "Trip changes"], ["trip_updates", "Day-of-travel updates"], ["route_matches", "Journeys matching my saved routes"], ["calls", "Missed calls"]];
async function loadSettingsExtras() {
  const box = $("#prefsBox"); if (!box) return;
  try {
    const { prefs } = await api("/api/me/notification-prefs");
    box.innerHTML = `<div class="checks stacked">${PREF_LABELS.map(([k, l]) => `<label class="check"><input type="checkbox" data-pref="${k}" ${prefs[k] ? "checked" : ""}/> ${l}</label>`).join("")}</div>
      <p class="muted small mt8">Trip cancellations are always shown. Changes save instantly.</p>
      ${me.is_admin ? `<p class="mt12"><a class="btn ghost small" href="#/admin">${ICON.shield} Review reports</a></p>` : ""}`;
    box.querySelectorAll("[data-pref]").forEach((el) => el.addEventListener("change", async () => {
      try { await api("/api/me/notification-prefs", { method: "PUT", body: { prefs: { [el.dataset.pref]: el.checked } } }); toast("Saved"); } catch (err) { toast(err.message); el.checked = !el.checked; }
    }));
  } catch { box.textContent = "Couldn't load notification settings."; }
}

// ---------- Report review (ADMIN_EMAILS only) ----------
async function viewAdmin() {
  if (!me) return needLogin();
  let d; try { d = await api("/api/admin/reports"); } catch { return notFound("Page not found"); }
  const row = (r, kind) => `<div class="request"><div class="grow"><b>${kind === "trip" ? `<a href="#/trip/${r.trip_id}">${esc(r.origin)} → ${esc(r.destination)}</a> by @${esc(r.owner_username)}` : `<a href="#/u/${r.reported_id}">${esc(r.reported_name)}</a> @${esc(r.reported_username)}`}</b>
      <div class="muted small">${esc(r.reason)} · reported by @${esc(r.reporter_username)} · ${esc(ago(r.created_at))} · ${r.open_reports} open</div>${r.details ? `<blockquote>${esc(r.details)}</blockquote>` : ""}</div>
      <span class="status ${r.status === "open" ? "pending" : "ok"}">${esc(r.status)}</span>
      ${r.status === "open" ? `<div class="row"><button class="btn small" data-act="adminReport" data-kind="${kind}" data-id="${r.id}" data-status="resolved">Resolve</button><button class="btn ghost small" data-act="adminReport" data-kind="${kind}" data-id="${r.id}" data-status="dismissed">Dismiss</button></div>` : ""}</div>`;
  view.innerHTML = `<h1 class="page-title">Reports</h1><p class="muted small">Only accounts listed in ADMIN_EMAILS can see this page. Three open reports hide a post from the feed; dismissing reports restores it.</p>
    <section class="card mt12"><h3>Posts (${d.trip_reports.length})</h3>${d.trip_reports.map((r) => row(r, "trip")).join("") || `<p class="muted">No post reports.</p>`}</section>
    <section class="card mt12"><h3>Members (${d.user_reports.length})</h3>${d.user_reports.map((r) => row(r, "user")).join("") || `<p class="muted">No member reports.</p>`}</section>`;
}

// ---------- clicks for this file ----------
document.addEventListener("click", async (e) => {
  const btn = e.target.closest && e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act, id = Number(btn.dataset.id);
  if (act === "openAi") openAi(btn.dataset.q || "", Number(btn.dataset.trip) || null);
  else if (act === "closeAi") { const p = $("#aiPanel"); p.hidden = true; p.setAttribute("aria-hidden", "true"); }
  else if (act === "aiSuggest" || act === "aiRetry") { $("#aiInput").value = btn.dataset.q; sendAi(); }
  else if (act === "aiReset") { ai.history = []; ai.tripId = null; aiWelcome(); }
  else if (act === "mapFocus") selectMapTrip(id);
  else if (act === "mapClose") { const c = $("#mapCard"); c.hidden = true; }
  else if (act === "reloadRoute") route();
  else if (act === "saveRoute") saveRouteDialog();
  else if (act === "rematch") runMatch();
  else if (act === "useLocation") useApproxLocation();
  else if (act === "runRoute") {
    const r = ($("#savedRoutes")._routes || []).find((x) => x.id === id); if (!r) return;
    $("#m_to").value = r.to.label.split(",")[0]; if (r.to.lat != null) placePicks.m_to = r.to; else delete placePicks.m_to;
    if (r.from) { $("#m_from").value = r.from.label.split(",")[0]; if (r.from.lat != null) placePicks.m_from = r.from; else delete placePicks.m_from; } else { $("#m_from").value = ""; delete placePicks.m_from; }
    $("#m_time").value = r.depart_time || ""; runMatch();
  } else if (act === "toggleRouteAlert") {
    try { await api(`/api/routes/${id}`, { method: "PATCH", body: { notify: btn.dataset.on !== "1" } }); toast(btn.dataset.on === "1" ? "Alerts off for this route" : "Alerts on for this route"); loadSavedRoutes(); } catch (err) { toast(err.message); }
  } else if (act === "deleteRoute") {
    if (!confirm("Delete this saved route?")) return;
    try { await api(`/api/routes/${id}`, { method: "DELETE" }); loadSavedRoutes(); } catch (err) { toast(err.message); }
  } else if (act === "tripUpdate") tripUpdateDialog(Number(btn.dataset.trip), btn.dataset.kind);
  else if (act === "adminReport") {
    try { await api(`/api/admin/reports/${btn.dataset.kind}/${id}`, { method: "POST", body: { status: btn.dataset.status } }); toast("Updated"); viewAdmin(); } catch (err) { toast(err.message); }
  }
});
