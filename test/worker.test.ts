import assert from "node:assert/strict";
import test from "node:test";

import { authorized, readBody } from "../src/http.js";

function env(token = "secret-token"): { ADMIN_TOKEN: string } {
  return { ADMIN_TOKEN: token };
}

test("control authentication accepts only the exact bounded bearer token", async () => {
  assert.equal(
    await authorized(
      new Request("https://worker.test/api/status", {
        headers: { authorization: "Bearer secret-token" },
      }),
      env(),
    ),
    true,
  );
  assert.equal(
    await authorized(
      new Request("https://worker.test/api/status", {
        headers: { authorization: "Bearer wrong" },
      }),
      env(),
    ),
    false,
  );
  assert.equal(
    await authorized(
      new Request("https://worker.test/api/status", {
        headers: { authorization: `Bearer ${"x".repeat(129)}` },
      }),
      env(),
    ),
    false,
  );
});

test("control bodies require JSON and enforce actual byte size", async () => {
  const accepted = await readBody(
    new Request("https://worker.test/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    2,
  );
  assert.equal(accepted.byteLength, 2);

  await assert.rejects(
    readBody(
      new Request("https://worker.test/api/run", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      }),
      2,
    ),
    (error: unknown) => error instanceof Response && error.status === 415,
  );
  await assert.rejects(
    readBody(
      new Request("https://worker.test/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "too large",
      }),
      2,
    ),
    (error: unknown) => error instanceof Response && error.status === 413,
  );
});
