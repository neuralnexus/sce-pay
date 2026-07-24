import assert from "node:assert/strict";
import test from "node:test";

import type { GuestBundle } from "../src/domain.js";
import { nextCheckAfterOutcome, nextCheckAfterSafeFailure } from "../src/schedule.js";

const now = new Date("2026-07-23T17:00:00.000Z");
const bundle = {
  payWhenDueWithinDays: 14,
} as GuestBundle;

test("successful and empty-balance runs avoid daily browser use", () => {
  assert.equal(
    nextCheckAfterOutcome(
      {
        status: "paid",
        message: "paid",
        review: {} as never,
        confirmation: {} as never,
      },
      bundle,
      now,
    ),
    "2026-08-06T17:00:00.000Z",
  );
  assert.equal(
    nextCheckAfterOutcome({ status: "no-balance", message: "none" }, bundle, now),
    "2026-07-30T17:00:00.000Z",
  );
});

test("not-due runs resume at the configured payment window", () => {
  assert.equal(
    nextCheckAfterOutcome(
      {
        status: "not-due",
        message: "later",
        dueDate: "2026-08-31",
      },
      bundle,
      now,
    ),
    "2026-08-17T17:00:00.000Z",
  );
});

test("safe pre-submission failures retry on the next daily cron", () => {
  assert.equal(nextCheckAfterSafeFailure(now), "2026-07-24T17:00:00.000Z");
});
