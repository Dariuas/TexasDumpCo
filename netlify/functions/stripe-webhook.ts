import Stripe from "stripe";
import { supabaseAdmin } from "./_shared/supabase";
import { stripe } from "./_shared/stripe";
import { env, optionalEnv } from "./_shared/env";
import { createCalendarEvent } from "./_shared/google-calendar";
import { sendEmail, esc, bookingConfirmationHtml, adminAlertHtml } from "./_shared/email";
import { assignUnitAndConfirm } from "./_shared/confirm";

// Insert the card payment into the ledger once per payment intent.
async function recordPayment(db: ReturnType<typeof supabaseAdmin>, bookingId: string, kind: string, amount: number, pi: string | null) {
  if (pi) {
    const { data: existing } = await db.from("payments").select("id").eq("booking_id", bookingId).eq("stripe_payment_intent_id", pi).neq("kind", "refund").maybeSingle();
    if (existing) return;
  }
  const { error } = await db.from("payments").insert({
    booking_id: bookingId, kind, method: "card", amount_cents: amount, status: "succeeded", stripe_payment_intent_id: pi,
  });
  if (error) throw new Error(`Could not record payment: ${error.message}`);
}

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
          const { error } = await db.from("payments").insert({ booking_id: bookingId, kind: "overage", method: "card", amount_cents: inv.amount_paid, status: "succeeded", note: inv.id });
          if (error) throw new Error(`Could not record overage payment: ${error.message}`);
        }
        await db.from("bookings").update({ overage_status: "paid" }).eq("id", bookingId);
      }
      return new Response("ok", { status: 200 });
    }
    if (event.type === "invoice.payment_failed") {
      const inv = event.data.object as Stripe.Invoice;
      const bookingId = inv.metadata?.booking_id;
      if (inv.metadata?.kind === "overage" && bookingId) {
        const { data: bk } = await db.from("bookings").select("flags").eq("id", bookingId).maybeSingle();
        const flags = new Set<string>(bk?.flags ?? []);
        flags.add("overage_payment_failed");
        await db.from("bookings").update({ flags: [...flags] }).eq("id", bookingId);
      }
      return new Response("ok", { status: 200 });
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const bookingId = session.metadata?.booking_id;
      const chargeKind = session.metadata?.charge_kind === "deposit" ? "deposit" : "full";
      if (!bookingId) return new Response("ok", { status: 200 });

      const { data: booking } = await db.from("bookings").select("*").eq("id", bookingId).maybeSingle();
      if (!booking) return new Response("ok", { status: 200 });
      const alreadyPaid = ["paid", "deposit_paid", "refunded"].includes(booking.payment_status);
      const alreadyConfirmed = alreadyPaid && booking.status === "confirmed";
      const flags = new Set<string>(booking.flags ?? []);

      const paid = session.amount_total ?? 0;
      const pi = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;
      const alertTo = optionalEnv("ADMIN_ALERT_EMAIL");

      // Saved card (for later weight-overage charges) and the tax Stripe actually computed.
      let paymentMethodId: string | null = null;
      if (pi) {
        const intent = await stripe().paymentIntents.retrieve(pi);
        paymentMethodId = typeof intent.payment_method === "string" ? intent.payment_method : intent.payment_method?.id ?? null;
      }
      const stripeTax = session.total_details?.amount_tax ?? 0;

      // Every step below is idempotent on its own, so a Stripe retry after a
      // partial failure finishes the job instead of being skipped.

      // 1. Confirm + assign a physical unit atomically.
      if (!alreadyConfirmed) {
        const confirmed = await assignUnitAndConfirm(booking.id, {
          payment_status: chargeKind === "deposit" ? "deposit_paid" : "paid",
          amount_paid_cents: paid,
          stripe_payment_intent_id: pi,
          stripe_customer_id: typeof session.customer === "string" ? session.customer : null,
          stripe_payment_method_id: paymentMethodId,
        });

        if (!confirmed) {
          // Paid, but the dates were taken (late payment after the hold expired).
          // Record the money, park the booking for staff, and alert them to
          // reschedule or refund. Never auto-confirm over a full inventory.
          flags.add("paid_no_capacity");
          const { error: parkErr } = await db.from("bookings").update({
            status: "pending",
            hold_expires_at: null,
            payment_status: chargeKind === "deposit" ? "deposit_paid" : "paid",
            amount_paid_cents: paid,
            stripe_payment_intent_id: pi,
            stripe_customer_id: typeof session.customer === "string" ? session.customer : null,
            stripe_payment_method_id: paymentMethodId,
            flags: [...flags],
          }).eq("id", booking.id);
          if (parkErr) throw new Error(`Could not park paid booking: ${parkErr.message}`);
          await recordPayment(db, booking.id, chargeKind, paid, pi);
          if (alertTo) await sendEmail(alertTo, `ACTION NEEDED: paid booking ${booking.reference} has no capacity`,
            `<div style="font-family:Arial,sans-serif"><h2>Paid booking could not be confirmed</h2>
             <p>${esc(booking.customer_name)} (${esc(booking.customer_phone)}) paid for ${esc(booking.start_date)} to ${esc(booking.end_date)},
             but those dates are no longer available. Reschedule with the customer or refund them in the admin.</p>
             <p>Reference: <strong>${esc(booking.reference)}</strong></p></div>`);
          return new Response("ok", { status: 200 });
        }

        // Consume promo once, on the invocation that actually confirms.
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
      }

      // Keep our books equal to what Stripe charged (Stripe Tax replaces our estimate).
      if (chargeKind === "full") {
        await db.from("bookings").update({ tax_cents: stripeTax, amount_total_cents: paid }).eq("id", booking.id);
      }

      // 2. Payment ledger (once per payment intent).
      await recordPayment(db, booking.id, chargeKind, paid, pi);

      // 3. Calendar. A Google failure must never block the confirmation email.
      const { data: type } = await db.from("dumpster_types").select("name").eq("id", booking.type_id).maybeSingle();
      const typeName = type?.name ?? "Booking";
      if (!booking.google_event_id) {
        try {
          const eventId = await createCalendarEvent({
            summary: `${typeName} — ${booking.customer_name} (${booking.reference})`,
            description: `Phone: ${booking.customer_phone}
Email: ${booking.customer_email}
Notes: ${booking.notes ?? "-"}
Ref: ${booking.reference}`,
            location: booking.delivery_address,
            startDate: booking.start_date,
            endDate: booking.end_date,
          });
          if (eventId) await db.from("bookings").update({ google_event_id: eventId }).eq("id", booking.id);
        } catch (err) {
          console.error("[webhook] calendar event failed:", (err as Error).message);
          flags.add("calendar_failed");
        }
      }

      // 4. Emails, once (tracked with a flag so retries don't double-send).
      if (!flags.has("confirm_email_sent")) {
        await sendEmail(booking.customer_email, `Booking confirmed — ${booking.reference}`,
          bookingConfirmationHtml({
            reference: booking.reference, customer_name: booking.customer_name, typeName,
            start_date: booking.start_date, end_date: booking.end_date,
            amount_total_cents: booking.amount_total_cents, amount_paid_cents: paid, payment_method: "card",
          }));
        if (alertTo) await sendEmail(alertTo, `New booking ${booking.reference}`,
          adminAlertHtml({
            reference: booking.reference, customer_name: booking.customer_name,
            customer_phone: booking.customer_phone, typeName,
            start_date: booking.start_date, payment_method: "card",
            payment_status: chargeKind === "deposit" ? "deposit_paid" : "paid",
          }));
        flags.add("confirm_email_sent");
      }
      await db.from("bookings").update({ flags: [...flags] }).eq("id", booking.id);
    }

    if (event.type === "charge.refunded") {
      const charge = event.data.object as Stripe.Charge;
      const pi = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
      if (pi) {
        const { data: booking } = await db.from("bookings").select("*").eq("stripe_payment_intent_id", pi).maybeSingle();
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
