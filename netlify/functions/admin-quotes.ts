import { adminHandler } from "./_shared/admin";
import { json, badRequest, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";

const BUCKET = "booking-uploads";

// Homepage quote requests: list (with signed photo URLs) and update status/notes.
export default adminHandler("staff", async (req) => {
  const db = supabaseAdmin();
  if (req.method === "GET") {
    const { data, error } = await db.from("quote_requests").select("*").order("created_at", { ascending: false }).limit(300);
    if (error) throw new Error(error.message);
    const quotes = await Promise.all((data ?? []).map(async (q) => ({
      ...q,
      photos: (await Promise.all(((q.photo_paths as string[]) ?? []).map(async (p) => {
        const { data: s } = await db.storage.from(BUCKET).createSignedUrl(p, 3600);
        return s?.signedUrl ?? null;
      }))).filter(Boolean),
    })));
    return json({ quotes });
  }
  if (req.method !== "POST") return badRequest("GET or POST");
  const b = await readJson<{ id?: string; status?: string; admin_notes?: string }>(req);
  if (!b.id) return badRequest("id required");
  const patch: Record<string, unknown> = {};
  if (b.status) {
    if (!["new", "contacted", "booked", "closed"].includes(b.status)) return badRequest("bad status");
    patch.status = b.status;
  }
  if (b.admin_notes !== undefined) patch.admin_notes = b.admin_notes;
  const { error } = await db.from("quote_requests").update(patch).eq("id", b.id);
  if (error) throw new Error(error.message);
  return json({ ok: true });
});
