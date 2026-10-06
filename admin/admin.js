import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { mountAvailabilityCalendar } from "/assets/js/availability-calendar.js";

// ---------- tiny helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const el = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const money = (c) => `$${((c || 0) / 100).toFixed(2)}`;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
const cents = (dollars) => Math.round(parseFloat(dollars || "0") * 100);
const addDays = (dateStr, n) => { const d = new Date(dateStr + "T00:00:00"); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const todayStr = () => new Date().toISOString().slice(0, 10);
function toast(msg) { const t = el(`<div class="toast">${esc(msg)}</div>`); document.body.appendChild(t); setTimeout(() => t.remove(), 2600); }
function badge(v) { return `<span class="badge b-${v}">${String(v).replace(/_/g, " ")}</span>`; }

// Run an async click handler at most once at a time; disables the button while in flight
// so fast double-clicks can't submit (and create) the same thing twice.
function guarded(btn, fn) {
  btn.addEventListener("click", async (e) => {
    if (btn.dataset.busy) return;
    btn.dataset.busy = "1"; btn.disabled = true;
    try { await fn(e); } finally { delete btn.dataset.busy; btn.disabled = false; }
  });
}

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
  refreshQueueBadge();
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
  $("#refresh").addEventListener("click", () => render(currentView()));
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
  const [{ bookings }, { quotes: webQuotes }] = await Promise.all([authFetch("admin-bookings"), authFetch("admin-quotes")]);
  const newWebQuotes = webQuotes.filter((q) => q.status === "new").length;
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
      <div class="kpi"><div class="n">${newWebQuotes}</div><div class="l">New web quote requests</div></div>
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
async function openNewBookingForm(serviceFilter, onDone, prefill = {}) {
  const [{ types }, cfg] = await Promise.all([authFetch("admin-inventory"), publicCfg()]);
  const q = prefill.quote || null;
  const contractor = prefill.contractor || null;
  const referralSources = cfg.referralSources || [];
  const list = (serviceFilter ? types.filter((t) => t.service === serviceFilter) : types).filter((t) => t.active);
  const drawer = $("#drawer"), backdrop = $("#drawer-backdrop");
  drawer.innerHTML = `
    <button class="close" id="nb-close">×</button>
    <h2>${q ? "Create Booking from Quote Request" : "New Booking — Phone Quote"}</h2>
    <p class="hint">For quote requests, contractor accounts, heavy material, cleanouts, or any job priced by phone.</p>
    <label>Service type<select id="nb-type">${list.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select></label>
    <div class="row two" style="display:grid;gap:10px;grid-template-columns:1fr 1fr;margin-top:8px">
      <label>Customer name<input id="nb-name" value="${esc(q?.name || "")}"></label>
      <label>Phone<input id="nb-phone" value="${esc(q?.phone || "")}"></label>
    </div>
    <label>Email ${q ? "" : "(optional)"}<input id="nb-email" type="email" value="${esc(q?.email || "")}"></label>
    <label>Address<input id="nb-address" value="${esc(q?.delivery_address || "")}"></label>
    <div class="actions"><button class="btn btn-ghost btn-sm" id="nb-distance" type="button">Calculate distance from the yard</button><span class="hint" id="nb-distance-msg"></span></div>
    <label>Notes<textarea id="nb-notes" rows="2">${esc(q ? [q.service, q.details].filter(Boolean).join(" — ") : "")}</textarea></label>
    <div class="row two" style="display:grid;gap:10px;grid-template-columns:1fr 1fr;margin-top:8px">
      <label>How did they hear about us?<select id="nb-source"><option value="">—</option>${referralSources.map((x) => `<option ${q?.referral_source === x ? "selected" : ""}>${esc(x)}</option>`).join("")}</select></label>
      <label>Contractor # / phone / email (optional)<input id="nb-contractor" placeholder="TXC-XXXXX" value="${esc(contractor?.contractor_number || (q?.is_contractor ? q.phone : "") || "")}"></label>
    </div>
    <label>Booking length (days)<input id="nb-days" type="number" min="1" value="1" style="max-width:100px"></label>
    <span class="field-label" style="display:block;margin-top:8px">Pick a start date <span class="hint">(availability for the selected type)</span></span>
    <div id="nb-calendar" style="margin-top:6px"></div>
    <div class="row two" style="display:grid;gap:10px;grid-template-columns:1fr 1fr;margin-top:8px">
      <label>Start date<input id="nb-start" type="date"></label>
      <label>End date<input id="nb-end" type="date"></label>
    </div>
    <label>Pricing<select id="nb-mode">
      <option value="itemize" ${q ? "selected" : ""}>Build an itemized invoice next (rental, mileage, fees) and send a pay link</option>
      <option value="agreed" ${q ? "" : "selected"}>Enter one agreed price now and confirm</option>
    </select></label>
    <div id="nb-agreed">
      <label>Agreed price ($)<input id="nb-amount" type="number" step="0.01"></label>
      <div class="row two" style="display:grid;gap:10px;grid-template-columns:1fr 1fr;margin-top:8px">
        <label>Payment method<select id="nb-method"><option value="cash">Cash</option><option value="card">Card</option></select></label>
        <label>Payment status<select id="nb-status"><option value="unpaid">Unpaid (invoice later)</option><option value="paid">Paid in full</option><option value="deposit_paid">Deposit paid</option></select></label>
      </div>
      <label id="nb-paid-wrap" hidden>Amount paid now ($)<input id="nb-paid" type="number" step="0.01"></label>
    </div>
    <div class="actions" style="margin-top:12px"><button class="btn btn-primary btn-sm" id="nb-submit">Create Booking</button></div>`;
  drawer.hidden = false; backdrop.hidden = false;
  const close = () => { if (cal) cal.destroy(); drawer.hidden = true; backdrop.hidden = true; };
  $("#nb-close").addEventListener("click", close);
  backdrop.addEventListener("click", close, { once: true });
  $("#nb-status").addEventListener("change", () => { $("#nb-paid-wrap").hidden = $("#nb-status").value !== "deposit_paid"; });
  const syncMode = () => { $("#nb-agreed").hidden = $("#nb-mode").value !== "agreed"; };
  $("#nb-mode").addEventListener("change", syncMode); syncMode();

  let distance = null;
  guarded($("#nb-distance"), async () => {
    const m = $("#nb-distance-msg");
    try {
      const r = await fetch("/api/distance-quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: $("#nb-address").value }) })
        .then(async (x) => { const d = await x.json(); if (!x.ok) throw new Error(d.error || "Failed"); return d; });
      if (r.configured === false) { m.textContent = "Google Maps is not set up yet."; return; }
      distance = r;
      m.textContent = `${r.oneway_miles} mi one way · ${r.round_trip_miles} mi round trip · mileage ${money(r.fee_cents)}${r.quote_only ? " · past the online limit" : ""}`;
    } catch (e) { m.textContent = e.message; }
  });

  // Staff can plan further out than the customer-facing lead time; no lead-time floor.
  const calMin = todayStr(), calMax = addDays(todayStr(), 180);
  let cal = mountAvailabilityCalendar($("#nb-calendar"), {
    typeId: $("#nb-type").value, days: +$("#nb-days").value || 1, minDate: calMin, maxDate: calMax,
    onSelect: (dateStr) => {
      $("#nb-start").value = dateStr;
      $("#nb-end").value = addDays(dateStr, (+$("#nb-days").value || 1) - 1);
    },
  });
  $("#nb-type").addEventListener("change", () => cal.setType($("#nb-type").value));
  $("#nb-days").addEventListener("change", () => {
    const days = Math.max(1, +$("#nb-days").value || 1);
    cal.setDays(days);
    if ($("#nb-start").value) $("#nb-end").value = addDays($("#nb-start").value, days - 1);
  });

  guarded($("#nb-submit"), async () => {
    const itemize = $("#nb-mode").value === "itemize";
    if (!$("#nb-name").value.trim() || !$("#nb-phone").value.trim() || !$("#nb-address").value.trim() || !$("#nb-start").value || (!itemize && !$("#nb-amount").value)) {
      return alert(itemize ? "Name, phone, address and start date are required." : "Name, phone, address, start date and price are required.");
    }
    if (itemize && !$("#nb-email").value.trim()) return alert("An email is needed to send the invoice and pay link.");
    try {
      const r = await post("admin-create-booking", {
        type_id: $("#nb-type").value,
        customer_name: $("#nb-name").value.trim(),
        customer_email: $("#nb-email").value.trim() || undefined,
        customer_phone: $("#nb-phone").value.trim(),
        delivery_address: $("#nb-address").value.trim(),
        notes: $("#nb-notes").value.trim(),
        referral_source: $("#nb-source").value || undefined,
        contractor_number: $("#nb-contractor").value.trim() || undefined,
        start_date: $("#nb-start").value,
        end_date: $("#nb-end").value || undefined,
        as_request: itemize,
        quote_request_id: q?.id,
        distance_miles: distance?.round_trip_miles,
        distance_fee_cents: distance && !distance.quote_only ? distance.fee_cents : undefined,
        amount_total_cents: itemize ? 0 : cents($("#nb-amount").value),
        payment_method: itemize ? "card" : $("#nb-method").value,
        payment_status: itemize ? "unpaid" : $("#nb-status").value,
        amount_paid_cents: cents($("#nb-paid")?.value || "0"),
      });
      toast(itemize ? "Booking created — build the invoice" : "Booking created");
      close(); onDone();
      if (itemize) {
        const { booking, charges } = await authFetch(`admin-bookings?id=${r.booking_id}`);
        drawer.hidden = false; backdrop.hidden = false;
        backdrop.addEventListener("click", () => { drawer.hidden = true; backdrop.hidden = true; }, { once: true });
        openInvoiceBuilder(booking, charges, () => openBooking(r.booking_id));
      }
    } catch (e) { alert(e.message); }
  });
}

// ---------- booking drawer ----------
async function openBooking(id) {
  const { booking: b, photos, payments, charges } = await authFetch(`admin-bookings?id=${id}`);
  const liveCharges = charges.filter((c) => c.status !== "void" && c.status !== "waived");
  const initialRows = liveCharges.filter((c) => c.stage === "initial");
  const hasInvoice = initialRows.length > 0;
  const initialLocked = initialRows.some((c) => ["invoiced", "paid", "external"].includes(c.status) && !(c.status === "invoiced" && (c.stripe_invoice_id || "").startsWith("cs_")));
  const initialOpen = initialRows.filter((c) => c.status === "draft" || (c.status === "invoiced" && (c.stripe_invoice_id || "").startsWith("cs_")));
  const draftAdjust = liveCharges.filter((c) => c.stage === "adjustment" && c.status === "draft");
  const drawer = $("#drawer"), backdrop = $("#drawer-backdrop");
  const typeName = b.dumpster_types?.name || "";
  // Every card payment (checkout, balance, overage) minus refunds; older bookings fall back to amount_paid.
  const cardIn = payments.filter((p) => p.method === "card" && p.kind !== "refund").reduce((s, p) => s + p.amount_cents, 0);
  const refunded = payments.filter((p) => p.kind === "refund").reduce((s, p) => s + p.amount_cents, 0);
  const refundable = (cardIn || b.amount_paid_cents) - refunded;

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
      ${b.service === "dumpster" && b.payment_method === "card" ? `<dt>Weight</dt><dd>
        ${b.weight_tons != null ? `${b.weight_tons} tons · overage ${money(b.overage_cents)} ${badge(b.overage_status)}` : '<span class="muted">Not recorded</span>'}
        ${b.overage_invoice_url ? `<br><a href="${b.overage_invoice_url}" target="_blank" rel="noopener">Customer pay link</a>` : ""}</dd>` : ""}
      ${b.balance_invoice_url ? `<dt>Balance</dt><dd><a href="${esc(b.balance_invoice_url)}" target="_blank" rel="noopener">Customer pay link</a></dd>` : ""}
      ${b.promo_codes ? `<dt>Promo</dt><dd>${esc(b.promo_codes.code)} (−${money(b.discount_cents)})</dd>` : ""}
      ${b.notes ? `<dt>Job notes</dt><dd>${esc(b.notes)}</dd>` : ""}
      ${b.referral_source ? `<dt>Heard about us</dt><dd>${esc(b.referral_source)}</dd>` : ""}
      ${b.contractor_id ? `<dt>Contractor</dt><dd>${esc(b.contractors?.company_name || "Contractor")}${b.contractors?.contractor_number ? ` · ${esc(b.contractors.contractor_number)}` : " · not approved yet"}</dd>` : ""}
      ${b.tax_exempt ? `<dt>Sales tax</dt><dd><span class="badge b-confirmed">tax exempt</span>${b.contractors?.tax_exempt_cert ? ` cert ${esc(b.contractors.tax_exempt_cert)}` : ""}</dd>` : ""}
      ${b.distance_miles != null ? `<dt>Distance</dt><dd>${b.distance_miles} mi round trip from the yard${b.distance_fee_cents ? ` · mileage ${money(b.distance_fee_cents)}` : ""}</dd>` : ""}
      ${b.agreement_signed_name ? `<dt>Agreement</dt><dd>Signed by ${esc(b.agreement_signed_name)} (v${b.agreement_version || "?"}, ${b.agreement_lang === "es" ? "Spanish" : "English"})<br>
        <span class="muted">${b.agreement_signed_at ? new Date(b.agreement_signed_at).toLocaleString() : ""} · IP ${esc(b.agreement_signed_ip || "?")}</span><br>
        ${b.agreement_verified_at ? `<span class="badge b-paid">email verified ${new Date(b.agreement_verified_at).toLocaleString()}</span>` : `<span class="badge b-unpaid">email not verified</span>`}
        ${b.agreement_signature ? `<br><img src="${b.agreement_signature}" alt="signature" style="max-width:220px;border:1px solid var(--line);background:#fff;margin-top:6px">` : ""}
        ${b.agreement_body_hash ? `<br><span class="muted" style="font-family:monospace;font-size:.68rem;word-break:break-all">SHA-256 ${esc(b.agreement_body_hash)}</span>` : ""}</dd>` : ""}
      ${b.flags && b.flags.length ? `<dt>Flags</dt><dd>${b.flags.map((f) => `<span class="flag">${esc(f)}</span>`).join(" ")}</dd>` : ""}
    </dl>

    <div class="drawer-actions">
      ${(b.flags || []).includes("quote_requested") && b.status === "pending" ? `
        <button class="btn btn-primary btn-sm" data-act="build-invoice">Build invoice &amp; confirm</button>` : ""}
      ${hasInvoice && !initialLocked && b.status !== "canceled" && !(b.flags || []).includes("quote_requested") ? `
        <button class="btn btn-ghost btn-sm" data-act="build-invoice">Edit invoice</button>` : ""}
      ${initialOpen.length && b.status !== "canceled" ? `
        <button class="btn btn-primary btn-sm" data-act="pay-link">${initialOpen.some((c) => c.status === "invoiced") ? "Resend pay link" : "Email pay link"}</button>` : ""}
      ${b.payment_method === "card" && b.status !== "canceled" && ["unpaid", "deposit_paid"].includes(b.payment_status) && !hasInvoice
          && !(b.flags || []).includes("quote_requested") && b.amount_total_cents > b.amount_paid_cents ? `
        <button class="btn btn-primary btn-sm" data-act="balance-link">Email pay link for balance</button>
        ${b.stripe_payment_method_id ? '<button class="btn btn-ghost btn-sm" data-act="balance-charge">Charge saved card for balance</button>' : ""}` : ""}
      ${b.payment_method === "card" && b.stripe_checkout_session_id && b.payment_status === "unpaid" ? `
        <button class="btn btn-primary btn-sm" data-act="sync-payment" title="Use when the customer paid but the booking still shows unpaid">Check payment in Stripe</button>` : ""}
      ${b.payment_status === "cash_pending" ? `
        <button class="btn btn-primary btn-sm" data-act="cash-approve">Approve cash</button>
        <button class="btn btn-ghost btn-sm" data-act="cash-approve-collected">Approve + collected</button>
        <button class="btn btn-ghost btn-sm" data-act="cash-reject">Reject</button>` : ""}
      ${b.service === "dumpster" && b.status !== "canceled" && b.overage_status !== "paid" ? `<button class="btn btn-ghost btn-sm" data-act="record-weight">Record weight</button>` : ""}
      ${b.overage_status === "due" ? `<button class="btn btn-primary btn-sm" data-act="charge-overage" ${b.stripe_payment_method_id ? "" : 'disabled title="No saved card"'}>Charge saved card</button>
        <button class="btn btn-ghost btn-sm" data-act="waive-overage">Waive overage</button>` : ""}
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
    <h3>Charges</h3>
    ${liveCharges.length || charges.length ? `<div class="table-wrap"><table class="table charge-table"><thead><tr><th>Item</th><th>Type</th><th class="num">Amount</th><th class="num">Tax</th><th>Status</th><th></th></tr></thead><tbody>
      ${charges.map((c) => `<tr data-charge="${c.id}" style="cursor:default${c.status === "void" || c.status === "waived" ? ";opacity:.5;text-decoration:line-through" : ""}">
        <td>${esc(c.description)}${c.quantity != 1 ? ` <span class="muted">(${c.quantity} × ${money(c.unit_cents)})</span>` : ""}</td>
        <td>${esc(c.kind.replace("_", " "))}${c.stage === "initial" ? "" : ' <span class="muted">added</span>'}</td>
        <td class="num">${money(c.amount_cents)}</td><td class="num">${money(c.tax_cents)}</td>
        <td>${badge(c.status === "external" ? "original" : c.status)}</td>
        <td>${["draft", "invoiced"].includes(c.status) && !(c.stage === "initial" && c.status === "draft") ? '<button class="btn btn-ghost btn-sm" data-remove>Remove</button>' : ""}</td></tr>`).join("")}
    </tbody></table></div>
    <div class="totals">Total ${money(b.amount_total_cents)} · Paid ${money(b.amount_paid_cents)} · <strong>Owed ${money(Math.max(0, b.amount_total_cents - b.amount_paid_cents))}</strong></div>` : '<p class="muted">No itemized charges yet.</p>'}
    ${b.status !== "canceled" ? `<details class="add-charge"${draftAdjust.length ? " open" : ""}><summary class="btn btn-ghost btn-sm">+ Add charge (overage, mileage, extra days, fee)</summary>
      <div class="form" style="margin-top:10px">
        <div class="row two" style="display:grid;gap:10px;grid-template-columns:1fr 1fr">
          <label>Type<select id="ac-kind">
            <option value="fee">Fee from fee schedule</option><option value="mileage">Extra mileage</option>
            <option value="extra_days">Extra days</option><option value="weight">Weight overage</option><option value="custom">Other</option>
          </select></label>
          <label id="ac-fee-wrap">Fee<select id="ac-fee"></select></label>
        </div>
        <label>Description<input id="ac-desc"></label>
        <div class="row three" style="display:grid;gap:10px;grid-template-columns:1fr 1fr 1fr">
          <label><span id="ac-qty-label">Quantity</span><input id="ac-qty" type="number" step="0.01" min="0" value="1"></label>
          <label>Each ($)<input id="ac-unit" type="number" step="0.01" min="0"></label>
          <label class="chk" style="align-self:end"><input type="checkbox" id="ac-taxable" ${b.tax_exempt ? "" : "checked"}> Taxable</label>
        </div>
        <div class="actions"><button class="btn btn-primary btn-sm" data-act="add-charge">Add charge</button></div>
      </div></details>` : ""}
    ${draftAdjust.length ? `<div class="drawer-actions">
      <span class="hint">${draftAdjust.length} new charge(s) not billed yet:</span>
      <button class="btn btn-primary btn-sm" data-act="bill-charge" ${b.stripe_payment_method_id ? "" : 'disabled title="No saved card on this booking"'}>Charge saved card</button>
      <button class="btn btn-ghost btn-sm" data-act="bill-link">Email pay link</button>
    </div>` : ""}

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
  drawer.querySelectorAll("[data-act]").forEach((btn) => guarded(btn, async () => {
    const act = btn.dataset.act;
    try {
      if (act === "save") {
        const flags = [...drawer.querySelectorAll('.chk input:checked')].map((c) => c.value);
        await post("admin-booking-update", { id, action: "update", status: $("#d-status").value, flags, admin_notes: $("#d-notes").value });
        toast("Saved"); refresh();
      } else if (act === "cancel") {
        const paidMsg = refundable > 0 && b.payment_method === "card"
          ? `\n\nThe customer paid ${money(refundable)} by card. Canceling does NOT refund it. Use Refund for that.` : "";
        if (confirm(`Cancel this booking?${paidMsg}`)) { await post("admin-booking-update", { id, action: "cancel" }); toast("Canceled"); refresh(); render(currentView()); }
      } else if (act === "reschedule") {
        const start = prompt("New start date (YYYY-MM-DD):", b.start_date); if (!start) return;
        const end = prompt("New end date (YYYY-MM-DD):", b.end_date); if (!end) return;
        await post("admin-booking-update", { id, action: "reschedule", start_date: start, end_date: end });
        toast("Rescheduled"); refresh();
      } else if (act === "refund") {
        const amt = prompt(`Refund amount in dollars (max ${money(refundable)}):`, (refundable / 100).toFixed(2)); if (!amt) return;
        await post("admin-refund", { booking_id: id, amount_cents: cents(amt) });
        toast("Refunded"); refresh();
      } else if (act === "build-invoice") {
        return openInvoiceBuilder(b, charges, refresh);
      } else if (act === "pay-link") {
        if (!confirm(`Email ${b.customer_email} a secure Stripe pay link for ${money(initialOpen.reduce((t, c) => t + c.amount_cents + c.tax_cents, 0))}? Their card is saved for later charges.`)) return;
        const r = await post("admin-booking-charges", { booking_id: id, action: "pay_link" });
        toast(r.emailed ? "Pay link emailed" : "Link created, but the email failed. Copy it from the next prompt.");
        if (!r.emailed) prompt("Pay link (copy and text it to the customer):", r.url);
        refresh();
      } else if (act === "add-charge") {
        const kind = $("#ac-kind").value, desc = $("#ac-desc").value.trim();
        const qty = parseFloat($("#ac-qty").value), unit = cents($("#ac-unit").value);
        if (!desc || !(qty > 0) || !(unit > 0)) return alert("Enter a description, quantity and amount.");
        await post("admin-booking-charges", { booking_id: id, action: "add", lines: [{ kind, description: desc, quantity: qty, unit_cents: unit, taxable: $("#ac-taxable").checked }] });
        toast("Charge added — bill it below"); refresh();
      } else if (act === "bill-charge" || act === "bill-link") {
        const total = draftAdjust.reduce((t, c) => t + c.amount_cents + c.tax_cents, 0);
        const charge = act === "bill-charge";
        if (!confirm(charge ? `Charge the saved card ${money(total)} now and email a receipt?` : `Email ${b.customer_email} a pay link for ${money(total)}?`)) return;
        const r = await post("admin-booking-charges", { booking_id: id, action: "bill", method: charge ? "charge" : "link" });
        toast(charge ? "Charged — receipt emailed" : r.emailed ? "Pay link emailed" : "Invoice created, but the email failed");
        if (!charge && !r.emailed && r.url) prompt("Pay link (copy and send it to the customer):", r.url);
        refresh();
      } else if (act === "sync-payment") {
        const r = await post("admin-sync-payment", { booking_id: id });
        toast(r.paid ? `Payment found — booking ${r.status}, ${String(r.payment_status).replace(/_/g, " ")}` : r.message);
        refresh(); render(currentView());
      } else if (act === "balance-link") {
        if (!confirm("Email the customer a Stripe pay link for the remaining balance (tax added by Stripe)?")) return;
        const r = await post("admin-collect-payment", { booking_id: id, action: "send_link" });
        toast(r.emailed ? `Pay link emailed (${money(r.amount_due_cents)})` : "Invoice created, but the email failed. Copy the link from Stripe."); refresh();
      } else if (act === "balance-charge") {
        if (!confirm("Charge the saved card for the remaining balance now?")) return;
        await post("admin-collect-payment", { booking_id: id, action: "charge_card" }); toast("Charged"); refresh();
      } else if (act === "record-weight") {
        const w = parseFloat(prompt("Scale weight in tons (e.g. 1.87):"));
        if (!(w >= 0)) return;
        const prev = await post("admin-record-weight", { booking_id: id, weight_tons: w });
        if (!prev.overage_cents) {
          await post("admin-record-weight", { booking_id: id, weight_tons: w, confirm: true });
          toast("Recorded — no overage"); refresh(); return;
        }
        if (!confirm(`Weight ${w} t, limit ${prev.limit_tons} t. Overage ${money(prev.overage_cents)} plus tax. Email the customer a pay link?`)) return;
        await post("admin-record-weight", { booking_id: id, weight_tons: w, confirm: true });
        toast("Overage invoice emailed"); refresh();
      } else if (act === "charge-overage") {
        if (!confirm("Charge the saved card for the overage now?")) return;
        await post("admin-charge-overage", { booking_id: id, action: "charge" }); toast("Charged"); refresh();
      } else if (act === "waive-overage") {
        if (!confirm("Waive this overage?")) return;
        await post("admin-charge-overage", { booking_id: id, action: "waive" }); toast("Waived"); refresh();
      } else if (act === "cash-approve") {
        await post("admin-approve-cash", { booking_id: id, decision: "approve" }); toast("Approved"); refresh();
      } else if (act === "cash-approve-collected") {
        await post("admin-approve-cash", { booking_id: id, decision: "approve", mark_collected: true }); toast("Approved + collected"); refresh();
      } else if (act === "cash-reject") {
        if (confirm("Reject this cash booking?")) { await post("admin-approve-cash", { booking_id: id, decision: "reject" }); toast("Rejected"); refresh(); }
      }
    } catch (e) { alert(e.message); }
  }));

  drawer.querySelectorAll("[data-remove]").forEach((btn) => guarded(btn, async () => {
    const tr = btn.closest("tr");
    const c = charges.find((x) => x.id === tr.dataset.charge);
    const msg = c.status === "invoiced" ? `Remove “${c.description}”? Its unpaid invoice / pay link is canceled; any other lines on it go back to “not billed”.` : `Remove “${c.description}”?`;
    if (!confirm(msg)) return;
    try { await post("admin-booking-charges", { booking_id: id, action: "remove", charge_id: c.id }); toast("Removed"); refresh(); } catch (e) { alert(e.message); }
  }));
  if ($("#ac-kind")) wireAddCharge(b);

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
let publicCfgPromise = null;
function publicCfg() {
  publicCfgPromise ??= fetch("/api/public-config").then((r) => r.json()).catch(() => ({}));
  return publicCfgPromise;
}

// "+ Add charge" presets: fee schedule items, per-mile, per-day and per-ton rates.
async function wireAddCharge(b) {
  const cfg = await publicCfg();
  const t = b.dumpster_types || {};
  const fees = cfg.feeSchedule || [];
  $("#ac-fee").innerHTML = fees.map((f, i) => `<option value="${i}">${esc(f.label)} (${f.from ? "from " : ""}${money(f.amount_cents)}${f.unit ? " / " + esc(f.unit) : ""})</option>`).join("") || "<option value=''>No fees in the fee schedule</option>";
  const set = (desc, qtyLabel, unitCents) => {
    $("#ac-desc").value = desc; $("#ac-qty-label").textContent = qtyLabel;
    $("#ac-qty").value = 1; $("#ac-unit").value = unitCents != null ? (unitCents / 100).toFixed(2) : "";
  };
  const apply = () => {
    const kind = $("#ac-kind").value;
    $("#ac-fee-wrap").hidden = kind !== "fee";
    if (kind === "fee") { const f = fees[+$("#ac-fee").value]; set(f ? f.label : "", f?.unit ? `Quantity (${f.unit})` : "Quantity", f?.amount_cents); }
    else if (kind === "mileage") set("Extra mileage", "Extra miles", cfg.distancePricing?.per_mile_cents ?? 185);
    else if (kind === "extra_days") set("Extra rental days", "Days", t.extra_day_fee_cents ?? null);
    else if (kind === "weight") set(`Weight overage${t.weight_limit_tons != null ? ` (limit ${t.weight_limit_tons} tons)` : ""}`, "Tons over the limit", t.overage_fee_cents ?? null);
    else set("", "Quantity", null);
  };
  $("#ac-kind").addEventListener("change", apply);
  $("#ac-fee").addEventListener("change", apply);
  apply();
}

// Invoice builder: price a quote / contractor request line by line. Saving confirms a
// pending request (reserves a container) and emails the itemized price; the pay link
// is sent next.
async function openInvoiceBuilder(b, charges, onDone) {
  const cfg = await publicCfg();
  const taxBps = b.tax_exempt ? 0 : (cfg.taxRateBps || 0);
  const t = b.dumpster_types || {};
  const typeName = t.name || "Booking";
  const draft = charges.filter((c) => c.stage === "initial" && ["draft", "invoiced"].includes(c.status));
  let lines = draft.length
    ? draft.map((c) => ({ kind: c.kind, description: c.description, quantity: Number(c.quantity), unit_cents: Math.abs(c.unit_cents), taxable: c.taxable }))
    : [
        { kind: "rental", description: `${typeName} ${b.start_date} to ${b.end_date}`, quantity: 1, unit_cents: Math.max(0, (b.subtotal_cents || 0) - (b.addon_cents || 0)), taxable: true },
        ...(b.addon_cents ? [{ kind: "custom", description: "Add-on items", quantity: 1, unit_cents: b.addon_cents, taxable: true }] : []),
        ...(b.distance_fee_cents ? [{ kind: "mileage", description: `Delivery mileage${b.distance_miles != null ? ` (${b.distance_miles} mi round trip)` : ""}`, quantity: 1, unit_cents: b.distance_fee_cents, taxable: true }] : []),
        ...(b.discount_cents ? [{ kind: "discount", description: b.contractor_id ? "Contractor pricing" : "Discount", quantity: 1, unit_cents: b.discount_cents, taxable: true }] : []),
      ];
  const fees = cfg.feeSchedule || [];
  const KINDS = [["rental", "Rental / service"], ["mileage", "Mileage"], ["extra_days", "Extra days"], ["weight", "Weight"], ["fee", "Fee"], ["custom", "Other"], ["discount", "Discount"]];
  const drawer = $("#drawer");
  drawer.innerHTML = `
    <button class="close" id="ib-close">×</button>
    <h2>Invoice — ${esc(b.reference)}</h2>
    <p class="hint">${esc(b.customer_name)} · ${esc(typeName)} · ${b.start_date} → ${b.end_date}${b.tax_exempt ? ' · <span class="badge b-confirmed">tax exempt</span>' : ""}${b.distance_miles != null ? ` · ${b.distance_miles} mi round trip` : ""}</p>
    ${(b.flags || []).includes("quote_requested") ? '<p class="hint">Saving confirms this request (reserves a container for those dates) and emails the customer the itemized price.</p>' : ""}
    <div id="ib-lines"></div>
    <div class="actions">
      <button class="btn btn-ghost btn-sm" id="ib-add" type="button">+ Line</button>
      ${fees.length ? `<select id="ib-fee"><option value="">+ Fee from schedule…</option>${fees.map((f, i) => `<option value="${i}">${esc(f.label)} (${money(f.amount_cents)})</option>`).join("")}</select>` : ""}
    </div>
    <div class="totals" id="ib-totals"></div>
    <div class="actions"><button class="btn btn-primary btn-sm" id="ib-save">${(b.flags || []).includes("quote_requested") ? "Save &amp; confirm booking" : "Save invoice"}</button>
      <button class="btn btn-ghost btn-sm" id="ib-cancel" type="button">Cancel</button></div>`;
  const read = () => {
    lines = [...drawer.querySelectorAll(".charge-row")].map((r) => ({
      kind: r.querySelector(".ib-kind").value, description: r.querySelector(".ib-desc").value.trim(),
      quantity: parseFloat(r.querySelector(".ib-qty").value) || 0, unit_cents: cents(r.querySelector(".ib-unit").value),
      taxable: r.querySelector(".ib-tax").checked,
    }));
  };
  const totals = () => {
    let sub = 0, tax = 0;
    for (const l of lines) {
      const amt = Math.round(l.quantity * (l.kind === "discount" ? -Math.abs(l.unit_cents) : Math.abs(l.unit_cents)));
      sub += amt; tax += l.taxable ? Math.round((amt * taxBps) / 10000) : 0;
    }
    $("#ib-totals").innerHTML = `Subtotal ${money(sub)} · Tax ${money(tax)}${taxBps ? ` (${(taxBps / 100).toFixed(2)}%)` : ""} · <strong>Total ${money(sub + tax)}</strong>`;
  };
  const draw = () => {
    $("#ib-lines").innerHTML = lines.map((l, i) => `
      <div class="charge-row" data-i="${i}">
        <select class="ib-kind">${KINDS.map(([k, label]) => `<option value="${k}" ${k === l.kind ? "selected" : ""}>${label}</option>`).join("")}</select>
        <input class="ib-desc" value="${esc(l.description)}" placeholder="Description">
        <input class="ib-qty" type="number" step="0.01" min="0" value="${l.quantity}" title="Quantity">
        <input class="ib-unit" type="number" step="0.01" min="0" value="${(Math.abs(l.unit_cents) / 100).toFixed(2)}" title="Each ($)">
        <label class="chk"><input type="checkbox" class="ib-tax" ${l.taxable ? "checked" : ""}> tax</label>
        <button class="btn btn-ghost btn-sm ib-del" type="button">×</button>
      </div>`).join("") || '<p class="muted">No lines.</p>';
    $("#ib-lines").querySelectorAll(".ib-del").forEach((x) => x.addEventListener("click", () => { read(); lines.splice(+x.closest(".charge-row").dataset.i, 1); draw(); }));
    totals();
  };
  $("#ib-lines").addEventListener("input", () => { read(); totals(); });
  $("#ib-add").addEventListener("click", () => { read(); lines.push({ kind: "custom", description: "", quantity: 1, unit_cents: 0, taxable: !b.tax_exempt }); draw(); });
  $("#ib-fee")?.addEventListener("change", (e) => {
    const f = fees[+e.target.value]; if (!f) return;
    read(); lines.push({ kind: "fee", description: f.label, quantity: 1, unit_cents: f.amount_cents, taxable: !b.tax_exempt }); e.target.value = ""; draw();
  });
  $("#ib-close").addEventListener("click", onDone);
  $("#ib-cancel").addEventListener("click", onDone);
  guarded($("#ib-save"), async () => {
    read();
    try {
      const r = await post("admin-booking-charges", { booking_id: b.id, action: "save_initial", lines: lines.filter((l) => l.description || l.unit_cents) });
      toast(r.confirmed ? "Booking confirmed — customer emailed the price" : "Invoice saved");
      if (confirm("Email the customer the secure pay link now?")) {
        const p = await post("admin-booking-charges", { booking_id: b.id, action: "pay_link" });
        toast(p.emailed ? "Pay link emailed" : "Link created, but the email failed");
        if (!p.emailed) prompt("Pay link (copy and send it to the customer):", p.url);
      }
      onDone(); render(currentView());
    } catch (e) { alert(e.message); }
  });
  draw();
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
    <h3>Weight limits &amp; overage ${isAdmin ? "" : "<span class='hint'>(read-only — admin edits)</span>"}</h3>
    <p class="hint">Weight included with each dumpster rental. When you record a scale weight on a booking, anything over the limit is billed at the per-ton rate (plus tax). Leave the limit blank for no overage.</p>
    <div id="weights"></div>
    <h3>Types &amp; pricing ${isAdmin ? "" : "<span class='hint'>(read-only — admin edits pricing)</span>"}</h3>
    <div id="types"></div>
    ${isAdmin ? `<button class="btn btn-ghost btn-sm" id="add-type">+ Add type</button> <button class="btn btn-ghost btn-sm" id="sync-stripe">Sync all to Stripe</button>` : ""}
    <details class="section-fold"><summary><h3>Units (physical containers)</h3></summary>
    <p class="hint">Types sharing the same "Equipment pool" label share physical containers for availability (e.g. Standard + Clean Green Waste roll-offs).</p>
    <div id="units"></div></details>
    <details class="section-fold" open><summary><h3>Add-on items</h3></summary>
    <p class="hint">Specialty items shown as checkboxes on junk-hauling bookings (mattress, appliance, access fees...).</p>
    <div id="addons"></div></details>`;

  const typeName = (id) => types.find((t) => t.id === id)?.name || "?";

  const renderWeights = () => {
    const rows = types.filter((t) => t.service === "dumpster" && t.active);
    const dis = isAdmin ? "" : "disabled";
    $("#weights").innerHTML = rows.length ? `<div class="table-wrap"><table class="table"><thead><tr>
        <th>Dumpster type</th><th>Included weight (tons)</th><th>Overage per ton ($)</th>${isAdmin ? "<th></th>" : ""}</tr></thead><tbody>
      ${rows.map((t) => `<tr data-id="${t.id}">
        <td>${esc(t.name)}</td>
        <td><input class="w-limit" type="number" step="0.1" min="0" placeholder="no limit" value="${t.weight_limit_tons ?? ""}" ${dis} style="max-width:110px"></td>
        <td><input class="w-fee" type="number" step="0.01" min="0" value="${(t.overage_fee_cents / 100).toFixed(2)}" ${dis} style="max-width:110px"></td>
        ${isAdmin ? `<td><button class="btn btn-primary btn-sm" data-save-weight>Save</button></td>` : ""}
      </tr>`).join("")}
      </tbody></table></div>` : '<p class="muted">No active dumpster types.</p>';
    if (isAdmin) $("#weights").querySelectorAll("[data-save-weight]").forEach((btn) => guarded(btn, async () => {
      const tr = btn.closest("tr");
      const lim = tr.querySelector(".w-limit").value.trim();
      try {
        await post("admin-inventory", { action: "update_weight", id: tr.dataset.id, weight_limit_tons: lim === "" ? null : parseFloat(lim), overage_fee_cents: cents(tr.querySelector(".w-fee").value || "0") });
        toast("Weight limit saved"); render("inventory");
      } catch (e) { alert(e.message); }
    }));
  };
  renderWeights();

  const renderTypes = () => {
    const SERVICE_TITLE = { dumpster: "Dumpster rentals", junk: "Junk hauling & crew jobs" };
    const ordered = [...types].sort((a, b) => (a.service === b.service ? 0 : a.service === "dumpster" ? -1 : 1));
    $("#types").innerHTML = ordered.map((t, idx) => `
      ${idx === 0 || ordered[idx - 1].service !== t.service ? `<h4 class="group-head">${SERVICE_TITLE[t.service] || esc(t.service)}</h4>` : ""}
      <details class="form type-card" data-id="${t.id}">
        <summary><strong>${esc(t.name)}</strong>
          <span class="muted">${t.pricing_mode === "quote_only" ? "starting at " : t.pricing_mode === "duration_tiers" ? "from " : ""}${money(t.base_price_cents)}</span>
          <span class="badge b-${t.active ? "confirmed" : "unpaid"}">${t.active ? "active" : "hidden"}</span>
          <span class="badge b-${t.stripe_sync_error ? "unpaid" : t.stripe_product_id ? "confirmed" : "pending"}" title="${esc(t.stripe_sync_error || "")}">${t.stripe_sync_error ? "Stripe: error" : t.stripe_product_id ? "in Stripe" : "not in Stripe"}</span></summary>
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
      </details>`).join("");

    if (isAdmin) $("#types").querySelectorAll("[data-save]").forEach((btn) => btn.addEventListener("click", async () => {
      const box = btn.closest(".form");
      const saved = await post("admin-inventory", {
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
      toast(saved.stripe_sync_error ? `Saved, but Stripe sync failed: ${saved.stripe_sync_error}` : "Type saved");
      sessionStorage.setItem("openType", box.dataset.id); render("inventory");
    }));
    if (isAdmin) $("#types").querySelectorAll("[data-add-tier]").forEach((btn) => btn.addEventListener("click", async () => {
      const typeId = btn.dataset.addTier;
      const box = btn.closest(".form");
      const days = +box.querySelector(".nt-days").value, price = box.querySelector(".nt-price").value, label = box.querySelector(".nt-label").value;
      if (!days || !price) return alert("Days and price are required.");
      const saved = await post("admin-inventory", { action: "upsert_tier", type_id: typeId, days, price_cents: cents(price), label: label || null, sort_order: days });
      toast(saved.stripe_sync_error ? `Saved, but Stripe sync failed: ${saved.stripe_sync_error}` : "Tier saved"); render("inventory");
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
  const reopen = sessionStorage.getItem("openType");
  if (reopen) { sessionStorage.removeItem("openType"); const d = $(`.type-card[data-id="${reopen}"]`); if (d) { d.open = true; d.scrollIntoView({ block: "center" }); } }

  if (isAdmin) $("#sync-stripe").addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      const r = await post("admin-stripe-sync", { scope: "all" });
      toast(r.failed.length ? `Synced ${r.ok}, ${r.failed.length} failed: ${r.failed[0].error}` : `Synced ${r.ok} items to Stripe`);
    } catch (err) { alert(err.message); }
    render("inventory");
  });
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
    const CAT_TITLE = { specialty: "Specialty items", appliance: "Appliances", access: "Access & carry", fee: "Fees" };
    const cats = ["specialty", "appliance", "access", "fee"];
    const card = (a) => `<div class="addon-card ${a.active ? "" : "off"}">
        <input class="a-name" data-id="${a.id}" value="${esc(a.name)}" ${isAdmin ? "" : "disabled"} aria-label="Name">
        <div class="addon-line">
          <label>$<input class="a-price" data-id="${a.id}" type="number" step="0.01" value="${(a.price_cents / 100).toFixed(2)}" ${isAdmin ? "" : "disabled"}></label>
          <select class="a-cat" data-id="${a.id}" ${isAdmin ? "" : "disabled"}>${cats.map((c) => `<option value="${c}" ${c === a.category ? "selected" : ""}>${CAT_TITLE[c]}</option>`).join("")}</select>
          <select class="a-active" data-id="${a.id}" ${isAdmin ? "" : "disabled"}><option value="true" ${a.active ? "selected" : ""}>On</option><option value="false" ${!a.active ? "selected" : ""}>Off</option></select>
        </div>
        ${isAdmin ? `<div class="addon-actions"><button class="btn btn-primary btn-sm a-save" data-id="${a.id}">Save</button> <button class="btn btn-ghost btn-sm a-del" data-id="${a.id}">Delete</button></div>` : ""}
      </div>`;
    $("#addons").innerHTML = cats.filter((c) => addons.some((a) => a.category === c)).map((c) => `
      <h4 class="group-head">${CAT_TITLE[c]}</h4>
      <div class="addon-grid">${addons.filter((a) => a.category === c).map(card).join("")}</div>`).join("") +
      (isAdmin ? `<div class="form" style="margin-top:12px"><div class="row three">
        <label>Name<input id="na-name"></label>
        <label>Category<select id="na-cat">${cats.map((c) => `<option value="${c}">${CAT_TITLE[c]}</option>`).join("")}</select></label>
        <label>Price ($)<input id="na-price" type="number" step="0.01"></label>
      </div><div class="actions"><button class="btn btn-primary btn-sm" id="na-add">+ Add add-on</button></div></div>` : "");
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
  const [{ blackouts: allBlackouts }, { types }, shiftRes] = await Promise.all([
    authFetch("admin-blackouts"), authFetch("admin-inventory"),
    me.role === "admin" ? authFetch("admin-shift-schedule") : Promise.resolve({ shift: null }),
  ]);
  const AUTO = "Owner on shift (auto)";
  const blackouts = allBlackouts.filter((b) => b.reason !== AUTO);
  const autoAll = allBlackouts.filter((b) => b.reason === AUTO && b.end_at.slice(0, 10) >= todayStr());
  const autoNext = autoAll.slice(0, 6);
  const shiftSaved = !!shiftRes.shift;
  const shift = shiftRes.shift || { enabled: true, anchor_date: "2026-10-06", on_days: 2, off_days: 4 };
  main.innerHTML = `
    <h2>Availability &amp; Blackouts</h2>
    <div id="ops-cal"></div>
    ${me.role === "admin" ? `<details class="section-fold"><summary><h3>Shift pattern (repeat for 12 months)</h3></summary><div class="form"><h3>Owner shift schedule</h3>
      ${!shiftSaved ? `<p style="background:#fde8e8;border:1px solid #d9a0a0;color:#7a1f1f;border-radius:4px;padding:8px 10px;margin:0 0 8px;font-size:.85rem"><strong>Not active yet.</strong> This pattern has never been saved, so customers can still book shift days. Check the dates and click Save below.</p>`
        : !autoAll.length && shift.enabled ? `<p style="background:#fde8e8;border:1px solid #d9a0a0;color:#7a1f1f;border-radius:4px;padding:8px 10px;margin:0 0 8px;font-size:.85rem"><strong>No upcoming shift blocks.</strong> Click Save below to rebuild them.</p>` : ""}
      <p class="hint">Shift days are blocked automatically for customers. Repeats forever on the pattern below. Change the first shift date any time his schedule moves, then save.</p>
      <div class="row three">
        <label>First shift day<input type="date" id="sh-anchor" value="${esc(shift.anchor_date)}"></label>
        <label>Days on<input type="number" id="sh-on" min="1" value="${shift.on_days}"></label>
        <label>Days off<input type="number" id="sh-off" min="0" value="${shift.off_days}"></label>
      </div>
      <div class="row two">
        <label>Apply the pattern starting from<input type="date" id="sh-from" value="${todayStr()}" min="${todayStr()}"></label>
        <label class="chk" style="align-self:end"><input type="checkbox" id="sh-enabled" ${shift.enabled ? "checked" : ""}> Block shift days</label>
      </div>
      <div class="actions"><button class="btn btn-primary btn-sm" id="sh-save">Save pattern &amp; rebuild from that date (12 months)</button></div>
      <p class="hint">Rebuilding replaces shift blocks from that date forward, including edits you made to them. Earlier blocks are kept.</p>
      <h3>Upcoming shift blocks</h3>
      <p class="hint">Schedule moved for just one shift? Edit or remove that block — nothing else changes.</p>
      <div class="table-wrap"><table class="table"><thead><tr><th>Start</th><th>End</th><th></th></tr></thead>
      <tbody id="auto-rows">${autoAll.slice(0, 12).map((b) => `<tr data-id="${b.id}" style="cursor:default"><td><input type="date" class="ab-start" value="${b.start_at.slice(0, 10)}"></td><td><input type="date" class="ab-end" value="${b.end_at.slice(0, 10)}"></td><td class="nowrap"><button class="btn btn-primary btn-sm" data-ab-save>Save</button> <button class="btn btn-ghost btn-sm" data-ab-del>Remove</button></td></tr>`).join("") || '<tr><td colspan="3" class="muted">None.</td></tr>'}</tbody></table></div>
      ${autoAll.length > 12 ? `<p class="hint">Showing the next 12 of ${autoAll.length}.</p>` : ""}
    </div></details>` : ""}
    <p class="hint">Blackout days have no deliveries or pickups — for holidays, shifts, full trucks, or maintenance. A rental can still run across them; customers just cannot start or end on one.</p>
    <div class="form"><h3>Add blackout</h3>
      <div class="row three">
        <label>Start<input type="date" id="bo-start"></label>
        <label>End<input type="date" id="bo-end"></label>
        <label>Applies to<select id="bo-type"><option value="">All types</option>${types.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select></label>
      </div>
      <label>Reason<input id="bo-reason" placeholder="e.g. Thanksgiving"></label>
      <div class="actions"><button class="btn btn-primary btn-sm" id="bo-add">Add blackout</button></div>
    </div>
    <h3>Your blackout days</h3><p class="hint">One-off days you block yourself (shift days above are handled automatically).</p>
    <div class="table-wrap"><table class="table"><thead><tr><th>Start</th><th>End</th><th>Scope</th><th>Reason</th><th></th></tr></thead>
    <tbody>${blackouts.map((b) => `<tr><td>${b.start_at.slice(0, 10)}</td><td>${b.end_at.slice(0, 10)}</td><td>${b.scope === "all" ? "All" : (types.find((t) => t.id === b.type_id)?.name || "type")}</td><td>${esc(b.reason || "")}</td><td><button class="btn btn-ghost btn-sm" data-del="${b.id}">Del</button></td></tr>`).join("") || '<tr><td class="muted" colspan="5">None.</td></tr>'}</tbody></table></div>`;
  mountOpsCalendar($("#ops-cal"), allBlackouts);

  if (me.role === "admin") guarded($("#sh-save"), async () => {
    try {
      const r = await post("admin-shift-schedule", { enabled: $("#sh-enabled").checked, anchor_date: $("#sh-anchor").value, on_days: +$("#sh-on").value, off_days: +$("#sh-off").value, from_date: $("#sh-from").value });
      toast(`Shift days saved (${r.created} blocks)`); render("availability");
    } catch (e) { alert(e.message); }
  });
  main.querySelectorAll("#auto-rows tr[data-id]").forEach((tr) => {
    guarded(tr.querySelector("[data-ab-save]"), async () => {
      const a = tr.querySelector(".ab-start").value, b = tr.querySelector(".ab-end").value;
      if (!a || !b || b < a) return alert("Pick a start and an end on or after it.");
      try { await post("admin-blackouts", { action: "update", id: tr.dataset.id, start_at: `${a}T00:00:00Z`, end_at: `${b}T23:59:59Z` }); toast("Shift block updated"); render("availability"); } catch (e) { alert(e.message); }
    });
    guarded(tr.querySelector("[data-ab-del]"), async () => {
      if (!confirm("Remove this shift block? Customers will be able to book those days.")) return;
      await post("admin-blackouts", { action: "delete", id: tr.dataset.id }); toast("Removed"); render("availability");
    });
  });
  $("#bo-add").addEventListener("click", async () => {
    const start = $("#bo-start").value, end = $("#bo-end").value;
    if (!start || !end) return alert("Pick start and end.");
    if (end < start) return alert("End must be on or after start.");
    try {
      await post("admin-blackouts", { start_at: `${start}T00:00:00Z`, end_at: `${end}T23:59:59Z`, type_id: $("#bo-type").value || null, reason: $("#bo-reason").value });
      toast("Blackout added"); render("availability");
    } catch (e) { alert(e.message); }
  });
  main.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => { await post("admin-blackouts", { action: "delete", id: b.dataset.del }); render("availability"); }));
};

// ---------- operations calendar (Availability tab) ----------
// Month grid: owner shift days and closed days highlighted, every booking's
// drop-off (🗑️🟢) and pickup (🛑) placed from its dates, junk jobs (🚚) on their day.
// Click a day to block / unblock it; click a booking to open it.
const SHIFT_REASON = "Owner on shift (auto)";
const MONTH_LABELS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const addDaysStr = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
let opsView = null;

function mountOpsCalendar(box, blackouts) {
  const canEdit = me.role === "admin" || me.role === "staff";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  if (!opsView) opsView = { y: +today.slice(0, 4), m: +today.slice(5, 7) };
  let mode = "shift";
  try { mode = sessionStorage.getItem("opsMode") || "shift"; } catch {}

  const draw = async () => {
    const { y, m } = opsView;
    const mm = String(m).padStart(2, "0");
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const first = `${y}-${mm}-01`, last = `${y}-${mm}-${String(days).padStart(2, "0")}`;
    box.innerHTML = `<p class="muted">Loading calendar…</p>`;
    let bookings = [];
    try { ({ bookings } = await authFetch(`admin-bookings?range_from=${first}&range_to=${last}`)); }
    catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }

    const blockFor = (d) => blackouts.find((b) => b.start_at.slice(0, 10) <= d && b.end_at.slice(0, 10) >= d);
    const chip = (b, kind) => {
      const icon = kind === "drop" ? "🗑️🟢" : kind === "pick" ? "🛑" : "🚚";
      const label = kind === "drop" ? "Drop-off" : kind === "pick" ? "Pickup" : "Job";
      return `<button type="button" class="ops-chip ops-${kind}" data-bk="${b.id}" title="${label}: ${esc(b.customer_name)} · ${esc(b.reference)} · ${esc(b.delivery_address || "")}">${icon} ${esc(String(b.customer_name).split(" ")[0])}</button>`;
    };

    let cells = "";
    const offset = new Date(first + "T00:00:00Z").getUTCDay();
    for (let i = 0; i < offset; i++) cells += `<div class="ops-cell ops-blank"></div>`;
    for (let d = 1; d <= days; d++) {
      const ds = `${y}-${mm}-${String(d).padStart(2, "0")}`;
      const bl = blockFor(ds);
      const isShift = bl && bl.reason === SHIFT_REASON;
      const chips = [];
      let truckDay = false;
      for (const b of bookings) {
        if (b.service === "junk") {
          if (b.start_date <= ds && b.end_date >= ds) { chips.push(chip(b, "job")); truckDay = true; }
          continue;
        }
        if (b.start_date === ds) { chips.push(chip(b, "drop")); truckDay = true; }
        if (b.end_date === ds) { chips.push(chip(b, "pick")); truckDay = true; }
      }
      const conflict = bl && truckDay;
      cells += `<div class="ops-cell${isShift ? " ops-shift" : bl ? " ops-closed" : ""}${ds === today ? " ops-today" : ""}${conflict ? " ops-conflict" : ""}${canEdit ? " ops-editable" : ""}" data-day="${ds}">
        <div class="ops-day"><span>${d}</span>${bl ? `<span class="ops-tag">${isShift ? "Shift" : esc(bl.reason || "Closed")}</span>` : ""}</div>
        ${conflict ? `<div class="ops-warn" title="A drop-off or pickup is scheduled on a blocked day">⚠ truck needed</div>` : ""}
        <div class="ops-chips">${chips.join("")}</div>
      </div>`;
    }

    box.innerHTML = `
      <div class="ops-cal">
        <div class="ops-head">
          <button type="button" class="btn btn-ghost btn-sm" data-ops-nav="-1" aria-label="Previous month">‹</button>
          <strong>${MONTH_LABELS[m - 1]} ${y}</strong>
          <button type="button" class="btn btn-ghost btn-sm" data-ops-nav="1" aria-label="Next month">›</button>
          <button type="button" class="btn btn-ghost btn-sm" data-ops-today>Today</button>
        </div>
        ${canEdit ? `<div class="ops-mode">Click a day to:
          <label class="chk"><input type="radio" name="ops-mode" value="shift" ${mode === "shift" ? "checked" : ""}> mark / unmark a <strong>shift day</strong></label>
          <label class="chk"><input type="radio" name="ops-mode" value="closed" ${mode === "closed" ? "checked" : ""}> mark / unmark <strong>closed</strong> (holiday, truck down)</label>
        </div>` : ""}
        <div class="ops-grid ops-weekdays">${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((w) => `<div>${w}</div>`).join("")}</div>
        <div class="ops-grid">${cells}</div>
        <div class="ops-legend">
          <span><span class="ops-sw ops-shift"></span> Owner on shift</span>
          <span><span class="ops-sw ops-closed"></span> Closed</span>
          <span>🗑️🟢 Drop-off</span><span>🛑 Pickup</span><span>🚚 Junk / crew job</span>
          <span>⚠ Drop-off or pickup on a blocked day</span>
        </div>
        <p class="hint">Customers cannot start or end a rental on a shift or closed day. Changes here apply immediately.</p>
      </div>`;

    box.querySelectorAll("[data-ops-nav]").forEach((b) => b.addEventListener("click", () => {
      const n = opsView.m + Number(b.dataset.opsNav);
      opsView = n < 1 ? { y: opsView.y - 1, m: 12 } : n > 12 ? { y: opsView.y + 1, m: 1 } : { y: opsView.y, m: n };
      draw();
    }));
    box.querySelector("[data-ops-today]").addEventListener("click", () => { opsView = { y: +today.slice(0, 4), m: +today.slice(5, 7) }; draw(); });
    box.querySelectorAll('input[name="ops-mode"]').forEach((r) => r.addEventListener("change", () => {
      mode = r.value; try { sessionStorage.setItem("opsMode", mode); } catch {}
    }));
    box.querySelectorAll("[data-bk]").forEach((c) => c.addEventListener("click", (e) => { e.stopPropagation(); openBooking(c.dataset.bk); }));
    if (canEdit) box.querySelectorAll(".ops-cell[data-day]").forEach((cell) => cell.addEventListener("click", async () => {
      const day = cell.dataset.day;
      const bl = blockFor(day);
      try {
        if (bl) {
          const what = bl.reason === SHIFT_REASON ? "shift day" : `closed day (${bl.reason || "Closed"})`;
          if (!confirm(`Unblock ${day}? It is a ${what}. Customers will be able to schedule drop-offs and pickups that day.`)) return;
          await unblockDay(bl, day);
          toast(`${day} unblocked`);
        } else {
          const reason = mode === "shift" ? SHIFT_REASON : prompt(`Close ${day}. Reason:`, "Closed");
          if (reason === null) return;
          await post("admin-blackouts", { start_at: `${day}T00:00:00Z`, end_at: `${day}T23:59:59Z`, type_id: null, reason: reason || "Closed" });
          toast(mode === "shift" ? `${day} marked as shift day` : `${day} closed`);
        }
        ({ blackouts } = await authFetch("admin-blackouts"));
        draw();
      } catch (e) { alert(e.message); }
    }));
  };
  draw();
}

// Remove one day from a blackout block: delete it, trim an end, or split it in two.
async function unblockDay(bl, day) {
  const a = bl.start_at.slice(0, 10), b = bl.end_at.slice(0, 10);
  if (a === day && b === day) return post("admin-blackouts", { action: "delete", id: bl.id });
  if (a === day) return post("admin-blackouts", { action: "update", id: bl.id, start_at: `${addDaysStr(day, 1)}T00:00:00Z`, end_at: bl.end_at });
  if (b === day) return post("admin-blackouts", { action: "update", id: bl.id, start_at: bl.start_at, end_at: `${addDaysStr(day, -1)}T23:59:59Z` });
  await post("admin-blackouts", { action: "update", id: bl.id, start_at: bl.start_at, end_at: `${addDaysStr(day, -1)}T23:59:59Z` });
  await post("admin-blackouts", { start_at: `${addDaysStr(day, 1)}T00:00:00Z`, end_at: bl.end_at, type_id: bl.type_id, reason: bl.reason });
}

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
    <p class="hint">Saving publishes a new version. Existing signed bookings keep the version (and language) they agreed to. Customers can switch between English and Spanish while signing.</p>
    <div class="form">
      <div class="lang-tabs"><button class="btn btn-sm btn-primary" data-lang="en">English</button><button class="btn btn-sm btn-ghost" data-lang="es">Español</button></div>
      <div data-pane="en">
        <label>Title<input id="a-title" value="${esc(active.title)}"></label>
        <span class="field-label">Agreement text</span>
        ${wysiwygHtml("a-body-en")}
      </div>
      <div data-pane="es" hidden>
        <label>Título<input id="a-title-es" value="${esc(active.title_es || "")}"></label>
        <span class="field-label">Texto del contrato</span>
        ${wysiwygHtml("a-body-es")}
        <p class="hint">${active.body_html_es ? "If you change the English text, update this Spanish text to match before publishing." : "No Spanish version yet. Customers will see English only until you add one."}</p>
      </div>
      <div class="actions" style="margin-top:12px"><button class="btn btn-primary btn-sm" id="a-save">Publish new version</button></div>
      <p class="hint">Current active version: v${active.version || "—"}</p>
    </div>`;
  const en = wysiwygMount("a-body-en", active.body_html);
  const es = wysiwygMount("a-body-es", active.body_html_es || "");
  main.querySelectorAll("[data-lang]").forEach((btn) => btn.addEventListener("click", () => {
    main.querySelectorAll("[data-lang]").forEach((x) => { x.classList.toggle("btn-primary", x === btn); x.classList.toggle("btn-ghost", x !== btn); });
    main.querySelectorAll("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== btn.dataset.lang));
  }));
  guarded($("#a-save"), async () => {
    if (!en.getHtml().trim()) return alert("English text is required.");
    await post("admin-agreement-template", {
      title: $("#a-title").value, body_html: en.getHtml(),
      title_es: $("#a-title-es").value || undefined, body_html_es: es.getHtml().trim() ? es.getHtml() : undefined,
    });
    toast("Published"); render("agreement");
  });
};

// ---------- minimal WYSIWYG (contenteditable + toolbar; no dependencies) ----------
function wysiwygHtml(id) {
  const btn = (cmd, label, arg = "") => `<button type="button" class="btn btn-ghost btn-sm" data-cmd="${cmd}" data-arg="${arg}" title="${cmd}">${label}</button>`;
  return `<div class="wysiwyg" id="${id}">
    <div class="wysiwyg-bar">
      ${btn("bold", "<b>B</b>")}${btn("italic", "<i>I</i>")}${btn("underline", "<u>U</u>")}
      ${btn("formatBlock", "H3", "h3")}${btn("formatBlock", "Paragraph", "p")}
      ${btn("insertUnorderedList", "• List")}${btn("insertOrderedList", "1. List")}
      ${btn("createLink", "Link")}${btn("removeFormat", "Clear")}${btn("undo", "↶")}${btn("redo", "↷")}
      <button type="button" class="btn btn-ghost btn-sm" data-src>&lt;/&gt; HTML</button>
    </div>
    <div class="wysiwyg-area" contenteditable="true"></div>
    <textarea class="wysiwyg-src" rows="14" hidden></textarea>
  </div>`;
}
function wysiwygMount(id, html) {
  const root = document.getElementById(id);
  const area = root.querySelector(".wysiwyg-area"), src = root.querySelector(".wysiwyg-src");
  area.innerHTML = html || "";
  let srcMode = false;
  root.querySelectorAll("[data-cmd]").forEach((b) => b.addEventListener("mousedown", (e) => {
    e.preventDefault(); // keep the selection in the editor
    if (srcMode) return;
    let arg = b.dataset.arg || null;
    if (b.dataset.cmd === "createLink") { arg = prompt("Link address (https://…):"); if (!arg) return; }
    document.execCommand(b.dataset.cmd, false, arg);
  }));
  root.querySelector("[data-src]").addEventListener("click", () => {
    srcMode = !srcMode;
    if (srcMode) src.value = area.innerHTML; else area.innerHTML = src.value;
    src.hidden = !srcMode; area.hidden = srcMode;
  });
  return {
    getHtml: () => (srcMode ? src.value : area.innerHTML),
    setHtml: (h) => { area.innerHTML = h; src.value = h; },
  };
}

// ==================================================================
//  SETTINGS (admin)
// ==================================================================
views.settings = async (main) => {
  const { settings: s } = await authFetch("admin-settings");
  const v = (k, d = "") => s[k] ?? d;
  main.innerHTML = `
    <h2>Settings</h2>
    ${me.role === "admin" ? `<div class="form"><h3>Google Calendar</h3>
      <p class="hint">Confirmed bookings appear in green. Requests waiting on you (quote requests, cash bookings to approve, paid bookings with no container free) appear in yellow as "⏳ PENDING" and update when you confirm or cancel them.</p>
      <div class="actions">
        <button class="btn btn-ghost btn-sm" id="gc-test">Test Google Calendar</button>
        <button class="btn btn-ghost btn-sm" id="gc-backfill">Put all upcoming bookings on the calendar</button>
      </div>
      <p class="hint" id="gc-msg"></p>
    </div>` : ""}
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

    <h3>Delivery distance (from the yard)</h3>
    <p class="hint">Driving miles from the yard to the job address are measured with Google Maps at booking. Inside the free radius is included; past it, every mile is billed at the per-mile rate (round trip counts the miles out and back). Past the online limit, the customer is asked to call for a quote.</p>
    <div class="form">
      <label>Yard address<input id="dp-hub" value="${esc(dp().hub_address || "1725 County Road 269, Leander, TX 78641")}"></label>
      <div class="row three">
        <label>Free radius (miles, one way)<input id="dp-free" type="number" step="0.1" value="${esc(dp().free_radius_miles ?? 15)}"></label>
        <label>Per mile ($)<input id="dp-rate" type="number" step="0.01" value="${esc(((dp().per_mile_cents ?? 185) / 100).toFixed(2))}"></label>
        <label>Online limit (miles, one way)<input id="dp-max" type="number" step="0.1" value="${esc(dp().max_oneway_miles ?? 35)}"></label>
      </div>
      <label>Bill miles<select id="dp-rt"><option value="true" ${dp().round_trip !== false ? "selected" : ""}>Round trip (out and back)</option><option value="false" ${dp().round_trip === false ? "selected" : ""}>One way</option></select></label>
      <div class="row two">
        <label>Test an address<input id="dp-test-addr" placeholder="Job address"></label>
        <div class="actions" style="align-self:end"><button class="btn btn-ghost btn-sm" id="dp-test" type="button">Calculate</button></div>
      </div>
      <p class="hint" id="dp-msg"></p>
      <div class="actions"><button class="btn btn-primary btn-sm" id="dp-save">Save distance pricing</button></div>
    </div>

    <h3>Fallback distance zones</h3>
    <p class="hint">Only used if Google Maps is not set up (no GOOGLE_MAPS_API_KEY): the customer then picks how far the job is.</p>
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

    <h3>Fee schedule <span class="hint">(shown to customers on the website under “Fees &amp; Policies”)</span></h3>
    <div class="form">
      <div id="fee-list"></div>
      <div class="actions"><button class="btn btn-ghost btn-sm" id="fee-add" type="button">+ Add fee</button><button class="btn btn-primary btn-sm" id="fee-save" type="button">Save fee schedule</button><span class="hint" id="fee-dirty" hidden style="color:#c0392b">Unsaved changes — click Save fee schedule</span></div>
      <p class="hint">“From” shows as “from $X” on the website. Unit is optional (e.g. “ton”, “day”). Details appear in the Details column on the website. Remove takes effect on the website right away.</p>
    </div>

    <h3>“How did you hear about us?” choices</h3>
    <div class="form">
      <textarea id="s-sources" rows="6">${esc((v("referral_sources", []) || []).join("\n"))}</textarea>
      <p class="hint">One per line. Shown as a dropdown in online booking and phone-quote entry.</p>
      <div class="actions"><button class="btn btn-ghost btn-sm" id="s-sources-save">Save</button></div>
    </div>`;

  if (me.role === "admin") {
    const gcMsg = (ok, text) => { const m = $("#gc-msg"); m.textContent = text; m.style.color = ok ? "#1e7a34" : "#c0392b"; };
    guarded($("#gc-test"), async () => {
      try { const r = await post("admin-calendar", { action: "test" }); gcMsg(r.ok, r.ok ? r.message : r.error); }
      catch (e) { gcMsg(false, e.message); }
    });
    guarded($("#gc-backfill"), async () => {
      try {
        const r = await post("admin-calendar", { action: "backfill" });
        gcMsg(r.ok, r.error || `${r.synced} booking(s) synced to Google Calendar${r.failed ? `, ${r.failed} failed (flagged calendar_failed)` : ""}.`);
      } catch (e) { gcMsg(false, e.message); }
    });
  }

  // seed the editor from the saved list, or from the legacy reference values on first use
  const FEE_LABELS = { dry_run_or_inaccessible_cents: "Dry run / blocked access", late_cancellation_lt24h_cents: "Late cancellation (under 24 hrs)", truck_already_dispatched_cents: "Cancel after truck dispatched", overfill_rearrangement_from_cents: "Overfill / rearrange load", long_carry_from_cents: "Long carry", stairs_from_cents: "Stairs", multi_floor_heavy_furniture_from_cents: "Multi-floor heavy furniture", same_day_priority_from_cents: "Same-day priority", after_hours_from_cents: "After-hours service" };
  let fees = Array.isArray(s.fee_schedule) ? s.fee_schedule : Object.entries(v("fee_schedule_reference", {}) || {})
    .filter(([k, x]) => typeof x === "number" && k.endsWith("_cents"))
    .map(([k, x]) => ({ label: FEE_LABELS[k] || k.replace(/_/g, " "), amount_cents: x, from: k.includes("_from_"), unit: "", note: "" }));
  const drawFees = () => {
    $("#fee-list").innerHTML = fees.map((f, i) => `
      <div class="fee-row" data-i="${i}">
        <input class="fe-label" value="${esc(f.label)}" placeholder="Fee name">
        <input class="fe-amt" type="number" step="0.01" value="${(f.amount_cents / 100).toFixed(2)}" title="Amount ($)">
        <label class="chk"><input class="fe-from" type="checkbox" ${f.from ? "checked" : ""}> from</label>
        <input class="fe-unit" value="${esc(f.unit || "")}" placeholder="unit (ton, day…)">
        <button class="btn btn-ghost btn-sm fe-del" type="button">Remove</button>
        <textarea class="fe-note" rows="2" placeholder="Details shown to customers (optional), e.g. when this fee applies">${esc(f.note || "")}</textarea>
      </div>`).join("") || '<p class="muted">No fees yet.</p>';
    $("#fee-list").querySelectorAll(".fe-del").forEach((b) => b.addEventListener("click", async () => {
      const row = b.closest(".fee-row");
      const label = row.querySelector(".fe-label").value.trim() || "this fee";
      if (!confirm(`Remove “${label}” from the website fee schedule?`)) return;
      syncFees();
      fees.splice(+row.dataset.i, 1);
      drawFees();
      await saveFees(`Removed “${label}” — website updated`);
    }));
  };
  const setDirty = (on) => { $("#fee-dirty").hidden = !on; };
  const saveFees = async (msg) => {
    syncFees();
    await post("admin-settings", { settings: { fee_schedule: fees.filter((f) => f.label) } });
    setDirty(false);
    toast(msg);
  };
  $("#fee-list").addEventListener("input", () => setDirty(true));
  const syncFees = () => {
    fees = [...$("#fee-list").querySelectorAll(".fee-row")].map((r) => ({
      label: r.querySelector(".fe-label").value.trim(), amount_cents: cents(r.querySelector(".fe-amt").value),
      from: r.querySelector(".fe-from").checked, unit: r.querySelector(".fe-unit").value.trim(), note: r.querySelector(".fe-note").value.trim(),
    }));
  };
  drawFees();
  $("#fee-add").addEventListener("click", () => { syncFees(); fees.push({ label: "", amount_cents: 0, from: false, unit: "", note: "" }); drawFees(); setDirty(true); });
  guarded($("#fee-save"), () => saveFees("Fee schedule saved — live on the website"));
  guarded($("#s-sources-save"), async () => {
    await post("admin-settings", { settings: { referral_sources: $("#s-sources").value.split("\n").map((x) => x.trim()).filter(Boolean) } });
    toast("Saved");
  });

  function zones() { return v("distance_zones", []) || []; }
  function dp() { return v("distance_pricing", {}) || {}; }

  $("#dp-save").addEventListener("click", async () => {
    const distance_pricing = {
      hub_address: $("#dp-hub").value.trim(),
      free_radius_miles: Number($("#dp-free").value), per_mile_cents: cents($("#dp-rate").value),
      max_oneway_miles: Number($("#dp-max").value), round_trip: $("#dp-rt").value === "true",
    };
    if (!distance_pricing.hub_address) return alert("Enter the yard address.");
    await post("admin-settings", { settings: { distance_pricing } });
    toast("Distance pricing saved — live on the website");
  });
  guarded($("#dp-test"), async () => {
    const m = $("#dp-msg");
    try {
      const r = await fetch("/api/distance-quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: $("#dp-test-addr").value }) })
        .then(async (x) => { const d = await x.json(); if (!x.ok) throw new Error(d.error || "Failed"); return d; });
      m.textContent = r.configured === false ? "Google Maps is not set up yet (add GOOGLE_MAPS_API_KEY in Netlify)."
        : `${r.oneway_miles} mi one way · ${r.round_trip_miles} mi round trip · ${r.billable_miles} billable mi · mileage ${money(r.fee_cents)}${r.quote_only ? " · past the online limit (call for quote)" : ""}. Uses saved settings.`;
    } catch (e) { m.textContent = e.message; }
  });

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
};

// ==================================================================
//  CUSTOMERS (high-level tracker, derived from bookings)
// ==================================================================
views.customers = async (main) => {
  const { customers } = await authFetch("admin-customers");
  const total = customers.reduce((s, c) => s + c.spend_cents, 0);
  const repeat = customers.filter((c) => c.bookings > 1).length;
  main.innerHTML = `
    <h2>Customers</h2>
    <div class="kpi-row">
      <div class="kpi"><div class="n">${customers.length}</div><div class="l">Customers</div></div>
      <div class="kpi"><div class="n">${repeat}</div><div class="l">Repeat customers</div></div>
      <div class="kpi"><div class="n">${customers.filter((c) => c.contractor).length}</div><div class="l">Contractors</div></div>
      <div class="kpi"><div class="n">${money(total)}</div><div class="l">Collected</div></div>
    </div>
    <div class="toolbar"><input class="grow" id="cu-q" placeholder="Search name, email, phone"></div>
    <div id="cu-list"></div>`;
  const draw = () => {
    const q = $("#cu-q").value.trim().toLowerCase();
    const rows = customers.filter((c) => !q || [c.name, c.email, c.phone].some((x) => String(x || "").toLowerCase().includes(q)));
    $("#cu-list").innerHTML = rows.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Customer</th><th>Contact</th><th>Jobs</th><th>Collected</th><th>First</th><th>Last</th><th>Heard about us</th></tr></thead><tbody>
      ${rows.map((c) => `<tr data-q="${esc(c.email || c.phone)}"><td><strong>${esc(c.name)}</strong>${c.contractor ? ' <span class="badge b-confirmed">contractor</span>' : ""}${c.bookings > 1 ? ' <span class="badge b-scheduled">repeat</span>' : ""}</td>
        <td>${esc(c.phone)}<br><span class="muted">${esc(c.email)}</span></td><td>${c.bookings}</td><td>${money(c.spend_cents)}</td>
        <td>${esc(c.first_booking)}</td><td>${esc(c.last_booking)}</td><td>${esc(c.referral_source || "—")}</td></tr>`).join("")}
    </tbody></table></div>` : `<div class="empty">No customers yet.</div>`;
    // click a customer -> Bookings list filtered to them
    $("#cu-list").querySelectorAll("tr[data-q]").forEach((tr) => tr.addEventListener("click", () => {
      document.querySelector('#admin-nav a[data-view="bookings"]').click();
      setTimeout(() => { const f = $("#f-q"); if (f) { f.value = tr.dataset.q; $("#f-go").click(); } }, 400);
    }));
  };
  $("#cu-q").addEventListener("input", draw);
  draw();
};

// ==================================================================
//  CONTRACTORS (signups, approval, numbers)
// ==================================================================
views.contractors = async (main) => {
  const data = await authFetch("admin-contractors");
  const { contractors, quotes, queue_bookings: queueBookings } = data;
  const pending = contractors.filter((c) => c.status === "pending");
  const openQuotes = quotes.filter((q) => ["new", "contacted"].includes(q.status));
  const queueCount = pending.length + queueBookings.length + openQuotes.length;
  setQueueBadge(queueCount);
  const byId = new Map(contractors.map((c) => [c.id, c]));
  const who = (id) => { const c = byId.get(id); return c ? `${esc(c.company_name)}${c.contractor_number ? ` · ${esc(c.contractor_number)}` : ""} ${contractorBadge(c.status)}` : '<span class="muted">—</span>'; };
  const tab = main.dataset.tab || "queue";

  main.innerHTML = `
    <h2>Contractors</h2>
    <div class="tabs" role="tablist">
      <button class="tab ${tab === "queue" ? "active" : ""}" data-tab="queue">Queue${queueCount ? ` <span class="count">${queueCount}</span>` : ""}</button>
      <button class="tab ${tab === "accounts" ? "active" : ""}" data-tab="accounts">Accounts (${contractors.length})</button>
    </div>
    <div id="ct-body"></div>`;
  main.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => { main.dataset.tab = b.dataset.tab; views.contractors(main); }));
  const body = $("#ct-body");

  if (tab === "queue") {
    body.innerHTML = `
      <p class="hint">Everything from contractors waiting on you: new applications to verify, booking requests to price and confirm, and quote requests.</p>
      <h3>Applications to verify (${pending.length})</h3>
      ${pending.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Company</th><th>Contact</th><th>Verification info</th><th>Applied</th><th></th></tr></thead><tbody>
        ${pending.map((c) => `<tr data-cid="${c.id}">
          <td><strong>${esc(c.company_name)}</strong></td>
          <td>${esc(c.contact_name)}<br><span class="muted">${esc(c.phone)}<br>${esc(c.email)}</span></td>
          <td>${esc(c.license_info || "—")}</td><td>${new Date(c.created_at).toLocaleDateString()}</td>
          <td class="nowrap"><button class="btn btn-primary btn-sm" data-st="approved">Approve</button> <button class="btn btn-ghost btn-sm" data-st="rejected">Reject</button></td>
        </tr>`).join("")}</tbody></table></div>` : '<div class="empty">No applications waiting.</div>'}
      <h3>Booking requests to price &amp; confirm (${queueBookings.length})</h3>
      <p class="hint">Open one and use “Build invoice &amp; confirm” to set the contractor price and send the pay link.</p>
      ${queueBookings.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Ref</th><th>Contractor</th><th>Item</th><th>Dates</th><th>Estimate</th></tr></thead><tbody>
        ${queueBookings.map((b) => `<tr data-id="${b.id}"><td><strong>${esc(b.reference)}</strong></td>
          <td>${who(b.contractor_id)}<br><span class="muted">${esc(b.customer_name)} · ${esc(b.customer_phone)}</span></td>
          <td>${esc(b.dumpster_types?.name || "")}</td><td>${b.start_date}${b.end_date !== b.start_date ? ` → ${b.end_date}` : ""}</td><td>${money(b.amount_total_cents)}</td></tr>`).join("")}
        </tbody></table></div>` : '<div class="empty">No contractor booking requests.</div>'}
      <h3>Quote requests (${openQuotes.length})</h3>
      ${openQuotes.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Contact</th><th>Contractor</th><th>Service / address</th><th>Status</th><th></th></tr></thead><tbody>
        ${openQuotes.map((q) => `<tr data-qid="${q.id}"><td>${esc(q.name)}<br><span class="muted">${esc(q.phone)} · ${esc(q.email)}</span></td>
          <td>${who(q.contractor_id)}</td><td>${esc(q.service || "")}<br><span class="muted">${esc(q.delivery_address || "")}</span>${q.details ? `<br><span class="muted">${esc(q.details.slice(0, 140))}</span>` : ""}</td>
          <td>${badge(q.status)}</td>
          <td class="nowrap"><button class="btn btn-primary btn-sm" data-qact="book">Create booking</button> <button class="btn btn-ghost btn-sm" data-qact="contacted">Mark contacted</button> <button class="btn btn-ghost btn-sm" data-qact="closed">Close</button></td></tr>`).join("")}
        </tbody></table></div>` : '<div class="empty">No open contractor quote requests.</div>'}`;
    body.querySelectorAll("tr[data-id]").forEach((tr) => tr.addEventListener("click", () => openBooking(tr.dataset.id)));
    body.querySelectorAll("tr[data-cid]").forEach((tr) => tr.addEventListener("click", (e) => { if (!e.target.closest("button")) openContractor(tr.dataset.cid, () => views.contractors(main)); }));
    body.querySelectorAll("[data-st]").forEach((b) => guarded(b, async () => {
      const id = b.closest("tr").dataset.cid;
      if (b.dataset.st === "rejected" && !confirm("Reject this contractor application?")) return;
      try {
        const r = await post("admin-contractors", { id, status: b.dataset.st });
        toast(b.dataset.st === "approved" ? `Approved — number ${r.contractor.contractor_number} emailed` : "Rejected");
        views.contractors(main);
      } catch (e) { alert(e.message); }
    }));
    body.querySelectorAll("[data-qact]").forEach((b) => guarded(b, async () => {
      const q = quotes.find((x) => x.id === b.closest("tr").dataset.qid);
      try {
        if (b.dataset.qact === "book") return openNewBookingForm(null, () => views.contractors(main), { quote: q, contractor: byId.get(q.contractor_id) });
        await post("admin-quotes", { id: q.id, status: b.dataset.qact });
        toast("Updated"); views.contractors(main);
      } catch (e) { alert(e.message); }
    }));
    return;
  }

  // ---- accounts ----
  body.innerHTML = `
    <div class="toolbar"><input class="grow" id="ct-search" placeholder="Search contractor number, phone, email or company"></div>
    <div id="ct-list"></div>`;
  const draw = () => {
    const q = $("#ct-search").value.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, "");
    const rows = contractors.filter((c) => !q
      || (c.contractor_number || "").toLowerCase().includes(q)
      || c.email.toLowerCase().includes(q)
      || c.company_name.toLowerCase().includes(q) || c.contact_name.toLowerCase().includes(q)
      || (qDigits.length >= 3 && (c.phone_digits || "").includes(qDigits)));
    $("#ct-list").innerHTML = `<div class="table-wrap"><table class="table"><thead><tr><th>Number</th><th>Company</th><th>Contact</th><th>Status</th><th>Tax</th><th>Quotes</th><th>Jobs</th><th>Spend</th></tr></thead><tbody>
      ${rows.map((c) => `<tr data-cid="${c.id}">
        <td><strong>${esc(c.contractor_number || "—")}</strong></td><td>${esc(c.company_name)}</td>
        <td>${esc(c.contact_name)}<br><span class="muted">${esc(c.phone)}<br>${esc(c.email)}</span></td>
        <td>${contractorBadge(c.status)}</td><td>${c.tax_exempt ? '<span class="badge b-confirmed">exempt</span>' : '<span class="muted">taxed</span>'}</td>
        <td>${c.quotes}</td><td>${c.jobs}</td><td>${money(c.spend_cents)}</td></tr>`).join("") || '<tr><td colspan="8" class="muted">No contractors match.</td></tr>'}
    </tbody></table></div>`;
    $("#ct-list").querySelectorAll("tr[data-cid]").forEach((tr) => tr.addEventListener("click", () => openContractor(tr.dataset.cid, () => views.contractors(main))));
  };
  $("#ct-search").addEventListener("input", draw);
  draw();
};

function contractorBadge(st) {
  return `<span class="badge b-${st === "approved" ? "confirmed" : st === "pending" ? "pending" : "canceled"}">${esc(st)}</span>`;
}
function setQueueBadge(n) {
  const a = document.querySelector('#admin-nav a[data-view="contractors"]');
  if (a) a.innerHTML = `Contractors${n ? ` <span class="count">${n}</span>` : ""}`;
}
async function refreshQueueBadge() {
  try {
    const { contractors, quotes, queue_bookings } = await authFetch("admin-contractors");
    setQueueBadge(contractors.filter((c) => c.status === "pending").length + queue_bookings.length
      + quotes.filter((q) => ["new", "contacted"].includes(q.status)).length);
  } catch { /* staff without access or offline: no badge */ }
}

// ---------- contractor drawer: details, status, tax exemption, linked work ----------
async function openContractor(id, onChange) {
  const data = await authFetch("admin-contractors");
  const c = data.contractors.find((x) => x.id === id);
  if (!c) return alert("Contractor not found");
  const bookings = data.bookings.filter((b) => b.contractor_id === id);
  const quotes = data.quotes.filter((q) => q.contractor_id === id);
  const drawer = $("#drawer"), backdrop = $("#drawer-backdrop");
  drawer.innerHTML = `
    <button class="close" id="cd-close">×</button>
    <h2>${esc(c.company_name)} ${contractorBadge(c.status)}</h2>
    <p class="hint">Contractor number: <strong>${esc(c.contractor_number || "assigned when approved")}</strong>${c.verified_by ? ` · verified by ${esc(c.verified_by)}` : ""}${c.approved_at ? ` on ${new Date(c.approved_at).toLocaleDateString()}` : ""}</p>
    <div class="drawer-actions">
      ${c.status !== "approved" ? '<button class="btn btn-primary btn-sm" data-st="approved">Approve</button>' : '<button class="btn btn-ghost btn-sm" data-st="suspended">Suspend</button>'}
      ${c.status === "pending" ? '<button class="btn btn-ghost btn-sm" data-st="rejected">Reject</button>' : ""}
    </div>
    <div class="section-line"></div>
    <div class="row two" style="display:grid;gap:10px;grid-template-columns:1fr 1fr">
      <label>Company<input id="cd-company" value="${esc(c.company_name)}"></label>
      <label>Contact<input id="cd-contact" value="${esc(c.contact_name)}"></label>
      <label>Phone<input id="cd-phone" value="${esc(c.phone)}"></label>
      <label>Email<input id="cd-email" type="email" value="${esc(c.email)}"></label>
    </div>
    <label>License / EIN / website<input id="cd-license" value="${esc(c.license_info || "")}"></label>
    <label>Admin notes<textarea id="cd-notes" rows="2">${esc(c.admin_notes || "")}</textarea></label>
    <h3>Sales tax</h3>
    <label class="chk"><input type="checkbox" id="cd-exempt" ${c.tax_exempt ? "checked" : ""}> Tax exempt — no sales tax on this contractor's bookings and invoices</label>
    <label>Exemption certificate / permit number<input id="cd-cert" value="${esc(c.tax_exempt_cert || "")}" placeholder="e.g. Texas form 01-339 or sales tax permit #"></label>
    <p class="hint">${c.tax_exempt_file ? '<button class="btn btn-ghost btn-sm" id="cd-cert-view" type="button">View certificate on file</button>' : "No certificate copy on file."}</p>
    <label class="hint">Upload certificate (PDF or photo)<input type="file" id="cd-cert-file" accept="application/pdf,image/*"></label>
    <div class="actions" style="margin-top:8px"><button class="btn btn-primary btn-sm" id="cd-save">Save changes</button></div>
    <div class="section-line"></div>
    <h3>Bookings (${bookings.length})</h3>
    <div class="table-wrap"><table class="table"><tbody>
      ${bookings.map((b) => `<tr data-id="${b.id}"><td><strong>${esc(b.reference)}</strong></td><td>${b.start_date}</td><td>${badge(b.status)}</td><td>${badge(b.payment_status)}</td><td>${money(b.amount_total_cents)}</td></tr>`).join("") || '<tr><td class="muted">No bookings yet.</td></tr>'}
    </tbody></table></div>
    <h3>Quote requests (${quotes.length})</h3>
    <div class="table-wrap"><table class="table"><tbody>
      ${quotes.map((q) => `<tr><td>${new Date(q.created_at).toLocaleDateString()}</td><td>${esc(q.service || "")}</td><td>${badge(q.status)}</td></tr>`).join("") || '<tr><td class="muted">No quote requests.</td></tr>'}
    </tbody></table></div>`;
  drawer.hidden = false; backdrop.hidden = false;
  const close = () => { drawer.hidden = true; backdrop.hidden = true; };
  $("#cd-close").addEventListener("click", close);
  backdrop.addEventListener("click", close, { once: true });
  const reopen = () => { onChange?.(); openContractor(id, onChange); };
  drawer.querySelectorAll("tr[data-id]").forEach((tr) => tr.addEventListener("click", () => openBooking(tr.dataset.id)));
  drawer.querySelectorAll("[data-st]").forEach((b) => guarded(b, async () => {
    if (b.dataset.st !== "approved" && !confirm(`${b.dataset.st === "rejected" ? "Reject" : "Suspend"} this contractor?`)) return;
    try {
      const r = await post("admin-contractors", { id, status: b.dataset.st });
      toast(b.dataset.st === "approved" ? `Approved — number ${r.contractor.contractor_number} emailed` : "Updated");
      reopen();
    } catch (e) { alert(e.message); }
  }));
  guarded($("#cd-save"), async () => {
    try {
      await post("admin-contractors", {
        id, company_name: $("#cd-company").value, contact_name: $("#cd-contact").value,
        phone: $("#cd-phone").value, email: $("#cd-email").value, license_info: $("#cd-license").value,
        admin_notes: $("#cd-notes").value, tax_exempt: $("#cd-exempt").checked, tax_exempt_cert: $("#cd-cert").value,
      });
      toast("Saved"); reopen();
    } catch (e) { alert(e.message); }
  });
  $("#cd-cert-view")?.addEventListener("click", async () => {
    try { const { url } = await post("admin-contractors", { id, action: "cert_view" }); window.open(url, "_blank", "noopener"); } catch (e) { alert(e.message); }
  });
  $("#cd-cert-file").addEventListener("change", async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const { path, token } = await post("admin-contractors", { id, action: "cert_upload_url", filename: file.name, content_type: file.type });
      const { error } = await sb.storage.from("booking-uploads").uploadToSignedUrl(path, token, file);
      if (error) throw error;
      await post("admin-contractors", { id, action: "cert_attach", path });
      toast("Certificate uploaded"); reopen();
    } catch (err) { alert(err.message || "Upload failed"); }
  });
}

// ==================================================================
//  REPORTS
// ==================================================================
views.reports = async (main) => {
  const ymd = (d) => d.toISOString().slice(0, 10);
  main.innerHTML = `
    <h2>Reports</h2>
    <div class="toolbar">
      <label class="hint">From <input type="date" id="r-from" value="${ymd(new Date(Date.now() - 365 * 864e5))}"></label>
      <label class="hint">To <input type="date" id="r-to" value="${ymd(new Date())}"></label>
      <button class="btn btn-primary btn-sm" id="r-go">Run</button>
      <button class="btn btn-ghost btn-sm" id="r-csv">Download CSV</button>
    </div>
    <div id="r-out"><p class="muted">Loading…</p></div>`;
  let last;
  const bars = (rows, title) => {
    const max = Math.max(1, ...rows.map((r) => r.count));
    return `<h3>${title}</h3><div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Jobs</th><th></th><th>Booked $</th></tr></thead><tbody>
      ${rows.map((r) => `<tr style="cursor:default"><td>${esc(r.label)}</td><td>${r.count}</td><td style="width:40%"><div class="bar" style="width:${Math.round((r.count / max) * 100)}%"></div></td><td>${money(r.revenue_cents)}</td></tr>`).join("") || '<tr><td colspan="4" class="muted">No data.</td></tr>'}
    </tbody></table></div>`;
  };
  const run = async () => {
    last = await authFetch(`admin-reports?from=${$("#r-from").value}&to=${$("#r-to").value}`);
    $("#r-out").innerHTML = `
      <div class="kpi-row"><div class="kpi"><div class="n">${last.total}</div><div class="l">Jobs</div></div>
      <div class="kpi"><div class="n">${money(last.revenue_cents)}</div><div class="l">Booked revenue</div></div></div>
      ${bars(last.by_source, "Where did you hear about us")}
      ${bars(last.by_month, "Jobs by month")}
      ${bars(last.by_type, "Jobs by service")}
      ${bars(last.by_customer_kind, "Retail vs contractor")}`;
  };
  $("#r-go").addEventListener("click", () => run().catch((e) => alert(e.message)));
  $("#r-csv").addEventListener("click", () => {
    if (!last) return;
    const q = (x) => `"${String(x).replace(/"/g, '""')}"`;
    const lines = [["Report", "Label", "Jobs", "Booked $"].join(",")];
    for (const [name, rows] of [["Source", last.by_source], ["Month", last.by_month], ["Service", last.by_type], ["Customer kind", last.by_customer_kind]]) {
      rows.forEach((r) => lines.push([q(name), q(r.label), r.count, (r.revenue_cents / 100).toFixed(2)].join(",")));
    }
    const a = el(`<a download="txd-report-${last.from}-to-${last.to}.csv"></a>`);
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    a.click(); URL.revokeObjectURL(a.href);
  });
  await run();
};

// ==================================================================
//  SITE CAROUSEL (the ON SITE panel on the home page)
// ==================================================================
views.carousel = async (main) => {
  const { slides } = await authFetch("admin-slides");
  const today = todayStr();
  const state = (s) => !s.active ? "hidden" : (s.ends_on && s.ends_on < today) ? "expired" : (s.starts_on && s.starts_on > today) ? "scheduled" : "live";
  main.innerHTML = `
    <h2>Site Carousel</h2>
    <p class="hint">These slides rotate in the “On-site” panel at the top of the home page. Reorder with the arrows. For a temporary promo, set a “hide after” date and it disappears by itself.</p>
    <div id="slides"></div>
    <button class="btn btn-primary btn-sm" id="sl-add">+ Add slide</button>`;
  const list = $("#slides");
  const ids = () => [...list.querySelectorAll(".slide-card")].map((c) => c.dataset.id);
  list.innerHTML = slides.map((s, i) => `
    <details class="slide-card form" data-id="${s.id}" ${slides.length <= 3 ? "open" : ""}>
      <summary><strong>${esc(s.title)}</strong> <span class="badge b-${state(s) === "live" ? "confirmed" : state(s) === "scheduled" ? "pending" : "unpaid"}">${state(s)}</span>
        <span class="slide-order"><button class="btn btn-ghost btn-sm" data-move="-1" ${i === 0 ? "disabled" : ""} title="Move up">↑</button><button class="btn btn-ghost btn-sm" data-move="1" ${i === slides.length - 1 ? "disabled" : ""} title="Move down">↓</button></span></summary>
      <div class="row two"><label>Title<input class="sl-title" value="${esc(s.title)}"></label><label>Badge (small yellow tag)<input class="sl-badge" value="${esc(s.badge || "")}" placeholder="e.g. Limited time"></label></div>
      <label>Short description<textarea class="sl-body" rows="2">${esc(s.body || "")}</textarea></label>
      <label>Checklist (one line each)<textarea class="sl-bullets" rows="4">${esc(s.bullets || "")}</textarea></label>
      <div class="row three">
        <label>Price label<input class="sl-plabel" value="${esc(s.price_label || "")}" placeholder="starting at"></label>
        <label>Price text<input class="sl-ptext" value="${esc(s.price_text || "")}" placeholder="$419" ${s.live_price ? "disabled" : ""}></label>
        <label class="chk" style="align-self:end"><input class="sl-live" type="checkbox" ${s.live_price ? "checked" : ""}> Use live 7-day price</label>
      </div>
      <div class="row two"><label>Button text<input class="sl-cta" value="${esc(s.cta_label || "")}"></label><label>Button link<input class="sl-url" value="${esc(s.cta_url || "")}" placeholder="/book or #pricing"></label></div>
      <div class="row three">
        <label>Show from<input class="sl-from" type="date" value="${esc(s.starts_on || "")}"></label>
        <label>Hide after<input class="sl-to" type="date" value="${esc(s.ends_on || "")}"></label>
        <label>Visible<select class="sl-active"><option value="true" ${s.active ? "selected" : ""}>Yes</option><option value="false" ${!s.active ? "selected" : ""}>No</option></select></label>
      </div>
      <label>Image (optional)<input class="sl-img" value="${esc(s.image_url || "")}" placeholder="paste a link, or upload below"></label>
      <input class="sl-file" type="file" accept="image/jpeg,image/png,image/webp">
      <div class="actions" style="margin-top:10px"><button class="btn btn-primary btn-sm" data-save>Save slide</button><button class="btn btn-ghost btn-sm" data-del>Delete</button></div>
    </details>`).join("") || '<div class="empty">No slides yet — the home page shows its built-in 7-day card.</div>';

  list.querySelectorAll(".sl-live").forEach((c) => c.addEventListener("change", () => { c.closest(".slide-card").querySelector(".sl-ptext").disabled = c.checked; }));
  list.querySelectorAll("[data-move]").forEach((b) => b.addEventListener("click", async (e) => {
    e.preventDefault();
    const order = ids(), card = b.closest(".slide-card"), i = order.indexOf(card.dataset.id), j = i + +b.dataset.move;
    [order[i], order[j]] = [order[j], order[i]];
    await post("admin-slides", { action: "reorder", ids: order }); render("carousel");
  }));
  list.querySelectorAll(".slide-card").forEach((card) => {
    const read = () => ({
      id: card.dataset.id, title: card.querySelector(".sl-title").value.trim(), badge: card.querySelector(".sl-badge").value.trim(),
      body: card.querySelector(".sl-body").value.trim(), bullets: card.querySelector(".sl-bullets").value.trim(),
      price_label: card.querySelector(".sl-plabel").value.trim(), price_text: card.querySelector(".sl-ptext").value.trim(),
      live_price: card.querySelector(".sl-live").checked, cta_label: card.querySelector(".sl-cta").value.trim(), cta_url: card.querySelector(".sl-url").value.trim(),
      starts_on: card.querySelector(".sl-from").value, ends_on: card.querySelector(".sl-to").value,
      active: card.querySelector(".sl-active").value === "true", image_url: card.querySelector(".sl-img").value.trim(),
    });
    guarded(card.querySelector("[data-save]"), async () => {
      const s = read(); if (!s.title) return alert("Title is required.");
      try { await post("admin-slides", { action: "update", ...s }); toast("Slide saved — live on the site"); render("carousel"); } catch (e) { alert(e.message); }
    });
    guarded(card.querySelector("[data-del]"), async () => {
      if (!confirm("Delete this slide?")) return;
      await post("admin-slides", { action: "delete", id: card.dataset.id }); render("carousel");
    });
    card.querySelector(".sl-file").addEventListener("change", async (e) => {
      const file = e.target.files[0]; if (!file) return;
      try {
        const up = await post("admin-slides", { action: "upload_url", filename: file.name, content_type: file.type });
        const { error } = await sb.storage.from("site-assets").uploadToSignedUrl(up.path, up.token, file);
        if (error) throw error;
        card.querySelector(".sl-img").value = up.public_url; toast("Image uploaded — click Save slide");
      } catch (err) { alert(err.message || "Upload failed"); }
    });
  });
  guarded($("#sl-add"), async () => {
    await post("admin-slides", { action: "create", title: "New promo", badge: "Limited time", active: false });
    toast("Slide added (hidden until you turn it on)"); render("carousel");
  });
};

// ==================================================================
//  QUOTE REQUESTS (homepage form, with customer photos)
// ==================================================================
views.quotes = async (main) => {
  const { quotes } = await authFetch("admin-quotes");
  const fresh = quotes.filter((q) => q.status === "new").length;
  main.innerHTML = `
    <h2>Quote Requests</h2>
    <p class="hint">From the homepage quote form. Call or email the customer, then use <strong>Create booking</strong> to turn the request into a job and build its invoice. Contractor requests also show under Contractors → Queue.</p>
    ${fresh ? `<div class="notice">${fresh} new</div>` : ""}
    <div id="q-list"></div>`;
  $("#q-list").innerHTML = quotes.map((q) => `
    <details class="form quote-card" data-id="${q.id}" ${q.status === "new" ? "open" : ""}>
      <summary><strong>${esc(q.name)}</strong> <span class="muted">${new Date(q.created_at).toLocaleString()}</span>
        <span class="badge b-${q.status === "new" ? "pending" : q.status === "booked" ? "confirmed" : "unpaid"}">${q.status}</span>
        ${q.photos.length ? `<span class="muted">📷 ${q.photos.length}</span>` : ""}
        ${q.is_contractor ? '<span class="badge b-pending">contractor</span>' : ""}</summary>
      <dl class="dl">
        <dt>Phone</dt><dd><a href="tel:${esc(q.phone)}">${esc(q.phone)}</a></dd>
        <dt>Email</dt><dd><a href="mailto:${esc(q.email)}">${esc(q.email)}</a></dd>
        <dt>Service</dt><dd>${esc(q.service || "—")}${q.zip ? ` · ZIP ${esc(q.zip)}` : ""}</dd>
        ${q.delivery_address ? `<dt>Address</dt><dd>${esc(q.delivery_address)}</dd>` : ""}
        ${q.booking_id ? `<dt>Booking</dt><dd><a href="#" data-open-booking="${q.booking_id}">Open booking</a></dd>` : ""}
        <dt>Heard about us</dt><dd>${esc(q.referral_source || "—")}</dd>
        <dt>Details</dt><dd>${esc(q.details || "—")}</dd>
      </dl>
      ${q.photos.length ? `<div class="photo-grid">${q.photos.map((u) => `<a href="${u}" target="_blank" rel="noopener"><img src="${u}" alt="customer photo"></a>`).join("")}</div>` : ""}
      <div class="row two" style="display:grid;gap:10px;grid-template-columns:1fr 2fr">
        <label>Status<select class="q-status">${["new", "contacted", "booked", "closed"].map((s) => `<option ${s === q.status ? "selected" : ""}>${s}</option>`).join("")}</select></label>
        <label>Notes<input class="q-notes" value="${esc(q.admin_notes || "")}"></label>
      </div>
      <div class="actions" style="margin-top:8px"><button class="btn btn-primary btn-sm" data-save>Save</button>
        ${!q.booking_id && q.status !== "closed" ? '<button class="btn btn-primary btn-sm" data-book>Create booking</button>' : ""}</div>
    </details>`).join("") || '<div class="empty">No quote requests yet.</div>';
  $("#q-list").querySelectorAll(".quote-card").forEach((card) => {
    const q = quotes.find((x) => x.id === card.dataset.id);
    guarded(card.querySelector("[data-save]"), async () => {
      await post("admin-quotes", { id: q.id, status: card.querySelector(".q-status").value, admin_notes: card.querySelector(".q-notes").value });
      toast("Saved"); render("quotes");
    });
    card.querySelector("[data-book]")?.addEventListener("click", () => openNewBookingForm(null, () => render("quotes"), { quote: q }));
    card.querySelector("[data-open-booking]")?.addEventListener("click", (e) => { e.preventDefault(); openBooking(q.booking_id); });
  });
};
