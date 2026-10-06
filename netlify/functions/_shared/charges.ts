import Stripe from "stripe";
import { supabaseAdmin } from "./supabase";
import { stripe } from "./stripe";
import { loadSettings, num } from "./settings";
import { ensureFixedProduct, ensureTaxRate, productIdForType } from "./stripe-catalog";
import { ChargeKind, ChargeLine, priceLines, lineTax, CHARGE_KINDS } from "./charge-math";
export { priceLines, lineTax, CHARGE_KINDS };
export type { ChargeKind, ChargeLine };

// Itemized charges on a booking (table booking_charges). "initial" lines are the priced
// quote the customer pays first (Checkout pay link, card saved for later); "adjustment"
// lines are added after the job (weight overage, extra miles/days, fees) and billed on
// a Stripe invoice that is charged to the saved card or emailed as a pay link.

export interface ChargeRow extends ChargeLine {
  id: string;
  booking_id: string;
  amount_cents: number;
  tax_cents: number;
  taxable: boolean;
  stage: "initial" | "adjustment";
  status: "draft" | "invoiced" | "paid" | "void" | "waived" | "external";
  stripe_invoice_id: string | null;
}

const LIVE = (r: { status: string }) => r.status !== "void" && r.status !== "waived";

export async function taxBpsFor(booking: { tax_exempt?: boolean | null }): Promise<number> {
  return booking.tax_exempt ? 0 : num(await loadSettings(), "tax_rate_bps", 0);
}

export async function listCharges(bookingId: string): Promise<ChargeRow[]> {
  const { data, error } = await supabaseAdmin().from("booking_charges").select("*").eq("booking_id", bookingId).order("created_at");
  if (error) throw new Error(error.message);
  return (data ?? []) as ChargeRow[];
}

