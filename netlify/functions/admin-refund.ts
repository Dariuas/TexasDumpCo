import { adminHandler } from "./_shared/admin";
import { json, badRequest, notFound, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { stripe } from "./_shared/stripe";
import { audit } from "./_shared/audit";

interface Body { booking_id?: string; amount_cents?: number; reason?: string }

// Refund card payments (full or partial) and record them. Admin only.
// A booking can be paid by several PaymentIntents (checkout, balance invoice,
// overage invoice); the refund is taken from the newest payment first.
export default adminHandler("admin", async (req, user) => {
  if (req.method !== "POST") return badRequest("POST required");
  const body = await readJson<Body>(req);
  if (!body.booking_id) return badRequest("booking_id required");
  const db = supabaseAdmin();

  const { data: booking } = await db.from("bookings").select("*").eq("id", body.booking_id).maybeSingle();
  if (!booking) return notFound("Booking not found");

  const { data: ledger } = await db.from("payments")
    .select("kind,amount_cents,stripe_payment_intent_id,created_at")
    .eq("booking_id", booking.id).eq("method", "card").order("created_at", { ascending: false });
  const rows = ledger ?? [];

  // Refundable per PaymentIntent = what it collected minus what was refunded from it.
  const byPi = new Map<string, number>();
  for (const r of rows) {
    if (!r.stripe_payment_intent_id) continue;
    const sign = r.kind === "refund" ? -1 : 1;
    byPi.set(r.stripe_payment_intent_id, (byPi.get(r.stripe_payment_intent_id) ?? 0) + sign * r.amount_cents);
  }
  // Older bookings may only have the PI on the booking row.
  if (!byPi.size && booking.stripe_payment_intent_id && booking.amount_paid_cents > 0) {
    byPi.set(booking.stripe_payment_intent_id, booking.amount_paid_cents);
  }
  const maxRefundable = [...byPi.values()].reduce((s, v) => s + Math.max(0, v), 0);
  if (maxRefundable <= 0) return badRequest("This booking has no card payment left to refund");

  const amount = Math.min(Math.round(body.amount_cents ?? maxRefundable), maxRefundable);
  if (!(amount > 0)) return badRequest("Enter a refund amount");
  const alreadyRefunded = rows.filter((r) => r.kind === "refund").reduce((s, r) => s + r.amount_cents, 0);

  let left = amount;
  const done: { pi: string; cents: number; refund: string }[] = [];
  for (const [pi, avail] of byPi) {   // Map keeps insertion order: newest payment first
    if (left <= 0) break;
    const take = Math.min(left, Math.max(0, avail));
    if (!take) continue;
    const refund = await stripe().refunds.create({
      payment_intent: pi,
      amount: take,
      reason: "requested_by_customer",
      metadata: { booking_id: booking.id, note: body.reason ?? "" },
    }, { idempotencyKey: `refund-${booking.id}-${pi}-${alreadyRefunded}-${take}` }); // blocks double-click duplicates

    // The charge.refunded webhook may have already ledgered this refund (unique on stripe_refund_id).
    const { data: ledgered } = await db.from("payments").select("id").eq("stripe_refund_id", refund.id).maybeSingle();
    if (!ledgered) await db.from("payments").insert({
      booking_id: booking.id, kind: "refund", method: "card", amount_cents: take, status: "succeeded",
      stripe_payment_intent_id: pi, stripe_refund_id: refund.id, note: body.reason ?? null,
    });
    done.push({ pi, cents: take, refund: refund.id });
    left -= take;
  }

  const fully = amount >= maxRefundable;
  await db.from("bookings").update({ payment_status: fully ? "refunded" : "partially_refunded" }).eq("id", booking.id);

  await audit({ actor: user.email!, action: "booking.refund", entity: "bookings", entityId: booking.id, detail: { amount_cents: amount, reason: body.reason, refunds: done } });
  return json({ ok: true, refunded_cents: amount, total_refunded_cents: alreadyRefunded + amount });
});
