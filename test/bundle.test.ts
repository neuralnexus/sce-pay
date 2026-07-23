import assert from "node:assert/strict";
import test from "node:test";

import { validateGuestBundle } from "../src/bundle.js";
import type { GuestBundle } from "../src/domain.js";

const valid: GuestBundle = {
  version: 2,
  configurationId: "AAAAAAAAAAAAAAAAAAAAAA",
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
  allowedRequestOrigins: ["https://www.sce.com"],
  storageState: { cookies: [], origins: [] },
  sessionStorageByOrigin: {},
};

test("valid guest bundle is accepted", () => {
  assert.deepEqual(validateGuestBundle(valid), valid);
});

test("bundle rejects an unreviewed guest origin and fee over four dollars", () => {
  assert.throws(() =>
    validateGuestBundle({
      ...valid,
      guestUrl: "https://lookalike.example.test/pay",
    }),
  );
  assert.throws(() => validateGuestBundle({ ...valid, feeLimitCentsExclusive: 401 }));
});

test("bundle requires exact SCE top-level routing and network review", () => {
  assert.throws(() =>
    validateGuestBundle({
      ...valid,
      allowedTopLevelOrigins: ["https://payments.example.test"],
    }),
  );
  assert.throws(() => validateGuestBundle({ ...valid, allowedRequestOrigins: [] }));
});

test("webhook configuration requires a credential-free URL and signing secret", () => {
  assert.throws(() =>
    validateGuestBundle({
      ...valid,
      notificationWebhookUrl: "https://user:secret@example.test/hook",
      notificationWebhookSecret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    }),
  );
  assert.doesNotThrow(() =>
    validateGuestBundle({
      ...valid,
      notificationWebhookUrl: "https://example.test/hook",
      notificationWebhookSecret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    }),
  );
});

test("browser state that resembles a raw card number is rejected", () => {
  assert.throws(() =>
    validateGuestBundle({
      ...valid,
      sessionStorageByOrigin: {
        "https://www.sce.com": {
          accidentalCardValue: "4111 1111 1111 1111",
        },
      },
    }),
  );
});

test("cookies must belong to a reviewed request origin", () => {
  assert.throws(() =>
    validateGuestBundle({
      ...valid,
      storageState: {
        cookies: [
          {
            name: "session",
            value: "opaque",
            domain: ".unreviewed.example",
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
          },
        ],
        origins: [],
      },
    }),
  );
});
