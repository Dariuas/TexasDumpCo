import { adminHandler } from "./_shared/admin";
import { json, badRequest, forbidden, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { audit } from "./_shared/audit";

const TYPE_FIELDS = [
  "name", "service", "category", "pricing_mode", "size_yards", "description",
  "base_price_cents", "deposit_cents", "rental_days_included", "extra_day_fee_cents",
  "weight_limit_tons", "overage_fee_cents", "uses_inventory", "equipment_pool",
  "price_note", "sort_order", "active",
];
const UNIT_STATUSES = ["available", "in_service", "maintenance", "out_of_service"];
const PRICING_MODES = ["flat", "duration_tiers", "quote_only"];

function pick(obj: Record<string, unknown>, fields: string[]) {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (obj[f] !== undefined) out[f] = obj[f];
  return out;
}

// Manage dumpster/junk types (incl. pricing), physical inventory units,
// per-duration price tiers, and add-on items. GET = list everything.
// POST { action, ... } = mutate. Type/tier/addon create-delete + core pricing
// are admin-only; unit status changes and small edits are allowed for staff.
export default adminHandler("staff", async (req, user) => {
  const db = supabaseAdmin();

  if (req.method === "GET") {
    const [{ data: types }, { data: units }, { data: tiers }, { data: addons }] = await Promise.all([
      db.from("dumpster_types").select("*").order("sort_order"),
      db.from("inventory_units").select("*").order("created_at"),
      db.from("duration_price_tiers").select("*").order("sort_order"),
      db.from("addon_items").select("*").order("sort_order"),
    ]);
    return json({ types: types ?? [], units: units ?? [], tiers: tiers ?? [], addons: addons ?? [] });
  }

  if (req.method !== "POST") return badRequest("GET or POST");
  const body = await readJson<Record<string, any>>(req);
  const action = body.action as string;
  const isAdmin = user.role === "admin";

  switch (action) {
    case "create_type": {
      if (!isAdmin) return forbidden("Admin required to add types");
      if (!body.name) return badRequest("name required");
      if (body.pricing_mode && !PRICING_MODES.includes(body.pricing_mode)) return badRequest("invalid pricing_mode");
      const { data, error } = await db
        .from("dumpster_types").insert(pick(body, TYPE_FIELDS)).select().single();
      if (error) throw new Error(error.message);
      await audit({ actor: user.email!, action: "type.create", entity: "dumpster_types", entityId: data.id });
      return json({ type: data });
    }
    case "update_type": {
      if (!isAdmin) return forbidden("Admin required to edit pricing/types");
      if (!body.id) return badRequest("id required");
      if (body.pricing_mode && !PRICING_MODES.includes(body.pricing_mode)) return badRequest("invalid pricing_mode");
      const { data, error } = await db
        .from("dumpster_types").update(pick(body, TYPE_FIELDS)).eq("id", body.id).select().single();
      if (error) throw new Error(error.message);
      await audit({ actor: user.email!, action: "type.update", entity: "dumpster_types", entityId: body.id, detail: pick(body, TYPE_FIELDS) });
      return json({ type: data });
    }
    case "delete_type": {
      if (!isAdmin) return forbidden("Admin required");
      if (!body.id) return badRequest("id required");
      // Soft-delete: keep history intact by deactivating rather than deleting.
      const { error } = await db.from("dumpster_types").update({ active: false }).eq("id", body.id);
      if (error) throw new Error(error.message);
      await audit({ actor: user.email!, action: "type.deactivate", entity: "dumpster_types", entityId: body.id });
      return json({ ok: true });
    }
    case "create_unit": {
      if (!body.type_id || !body.label) return badRequest("type_id and label required");
      const { data, error } = await db
        .from("inventory_units")
        .insert({ type_id: body.type_id, label: body.label, status: body.status ?? "available", notes: body.notes ?? null })
        .select().single();
      if (error) throw new Error(error.message);
      await audit({ actor: user.email!, action: "unit.create", entity: "inventory_units", entityId: data.id });
      return json({ unit: data });
    }
    case "update_unit": {
      if (!body.id) return badRequest("id required");
      if (body.status && !UNIT_STATUSES.includes(body.status)) return badRequest("invalid status");
      const { data, error } = await db
        .from("inventory_units")
        .update(pick(body, ["label", "status", "notes", "type_id"]))
        .eq("id", body.id).select().single();
      if (error) throw new Error(error.message);
      await audit({ actor: user.email!, action: "unit.update", entity: "inventory_units", entityId: body.id, detail: pick(body, ["status", "label"]) });
      return json({ unit: data });
    }
    case "delete_unit": {
      if (!isAdmin) return forbidden("Admin required");
      if (!body.id) return badRequest("id required");
      const { error } = await db.from("inventory_units").delete().eq("id", body.id);
      if (error) throw new Error(error.message);
      await audit({ actor: user.email!, action: "unit.delete", entity: "inventory_units", entityId: body.id });
      return json({ ok: true });
    }

    // ---- duration price tiers (Section A/C pricing) ----
    case "upsert_tier": {
      if (!isAdmin) return forbidden("Admin required to edit pricing");
      if (!body.type_id || !body.days || body.price_cents == null) return badRequest("type_id, days, price_cents required");
      const { data, error } = await db
        .from("duration_price_tiers")
        .upsert({ type_id: body.type_id, days: body.days, price_cents: body.price_cents, label: body.label ?? null, sort_order: body.sort_order ?? body.days }, { onConflict: "type_id,days" })
        .select().single();
      if (error) throw new Error(error.message);
      await audit({ actor: user.email!, action: "tier.upsert", entity: "duration_price_tiers", entityId: data.id, detail: { type_id: body.type_id, days: body.days, price_cents: body.price_cents } });
      return json({ tier: data });
    }
    case "delete_tier": {
      if (!isAdmin) return forbidden("Admin required");
      if (!body.id) return badRequest("id required");
      const { error } = await db.from("duration_price_tiers").delete().eq("id", body.id);
      if (error) throw new Error(error.message);
      await audit({ actor: user.email!, action: "tier.delete", entity: "duration_price_tiers", entityId: body.id });
      return json({ ok: true });
    }

    // ---- add-on items (Sections D/E/G specialty items & access fees) ----
    case "create_addon": {
      if (!isAdmin) return forbidden("Admin required");
      if (!body.name || body.price_cents == null) return badRequest("name and price_cents required");
      const { data, error } = await db
        .from("addon_items")
        .insert({ name: body.name, category: body.category ?? "specialty", price_cents: body.price_cents, active: body.active ?? true, sort_order: body.sort_order ?? 0 })
        .select().single();
      if (error) throw new Error(error.message);
      await audit({ actor: user.email!, action: "addon.create", entity: "addon_items", entityId: data.id });
      return json({ addon: data });
    }
    case "update_addon": {
      if (!isAdmin) return forbidden("Admin required");
      if (!body.id) return badRequest("id required");
      const { data, error } = await db
        .from("addon_items")
        .update(pick(body, ["name", "category", "price_cents", "active", "sort_order"]))
        .eq("id", body.id).select().single();
      if (error) throw new Error(error.message);
      await audit({ actor: user.email!, action: "addon.update", entity: "addon_items", entityId: body.id });
      return json({ addon: data });
    }
    case "delete_addon": {
      if (!isAdmin) return forbidden("Admin required");
      if (!body.id) return badRequest("id required");
      const { error } = await db.from("addon_items").delete().eq("id", body.id);
      if (error) throw new Error(error.message);
      await audit({ actor: user.email!, action: "addon.delete", entity: "addon_items", entityId: body.id });
      return json({ ok: true });
    }

    default:
      return badRequest("unknown action");
  }
});
