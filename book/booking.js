import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const api = (path, opts) => fetch(`/api/${path}`, opts).then(async (r) => {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
});
const $ = (sel) => document.querySelector(sel);
const money = (c) => `$${(c / 100).toFixed(2)}`;
const addDays = (dateStr, n) => { const d = new Date(dateStr + "T00:00:00"); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const todayStr = () => new Date().toISOString().slice(0, 10);

const state = {
  config: null,
  types: [],
  supabase: null,
  service: null,
  type: null,
  rentalDays: null,
  startDate: null,
  timeWindow: null,
  photos: [],          // { path, kind, name }
  promo: null,         // { code, discount_cents }
  step: 1,
};

// ---------- init ----------
(async function init() {
  try {
    const [config, catalog] = await Promise.all([api("public-config"), api("catalog")]);
    state.config = config;
    state.types = catalog.types;
    if (config.supabaseUrl && config.supabaseAnonKey) {
      state.supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);
    }
    setupStatic();
    $("#loading").hidden = true;
    goStep(1);
    // Deep-link: /book/?service=dumpster|junk
    const svc = new URLSearchParams(location.search).get("service");
    if (svc === "dumpster" || svc === "junk") selectService(svc);
  } catch (err) {
    showError(err.message);
  }
})();

function showError(msg) {
  const el = $("#error"); el.textContent = msg; el.hidden = false;
  $("#loading").hidden = true;
}

function setupStatic() {
  // time windows
  const tw = $("#time-window");
  tw.innerHTML = (state.config.timeWindows || ["Anytime"]).map((w) => `<option>${w}</option>`).join("");
  // date bounds
  const start = $("#start-date");
  start.min = addDays(todayStr(), state.config.leadTimeDays || 1);
  start.max = addDays(todayStr(), state.config.bookingWindowDays || 120);
  // cash option
  if (state.config.cashAccepted) $("#cash-opt").hidden = false;

  // service choices
  document.querySelectorAll(".choice").forEach((b) =>
    b.addEventListener("click", () => selectService(b.dataset.service)));
  // back buttons
  document.querySelectorAll("[data-back]").forEach((b) =>
    b.addEventListener("click", () => goStep(state.step - 1)));

  $("#to-date").addEventListener("click", () => goStep(3));
  $("#to-details").addEventListener("click", () => goStep(4));
  $("#to-agreement").addEventListener("click", onDetailsNext);
  $("#to-payment").addEventListener("click", () => { renderSummary(); goStep(6); });

  $("#start-date").addEventListener("change", onDateChange);
  $("#rental-days").addEventListener("change", (e) => { state.rentalDays = Number(e.target.value); });
  $("#c-photos").addEventListener("change", onPhotoPick);
  $("#sign-name").addEventListener("input", validateAgreement);
  $("#agree-check").addEventListener("change", validateAgreement);
  $("#apply-promo").addEventListener("click", applyPromo);
  document.querySelectorAll('input[name="pay"]').forEach((r) =>
    r.addEventListener("change", renderSummary));
  $("#submit-booking").addEventListener("click", submitBooking);
}

