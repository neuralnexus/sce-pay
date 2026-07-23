import assert from "node:assert/strict";
import test from "node:test";

import type {
  BillSnapshot,
  GuestBundle,
  PaymentConfirmation,
  PaymentIntent,
  PaymentReview,
  PaymentStore,
  PortalClient,
  RunLease,
} from "../src/domain.js";
import { PaymentUncertainError } from "../src/errors.js";
import { runPaymentWorkflow } from "../src/workflow.js";

const NOW = new Date("2026-07-23T12:00:00.000Z");
const bundle: GuestBundle = {
  version: 1,
  capturedAt: NOW.toISOString(),
  guestUrl: "https://www.sce.com/mysce/billsnpayments/paybills",
  accountNumber: "123456789012",
  mailingZip: "91203",
  paymentMethodLast4: "4242",
  maxBillCents: 75_000,
  feeLimitCentsExclusive: 400,
  payWhenDueWithinDays: 14,
  allowedTopLevelOrigins: ["https://www.sce.com"],
  allowedFrameOrigins: [],
  storageState: { cookies: [], origins: [] },
  sessionStorageByOrigin: {},
};
const bill: BillSnapshot = {
  accountReference: "sce-home",
  amountCents: 28_417,
  dueDate: "2026-07-31",
  observedAt: NOW.toISOString(),
};
const review: PaymentReview = {
  ...bill,
  feeCents: 399,
  totalCents: 28_816,
  paymentMethodLast4: "4242",
};
const confirmation: PaymentConfirmation = {
  confirmationNumber: "SCE-1234",
  paidAt: "2026-07-23T12:01:00.000Z",
};

class MemoryStore implements PaymentStore {
  lease: RunLease | undefined;
  blocking: PaymentIntent | undefined;
  confirmed = new Set<string>();

  async acquireLease(): Promise<RunLease> {
    this.lease = { id: "lease", expiresAt: "2026-07-23T12:15:00.000Z" };
    return this.lease;
  }
  async releaseLease(): Promise<void> {
    this.lease = undefined;
  }
  async findBlockingIntent(): Promise<PaymentIntent | undefined> {
    return this.blocking;
  }
  async isFingerprintConfirmed(value: string): Promise<boolean> {
    return this.confirmed.has(value);
  }
  async beginIntent(
    fingerprint: string,
    paymentReview: PaymentReview,
  ): Promise<PaymentIntent> {
    this.blocking = {
      id: "intent-1",
      fingerprint,
      status: "submitting",
      amountCents: paymentReview.amountCents,
      feeCents: paymentReview.feeCents,
      totalCents: paymentReview.totalCents,
      dueDate: paymentReview.dueDate,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    return this.blocking;
  }
  async confirmIntent(): Promise<void> {
    if (!this.blocking) throw new Error("missing");
    this.confirmed.add(this.blocking.fingerprint);
    this.blocking = undefined;
  }
  async markIntentUnknown(): Promise<void> {
    if (this.blocking) this.blocking.status = "unknown";
  }
}

class FakePortal implements PortalClient {
  readonly failAfterBoundary: boolean;
  submitted = false;
  closed = false;

  constructor(failAfterBoundary = false) {
    this.failAfterBoundary = failAfterBoundary;
  }
  async inspectBill(): Promise<BillSnapshot> {
    return bill;
  }
  async preparePayment(): Promise<PaymentReview> {
    return review;
  }
  async submitPayment(
    onWillSubmit: () => Promise<void>,
  ): Promise<PaymentConfirmation> {
    await onWillSubmit();
    this.submitted = true;
    if (this.failAfterBoundary) throw new PaymentUncertainError();
    return confirmation;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

test("cloud workflow confirms once and suppresses the exact bill", async () => {
  const store = new MemoryStore();
  const portal = new FakePortal();
  const first = await runPaymentWorkflow({
    bundle,
    portal,
    store,
    now: NOW,
    dryRun: false,
  });
  assert.equal(first.status, "paid");
  assert.equal(portal.submitted, true);
  assert.equal(portal.closed, true);

  const duplicatePortal = new FakePortal();
  const second = await runPaymentWorkflow({
    bundle,
    portal: duplicatePortal,
    store,
    now: NOW,
    dryRun: false,
  });
  assert.equal(second.status, "already-paid");
  assert.equal(duplicatePortal.submitted, false);
});

test("dry run reaches review without creating an intent", async () => {
  const store = new MemoryStore();
  const portal = new FakePortal();
  const result = await runPaymentWorkflow({
    bundle,
    portal,
    store,
    now: NOW,
    dryRun: true,
  });
  assert.equal(result.status, "dry-run");
  assert.equal(store.blocking, undefined);
  assert.equal(portal.submitted, false);
});

test("an uncertain result blocks every retry", async () => {
  const store = new MemoryStore();
  await assert.rejects(
    runPaymentWorkflow({
      bundle,
      portal: new FakePortal(true),
      store,
      now: NOW,
      dryRun: false,
    }),
    PaymentUncertainError,
  );
  assert.equal(store.blocking?.status, "unknown");
  await assert.rejects(
    runPaymentWorkflow({
      bundle,
      portal: new FakePortal(),
      store,
      now: NOW,
      dryRun: false,
    }),
  );
});
