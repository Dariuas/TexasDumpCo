import { test } from "node:test";
import assert from "node:assert/strict";
import { computeOverageCents } from "./overage.ts";

test("under or at the limit is free", () => {
  assert.equal(computeOverageCents(1.2, 1.5, 9000), 0);
  assert.equal(computeOverageCents(1.5, 1.5, 9000), 0);
});
test("over the limit is prorated per ton and rounded to the cent", () => {
  assert.equal(computeOverageCents(1.87, 1.5, 9000), 3330);
  assert.equal(computeOverageCents(2.5, 1.5, 9000), 9000);
});
test("bad input yields 0", () => {
  assert.equal(computeOverageCents(NaN, 1.5, 9000), 0);
  assert.equal(computeOverageCents(-3, 1.5, 9000), 0);
  assert.equal(computeOverageCents(2, null, 9000), 0);
  assert.equal(computeOverageCents(2, 1.5, 0), 0);
});