// ---------- navigation ----------
function goStep(n) {
  state.step = n;
  document.querySelectorAll(".step").forEach((s) => { s.hidden = Number(s.dataset.step) !== n; });
  document.querySelectorAll("#steps li").forEach((li) => {
    const s = Number(li.dataset.step);
    li.classList.toggle("active", s === n);
    li.classList.toggle("done", s < n);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---------- step 1: service ----------
function selectService(service) {
  state.service = service;
  state.type = null;
  $("#svc-label").textContent = service === "junk" ? "junk service" : "dumpster";
  $("#rental-days-wrap").hidden = service !== "dumpster";
  renderTypes();
  goStep(2);
}

function renderTypes() {
  const list = $("#type-list");
  const types = state.types.filter((t) => t.service === state.service);
  list.innerHTML = types.map((t) => `
    <button class="type-card" data-id="${t.id}">
      <span class="tc-top">
        <span class="tc-name">${t.name}</span>
        <span class="tc-price">${money(t.base_price_cents)}${t.service === "dumpster" ? "/rental" : ""}</span>
      </span>
      <span class="tc-desc">${t.description || ""}</span>
    </button>`).join("");
  list.querySelectorAll(".type-card").forEach((card) =>
    card.addEventListener("click", () => selectType(card.dataset.id)));
}

function selectType(id) {
  state.type = state.types.find((t) => t.id === id);
  state.rentalDays = state.type.rental_days_included;
  document.querySelectorAll(".type-card").forEach((c) => c.classList.toggle("selected", c.dataset.id === id));
  // rental-length options: included .. included+14
  const inc = state.type.rental_days_included;
  $("#rental-days").innerHTML = Array.from({ length: 15 }, (_, i) => inc + i)
    .map((d) => `<option value="${d}">${d} days${d === inc ? " (included)" : ` (+${money((d - inc) * state.type.extra_day_fee_cents)})`}</option>`).join("");
  $("#to-date").disabled = false;
  state.promo = null; // reset promo when the item changes
}

// ---------- step 3: date ----------
async function onDateChange(e) {
  state.startDate = e.target.value;
  const msg = $("#avail-msg");
  $("#to-details").disabled = true;
  if (!state.startDate) return;
  const end = addDays(state.startDate, (state.rentalDays || 1) - 1);
  msg.textContent = "Checking availability…"; msg.className = "avail";
  try {
    const { available } = await api(`availability?type=${state.type.id}&start=${state.startDate}&end=${end}`);
    if (available > 0) {
      msg.textContent = `✓ Available on ${state.startDate}`; msg.className = "avail ok";
      $("#to-details").disabled = false;
    } else {
      msg.textContent = "Sorry — fully booked for those dates. Try another day."; msg.className = "avail no";
    }
  } catch (err) { msg.textContent = err.message; msg.className = "avail no"; }
}

// ---------- step 4: details + photos ----------
function onDetailsNext() {
  const required = [["#c-name", "name"], ["#c-phone", "phone"], ["#c-email", "email"], ["#c-address", "address"]];
  for (const [sel, label] of required) {
    if (!$(sel).value.trim()) { $(sel).focus(); alert(`Please enter your ${label}.`); return; }
  }
  state.timeWindow = $("#time-window").value;
  loadAgreement();
  goStep(5);
}

async function onPhotoPick(e) {
  const files = Array.from(e.target.files || []);
  for (const file of files) {
    const thumb = document.createElement("div");
    thumb.className = "thumb uploading";
    const img = document.createElement("img");
    img.src = URL.createObjectURL(file);
    thumb.appendChild(img);
    $("#thumbs").appendChild(thumb);
    try {
      const { path, token } = await api("upload-url", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: file.name, content_type: file.type }),
      });
      if (state.supabase) {
        const { error } = await state.supabase.storage.from("booking-uploads").uploadToSignedUrl(path, token, file);
        if (error) throw error;
      }
      state.photos.push({ path, kind: "junk_items", name: file.name });
      thumb.classList.remove("uploading");
      const rm = document.createElement("button");
      rm.textContent = "×"; rm.type = "button";
      rm.addEventListener("click", () => { state.photos = state.photos.filter((p) => p.path !== path); thumb.remove(); });
      thumb.appendChild(rm);
    } catch (err) {
      thumb.remove(); alert(`Upload failed: ${err.message}`);
    }
  }
  e.target.value = "";
}

// ---------- step 5: agreement ----------
async function loadAgreement() {
  try {
    const a = await api("agreement");
    $("#agreement-body").innerHTML = a.body_html;
  } catch { $("#agreement-body").textContent = "Agreement unavailable. Please call us to book."; }
}
function validateAgreement() {
  $("#to-payment").disabled = !($("#agree-check").checked && $("#sign-name").value.trim());
}

