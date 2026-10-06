import { adminHandler } from "./_shared/admin";
import { json, badRequest, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { assignUnitAndConfirm } from "./_shared/confirm";
import { syncBookingEvent } from "./_shared/booking-calendar";
import { sendEmail, bookingConfirmationHtml } from "./_shared/email";
import { audit } from "./_shared/audit";
import { findContractor } from "./_shared/contractors";

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
  as_request?: boolean;          // itemize next: create as an open request, price it in the invoice builder
  quote_request_id?: string;     // homepage quote request this booking comes from
  distance_miles?: number;       // round trip, from the admin distance check
  distance_fee_cents?: number;
}

// Enter a booking staff already priced by phone: contractor accounts, heavy
// material (weight-based), cleanouts, or any other quote_only job from the
// pricing guide. This is the "phone rep is the pricing engine" workflow the
// source document describes — staff sets the real amount_total_cents rather
// than the automated quote engine, then the booking is confirmed immediately
// (a unit is assigned if the type uses physical inventory) and synced to the
// calendar, same as a paid customer booking.
// With as_request the booking is created as an open request instead (calendar shows it
// PENDING) and staff price it line by line in the invoice builder, which confirms it.
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

  const asRequest = !!body.as_request;
  const paymentStatus = asRequest ? "unpaid" : body.payment_status ?? "unpaid";
  const amountPaid =
    paymentStatus === "paid" ? amountTotal :
    paymentStatus === "deposit_paid" ? Math.min(Number(body.amount_paid_cents ?? 0), amountTotal) : 0;

  // Contractor by number, or by the phone/email typed in this field (staff lookup).
  let contractorId: string | null = null;
  let taxExempt = false;
  const lookup = body.contractor_number?.trim();
  if (lookup) {
    const c = await findContractor(lookup.includes("@") ? { email: lookup } : /^[\d\s()+.-]+$/.test(lookup) ? { phone: lookup } : { number: lookup });
    if (!c) return badRequest("No contractor found for that number, phone or email");
    contractorId = c.id;
    taxExempt = !!c.tax_exempt;
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
    payment_method: asRequest ? "card" : body.payment_method ?? "cash",
    payment_status: "unpaid", // set via assignUnitAndConfirm below
    subtotal_cents: amountTotal,
    amount_total_cents: amountTotal,
    amount_paid_cents: 0,
    agreement_version: agr?.version ?? null,
    agreement_signed_name: `${body.customer_name} (phone agreement, entered by ${user.email})`,
    agreement_signed_at: new Date().toISOString(),
    referral_source: body.referral_source?.slice(0, 80) ?? null,
    contractor_id: contractorId,
    tax_exempt: taxExempt,
    distance_miles: Number.isFinite(Number(body.distance_miles)) && body.distance_miles != null ? Number(body.distance_miles) : null,
    distance_fee_cents: Math.max(0, Math.round(Number(body.distance_fee_cents) || 0)),
    flags: ["staff_entered", ...(asRequest ? ["quote_requested"] : []), ...(asRequest && contractorId ? ["contractor_request"] : [])],
  }).select().single();
  if (error) throw new Error(error.message);

  // Link the homepage quote request and carry over its photos.
  if (body.quote_request_id) {
    const { data: qr } = await db.from("quote_requests").select("id,photo_paths").eq("id", body.quote_request_id).maybeSingle();
    if (qr) {
      await db.from("quote_requests").update({ status: "booked", booking_id: booking.id, contractor_id: contractorId ?? undefined }).eq("id", qr.id);
      const paths = (qr.photo_paths as string[] | null) ?? [];
      if (paths.length) await db.from("booking_photos").insert(paths.map((p) => ({ booking_id: booking.id, kind: "junk_items", storage_path: p, uploaded_by: "customer" })));
    }
  }

  if (asRequest) {
    await syncBookingEvent(booking.id); // PENDING until the invoice builder confirms it
    await audit({ actor: user.email!, action: "booking.create_request", entity: "bookings", entityId: booking.id, detail: { type: type.name, quote_request: body.quote_request_id ?? null } });
    return json({ booking_id: booking.id, reference: booking.reference, request: true });
  }

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
