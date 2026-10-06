import { withErrors, json } from "./_shared/response";
import { optionalEnv } from "./_shared/env";
import { loadSettings, bool, str } from "./_shared/settings";
import { distancePricing } from "./_shared/distance";
import { mapsConfigured } from "./_shared/maps";

const FEE_LABELS: Record<string, string> = {
  dry_run_or_inaccessible_cents: "Dry run / blocked access",
  late_cancellation_lt24h_cents: "Late cancellation (under 24 hrs)",
  truck_already_dispatched_cents: "Cancel after truck dispatched",
  overfill_rearrangement_from_cents: "Overfill / rearrange load",
  long_carry_from_cents: "Long carry",
  stairs_from_cents: "Stairs",
  multi_floor_heavy_furniture_from_cents: "Multi-floor heavy furniture",
  same_day_priority_from_cents: "Same-day priority",
  after_hours_from_cents: "After-hours service",
};

// Admin-edited list wins; otherwise derive rows from the legacy reference object.
function feeSchedule(settings: Record<string, unknown>) {
  const list = settings["fee_schedule"];
  if (Array.isArray(list)) return list;
  const ref = (settings["fee_schedule_reference"] ?? {}) as Record<string, unknown>;
  return Object.entries(ref)
    .filter(([k, v]) => typeof v === "number" && k.endsWith("_cents"))
    .map(([k, v]) => ({ label: FEE_LABELS[k] ?? k.replace(/_/g, " ").replace(/ cents$/, ""), amount_cents: v as number, from: k.includes("_from_"), note: "" }));
}

// Public browser config: publishable keys + business flags only. No secrets.
export default withErrors(async () => {
  const settings = await loadSettings();
  return json({
    supabaseUrl: optionalEnv("SUPABASE_URL") ?? "",
    supabaseAnonKey: optionalEnv("SUPABASE_ANON_KEY") ?? "",
    stripePublishableKey: optionalEnv("STRIPE_PUBLISHABLE_KEY") ?? "",
    cashAccepted: bool(settings, "cash_accepted", false),
    companyName: str(settings, "company_name", "Texas Dumpster Co"),
    companyPhone: str(settings, "company_phone", ""),
    timeWindows: (settings["time_windows"] as string[]) ?? ["Anytime"],
    leadTimeDays: (settings["lead_time_days"] as number) ?? 1,
    bookingWindowDays: (settings["booking_window_days"] as number) ?? 120,
    taxRateBps: (settings["tax_rate_bps"] as number) ?? 0,
    depositPercent: (settings["deposit_percent"] as number) ?? 25,
    distanceZones: settings["distance_zones"] ?? [],
    distancePricing: distancePricing(settings),
    distanceMeasured: mapsConfigured(),
    emailVerification: !!optionalEnv("RESEND_API_KEY"),
    feeSchedule: feeSchedule(settings),
    referralSources: (settings["referral_sources"] as string[]) ?? [],
    contractorRateCard: (settings["contractor_rate_card"] as Record<string, number>) ?? {},
  });
});
