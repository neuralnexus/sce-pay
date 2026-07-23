import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { SafetyStopError } from "../src/errors.js";
import { portalInternals } from "../src/portal/playwrightPortal.js";

test("host allowlist supports exact hosts and safe subdomain wildcards", () => {
  assert.equal(portalInternals.hostMatches("sce.com", "sce.com"), true);
  assert.equal(portalInternals.hostMatches("www.sce.com", "*.sce.com"), true);
  assert.equal(portalInternals.hostMatches("evilsce.com", "*.sce.com"), false);
  assert.equal(portalInternals.hostMatches("sce.com.evil.test", "*.sce.com"), false);
});

test("payment URLs must use HTTPS and an allowed host", () => {
  assert.doesNotThrow(() =>
    portalInternals.assertAllowedUrl("https://www.sce.com/pay", [
      "sce.com",
      "*.sce.com",
    ]),
  );
  assert.throws(
    () =>
      portalInternals.assertAllowedUrl("http://www.sce.com/pay", [
        "*.sce.com",
      ]),
    SafetyStopError,
  );
  assert.throws(
    () =>
      portalInternals.assertAllowedUrl("https://lookalike-sce.com/pay", [
        "*.sce.com",
      ]),
    SafetyStopError,
  );
});

test("current SCE payment route rejects legacy or unrelated destinations", () => {
  assert.equal(
    portalInternals.isScePaymentRoute(
      "https://www.sce.com/mysce/billsnpayments/paybills",
    ),
    true,
  );
  assert.equal(
    portalInternals.isScePaymentRoute(
      "https://www.sce.com/mysce/billsnpayments/paybills/review?step=2",
    ),
    true,
  );
  assert.equal(
    portalInternals.isScePaymentRoute("https://www.sce.com/my-account"),
    false,
  );
  assert.equal(
    portalInternals.isScePaymentRoute("https://payments.example.test/pay"),
    false,
  );
  assert.throws(
    () =>
      portalInternals.assertScePaymentRoute(
        "https://payments.example.test/pay",
      ),
    SafetyStopError,
  );
});

test("labeled values are parsed from a deterministic review fixture", async () => {
  const text = await readFile(
    new URL("./fixtures/sce-payment-review.txt", import.meta.url),
    "utf8",
  );
  assert.equal(portalInternals.labeledMoney(text, ["payment amount"]), 28_417);
  assert.equal(portalInternals.labeledMoney(text, ["convenience fee"]), 165);
  assert.equal(portalInternals.labeledMoney(text, ["total payment"]), 28_582);
});

test("SCE due date formats normalize to ISO dates", async () => {
  const billText = await readFile(
    new URL("./fixtures/sce-bill.txt", import.meta.url),
    "utf8",
  );
  assert.equal(
    portalInternals.extractDueDate(billText),
    "2026-07-31",
  );
  assert.equal(
    portalInternals.extractDueDate("Amount due by 07/31/2026"),
    "2026-07-31",
  );
  assert.equal(portalInternals.isoDate("2026-07-31"), "2026-07-31");
});

test("account references are irreversible and labels are verified", () => {
  const reference = portalInternals.safeAccountReference(
    "Service Account Number: 123-456-7890",
    null,
  );
  assert.match(reference, /^sce-[a-f0-9]{12}$/);
  assert.equal(reference.includes("1234567890"), false);
  assert.throws(
    () => portalInternals.safeAccountReference("Primary home", "Rental unit"),
    SafetyStopError,
  );
});
