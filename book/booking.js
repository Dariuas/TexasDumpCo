import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { mountAvailabilityCalendar } from "/assets/js/availability-calendar.js";

const api = (path, opts) => fetch(`/api/${path}`, opts).then(async (r) => {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
});
const $ = (sel) => document.querySelector(sel);
const money = (c) => `$${(c / 100).toFixed(2)}`;
const addDays = (dateStr, n) => { const d = new Date(dateStr + "T00:00:00"); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const todayStr = () => new Date().toISOString().slice(0, 10);

const CATEGORY_META = {
  roll_off_standard: { title: "Roll-Off Dumpster", sub: "You load it — 14-yard container, 1 to 28 days." },
  roll_off_green:    { title: "Clean Green Waste Roll-Off", sub: "Tree limbs, brush & untreated natural wood only." },
  junk_household:    { title: "Junk Hauling", sub: "Our crew loads and hauls away household junk." },
  junk_yard_waste:   { title: "Yard Waste Hauling", sub: "Our crew hauls away brush & yard debris — no dumpster needed." },
  junk_cleanout:     { title: "Cleanout Service", sub: "Garage, house, apartment or storage unit — we do the work." },
  heavy_material:    { title: "Heavy Material", sub: "Concrete, dirt, rock, tile or shingles — priced by weight." },
};
const STEP_ORDER = ["category", "type", "duration", "date", "details", "agreement", "payment"];
const STEP_LABEL = { category: "Service", type: "Choose", duration: "Length", date: "Date", details: "Details", agreement: "Agreement", payment: "Payment" };

const state = {
  config: null,
  types: [],
  tiers: [],       // { type_id, days, price_cents, label }
  addons: [],       // { id, name, category, price_cents }
  supabase: null,
  category: null,
  type: null,       // selected dumpster_types row
  days: null,
  startDate: null,
  timeWindow: null,
  zone: null,       // { code, label, fee_cents, quote_only }
  photos: [],
  selectedAddonIds: [],
  promo: null,
  step: "category",
};

(async function init() {
  try {
    const [config, catalog] = await Promise.all([api("public-config"), api("catalog")]);
    state.config = config;
    state.types = catalog.types;
    state.tiers = catalog.tiers;
    state.addons = catalog.addons;
    if (config.supabaseUrl && config.supabaseAnonKey) {
      state.supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);
    }
    setupStatic();
    renderCategories();
    $("#loading").hidden = true;
    goStep("category");
    const svc = new URLSearchParams(location.search).get("service");
    if (svc) {
      const guess = svc === "junk" ? "junk_household" : "roll_off_standard";
      if (state.types.some((t) => t.category === guess)) selectCategory(guess);
    }
  } catch (err) {
    showError(err.message);
  }
})();

function showError(msg) {
  const el = $("#error"); el.textContent = msg; el.hidden = false;
  $("#loading").hidden = true;
}

function setupStatic() {
  const tw = $("#time-window");
  tw.innerHTML = (state.config.timeWindows || ["Anytime"]).map((w) => `<option>${w}</option>`).join("");
  state.minDate = addDays(todayStr(), state.config.leadTimeDays || 1);
  state.maxDate = addDays(todayStr(), state.config.bookingWindowDays || 120);
  if (state.config.cashAccepted) $("#cash-opt").hidden = false;

  document.querySelectorAll("[data-back]").forEach((b) => b.addEventListener("click", back));
  $("#to-details").addEventListener("click", () => goStep("details"));
  $("#to-agreement").addEventListener("click", onDetailsNext);
  $("#to-payment").addEventListener("click", () => { renderSummary(); goStep("payment"); });
  $("#c-photos").addEventListener("change", onPhotoPick);
  $("#sign-name").addEventListener("input", validateAgreement);
  $("#agree-check").addEventListener("change", validateAgreement);
  $("#apply-promo").addEventListener("click", applyPromo);
  document.querySelectorAll('input[name="pay"]').forEach((r) => r.addEventListener("change", renderSummary));
  $("#submit-booking").addEventListener("click", submitBooking);

  renderZones();
}

