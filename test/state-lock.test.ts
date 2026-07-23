import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BillSnapshot, PaymentReview } from "../src/domain.js";
import { ScePayError } from "../src/errors.js";
import { acquireRunLock } from "../src/lock.js";
import type { AppPaths } from "../src/paths.js";
import { StateStore } from "../src/state.js";

function appPaths(rootDir: string): AppPaths {
  return {
    rootDir,
    configFile: join(rootDir, "config.json"),
    stateFile: join(rootDir, "state.json"),
    auditFile: join(rootDir, "audit.jsonl"),
    profileDir: join(rootDir, "profile"),
    lockFile: join(rootDir, "run.lock"),
  };
}

const bill: BillSnapshot = {
  accountReference: "sce-test",
  amountCents: 12_345,
  dueDate: "2026-08-01",
  observedAt: "2026-07-23T12:00:00.000Z",
};

const review: PaymentReview = {
  accountReference: "sce-test",
  amountCents: 12_345,
  feeCents: 165,
  totalCents: 12_510,
  dueDate: "2026-08-01",
  paymentMethodLast4: "4242",
};

test("state persists payment intent transitions and reconciliation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "sce-pay-state-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const paths = appPaths(root);
  const store = new StateStore(paths);

  const intent = await store.createSubmittingIntent(
    "fingerprint",
    bill,
    review,
    "2026-07-23T12:00:00.000Z",
  );
  assert.equal((await store.findBlockingIntent())?.id, intent.id);

  await store.markIntentUnknown(
    intent.id,
    "network ended after click",
    "2026-07-23T12:01:00.000Z",
  );
  const reconciled = await store.reconcileIntent(
    intent.id,
    "paid",
    "verified in SCE payment history",
    "2026-07-23T12:05:00.000Z",
    "ABC-123",
  );
  assert.equal(reconciled.status, "confirmed");
  assert.equal(reconciled.confirmationNumber, "ABC-123");
  assert.equal(await store.findBlockingIntent(), undefined);

  const persisted = JSON.parse(await readFile(paths.stateFile, "utf8")) as {
    paymentIntents: unknown[];
  };
  assert.equal(persisted.paymentIntents.length, 1);
});

test("run lock prevents concurrent payment processes and is reusable", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "sce-pay-lock-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const path = appPaths(root).lockFile;

  const release = await acquireRunLock(path);
  await assert.rejects(
    acquireRunLock(path),
    (error: unknown) => error instanceof ScePayError && error.code === "LOCKED",
  );
  await release();
  const releaseAgain = await acquireRunLock(path);
  await releaseAgain();
});
