import assert from "node:assert/strict";
import test from "node:test";

import { validateGuestBundle } from "../src/bundle.js";
import type { GuestBundle } from "../src/domain.js";

const valid: GuestBundle = {
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

test("valid guest bundle is accepted", () => {
  assert.equal(validateGuestBundle(valid), valid);
});

test("bundle rejects an unreviewed guest origin and fee over four dollars", () => {
  assert.throws(() =>
    validateGuestBundle({
      ...valid,
      guestUrl: "https://lookalike.example.test/pay",
    }),
  );
  assert.throws(() =>
    validateGuestBundle({ ...valid, feeLimitCentsExclusive: 401 }),
  );
});
