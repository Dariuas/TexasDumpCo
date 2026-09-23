import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// ---------- tiny helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const el = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const money = (c) => `$${((c || 0) / 100).toFixed(2)}`;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
const cents = (dollars) => Math.round(parseFloat(dollars || "0") * 100);
function toast(msg) { const t = el(`<div class="toast">${esc(msg)}</div>`); document.body.appendChild(t); setTimeout(() => t.remove(), 2600); }
function badge(v) { return `<span class="badge b-${v}">${String(v).replace(/_/g, " ")}</span>`; }

let sb, session, me = { role: "customer", email: "" };

// ---------- auth ----------
(async function boot() {
  const cfg = await fetch("/api/public-config").then((r) => r.json());
  sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  const { data } = await sb.auth.getSession();
  session = data.session;
  if (session) return onSignedIn();
  showLogin();
})();

function showLogin() {
  $("#shell").hidden = true;
  $("#login").hidden = false;
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#login-err").textContent = "";
    const { data, error } = await sb.auth.signInWithPassword({
      email: $("#login-email").value.trim(), password: $("#login-pass").value,
    });
    if (error) { $("#login-err").textContent = error.message; return; }
    session = data.session; onSignedIn();
  }, { once: false });
}

async function onSignedIn() {
  // Resolve role via an authed call (settings is admin-only; fall back to staff).
  me.email = session.user.email;
  // Determine role: admin-settings is admin-only, so a 200 means admin,
  // a 403 means staff. Anything else falls back to staff (least privilege).
  const roleProbe = await fetch("/api/admin-settings", { headers: authHeaders() });
  me.role = roleProbe.status === 200 ? "admin" : "staff";
  $("#login").hidden = true;
  $("#shell").hidden = false;
  $("#admin-user").textContent = `${me.email} · ${me.role}`;
  document.querySelectorAll("[data-admin]").forEach((a) => { if (me.role !== "admin") a.style.display = "none"; });
  setupNav();
  render("dashboard");
}

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${session.access_token}`, ...extra };
}
async function authFetch(path, opts = {}) {
  const r = await fetch(`/api/${path}`, { ...opts, headers: authHeaders(opts.headers || {}) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
  return data;
}
function post(path, body) {
  return authFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

// ---------- nav ----------
function setupNav() {
  const nav = $("#admin-nav");
  nav.querySelectorAll("a").forEach((a) =>
    a.addEventListener("click", () => {
      nav.querySelectorAll("a").forEach((x) => x.classList.remove("active"));
      a.classList.add("active");
      nav.classList.remove("open");
      render(a.dataset.view);
    }));
  $("#menu-btn").addEventListener("click", () => nav.classList.toggle("open"));
  $("#logout").addEventListener("click", async () => { await sb.auth.signOut(); location.reload(); });
  $("#chg-pass").addEventListener("click", async () => {
    const p1 = prompt("New password (min 8 characters):");
    if (!p1) return;
    if (p1.length < 8) return alert("Password must be at least 8 characters.");
    if (prompt("Confirm new password:") !== p1) return alert("Passwords didn't match.");
    const { error } = await sb.auth.updateUser({ password: p1 });
    if (error) return alert(error.message);
    toast("Password updated");
  });
}

const views = {};
function render(view) {
  const main = $("#view");
  main.innerHTML = `<p class="muted">Loading…</p>`;
  (views[view] || (() => (main.innerHTML = "Not found")))(main).catch((e) => (main.innerHTML = `<p class="empty">${esc(e.message)}</p>`));
}

// ==================================================================
//  DASHBOARD
// ==================================================================
views.dashboard = async (main) => {
  const today = new Date().toISOString().slice(0, 10);
  const { bookings } = await authFetch("admin-bookings");
  const upcoming = bookings.filter((b) => b.status !== "canceled" && b.start_date >= today);
  const todays = bookings.filter((b) => b.start_date === today && b.status !== "canceled");
  const cashPending = bookings.filter((b) => b.payment_status === "cash_pending");
  const quoteRequests = bookings.filter((b) => b.status === "pending" && (b.flags || []).includes("quote_requested"));
  const revenue = bookings.filter((b) => b.payment_status === "paid").reduce((s, b) => s + b.amount_paid_cents, 0);

  main.innerHTML = `
    <h2>Dashboard</h2>
    <div class="kpi-row">
      <div class="kpi"><div class="n">${todays.length}</div><div class="l">Jobs today</div></div>
      <div class="kpi"><div class="n">${upcoming.length}</div><div class="l">Upcoming</div></div>
      <div class="kpi"><div class="n">${cashPending.length}</div><div class="l">Cash to approve</div></div>
      <div class="kpi"><div class="n">${quoteRequests.length}</div><div class="l">Quotes to price</div></div>
    </div>
    ${quoteRequests.length ? `<h3>📞 Needs a phone quote (cleanout / heavy material / yard waste / 35+ mi)</h3>${bookingTable(quoteRequests)}` : ""}
    ${cashPending.length ? `<h3>⚠ Cash bookings awaiting approval</h3>${bookingTable(cashPending)}` : ""}
    <h3>Next up</h3>
    ${upcoming.length ? bookingTable(upcoming.slice(0, 15)) : `<div class="empty">No upcoming bookings.</div>`}
    <p class="hint">Collected to date: ${money(revenue)}</p>`;
  wireRows(main);
};

// ==================================================================
//  BOOKINGS + JUNK (shared list with filters)
// ==================================================================
function bookingListView(serviceFilter) {
  return async (main) => {
    main.innerHTML = `
      <h2>${serviceFilter === "junk" ? "Junk Hauling" : "Bookings"}</h2>
      <div class="toolbar">
        <input class="grow" id="f-q" placeholder="Search name, ref, phone, email">
        <select id="f-status">
          <option value="">All statuses</option>
          ${["pending", "confirmed", "scheduled", "delivered", "picked_up", "completed", "canceled"].map((s) => `<option>${s}</option>`).join("")}
        </select>
        <select id="f-pay">
          <option value="">All payments</option>
          ${["unpaid", "deposit_paid", "paid", "cash_pending", "refunded", "partially_refunded"].map((s) => `<option>${s}</option>`).join("")}
        </select>
        <input type="date" id="f-from" title="From date">
        <input type="date" id="f-to" title="To date">
        <button class="btn btn-primary btn-sm" id="f-go">Filter</button>
        <button class="btn btn-ghost btn-sm" id="f-new">+ New Booking (Phone Quote)</button>
      </div>
      <div id="list"><p class="muted">Loading…</p></div>`;

    $("#f-new").addEventListener("click", () => openNewBookingForm(serviceFilter, load));

    const load = async () => {
      const p = new URLSearchParams();
      if (serviceFilter) p.set("service", serviceFilter);
      if ($("#f-q").value.trim()) p.set("q", $("#f-q").value.trim());
      if ($("#f-status").value) p.set("status", $("#f-status").value);
      if ($("#f-pay").value) p.set("payment_status", $("#f-pay").value);
      if ($("#f-from").value) p.set("from", $("#f-from").value);
      if ($("#f-to").value) p.set("to", $("#f-to").value);
      const { bookings } = await authFetch(`admin-bookings?${p}`);
      $("#list").innerHTML = bookings.length ? bookingTable(bookings) : `<div class="empty">No bookings match.</div>`;
      wireRows(main);
    };
    $("#f-go").addEventListener("click", load);
    $("#f-q").addEventListener("keydown", (e) => { if (e.key === "Enter") load(); });
    await load();
  };
}
views.bookings = bookingListView(null);
views.junk = bookingListView("junk");

function bookingTable(rows) {
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th>Ref</th><th>Customer</th><th>Item</th><th>Dates</th><th>Status</th><th>Payment</th><th>Total</th></tr></thead>
    <tbody>${rows.map((b) => `
      <tr data-id="${b.id}">
        <td><strong>${esc(b.reference)}</strong></td>
        <td>${esc(b.customer_name)}<br><span class="muted">${esc(b.customer_phone)}</span></td>
        <td>${esc(b.dumpster_types?.name || "")}</td>
        <td>${b.start_date}${b.end_date !== b.start_date ? `<br>→ ${b.end_date}` : ""}</td>
        <td>${badge(b.status)}${(b.flags && b.flags.length) ? `<span class="flag">⚑${b.flags.length}</span>` : ""}</td>
        <td>${badge(b.payment_status)}</td>
        <td>${money(b.amount_total_cents)}</td>
      </tr>`).join("")}</tbody></table></div>`;
}
function wireRows(main) {
  main.querySelectorAll("tr[data-id]").forEach((tr) =>
    tr.addEventListener("click", () => openBooking(tr.dataset.id)));
}

