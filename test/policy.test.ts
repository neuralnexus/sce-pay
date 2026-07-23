import assert from "node:assert/strict";
import test from "node:test";

import type { BillSnapshot, GuestBundle, PaymentReview } from "../src/domain.js";
import { validateBill, validateReview } from "../src/policy.js";

const bundle: GuestBundle = {
  version: 1,
  capturedAt: "2026-07-23T12:00:00.000Z",
  guestUrl: "https://www.sce.com/mysce/billsnpayments/paybills",
  accountNumber: "123456789012",
  mailingZip: "91203",
  paymentMethodLast4: "4242",
  maxBillCents: 75_000,
  feeLimitCentsExclusive: 400,
  payWhenDueWithinDays: 14,
  allowedTopLevelOrigins: ["https://www.sce.com"],
  allowedFrameOrigins: [],
  storageState: { cookies: [], origins: [] },
  sessionStorageByOrigin: {},
};

const bill: BillSnapshot = {
  accountReference: "sce-test",
  amountCents: 28_417,
  dueDate: "2026-07-31",
  observedAt: "2026-07-23T12:00:00.000Z",
};

function review(feeCents: number): PaymentReview {
  return {
    ...bill,
    feeCents,
    totalCents: bill.amountCents + feeCents,
    paymentMethodLast4: "4242",
  };
}

test("bill policy enforces the ceiling and due window", () => {
  assert.equal(
    validateBill(bill, bundle, new Date("2026-07-23T12:00:00.000Z")),
    "eligible",
  );
  assert.equal(
    validateBill(
      { ...bill, dueDate: "2026-09-01" },
      bundle,
      new Date("2026-07-23T12:00:00.000Z"),
    ),
    "not-due",
  );
  assert.throws(() =>
    validateBill({ ...bill, amountCents: 75_001 }, bundle, new Date()),
  );
});

test("the fee rule is strictly below four dollars", () => {
  assert.doesNotThrow(() => validateReview(bill, review(399), bundle));
  assert.throws(() => validateReview(bill, review(400), bundle));
});

test("review must preserve amount, method, and arithmetic", () => {
  assert.throws(() =>
    validateReview(bill, { ...review(165), amountCents: 1 }, bundle),
  );
  assert.throws(() =>
    validateReview(
      bill,
      { ...review(165), paymentMethodLast4: "1111" },
      bundle,
    ),
  );
  assert.throws(() =>
    validateReview(bill, { ...review(165), totalCents: 1 }, bundle),
  );
});
