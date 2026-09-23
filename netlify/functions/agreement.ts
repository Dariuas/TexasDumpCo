import { withErrors, json, notFound } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";

// Public: the active rental agreement to display before signing.
export default withErrors(async () => {
  const { data, error } = await supabaseAdmin()
    .from("agreement_templates")
    .select("version,title,body_html")
    .eq("active", true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return notFound("No active agreement configured");
  return json(data);
});