// ---------- step machine ----------
function isDurationType(t) { return t && t.pricing_mode === "duration_tiers"; }
function needsQuote() {
  return (state.type && state.type.pricing_mode === "quote_only") || !!(state.zone && state.zone.quote_only);
}
function categoriesInCatalog() {
  const seen = new Set();
  return state.types.filter((t) => { if (seen.has(t.category)) return false; seen.add(t.category); return true; }).map((t) => t.category);
}
function typesInCategory(cat) { return state.types.filter((t) => t.category === cat); }

function shouldSkip(stepId) {
  if (stepId === "type") return typesInCategory(state.category || "").length <= 1;
  if (stepId === "duration") return !isDurationType(state.type);
  return false;
}
function goStep(id) {
  state.step = id;
  updateProgress();
  document.querySelectorAll(".step").forEach((s) => { s.hidden = s.dataset.step !== id; });
  if (id === "date") mountDateCalendar();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function mountDateCalendar() {
  if (state.calendar) { state.calendar.destroy(); state.calendar = null; }
  $("#to-details").disabled = true;
  $("#avail-msg").textContent = "";
  state.calendar = mountAvailabilityCalendar($("#date-calendar"), {
    typeId: state.type.id,
    days: state.days || 1,
    minDate: state.minDate,
    maxDate: state.maxDate,
    selectedDate: state.startDate,
    onSelect: (dateStr) => {
      state.startDate = dateStr;
      $("#avail-msg").textContent = `✓ Selected ${dateStr}`;
      $("#avail-msg").className = "avail ok";
      $("#to-details").disabled = false;
    },
  });
}
function advance(from) {
  let i = STEP_ORDER.indexOf(from) + 1;
  while (i < STEP_ORDER.length && shouldSkip(STEP_ORDER[i])) i++;
  goStep(STEP_ORDER[i]);
}
function back() {
  let i = STEP_ORDER.indexOf(state.step) - 1;
  while (i >= 0 && shouldSkip(STEP_ORDER[i])) i--;
  if (i >= 0) goStep(STEP_ORDER[i]);
}
function updateProgress() {
  const visible = STEP_ORDER.filter((s) => !shouldSkip(s));
  const idx = visible.indexOf(state.step);
  $("#steps").innerHTML = visible.map((s, i) =>
    `<li class="${i === idx ? "active" : i < idx ? "done" : ""}">${STEP_LABEL[s]}</li>`).join("");
}

// ---------- category ----------
function renderCategories() {
  const cats = categoriesInCatalog();
  $("#category-list").innerHTML = cats.map((c) => {
    const meta = CATEGORY_META[c] || { title: c, sub: "" };
    return `<button class="choice" data-cat="${c}">
      <span class="choice-title">${meta.title}</span>
      <span class="choice-sub">${meta.sub}</span>
    </button>`;
  }).join("");
  $("#category-list").querySelectorAll(".choice").forEach((b) =>
    b.addEventListener("click", () => selectCategory(b.dataset.cat)));
}
function selectCategory(cat) {
  state.category = cat;
  state.type = null;
  const types = typesInCategory(cat);
  if (types.length === 1) {
    selectType(types[0].id);
  } else {
    renderTypes();
    advance("category");
  }
}

// ---------- type ----------
function renderTypes() {
  const meta = CATEGORY_META[state.category] || { title: "option" };
  $("#type-heading").textContent = `Pick your ${meta.title.toLowerCase()}`;
  const types = typesInCategory(state.category);
  $("#type-list").innerHTML = types.map((t) => `
    <button class="type-card" data-id="${t.id}">
      <span class="tc-top">
        <span class="tc-name">${t.name}</span>
        <span class="tc-price">${t.price_note ? t.price_note + " " : ""}${money(t.base_price_cents)}</span>
      </span>
      <span class="tc-desc">${t.description || ""}</span>
    </button>`).join("");
  $("#type-list").querySelectorAll(".type-card").forEach((card) =>
    card.addEventListener("click", () => selectType(card.dataset.id)));
}
function selectType(id) {
  state.type = state.types.find((t) => t.id === id);
  state.days = state.type.rental_days_included;
  state.promo = null;
  state.selectedAddonIds = [];
  if (isDurationType(state.type)) renderDurations();
  advance(document.querySelector('.step[data-step="type"]').hidden ? "category" : "type");
}

// ---------- duration ----------
function renderDurations() {
  const rows = state.tiers.filter((t) => t.type_id === state.type.id).sort((a, b) => a.days - b.days);
  $("#duration-list").innerHTML = rows.map((r) => `
    <button class="type-card" data-days="${r.days}">
      <span class="tc-top">
        <span class="tc-name">${r.label || r.days + " Days"}</span>
        <span class="tc-price">${money(r.price_cents)}</span>
      </span>
    </button>`).join("");
  $("#duration-list").querySelectorAll(".type-card").forEach((card) =>
    card.addEventListener("click", () => {
      state.days = Number(card.dataset.days);
      $("#duration-list .type-card").forEach((c) => c.classList.toggle("selected", c === card));
      advance("duration");
    }));
}

// ---------- date + distance ----------
function renderZones() {
  const zones = state.config.distanceZones || [];
  $("#zone-list").innerHTML = zones.map((z, i) => `
    <button class="type-card${i === 0 ? " selected" : ""}" data-code="${z.code}">
      <span class="tc-top">
        <span class="tc-name">${z.label}</span>
        <span class="tc-price">${z.quote_only ? "Call for quote" : (z.fee_cents ? "+" + money(z.fee_cents) : "Included")}</span>
      </span>
    </button>`).join("");
  if (zones.length) state.zone = zones[0];
  $("#zone-list").querySelectorAll(".type-card").forEach((card) =>
    card.addEventListener("click", () => {
      state.zone = zones.find((z) => z.code === card.dataset.code);
      $("#zone-list .type-card").forEach((c) => c.classList.toggle("selected", c === card));
    }));
}

// ---------- details + add-ons + photos ----------
function onDetailsNext() {
  const required = [["#c-name", "name"], ["#c-phone", "phone"], ["#c-email", "email"], ["#c-address", "address"]];
  for (const [sel, label] of required) {
    if (!$(sel).value.trim()) { $(sel).focus(); alert(`Please enter your ${label}.`); return; }
  }
  state.timeWindow = $("#time-window").value;
  loadAgreement();
  advance("details");
}

function renderAddons() {
  const wrap = $("#addon-wrap");
  if (state.category !== "junk_household" || !state.addons.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  $("#addon-list").innerHTML = state.addons.map((a) => `
    <label class="addon-opt">
      <input type="checkbox" value="${a.id}" data-price="${a.price_cents}">
      <span>${a.name}</span><span class="addon-price">+${money(a.price_cents)}</span>
    </label>`).join("");
  $("#addon-list").querySelectorAll("input").forEach((cb) =>
    cb.addEventListener("change", () => {
      state.selectedAddonIds = [...$("#addon-list").querySelectorAll("input:checked")].map((c) => c.value);
    }));
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

// ---------- agreement ----------
async function loadAgreement() {
  renderAddons();
  try {
    const a = await api("agreement");
    $("#agreement-body").innerHTML = a.body_html;
  } catch { $("#agreement-body").textContent = "Agreement unavailable. Please call us to book."; }
}
function validateAgreement() {
  $("#to-payment").disabled = !($("#agree-check").checked && $("#sign-name").value.trim());
}

// ---------- quote + promo + review ----------
function selectedAddons() {
  return state.selectedAddonIds
    .map((id) => state.addons.find((a) => a.id === id))
    .filter(Boolean)
    .map((a) => ({ name: a.name, price_cents: a.price_cents, qty: 1 }));
}
function computeQuote() {
  const t = state.type;
  let base;
  if (isDurationType(t)) {
    const tier = state.tiers.find((r) => r.type_id === t.id && r.days === state.days);
    base = tier ? tier.price_cents : t.base_price_cents;
  } else {
    base = t.base_price_cents;
  }
  const addons = selectedAddons();
  const addonTotal = addons.reduce((s, a) => s + a.price_cents, 0);
  const subtotal = base + addonTotal;
  const discount = state.promo ? Math.min(state.promo.discount_cents, subtotal) : 0;
  const distanceFee = state.zone?.fee_cents || 0;
  const taxable = Math.max(0, subtotal - discount) + distanceFee;
  const tax = Math.round((taxable * (state.config.taxRateBps || 0)) / 10000);
  const total = taxable + tax;
  const deposit = t.deposit_cents > 0 ? t.deposit_cents : Math.round((total * (state.config.depositPercent || 25)) / 100);
  return { base, addonTotal, subtotal, discount, distanceFee, tax, total, deposit: Math.min(deposit, total) };
}

function renderSummary() {
  const q = computeQuote();
  const quote = needsQuote();
  $("#review-heading").textContent = quote ? "Review & request quote" : "Review & pay";
  $("#promo-wrap").hidden = quote;
  $("#pay-options").hidden = quote;
  $("#quote-note").hidden = !quote;
  $("#submit-booking").textContent = quote ? "Request Quote" : "Book & Pay";

  const choice = document.querySelector('input[name="pay"]:checked')?.value || "card_full";
  const dueNow = quote ? 0 : choice === "card_full" ? q.total : choice === "card_deposit" ? q.deposit : 0;
  const addons = selectedAddons();

  $("#summary").innerHTML = `
    <div class="line"><span>${state.type.name}${isDurationType(state.type) ? ` (${state.days} days)` : ""}</span><span>${money(q.base)}</span></div>
    ${addons.map((a) => `<div class="line"><span>${a.name}</span><span>${money(a.price_cents)}</span></div>`).join("")}
    ${state.startDate ? `<div class="line"><span>Date</span><span>${state.startDate}</span></div>` : ""}
    ${state.zone ? `<div class="line"><span>${state.zone.label}</span><span>${q.distanceFee ? money(q.distanceFee) : (state.zone.quote_only ? "—" : "Included")}</span></div>` : ""}
    ${q.discount ? `<div class="line disc"><span>Discount ${state.promo.code}</span><span>−${money(q.discount)}</span></div>` : ""}
    ${!quote && q.tax ? `<div class="line"><span>Tax</span><span>${money(q.tax)}</span></div>` : ""}
    <div class="line total"><span>${quote ? "Estimated total" : "Total"}</span><span>${quote ? money(q.total) + "+" : money(q.total)}</span></div>
    ${!quote ? `<div class="line"><span>Due now (${choice === "cash" ? "cash on approval" : choice === "card_deposit" ? "deposit" : "full"})</span><span>${money(dueNow)}</span></div>` : ""}`;
}

async function applyPromo() {
  const code = $("#promo-code").value.trim();
  const msg = $("#promo-msg");
  if (!code) return;
  const q = computeQuote();
  try {
    const res = await api("promo-validate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, subtotal_cents: q.subtotal, service: state.type.service }),
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
  const quote = needsQuote();
  btn.disabled = true; btn.textContent = quote ? "Sending…" : "Booking…";
  const choice = document.querySelector('input[name="pay"]:checked')?.value || "card_full";
  try {
    const payload = {
      type_id: state.type.id,
      rental_days: state.days,
      start_date: state.startDate,
      time_window: state.timeWindow,
      distance_zone: state.zone?.code || null,
      addon_ids: state.selectedAddonIds,
      customer_name: $("#c-name").value.trim(),
      customer_email: $("#c-email").value.trim(),
      customer_phone: $("#c-phone").value.trim(),
      delivery_address: $("#c-address").value.trim(),
      delivery_notes: $("#c-delnotes").value.trim(),
      notes: $("#c-notes").value.trim(),
      promo_code: state.promo?.code || null,
      payment_choice: quote ? undefined : choice,
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
    } else if (res.mode === "quote") {
      window.location.href = `/book/confirm.html?ref=${res.reference}&quote=1`;
    }
  } catch (err) {
    alert(err.message);
    btn.disabled = false; btn.textContent = quote ? "Request Quote" : "Book & Pay";
  }
}
