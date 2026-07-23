import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { AuditLog } from "../src/audit.js";
import { defaultConfig, type AppConfig } from "../src/config.js";
import type {
  BillSnapshot,
  Clock,
  PaymentConfirmation,
  PaymentReview,
  PortalClient,
} from "../src/domain.js";
import {
  PaymentSubmissionUncertainError,
  SafetyStopError,
  SiteChangedError,
} from "../src/errors.js";
import type { AppPaths } from "../src/paths.js";
import { StateStore } from "../src/state.js";
import { runPaymentWorkflow } from "../src/workflow.js";

const NOW = new Date("2026-07-23T12:00:00.000Z");

const bill: BillSnapshot = {
  accountReference: "sce-home",
  amountCents: 28_417,
  dueDate: "2026-07-31",
  observedAt: NOW.toISOString(),
};

const review: PaymentReview = {
  accountReference: bill.accountReference,
  amountCents: bill.amountCents,
  feeCents: 165,
  totalCents: 28_582,
  dueDate: bill.dueDate,
  paymentMethodLast4: "4242",
};

const confirmation: PaymentConfirmation = {
  confirmationNumber: "CONF-1234",
  paidAt: "2026-07-23T12:01:00.000Z",
};

class FakePortal implements PortalClient {
  readonly bill: BillSnapshot | null;
  readonly review: PaymentReview;
  readonly confirmation: PaymentConfirmation;
  readonly failBeforeBoundary: boolean;
  readonly failAfterBoundary: boolean;
  closed = false;
  submitted = false;
  prepared = false;

  constructor(options?: {
    bill?: BillSnapshot | null;
    review?: PaymentReview;
    confirmation?: PaymentConfirmation;
    failBeforeBoundary?: boolean;
    failAfterBoundary?: boolean;
  }) {
    this.bill = options?.bill === undefined ? bill : options.bill;
    this.review = options?.review ?? review;
    this.confirmation = options?.confirmation ?? confirmation;
    this.failBeforeBoundary = options?.failBeforeBoundary ?? false;
    this.failAfterBoundary = options?.failAfterBoundary ?? false;
  }

  async inspectBill(): Promise<BillSnapshot | null> {
    return this.bill;
  }

  async preparePayment(): Promise<PaymentReview> {
    this.prepared = true;
    return this.review;
  }

