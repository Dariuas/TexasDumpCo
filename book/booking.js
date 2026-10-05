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
  contractor: null,        // { number, discount_cents } once verified by the server
  agrLang: "en",
  agreement: null,
  verifyToken: null,
  verified: false,
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
  setupAgreementWidgets();
  $("#c-source").innerHTML += (state.config.referralSources || []).map((x) => `<option>${x}</option>`).join("");
  $("#apply-contractor").addEventListener("click", applyContractor);
  $("#c-email").addEventListener("change", () => { state.contractor = null; $("#contractor-msg").textContent = ""; });
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
      document.querySelectorAll("#duration-list .type-card").forEach((c) => c.classList.toggle("selected", c === card));
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
      document.querySelectorAll("#zone-list .type-card").forEach((c) => c.classList.toggle("selected", c === card));
    }));
}

// ---------- details + add-ons + photos ----------
async function onDetailsNext() {
  const required = [["#c-name", "name"], ["#c-phone", "phone"], ["#c-email", "email"], ["#c-address", "address"]];
  for (const [sel, label] of required) {
    if (!$(sel).value.trim()) { $(sel).focus(); alert(`Please enter your ${label}.`); return; }
  }
  state.timeWindow = $("#time-window").value;
  // Re-check the contractor number now that the item/length are final.
  if ($("#c-contractor").value.trim()) await applyContractor(); else state.contractor = null;
  if ($("#c-contractor").value.trim() && !state.contractor) return; // invalid number: show message, let them fix or clear it
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
const I18N = {
  en: {
    title: "Rental agreement", serviceTitle: "Service agreement", name: "Type your full name to sign", sig: "Draw your signature", clear: "Clear",
    nameHint: "Must match the name on your booking exactly.",
    acks: {
      read: "I read this whole agreement and my order details.",
      weight: "I understand the included weight and that extra weight is charged per ton.",
      prohibited: "I will not load prohibited items, and heavy materials need prior approval.",
      access: "I will keep the delivery and pickup spot clear, or I may be charged a dry-run fee.",
      charges: "I authorize the additional charges listed in Section 6.",
    },
    verifyTitle: "Verify your email", send: "Email me a code", verify: "Verify", resend: "Resend code",
    verifyHelp: "We email a 6-digit code to prove this email address is yours. We also email you a signed copy of this agreement.",
    todo: "To continue:", todoAcks: "tick all 5 boxes", todoName: "type your name exactly as entered on the previous page", todoSig: "draw your signature", todoVerify: "verify your email with the code",
    sent: "Code sent. Check your inbox (and spam).", ok: "Email verified ✓", bad: "That code did not work.",
  },
  es: {
    title: "Contrato de renta", serviceTitle: "Contrato de servicio", name: "Escriba su nombre completo para firmar", sig: "Dibuje su firma", clear: "Borrar",
    nameHint: "Debe coincidir exactamente con el nombre de su reservación.",
    acks: {
      read: "Leí todo este contrato y los detalles de mi pedido.",
      weight: "Entiendo el peso incluido y que el peso adicional se cobra por tonelada.",
      prohibited: "No cargaré artículos prohibidos, y los materiales pesados necesitan aprobación previa.",
      access: "Mantendré libre el lugar de entrega y recolección, o se me puede cobrar una tarifa por viaje fallido.",
      charges: "Autorizo los cargos adicionales indicados en la Sección 6.",
    },
    verifyTitle: "Verifique su correo electrónico", send: "Envíenme un código", verify: "Verificar", resend: "Reenviar código",
    verifyHelp: "Le enviamos un código de 6 dígitos para comprobar que este correo es suyo. También le enviamos una copia firmada de este contrato.",
    todo: "Para continuar:", todoAcks: "marque las 5 casillas", todoName: "escriba su nombre exactamente como lo ingresó en la página anterior", todoSig: "dibuje su firma", todoVerify: "verifique su correo con el código",
    sent: "Código enviado. Revise su bandeja de entrada (y el correo no deseado).", ok: "Correo verificado ✓", bad: "Ese código no funcionó.",
  },
};
const ACK_IDS = ["read", "weight", "prohibited", "access", "charges"];
const t = (k) => I18N[state.agrLang][k];

async function loadAgreement() {
  renderAddons();
  try {
    state.agreement = await api("agreement");
    $("#lang-toggle").hidden = !state.agreement.body_html_es; // no Spanish text yet -> English only
    if (!state.agreement.body_html_es) state.agrLang = "en";
    applyAgreementLang();
  } catch { $("#agreement-body").textContent = "Agreement unavailable. Please call us to book."; }
  $("#verify-wrap").hidden = !state.config.emailVerification;
  $("#name-hint").textContent = t("nameHint");
}
function agreementShown() {
  const a = state.agreement; if (!a) return "";
  return state.agrLang === "es" && a.body_html_es ? a.body_html_es : a.body_html;
}
function applyAgreementLang() {
  $("#agreement-body").innerHTML = agreementShown();
  // The signed template is the dumpster rental text; for crew-hauled services at least show the right title.
  const isRental = (state.category || "").startsWith("roll_off");
  const firstHeading = $("#agreement-body h3");
  if (!isRental && firstHeading) firstHeading.textContent = t("serviceTitle");
  document.querySelectorAll("#lang-toggle button").forEach((b) => b.classList.toggle("active", b.dataset.lang === state.agrLang));
  $("#agr-title").textContent = isRental ? t("title") : t("serviceTitle");
  $("#lbl-name").textContent = t("name");
  $("#lbl-sig").textContent = t("sig");
  $("#sig-clear").textContent = t("clear");
  $("#name-hint").textContent = t("nameHint");
  $("#lbl-verify").textContent = t("verifyTitle");
  $("#verify-help").textContent = t("verifyHelp");
  $("#send-code").textContent = state.verifyToken ? t("resend") : t("send");
  $("#check-code").textContent = t("verify");
  const ticked = new Set([...document.querySelectorAll("#acks input:checked")].map((i) => i.value));
  $("#acks").innerHTML = ACK_IDS.map((id) =>
    `<label class="check"><input type="checkbox" value="${id}" ${ticked.has(id) ? "checked" : ""}> ${t("acks")[id]}</label>`).join("");
  $("#acks").querySelectorAll("input").forEach((i) => i.addEventListener("change", validateAgreement));
  validateAgreement();
}

// signature pad (pointer events work for mouse, touch and pen)
let sigInk = false;
function setupAgreementWidgets() {
  document.querySelectorAll("#lang-toggle button").forEach((b) => b.addEventListener("click", () => {
    state.agrLang = b.dataset.lang; applyAgreementLang();
  }));
  const cv = $("#sig-canvas"), ctx = cv.getContext("2d");
  ctx.lineWidth = 3; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#111";
  let drawing = false;
  const pos = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * (cv.width / r.width), (e.clientY - r.top) * (cv.height / r.height)]; };
  cv.addEventListener("pointerdown", (e) => { drawing = true; cv.setPointerCapture(e.pointerId); const [x, y] = pos(e); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 0.01, y); ctx.stroke(); sigInk = true; validateAgreement(); });
  cv.addEventListener("pointermove", (e) => { if (!drawing) return; const [x, y] = pos(e); ctx.lineTo(x, y); ctx.stroke(); });
  const end = () => { drawing = false; };
  cv.addEventListener("pointerup", end); cv.addEventListener("pointercancel", end);
  $("#sig-clear").addEventListener("click", () => { ctx.clearRect(0, 0, cv.width, cv.height); sigInk = false; validateAgreement(); });

  // email verification
  let cooldown = 0;
  $("#send-code").addEventListener("click", async () => {
    const btn = $("#send-code"), msg = $("#verify-msg");
    if (cooldown > 0) return;
    btn.disabled = true; msg.className = "promo-msg"; msg.textContent = "…";
    try {
      const r = await api("agreement-verify-send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: $("#c-email").value.trim(), lang: state.agrLang }) });
      state.verifyToken = r.token; state.verified = false;
      $("#verify-code").disabled = false; $("#check-code").disabled = false; $("#verify-code").focus();
      msg.className = "promo-msg ok"; msg.textContent = t("sent");
      cooldown = 30; btn.textContent = `${t("resend")} (${cooldown})`;
      const iv = setInterval(() => { cooldown--; if (cooldown <= 0) { clearInterval(iv); btn.disabled = false; btn.textContent = t("resend"); } else btn.textContent = `${t("resend")} (${cooldown})`; }, 1000);
    } catch (err) { btn.disabled = false; msg.className = "promo-msg no"; msg.textContent = err.message; }
    validateAgreement();
  });
  $("#check-code").addEventListener("click", async () => {
    const msg = $("#verify-msg");
    try {
      await api("agreement-verify-check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: $("#c-email").value.trim(), code: $("#verify-code").value.trim(), token: state.verifyToken }) });
      state.verified = true; msg.className = "promo-msg ok"; msg.textContent = t("ok");
    } catch { state.verified = false; msg.className = "promo-msg no"; msg.textContent = t("bad"); }
    validateAgreement();
  });
}
function validateAgreement() {
  const acksOk = ACK_IDS.every((id) => document.querySelector(`#acks input[value="${id}"]`)?.checked);
  const nameOk = $("#sign-name").value.trim().toLowerCase() === $("#c-name").value.trim().toLowerCase() && $("#sign-name").value.trim() !== "";
  const verifyOk = !state.config.emailVerification || state.verified;
  $("#to-payment").disabled = !(acksOk && nameOk && sigInk && verifyOk);
  const todo = [!acksOk && t("todoAcks"), !nameOk && t("todoName"), !sigInk && t("todoSig"), !verifyOk && t("todoVerify")].filter(Boolean);
  $("#agr-todo").textContent = todo.length ? `${t("todo")} ${todo.join("; ")}.` : "";
}

// contractor number -> server confirms it is approved for this email and returns the discount
async function applyContractor() {
  const msg = $("#contractor-msg"), number = $("#c-contractor").value.trim();
  if (!number) { state.contractor = null; msg.textContent = ""; return; }
  if (!$("#c-email").value.trim()) { msg.className = "promo-msg no"; msg.textContent = "Enter your email above first."; return; }
  try {
    const r = await api("contractor-quote", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ contractor_number: number, email: $("#c-email").value.trim(), type_id: state.type.id, rental_days: state.days }) });
    state.contractor = { number: r.contractor_number, discount_cents: r.discount_cents };
    msg.className = "promo-msg ok"; msg.textContent = r.discount_cents ? `Contractor pricing applied (−${money(r.discount_cents)}).` : "Approved contractor — no contractor discount for this item.";
  } catch (err) { state.contractor = null; msg.className = "promo-msg no"; msg.textContent = err.message; }
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
  const contractorOff = state.contractor?.discount_cents || 0;
  const discount = Math.min(subtotal, (state.promo ? state.promo.discount_cents : 0) + contractorOff);
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
  $("#stripe-note").hidden = quote;
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
    <div class="line total"><span>${quote ? "Estimated total (before tax)" : "Total"}</span><span>${quote ? money(q.total - q.tax) + "+" : money(q.total)}</span></div>
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
      agreement_lang: state.agrLang,
      agreement_signature: $("#sig-canvas").toDataURL("image/png"),
      agreement_ack: [...document.querySelectorAll("#acks input:checked")].map((i) => i.value),
      verify_token: state.verifyToken,
      verify_code: $("#verify-code").value.trim(),
      referral_source: $("#c-source").value || undefined,
      contractor_number: state.contractor?.number || undefined,
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
