import { supabaseAdmin } from "./supabase";
import { loadSettings, num } from "./settings";

const BIG_NUMBER = 999; // effectively "unlimited" for crew/truck-based services

// Availability for a single type over a date range. Types with physical
// inventory (uses_inventory=true, e.g. roll-off containers) are constrained
// by unit count, overlapping bookings, and blackouts (via the pool-aware
// `type_availability` SQL function). Crew/truck-based services (junk hauling,
// cleanouts — uses_inventory=false) have no numbered units, so their capacity
// comes only from the optional per-day cap; without one they're unconstrained.
export async function typeAvailability(
  typeId: string,
  startDate: string,
  endDate: string,
  usesInventory = true,
): Promise<number> {
  const db = supabaseAdmin();
  let avail = BIG_NUMBER;

  if (usesInventory) {
    const { data, error } = await db.rpc("type_availability", {
      p_type: typeId,
      p_start: startDate,
      p_end: endDate,
    });
    if (error) throw new Error(error.message);
    avail = (data as number) ?? 0;
  } else {
    // Crew/truck jobs have no units, but blackouts (owner shifts, holidays) still apply
    // to the days the truck goes out: the start day and the last day (same rule as SQL is_blacked_out).
    const { data: bl, error } = await db
      .from("blackouts")
      .select("start_at,end_at")
      .or(`scope.eq.all,type_id.eq.${typeId}`)
      .lte("start_at", `${endDate}T23:59:59Z`)
      .gte("end_at", `${startDate}T00:00:00Z`);
    if (error) throw new Error(error.message);
    const covers = (day: string) => (bl ?? []).some((b) => b.start_at.slice(0, 10) <= day && b.end_at.slice(0, 10) >= day);
    if (covers(startDate) || covers(endDate)) return 0;
  }

  const settings = await loadSettings();
  const cap = num(settings, "per_day_cap", 0);
  if (cap > 0) {
    // Count bookings that overlap the window to enforce a daily throughput cap.
    const { count } = await db
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .neq("status", "canceled")
      .lte("start_date", endDate)
      .gte("end_date", startDate);
    avail = Math.min(avail, Math.max(0, cap - (count ?? 0)));
  }
  return avail;
}

// Availability for every active type over a range (used by the booking calendar).
export async function availabilityByType(
  startDate: string,
  endDate: string,
): Promise<Record<string, number>> {
  const db = supabaseAdmin();
  const { data: types, error } = await db
    .from("dumpster_types")
    .select("id, uses_inventory")
    .eq("active", true);
  if (error) throw new Error(error.message);

  const out: Record<string, number> = {};
  for (const t of types ?? []) {
    out[t.id] = await typeAvailability(t.id, startDate, endDate, t.uses_inventory);
  }
  return out;
}
