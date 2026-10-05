// Overage = tons over the included limit x rate per ton, in whole cents.
export function computeOverageCents(weightTons: number, limitTons: number | null, ratePerTonCents: number): number {
  if (!Number.isFinite(weightTons) || weightTons <= 0) return 0;
  if (limitTons == null || !(ratePerTonCents > 0)) return 0;
  const over = weightTons - limitTons;
  if (over <= 0) return 0;
  return Math.round(over * ratePerTonCents);
}