// ---------- manual "phone quote" booking entry (contractor / heavy material / cleanouts) ----------
async function openNewBookingForm(serviceFilter, onDone) {
  const { types } = await authFetch("admin-inventory");
  const list = (serviceFilter ? types.filter((t) => t.service === serviceFilter) : types).filter((t) => t.active);
  const drawer = $("#drawer"), backdrop = $("#drawer-backdrop");
  drawer.innerHTML = `
    <button class="close" id="nb-close">×</button>
    <h2>New Booking — Phone Quote</h2>
    <p class="hint">For contractor accounts, heavy material, cleanouts, or any job priced by phone. Confirms immediately.</p>
    <label>Service type<select id="nb-type">${list.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select></label>
    <div class="row two" style="display:grid;gap:10px;grid-template-columns:1fr 1fr;margin-top:8px">
      <label>Customer name<input id="nb-name"></label>
      <label>Phone<input id="nb-phone"></label>
    </div>
    <label>Email (optional)<input id="nb-email" type="email"></label>
    <label>Address<input id="nb-address"></label>
    <label>Notes<textarea id="nb-notes" rows="2"></textarea></label>
    <div class="row two" style="display:grid;gap:10px;grid-template-columns:1fr 1fr;margin-top:8px">
      <label>Start date<input id="nb-start" type="date"></label>
      <label>End date (optional)<input id="nb-end" type="date"></label>
    </div>
    <label>Agreed price ($)<input id="nb-amount" type="number" step="0.01"></label>
    <div class="row two" style="display:grid;gap:10px;grid-template-columns:1fr 1fr;margin-top:8px">
      <label>Payment method<select id="nb-method"><option value="cash">Cash</option><option value="card">Card</option></select></label>
      <label>Payment status<select id="nb-status"><option value="unpaid">Unpaid (invoice later)</option><option value="paid">Paid in full</option><option value="deposit_paid">Deposit paid</option></select></label>
    </div>
    <label id="nb-paid-wrap" hidden>Amount paid now ($)<input id="nb-paid" type="number" step="0.01"></label>
    <div class="actions" style="margin-top:12px"><button class="btn btn-primary btn-sm" id="nb-submit">Create Booking</button></div>`;
  drawer.hidden = false; backdrop.hidden = false;
  const close = () => { drawer.hidden = true; backdrop.hidden = true; };
  $("#nb-close").addEventListener("click", close);
  backdrop.addEventListener("click", close, { once: true });
  $("#nb-status").addEventListener("change", () => { $("#nb-paid-wrap").hidden = $("#nb-status").value !== "deposit_paid"; });
  $("#nb-submit").addEventListener("click", async () => {
    if (!$("#nb-name").value.trim() || !$("#nb-phone").value.trim() || !$("#nb-address").value.trim() || !$("#nb-start").value || !$("#nb-amount").value) {
      return alert("Name, phone, address, start date and price are required.");
    }
    try {
      await post("admin-create-booking", {
        type_id: $("#nb-type").value,
        customer_name: $("#nb-name").value.trim(),
        customer_email: $("#nb-email").value.trim() || undefined,
        customer_phone: $("#nb-phone").value.trim(),
        delivery_address: $("#nb-address").value.trim(),
        notes: $("#nb-notes").value.trim(),
        start_date: $("#nb-start").value,
        end_date: $("#nb-end").value || undefined,
        amount_total_cents: cents($("#nb-amount").value),
        payment_method: $("#nb-method").value,
        payment_status: $("#nb-status").value,
        amount_paid_cents: cents($("#nb-paid")?.value || "0"),
      });
      toast("Booking created"); close(); onDone();
    } catch (e) { alert(e.message); }
  });
}

