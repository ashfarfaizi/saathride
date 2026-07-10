// SaathRide — frontend SPA
const $ = (sel) => document.querySelector(sel);
const app = $("#app");
let me = null;
let chatTimer = null;

// ---------- api ----------
async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  const token = localStorage.getItem("token");
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.hidden = true), 2600);
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const initials = (name) => name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();

function routeLine(o, d) {
  return `<div class="route">
    <span class="dot origin"></span><span class="place">${esc(o)}</span>
    <span class="dash"></span>
    <span class="dot dest"></span><span class="place">${esc(d)}</span>
  </div>`;
}

// ---------- nav ----------
function renderNav() {
  const nav = $("#nav");
  if (me) {
    nav.innerHTML = `
      <button data-nav="search">Find a ride</button>
      <button data-nav="post" class="cta">Offer a ride</button>
      <button data-nav="mine">My rides</button>
      <button data-nav="logout">Log out</button>`;
  } else {
    nav.innerHTML = `
      <button data-nav="search">Find a ride</button>
      <button data-nav="login">Log in</button>
      <button data-nav="signup" class="cta">Sign up</button>`;
  }
}

document.addEventListener("click", (e) => {
  const nav = e.target.closest("[data-nav]");
  if (!nav) return;
  e.preventDefault();
  go(nav.dataset.nav);
});

function go(view, arg) {
  clearInterval(chatTimer);
  const views = { home, search, post, mine, login, signup, ride: rideDetail, logout };
  (views[view] || home)(arg);
}

// ---------- views ----------
function home() {
  app.innerHTML = `
    <section class="hero">
      <span class="eyebrow">Fuel-share carpooling</span>
      <h1>Same route.<br /><em>Shared ride.</em><br />New friends.</h1>
      <p>Government buses are packed. Cabs empty your wallet. Meanwhile someone from your
         college drives your exact route with three empty seats. SaathRide connects you —
         split the fuel, not your budget.</p>
      <div class="actions">
        <button class="btn" data-nav="search">Find a ride</button>
        <button class="btn ghost" data-nav="${me ? "post" : "signup"}">Offer a ride</button>
      </div>
    </section>
    <h2 class="section-title">Leaving soon</h2>
    <div id="feed" class="stack"><p class="muted">Loading rides…</p></div>`;
  loadRides({}, "#feed");
}

async function loadRides(params, target) {
  const q = new URLSearchParams(params).toString();
  try {
    const { rides } = await api(`/api/rides?${q}`);
    const el = $(target);
    if (!rides.length) {
      el.innerHTML = `<div class="card empty">No rides on this route yet. Be the first to offer one!</div>`;
      return;
    }
    el.innerHTML = rides.map(rideCard).join("");
  } catch (err) { toast(err.message); }
}

function rideCard(r) {
  const tags = [
    r.driver.is_verified ? `<span class="tag verified">✓ verified</span>` : "",
    r.women_only ? `<span class="tag women">women only</span>` : "",
    r.recurring ? `<span class="tag recurring">↻ ${esc(r.recurring)}</span>` : "",
  ].join(" ");
  return `
  <button class="card ride-card" data-ride="${r.id}">
    ${routeLine(r.origin, r.destination)}
    <div class="ride-meta">
      <span>${esc(r.depart_date)} · ${esc(r.depart_time)}</span>
      <span>${esc(r.vehicle_type)}</span>
      <span>${r.seats_left} seat${r.seats_left === 1 ? "" : "s"} left</span>
      <span class="price">₹${r.price_per_seat} / seat</span>
    </div>
    <div class="ride-meta">
      <span>Driver: ${esc(r.driver.name)}${r.driver.rating ? ` · <span class="stars">★ ${r.driver.rating}</span>` : ""}</span>
      ${tags}
    </div>
  </button>`;
}

document.addEventListener("click", (e) => {
  const card = e.target.closest("[data-ride]");
  if (card) go("ride", card.dataset.ride);
});

