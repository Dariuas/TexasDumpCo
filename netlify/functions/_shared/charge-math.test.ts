import { test } from "node:test";
import assert from "node:assert/strict";
import { priceLines, lineTax } from "./charge-math.ts";

test("lines are priced quantity x unit with per-line tax", () => {
  const [rental, miles] = priceLines([
    { kind: "rental", description: "14 yd, 7 days", quantity: 1, unit_cents: 41900 },
    { kind: "mileage", description: "Extra miles", quantity: 12, unit_cents: 185 },
  ], 825);
  assert.equal(rental.amount_cents, 41900);
  assert.equal(rental.tax_cents, 3457);
  assert.equal(miles.amount_cents, 2220);
  assert.equal(miles.tax_cents, 183);
});
test("discounts are always negative and reduce tax", () => {
  const [d] = priceLines([{ kind: "discount", description: "Contractor pricing", quantity: 1, unit_cents: 3000 }], 825);
  assert.equal(d.amount_cents, -3000);
  assert.equal(d.tax_cents, -248);
});
test("tax exempt (0 bps) or untaxed lines carry no tax", () => {
  assert.equal(priceLines([{ kind: "fee", description: "Stairs", quantity: 1, unit_cents: 2500 }], 0)[0].tax_cents, 0);
  assert.equal(priceLines([{ kind: "fee", description: "Stairs", quantity: 1, unit_cents: 2500, taxable: false }], 825)[0].tax_cents, 0);
  assert.equal(lineTax(1000, true, 825), 83);
});
test("bad lines are rejected", () => {
  assert.throws(() => priceLines([{ kind: "fee", description: "", quantity: 1, unit_cents: 100 }], 0));
  assert.throws(() => priceLines([{ kind: "fee", description: "x", quantity: 0, unit_cents: 100 }], 0));
  assert.throws(() => priceLines([{ kind: "bogus" as any, description: "x", quantity: 1, unit_cents: 100 }], 0));
});
