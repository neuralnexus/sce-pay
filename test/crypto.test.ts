import assert from "node:assert/strict";
import test from "node:test";

import { decryptBundle, encryptBundle, generateBundleKey } from "../src/crypto.js";
import type { GuestBundle } from "../src/domain.js";

const bundle: GuestBundle = {
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
  allowedFrameOrigins: ["https://payments.example.test"],
  allowedRequestOrigins: ["https://www.sce.com", "https://payments.example.test"],
  storageState: { cookies: [], origins: [] },
  sessionStorageByOrigin: {},
};

test("onboarding bundle encrypts and decrypts without plaintext fields", async () => {
  const key = generateBundleKey();
  const encrypted = await encryptBundle(bundle, key);
  assert.equal(encrypted.ciphertext.includes(bundle.accountNumber), false);
  assert.deepEqual(await decryptBundle(encrypted, key), bundle);
});

test("wrong encryption key cannot open a bundle", async () => {
  const encrypted = await encryptBundle(bundle, generateBundleKey());
  await assert.rejects(decryptBundle(encrypted, generateBundleKey()));
});

test("envelope metadata is authenticated", async () => {
  const key = generateBundleKey();
  const encrypted = await encryptBundle(bundle, key);
  await assert.rejects(
    decryptBundle(
      {
        ...encrypted,
        bundleId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
      key,
    ),
  );
});