function search() {
  app.innerHTML = `
    <h2 class="section-title">Find a ride</h2>
    <form id="searchForm" class="card">
      <div class="row2">
        <div class="field"><label>From</label><input name="origin" placeholder="e.g. Mumbai" /></div>
        <div class="field"><label>To</label><input name="destination" placeholder="e.g. Pune" /></div>
      </div>
      <div class="row2">
        <div class="field"><label>Date</label><input type="date" name="date" /></div>
        <div class="field" style="display:flex;align-items:end;">
          <label class="check"><input type="checkbox" name="women_only" /> Women-only rides</label>
        </div>
      </div>
      <button class="btn">Search rides</button>
    </form>
    <div id="results" class="stack" style="margin-top:16px"></div>`;
  loadRides({}, "#results");
  $("#searchForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    loadRides({
      origin: f.get("origin") || "",
      destination: f.get("destination") || "",
      date: f.get("date") || "",
      women_only: f.get("women_only") ? "1" : "",
    }, "#results");
  });
}

function post() {
  if (!me) return go("login");
  app.innerHTML = `
    <h2 class="section-title">Offer a ride</h2>
    <form id="postForm" class="card">
      <div class="row2">
        <div class="field"><label>From</label><input name="origin" required /></div>
        <div class="field"><label>To</label><input name="destination" required /></div>
      </div>
      <div class="row2">
        <div class="field"><label>Date</label><input type="date" name="depart_date" required /></div>
        <div class="field"><label>Departure time</label><input type="time" name="depart_time" required /></div>
      </div>
      <div class="row2">
        <div class="field"><label>Seats available</label><input type="number" name="seats_total" min="1" max="6" value="2" required /></div>
        <div class="field"><label>Fuel share per seat (₹)</label><input type="number" name="price_per_seat" min="0" required placeholder="e.g. 150" /></div>
      </div>
      <div class="row2">
        <div class="field"><label>Vehicle</label>
          <select name="vehicle_type"><option>car</option><option>scooty</option><option>bike</option></select>
        </div>
        <div class="field"><label>Repeats (optional)</label><input name="recurring" placeholder="e.g. Mon, Fri" /></div>
      </div>
      ${me.gender === "female" ? `<div class="field"><label class="check"><input type="checkbox" name="women_only" /> Women-only ride</label></div>` : ""}
      <div class="field"><label>Notes</label><textarea name="notes" rows="2" placeholder="Pickup point, luggage space…"></textarea></div>
      <button class="btn">Post ride</button>
      <p class="muted" style="margin-top:10px">Fuel share should cover costs only — SaathRide is cost-sharing, not a taxi service.</p>
    </form>`;
  $("#postForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    f.women_only = !!f.women_only;
    try {
      const { ride } = await api("/api/rides", { method: "POST", body: JSON.stringify(f) });
      toast("Ride posted!");
      go("ride", ride.id);
    } catch (err) { toast(err.message); }
  });
}

