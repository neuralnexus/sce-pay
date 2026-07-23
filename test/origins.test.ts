import assert from "node:assert/strict";
import test from "node:test";

import { assertAllowedOrigin, normalizedOrigin } from "../src/origins.js";

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
    assertAllowedOrigin(
      "http://www.sce.com/pay",
      ["https://www.sce.com"],
      "top-level",
    ),
  );
});
