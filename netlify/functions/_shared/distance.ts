// Delivery mileage measured from the yard (settings.distance_pricing). The free radius
// is one-way; with round_trip the first 2 x radius miles out and back are free and
// every mile beyond is billed, rounded up to a whole mile. Past max_oneway_miles the
// job is priced by phone (quote_only).
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
  const oneway = Number.isFinite(onewayMiles) && onewayMiles > 0 ? onewayMiles : 0;
  const factor = p.round_trip ? 2 : 1;
  const traveled = oneway * factor;
  // Tiny epsilon so 30.0000001 miles from floating-point math doesn't bill a mile.
  const billable = Math.max(0, Math.ceil(traveled - p.free_radius_miles * factor - 1e-6));
  return {
    oneway_miles: Math.round(oneway * 10) / 10,
    round_trip_miles: Math.round(oneway * 2 * 10) / 10,
    billable_miles: billable,
    fee_cents: billable * p.per_mile_cents,
    quote_only: oneway > p.max_oneway_miles,
  };
}
