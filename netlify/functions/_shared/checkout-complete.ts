import Stripe from "stripe";
import { supabaseAdmin } from "./supabase";
import { stripe } from "./stripe";
import { syncBookingEvent } from "./booking-calendar";
import { sendEmail, esc, bookingConfirmationHtml, adminAlertHtml, adminAlertTo } from "./email";
import { assignUnitAndConfirm } from "./confirm";

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

// Apply a paid Checkout Session to its booking: confirm + assign a unit, record the
// payment, add the calendar event and send emails. Every step is idempotent, so it is
// safe to run from the webhook, from a Stripe retry, and from the admin
// "Check payment in Stripe" recovery button for a webhook that never arrived.
export async function processPaidCheckout(session: Stripe.Checkout.Session): Promise<void> {
  const db = supabaseAdmin();
  // Only a completed card payment confirms a booking.
  if (session.payment_status !== "paid") return;
  if (session.metadata?.kind === "charges") return processChargesCheckout(session);
  const bookingId = session.metadata?.booking_id;
  const chargeKind = session.metadata?.charge_kind === "deposit" ? "deposit" : "full";
  if (!bookingId) return;

  const { data: booking } = await db.from("bookings").select("*").eq("id", bookingId).maybeSingle();
  if (!booking) return;
  const alreadyPaid = ["paid", "deposit_paid", "refunded"].includes(booking.payment_status);
  const alreadyConfirmed = alreadyPaid && booking.status === "confirmed";
  const flags = new Set<string>(booking.flags ?? []);

  const paid = session.amount_total ?? 0;
  const pi = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;
  const alertTo = await adminAlertTo();

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
      await syncBookingEvent(booking.id); // shows on the calendar as PENDING (paid, needs a container)
      await recordPayment(db, booking.id, chargeKind, paid, pi);
      if (alertTo) await sendEmail(alertTo, `ACTION NEEDED: paid booking ${booking.reference} has no capacity`,
        `<div style="font-family:Arial,sans-serif"><h2>Paid booking could not be confirmed</h2>
         <p>${esc(booking.customer_name)} (${esc(booking.customer_phone)}) paid for ${esc(booking.start_date)} to ${esc(booking.end_date)},
         but those dates are no longer available. Reschedule with the customer or refund them in the admin.</p>
         <p>Reference: <strong>${esc(booking.reference)}</strong></p></div>`);
      return;
    }

    // Consume promo once, on the invocation that actually confirms.
    if (booking.promo_code_id) {
      // supabase-js reports RPC failures in `error`; it does not reject.
      const { error: promoErr } = await db.rpc("increment_promo_use", { p_id: booking.promo_code_id });
      if (promoErr) console.error("[webhook] promo use not counted:", promoErr.message);
    }
  }

  // Keep our books equal to what Stripe charged (Stripe Tax replaces our estimate).
  if (chargeKind === "full") {
    await db.from("bookings").update({ tax_cents: stripeTax, amount_total_cents: paid }).eq("id", booking.id);
  } else if (session.amount_subtotal != null) {
    // Deposit: keep the pre-tax part actually charged, so the balance invoice bills the rest before tax.
    await db.from("bookings").update({ deposit_cents: session.amount_subtotal }).eq("id", booking.id);
  }

  // 2. Payment ledger (once per payment intent).
  await recordPayment(db, booking.id, chargeKind, paid, pi);

  // 3. Calendar. A Google failure must never block the confirmation email.
  const { data: type } = await db.from("dumpster_types").select("name").eq("id", booking.type_id).maybeSingle();
  const typeName = type?.name ?? "Booking";
  if (await syncBookingEvent(booking.id)) flags.delete("calendar_failed");
  else flags.add("calendar_failed");

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

// A paid pay link for itemized charges (invoice builder). The booking was already
// confirmed by staff; mark its lines paid, ledger the payment once, keep the saved
// card for later adjustments and email a receipt. Idempotent like the above.
async function processChargesCheckout(session: Stripe.Checkout.Session): Promise<void> {
  const db = supabaseAdmin();
  const bookingId = session.metadata?.booking_id;
  if (!bookingId) return;
  const { data: booking } = await db.from("bookings").select("*").eq("id", bookingId).maybeSingle();
  if (!booking) return;
  const paid = session.amount_total ?? 0;
  const pi = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;
  let paymentMethodId: string | null = null;
  if (pi) {
    const intent = await stripe().paymentIntents.retrieve(pi);
    paymentMethodId = typeof intent.payment_method === "string" ? intent.payment_method : intent.payment_method?.id ?? null;
  }

  const { data: lines } = await db.from("booking_charges").select("*").eq("stripe_invoice_id", session.id);
  await db.from("booking_charges").update({ status: "paid" }).eq("stripe_invoice_id", session.id).neq("status", "void");

  // Ledger + paid total once per payment intent.
  let seen = false;
  if (pi) {
    const { data: existing } = await db.from("payments").select("id").eq("booking_id", bookingId).eq("stripe_payment_intent_id", pi).neq("kind", "refund").maybeSingle();
    seen = !!existing;
  }
  if (!seen) {
    await recordPayment(db, bookingId, "full", paid, pi);
    const { error } = await db.from("bookings").update({
      payment_status: "paid",
      amount_paid_cents: (booking.amount_paid_cents ?? 0) + paid,
      stripe_payment_intent_id: booking.stripe_payment_intent_id ?? pi,
      stripe_customer_id: typeof session.customer === "string" ? session.customer : booking.stripe_customer_id,
      stripe_payment_method_id: paymentMethodId ?? booking.stripe_payment_method_id,
    }).eq("id", bookingId);
    if (error) throw new Error(`Could not mark charges paid: ${error.message}`);
    const rows = (lines ?? []).filter((l) => l.status !== "void");
    const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;
    await sendEmail(booking.customer_email, `Payment received — ${booking.reference}`,
      `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">
         <div style="background:#0b0b0c;color:#ffc61a;padding:18px 24px;font-weight:bold;font-size:20px">Texas Dumpster Co</div>
         <div style="padding:24px;color:#111">
           <h2>Thank you — payment received</h2>
           <p>Hi ${esc(booking.customer_name)}, we received ${dollars(paid)} for booking ${esc(booking.reference)} (${esc(booking.start_date)} to ${esc(booking.end_date)}).</p>
           <ul>${rows.map((r) => `<li>${esc(r.description)}: ${dollars(r.amount_cents)}</li>`).join("")}</ul>
           <p>Your card is saved securely with Stripe for any charges described in your rental agreement (for example a weight overage). We always email the amount first.</p>
         </div></div>`);
    const alertTo = await adminAlertTo();
    if (alertTo) await sendEmail(alertTo, `Paid: ${booking.reference} (${dollars(paid)})`,
      `<p>${esc(booking.customer_name)} paid ${dollars(paid)} for booking ${esc(booking.reference)}.</p>`);
  }
}