  async submitPayment(onWillSubmit: () => Promise<void>): Promise<PaymentConfirmation> {
    if (this.failBeforeBoundary) {
      throw new SiteChangedError("final button missing");
    }
    await onWillSubmit();
    this.submitted = true;
    if (this.failAfterBoundary) {
      throw new PaymentSubmissionUncertainError("connection ended after click");
    }
    return this.confirmation;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function armedConfig(overrides?: Partial<AppConfig["automation"]>): AppConfig {
  const config = defaultConfig();
  return {
    ...config,
    automation: {
      ...config.automation,
      enabled: true,
      mode: "pay",
      paymentMethodLast4: "4242",
      authorizedAt: NOW.toISOString(),
      maxBillCents: 75_000,
      ...overrides,
    },
  };
}

function fixedClock(): Clock {
  return { now: () => new Date(NOW) };
}

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

async function harness(context: TestContext): Promise<{
  paths: AppPaths;
  state: StateStore;
  audit: AuditLog;
}> {
  const root = await mkdtemp(join(tmpdir(), "sce-pay-workflow-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const paths = appPaths(root);
  return {
    paths,
    state: new StateStore(paths),
    audit: new AuditLog(paths),
  };
}

test("happy path persists intent before submit and confirms once", async (context) => {
  const { state, audit } = await harness(context);
  const portal = new FakePortal();
  const outcome = await runPaymentWorkflow(
    { config: armedConfig(), portal, state, audit, clock: fixedClock() },
    { dryRun: false },
  );

  assert.equal(outcome.status, "paid");
  assert.equal(portal.submitted, true);
  assert.equal(portal.closed, true);
  const snapshot = await state.snapshot();
  assert.equal(snapshot.paymentIntents.length, 1);
  assert.equal(snapshot.paymentIntents[0]?.status, "confirmed");

  const secondPortal = new FakePortal();
  const duplicate = await runPaymentWorkflow(
    {
      config: armedConfig(),
      portal: secondPortal,
      state,
      audit,
      clock: fixedClock(),
    },
    { dryRun: false },
  );
  assert.equal(duplicate.status, "already-paid");
  assert.equal(secondPortal.prepared, false);
  assert.equal(secondPortal.submitted, false);
});

test("dry run validates the entire review but never creates an intent", async (context) => {
  const { state, audit } = await harness(context);
  const portal = new FakePortal();
  const outcome = await runPaymentWorkflow(
    { config: armedConfig(), portal, state, audit, clock: fixedClock() },
    { dryRun: true },
  );
  assert.equal(outcome.status, "dry-run");
  assert.equal(portal.prepared, true);
  assert.equal(portal.submitted, false);
  assert.equal((await state.snapshot()).paymentIntents.length, 0);
});

test("observe mode reads the bill without entering payment review", async (context) => {
  const { state, audit } = await harness(context);
  const portal = new FakePortal();
  const config = armedConfig({ enabled: false, mode: "observe" });
  const outcome = await runPaymentWorkflow(
    { config, portal, state, audit, clock: fixedClock() },
    { dryRun: false },
  );
  assert.equal(outcome.status, "observed");
  assert.equal(portal.prepared, false);
});

test("amount cap and fee mismatch fail before submission", async (context) => {
  const first = await harness(context);
  await assert.rejects(
    runPaymentWorkflow(
      {
        config: armedConfig({ maxBillCents: 10_000 }),
        portal: new FakePortal(),
        state: first.state,
        audit: first.audit,
        clock: fixedClock(),
      },
      { dryRun: false },
    ),
    SafetyStopError,
  );

  const second = await harness(context);
  await assert.rejects(
    runPaymentWorkflow(
      {
        config: armedConfig(),
        portal: new FakePortal({
          review: { ...review, feeCents: 200, totalCents: 28_617 },
        }),
        state: second.state,
        audit: second.audit,
        clock: fixedClock(),
      },
      { dryRun: false },
    ),
    SafetyStopError,
  );
  assert.equal((await second.state.snapshot()).paymentIntents.length, 0);
});

test("bill outside the configured window is not prepared", async (context) => {
  const { state, audit } = await harness(context);
  const portal = new FakePortal({
    bill: { ...bill, dueDate: "2026-09-01" },
  });
  const outcome = await runPaymentWorkflow(
    {
      config: armedConfig({ payWhenDueWithinDays: 21 }),
      portal,
      state,
      audit,
      clock: fixedClock(),
    },
    { dryRun: false },
  );
  assert.equal(outcome.status, "not-due");
  assert.equal(portal.prepared, false);
});

test("failure before durable boundary does not create ambiguous intent", async (context) => {
  const { state, audit } = await harness(context);
  await assert.rejects(
    runPaymentWorkflow(
      {
        config: armedConfig(),
        portal: new FakePortal({ failBeforeBoundary: true }),
        state,
        audit,
        clock: fixedClock(),
      },
      { dryRun: false },
    ),
    SiteChangedError,
  );
  assert.equal((await state.snapshot()).paymentIntents.length, 0);
});

test("failure after durable boundary blocks retries until reconciliation", async (context) => {
  const { state, audit } = await harness(context);
  await assert.rejects(
    runPaymentWorkflow(
      {
        config: armedConfig(),
        portal: new FakePortal({ failAfterBoundary: true }),
        state,
        audit,
        clock: fixedClock(),
      },
      { dryRun: false },
    ),
    PaymentSubmissionUncertainError,
  );
  const intent = (await state.snapshot()).paymentIntents[0];
  assert.equal(intent?.status, "unknown");

  await assert.rejects(
    runPaymentWorkflow(
      {
        config: armedConfig(),
        portal: new FakePortal(),
        state,
        audit,
        clock: fixedClock(),
      },
      { dryRun: false },
    ),
    (error: unknown) =>
      error instanceof SafetyStopError && error.message.includes("unresolved"),
  );
});
