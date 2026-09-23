import { adminHandler } from "./_shared/admin";
import { json, badRequest, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { audit } from "./_shared/audit";

const FIELDS = [
  "code", "kind", "value", "min_amount_cents", "max_uses",
  "applies_to", "starts_at", "ends_at", "active",
];

function pick(obj: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const f of FIELDS) if (obj[f] !== undefined) out[f] = obj[f];
  return out;
}

// Promo code CRUD (admin only). uses_count is read-only here; the booking
// flow increments it when a code is actually redeemed.
export default adminHandler("admin", async (req, user) => {
  const db = supabaseAdmin();

  if (req.method === "GET") {
    const { data, error } = await db.from("promo_codes").select("*").order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return json({ promos: data ?? [] });
  }

  if (req.method !== "POST") return badRequest("GET or POST");
  const body = await readJson<Record<string, any>>(req);

  switch (body.action) {
    case "create": {
      if (!body.code || !body.kind || body.value == null) return badRequest("code, kind, value required");
      const row = pick(body);
      row.code = String(body.code).trim().toUpperCase();
      const { data, error } = await db.from("promo_codes").insert(row).select().single();
      if (error) throw new Error(error.message);
      await audit({ actor: user.email!, action: "promo.create", entity: "promo_codes", entityId: data.id });
      return json({ promo: data });
    }
    case "update": {
      if (!body.id) return badRequest("id required");
      const { data, error } = await db.from("promo_codes").update(pick(body)).eq("id", body.id).select().single();
      if (error) throw new Error(error.message);
      await audit({ actor: user.email!, action: "promo.update", entity: "promo_codes", entityId: body.id });
      return json({ promo: data });
    }
    case "delete": {
      if (!body.id) return badRequest("id required");
      const { error } = await db.from("promo_codes").delete().eq("id", body.id);
      if (error) throw new Error(error.message);
      await audit({ actor: user.email!, action: "promo.delete", entity: "promo_codes", entityId: body.id });
      return json({ ok: true });
    }
    default:
      return badRequest("unknown action");
  }
});
