import { Settings, num } from "./settings";

export type PricingMode = "flat" | "duration_tiers" | "quote_only";

export interface DumpsterType {
  id: string;
  name: string;
  service: "dumpster" | "junk";
  pricing_mode: PricingMode;
  base_price_cents: number;
  deposit_cents: number;
  rental_days_included: number;
  extra_day_fee_cents: number;
  uses_inventory: boolean;
  equipment_pool: string | null;
}

export interface DurationTier {
  days: number;
  price_cents: number;
  label?: string;
}

export interface AddonSelection {
  name: string;
  price_cents: number;
  qty: number;
}

export interface DistanceZone {
  code: string;
  label: string;
  fee_cents: number;
  quote_only?: boolean;
}

export interface PromoRow {
  id: string;
  code: string;
  kind: "percent" | "fixed";
  value: number;
  min_amount_cents: number;
  applies_to: "dumpster" | "junk" | null;
  max_uses: number | null;
  uses_count: number;
  active: boolean;
  starts_at: string | null;
  ends_at: string | null;
}

export interface Quote {
  subtotal_cents: number;
  addon_cents: number;
  distance_fee_cents: number;
  discount_cents: number;
  tax_cents: number;
  amount_total_cents: number;
  deposit_cents: number;
  extra_days: number;
  needs_quote: boolean;
}

// Validate a promo against a subtotal + service. Returns a reason if invalid.
export function validatePromo(
  promo: PromoRow | null,
  subtotalCents: number,
  service: "dumpster" | "junk",
): { valid: boolean; reason?: string } {
  if (!promo) return { valid: false, reason: "Unknown code" };
  if (!promo.active) return { valid: false, reason: "Code is not active" };
  const now = Date.now();
  if (promo.starts_at && new Date(promo.starts_at).getTime() > now)
    return { valid: false, reason: "Code is not yet valid" };
  if (promo.ends_at && new Date(promo.ends_at).getTime() < now)
    return { valid: false, reason: "Code has expired" };
  if (promo.max_uses != null && promo.uses_count >= promo.max_uses)
    return { valid: false, reason: "Code usage limit reached" };
  if (promo.applies_to && promo.applies_to !== service)
    return { valid: false, reason: "Code does not apply to this service" };
  if (subtotalCents < promo.min_amount_cents)
    return { valid: false, reason: "Order below the code minimum" };
  return { valid: true };
}

export function discountFor(promo: PromoRow, subtotalCents: number): number {
  const raw =
    promo.kind === "percent"
      ? Math.round((subtotalCents * promo.value) / 100)
      : promo.value;
  return Math.min(raw, subtotalCents);
}

// Resolve the base price for one unit of service, given its pricing mode.
// - duration_tiers: exact tier match, or the longest tier + a per-day fee for
//   any days beyond it (e.g. a 40-day rental on a table that tops out at 28).
// - flat: the type's flat price (junk load-volume tiers, single price).
// - quote_only: the type's base_price_cents is only a "starting at" estimate;
//   the real price is finalized by staff, never charged automatically.
function resolveBase(
  type: DumpsterType,
  rentalDays: number,
  tiers: DurationTier[],
): { price: number; extraDays: number } {
  if (type.pricing_mode === "duration_tiers" && tiers.length) {
    const sorted = [...tiers].sort((a, b) => a.days - b.days);
    const exact = sorted.find((t) => t.days === rentalDays);
    if (exact) return { price: exact.price_cents, extraDays: 0 };
    const longest = sorted[sorted.length - 1];
    if (rentalDays > longest.days) {
      const extraDays = rentalDays - longest.days;
      return { price: longest.price_cents + extraDays * type.extra_day_fee_cents, extraDays };
    }
    // shorter than the shortest tier: fall back to the shortest tier's price
    const shortest = sorted[0];
    return { price: shortest.price_cents, extraDays: 0 };
  }
  // flat or quote_only (estimate)
  const extraDays = Math.max(0, rentalDays - type.rental_days_included);
  return { price: type.base_price_cents + extraDays * type.extra_day_fee_cents, extraDays };
}

// Build the authoritative quote. Never trust client-sent totals — always
// recompute here before charging. For quote_only services or a 35+ mile
// distance zone, amount_total_cents is an estimate only and needs_quote is
// set — the caller must skip payment and route to the manual-quote flow.
export function buildQuote(
  type: DumpsterType,
  opts: {
    rentalDays?: number;
    promo?: PromoRow | null;
    tiers?: DurationTier[];
    addons?: AddonSelection[];
    distanceZone?: DistanceZone | null;
  },
  settings: Settings,
): Quote {
  const rentalDays = opts.rentalDays ?? type.rental_days_included;
  const { price: base, extraDays } = resolveBase(type, rentalDays, opts.tiers ?? []);

  const addonCents = (opts.addons ?? []).reduce((s, a) => s + a.price_cents * a.qty, 0);
  const subtotal = base + addonCents;

  let discount = 0;
  if (opts.promo) {
    const check = validatePromo(opts.promo, subtotal, type.service);
    if (check.valid) discount = discountFor(opts.promo, subtotal);
  }

  const distanceFee = opts.distanceZone?.fee_cents ?? 0;
  const taxable = Math.max(0, subtotal - discount) + distanceFee;
  const taxBps = num(settings, "tax_rate_bps", 0);
  const tax = Math.round((taxable * taxBps) / 10000);
  const total = taxable + tax;

  const depositPct = num(settings, "deposit_percent", 25);
  const deposit =
    type.deposit_cents > 0 ? type.deposit_cents : Math.round((total * depositPct) / 100);

  const needsQuote = type.pricing_mode === "quote_only" || !!opts.distanceZone?.quote_only;

  return {
    subtotal_cents: subtotal,
    addon_cents: addonCents,
    distance_fee_cents: distanceFee,
    discount_cents: discount,
    tax_cents: tax,
    amount_total_cents: total,
    deposit_cents: Math.min(deposit, total),
    extra_days: extraDays,
    needs_quote: needsQuote,
  };
}
