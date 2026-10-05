import type { Config } from "@netlify/functions";
import { withErrors, json, badRequest, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { stripe } from "./_shared/stripe";

// Public: the customer backed out of Stripe Checkout (cancel_url). Expire the
// checkout session and cancel the unpaid booking so its container is free again
// right away, instead of after the 30-minute hold. Needs both the reference and
// the booking id from the cancel URL, so it cannot be guessed.
export default withErrors(async (req: Request) => {
  if (req.method !== "POST") return badRequest("POST required");
  const { reference, booking_id } = await readJson<{ reference?: string; booking_id?: string }>(req);
  if (!reference || !booking_id) return badRequest("reference and booking_id required");
  const db = supabaseAdmin();
  const { data: b } = await db.from("bookings")
    .select("id,status,payment_status,stripe_checkout_session_id")
    .eq("id", booking_id).eq("reference", reference).maybeSingle();
  if (!b || b.status !== "pending" || b.payment_status !== "unpaid" || !b.stripe_checkout_session_id) {
    return json({ ok: true, released: false });
  }
  // Expire first: if the customer already paid in another tab, Stripe refuses and we keep the booking.
  try {
    await stripe().checkout.sessions.expire(b.stripe_checkout_session_id);
  } catch {
    return json({ ok: true, released: false });
  }
  await db.from("bookings").update({ status: "canceled", hold_expires_at: null })
    .eq("id", b.id).eq("status", "pending").eq("payment_status", "unpaid");
  return json({ ok: true, released: true });
});

export const config: Config = { rateLimit: { windowLimit: 10, windowSize: 60, aggregateBy: ["ip", "domain"] } } as Config; // windowLimit postdates the installed @netlify/functions types
