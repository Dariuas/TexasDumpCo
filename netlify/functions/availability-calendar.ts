import { withErrors, json, badRequest } from "./_shared/response";
import { typeAvailability } from "./_shared/availability";
import { supabaseAdmin } from "./_shared/supabase";

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
function fmt(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// GET /api/availability-calendar?type=<id>&days=<n>&month=YYYY-MM
// Returns, for every calendar day in the month, the availability of a
// `days`-long booking STARTING that day — i.e. "can I start here?" — so a
// customer or staff member can browse a month and click an open date rather
// than guess-and-check one date at a time.
export default withErrors(async (req: Request) => {
  const url = new URL(req.url);
  const type = url.searchParams.get("type");
  const days = Math.max(1, Number(url.searchParams.get("days") || 1));
  const month = url.searchParams.get("month"); // YYYY-MM

  if (!type) return badRequest("type is required");
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return badRequest("month must be YYYY-MM");

  const { data: t } = await supabaseAdmin()
    .from("dumpster_types").select("uses_inventory").eq("id", type).maybeSingle();
  if (!t) return badRequest("Unknown type");

  const [year, mon] = month.split("-").map(Number);
  const numDays = daysInMonth(year, mon);

  const availability: Record<string, number> = {};
  for (let d = 1; d <= numDays; d++) {
    const start = fmt(year, mon, d);
    const end = addDays(start, days - 1);
    availability[start] = await typeAvailability(type, start, end, t.uses_inventory);
  }

  return json({ month, days, availability });
});
