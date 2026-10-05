import type { Config } from "@netlify/functions";
import { withErrors, json, badRequest, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { getUser } from "./_shared/auth";
import { stripe } from "./_shared/stripe";
import { productIdForType, productIdForAddon, ensureFixedProduct, ensureTaxRate } from "./_shared/stripe-catalog";
import { siteUrl } from "./_shared/env";
import { loadSettings, bool, num } from "./_shared/settings";
import { buildQuote, contractorDiscountCents, likeLiteral, DumpsterType, PromoRow, DurationTier, AddonSelection, DistanceZone } from "./_shared/pricing";
import { checkChallenge, agreementHash } from "./_shared/agreement-verify";
import { typeAvailability } from "./_shared/availability";
import { sendEmail, adminAlertHtml, adminAlertTo } from "./_shared/email";
import { optionalEnv } from "./_shared/env";

const HOLD_MINUTES = 30;
const esc = (s: string) => s.replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]!));

interface Photo { path: string; kind?: string }
interface Body {
  type_id?: string;
  rental_days?: number;
  start_date?: string;
  time_window?: string;
  customer_name?: string;
  customer_email?: string;
  customer_phone?: string;
  delivery_address?: string;
  delivery_notes?: string;
  notes?: string;
  promo_code?: string;
  payment_choice?: "card_full" | "card_deposit" | "cash";
  agreement_signed_name?: string;
  photos?: Photo[];
  addon_ids?: string[];
  distance_zone?: string;
  referral_source?: string;
  contractor_number?: string;
  agreement_lang?: "en" | "es";
  agreement_signature?: string;   // drawn signature, PNG data URL
  agreement_ack?: string[];       // ids of acknowledgements the customer ticked
  verify_token?: string;          // from agreement-verify-send
  verify_code?: string;           // 6-digit code from the customer's email
}

// Every acknowledgement the form shows must come back ticked.
const REQUIRED_ACKS = ["read", "weight", "prohibited", "access", "charges"];

