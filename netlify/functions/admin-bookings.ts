import { adminHandler } from "./_shared/admin";
import { json, notFound } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";

const BUCKET = "booking-uploads";

// GET /api/admin-bookings                -> filtered list
//   ?status=&service=&from=&to=&q=&payment_status=
// GET /api/admin-bookings?id=<uuid>      -> full detail + photos (signed) + payments
export default adminHandler("staff", async (req) => {
  const db = supabaseAdmin();
  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  if (id) {
    const { data: booking } = await db
      .from("bookings")
      .select("*, dumpster_types(name,service), inventory_units(label), promo_codes(code)")
      .eq("id", id).maybeSingle();
    if (!booking) return notFound("Booking not found");

    const { data: photos } = await db.from("booking_photos").select("*").eq("booking_id", id);
    // Sign each photo for viewing (1 hour).
    const signed = await Promise.all(
      (photos ?? []).map(async (p) => {
        const { data } = await db.storage.from(BUCKET).createSignedUrl(p.storage_path, 3600);
        return { ...p, url: data?.signedUrl ?? null };
      }),
    );
    const { data: payments } = await db.from("payments").select("*").eq("booking_id", id).order("created_at");

    return json({ booking, photos: signed, payments: payments ?? [] });
  }

  let q = db.from("bookings")
    .select("id,reference,service,customer_name,customer_phone,customer_email,delivery_address,start_date,end_date,status,payment_method,payment_status,amount_total_cents,amount_paid_cents,flags,created_at,dumpster_types(name)")
    .order("start_date", { ascending: true }).limit(500);

  const status = url.searchParams.get("status");
  const service = url.searchParams.get("service");
  const paymentStatus = url.searchParams.get("payment_status");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const search = url.searchParams.get("q");

  if (status) q = q.eq("status", status);
  if (service) q = q.eq("service", service);
  if (paymentStatus) q = q.eq("payment_status", paymentStatus);
  if (from) q = q.gte("start_date", from);
  if (to) q = q.lte("start_date", to);
  if (search) q = q.or(`customer_name.ilike.%${search}%,reference.ilike.%${search}%,customer_email.ilike.%${search}%,customer_phone.ilike.%${search}%`);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return json({ bookings: data ?? [] });
});
