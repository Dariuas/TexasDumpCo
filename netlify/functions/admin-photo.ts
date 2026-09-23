import { adminHandler } from "./_shared/admin";
import { json, badRequest, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { audit } from "./_shared/audit";

const BUCKET = "booking-uploads";

// Staff photo management for a booking: attach drop-off/pickup photos
// (already uploaded via /api/upload-url) or delete one.
export default adminHandler("staff", async (req, user) => {
  if (req.method !== "POST") return badRequest("POST required");
  const body = await readJson<Record<string, any>>(req);
  const db = supabaseAdmin();

  if (body.action === "delete") {
    if (!body.photo_id) return badRequest("photo_id required");
    const { data: photo } = await db.from("booking_photos").select("storage_path").eq("id", body.photo_id).maybeSingle();
    if (photo) await db.storage.from(BUCKET).remove([photo.storage_path]);
    await db.from("booking_photos").delete().eq("id", body.photo_id);
    await audit({ actor: user.email!, action: "photo.delete", entity: "booking_photos", entityId: body.photo_id });
    return json({ ok: true });
  }

  // attach
  if (!body.booking_id || !body.path) return badRequest("booking_id and path required");
  const kind = ["drop_off", "pickup", "delivery_site", "junk_items", "other"].includes(body.kind) ? body.kind : "drop_off";
  const { data, error } = await db.from("booking_photos").insert({
    booking_id: body.booking_id, kind, storage_path: body.path, uploaded_by: "staff",
  }).select().single();
  if (error) throw new Error(error.message);
  await audit({ actor: user.email!, action: "photo.attach", entity: "bookings", entityId: body.booking_id, detail: { kind } });
  return json({ photo: data });
});