function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Creates a booking and either:
//  - a Stripe Checkout session (card, priced service), or
//  - a cash-pending booking awaiting admin approval, or
//  - a quote-request (quote_only service, or a 35+ mile delivery) that is
//    NEVER charged automatically — it lands in the admin for a staff member
//    to price by phone, exactly as the source pricing guide operates for
//    cleanouts, heavy material, and contractor work.
// Totals are always recomputed server-side; client-sent prices are never trusted.
export default withErrors(async (req: Request) => {
  if (req.method !== "POST") return badRequest("POST required");
  const body = await readJson<Body>(req);
  const db = supabaseAdmin();
  const settings = await loadSettings();

  // ---- validate required fields ----
  const required: (keyof Body)[] = [
    "type_id", "start_date", "customer_name", "customer_email", "customer_phone",
    "delivery_address", "agreement_signed_name",
  ];
  for (const f of required) if (!body[f]) return badRequest(`${f} is required`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.start_date!)) return badRequest("start_date must be YYYY-MM-DD");

  // ---- agreement verification: typed name + drawn signature + ticked acknowledgements,
  // email-code proof of ownership, and a stored tamper-evident hash. ----
  const lang = body.agreement_lang === "es" ? "es" : "en";
  if (body.agreement_signed_name!.trim().toLowerCase() !== body.customer_name!.trim().toLowerCase()) {
    return badRequest("The name you sign with must match the customer name exactly");
  }
  const acks = Array.isArray(body.agreement_ack) ? body.agreement_ack : [];
  if (!REQUIRED_ACKS.every((a) => acks.includes(a))) return badRequest("Please confirm every acknowledgement");
  const sig = body.agreement_signature ?? "";
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sig) || sig.length < 800 || sig.length > 400_000) {
    return badRequest("A drawn signature is required");
  }
  // Enforced whenever email can actually be delivered (RESEND_API_KEY set), so a
  // missing mail config never locks every customer out of booking.
  if (optionalEnv("RESEND_API_KEY") && !checkChallenge(body.customer_email!, body.verify_code ?? "", body.verify_token ?? "")) {
    return badRequest("Email verification code is missing, wrong or expired");
  }

  // ---- load type ----
  const { data: type, error: typeErr } = await db
    .from("dumpster_types").select("*").eq("id", body.type_id).eq("active", true).maybeSingle();
  if (typeErr) throw new Error(typeErr.message);
  if (!type) return badRequest("Selected item is not available");
  const t = type as DumpsterType & { name: string };

  // ---- date window guards ----
  const leadDays = num(settings, "lead_time_days", 1);
  const windowDays = num(settings, "booking_window_days", 120);
  // Business runs on Central time; UTC would roll "today" forward each evening.
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const earliest = addDays(today, leadDays);
  const latest = addDays(today, windowDays);
  if (body.start_date! < earliest) return badRequest(`Earliest available date is ${earliest}`);
  if (body.start_date! > latest) return badRequest(`Bookings open only through ${latest}`);

  // ---- duration tiers (if applicable) ----
  let tiers: DurationTier[] = [];
  if (t.pricing_mode === "duration_tiers") {
    const { data } = await db.from("duration_price_tiers").select("days,price_cents,label").eq("type_id", t.id);
    tiers = data ?? [];
  }
  const rentalDays = Number(body.rental_days ?? t.rental_days_included);
  if (!Number.isInteger(rentalDays) || rentalDays < 1 || rentalDays > 365) {
    return badRequest("rental_days must be a whole number from 1 to 365");
  }
  const startDate = body.start_date!;
  const endDate = addDays(startDate, rentalDays - 1);

  // ---- availability: only for physically-inventoried services (roll-offs) ----
  if (t.uses_inventory) {
    const available = await typeAvailability(t.id, startDate, endDate, true);
    if (available <= 0) return badRequest("That item is fully booked for the selected dates");
  }

  // ---- add-ons ----
  let addons: AddonSelection[] = [];
  if (Array.isArray(body.addon_ids) && body.addon_ids.length) {
    const { data } = await db.from("addon_items").select("id,name,price_cents").in("id", body.addon_ids).eq("active", true);
    addons = (data ?? []).map((a) => ({ id: a.id, name: a.name, price_cents: a.price_cents, qty: 1 }));
  }

  // ---- distance zone ----
  let distanceZone: DistanceZone | null = null;
  const zones = (settings["distance_zones"] as DistanceZone[]) ?? [];
  if (body.distance_zone) {
    distanceZone = zones.find((z) => z.code === body.distance_zone) ?? null;
    if (!distanceZone) return badRequest("Unknown delivery distance zone");
  }

  // ---- promo ----
  let promo: PromoRow | null = null;
  if (body.promo_code) {
    const { data } = await db.from("promo_codes").select("*").ilike("code", likeLiteral(body.promo_code.trim())).maybeSingle();
    promo = (data as PromoRow) ?? null;
  }

  // ---- approved contractor (number + matching email, status approved) ----
  let contractorId: string | null = null;
  let contractorDiscount = 0;
  if (body.contractor_number?.trim()) {
    const { data: c } = await db.from("contractors").select("id,email,status")
      .eq("contractor_number", body.contractor_number.trim().toUpperCase()).maybeSingle();
    if (!c || c.status !== "approved" || c.email.toLowerCase() !== body.customer_email!.trim().toLowerCase()) {
      return badRequest("Contractor number not recognized or not approved yet for this email");
    }
    contractorId = c.id;
    contractorDiscount = contractorDiscountCents((t as any).category, rentalDays, tiers, settings);
  }

  // ---- authoritative quote ----
  const quote = buildQuote(t, { rentalDays, promo, tiers, addons, distanceZone, extraDiscountCents: contractorDiscount }, settings);

  // ---- payment choice ----
  const choice = quote.needs_quote ? null : body.payment_choice;
  if (!quote.needs_quote && !choice) return badRequest("payment_choice is required");
  if (choice === "cash" && !bool(settings, "cash_accepted", false)) {
    return badRequest("Cash payment is not currently available");
  }
  const method = choice === "cash" ? "cash" : "card";

  // ---- optional logged-in customer ----
  const user = await getUser(req);

  // ---- create booking ----
  const { data: booking, error: bErr } = await db.from("bookings").insert({
    service: t.service,
    user_id: user?.id ?? null,
    customer_name: body.customer_name,
    customer_email: body.customer_email,
    customer_phone: body.customer_phone,
    delivery_address: body.delivery_address,
    delivery_notes: body.delivery_notes ?? null,
    notes: body.notes ?? null,
    type_id: t.id,
    start_date: startDate,
    end_date: endDate,
    time_window: body.time_window ?? null,
    status: "pending",
    payment_method: quote.needs_quote ? "card" : method,
    payment_status: quote.needs_quote ? "unpaid" : (choice === "cash" ? "cash_pending" : "unpaid"),
    subtotal_cents: quote.subtotal_cents,
    addon_cents: quote.addon_cents,
    distance_zone: distanceZone?.code ?? null,
    distance_fee_cents: quote.distance_fee_cents,
    discount_cents: quote.discount_cents,
    tax_cents: quote.tax_cents,
    amount_total_cents: quote.amount_total_cents,
    amount_paid_cents: 0,
    deposit_cents: quote.deposit_cents,
    promo_code_id: promo?.id ?? null,
    agreement_version: null,
    agreement_signed_name: body.agreement_signed_name,
    agreement_signed_at: new Date().toISOString(),
    referral_source: body.referral_source?.slice(0, 80) ?? null,
    contractor_id: contractorId,
    agreement_lang: lang,
    agreement_signature: sig,
    agreement_ack: acks,
    agreement_user_agent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
    agreement_verified_at: optionalEnv("RESEND_API_KEY") ? new Date().toISOString() : null,
    agreement_signed_ip: req.headers.get("x-nf-client-connection-ip") ?? req.headers.get("x-forwarded-for"),
    flags: quote.needs_quote ? ["quote_requested"] : [],
    // Only card checkouts hold inventory for HOLD_MINUTES; cash waits for staff approval
    // and must not be auto-canceled by expire-holds before anyone looks at it.
    hold_expires_at: quote.needs_quote || choice === "cash" ? null : new Date(Date.now() + HOLD_MINUTES * 60_000).toISOString(),
  }).select().single();
  if (bErr) throw new Error(bErr.message);

  // snapshot agreement version
  const { data: agr } = await db.from("agreement_templates").select("version,body_html,body_html_es").eq("active", true).maybeSingle();
  if (agr) {
    const shown = lang === "es" && agr.body_html_es ? agr.body_html_es : agr.body_html;
    const hash = agreementHash({ version: agr.version, lang, html: shown, name: body.agreement_signed_name!, email: body.customer_email! });
    await db.from("bookings").update({ agreement_version: agr.version, agreement_body_hash: hash }).eq("id", booking.id);
    await sendEmail(body.customer_email!,
      lang === "es" ? `Copia de su contrato firmado — ${booking.reference}` : `Your signed rental agreement — ${booking.reference}`,
      `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto">
         <p>${lang === "es" ? "Gracias. Esta es su copia del contrato que firmó." : "Thanks. Here is your copy of the agreement you signed."}</p>
         <p><strong>${lang === "es" ? "Firmado por" : "Signed by"}:</strong> ${esc(body.agreement_signed_name!)}<br>
            <strong>${lang === "es" ? "Fecha" : "Date"}:</strong> ${new Date().toISOString()}<br>
            <strong>${lang === "es" ? "Referencia" : "Reference"}:</strong> ${booking.reference} · v${agr.version}<br>
            <strong>SHA-256:</strong> <span style="font-family:monospace;font-size:11px">${hash}</span></p>
         <img src="${sig}" alt="signature" style="max-width:300px;border:1px solid #ccc">
         <hr>${shown}
       </div>`);
  }

  // attach add-ons (snapshot name/price so later catalog edits don't rewrite history)
  if (addons.length) {
    await db.from("booking_addons").insert(
      addons.map((a) => ({ booking_id: booking.id, name: a.name, price_cents: a.price_cents, qty: a.qty })),
    );
  }

  // attach uploaded photos
  // Only paths minted by upload-url, and only kinds a customer may set.
  const photos = (Array.isArray(body.photos) ? body.photos : [])
    .filter((p) => typeof p?.path === "string" && /^uploads\/[0-9a-f-]{36}\/[A-Za-z0-9._-]+$/.test(p.path))
    .slice(0, 20);
  if (photos.length) {
    const { error: photoErr } = await db.from("booking_photos").insert(
      photos.map((p) => ({
        booking_id: booking.id,
        kind: p.kind === "delivery_site" || p.kind === "other" ? p.kind : "junk_items",
        storage_path: p.path,
        uploaded_by: "customer",
      })),
    );
    if (photoErr) console.error("[create-booking] photos not attached:", photoErr.message);
  }

  const alertTo = await adminAlertTo();

  // ---- quote-request path: cleanouts, heavy material, contractor-style jobs,
  // or any 35+ mile delivery. Never charged automatically. ----
  if (quote.needs_quote) {
    if (alertTo) {
      await sendEmail(alertTo, `Quote requested — ${booking.reference}`,
        adminAlertHtml({
          reference: booking.reference, customer_name: booking.customer_name,
          customer_phone: booking.customer_phone, typeName: t.name,
          start_date: startDate, payment_method: "card", payment_status: "quote_requested",
        }));
    }
    return json({ mode: "quote", reference: booking.reference, booking_id: booking.id });
  }

  // ---- cash path: no charge, await approval ----
  if (choice === "cash") {
    if (alertTo) {
      await sendEmail(alertTo, `Cash booking ${booking.reference} needs approval`,
        adminAlertHtml({
          reference: booking.reference, customer_name: booking.customer_name,
          customer_phone: booking.customer_phone, typeName: t.name,
          start_date: startDate, payment_method: "cash", payment_status: "cash_pending",
        }));
    }
    return json({ mode: "cash", reference: booking.reference, booking_id: booking.id });
  }

  // ---- card path: Stripe Checkout ----
  // Line items reference catalog Products (so Stripe reports group by item) with our
  // computed pre-tax amounts (so promos, contractor discounts and deposits still work).
  // Sales tax is a separate Stripe Tax Rate from the tax_rate_bps setting, so Checkout,
  // the receipt and the dashboard show "Subtotal" and "Sales Tax" as their own lines.
  const taxBps = num(settings, "tax_rate_bps", 0);
  const taxRate = await ensureTaxRate(taxBps);
  const exclusive = (product: string, unit_amount: number) => ({
    quantity: 1,
    price_data: { currency: "usd" as const, unit_amount, tax_behavior: "exclusive" as const, product },
    ...(taxRate ? { tax_rates: [taxRate] } : {}),
  });
  const lines: ReturnType<typeof exclusive>[] = [];
  if (choice === "card_deposit") {
    // The quoted deposit already includes tax; charge its pre-tax part so deposit + tax = quoted deposit.
    const depositPreTax = Math.round((quote.deposit_cents * 10000) / (10000 + taxBps));
    lines.push(exclusive(await ensureFixedProduct("deposit", "Booking deposit"), depositPreTax));
  } else {
    const separateAddons = addons.filter((a) => a.id);
    const separateTotal = separateAddons.reduce((s, a) => s + a.price_cents * a.qty, 0);
    const mainNet = Math.max(0, quote.subtotal_cents - separateTotal - quote.discount_cents);
    lines.push(exclusive(await productIdForType(t.id), mainNet));
    for (const a of separateAddons) lines.push(exclusive(await productIdForAddon(a.id!), a.price_cents * a.qty));
    if (quote.distance_fee_cents) lines.push(exclusive(await ensureFixedProduct("distance_fee", "Distance fee"), quote.distance_fee_cents));
  }

  // If Stripe rejects the session, release the hold now instead of blocking the dates for 30 minutes.
  let session;
  try {
    session = await stripe().checkout.sessions.create({
    mode: "payment",
    customer_email: body.customer_email,
    customer_creation: "always",
    billing_address_collection: "required",
    payment_intent_data: { setup_future_usage: "off_session", description: `${t.name} ${startDate} to ${endDate} · Booking ${booking.reference}` },
    line_items: lines,
    metadata: {
      booking_id: booking.id,
      charge_kind: choice === "card_deposit" ? "deposit" : "full",
    },
    success_url: `${siteUrl()}/book/confirm.html?ref=${booking.reference}`,
    cancel_url: `${siteUrl()}/book/?canceled=${booking.reference}&b=${booking.id}`,
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    });
  } catch (err) {
    await db.from("bookings").update({ status: "canceled", hold_expires_at: null }).eq("id", booking.id);
    console.error("[create-booking] checkout session failed:", (err as Error).message);
    return json({ error: "Card checkout is unavailable right now. Please try again or call (512) 337-4340." }, 502);
  }

  await db.from("bookings").update({ stripe_checkout_session_id: session.id }).eq("id", booking.id);

  return json({ mode: "card", checkout_url: session.url, reference: booking.reference, booking_id: booking.id });
});

// Abuse guard: per-IP limit, enforced by Netlify before the function runs.
export const config: Config = { rateLimit: { windowLimit: 10, windowSize: 60, aggregateBy: ["ip", "domain"] } } as Config; // windowLimit postdates the installed @netlify/functions types
