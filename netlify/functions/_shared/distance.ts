// Delivery mileage measured from the yard (settings.distance_pricing). Everything is in
// whole miles: the one-way driving distance is rounded to the nearest mile (18.2 -> 18,
// 18.5 -> 19) and every other number comes from that, so the customer sees
// 18 mi one way, 36 round trip, 6 billable. The free radius is one-way; with
// round_trip the first 2 x radius miles out and back are free. Past max_oneway_miles
// the job is priced by phone (quote_only).
export interface DistancePricing {
  hub_address: string;
  free_radius_miles: number;
  per_mile_cents: number;
  max_oneway_miles: number;
  round_trip: boolean;
}

export interface DistanceResult {
  oneway_miles: number;
  round_trip_miles: number;
  billable_miles: number;
  fee_cents: number;
  quote_only: boolean;
}

export function distancePricing(settings: Record<string, unknown>): DistancePricing {
  const p = (settings["distance_pricing"] ?? {}) as Partial<DistancePricing>;
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
  return {
    hub_address: typeof p.hub_address === "string" && p.hub_address.trim() ? p.hub_address : "1725 County Road 269, Leander, TX 78641",
    free_radius_miles: n(p.free_radius_miles, 15),
    per_mile_cents: Math.round(n(p.per_mile_cents, 185)),
    max_oneway_miles: n(p.max_oneway_miles, 35),
    round_trip: p.round_trip !== false,
  };
}

export function distanceFee(onewayMiles: number, p: DistancePricing): DistanceResult {
  const oneway = Number.isFinite(onewayMiles) && onewayMiles > 0 ? Math.round(onewayMiles) : 0;
  const factor = p.round_trip ? 2 : 1;
  const billable = Math.max(0, Math.round((oneway - p.free_radius_miles) * factor));
  return {
    oneway_miles: oneway,
    round_trip_miles: oneway * 2,
    billable_miles: billable,
    fee_cents: billable * p.per_mile_cents,
    quote_only: oneway > p.max_oneway_miles,
  };
}
