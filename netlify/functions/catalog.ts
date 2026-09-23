import { withErrors, json } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";

// Public catalog of active, bookable types (used by the booking flow + pricing).
export default withErrors(async () => {
  const { data, error } = await supabaseAdmin()
    .from("dumpster_types")
    .select(
      "id,name,service,size_yards,description,base_price_cents,deposit_cents," +
        "rental_days_included,extra_day_fee_cents,weight_limit_tons,overage_fee_cents,sort_order",
    )
    .eq("active", true)
    .order("sort_order", { ascending: true });
  if (error) throw new Error(error.message);

  return json({ types: data ?? [] });
});
