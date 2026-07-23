import { createHash } from "node:crypto";

import type { AuditLog } from "./audit.js";
import type { AppConfig } from "./config.js";
import type {
  BillSnapshot,
  Clock,
  PaymentReview,
  PortalClient,
  RunOutcome,
} from "./domain.js";
import {
  PaymentSubmissionUncertainError,
  SafetyStopError,
  ScePayError,
} from "./errors.js";
import { formatCents } from "./money.js";
import type { StateStore } from "./state.js";

export type WorkflowOptions = {
  dryRun: boolean;
};

export type WorkflowDependencies = {
  config: AppConfig;
  portal: PortalClient;
  state: StateStore;
  audit: AuditLog;
  clock: Clock;
};

function paymentFingerprint(bill: BillSnapshot): string {
  return createHash("sha256")
    .update(
      ["sce-pay-intent-v1", bill.accountReference, bill.dueDate, bill.amountCents].join(
        "\n",
      ),
    )
    .digest("hex");
}

function isoDateToUtcMs(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    throw new SafetyStopError(`SCE returned an invalid due date: "${value}".`);
  }

  const year = Number.parseInt(match[1] ?? "", 10);
  const month = Number.parseInt(match[2] ?? "", 10);
  const day = Number.parseInt(match[3] ?? "", 10);
  const result = Date.UTC(year, month - 1, day);
  const check = new Date(result);

  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new SafetyStopError(`SCE returned an impossible due date: "${value}".`);
  }

  return result;
}

function daysUntil(dueDate: string, now: Date): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.ceil((isoDateToUtcMs(dueDate) - today) / 86_400_000);
}

function validateBill(config: AppConfig, bill: BillSnapshot, now: Date): void {
  if (!Number.isSafeInteger(bill.amountCents) || bill.amountCents <= 0) {
    throw new SafetyStopError("SCE returned a non-positive or invalid bill amount.");
  }

  if (bill.amountCents > config.automation.maxBillCents) {
    throw new SafetyStopError(
      `The ${formatCents(bill.amountCents)} bill exceeds the configured ${formatCents(config.automation.maxBillCents)} limit.`,
      "Review the bill manually. Raise maxBillCents only after confirming the amount is expected.",
    );
  }

  const remainingDays = daysUntil(bill.dueDate, now);
  if (remainingDays < -45) {
    throw new SafetyStopError(
      `The observed due date ${bill.dueDate} is more than 45 days in the past.`,
      "Review SCE payment history and the current balance before continuing.",
    );
  }
}

function validateReview(
  config: AppConfig,
  bill: BillSnapshot,
  review: PaymentReview,
  last4: string,
): void {
  if (review.accountReference !== bill.accountReference) {
    throw new SafetyStopError("The account changed between bill inspection and review.");
  }
  if (review.dueDate !== bill.dueDate) {
    throw new SafetyStopError("The due date changed between bill inspection and review.");
  }
  if (review.amountCents !== bill.amountCents) {
    throw new SafetyStopError(
      `The payment amount changed from ${formatCents(bill.amountCents)} to ${formatCents(review.amountCents)}.`,
    );
  }
  if (review.paymentMethodLast4 !== last4) {
    throw new SafetyStopError("The selected card does not match the authorized last four.");
  }
  if (review.feeCents !== config.automation.expectedFeeCents) {
    throw new SafetyStopError(
      `The card fee is ${formatCents(review.feeCents)}, but ${formatCents(config.automation.expectedFeeCents)} was authorized.`,
      "Review SCE's current fee, then re-arm sce-pay if you accept the new amount.",
    );
  }
  if (review.totalCents !== review.amountCents + review.feeCents) {
    throw new SafetyStopError("The payment total does not equal the bill plus the fee.");
  }
  if (review.totalCents > config.automation.maxBillCents + review.feeCents) {
    throw new SafetyStopError("The reviewed total exceeds the configured safety limit.");
  }
}

function shouldSubmit(config: AppConfig, options: WorkflowOptions): boolean {
  return (
    !options.dryRun &&
    config.automation.enabled &&
    config.automation.mode === "pay"
  );
}

function assertArmed(config: AppConfig): string {
  const { paymentMethodLast4, authorizedAt } = config.automation;
  if (paymentMethodLast4 === null || authorizedAt === null) {
    throw new SafetyStopError(
      "Payment mode is not fully authorized.",
      "Run `sce-pay arm --last4 1234 --max 750 --fee 1.65`.",
    );
  }
  return paymentMethodLast4;
}

