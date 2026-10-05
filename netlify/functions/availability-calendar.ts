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

  const db = supabaseAdmin();
  const { data: t } = await db
    .from("dumpster_types").select("uses_inventory,equipment_pool").eq("id", type).maybeSingle();
  if (!t) return badRequest("Unknown type");

  const [year, mon] = month.split("-").map(Number);
  const numDays = daysInMonth(year, mon);

  const availability: Record<string, number> = {};
  // Days are independent, so query them in parallel (serial awaits took ~4s a month).
  const starts = Array.from({ length: numDays }, (_, i) => fmt(year, mon, i + 1));
  const counts = await Promise.all(
    starts.map((start) => typeAvailability(type, start, addDays(start, days - 1), t.uses_inventory)),
  );
  starts.forEach((start, i) => { availability[start] = counts[i]; });

  // Days that are themselves blacked out (owner shifts, holidays), so the calendar can
  // show them as "Closed" rather than "Fully booked". Blackouts on any type that shares
  // this type's containers count too.
  let typeIds = [type];
  if (t.equipment_pool) {
    const { data: pool } = await db.from("dumpster_types").select("id").eq("equipment_pool", t.equipment_pool);
    typeIds = (pool ?? []).map((p) => p.id);
  }
  const { data: blackouts, error } = await db.from("blackouts").select("start_at,end_at")
    .or(`scope.eq.all,type_id.in.(${typeIds.join(",")})`)
    .lte("start_at", `${starts[starts.length - 1]}T23:59:59Z`)
    .gte("end_at", `${starts[0]}T00:00:00Z`);
  if (error) throw new Error(error.message);
  const closed = starts.filter((d) => (blackouts ?? []).some((b) => b.start_at.slice(0, 10) <= d && b.end_at.slice(0, 10) >= d));

  return json({ month, days, availability, closed });
});
