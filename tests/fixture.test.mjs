import test from "node:test";
import assert from "node:assert/strict";
import { discountTotal } from "../examples/review-fixture/discount.js";
test("review fixture correction meets positive, boundary and negative cases", () => {
  assert.equal(discountTotal(100, 20), 80);
  assert.equal(discountTotal(100, 0), 100);
  assert.equal(discountTotal(100, 100), 0);
  assert.equal(discountTotal(0, 50), 0);
  for (const amount of [-1, NaN, Infinity, "100", null])
    assert.throws(() => discountTotal(amount, 20), RangeError);
  for (const percent of [-1, 101, NaN, Infinity, "20", null])
    assert.throws(() => discountTotal(100, percent), RangeError);
});
