import { adminHandler } from "./_shared/admin";
import { json, badRequest, notFound, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { stripe } from "./_shared/stripe";
import { processPaidCheckout } from "./_shared/checkout-complete";
import { audit } from "./_shared/audit";

// Recovery for a missed Stripe webhook: look up the booking's Checkout Session in
// Stripe and, if it was paid, apply it exactly as the webhook would have.
export default adminHandler("staff", async (req, user) => {
  if (req.method !== "POST") return badRequest("POST required");
  const { booking_id } = await readJson<{ booking_id?: string }>(req);
  if (!booking_id) return badRequest("booking_id required");
  const db = supabaseAdmin();
  const { data: b } = await db.from("bookings").select("id,stripe_checkout_session_id").eq("id", booking_id).maybeSingle();
  if (!b) return notFound("Booking not found");
  if (!b.stripe_checkout_session_id) return badRequest("This booking never started a card checkout");

  const session = await stripe().checkout.sessions.retrieve(b.stripe_checkout_session_id);
  if (session.payment_status !== "paid") {
    return json({ ok: true, paid: false, message: `Stripe shows this checkout as ${session.status} / ${session.payment_status}. No payment was taken.` });
  }
  await processPaidCheckout(session);
  const { data: after } = await db.from("bookings").select("status,payment_status").eq("id", b.id).maybeSingle();
  await audit({ actor: user.email!, action: "booking.sync_payment", entity: "bookings", entityId: b.id, detail: after ?? {} });
  return json({ ok: true, paid: true, status: after?.status, payment_status: after?.payment_status });
});
