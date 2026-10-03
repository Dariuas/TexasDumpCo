import { withErrors, json, badRequest, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { loadSettings } from "./_shared/settings";
import { contractorDiscountCents, DurationTier } from "./_shared/pricing";

// Public: confirm a contractor number is approved for this email and report the
// discount it earns on the selected item, so the booking summary can show it.
// create-booking recomputes and enforces the same rule; this is display only.
export default withErrors(async (req: Request) => {
  if (req.method !== "POST") return badRequest("POST required");
  const b = await readJson<{ contractor_number?: string; email?: string; type_id?: string; rental_days?: number }>(req);
  if (!b.contractor_number || !b.email || !b.type_id) return badRequest("contractor_number, email and type_id required");
  const db = supabaseAdmin();

  const { data: c } = await db.from("contractors").select("contractor_number,email,status")
    .eq("contractor_number", b.contractor_number.trim().toUpperCase()).maybeSingle();
  // Same message for unknown / wrong email so numbers can't be probed.
  if (!c || c.email.toLowerCase() !== b.email.trim().toLowerCase()) return badRequest("Contractor number not recognized for this email");
  if (c.status !== "approved") return badRequest("This contractor number is still waiting for approval. We will email you when it is active.");

  const { data: type } = await db.from("dumpster_types").select("id,category").eq("id", b.type_id).maybeSingle();
  if (!type) return badRequest("Unknown item");
  const { data: tiers } = await db.from("duration_price_tiers").select("days,price_cents").eq("type_id", type.id);
  const settings = await loadSettings();
  const discount = contractorDiscountCents(type.category, Math.max(1, Number(b.rental_days) || 7), (tiers ?? []) as DurationTier[], settings);
  return json({ contractor_number: c.contractor_number, discount_cents: discount });
});
