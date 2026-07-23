import assert from "node:assert/strict";
import test from "node:test";

import { SafetyStopError } from "../src/errors.js";
import { formatCents, parseMoneyToCents } from "../src/money.js";

test("parseMoneyToCents handles currency and thousands separators", () => {
  assert.equal(parseMoneyToCents("$1,234.56"), 123_456);
  assert.equal(parseMoneyToCents("Convenience fee: $1.65"), 165);
  assert.equal(parseMoneyToCents("42"), 4_200);
});

test("parseMoneyToCents rejects text without a monetary value", () => {
  assert.throws(() => parseMoneyToCents("not available"), SafetyStopError);
});

test("formatCents emits US currency", () => {
  assert.equal(formatCents(12_345), "$123.45");
  assert.throws(() => formatCents(-1), TypeError);
});
