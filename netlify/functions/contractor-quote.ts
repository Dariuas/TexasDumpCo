import { withErrors, json, badRequest, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { loadSettings } from "./_shared/settings";
import { contractorDiscountCents, DurationTier } from "./_shared/pricing";
import { findContractor, matchesContact } from "./_shared/contractors";

// Public: confirm a contractor account (number, or the email/phone on the account)
// is approved and report the estimated discount on the selected item, so the
// booking summary can show it. Display only; contractor bookings are requests the
// admin prices and confirms, and create-booking recomputes everything.
export default withErrors(async (req: Request) => {
  if (req.method !== "POST") return badRequest("POST required");
  const b = await readJson<{ contractor_number?: string; email?: string; phone?: string; type_id?: string; rental_days?: number }>(req);
  if (!b.type_id || (!b.email && !b.phone)) return badRequest("type_id and email or phone required");
  const db = supabaseAdmin();

  let c = await findContractor({ number: b.contractor_number, email: b.email, phone: b.phone });
  // Same message for unknown / mismatched details so numbers can't be probed.
  if (c && !matchesContact(c, b.email, b.phone)) c = null;
  if (!c) return badRequest(b.contractor_number ? "Contractor number not recognized for this email or phone" : "No contractor account found for this email or phone. We'll start your application when you submit.");
  if (c.status !== "approved") return badRequest("Your contractor account is still being verified. You can still send this request.");

  const { data: type } = await db.from("dumpster_types").select("id,category").eq("id", b.type_id).maybeSingle();
  if (!type) return badRequest("Unknown item");
  const { data: tiers } = await db.from("duration_price_tiers").select("days,price_cents").eq("type_id", type.id);
  const settings = await loadSettings();
  const discount = contractorDiscountCents(type.category, Math.max(1, Number(b.rental_days) || 7), (tiers ?? []) as DurationTier[], settings);
  return json({ contractor_number: c.contractor_number, discount_cents: discount, tax_exempt: c.tax_exempt });
});
