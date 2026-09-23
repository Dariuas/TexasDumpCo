import { adminHandler } from "./_shared/admin";
import { json, badRequest, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { loadSettings } from "./_shared/settings";
import { audit } from "./_shared/audit";

// Read all settings (GET) or upsert a batch of key/value pairs (POST).
// Admin-only; includes the cash-accepted master switch, tax, deposit %, etc.
export default adminHandler("admin", async (req, user) => {
  if (req.method === "GET") {
    return json({ settings: await loadSettings() });
  }
  if (req.method !== "POST") return badRequest("GET or POST");

  const body = await readJson<{ settings?: Record<string, unknown> }>(req);
  if (!body.settings || typeof body.settings !== "object") return badRequest("settings object required");

  const rows = Object.entries(body.settings).map(([key, value]) => ({ key, value }));
  const { error } = await supabaseAdmin().from("settings").upsert(rows, { onConflict: "key" });
  if (error) throw new Error(error.message);

  await audit({ actor: user.email!, action: "settings.update", detail: Object.keys(body.settings) });
  return json({ settings: await loadSettings() });
});