// ---------- booking drawer ----------
async function openBooking(id) {
  const { booking: b, photos, payments } = await authFetch(`admin-bookings?id=${id}`);
  const drawer = $("#drawer"), backdrop = $("#drawer-backdrop");
  const typeName = b.dumpster_types?.name || "";
  const refundable = b.amount_paid_cents - payments.filter((p) => p.kind === "refund").reduce((s, p) => s + p.amount_cents, 0);

  drawer.innerHTML = `
    <button class="close" id="drawer-close">×</button>
    <h2>${esc(b.reference)} ${badge(b.status)}</h2>
    <dl class="dl">
      <dt>Customer</dt><dd>${esc(b.customer_name)}<br>${esc(b.customer_phone)} · ${esc(b.customer_email)}</dd>
      <dt>Service</dt><dd>${esc(typeName)} (${esc(b.service)})</dd>
      <dt>Address</dt><dd>${esc(b.delivery_address)}${b.delivery_notes ? `<br><span class="muted">${esc(b.delivery_notes)}</span>` : ""}</dd>
      <dt>Dates</dt><dd>${b.start_date} → ${b.end_date}${b.time_window ? ` · ${esc(b.time_window)}` : ""}</dd>
      <dt>Unit</dt><dd>${esc(b.inventory_units?.label || "— not assigned —")}</dd>
      <dt>Payment</dt><dd>${badge(b.payment_method)} ${badge(b.payment_status)} · paid ${money(b.amount_paid_cents)} / ${money(b.amount_total_cents)}</dd>
      ${b.promo_codes ? `<dt>Promo</dt><dd>${esc(b.promo_codes.code)} (−${money(b.discount_cents)})</dd>` : ""}
      ${b.notes ? `<dt>Job notes</dt><dd>${esc(b.notes)}</dd>` : ""}
      ${b.agreement_signed_name ? `<dt>Agreement</dt><dd>Signed by ${esc(b.agreement_signed_name)} (v${b.agreement_version || "?"})</dd>` : ""}
      ${b.flags && b.flags.length ? `<dt>Flags</dt><dd>${b.flags.map((f) => `<span class="flag">${esc(f)}</span>`).join(" ")}</dd>` : ""}
    </dl>

    <div class="drawer-actions">
      ${(b.flags || []).includes("quote_requested") && b.status === "pending" ? `
        <button class="btn btn-primary btn-sm" data-act="set-price">Set Final Price &amp; Confirm</button>` : ""}
      ${b.payment_status === "cash_pending" ? `
        <button class="btn btn-primary btn-sm" data-act="cash-approve">Approve cash</button>
        <button class="btn btn-ghost btn-sm" data-act="cash-approve-collected">Approve + collected</button>
        <button class="btn btn-ghost btn-sm" data-act="cash-reject">Reject</button>` : ""}
      ${b.status !== "canceled" ? `<button class="btn btn-ghost btn-sm" data-act="reschedule">Reschedule</button>` : ""}
      ${refundable > 0 && b.payment_method === "card" ? `<button class="btn btn-ghost btn-sm" data-act="refund">Refund</button>` : ""}
      ${b.status !== "canceled" ? `<button class="btn btn-ghost btn-sm" data-act="cancel">Cancel</button>` : ""}
    </div>

    <div class="section-line"></div>
    <label class="form-inline">Status
      <select id="d-status">${["pending", "confirmed", "scheduled", "delivered", "picked_up", "completed", "canceled"].map((s) => `<option ${s === b.status ? "selected" : ""}>${s}</option>`).join("")}</select>
    </label>
    <div style="margin:10px 0">
      <span class="hint">Flags:</span>
      ${["hazardous", "overweight", "access_issue", "review"].map((f) => `<label class="chk"><input type="checkbox" value="${f}" ${(b.flags || []).includes(f) ? "checked" : ""}> ${f}</label>`).join(" ")}
    </div>
    <label>Admin notes<textarea id="d-notes" rows="2">${esc(b.admin_notes || "")}</textarea></label>
    <div class="actions" style="margin-top:8px"><button class="btn btn-primary btn-sm" data-act="save">Save changes</button></div>

    <div class="section-line"></div>
    <h3>Photos</h3>
    <div class="photo-grid" id="photo-grid">
      ${photos.map((p) => `<a href="${p.url}" target="_blank"><img src="${p.url}" alt="${esc(p.kind)}" title="${esc(p.kind)} · ${esc(p.uploaded_by)}"></a>`).join("") || '<span class="muted">No photos.</span>'}
    </div>
    <label class="hint">Add drop-off / pickup photo
      <input type="file" id="staff-photo" accept="image/*" capture="environment">
    </label>

    <div class="section-line"></div>
    <h3>Payment history</h3>
    <div class="table-wrap"><table class="table"><tbody>
      ${payments.map((p) => `<tr><td>${p.kind}</td><td>${p.method}</td><td>${p.kind === "refund" ? "−" : ""}${money(p.amount_cents)}</td><td>${badge(p.status)}</td><td>${new Date(p.created_at).toLocaleDateString()}</td></tr>`).join("") || '<tr><td class="muted">No payments recorded.</td></tr>'}
    </tbody></table></div>`;

  drawer.hidden = false; backdrop.hidden = false;
  const close = () => { drawer.hidden = true; backdrop.hidden = true; };
  $("#drawer-close").addEventListener("click", close);
  backdrop.addEventListener("click", close, { once: true });

  const refresh = () => { close(); openBooking(id); };
  drawer.querySelectorAll("[data-act]").forEach((btn) => btn.addEventListener("click", async () => {
    const act = btn.dataset.act;
    try {
      if (act === "save") {
        const flags = [...drawer.querySelectorAll('.chk input:checked')].map((c) => c.value);
        await post("admin-booking-update", { id, action: "update", status: $("#d-status").value, flags, admin_notes: $("#d-notes").value });
        toast("Saved"); refresh();
      } else if (act === "cancel") {
        if (confirm("Cancel this booking?")) { await post("admin-booking-update", { id, action: "cancel" }); toast("Canceled"); refresh(); render(currentView()); }
      } else if (act === "reschedule") {
        const start = prompt("New start date (YYYY-MM-DD):", b.start_date); if (!start) return;
        const end = prompt("New end date (YYYY-MM-DD):", b.end_date); if (!end) return;
        await post("admin-booking-update", { id, action: "reschedule", start_date: start, end_date: end });
        toast("Rescheduled"); refresh();
      } else if (act === "refund") {
        const amt = prompt(`Refund amount in dollars (max ${money(refundable)}):`, (refundable / 100).toFixed(2)); if (!amt) return;
        await post("admin-refund", { booking_id: id, amount_cents: cents(amt) });
        toast("Refunded"); refresh();
      } else if (act === "set-price") {
        const amt = prompt("Final agreed price in dollars:", (b.amount_total_cents / 100).toFixed(2)); if (!amt) return;
        const remainingFlags = (b.flags || []).filter((f) => f !== "quote_requested");
        await post("admin-booking-update", { id, action: "update", amount_total_cents: cents(amt), status: "confirmed", flags: remainingFlags });
        toast("Price set — booking confirmed"); refresh();
      } else if (act === "cash-approve") {
        await post("admin-approve-cash", { booking_id: id, decision: "approve" }); toast("Approved"); refresh();
      } else if (act === "cash-approve-collected") {
        await post("admin-approve-cash", { booking_id: id, decision: "approve", mark_collected: true }); toast("Approved + collected"); refresh();
      } else if (act === "cash-reject") {
        if (confirm("Reject this cash booking?")) { await post("admin-approve-cash", { booking_id: id, decision: "reject" }); toast("Rejected"); refresh(); }
      }
    } catch (e) { alert(e.message); }
  }));

  $("#staff-photo").addEventListener("change", async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const { path, token } = await authFetch("upload-url", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filename: file.name, content_type: file.type }) });
      await sb.storage.from("booking-uploads").uploadToSignedUrl(path, token, file);
      const kind = prompt("Photo type: drop_off or pickup", "drop_off") || "drop_off";
      await post("admin-photo", { booking_id: id, path, kind });
      toast("Photo added"); refresh();
    } catch (err) { alert(err.message); }
  });
}
function currentView() { return $("#admin-nav a.active")?.dataset.view || "dashboard"; }