// ---------- step 6: quote + promo + submit ----------
function computeQuote() {
  const t = state.type;
  const extraDays = Math.max(0, (state.rentalDays || t.rental_days_included) - t.rental_days_included);
  const subtotal = t.base_price_cents + extraDays * t.extra_day_fee_cents;
  const discount = state.promo ? Math.min(state.promo.discount_cents, subtotal) : 0;
  const taxable = Math.max(0, subtotal - discount);
  const tax = Math.round((taxable * (state.config.taxRateBps || 0)) / 10000);
  const total = taxable + tax;
  const deposit = t.deposit_cents > 0 ? t.deposit_cents : Math.round((total * (state.config.depositPercent || 25)) / 100);
  return { subtotal, discount, tax, total, deposit: Math.min(deposit, total), extraDays };
}

function renderSummary() {
  const q = computeQuote();
  const choice = document.querySelector('input[name="pay"]:checked')?.value || "card_full";
  const dueNow = choice === "card_full" ? q.total : choice === "card_deposit" ? q.deposit : 0;
  $("#summary").innerHTML = `
    <div class="line"><span>${state.type.name}</span><span>${money(state.type.base_price_cents)}</span></div>
    ${q.extraDays ? `<div class="line"><span>+${q.extraDays} extra day(s)</span><span>${money(q.extraDays * state.type.extra_day_fee_cents)}</span></div>` : ""}
    <div class="line"><span>Dates</span><span>${state.startDate} → ${addDays(state.startDate, (state.rentalDays || 1) - 1)}</span></div>
    ${q.discount ? `<div class="line disc"><span>Discount ${state.promo.code}</span><span>−${money(q.discount)}</span></div>` : ""}
    ${q.tax ? `<div class="line"><span>Tax</span><span>${money(q.tax)}</span></div>` : ""}
    <div class="line total"><span>Total</span><span>${money(q.total)}</span></div>
    <div class="line"><span>Due now (${choice === "cash" ? "cash on approval" : choice === "card_deposit" ? "deposit" : "full"})</span><span>${money(dueNow)}</span></div>`;
}

async function applyPromo() {
  const code = $("#promo-code").value.trim();
  const msg = $("#promo-msg");
  if (!code) return;
  const q = computeQuote();
  try {
    const res = await api("promo-validate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, subtotal_cents: state.type.base_price_cents + q.extraDays * state.type.extra_day_fee_cents, service: state.service }),
    });
    if (res.valid) {
      state.promo = { code: res.code, discount_cents: res.discount_cents };
      msg.textContent = `✓ ${res.code} applied — you save ${money(res.discount_cents)}`; msg.className = "promo-msg ok";
    } else {
      state.promo = null; msg.textContent = res.reason || "Invalid code"; msg.className = "promo-msg no";
    }
  } catch (err) { msg.textContent = err.message; msg.className = "promo-msg no"; }
  renderSummary();
}

async function submitBooking() {
  const btn = $("#submit-booking");
  btn.disabled = true; btn.textContent = "Booking…";
  const choice = document.querySelector('input[name="pay"]:checked')?.value || "card_full";
  try {
    const payload = {
      type_id: state.type.id,
      rental_days: state.rentalDays,
      start_date: state.startDate,
      time_window: state.timeWindow,
      customer_name: $("#c-name").value.trim(),
      customer_email: $("#c-email").value.trim(),
      customer_phone: $("#c-phone").value.trim(),
      delivery_address: $("#c-address").value.trim(),
      delivery_notes: $("#c-delnotes").value.trim(),
      notes: $("#c-notes").value.trim(),
      promo_code: state.promo?.code || null,
      payment_choice: choice,
      agreement_signed_name: $("#sign-name").value.trim(),
      photos: state.photos.map((p) => ({ path: p.path, kind: p.kind })),
    };
    const res = await api("create-booking", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.mode === "card" && res.checkout_url) {
      window.location.href = res.checkout_url;
    } else if (res.mode === "cash") {
      window.location.href = `/book/confirm.html?ref=${res.reference}&cash=1`;
    }
  } catch (err) {
    alert(err.message);
    btn.disabled = false; btn.textContent = "Book & Pay";
  }
}
