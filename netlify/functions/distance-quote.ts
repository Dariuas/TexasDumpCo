import type { Config } from "@netlify/functions";
import { withErrors, json, badRequest, readJson } from "./_shared/response";
import { loadSettings } from "./_shared/settings";
import { mapsConfigured, measureFromYard, AddressNotFound } from "./_shared/maps";

// Public: driving distance from the yard to a job address and the mileage fee, for
// display on the booking page. create-booking measures again; this is never trusted.
// { configured: false } tells the page to fall back to the mileage-zone picker.
export default withErrors(async (req: Request) => {
  if (req.method !== "POST") return badRequest("POST required");
  if (!mapsConfigured()) return json({ configured: false });
  const { address } = await readJson<{ address?: string }>(req);
  const a = String(address ?? "").trim();
  if (a.length < 5) return badRequest("Enter the full job address.");
  try {
    return json(await measureFromYard(a.slice(0, 300), await loadSettings()));
  } catch (err) {
    if (err instanceof AddressNotFound) return badRequest(err.message);
    throw err;
  }
});

// Abuse guard (each call is a billed Maps request): per-IP limit, enforced by Netlify.
export const config: Config = { rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ["ip", "domain"] } } as Config; // windowLimit postdates the installed @netlify/functions types
