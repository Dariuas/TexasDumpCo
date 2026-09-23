import { withErrors, json } from "./_shared/response";
import { optionalEnv } from "./_shared/env";
import { loadSettings, bool, str } from "./_shared/settings";

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
  });
});
