import { adminHandler } from "./_shared/admin";
import { json, badRequest, notFound, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { deleteCalendarEvent, calendarConfigured } from "./_shared/google-calendar";
import { audit } from "./_shared/audit";

const BUCKET = "booking-uploads";

interface Body {
  kind?: "booking" | "customer" | "contractor";
  id?: string;      // booking / contractor
  email?: string;   // customer
  phone?: string;   // customer (used when there is no email)
}

// Permanently delete test or junk records (admin only). Bookings take their charges,
// payments, photos and add-ons with them (FK cascade); the calendar event and stored
// photo files are removed here. Stripe is not touched: refund real money first.
export default adminHandler("admin", async (req, user) => {
  if (req.method !== "POST") return badRequest("POST required");
  const body = await readJson<Body>(req);
  const db = supabaseAdmin();

  const purgeBookings = async (ids: string[]) => {
    if (!ids.length) return;
    const [{ data: rows }, { data: photos }] = await Promise.all([
      db.from("bookings").select("id,google_event_id").in("id", ids),
      db.from("booking_photos").select("storage_path").in("booking_id", ids),
    ]);
    if (calendarConfigured()) {
      for (const r of rows ?? []) {
        if (!r.google_event_id) continue;
        try { await deleteCalendarEvent(r.google_event_id); } catch (err) { console.error("[delete] calendar:", (err as Error).message); }
      }
    }
    const paths = (photos ?? []).map((p) => p.storage_path).filter(Boolean);
    if (paths.length) await db.storage.from(BUCKET).remove(paths);
    const { error } = await db.from("bookings").delete().in("id", ids);
    if (error) throw new Error(error.message);
  };

  if (body.kind === "booking") {
    if (!body.id) return badRequest("id required");
    const { data: b } = await db.from("bookings").select("id,reference,customer_name").eq("id", body.id).maybeSingle();
    if (!b) return notFound("Booking not found");
    await purgeBookings([b.id]);
    await audit({ actor: user.email!, action: "booking.delete", entity: "bookings", entityId: b.id, detail: { reference: b.reference, customer: b.customer_name } });
    return json({ ok: true, bookings: 1 });
  }

  if (body.kind === "customer") {
    const email = (body.email ?? "").trim();
    const phone = (body.phone ?? "").trim();
    if (!email && !phone) return badRequest("email or phone required");
    // Same grouping as the Customers page: by email, or by phone when there is no email.
    // ilike = case-insensitive exact match once % and _ are escaped.
    const emailLike = email.replace(/[\\%_]/g, "\\$&");
    let q = db.from("bookings").select("id");
    q = email ? q.ilike("customer_email", emailLike) : q.eq("customer_phone", phone).eq("customer_email", "");
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    const ids = (rows ?? []).map((r) => r.id);
    await purgeBookings(ids);
    let quotes = 0;
    if (email) {
      const { data: qr } = await db.from("quote_requests").delete().ilike("email", emailLike).is("contractor_id", null).select("id");
      quotes = qr?.length ?? 0;
    }
    await audit({ actor: user.email!, action: "customer.delete", entity: "bookings", detail: { email, phone, bookings: ids.length, quotes } });
    return json({ ok: true, bookings: ids.length, quotes });
  }

  if (body.kind === "contractor") {
    if (!body.id) return badRequest("id required");
    const { data: c } = await db.from("contractors").select("*").eq("id", body.id).maybeSingle();
    if (!c) return notFound("Contractor not found");
    // Their bookings and quote requests stay (contractor_id is set null); delete those separately.
    if (c.tax_exempt_file) await db.storage.from(BUCKET).remove([c.tax_exempt_file]);
    const { error } = await db.from("contractors").delete().eq("id", c.id);
    if (error) throw new Error(error.message);
    await audit({ actor: user.email!, action: "contractor.delete", entity: "contractors", entityId: c.id, detail: { company: c.company_name, email: c.email } });
    return json({ ok: true });
  }

  return badRequest("Unknown kind");
});
