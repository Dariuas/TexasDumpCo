import Stripe from "stripe";
import { supabaseAdmin } from "./_shared/supabase";
import { stripe } from "./_shared/stripe";
import { env, optionalEnv } from "./_shared/env";
import { createCalendarEvent } from "./_shared/google-calendar";
import { sendEmail, bookingConfirmationHtml, adminAlertHtml } from "./_shared/email";
import { assignUnitAndConfirm } from "./_shared/confirm";

// Stripe webhook. Verifies the signature against the RAW body, then confirms
// bookings on successful payment and keeps refunds in sync. Idempotent: a
// booking already marked paid is left untouched.
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
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const bookingId = session.metadata?.booking_id;
      const chargeKind = session.metadata?.charge_kind === "deposit" ? "deposit" : "full";
      if (!bookingId) return new Response("ok", { status: 200 });

      const { data: booking } = await db.from("bookings").select("*").eq("id", bookingId).maybeSingle();
      if (!booking) return new Response("ok", { status: 200 });
      // Idempotency guard.
      if (["paid", "deposit_paid", "refunded"].includes(booking.payment_status)) {
        return new Response("ok", { status: 200 });
      }

      const paid = session.amount_total ?? 0;
      const pi = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;

      // Confirm + assign a physical unit atomically.
      await assignUnitAndConfirm(booking.id, {
        payment_status: chargeKind === "deposit" ? "deposit_paid" : "paid",
        amount_paid_cents: paid,
        stripe_payment_intent_id: pi,
        stripe_customer_id: typeof session.customer === "string" ? session.customer : null,
      });

      // Payment ledger.
      await db.from("payments").insert({
        booking_id: booking.id,
        kind: chargeKind,
        method: "card",
        amount_cents: paid,
        status: "succeeded",
        stripe_payment_intent_id: pi,
      });

      // Consume promo once, on successful payment.
      if (booking.promo_code_id) {
        await db.rpc("increment_promo_use", { p_id: booking.promo_code_id }).then(
          () => {},
          async () => {
            // Fallback if RPC not present.
            const { data: p } = await db.from("promo_codes").select("uses_count").eq("id", booking.promo_code_id).maybeSingle();
            if (p) await db.from("promo_codes").update({ uses_count: (p.uses_count ?? 0) + 1 }).eq("id", booking.promo_code_id);
          },
        );
      }

      // Calendar + emails.
      const { data: type } = await db.from("dumpster_types").select("name").eq("id", booking.type_id).maybeSingle();
      const typeName = type?.name ?? "Booking";
      const eventId = await createCalendarEvent({
        summary: `${typeName} — ${booking.customer_name} (${booking.reference})`,
        description: `Phone: ${booking.customer_phone}\nEmail: ${booking.customer_email}\nNotes: ${booking.notes ?? "-"}\nRef: ${booking.reference}`,
        location: booking.delivery_address,
        startDate: booking.start_date,
        endDate: booking.end_date,
      });
      if (eventId) await db.from("bookings").update({ google_event_id: eventId }).eq("id", booking.id);

      await sendEmail(booking.customer_email, `Booking confirmed — ${booking.reference}`,
        bookingConfirmationHtml({
          reference: booking.reference, customer_name: booking.customer_name, typeName,
          start_date: booking.start_date, end_date: booking.end_date,
          amount_total_cents: booking.amount_total_cents, amount_paid_cents: paid, payment_method: "card",
        }));
      const alertTo = optionalEnv("ADMIN_ALERT_EMAIL");
      if (alertTo) await sendEmail(alertTo, `New booking ${booking.reference}`,
        adminAlertHtml({
          reference: booking.reference, customer_name: booking.customer_name,
          customer_phone: booking.customer_phone, typeName,
          start_date: booking.start_date, payment_method: "card",
          payment_status: chargeKind === "deposit" ? "deposit_paid" : "paid",
        }));
    }

    if (event.type === "charge.refunded") {
      const charge = event.data.object as Stripe.Charge;
      const pi = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
      if (pi) {
        const { data: booking } = await db.from("bookings").select("*").eq("stripe_payment_intent_id", pi).maybeSingle();
        if (booking) {
          const fullyRefunded = charge.amount_refunded >= (charge.amount ?? 0);
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