async function rideDetail(id) {
  let data;
  try { data = await api(`/api/rides/${id}`); } catch (err) { return toast(err.message); }
  const r = data.ride;
  const isDriver = me && me.id === r.driver_id;
  const myBooking = me && r.bookings.find((b) => b.rider_id === me.id);
  const canChat = me && (isDriver || (myBooking && ["requested", "approved"].includes(myBooking.status)));

  app.innerHTML = `
    <div class="stack">
      <div class="card">
        ${routeLine(r.origin, r.destination)}
        <div class="ride-meta" style="margin-top:12px">
          <span>${esc(r.depart_date)} · ${esc(r.depart_time)}</span>
          <span>${esc(r.vehicle_type)}</span>
          <span>${r.seats_left}/${r.seats_total} seats left</span>
          <span class="price">₹${r.price_per_seat} / seat</span>
          ${r.women_only ? `<span class="tag women">women only</span>` : ""}
          ${r.recurring ? `<span class="tag recurring">↻ ${esc(r.recurring)}</span>` : ""}
          ${r.status !== "open" ? `<span class="tag">${esc(r.status)}</span>` : ""}
        </div>
        ${r.notes ? `<p class="muted" style="margin-top:10px">${esc(r.notes)}</p>` : ""}
        <div class="person" style="margin-top:16px">
          <div class="avatar">${initials(r.driver.name)}</div>
          <div>
            <strong>${esc(r.driver.name)}</strong>
            ${r.driver.is_verified ? `<span class="tag verified">✓ verified</span>` : ""}
            <div class="muted">${esc(r.driver.college || "")}
              ${r.driver.rating ? ` · <span class="stars">★ ${r.driver.rating}</span> (${r.driver.rating_count})` : " · no ratings yet"}</div>
          </div>
        </div>
        <div style="margin-top:16px" id="rideActions"></div>
      </div>
      ${isDriver ? `<div class="card"><h3>Seat requests</h3><div id="requests" class="stack" style="margin-top:10px"></div></div>` : ""}
      ${canChat ? `
      <div class="card">
        <h3>Ride chat</h3>
        <div class="chat-box" id="chatBox"></div>
        <form class="chat-form" id="chatForm">
          <input name="body" placeholder="Message the group…" autocomplete="off" />
          <button class="btn small">Send</button>
        </form>
      </div>` : ""}
    </div>`;

  // actions
  const actions = $("#rideActions");
  if (!me) {
    actions.innerHTML = `<button class="btn" data-nav="login">Log in to request a seat</button>`;
  } else if (isDriver && r.status === "open") {
    actions.innerHTML = `<button class="btn ghost" id="completeBtn">Mark ride completed</button>`;
    $("#completeBtn").onclick = async () => {
      await api(`/api/rides/${r.id}/complete`, { method: "POST" });
      toast("Ride completed"); go("ride", r.id);
    };
  } else if (!isDriver && r.status === "open") {
    if (!myBooking) {
      actions.innerHTML = `<button class="btn" id="bookBtn">Request a seat</button>`;
      $("#bookBtn").onclick = async () => {
        try { await api(`/api/rides/${r.id}/book`, { method: "POST" }); toast("Request sent!"); go("ride", r.id); }
        catch (err) { toast(err.message); }
      };
    } else {
      actions.innerHTML = `<span class="tag">Your request: ${esc(myBooking.status)}</span>`;
    }
  } else if (r.status === "completed" && me && !isDriver && myBooking?.status === "approved") {
    actions.innerHTML = `
      <label>Rate your driver</label>
      <div class="row2" style="margin-top:6px">
        <select id="rateStars"><option value="5">★★★★★</option><option value="4">★★★★</option><option value="3">★★★</option><option value="2">★★</option><option value="1">★</option></select>
        <button class="btn small" id="rateBtn">Submit rating</button>
      </div>`;
    $("#rateBtn").onclick = async () => {
      try {
        await api(`/api/rides/${r.id}/rate`, { method: "POST",
          body: JSON.stringify({ ratee_id: r.driver_id, stars: $("#rateStars").value }) });
        toast("Thanks for rating!"); go("ride", r.id);
      } catch (err) { toast(err.message); }
    };
  }

  // driver: seat requests
  if (isDriver) {
    const box = $("#requests");
    const pending = r.bookings.filter((b) => b.status !== "cancelled");
    box.innerHTML = pending.length
      ? pending.map((b) => `
        <div class="person">
          <div class="avatar">${initials(b.rider.name)}</div>
          <div style="flex:1">
            <strong>${esc(b.rider.name)}</strong>
            ${b.rider.is_verified ? `<span class="tag verified">✓</span>` : ""}
            <div class="muted">${esc(b.rider.college || "")} · ${esc(b.status)}</div>
          </div>
          ${b.status === "requested" ? `
            <button class="btn small" data-approve="${b.id}">Approve</button>
            <button class="btn small ghost" data-reject="${b.id}">Reject</button>` : ""}
        </div>`).join("")
      : `<p class="muted">No requests yet.</p>`;
    box.onclick = async (e) => {
      const a = e.target.closest("[data-approve]"), j = e.target.closest("[data-reject]");
      if (!a && !j) return;
      const bid = (a || j).dataset.approve || (a || j).dataset.reject;
      try {
        await api(`/api/bookings/${bid}/${a ? "approve" : "reject"}`, { method: "POST" });
        toast(a ? "Approved" : "Rejected"); go("ride", r.id);
      } catch (err) { toast(err.message); }
    };
  }

  // chat
  if (canChat) {
    const renderChat = async () => {
      try {
        const { messages } = await api(`/api/rides/${r.id}/messages`);
        const box = $("#chatBox");
        if (!box) return;
        box.innerHTML = messages.map((m) => `
          <div class="msg ${m.sender_id === me.id ? "mine" : ""}">
            <span class="who">${esc(m.sender_name)}</span>${esc(m.body)}
          </div>`).join("") || `<p class="muted">Say hi and coordinate pickup 👋</p>`;
        box.scrollTop = box.scrollHeight;
      } catch {}
    };
    renderChat();
    chatTimer = setInterval(renderChat, 3000);
    $("#chatForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = e.target.body;
      if (!input.value.trim()) return;
      await api(`/api/rides/${r.id}/messages`, { method: "POST", body: JSON.stringify({ body: input.value }) });
      input.value = "";
      renderChat();
    });
  }
}

