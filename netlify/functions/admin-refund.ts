import { adminHandler } from "./_shared/admin";
import { json, badRequest, notFound, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { stripe } from "./_shared/stripe";
import { audit } from "./_shared/audit";

interface Body { booking_id?: string; amount_cents?: number; reason?: string }

// Refund a card payment (full or partial) and record it. Admin only.
export default adminHandler("admin", async (req, user) => {
  if (req.method !== "POST") return badRequest("POST required");
  const body = await readJson<Body>(req);
  if (!body.booking_id) return badRequest("booking_id required");
  const db = supabaseAdmin();

  const { data: booking } = await db.from("bookings").select("*").eq("id", body.booking_id).maybeSingle();
  if (!booking) return notFound("Booking not found");
  if (booking.payment_method !== "card" || !booking.stripe_payment_intent_id) {
    return badRequest("This booking has no card payment to refund");
  }

  const alreadyRefunded = (await db
    .from("payments").select("amount_cents").eq("booking_id", booking.id).eq("kind", "refund"))
    .data?.reduce((s, r) => s + r.amount_cents, 0) ?? 0;

  const maxRefundable = booking.amount_paid_cents - alreadyRefunded;
  if (maxRefundable <= 0) return badRequest("Nothing left to refund");

  const amount = Math.min(body.amount_cents ?? maxRefundable, maxRefundable);

  const refund = await stripe().refunds.create({
    payment_intent: booking.stripe_payment_intent_id,
    amount,
    reason: "requested_by_customer",
    metadata: { booking_id: booking.id, note: body.reason ?? "" },
  });

  await db.from("payments").insert({
    booking_id: booking.id,
    kind: "refund",
    method: "card",
    amount_cents: amount,
    status: "succeeded",
    stripe_payment_intent_id: booking.stripe_payment_intent_id,
    stripe_refund_id: refund.id,
    note: body.reason ?? null,
  });

  const totalRefunded = alreadyRefunded + amount;
  await db.from("bookings").update({
    payment_status: totalRefunded >= booking.amount_paid_cents ? "refunded" : "partially_refunded",
  }).eq("id", booking.id);

  await audit({ actor: user.email!, action: "booking.refund", entity: "bookings", entityId: booking.id, detail: { amount_cents: amount, reason: body.reason } });
  return json({ ok: true, refunded_cents: amount, total_refunded_cents: totalRefunded });
});
