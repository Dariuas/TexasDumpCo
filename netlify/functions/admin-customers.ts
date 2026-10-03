import { adminHandler } from "./_shared/admin";
import { json } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";

// High-level customer tracker: one row per customer (grouped by email), derived from bookings.
export default adminHandler("staff", async () => {
  const { data, error } = await supabaseAdmin()
    .from("bookings")
    .select("customer_name,customer_email,customer_phone,start_date,status,amount_total_cents,amount_paid_cents,referral_source,contractor_id,created_at")
    .order("created_at", { ascending: false })
    .limit(5000);
  if (error) throw new Error(error.message);

  const map = new Map<string, any>();
  for (const b of data ?? []) {
    const key = (b.customer_email || b.customer_phone).toLowerCase();
    const c = map.get(key) ?? {
      name: b.customer_name, email: b.customer_email, phone: b.customer_phone,
      bookings: 0, spend_cents: 0, last_booking: "", first_booking: "", referral_source: null, contractor: false,
    };
    if (b.status !== "canceled") { c.bookings += 1; c.spend_cents += b.amount_paid_cents || 0; }
    if (!c.last_booking || b.start_date > c.last_booking) c.last_booking = b.start_date;
    if (!c.first_booking || b.start_date < c.first_booking) c.first_booking = b.start_date;
    c.referral_source = c.referral_source ?? b.referral_source;
    c.contractor = c.contractor || !!b.contractor_id;
    map.set(key, c);
  }
  const customers = [...map.values()].sort((a, b) => (b.last_booking || "").localeCompare(a.last_booking || ""));
  return json({ customers });
});
