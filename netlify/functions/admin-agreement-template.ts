import { adminHandler } from "./_shared/admin";
import { json, badRequest, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { audit } from "./_shared/audit";

// View/edit the rental agreement. Saving creates a NEW version and makes it
// active, so previously-signed bookings keep their original text/version.
export default adminHandler("admin", async (req, user) => {
  const db = supabaseAdmin();

  if (req.method === "GET") {
    const { data, error } = await db
      .from("agreement_templates").select("*").order("version", { ascending: false });
    if (error) throw new Error(error.message);
    return json({ templates: data ?? [] });
  }
  if (req.method !== "POST") return badRequest("GET or POST");

  const body = await readJson<{ title?: string; body_html?: string }>(req);
  if (!body.body_html) return badRequest("body_html required");

  const { data: latest } = await db
    .from("agreement_templates").select("version").order("version", { ascending: false }).limit(1).maybeSingle();
  const nextVersion = (latest?.version ?? 0) + 1;

  // Deactivate the current active template, then insert the new active one.
  await db.from("agreement_templates").update({ active: false }).eq("active", true);
  const { data, error } = await db
    .from("agreement_templates")
    .insert({ version: nextVersion, title: body.title ?? "Rental Agreement", body_html: body.body_html, active: true })
    .select().single();
  if (error) throw new Error(error.message);

  await audit({ actor: user.email!, action: "agreement.publish", entity: "agreement_templates", entityId: data.id, detail: { version: nextVersion } });
  return json({ template: data });
});
