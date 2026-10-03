import { adminHandler } from "./_shared/admin";
import { json, badRequest, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { audit } from "./_shared/audit";

const BUCKET = "site-assets";
const ALLOWED = ["image/jpeg", "image/png", "image/webp"];
const FIELDS = ["title", "body", "badge", "bullets", "price_label", "price_text", "live_price", "image_url", "cta_label", "cta_url", "starts_on", "ends_on", "active"] as const;

// Manage the ON SITE carousel.
//   GET                          -> all slides (including inactive/expired)
//   POST {action:"create"|"update"|"delete"|"reorder"|"upload_url", ...}
export default adminHandler("admin", async (req, user) => {
  const db = supabaseAdmin();

  if (req.method === "GET") {
    const { data, error } = await db.from("site_slides").select("*").order("sort_order").order("created_at");
    if (error) throw new Error(error.message);
    return json({ slides: data ?? [] });
  }
  if (req.method !== "POST") return badRequest("GET or POST");
  const body = await readJson<Record<string, any>>(req);

  const pick = () => {
    const out: Record<string, unknown> = {};
    for (const f of FIELDS) if (f in body) out[f] = body[f] === "" ? null : body[f];
    return out;
  };

  switch (body.action) {
    case "upload_url": {
      if (body.content_type && !ALLOWED.includes(body.content_type)) return badRequest("Use a JPG, PNG or WebP image");
      const safe = String(body.filename || "slide.jpg").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-60);
      const path = `slides/${crypto.randomUUID()}-${safe}`;
      const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path);
      if (error) throw new Error(error.message);
      const { data: pub } = db.storage.from(BUCKET).getPublicUrl(path);
      return json({ path, token: data.token, public_url: pub.publicUrl });
    }
    case "create": {
      if (!body.title) return badRequest("title required");
      const { data: last } = await db.from("site_slides").select("sort_order").order("sort_order", { ascending: false }).limit(1).maybeSingle();
      const { data, error } = await db.from("site_slides")
        .insert({ ...pick(), sort_order: (last?.sort_order ?? 0) + 1 }).select().single();
      if (error) throw new Error(error.message);
      await audit({ actor: user.email!, action: "slide.create", entity: "site_slides", entityId: data.id });
      return json({ slide: data });
    }
    case "update": {
      if (!body.id) return badRequest("id required");
      const { data, error } = await db.from("site_slides").update(pick()).eq("id", body.id).select().single();
      if (error) throw new Error(error.message);
      await audit({ actor: user.email!, action: "slide.update", entity: "site_slides", entityId: body.id });
      return json({ slide: data });
    }
    case "delete": {
      if (!body.id) return badRequest("id required");
      const { error } = await db.from("site_slides").delete().eq("id", body.id);
      if (error) throw new Error(error.message);
      await audit({ actor: user.email!, action: "slide.delete", entity: "site_slides", entityId: body.id });
      return json({ ok: true });
    }
    case "reorder": {
      // body.ids = slide ids in their new display order
      if (!Array.isArray(body.ids)) return badRequest("ids array required");
      for (let i = 0; i < body.ids.length; i++) {
        const { error } = await db.from("site_slides").update({ sort_order: i + 1 }).eq("id", body.ids[i]);
        if (error) throw new Error(error.message);
      }
      return json({ ok: true });
    }
    default:
      return badRequest("Unknown action");
  }
});
