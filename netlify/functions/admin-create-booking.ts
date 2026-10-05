import { adminHandler } from "./_shared/admin";
import { json, badRequest, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { assignUnitAndConfirm } from "./_shared/confirm";
import { syncBookingEvent } from "./_shared/booking-calendar";
import { sendEmail, bookingConfirmationHtml } from "./_shared/email";
import { audit } from "./_shared/audit";

interface Body {
  type_id?: string;
  customer_name?: string;
  customer_email?: string;
  customer_phone?: string;
  delivery_address?: string;
  delivery_notes?: string;
  notes?: string;
  admin_notes?: string;
  start_date?: string;
  end_date?: string;
  time_window?: string;
  amount_total_cents?: number;
  payment_method?: "card" | "cash";
  payment_status?: "unpaid" | "paid" | "deposit_paid";
  amount_paid_cents?: number;
  referral_source?: string;
  contractor_number?: string;
}

// Enter a booking staff already priced by phone: contractor accounts, heavy
// material (weight-based), cleanouts, or any other quote_only job from the
// pricing guide. This is the "phone rep is the pricing engine" workflow the
// source document describes — staff sets the real amount_total_cents rather
// than the automated quote engine, then the booking is confirmed immediately
// (a unit is assigned if the type uses physical inventory) and synced to the
// calendar, same as a paid customer booking.
export default adminHandler("staff", async (req, user) => {
  if (req.method !== "POST") return badRequest("POST required");
  const body = await readJson<Body>(req);
  const db = supabaseAdmin();

  const required: (keyof Body)[] = ["type_id", "customer_name", "customer_phone", "delivery_address", "start_date", "amount_total_cents"];
  for (const f of required) if (body[f] === undefined || body[f] === "") return badRequest(`${f} is required`);

  const { data: type } = await db.from("dumpster_types").select("*").eq("id", body.type_id).maybeSingle();
  if (!type) return badRequest("Unknown type_id");

  const startDate = body.start_date!;
  const endDate = body.end_date || startDate;
  const amountTotal = Math.round(Number(body.amount_total_cents));
  if (!Number.isFinite(amountTotal) || amountTotal < 0) return badRequest("amount_total_cents must be a non-negative number");

  const paymentStatus = body.payment_status ?? "unpaid";
  const amountPaid =
    paymentStatus === "paid" ? amountTotal :
    paymentStatus === "deposit_paid" ? Math.min(Number(body.amount_paid_cents ?? 0), amountTotal) : 0;

  let contractorId: string | null = null;
  if (body.contractor_number?.trim()) {
    const { data: c } = await db.from("contractors").select("id,status")
      .eq("contractor_number", body.contractor_number.trim().toUpperCase()).maybeSingle();
    if (!c) return badRequest("Unknown contractor number");
    contractorId = c.id;
  }

  const { data: agr } = await db.from("agreement_templates").select("version").eq("active", true).maybeSingle();

  const { data: booking, error } = await db.from("bookings").insert({
    service: type.service,
    customer_name: body.customer_name,
    customer_email: body.customer_email || null,
    customer_phone: body.customer_phone,
    delivery_address: body.delivery_address,
    delivery_notes: body.delivery_notes ?? null,
    notes: body.notes ?? null,
    admin_notes: body.admin_notes ?? null,
    type_id: type.id,
    start_date: startDate,
    end_date: endDate,
    time_window: body.time_window ?? null,
    status: "pending",
    payment_method: body.payment_method ?? "cash",
    payment_status: "unpaid", // set via assignUnitAndConfirm below
    subtotal_cents: amountTotal,
    amount_total_cents: amountTotal,
    amount_paid_cents: 0,
    agreement_version: agr?.version ?? null,
    agreement_signed_name: `${body.customer_name} (phone agreement, entered by ${user.email})`,
    agreement_signed_at: new Date().toISOString(),
    referral_source: body.referral_source?.slice(0, 80) ?? null,
    contractor_id: contractorId,
    flags: ["staff_entered"],
  }).select().single();
  if (error) throw new Error(error.message);

  const confirmed = await assignUnitAndConfirm(booking.id, { payment_status: paymentStatus, amount_paid_cents: amountPaid });
  if (!confirmed) {
    await db.from("bookings").update({ status: "canceled" }).eq("id", booking.id);
    return badRequest("No capacity left for those dates");
  }

  if (paymentStatus !== "unpaid") {
    await db.from("payments").insert({
      booking_id: booking.id,
      kind: paymentStatus === "deposit_paid" ? "deposit" : "full",
      method: body.payment_method ?? "cash",
      amount_cents: amountPaid,
      status: "succeeded",
      note: "Entered by staff at booking time",
    });
  }

  await syncBookingEvent(booking.id);

  if (body.customer_email) {
    await sendEmail(body.customer_email, `Booking confirmed — ${booking.reference}`,
      bookingConfirmationHtml({
        reference: booking.reference, customer_name: booking.customer_name, typeName: type.name,
        start_date: startDate, end_date: endDate,
        amount_total_cents: amountTotal, amount_paid_cents: amountPaid,
        payment_method: body.payment_method ?? "cash",
      }));
  }

  await audit({ actor: user.email!, action: "booking.create_manual", entity: "bookings", entityId: booking.id, detail: { amount_total_cents: amountTotal, type: type.name } });
  return json({ booking_id: booking.id, reference: booking.reference });
});
