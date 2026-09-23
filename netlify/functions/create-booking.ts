import { withErrors, json, badRequest, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { getUser } from "./_shared/auth";
import { stripe } from "./_shared/stripe";
import { siteUrl } from "./_shared/env";
import { loadSettings, bool, num } from "./_shared/settings";
import { buildQuote, DumpsterType, PromoRow } from "./_shared/pricing";
import { typeAvailability } from "./_shared/availability";
import { sendEmail, adminAlertHtml } from "./_shared/email";
import { optionalEnv } from "./_shared/env";

const HOLD_MINUTES = 30;

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
}

function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Creates a PENDING booking + a Stripe Checkout session (card) or a
// cash-pending booking awaiting admin approval. Totals are recomputed
// server-side — client-sent prices are never trusted.
export default withErrors(async (req: Request) => {
  if (req.method !== "POST") return badRequest("POST required");
  const body = await readJson<Body>(req);
  const db = supabaseAdmin();
  const settings = await loadSettings();

  // ---- validate required fields ----
  const required: (keyof Body)[] = [
    "type_id", "start_date", "customer_name", "customer_email", "customer_phone",
    "delivery_address", "payment_choice", "agreement_signed_name",
  ];
  for (const f of required) if (!body[f]) return badRequest(`${f} is required`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.start_date!)) return badRequest("start_date must be YYYY-MM-DD");

  // ---- load type ----
  const { data: type, error: typeErr } = await db
    .from("dumpster_types").select("*").eq("id", body.type_id).eq("active", true).maybeSingle();
  if (typeErr) throw new Error(typeErr.message);
  if (!type) return badRequest("Selected item is not available");
  const t = type as DumpsterType & { name: string };

  // ---- date window guards ----
  const leadDays = num(settings, "lead_time_days", 1);
  const windowDays = num(settings, "booking_window_days", 120);
  const today = new Date().toISOString().slice(0, 10);
  const earliest = addDays(today, leadDays);
  const latest = addDays(today, windowDays);
  if (body.start_date! < earliest) return badRequest(`Earliest available date is ${earliest}`);
  if (body.start_date! > latest) return badRequest(`Bookings open only through ${latest}`);

  const rentalDays = Math.max(1, Number(body.rental_days ?? t.rental_days_included));
  const startDate = body.start_date!;
  const endDate = addDays(startDate, rentalDays - 1);

  // ---- availability ----
  const available = await typeAvailability(t.id, startDate, endDate);
  if (available <= 0) return badRequest("That item is fully booked for the selected dates");

  // ---- promo ----
  let promo: PromoRow | null = null;
  if (body.promo_code) {
    const { data } = await db.from("promo_codes").select("*").ilike("code", body.promo_code.trim()).maybeSingle();
    promo = (data as PromoRow) ?? null;
  }

  // ---- authoritative quote ----
  const quote = buildQuote(t, { rentalDays, promo }, settings);

  // ---- payment choice ----
  const choice = body.payment_choice!;
  if (choice === "cash" && !bool(settings, "cash_accepted", false)) {
    return badRequest("Cash payment is not currently available");
  }
  const method = choice === "cash" ? "cash" : "card";
  const chargeNow =
    choice === "card_full" ? quote.amount_total_cents :
    choice === "card_deposit" ? quote.deposit_cents : 0;

  // ---- optional logged-in customer ----
  const user = await getUser(req);

  // ---- create pending booking ----
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
    payment_method: method,
    payment_status: choice === "cash" ? "cash_pending" : "unpaid",
    subtotal_cents: quote.subtotal_cents,
    discount_cents: quote.discount_cents,
    tax_cents: quote.tax_cents,
    amount_total_cents: quote.amount_total_cents,
    amount_paid_cents: 0,
    deposit_cents: quote.deposit_cents,
    promo_code_id: promo?.id ?? null,
    agreement_version: null,
    agreement_signed_name: body.agreement_signed_name,
    agreement_signed_at: new Date().toISOString(),
    agreement_signed_ip: req.headers.get("x-nf-client-connection-ip") ?? req.headers.get("x-forwarded-for"),
    hold_expires_at: new Date(Date.now() + HOLD_MINUTES * 60_000).toISOString(),
  }).select().single();
  if (bErr) throw new Error(bErr.message);

  // snapshot agreement version
  const { data: agr } = await db.from("agreement_templates").select("version").eq("active", true).maybeSingle();
  if (agr) await db.from("bookings").update({ agreement_version: agr.version }).eq("id", booking.id);

  // attach uploaded photos
  if (Array.isArray(body.photos) && body.photos.length) {
    await db.from("booking_photos").insert(
      body.photos.map((p) => ({
        booking_id: booking.id,
        kind: (p.kind as string) ?? "junk_items",
        storage_path: p.path,
        uploaded_by: "customer",
      })),
    );
  }

  // ---- cash path: no charge, await approval ----
  if (choice === "cash") {
    const alertTo = optionalEnv("ADMIN_ALERT_EMAIL");
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
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    customer_email: body.customer_email,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: chargeNow,
        product_data: {
          name: choice === "card_deposit" ? `Deposit — ${t.name}` : t.name,
          description: `${startDate} to ${endDate} · Booking ${booking.reference}`,
        },
      },
    }],
    metadata: {
      booking_id: booking.id,
      charge_kind: choice === "card_deposit" ? "deposit" : "full",
    },
    success_url: `${siteUrl()}/book/confirm.html?ref=${booking.reference}`,
    cancel_url: `${siteUrl()}/book/?canceled=${booking.reference}`,
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
  });

  await db.from("bookings").update({ stripe_checkout_session_id: session.id }).eq("id", booking.id);

  return json({ mode: "card", checkout_url: session.url, reference: booking.reference, booking_id: booking.id });
});
