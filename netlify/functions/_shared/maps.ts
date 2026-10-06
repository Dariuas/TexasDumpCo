import { optionalEnv } from "./env";
import { Settings } from "./settings";
import { distanceFee, distancePricing, DistanceResult } from "./distance";

const METERS_PER_MILE = 1609.344;
const cache = new Map<string, number>(); // address -> one-way miles, per warm function instance

export function mapsConfigured(): boolean {
  return !!optionalEnv("GOOGLE_MAPS_API_KEY");
}

export class AddressNotFound extends Error {}

// One-way driving miles between two addresses (Google Routes API, computeRoutes).
export async function driveMiles(origin: string, destination: string): Promise<number> {
  const key = optionalEnv("GOOGLE_MAPS_API_KEY");
  if (!key) throw new Error("GOOGLE_MAPS_API_KEY is not set");
  const cacheKey = `${origin}|${destination}`.toLowerCase();
  const hit = cache.get(cacheKey);
  if (hit != null) return hit;

  const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "routes.distanceMeters" },
    body: JSON.stringify({ origin: { address: origin }, destination: { address: destination }, travelMode: "DRIVE", units: "IMPERIAL" }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message ?? `HTTP ${res.status}`;
    // Unknown / unroutable addresses come back as 400 INVALID_ARGUMENT or NOT_FOUND.
    if (res.status === 400 || res.status === 404) throw new AddressNotFound("We couldn't find that address.");
    throw new Error(`Google Maps error: ${msg}`);
  }
  const meters = data?.routes?.[0]?.distanceMeters;
  if (typeof meters !== "number") throw new AddressNotFound("We couldn't find a driving route to that address.");
  const miles = meters / METERS_PER_MILE;
  if (cache.size > 500) cache.clear();
  cache.set(cacheKey, miles);
  return miles;
}

// Distance from the yard to a job address, priced with settings.distance_pricing.
export async function measureFromYard(address: string, settings: Settings): Promise<DistanceResult & { free_miles: number }> {
  const p = distancePricing(settings);
  const miles = await driveMiles(p.hub_address, address);
  return { ...distanceFee(miles, p), free_miles: p.free_radius_miles * (p.round_trip ? 2 : 1) };
}
