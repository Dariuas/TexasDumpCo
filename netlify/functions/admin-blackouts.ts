import { adminHandler } from "./_shared/admin";
import { json, badRequest, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { audit } from "./_shared/audit";

// Manage blackout windows that block booking dates/times (all types or one type).
export default adminHandler("staff", async (req, user) => {
  const db = supabaseAdmin();

  if (req.method === "GET") {
    const { data, error } = await db.from("blackouts").select("*").order("start_at");
    if (error) throw new Error(error.message);
    return json({ blackouts: data ?? [] });
  }

  if (req.method !== "POST") return badRequest("GET or POST");
  const body = await readJson<Record<string, any>>(req);

  if (body.action === "delete") {
    if (!body.id) return badRequest("id required");
    const { error } = await db.from("blackouts").delete().eq("id", body.id);
    if (error) throw new Error(error.message);
    await audit({ actor: user.email!, action: "blackout.delete", entity: "blackouts", entityId: body.id });
    return json({ ok: true });
  }

  // create
  if (!body.start_at || !body.end_at) return badRequest("start_at and end_at required");
  const scope = body.type_id ? "type" : "all";
  const { data, error } = await db
    .from("blackouts")
    .insert({
      start_at: body.start_at,
      end_at: body.end_at,
      scope,
      type_id: body.type_id ?? null,
      reason: body.reason ?? null,
    })
    .select().single();
  if (error) throw new Error(error.message);
  await audit({ actor: user.email!, action: "blackout.create", entity: "blackouts", entityId: data.id, detail: body });
  return json({ blackout: data });
});