// Booking totals follow its charge lines once it has any.
export async function syncTotals(bookingId: string): Promise<void> {
  const rows = (await listCharges(bookingId)).filter(LIVE);
  if (!rows.length) return;
  const sum = (f: (r: ChargeRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  const { error } = await supabaseAdmin().from("bookings").update({
    subtotal_cents: sum((r) => (r.amount_cents > 0 && r.kind !== "mileage" ? r.amount_cents : 0)),
    distance_fee_cents: sum((r) => (r.kind === "mileage" ? r.amount_cents : 0)),
    discount_cents: -sum((r) => (r.amount_cents < 0 ? r.amount_cents : 0)),
    tax_cents: sum((r) => r.tax_cents),
    amount_total_cents: sum((r) => r.amount_cents + r.tax_cents),
  }).eq("id", bookingId);
  if (error) throw new Error(error.message);
}

// The first adjustment on a booking that was paid/priced the normal way: record the
// original amount as one "external" (or paid) line so the booking total stays right.
export async function ensureBaseline(booking: any, typeName: string, actor: string): Promise<void> {
  const rows = await listCharges(booking.id);
  if (rows.some((r) => r.stage === "initial")) return;
  const pretax = booking.amount_total_cents - (booking.tax_cents ?? 0);
  if (pretax <= 0) return;
  const { error } = await supabaseAdmin().from("booking_charges").insert({
    booking_id: booking.id, kind: "rental", description: `${typeName} ${booking.start_date} to ${booking.end_date} (original booking)`,
    quantity: 1, unit_cents: pretax, amount_cents: pretax, taxable: (booking.tax_cents ?? 0) > 0, tax_cents: booking.tax_cents ?? 0,
    stage: "initial", status: booking.payment_status === "paid" ? "paid" : "external", created_by: actor,
  });
  if (error) throw new Error(error.message);
}

// Stripe customer for the booking (phone/quote customers never went through checkout).
export async function ensureCustomer(booking: any): Promise<string> {
  if (booking.stripe_customer_id) return booking.stripe_customer_id;
  const customer = await stripe().customers.create({
    email: booking.customer_email || undefined, name: booking.customer_name, phone: booking.customer_phone,
    address: { line1: booking.delivery_address, state: "TX", country: "US" },
    tax_exempt: booking.tax_exempt ? "exempt" : "none",
    metadata: { booking_id: booking.id },
  });
  await supabaseAdmin().from("bookings").update({ stripe_customer_id: customer.id }).eq("id", booking.id);
  return customer.id;
}

async function productFor(kind: ChargeKind, typeId: string): Promise<string> {
  switch (kind) {
    case "rental": return productIdForType(typeId);
    case "mileage": return ensureFixedProduct("distance_fee", "Delivery mileage");
    case "weight": return ensureFixedProduct("overage", "Weight overage");
    case "extra_days": return ensureFixedProduct("extra_days", "Extra rental days");
    case "fee": return ensureFixedProduct("service_fee", "Service fee");
    default: return ensureFixedProduct("custom_charge", "Other charge");
  }
}

// Checkout pay link for the open initial lines. Saves the card for later adjustments
// and has Stripe issue an invoice/receipt. Discount lines become a one-time coupon
// (Checkout lines can't be negative).
export async function createPayLink(booking: any, rows: ChargeRow[], successUrl: string, cancelUrl: string): Promise<Stripe.Checkout.Session> {
  const s = stripe();
  const taxBps = await taxBpsFor(booking);
  const taxRate = taxBps ? await ensureTaxRate(taxBps) : null;
  const positive = rows.filter((r) => r.amount_cents > 0);
  const discount = -rows.filter((r) => r.amount_cents < 0).reduce((t, r) => t + r.amount_cents, 0);
  if (!positive.length) throw new Error("Nothing to charge");
  const line_items: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
  for (const r of positive) {
    line_items.push({
      quantity: 1,
      price_data: { currency: "usd", unit_amount: r.amount_cents, tax_behavior: "exclusive", product: await productFor(r.kind, booking.type_id) },
      ...(taxRate && r.taxable ? { tax_rates: [taxRate] } : {}),
    });
  }
  let discounts: Stripe.Checkout.SessionCreateParams.Discount[] | undefined;
  if (discount > 0) {
    const coupon = await s.coupons.create({ amount_off: discount, currency: "usd", duration: "once", name: `Discount ${booking.reference}`.slice(0, 40), max_redemptions: 1 });
    discounts = [{ coupon: coupon.id }];
  }
  const customer = await ensureCustomer(booking);
  return s.checkout.sessions.create({
    mode: "payment",
    customer,
    billing_address_collection: "required",
    payment_intent_data: { setup_future_usage: "off_session", description: `Booking ${booking.reference}` },
    invoice_creation: { enabled: true, invoice_data: { description: `Booking ${booking.reference}`, metadata: { booking_id: booking.id } } },
    line_items,
    ...(discounts ? { discounts } : {}),
    metadata: { booking_id: booking.id, kind: "charges" },
    success_url: successUrl,
    cancel_url: cancelUrl,
    expires_at: Math.floor(Date.now() / 1000) + 23 * 60 * 60,
  });
}

// One Stripe invoice for the given adjustment lines (finalized, not yet paid).
export async function createAdjustmentInvoice(booking: any, rows: ChargeRow[]): Promise<Stripe.Invoice> {
  const s = stripe();
  const customer = await ensureCustomer(booking);
  const taxBps = await taxBpsFor(booking);
  const taxRate = taxBps ? await ensureTaxRate(taxBps) : null;
  const draft = await s.invoices.create({
    customer, collection_method: "send_invoice", days_until_due: 7, auto_advance: false,
    description: `Additional charges — booking ${booking.reference}`,
    metadata: { booking_id: booking.id, kind: "adjustment" },
  });
  for (const r of rows) {
    await s.invoiceItems.create({
      customer, invoice: draft.id, currency: "usd", quantity: 1,
      description: `${r.description} — ${booking.reference}`,
      price_data: { currency: "usd", unit_amount: r.amount_cents, tax_behavior: "exclusive", product: await productFor(r.kind, booking.type_id) },
      tax_rates: taxRate && r.taxable ? [taxRate] : [],
    });
  }
  const invoice = await s.invoices.finalizeInvoice(draft.id);
  await supabaseAdmin().from("booking_charges").update({ status: "invoiced", stripe_invoice_id: invoice.id }).in("id", rows.map((r) => r.id));
  return invoice;
}

export function chargesTableHtml(rows: { description: string; amount_cents: number; tax_cents: number }[]): string {
  const money = (c: number) => `${c < 0 ? "−" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;
  const tax = rows.reduce((t, r) => t + r.tax_cents, 0);
  const total = rows.reduce((t, r) => t + r.amount_cents + r.tax_cents, 0);
  const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]!));
  return `<table style="width:100%;border-collapse:collapse;font-size:14px">
    ${rows.map((r) => `<tr><td style="padding:6px 0;border-bottom:1px solid #eee">${esc(r.description)}</td><td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right">${money(r.amount_cents)}</td></tr>`).join("")}
    ${tax ? `<tr><td style="padding:6px 0">Sales tax</td><td style="padding:6px 0;text-align:right">${money(tax)}</td></tr>` : ""}
    <tr><td style="padding:8px 0;font-weight:bold">Total</td><td style="padding:8px 0;text-align:right;font-weight:bold">${money(total)}</td></tr>
  </table>`;
}
