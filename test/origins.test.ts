import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAllowedOrigin,
  assertAllowedTopLevelUrl,
  isAllowedSceTopLevelUrl,
  isLocallySafeRequestUrl,
  normalizedOrigin,
} from "../src/origins.js";

test("origin checks require exact reviewed HTTPS origins", () => {
  assert.equal(
    normalizedOrigin("https://www.sce.com/path?account=redacted"),
    "https://www.sce.com",
  );
  assert.doesNotThrow(() =>
    assertAllowedOrigin(
      "https://www.sce.com/mysce/billsnpayments/paybills",
      ["https://www.sce.com"],
      "top-level",
    ),
  );
  assert.throws(() =>
    assertAllowedOrigin(
      "https://www.sce.com.evil.test/pay",
      ["https://www.sce.com"],
      "top-level",
    ),
  );
  assert.throws(() =>
    assertAllowedOrigin("http://www.sce.com/pay", ["https://www.sce.com"], "top-level"),
  );
});

test("top-level navigation is pinned to the SCE Guest Pay route", () => {
  assert.equal(
    isAllowedSceTopLevelUrl(
      "https://www.sce.com/mysce/billsnpayments/paybills?source=guest",
    ),
    true,
  );
  assert.doesNotThrow(() =>
    assertAllowedTopLevelUrl(
      "https://www.sce.com/mysce/billsnpayments/paybills/review",
    ),
  );
  assert.throws(() => assertAllowedTopLevelUrl("https://www.sce.com/my-account"));
  assert.throws(() =>
    assertAllowedTopLevelUrl(
      "https://payments.example.test/mysce/billsnpayments/paybills",
    ),
  );
});

test("only inert local request schemes bypass the network allowlist", () => {
  assert.equal(isLocallySafeRequestUrl("about:blank"), true);
  assert.equal(isLocallySafeRequestUrl("data:text/plain,ok"), true);
  assert.equal(isLocallySafeRequestUrl("blob:https://www.sce.com/id"), true);
  assert.equal(isLocallySafeRequestUrl("http://www.sce.com/pay"), false);
});
