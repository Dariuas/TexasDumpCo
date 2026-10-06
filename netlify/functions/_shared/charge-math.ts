// Pure pricing for booking charge lines (no I/O, unit tested).

export type ChargeKind = "rental" | "mileage" | "weight" | "extra_days" | "fee" | "custom" | "discount";
export const CHARGE_KINDS: ChargeKind[] = ["rental", "mileage", "weight", "extra_days", "fee", "custom", "discount"];

export interface ChargeLine {
  kind: ChargeKind;
  description: string;
  quantity: number;
  unit_cents: number;
  taxable?: boolean;
}

export function lineTax(amountCents: number, taxable: boolean, taxBps: number): number {
  if (!taxable) return 0;
  // Round half away from zero so a discount line mirrors the same positive line.
  return Math.sign(amountCents) * Math.round((Math.abs(amountCents) * taxBps) / 10000);
}

// Validate and price lines from the admin. Discounts are the only negative lines.
export function priceLines(lines: ChargeLine[], taxBps: number) {
  return lines.map((l) => {
    if (!CHARGE_KINDS.includes(l.kind)) throw new Error(`Unknown charge type ${l.kind}`);
    const description = String(l.description ?? "").trim().slice(0, 200);
    if (!description) throw new Error("Every line needs a description");
    const quantity = Math.round(Number(l.quantity) * 100) / 100;
    const unit = Math.round(Number(l.unit_cents));
    if (!(quantity > 0) || !Number.isFinite(unit)) throw new Error(`Check the amount on “${description}”`);
    const unitCents = l.kind === "discount" ? -Math.abs(unit) : Math.abs(unit);
    const amount = Math.round(quantity * unitCents);
    const taxable = l.taxable !== false;
    return { kind: l.kind, description, quantity, unit_cents: unitCents, amount_cents: amount, taxable, tax_cents: lineTax(amount, taxable, taxBps) };
  });
}