// ==================================================================
//  INVENTORY & PRICING
// ==================================================================
const PRICING_MODE_HINT = {
  flat: "One fixed price (e.g. junk load-volume tiers).",
  duration_tiers: "Priced by rental length — edit the day/price tiers below.",
  quote_only: "\"Starting at\" price shown online; customer requests a quote, staff sets the real price (Section F/G/contractor jobs).",
};

views.inventory = async (main) => {
  const { types, units, tiers, addons } = await authFetch("admin-inventory");
  const isAdmin = me.role === "admin";
  main.innerHTML = `
    <h2>Inventory &amp; Pricing</h2>
    <p class="hint">Matches the TXD Master Pricing &amp; Phone Call Guide. Contractor rates and judgment fees are reference-only — apply them via <strong>Bookings → + New Booking (Phone Quote)</strong>, see Settings.</p>
    <h3>Types &amp; pricing ${isAdmin ? "" : "<span class='hint'>(read-only — admin edits pricing)</span>"}</h3>
    <div id="types"></div>
    ${isAdmin ? `<button class="btn btn-ghost btn-sm" id="add-type">+ Add type</button>` : ""}
    <h3>Units (physical containers)</h3>
    <p class="hint">Types sharing the same "Equipment pool" label share physical containers for availability (e.g. Standard + Clean Green Waste roll-offs).</p>
    <div id="units"></div>
    <h3>Add-on items</h3>
    <p class="hint">Specialty items shown as checkboxes on junk-hauling bookings (mattress, appliance, access fees...).</p>
    <div id="addons"></div>`;

  const typeName = (id) => types.find((t) => t.id === id)?.name || "?";

  const renderTypes = () => {
    $("#types").innerHTML = types.map((t) => `
      <div class="form" data-id="${t.id}">
        <div class="row three">
          <label>Name<input class="f-name" value="${esc(t.name)}" ${isAdmin ? "" : "disabled"}></label>
          <label>Service<select class="f-service" ${isAdmin ? "" : "disabled"}><option ${t.service === "dumpster" ? "selected" : ""}>dumpster</option><option ${t.service === "junk" ? "selected" : ""}>junk</option></select></label>
          <label>Active<select class="f-active" ${isAdmin ? "" : "disabled"}><option value="true" ${t.active ? "selected" : ""}>Yes</option><option value="false" ${!t.active ? "selected" : ""}>No</option></select></label>
        </div>
        <div class="row three">
          <label>Category<input class="f-cat" value="${esc(t.category)}" ${isAdmin ? "" : "disabled"} placeholder="e.g. roll_off_standard"></label>
          <label>Pricing mode<select class="f-mode" ${isAdmin ? "" : "disabled"}>${["flat", "duration_tiers", "quote_only"].map((m) => `<option value="${m}" ${m === t.pricing_mode ? "selected" : ""}>${m}</option>`).join("")}</select></label>
          <label>Price note<input class="f-note" value="${esc(t.price_note || "")}" ${isAdmin ? "" : "disabled"} placeholder="e.g. Starting at"></label>
        </div>
        <p class="hint" id="mode-hint-${t.id}">${PRICING_MODE_HINT[t.pricing_mode] || ""}</p>
        <div class="row three">
          <label>${t.pricing_mode === "duration_tiers" ? "Lowest tier / display ($)" : "Base price ($)"}<input class="f-base" type="number" step="0.01" value="${(t.base_price_cents / 100).toFixed(2)}" ${isAdmin ? "" : "disabled"}></label>
          <label>Deposit ($, 0=use %)<input class="f-dep" type="number" step="0.01" value="${(t.deposit_cents / 100).toFixed(2)}" ${isAdmin ? "" : "disabled"}></label>
          <label>Days included<input class="f-days" type="number" value="${t.rental_days_included}" ${isAdmin ? "" : "disabled"}></label>
        </div>
        <div class="row three">
          <label>Extra day beyond tiers ($)<input class="f-extra" type="number" step="0.01" value="${(t.extra_day_fee_cents / 100).toFixed(2)}" ${isAdmin ? "" : "disabled"}></label>
          <label>Weight limit (tons)<input class="f-wt" type="number" step="0.1" value="${t.weight_limit_tons ?? ""}" ${isAdmin ? "" : "disabled"}></label>
          <label>Overage/ton ($)<input class="f-over" type="number" step="0.01" value="${(t.overage_fee_cents / 100).toFixed(2)}" ${isAdmin ? "" : "disabled"}></label>
        </div>
        <div class="row two">
          <label>Uses physical inventory?<select class="f-inv" ${isAdmin ? "" : "disabled"}><option value="true" ${t.uses_inventory ? "selected" : ""}>Yes (roll-off container)</option><option value="false" ${!t.uses_inventory ? "selected" : ""}>No (crew/truck job)</option></select></label>
          <label>Equipment pool (shared containers)<input class="f-pool" value="${esc(t.equipment_pool || "")}" ${isAdmin ? "" : "disabled"} placeholder="blank = own pool"></label>
        </div>
        <label>Description<input class="f-desc" value="${esc(t.description || "")}" ${isAdmin ? "" : "disabled"}></label>
        ${isAdmin ? `<div class="actions"><button class="btn btn-primary btn-sm" data-save>Save</button></div>` : ""}
        ${t.pricing_mode === "duration_tiers" ? `
          <div class="section-line"></div>
          <h4>Duration price tiers — ${esc(t.name)}</h4>
          <div id="tiers-${t.id}"></div>
          ${isAdmin ? `<div class="row three" style="margin-top:8px">
            <label>Days<input class="nt-days" type="number" placeholder="7"></label>
            <label>Price ($)<input class="nt-price" type="number" step="0.01" placeholder="419.00"></label>
            <label>Label<input class="nt-label" placeholder="7 Days - Most Popular"></label>
          </div><div class="actions"><button class="btn btn-ghost btn-sm" data-add-tier="${t.id}">+ Add / update tier</button></div>` : ""}` : ""}
      </div>`).join("");

    if (isAdmin) $("#types").querySelectorAll("[data-save]").forEach((btn) => btn.addEventListener("click", async () => {
      const box = btn.closest(".form");
      await post("admin-inventory", {
        action: "update_type", id: box.dataset.id,
        name: box.querySelector(".f-name").value, service: box.querySelector(".f-service").value,
        active: box.querySelector(".f-active").value === "true",
        category: box.querySelector(".f-cat").value, pricing_mode: box.querySelector(".f-mode").value,
        price_note: box.querySelector(".f-note").value || null,
        base_price_cents: cents(box.querySelector(".f-base").value), deposit_cents: cents(box.querySelector(".f-dep").value),
        rental_days_included: +box.querySelector(".f-days").value, extra_day_fee_cents: cents(box.querySelector(".f-extra").value),
        weight_limit_tons: parseFloat(box.querySelector(".f-wt").value) || null, overage_fee_cents: cents(box.querySelector(".f-over").value),
        uses_inventory: box.querySelector(".f-inv").value === "true", equipment_pool: box.querySelector(".f-pool").value || null,
        description: box.querySelector(".f-desc").value,
      });
      toast("Type saved"); render("inventory");
    }));
    if (isAdmin) $("#types").querySelectorAll("[data-add-tier]").forEach((btn) => btn.addEventListener("click", async () => {
      const typeId = btn.dataset.addTier;
      const box = btn.closest(".form");
      const days = +box.querySelector(".nt-days").value, price = box.querySelector(".nt-price").value, label = box.querySelector(".nt-label").value;
      if (!days || !price) return alert("Days and price are required.");
      await post("admin-inventory", { action: "upsert_tier", type_id: typeId, days, price_cents: cents(price), label: label || null, sort_order: days });
      toast("Tier saved"); render("inventory");
    }));
    types.filter((t) => t.pricing_mode === "duration_tiers").forEach((t) => {
      const rows = tiers.filter((r) => r.type_id === t.id).sort((a, b) => a.days - b.days);
      const wrap = $(`#tiers-${t.id}`);
      if (!wrap) return;
      wrap.innerHTML = rows.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Days</th><th>Price</th><th>Label</th>${isAdmin ? "<th></th>" : ""}</tr></thead><tbody>
        ${rows.map((r) => `<tr><td>${r.days}</td><td>${money(r.price_cents)}</td><td>${esc(r.label || "")}</td>${isAdmin ? `<td><button class="btn btn-ghost btn-sm" data-del-tier="${r.id}">Del</button></td>` : ""}</tr>`).join("")}
        </tbody></table></div>` : `<p class="muted">No tiers yet.</p>`;
      if (isAdmin) wrap.querySelectorAll("[data-del-tier]").forEach((b) => b.addEventListener("click", async () => {
        await post("admin-inventory", { action: "delete_tier", id: b.dataset.delTier }); render("inventory");
      }));
    });
  };
  renderTypes();

  if (isAdmin) $("#add-type").addEventListener("click", async () => {
    const name = prompt("New type name:"); if (!name) return;
    const service = prompt("Service (dumpster/junk):", "dumpster") || "dumpster";
    const category = prompt("Category (grouping key, e.g. roll_off_standard, junk_household, junk_cleanout, heavy_material):", "general") || "general";
    const pricingMode = prompt("Pricing mode (flat / duration_tiers / quote_only):", "flat") || "flat";
    await post("admin-inventory", { action: "create_type", name, service, category, pricing_mode: pricingMode, base_price_cents: 0, active: true });
    render("inventory");
  });
  const renderUnits = () => {
    $("#units").innerHTML = `<div class="table-wrap"><table class="table">
      <thead><tr><th>Label</th><th>Type</th><th>Status</th><th></th></tr></thead><tbody>
      ${units.map((u) => `<tr>
        <td><input class="u-label" data-id="${u.id}" value="${esc(u.label)}"></td>
        <td>${esc(typeName(u.type_id))}</td>
        <td><select class="u-status" data-id="${u.id}">${["available", "in_service", "maintenance", "out_of_service"].map((s) => `<option ${s === u.status ? "selected" : ""}>${s}</option>`).join("")}</select></td>
        <td><button class="btn btn-ghost btn-sm u-save" data-id="${u.id}">Save</button>${isAdmin ? ` <button class="btn btn-ghost btn-sm u-del" data-id="${u.id}">Del</button>` : ""}</td>
      </tr>`).join("")}
      </tbody></table></div>
      <div class="form" style="margin-top:12px"><div class="row three">
        <label>New unit label<input id="nu-label"></label>
        <label>Type<select id="nu-type">${types.filter((t) => t.service === "dumpster").map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select></label>
        <div class="actions" style="align-items:flex-end"><button class="btn btn-primary btn-sm" id="nu-add">+ Add unit</button></div>
      </div></div>`;
    $("#units").querySelectorAll(".u-save").forEach((b) => b.addEventListener("click", async () => {
      const id = b.dataset.id;
      await post("admin-inventory", { action: "update_unit", id, label: $(`.u-label[data-id="${id}"]`).value, status: $(`.u-status[data-id="${id}"]`).value });
      toast("Unit saved");
    }));
    $("#units").querySelectorAll(".u-del").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Delete this unit?")) return;
      await post("admin-inventory", { action: "delete_unit", id: b.dataset.id });
      render("inventory");
    }));
    $("#nu-add").addEventListener("click", async () => {
      const label = $("#nu-label").value.trim(); if (!label) return;
      await post("admin-inventory", { action: "create_unit", type_id: $("#nu-type").value, label });
      render("inventory");
    });
  };
  renderUnits();

  const renderAddons = () => {
    $("#addons").innerHTML = `<div class="table-wrap"><table class="table">
      <thead><tr><th>Name</th><th>Category</th><th>Price</th><th>Active</th><th></th></tr></thead><tbody>
      ${addons.map((a) => `<tr>
        <td><input class="a-name" data-id="${a.id}" value="${esc(a.name)}" ${isAdmin ? "" : "disabled"}></td>
        <td><select class="a-cat" data-id="${a.id}" ${isAdmin ? "" : "disabled"}>${["specialty", "appliance", "access", "fee"].map((c) => `<option ${c === a.category ? "selected" : ""}>${c}</option>`).join("")}</select></td>
        <td><input class="a-price" data-id="${a.id}" type="number" step="0.01" value="${(a.price_cents / 100).toFixed(2)}" style="width:90px" ${isAdmin ? "" : "disabled"}></td>
        <td><select class="a-active" data-id="${a.id}" ${isAdmin ? "" : "disabled"}><option value="true" ${a.active ? "selected" : ""}>Yes</option><option value="false" ${!a.active ? "selected" : ""}>No</option></select></td>
        <td>${isAdmin ? `<button class="btn btn-ghost btn-sm a-save" data-id="${a.id}">Save</button> <button class="btn btn-ghost btn-sm a-del" data-id="${a.id}">Del</button>` : ""}</td>
      </tr>`).join("")}
      </tbody></table></div>
      ${isAdmin ? `<div class="form" style="margin-top:12px"><div class="row three">
        <label>Name<input id="na-name"></label>
        <label>Category<select id="na-cat">${["specialty", "appliance", "access", "fee"].map((c) => `<option>${c}</option>`).join("")}</select></label>
        <label>Price ($)<input id="na-price" type="number" step="0.01"></label>
      </div><div class="actions"><button class="btn btn-primary btn-sm" id="na-add">+ Add add-on</button></div></div>` : ""}`;
    if (!isAdmin) return;
    $("#addons").querySelectorAll(".a-save").forEach((b) => b.addEventListener("click", async () => {
      const id = b.dataset.id;
      await post("admin-inventory", {
        action: "update_addon", id,
        name: $(`.a-name[data-id="${id}"]`).value, category: $(`.a-cat[data-id="${id}"]`).value,
        price_cents: cents($(`.a-price[data-id="${id}"]`).value), active: $(`.a-active[data-id="${id}"]`).value === "true",
      });
      toast("Add-on saved");
    }));
    $("#addons").querySelectorAll(".a-del").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Delete this add-on?")) return;
      await post("admin-inventory", { action: "delete_addon", id: b.dataset.id }); render("inventory");
    }));
    $("#na-add").addEventListener("click", async () => {
      const name = $("#na-name").value.trim(); if (!name || !$("#na-price").value) return alert("Name and price required.");
      await post("admin-inventory", { action: "create_addon", name, category: $("#na-cat").value, price_cents: cents($("#na-price").value) });
      render("inventory");
    });
  };
  renderAddons();
};

// ==================================================================
//  AVAILABILITY & BLACKOUTS
// ==================================================================
views.availability = async (main) => {
  const [{ blackouts }, { types }] = await Promise.all([authFetch("admin-blackouts"), authFetch("admin-inventory")]);
  main.innerHTML = `
    <h2>Availability &amp; Blackouts</h2>
    <p class="hint">Blackouts remove dates from customer availability — for holidays, full trucks, or maintenance windows.</p>
    <div class="form"><h3>Add blackout</h3>
      <div class="row three">
        <label>Start<input type="date" id="bo-start"></label>
        <label>End<input type="date" id="bo-end"></label>
        <label>Applies to<select id="bo-type"><option value="">All types</option>${types.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select></label>
      </div>
      <label>Reason<input id="bo-reason" placeholder="e.g. Thanksgiving"></label>
      <div class="actions"><button class="btn btn-primary btn-sm" id="bo-add">Add blackout</button></div>
    </div>
    <h3>Current blackouts</h3>
    <div class="table-wrap"><table class="table"><thead><tr><th>Start</th><th>End</th><th>Scope</th><th>Reason</th><th></th></tr></thead>
    <tbody>${blackouts.map((b) => `<tr><td>${b.start_at.slice(0, 10)}</td><td>${b.end_at.slice(0, 10)}</td><td>${b.scope === "all" ? "All" : (types.find((t) => t.id === b.type_id)?.name || "type")}</td><td>${esc(b.reason || "")}</td><td><button class="btn btn-ghost btn-sm" data-del="${b.id}">Del</button></td></tr>`).join("") || '<tr><td class="muted" colspan="5">None.</td></tr>'}</tbody></table></div>`;
  $("#bo-add").addEventListener("click", async () => {
    const start = $("#bo-start").value, end = $("#bo-end").value;
    if (!start || !end) return alert("Pick start and end.");
    await post("admin-blackouts", { start_at: `${start}T00:00:00Z`, end_at: `${end}T23:59:59Z`, type_id: $("#bo-type").value || null, reason: $("#bo-reason").value });
    render("availability");
  });
  main.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => { await post("admin-blackouts", { action: "delete", id: b.dataset.del }); render("availability"); }));
};

// ==================================================================
//  PROMO CODES (admin)
// ==================================================================
views.promos = async (main) => {
  const { promos } = await authFetch("admin-promos");
  main.innerHTML = `
    <h2>Promo Codes</h2>
    <div class="form"><h3>New code</h3>
      <div class="row three">
        <label>Code<input id="p-code" placeholder="SAVE20"></label>
        <label>Type<select id="p-kind"><option value="percent">Percent %</option><option value="fixed">Fixed $</option></select></label>
        <label>Value<input id="p-val" type="number" step="0.01" placeholder="20"></label>
      </div>
      <div class="row three">
        <label>Min order ($)<input id="p-min" type="number" step="0.01" value="0"></label>
        <label>Max uses<input id="p-max" type="number" placeholder="blank = ∞"></label>
        <label>Applies to<select id="p-app"><option value="">Any</option><option value="dumpster">Dumpster</option><option value="junk">Junk</option></select></label>
      </div>
      <div class="actions"><button class="btn btn-primary btn-sm" id="p-add">Create</button></div>
      <p class="hint">Percent value is 1–100. Fixed value is dollars.</p>
    </div>
    <div class="table-wrap"><table class="table"><thead><tr><th>Code</th><th>Discount</th><th>Uses</th><th>Applies</th><th>Active</th><th></th></tr></thead>
    <tbody>${promos.map((p) => `<tr>
      <td><strong>${esc(p.code)}</strong></td>
      <td>${p.kind === "percent" ? p.value + "%" : money(p.value)}</td>
      <td>${p.uses_count}${p.max_uses ? "/" + p.max_uses : ""}</td>
      <td>${p.applies_to || "any"}</td>
      <td><button class="btn btn-ghost btn-sm" data-toggle="${p.id}" data-active="${p.active}">${p.active ? "Active" : "Off"}</button></td>
      <td><button class="btn btn-ghost btn-sm" data-del="${p.id}">Del</button></td>
    </tr>`).join("") || '<tr><td class="muted" colspan="6">No codes yet.</td></tr>'}</tbody></table></div>`;
  $("#p-add").addEventListener("click", async () => {
    const kind = $("#p-kind").value;
    const value = kind === "percent" ? Math.round(+$("#p-val").value) : cents($("#p-val").value);
    if (!$("#p-code").value.trim() || !value) return alert("Code and value required.");
    await post("admin-promos", { action: "create", code: $("#p-code").value.trim(), kind, value, min_amount_cents: cents($("#p-min").value), max_uses: $("#p-max").value ? +$("#p-max").value : null, applies_to: $("#p-app").value || null, active: true });
    render("promos");
  });
  main.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", async () => { await post("admin-promos", { action: "update", id: b.dataset.toggle, active: b.dataset.active !== "true" }); render("promos"); }));
  main.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => { if (confirm("Delete code?")) { await post("admin-promos", { action: "delete", id: b.dataset.del }); render("promos"); } }));
};

// ==================================================================
//  AGREEMENT (admin)
// ==================================================================
views.agreement = async (main) => {
  const { templates } = await authFetch("admin-agreement-template");
  const active = templates.find((t) => t.active) || templates[0] || { title: "Rental Agreement", body_html: "" };
  main.innerHTML = `
    <h2>Rental Agreement</h2>
    <p class="hint">Saving publishes a new version. Existing signed bookings keep the version they agreed to.</p>
    <div class="form">
      <label>Title<input id="a-title" value="${esc(active.title)}"></label>
      <label>Body (HTML)<textarea id="a-body" rows="16">${esc(active.body_html)}</textarea></label>
      <div class="actions"><button class="btn btn-primary btn-sm" id="a-save">Publish new version</button></div>
      <p class="hint">Current active version: v${active.version || "—"}</p>
    </div>
    <h3>Preview</h3>
    <div class="form" id="a-preview">${active.body_html}</div>`;
  $("#a-body").addEventListener("input", () => { $("#a-preview").innerHTML = $("#a-body").value; });
  $("#a-save").addEventListener("click", async () => { await post("admin-agreement-template", { title: $("#a-title").value, body_html: $("#a-body").value }); toast("Published"); render("agreement"); });
};

// ==================================================================
//  SETTINGS (admin)
// ==================================================================
views.settings = async (main) => {
  const { settings: s } = await authFetch("admin-settings");
  const v = (k, d = "") => s[k] ?? d;
  main.innerHTML = `
    <h2>Settings</h2>
    <div class="form">
      <div class="row two">
        <label>Company name<input id="s-name" value="${esc(v("company_name"))}"></label>
        <label>Company phone<input id="s-phone" value="${esc(v("company_phone"))}"></label>
      </div>
      <div class="row two">
        <label>Bookings email<input id="s-email" value="${esc(v("company_email"))}"></label>
        <label>New-booking alerts to<input id="s-alert" value="${esc(v("alert_email"))}"></label>
      </div>
      <div class="row three">
        <label>Deposit %<input id="s-dep" type="number" value="${esc(v("deposit_percent", 25))}"></label>
        <label>Tax rate (bps)<input id="s-tax" type="number" value="${esc(v("tax_rate_bps", 0))}"></label>
        <label>Lead time (days)<input id="s-lead" type="number" value="${esc(v("lead_time_days", 1))}"></label>
      </div>
      <div class="row three">
        <label>Booking window (days)<input id="s-window" type="number" value="${esc(v("booking_window_days", 120))}"></label>
        <label>Per-day cap (0=∞)<input id="s-cap" type="number" value="${esc(v("per_day_cap", 0))}"></label>
        <label>Accept cash?<select id="s-cash"><option value="true" ${v("cash_accepted") === true ? "selected" : ""}>Yes</option><option value="false" ${v("cash_accepted") !== true ? "selected" : ""}>No</option></select></label>
      </div>
      <label>Time windows (comma separated)<input id="s-tw" value="${esc((v("time_windows", []) || []).join(", "))}"></label>
      <div class="actions"><button class="btn btn-primary btn-sm" id="s-save">Save settings</button></div>
    </div>

    <h3>Delivery distance zones</h3>
    <p class="hint">Self-reported by the customer at booking, same question the phone guide asks: "where is the job?"</p>
    <div class="form">
      <div class="row three">
        <label>0-15 miles<input value="Included" disabled></label>
        <label>16-25 miles ($)<input id="z2" type="number" step="0.01" value="${esc(((zones()[1]?.fee_cents ?? 3500) / 100).toFixed(2))}"></label>
        <label>26-35 miles ($)<input id="z3" type="number" step="0.01" value="${esc(((zones()[2]?.fee_cents ?? 6500) / 100).toFixed(2))}"></label>
      </div>
      <p class="hint">Beyond 35 miles always routes to a phone quote — no fee to set.</p>
      <div class="actions"><button class="btn btn-primary btn-sm" id="z-save">Save zone fees</button></div>
    </div>

    <h3>Contractor rate card <span class="hint">(reference — apply via + New Booking)</span></h3>
    <div class="form">
      <textarea id="s-contractor" rows="8">${esc(JSON.stringify(v("contractor_rate_card", {}), null, 2))}</textarea>
      <div class="actions"><button class="btn btn-ghost btn-sm" id="s-contractor-save">Save</button></div>
    </div>

    <h3>Judgment fee reference <span class="hint">(dry run, stairs, long carry... — apply manually)</span></h3>
    <div class="form">
      <textarea id="s-fees" rows="10">${esc(JSON.stringify(v("fee_schedule_reference", {}), null, 2))}</textarea>
      <div class="actions"><button class="btn btn-ghost btn-sm" id="s-fees-save">Save</button></div>
    </div>`;

  function zones() { return v("distance_zones", []) || []; }

  $("#s-save").addEventListener("click", async () => {
    await post("admin-settings", { settings: {
      company_name: $("#s-name").value, company_phone: $("#s-phone").value, company_email: $("#s-email").value,
      alert_email: $("#s-alert").value, deposit_percent: +$("#s-dep").value, tax_rate_bps: +$("#s-tax").value,
      lead_time_days: +$("#s-lead").value, booking_window_days: +$("#s-window").value, per_day_cap: +$("#s-cap").value,
      cash_accepted: $("#s-cash").value === "true",
      time_windows: $("#s-tw").value.split(",").map((x) => x.trim()).filter(Boolean),
    } });
    toast("Settings saved");
  });

  $("#z-save").addEventListener("click", async () => {
    const z = zones();
    const updated = [
      z[0] || { code: "zone1", label: "0-15 miles (included)", fee_cents: 0, quote_only: false },
      { ...(z[1] || { code: "zone2", label: "16-25 miles" }), fee_cents: cents($("#z2").value), quote_only: false },
      { ...(z[2] || { code: "zone3", label: "26-35 miles" }), fee_cents: cents($("#z3").value), quote_only: false },
      z[3] || { code: "zone4", label: "Beyond 35 miles", fee_cents: 0, quote_only: true },
    ];
    await post("admin-settings", { settings: { distance_zones: updated } });
    toast("Zone fees saved");
  });

  $("#s-contractor-save").addEventListener("click", async () => {
    try {
      const parsed = JSON.parse($("#s-contractor").value);
      await post("admin-settings", { settings: { contractor_rate_card: parsed } });
      toast("Contractor rate card saved");
    } catch { alert("Invalid JSON."); }
  });
  $("#s-fees-save").addEventListener("click", async () => {
    try {
      const parsed = JSON.parse($("#s-fees").value);
      await post("admin-settings", { settings: { fee_schedule_reference: parsed } });
      toast("Fee reference saved");
    } catch { alert("Invalid JSON."); }
  });
};
