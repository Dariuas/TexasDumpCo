import Stripe from "stripe";
import { supabaseAdmin } from "./_shared/supabase";
import { stripe, invoicePaymentIntentId } from "./_shared/stripe";
import { env } from "./_shared/env";
import { processPaidCheckout } from "./_shared/checkout-complete";

// Stripe webhook. Verifies the signature against the RAW body, then confirms
// bookings on successful payment and keeps refunds in sync. Idempotent: each
// step is skipped if already done, so Stripe retries finish partial work.
export default async (req: Request): Promise<Response> => {
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("missing signature", { status: 400 });

  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe().webhooks.constructEventAsync(raw, sig, env("STRIPE_WEBHOOK_SECRET"));
  } catch (err) {
    console.error("[webhook] signature verification failed:", (err as Error).message);
    return new Response("invalid signature", { status: 400 });
  }

  const db = supabaseAdmin();

  try {
    if (event.type === "invoice.paid") {
      const inv = event.data.object as Stripe.Invoice;
      const bookingId = inv.metadata?.booking_id;
      if (inv.metadata?.kind === "overage" && bookingId) {
        const { data: existing } = await db.from("payments").select("id").eq("booking_id", bookingId).eq("kind", "overage").eq("note", inv.id).maybeSingle();
        if (!existing) {
          const { error } = await db.from("payments").insert({ booking_id: bookingId, kind: "overage", method: "card", amount_cents: inv.amount_paid, status: "succeeded", note: inv.id, stripe_payment_intent_id: await invoicePaymentIntentId(inv) });
          if (error) throw new Error(`Could not record overage payment: ${error.message}`);
        }
        await db.from("bookings").update({ overage_status: "paid" }).eq("id", bookingId);
      }
      if (inv.metadata?.kind === "balance" && bookingId) {
        // Deposit remainder or finalized quote (admin-collect-payment). Ledger once per invoice.
        const { data: existing } = await db.from("payments").select("id").eq("booking_id", bookingId).eq("kind", "balance").eq("note", inv.id).maybeSingle();
        if (!existing) {
          const { data: bk } = await db.from("bookings").select("amount_paid_cents").eq("id", bookingId).maybeSingle();
          const { error } = await db.from("payments").insert({ booking_id: bookingId, kind: "balance", method: "card", amount_cents: inv.amount_paid, status: "succeeded", note: inv.id, stripe_payment_intent_id: await invoicePaymentIntentId(inv) });
          if (error) throw new Error(`Could not record balance payment: ${error.message}`);
          const paidNow = (bk?.amount_paid_cents ?? 0) + inv.amount_paid;
          const pretaxTotal = Number(inv.metadata?.pretax_total_cents ?? paidNow);
          await db.from("bookings").update({
            payment_status: "paid", amount_paid_cents: paidNow,
            amount_total_cents: paidNow, tax_cents: Math.max(0, paidNow - pretaxTotal),
          }).eq("id", bookingId);
        }
      }
      return new Response("ok", { status: 200 });
    }
    if (event.type === "invoice.payment_failed") {
      const inv = event.data.object as Stripe.Invoice;
      const bookingId = inv.metadata?.booking_id;
      if ((inv.metadata?.kind === "overage" || inv.metadata?.kind === "balance") && bookingId) {
        const { data: bk } = await db.from("bookings").select("flags").eq("id", bookingId).maybeSingle();
        const flags = new Set<string>(bk?.flags ?? []);
        flags.add(`${inv.metadata.kind}_payment_failed`);
        await db.from("bookings").update({ flags: [...flags] }).eq("id", bookingId);
      }
      return new Response("ok", { status: 200 });
    }

    if (event.type === "checkout.session.completed") {
      await processPaidCheckout(event.data.object as Stripe.Checkout.Session);
    }

    if (event.type === "charge.refunded") {
      const charge = event.data.object as Stripe.Charge;
      const pi = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
      if (pi) {
        let { data: booking } = await db.from("bookings").select("*").eq("stripe_payment_intent_id", pi).maybeSingle();
        if (!booking) {
          // Balance/overage invoices are paid by their own PaymentIntent, ledgered on the payment row.
          const { data: pay } = await db.from("payments").select("booking_id").eq("stripe_payment_intent_id", pi).neq("kind", "refund").limit(1).maybeSingle();
          if (pay) ({ data: booking } = await db.from("bookings").select("*").eq("id", pay.booking_id).maybeSingle());
        }
        if (booking) {
          // Ledger refunds made outside the admin (e.g. in the Stripe dashboard).
          const refunds = await stripe().refunds.list({ charge: charge.id, limit: 100 });
          for (const r of refunds.data) {
            if (r.status === "failed" || r.status === "canceled") continue;
            const { data: seen } = await db.from("payments").select("id").eq("stripe_refund_id", r.id).maybeSingle();
            if (seen) continue;
            const { error: ledgerErr } = await db.from("payments").insert({
              booking_id: booking.id, kind: "refund", method: "card", amount_cents: r.amount, status: "succeeded",
              stripe_payment_intent_id: pi, stripe_refund_id: r.id, note: "Refunded in Stripe",
            });
            if (ledgerErr) throw new Error(`Could not record refund: ${ledgerErr.message}`);
          }
          // A booking can have several card payments (checkout, balance, overage); judge by the whole ledger.
          const { data: ledger } = await db.from("payments").select("kind,amount_cents").eq("booking_id", booking.id).eq("method", "card");
          const paidTotal = (ledger ?? []).filter((p) => p.kind !== "refund").reduce((s, p) => s + p.amount_cents, 0);
          const refundedTotal = (ledger ?? []).filter((p) => p.kind === "refund").reduce((s, p) => s + p.amount_cents, 0);
          const fullyRefunded = refundedTotal >= paidTotal;
          await db.from("bookings").update({
            payment_status: fullyRefunded ? "refunded" : "partially_refunded",
          }).eq("id", booking.id);
        }
      }
    }
  } catch (err) {
    console.error("[webhook] handler error:", (err as Error).message);
    // Return 500 so Stripe retries transient failures.
    return new Response("handler error", { status: 500 });
  }

  return new Response("ok", { status: 200 });
};
