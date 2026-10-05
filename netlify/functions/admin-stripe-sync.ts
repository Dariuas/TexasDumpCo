import { adminHandler } from "./_shared/admin";
import { json, badRequest, readJson } from "./_shared/response";
import { syncAll, syncType, syncAddon } from "./_shared/stripe-catalog";
import { audit } from "./_shared/audit";

export default adminHandler("admin", async (req, user) => {
  if (req.method !== "POST") return badRequest("POST required");
  const { scope, id } = await readJson<{ scope?: "all" | "type" | "addon"; id?: string }>(req);
  if (scope === "type" && id) { await syncType(id); return json({ ok: 1, failed: [] }); }
  if (scope === "addon" && id) { await syncAddon(id); return json({ ok: 1, failed: [] }); }
  if (scope !== "all") return badRequest("scope must be all, type or addon");
  const result = await syncAll();
  await audit({ actor: user.email!, action: "stripe.sync_all", entity: "stripe", detail: result as unknown as Record<string, unknown> });
  return json(result);
});
