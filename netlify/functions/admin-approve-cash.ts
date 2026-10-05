import { adminHandler } from "./_shared/admin";
import { json, badRequest, notFound, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { assignUnitAndConfirm } from "./_shared/confirm";
import { syncBookingEvent } from "./_shared/booking-calendar";
import { sendEmail, bookingConfirmationHtml } from "./_shared/email";
import { audit } from "./_shared/audit";

interface Body {
  booking_id?: string;
  decision?: "approve" | "reject";
  mark_collected?: boolean;   // cash already in hand?
  amount_cents?: number;      // amount collected, defaults to total
}

// Approve (or reject) a cash-pending booking. Approval reserves inventory,
// confirms the booking, and adds a calendar event. Optionally records the
// cash as collected. Rejection cancels the booking.
export default adminHandler("staff", async (req, user) => {
  if (req.method !== "POST") return badRequest("POST required");
  const body = await readJson<Body>(req);
  if (!body.booking_id) return badRequest("booking_id required");
  const db = supabaseAdmin();

  const { data: booking } = await db.from("bookings").select("*").eq("id", body.booking_id).maybeSingle();
  if (!booking) return notFound("Booking not found");
  if (booking.payment_method !== "cash") return badRequest("Not a cash booking");
  if (booking.status !== "pending") return badRequest(`Booking is already ${booking.status}`);

  if (body.decision === "reject") {
    await db.from("bookings").update({ status: "canceled" }).eq("id", booking.id);
    await syncBookingEvent(booking.id); // removes the PENDING event
    await audit({ actor: user.email!, action: "cash.reject", entity: "bookings", entityId: booking.id });
    return json({ ok: true, status: "canceled" });
  }

  // approve
  const collected = !!body.mark_collected;
  const amount = collected ? Math.min(body.amount_cents ?? booking.amount_total_cents, booking.amount_total_cents) : 0;

  const confirmed = await assignUnitAndConfirm(booking.id, {
    payment_status: collected ? "paid" : "unpaid",
    amount_paid_cents: amount,
  });
  if (!confirmed) return badRequest("No capacity left for those dates. Reschedule or reject this booking.");

  if (collected) {
    await db.from("payments").insert({
      booking_id: booking.id, kind: "full", method: "cash",
      amount_cents: amount, status: "succeeded", note: "Cash collected",
    });
  }

  if (booking.promo_code_id) {
    await db.rpc("increment_promo_use", { p_id: booking.promo_code_id });
  }

  const { data: type } = await db.from("dumpster_types").select("name").eq("id", booking.type_id).maybeSingle();
  const typeName = type?.name ?? "Booking";
  await syncBookingEvent(booking.id); // PENDING event becomes the confirmed booking

  await sendEmail(booking.customer_email, `Booking confirmed — ${booking.reference}`,
    bookingConfirmationHtml({
      reference: booking.reference, customer_name: booking.customer_name, typeName,
      start_date: booking.start_date, end_date: booking.end_date,
      amount_total_cents: booking.amount_total_cents, amount_paid_cents: amount, payment_method: "cash",
    }));

  await audit({ actor: user.email!, action: "cash.approve", entity: "bookings", entityId: booking.id, detail: { collected, amount } });
  return json({ ok: true, status: "confirmed", collected });
});
