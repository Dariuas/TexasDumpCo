import { adminHandler } from "./_shared/admin";
import { json, badRequest, notFound, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { stripe } from "./_shared/stripe";
import { computeOverageCents } from "./_shared/overage";
import { ensureFixedProduct } from "./_shared/stripe-catalog";
import { sendEmail } from "./_shared/email";
import { overageNoticeHtml } from "./_shared/overage-email";
import { audit } from "./_shared/audit";

export default adminHandler("staff", async (req, user) => {
  if (req.method !== "POST") return badRequest("POST required");
  const body = await readJson<{ booking_id?: string; weight_tons?: number; confirm?: boolean }>(req);
  const weight = Number(body.weight_tons);
  if (!body.booking_id || !Number.isFinite(weight) || weight < 0) return badRequest("booking_id and weight_tons required");
  const db = supabaseAdmin();
  const { data: b } = await db.from("bookings").select("*").eq("id", body.booking_id).maybeSingle();
  if (!b) return notFound("Booking not found");
  if (b.overage_status === "paid") return badRequest("Overage already paid");
  const { data: t } = await db.from("dumpster_types").select("weight_limit_tons,overage_fee_cents").eq("id", b.type_id).maybeSingle();
  const limit = t?.weight_limit_tons != null ? Number(t.weight_limit_tons) : null;
  const overage = computeOverageCents(weight, limit, t?.overage_fee_cents ?? 0);

  if (!body.confirm) return json({ overage_cents: overage, weight_tons: weight, limit_tons: limit });

  await db.from("bookings").update({ weight_tons: weight, overage_cents: overage, overage_status: overage > 0 ? "due" : "none" }).eq("id", b.id);
  if (overage === 0) {
    await audit({ actor: user.email!, action: "overage.none", entity: "bookings", entityId: b.id, detail: { weight } });
    return json({ overage_cents: 0, invoice_url: null });
  }
  if (!b.stripe_customer_id) return badRequest("No Stripe customer on this booking (cash or quote). Collect the overage manually.");
  if (b.overage_invoice_id) return badRequest("An overage invoice already exists. Waive it first to re-bill.");

  const s = stripe();
  const invoice = await s.invoices.create({
    customer: b.stripe_customer_id, collection_method: "send_invoice", days_until_due: 7,
    auto_advance: false, automatic_tax: { enabled: true },
    description: `Weight overage — booking ${b.reference}`,
    metadata: { booking_id: b.id, kind: "overage" },
  });
  await s.invoiceItems.create({
    customer: b.stripe_customer_id, invoice: invoice.id, currency: "usd", quantity: 1,
    description: `Overage: ${weight} tons (limit ${limit}) — ${b.reference}`,
    price_data: { currency: "usd", unit_amount: overage, tax_behavior: "exclusive", product: await ensureFixedProduct("overage", "Weight overage") },
  });
  const final = await s.invoices.finalizeInvoice(invoice.id);
  await db.from("bookings").update({ overage_invoice_id: final.id, overage_invoice_url: final.hosted_invoice_url }).eq("id", b.id);
  // Stripe does not email invoices in test mode, so we send our own notice with the hosted pay link.
  await sendEmail(b.customer_email, `Weight overage — ${b.reference}`,
    overageNoticeHtml({ reference: b.reference, customer_name: b.customer_name, weight_tons: weight, limit_tons: limit ?? 0, amount_cents: overage, pay_url: final.hosted_invoice_url!, has_card: !!b.stripe_payment_method_id }));
  await audit({ actor: user.email!, action: "overage.invoice", entity: "bookings", entityId: b.id, detail: { weight, overage, invoice: final.id } });
  return json({ overage_cents: overage, invoice_url: final.hosted_invoice_url });
});
