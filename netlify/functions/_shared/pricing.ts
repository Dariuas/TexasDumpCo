import { Settings, num } from "./settings";

export interface DumpsterType {
  id: string;
  name: string;
  service: "dumpster" | "junk";
  base_price_cents: number;
  deposit_cents: number;
  rental_days_included: number;
  extra_day_fee_cents: number;
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
  discount_cents: number;
  tax_cents: number;
  amount_total_cents: number;
  deposit_cents: number;
  extra_days: number;
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

// Build the authoritative quote. Never trust client-sent totals — always
// recompute here before charging.
export function buildQuote(
  type: DumpsterType,
  opts: { rentalDays?: number; promo?: PromoRow | null },
  settings: Settings,
): Quote {
  const extraDays = Math.max(
    0,
    (opts.rentalDays ?? type.rental_days_included) - type.rental_days_included,
  );
  const subtotal = type.base_price_cents + extraDays * type.extra_day_fee_cents;

  let discount = 0;
  if (opts.promo) {
    const check = validatePromo(opts.promo, subtotal, type.service);
    if (check.valid) discount = discountFor(opts.promo, subtotal);
  }

  const taxable = Math.max(0, subtotal - discount);
  const taxBps = num(settings, "tax_rate_bps", 0);
  const tax = Math.round((taxable * taxBps) / 10000);
  const total = taxable + tax;

  const depositPct = num(settings, "deposit_percent", 25);
  const deposit =
    type.deposit_cents > 0 ? type.deposit_cents : Math.round((total * depositPct) / 100);

  return {
    subtotal_cents: subtotal,
    discount_cents: discount,
    tax_cents: tax,
    amount_total_cents: total,
    deposit_cents: Math.min(deposit, total),
    extra_days: extraDays,
  };
}