async function mine() {
  if (!me) return go("login");
  const { driving, riding } = await api("/api/me/rides");
  app.innerHTML = `
    <h2 class="section-title">Rides I'm offering</h2>
    <div class="stack">${driving.map(rideCard).join("") || `<div class="card empty">You haven't offered any rides yet.</div>`}</div>
    <h2 class="section-title">Rides I've joined</h2>
    <div class="stack">${riding.map(rideCard).join("") || `<div class="card empty">You haven't joined any rides yet.</div>`}</div>`;
}

// ---------- auth views ----------
function login() {
  app.innerHTML = `
    <h2 class="section-title">Log in</h2>
    <form id="loginForm" class="card" style="max-width:440px">
      <div class="field"><label>Email</label><input type="email" name="email" required /></div>
      <div class="field"><label>Password</label><input type="password" name="password" required /></div>
      <button class="btn">Log in</button>
      <p class="muted" style="margin-top:12px">New here? <a href="#" data-nav="signup">Create an account</a></p>
    </form>`;
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const f = Object.fromEntries(new FormData(e.target));
      const { token, user } = await api("/api/auth/login", { method: "POST", body: JSON.stringify(f) });
      localStorage.setItem("token", token);
      me = user; renderNav(); toast(`Welcome back, ${user.name.split(" ")[0]}!`); go("home");
    } catch (err) { toast(err.message); }
  });
}

function signup() {
  app.innerHTML = `
    <h2 class="section-title">Create your account</h2>
    <form id="signupForm" class="card" style="max-width:520px">
      <div class="row2">
        <div class="field"><label>Full name</label><input name="name" required /></div>
        <div class="field"><label>Phone</label><input name="phone" /></div>
      </div>
      <div class="field"><label>Email</label><input type="email" name="email" required />
        <p class="muted" style="margin-top:4px">Use your college email (.ac.in / .edu) to get the ✓ verified badge instantly.</p></div>
      <div class="row2">
        <div class="field"><label>Password</label><input type="password" name="password" minlength="6" required /></div>
        <div class="field"><label>Gender</label>
          <select name="gender"><option value="unspecified">Prefer not to say</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></select>
        </div>
      </div>
      <div class="field"><label>College / company</label><input name="college" placeholder="e.g. COEP Pune" /></div>
      <div class="field"><label class="check"><input type="checkbox" name="has_vehicle" id="hasVehicle" /> I have a vehicle and may offer rides</label></div>
      <div class="field" id="vehicleField" hidden><label>Vehicle type</label>
        <select name="vehicle_type"><option>car</option><option>scooty</option><option>bike</option></select></div>
      <button class="btn">Sign up</button>
    </form>`;
  $("#hasVehicle").addEventListener("change", (e) => ($("#vehicleField").hidden = !e.target.checked));
  $("#signupForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const f = Object.fromEntries(new FormData(e.target));
      f.has_vehicle = !!f.has_vehicle;
      const { token, user } = await api("/api/auth/signup", { method: "POST", body: JSON.stringify(f) });
      localStorage.setItem("token", token);
      me = user; renderNav();
      toast(user.is_verified ? "Account created — verified ✓" : "Account created!");
      go("home");
    } catch (err) { toast(err.message); }
  });
}

function logout() {
  localStorage.removeItem("token");
  me = null; renderNav(); toast("Logged out"); go("home");
}

// ---------- boot ----------
(async function init() {
  const token = localStorage.getItem("token");
  if (token) {
    try { me = (await api("/api/me")).user; }
    catch { localStorage.removeItem("token"); }
  }
  renderNav();
  home();
})();
