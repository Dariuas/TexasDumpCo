import { adminHandler } from "./_shared/admin";
import { json, badRequest, notFound, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { stripe } from "./_shared/stripe";
import { ensureFixedProduct, ensureTaxRate } from "./_shared/stripe-catalog";
import { loadSettings, num } from "./_shared/settings";
import { assignUnitAndConfirm } from "./_shared/confirm";
import { syncBookingEvent } from "./_shared/booking-calendar";
import { sendEmail, esc, bookingConfirmationHtml } from "./_shared/email";
import { audit } from "./_shared/audit";

interface Body {
  booking_id?: string;
  action?: "finalize_quote" | "send_link" | "charge_card";
  amount_cents?: number; // finalize_quote: agreed price before tax
}

const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;

// Pre-tax amount still owed. A Stripe deposit was charged as deposit_cents
// before tax; anything recorded by hand (phone bookings) has no tax split.
function preTaxDue(b: any): { total: number; due: number } {
  const total = b.amount_total_cents - (b.tax_cents ?? 0);
  const paid = b.payment_status === "deposit_paid" && b.stripe_payment_intent_id ? b.deposit_cents : b.amount_paid_cents;
  return { total, due: total - paid };
}

// Staff money actions that the automated checkout cannot cover:
//  - finalize_quote: price a quote request, reserve capacity, confirm, email the customer.
//  - send_link:      email a Stripe invoice for what is still owed (deposit remainder or quoted price).
//  - charge_card:    pay that invoice with the card saved at checkout.
// Payment rows are written by the invoice.paid webhook (metadata kind=balance).
export default adminHandler("staff", async (req, user) => {
  if (req.method !== "POST") return badRequest("POST required");
  const body = await readJson<Body>(req);
  if (!body.booking_id) return badRequest("booking_id required");
  const db = supabaseAdmin();
  const { data: b } = await db.from("bookings").select("*, dumpster_types(name)").eq("id", body.booking_id).maybeSingle();
  if (!b) return notFound("Booking not found");
  if (b.status === "canceled") return badRequest("Booking is canceled");
  const typeName = (b as any).dumpster_types?.name ?? "Booking";

  if (body.action === "finalize_quote") {
    if (b.status !== "pending" || !(b.flags ?? []).includes("quote_requested")) return badRequest("Not an open quote request");
    const amount = Math.round(Number(body.amount_cents));
    if (!Number.isFinite(amount) || amount <= 0) return badRequest("Enter the agreed price");

    // Same capacity guard as a paid booking: heavy material shares the roll-off containers.
    const confirmed = await assignUnitAndConfirm(b.id, { payment_status: "unpaid", amount_paid_cents: 0 });
    if (!confirmed) return badRequest("No container free for those dates. Reschedule first.");

    const flags = (b.flags ?? []).filter((f: string) => f !== "quote_requested");
    const { error } = await db.from("bookings").update({
      subtotal_cents: amount, addon_cents: 0, distance_fee_cents: 0, discount_cents: 0,
      tax_cents: 0, amount_total_cents: amount, deposit_cents: 0, payment_method: "card", flags,
    }).eq("id", b.id);
    if (error) throw new Error(error.message);

    await syncBookingEvent(b.id); // PENDING quote event becomes the confirmed booking
    await sendEmail(b.customer_email, `Booking confirmed — ${b.reference}`,
      bookingConfirmationHtml({
        reference: b.reference, customer_name: b.customer_name, typeName,
        start_date: b.start_date, end_date: b.end_date,
        amount_total_cents: amount, amount_paid_cents: 0, payment_method: "quote, plus tax",
      }));
    await audit({ actor: user.email!, action: "quote.finalize", entity: "bookings", entityId: b.id, detail: { amount } });
    return json({ ok: true, amount_cents: amount });
  }

  if (body.action !== "send_link" && body.action !== "charge_card") return badRequest("Unknown action");
  if (b.payment_method !== "card") return badRequest("Cash bookings are collected in person");
  if (!["unpaid", "deposit_paid"].includes(b.payment_status)) return badRequest(`Nothing to collect (payment is ${b.payment_status})`);
  if ((b.flags ?? []).includes("quote_requested")) return badRequest("Set the final price first");
  const { total, due } = preTaxDue(b);
  if (due <= 0) return badRequest("Nothing left to collect");

  const s = stripe();
  let invoice = b.balance_invoice_id ? await s.invoices.retrieve(b.balance_invoice_id) : null;
  if (invoice?.status === "paid") return badRequest("Balance already paid");
  if (invoice && invoice.status !== "open") invoice = null; // voided/uncollectible: issue a fresh one

  if (!invoice) {
    let customerId: string | null = b.stripe_customer_id;
    if (!customerId) {
      // Phone/quote customers never went through checkout, so they have no Stripe customer yet.
      const customer = await s.customers.create({
        email: b.customer_email, name: b.customer_name, phone: b.customer_phone,
        address: { line1: b.delivery_address, state: "TX", country: "US" },
        metadata: { booking_id: b.id },
      });
      customerId = customer.id;
      await db.from("bookings").update({ stripe_customer_id: customerId }).eq("id", b.id);
    }
    // Same separate "Sales Tax" line as checkout (settings.tax_rate_bps).
    const taxRateId = await ensureTaxRate(num(await loadSettings(), "tax_rate_bps", 0));
    const taxRates = taxRateId ? [taxRateId] : [];
    const draft = await s.invoices.create({
      customer: customerId, collection_method: "send_invoice", days_until_due: 7,
      auto_advance: false,
      description: `Balance — booking ${b.reference}`,
      metadata: { booking_id: b.id, kind: "balance", pretax_total_cents: String(total) },
    });
    await s.invoiceItems.create({
      customer: customerId, invoice: draft.id, currency: "usd", quantity: 1,
      description: `${typeName} ${b.start_date} to ${b.end_date} — balance for ${b.reference}`,
      price_data: { currency: "usd", unit_amount: due, tax_behavior: "exclusive", product: await ensureFixedProduct("balance", "Booking balance") },
      tax_rates: taxRates,
    });
    invoice = await s.invoices.finalizeInvoice(draft.id);
    await db.from("bookings").update({ balance_invoice_id: invoice.id, balance_invoice_url: invoice.hosted_invoice_url }).eq("id", b.id);
  }

  if (body.action === "charge_card") {
    if (!b.stripe_payment_method_id) return badRequest("No saved card on this booking. Send a pay link instead.");
    try {
      await s.invoices.pay(invoice.id, { payment_method: b.stripe_payment_method_id, off_session: true });
    } catch (err) {
      await audit({ actor: user.email!, action: "balance.charge_failed", entity: "bookings", entityId: b.id, detail: { error: (err as Error).message } });
      return badRequest(`Card charge failed: ${(err as Error).message}`);
    }
    await audit({ actor: user.email!, action: "balance.charge", entity: "bookings", entityId: b.id, detail: { due } });
    return json({ ok: true, status: "paid" });
  }

  const sent = await sendEmail(b.customer_email, `Payment due — ${b.reference}`,
    `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">
       <div style="background:#0b0b0c;color:#ffc61a;padding:18px 24px;font-weight:bold;font-size:20px">Texas Dumpster Co</div>
       <div style="padding:24px;color:#111">
         <h2>Balance due — ${esc(b.reference)}</h2>
         <p>Hi ${esc(b.customer_name)}, the remaining balance for your ${esc(typeName)} (${b.start_date} to ${b.end_date})
            is <strong>${dollars(invoice.amount_due)}</strong>, tax included.</p>
         <p><a href="${esc(invoice.hosted_invoice_url ?? "")}" style="background:#ffc61a;color:#0b0b0c;padding:12px 22px;text-decoration:none;font-weight:bold">Pay now</a></p>
       </div></div>`);
  await audit({ actor: user.email!, action: "balance.link", entity: "bookings", entityId: b.id, detail: { due, invoice: invoice.id } });
  return json({ ok: true, emailed: sent, invoice_url: invoice.hosted_invoice_url, amount_due_cents: invoice.amount_due });
});