export async function runPaymentWorkflow(
  dependencies: WorkflowDependencies,
  options: WorkflowOptions,
): Promise<RunOutcome> {
  const { config, portal, state, audit, clock } = dependencies;
  const startedAt = clock.now().toISOString();
  const run = await state.beginRun(startedAt, options.dryRun);
  await audit.append({ at: startedAt, event: "run.started", runId: run.id });

  try {
    const submitting = shouldSubmit(config, options);
    if (submitting) {
      const blocking = await state.findBlockingIntent();
      if (blocking !== undefined) {
        throw new SafetyStopError(
          `Payment intent ${blocking.id} has unresolved status "${blocking.status}".`,
          `Check SCE payment history, then run \`sce-pay reconcile ${blocking.id} --as paid\` or \`--as not-paid\`.`,
        );
      }
    }

    const bill = await portal.inspectBill();
    if (bill === null || bill.amountCents === 0) {
      const message = "No payable SCE balance was found.";
      await state.finishRun(run.id, "skipped", message, clock.now().toISOString());
      await audit.append({
        at: clock.now().toISOString(),
        event: "run.no_bill",
        runId: run.id,
      });
      return { status: "no-bill", message };
    }

    validateBill(config, bill, clock.now());
    const fingerprint = paymentFingerprint(bill);
    const confirmed = await state.findConfirmed(fingerprint);
    if (confirmed !== undefined) {
      const message = `This ${formatCents(bill.amountCents)} bill was already confirmed paid.`;
      await state.finishRun(run.id, "skipped", message, clock.now().toISOString());
      return { status: "already-paid", message };
    }

    const remainingDays = daysUntil(bill.dueDate, clock.now());
    if (remainingDays > config.automation.payWhenDueWithinDays) {
      const message = `Bill is due in ${remainingDays} days; configured payment window is ${config.automation.payWhenDueWithinDays} days.`;
      await state.finishRun(run.id, "skipped", message, clock.now().toISOString());
      await audit.append({
        at: clock.now().toISOString(),
        event: "run.not_due",
        runId: run.id,
        amountCents: bill.amountCents,
        dueDate: bill.dueDate,
      });
      return { status: "not-due", message };
    }

    if (config.automation.mode === "observe" && !options.dryRun) {
      const message = `Observed ${formatCents(bill.amountCents)} due ${bill.dueDate}; payment mode is disabled.`;
      await state.finishRun(run.id, "succeeded", message, clock.now().toISOString());
      await audit.append({
        at: clock.now().toISOString(),
        event: "run.observed",
        runId: run.id,
        amountCents: bill.amountCents,
        dueDate: bill.dueDate,
      });
      return { status: "observed", message };
    }

    const last4 = assertArmed(config);
    const review = await portal.preparePayment(bill, last4);
    validateReview(config, bill, review, last4);

    if (!submitting) {
      const message = `Dry run passed: ${formatCents(review.amountCents)} bill + ${formatCents(review.feeCents)} fee = ${formatCents(review.totalCents)}.`;
      await state.finishRun(run.id, "succeeded", message, clock.now().toISOString());
      await audit.append({
        at: clock.now().toISOString(),
        event: "run.dry_run",
        runId: run.id,
        amountCents: review.amountCents,
        feeCents: review.feeCents,
        totalCents: review.totalCents,
        dueDate: review.dueDate,
      });
      return { status: "dry-run", message, review };
    }

    const submission = new Map<"intent", string>();
    try {
      const confirmation = await portal.submitPayment(async () => {
        const intent = await state.createSubmittingIntent(
          fingerprint,
          bill,
          review,
          clock.now().toISOString(),
        );
        submission.set("intent", intent.id);
        await audit.append({
          at: clock.now().toISOString(),
          event: "payment.submitting",
          runId: run.id,
          intentId: intent.id,
          amountCents: review.amountCents,
          feeCents: review.feeCents,
          totalCents: review.totalCents,
          dueDate: review.dueDate,
        });
      });
      const intentId = submission.get("intent");
      if (intentId === undefined) {
        throw new SafetyStopError(
          "The portal returned a confirmation without entering the durable submission boundary.",
        );
      }
      if (confirmation.confirmationNumber.trim() === "") {
        throw new PaymentSubmissionUncertainError(
          "The payment page reported success without a confirmation number.",
        );
      }
      await state.confirmIntent(intentId, confirmation, clock.now().toISOString());
      const message = `Paid ${formatCents(review.amountCents)} plus a ${formatCents(review.feeCents)} fee.`;
      await state.finishRun(run.id, "succeeded", message, clock.now().toISOString());
      await audit.append({
        at: clock.now().toISOString(),
        event: "payment.confirmed",
        runId: run.id,
        intentId,
        status: "confirmed",
        amountCents: review.amountCents,
        feeCents: review.feeCents,
        totalCents: review.totalCents,
      });
      return { status: "paid", message, confirmation, review };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Payment result could not be determined.";
      const intentId = submission.get("intent");
      if (intentId !== undefined) {
        await state.markIntentUnknown(intentId, message, clock.now().toISOString());
        await audit.append({
          at: clock.now().toISOString(),
          event: "payment.unknown",
          runId: run.id,
          intentId,
          status: "unknown",
          detail: message,
        });
      } else {
        throw error;
      }
      throw error instanceof PaymentSubmissionUncertainError
        ? error
        : new PaymentSubmissionUncertainError(
            "The payment may have been submitted, but confirmation was not observed.",
            error,
          );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown failure";
    await state.finishRun(run.id, "failed", message, clock.now().toISOString());
    await audit.append({
      at: clock.now().toISOString(),
      event: "run.failed",
      runId: run.id,
      status: error instanceof ScePayError ? error.code : "UNKNOWN",
      detail: message,
    });
    throw error;
  } finally {
    await portal.close().catch(() => undefined);
  }
}

export const workflowInternals = {
  daysUntil,
  paymentFingerprint,
  validateBill,
  validateReview,
};
