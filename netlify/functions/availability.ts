import { withErrors, json, badRequest } from "./_shared/response";
import { typeAvailability, availabilityByType } from "./_shared/availability";
import { supabaseAdmin } from "./_shared/supabase";

// GET /api/availability?type=<id>&start=YYYY-MM-DD&end=YYYY-MM-DD
//   -> { available: n }  for a single type
// GET /api/availability?start=...&end=...
//   -> { availability: { [typeId]: n } }  for all active types
export default withErrors(async (req: Request) => {
  const url = new URL(req.url);
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end") || start;
  const type = url.searchParams.get("type");

  if (!start || !end) return badRequest("start and end dates are required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return badRequest("dates must be YYYY-MM-DD");
  }

  if (type) {
    const { data: t } = await supabaseAdmin()
      .from("dumpster_types").select("uses_inventory").eq("id", type).maybeSingle();
    const available = await typeAvailability(type, start, end, t?.uses_inventory ?? true);
    return json({ available });
  }
  const availability = await availabilityByType(start, end);
  return json({ availability });
});
