import assert from "node:assert/strict";
import test from "node:test";

import { signNotification } from "../src/notifications.js";

test("notification signatures bind timestamp and body", async () => {
  const secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const first = await signNotification(
    '{"outcome":"paid"}',
    secret,
    "2026-07-23T17:00:00.000Z",
  );
  const same = await signNotification(
    '{"outcome":"paid"}',
    secret,
    "2026-07-23T17:00:00.000Z",
  );
  const changed = await signNotification(
    '{"outcome":"unknown"}',
    secret,
    "2026-07-23T17:00:00.000Z",
  );
  assert.match(first, /^v1=[A-Za-z0-9_-]{43}$/);
  assert.equal(first, same);
  assert.notEqual(first, changed);
});
