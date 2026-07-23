import assert from "node:assert/strict";
import test from "node:test";

import { formatCents, parseMoneyToCents } from "../src/money.js";

test("money parsing and formatting preserve cents", () => {
  assert.equal(parseMoneyToCents("$1,234.56"), 123_456);
  assert.equal(parseMoneyToCents("Convenience fee: $3.99"), 399);
  assert.equal(parseMoneyToCents("42"), 4_200);
  assert.equal(formatCents(12_345), "$123.45");
});

test("invalid money fails closed", () => {
  assert.throws(() => parseMoneyToCents("not available"));
  assert.throws(() => parseMoneyToCents("-$10.00"));
  assert.throws(() => formatCents(-1));
});
