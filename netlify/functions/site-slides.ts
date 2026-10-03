import { withErrors, json } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";

// Public: active ON SITE carousel slides inside their optional promo window, in admin order.
export default withErrors(async () => {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabaseAdmin()
    .from("site_slides")
    .select("id,title,body,badge,bullets,price_label,price_text,live_price,image_url,cta_label,cta_url,starts_on,ends_on,sort_order")
    .eq("active", true)
    .order("sort_order")
    .order("created_at");
  if (error) throw new Error(error.message);
  const slides = (data ?? []).filter(
    (s) => (!s.starts_on || s.starts_on <= today) && (!s.ends_on || s.ends_on >= today),
  );
  return json({ slides }, 200, { "cache-control": "public, max-age=60" });
});
