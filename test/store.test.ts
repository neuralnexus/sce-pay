import assert from "node:assert/strict";
import test from "node:test";

import type { EncryptedBundle, PaymentReview, RunRecord } from "../src/domain.js";
import { DurablePaymentStore } from "../src/store.js";

class MemoryStorage {
  readonly data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async put<T>(keyOrEntries: string | Record<string, T>, value?: T): Promise<void> {
    if (typeof keyOrEntries === "string") {
      this.data.set(keyOrEntries, value);
      return;
    }
    for (const [key, entry] of Object.entries(keyOrEntries)) {
      this.data.set(key, entry);
    }
  }

  async delete(keys: string | string[]): Promise<boolean> {
    if (Array.isArray(keys)) {
      let deleted = false;
      for (const key of keys) deleted = this.data.delete(key) || deleted;
      return deleted;
    }
    return this.data.delete(keys);
  }

  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    return new Map(
      [...this.data.entries()].filter(
        ([key]) => !options?.prefix || key.startsWith(options.prefix),
      ),
    ) as Map<string, T>;
  }

  async transaction<T>(
    closure: (transaction: MemoryStorage) => Promise<T>,
  ): Promise<T> {
    return closure(this);
  }
}

function store(): DurablePaymentStore {
  return new DurablePaymentStore(
    new MemoryStorage() as unknown as DurableObjectStorage,
  );
}

const encrypted: EncryptedBundle = {
  version: 2,
  algorithm: "AES-256-GCM",
  bundleId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  createdAt: "2026-07-23T17:00:00.000Z",
  iv: "AAAAAAAAAAAAAAAA",
  ciphertext: "AAAAAAAAAAAAAAAAAAAAAA==",
};

const review: PaymentReview = {
  accountReference: "sce-test",
  amountCents: 10_000,
  feeCents: 399,
  totalCents: 10_399,
  dueDate: "2026-07-31",
  observedAt: "2026-07-23T17:00:00.000Z",
  paymentMethodLast4: "4242",
};

test("arming is bound to a recent dry run and exact Worker release", async () => {
  const paymentStore = store();
  const now = new Date("2026-07-23T17:00:00.000Z");
  await paymentStore.configure("config", encrypted.bundleId, encrypted, now);
  await assert.rejects(paymentStore.arm("config", "release-a", now));
  await paymentStore.recordDryRunValidation("config", "release-a", now);
  await paymentStore.arm("config", "release-a", now);
  assert.equal((await paymentStore.status("release-a")).armed, true);
  const changed = await paymentStore.status("release-b");
  assert.equal(changed.armed, false);
  assert.equal(changed.armBlockReason, "release-changed");
});

test("intent creation requires the active lease and blocks reconfiguration", async () => {
  const paymentStore = store();
  const now = new Date("2026-07-23T17:00:00.000Z");
  await paymentStore.configure("config", encrypted.bundleId, encrypted, now);
  const lease = await paymentStore.acquireLease(now);
  const intent = await paymentStore.beginIntent(lease.id, "fingerprint", review, now);
  assert.equal(intent.status, "submitting");
  await assert.rejects(
    paymentStore.configure("replacement", encrypted.bundleId, encrypted, now),
  );
});

test("confirmed intent cannot be downgraded to unknown", async () => {
  const paymentStore = store();
  const now = new Date("2026-07-23T17:00:00.000Z");
  const lease = await paymentStore.acquireLease(now);
  const intent = await paymentStore.beginIntent(lease.id, "fingerprint", review, now);
  await paymentStore.confirmIntent(
    intent.id,
    { confirmationNumber: "SCE-1234", paidAt: now.toISOString() },
    now,
  );
  await paymentStore.markIntentUnknown(intent.id, now);
  const status = await paymentStore.status("release");
  assert.equal(status.blockingIntent, undefined);
  assert.equal(status.confirmedPayments[0]?.status, "confirmed");
});

test("run history is bounded and scheduling is durable", async () => {
  const paymentStore = store();
  for (let index = 0; index < 105; index += 1) {
    const record: RunRecord = {
      id: index.toString().padStart(36, "0"),
      at: new Date(Date.UTC(2026, 6, 23, 17, index)).toISOString(),
      source: "cron",
      dryRun: false,
      outcome: "no-balance",
      message: "none",
      releaseId: "release",
    };
    await paymentStore.recordRun(record, "2026-07-30T17:00:00.000Z");
  }
  const status = await paymentStore.status("release");
  assert.equal(status.recentRuns.length, 20);
  assert.equal(status.nextCheckAt, "2026-07-30T17:00:00.000Z");
});
