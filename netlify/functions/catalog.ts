import { withErrors, json } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";

// Public catalog: active bookable types, their duration price tiers (for
// duration_tiers services), and the add-on item list (used by the junk
// hauling flow). Everything a customer needs to price a booking client-side
// before submitting — the server always recomputes the real total.
export default withErrors(async () => {
  const db = supabaseAdmin();
  const [{ data: types, error: typesErr }, { data: tiers, error: tiersErr }, { data: addons, error: addonsErr }] =
    await Promise.all([
      db.from("dumpster_types")
        .select(
          "id,name,service,category,pricing_mode,size_yards,description,base_price_cents,deposit_cents," +
            "rental_days_included,extra_day_fee_cents,weight_limit_tons,overage_fee_cents,price_note,sort_order",
        )
        .eq("active", true)
        .order("sort_order", { ascending: true }),
      db.from("duration_price_tiers").select("type_id,days,price_cents,label,sort_order").order("sort_order"),
      db.from("addon_items").select("id,name,category,price_cents,sort_order").eq("active", true).order("sort_order"),
    ]);
  if (typesErr) throw new Error(typesErr.message);
  if (tiersErr) throw new Error(tiersErr.message);
  if (addonsErr) throw new Error(addonsErr.message);

  return json({ types: types ?? [], tiers: tiers ?? [], addons: addons ?? [] });
});
