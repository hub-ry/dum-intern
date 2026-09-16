// The failure mode here is silent and plausible: a compounding bug still
// returns a bigger number that grows with time, so it looks right. These check
// it against figures you can work out by hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { project } from "../tools/hysa.ts";

const near = (a: number, b: number, eps = 0.01) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} to be within ${eps} of ${b}`);

test("one year at the advertised APY earns exactly the advertised APY", () => {
  // The whole point of the twelfth-root factor: apy/12 would land near 4.33%.
  const r = project({ balance: 10_000, apy: 0.0425, years: 1, monthly: 0 });
  near(r.final, 10_425);
  near(r.interest, 425);
});

test("zero rate means the balance is only what you put in", () => {
  const r = project({ balance: 1_000, apy: 0, years: 3, monthly: 100 });
  assert.equal(r.final, 1_000 + 3_600);
  assert.equal(r.contributed, 3_600);
  assert.equal(r.interest, 0);
});

test("zero years leaves the balance untouched", () => {
  const r = project({ balance: 5_000, apy: 0.05, years: 0, monthly: 500 });
  assert.equal(r.final, 5_000);
  assert.equal(r.contributed, 0);
  assert.equal(r.interest, 0);
});

test("contributions earn interest too, and are not counted as interest", () => {
  const r = project({ balance: 0, apy: 0.0425, years: 1, monthly: 100 });
  assert.equal(r.contributed, 1_200);
  assert.ok(r.interest > 0, "a year of deposits should earn something");
  // Each deposit sits for less than a full year, so it earns less than a full
  // year's yield on the total.
  assert.ok(r.interest < 1_200 * 0.0425);
  near(r.final, r.contributed + r.interest);
});

test("the last contribution is deposited after the final month's growth", () => {
  const r = project({ balance: 0, apy: 0.05, years: 1 / 12, monthly: 100 });
  assert.equal(r.final, 100);
  assert.equal(r.interest, 0);
});
