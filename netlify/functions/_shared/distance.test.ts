import { test } from "node:test";
import assert from "node:assert/strict";
import { distanceFee, distancePricing } from "./distance.ts";

const p = distancePricing({});

test("defaults match the client's terms", () => {
  assert.deepEqual(p, { hub_address: "1725 County Road 269, Leander, TX 78641", free_radius_miles: 15, per_mile_cents: 185, max_oneway_miles: 35, round_trip: true });
});
test("inside the free radius is free", () => {
  assert.equal(distanceFee(0, p).fee_cents, 0);
  assert.equal(distanceFee(15, p).fee_cents, 0);
});
test("round trip miles past 2 x radius are billed", () => {
  const r = distanceFee(25, p); // 50 round trip, 30 free
  assert.equal(r.round_trip_miles, 50);
  assert.equal(r.billable_miles, 20);
  assert.equal(r.fee_cents, 3700);
});
test("miles are whole numbers: one way rounds to the nearest mile", () => {
  const g = distanceFee(18.2, p); // Georgetown
  assert.deepEqual([g.oneway_miles, g.round_trip_miles, g.billable_miles, g.fee_cents], [18, 36, 6, 1110]);
  const up = distanceFee(18.5, p);
  assert.deepEqual([up.oneway_miles, up.round_trip_miles, up.billable_miles], [19, 38, 8]);
  assert.equal(distanceFee(15.4, p).billable_miles, 0); // rounds to 15: inside the radius
  assert.equal(distanceFee(35.4, p).quote_only, false); // rounds to 35: still online
  assert.equal(distanceFee(35.6, p).quote_only, true);  // rounds to 36: call for quote
});
test("past the max one-way distance it becomes a phone quote", () => {
  assert.equal(distanceFee(35, p).quote_only, false);
  assert.equal(distanceFee(45, p).quote_only, true);
});
test("one-way pricing when round_trip is off", () => {
  const oneWay = distancePricing({ distance_pricing: { round_trip: false } });
  assert.equal(distanceFee(25, oneWay).fee_cents, 1850);
});
test("bad settings fall back to defaults", () => {
  assert.equal(distancePricing({ distance_pricing: { per_mile_cents: -5, free_radius_miles: "x" } }).per_mile_cents, 185);
  assert.equal(distanceFee(NaN, p).fee_cents, 0);
});
