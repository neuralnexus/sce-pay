import { createHash, randomUUID } from "node:crypto";

import type {
  GuestBundle,
  PaymentIntent,
  PaymentStore,
  PortalClient,
  WorkflowExecution,
  WorkflowOutcome,
} from "./domain.js";
import { PaymentUncertainError, PolicyStopError } from "./errors.js";
import { daysUntil, validateBill, validateReview } from "./policy.js";

function fingerprint(
  accountReference: string,
  dueDate: string,
  amountCents: number,
): string {
  return createHash("sha256")
    .update(`${accountReference}\0${dueDate}\0${amountCents}`)
    .digest("hex");
}

export async function runPaymentWorkflow(options: {
  bundle: GuestBundle;
  portal: PortalClient;
  store: PaymentStore;
  now?: Date;
  clock?: () => Date;
  dryRun: boolean;
}): Promise<WorkflowExecution> {
  const clock = options.clock ?? (() => new Date());
  const now = options.now ?? clock();
  const lease = await options.store.acquireLease(now);
  let intent: PaymentIntent | undefined;
  let crossedSubmissionBoundary = false;

  const complete = async (
    outcome: Exclude<WorkflowOutcome, { status: "deferred" }>,
  ): Promise<WorkflowExecution> => {
    const refreshedBrowserState = await options.portal
      .captureBrowserState()
      .catch(() => undefined);
    return {
      outcome,
      ...(refreshedBrowserState ? { refreshedBrowserState } : {}),
    };
  };

  try {
    const blocking = await options.store.findBlockingIntent();
    if (blocking) {
      throw new PolicyStopError(
        `Payment intent ${blocking.id} has an unresolved ${blocking.status} result.`,
      );
    }

    const bill = await options.portal.inspectBill();
    if (bill === null) {
      return complete({
        status: "no-balance",
        message: "SCE shows no current balance due.",
      });
    }

    if (validateBill(bill, options.bundle, now) === "not-due") {
      return complete({
        status: "not-due",
        dueDate: bill.dueDate,
        message: `The bill is not inside the ${options.bundle.payWhenDueWithinDays}-day payment window (${daysUntil(
          bill.dueDate,
          now,
        )} days remaining).`,
      });
    }

    const billFingerprint = fingerprint(
      bill.accountReference,
      bill.dueDate,
      bill.amountCents,
    );
    if (await options.store.isFingerprintConfirmed(billFingerprint)) {
      return complete({
        status: "already-paid",
        message: "This exact bill cycle is already confirmed paid.",
      });
    }

    const review = await options.portal.preparePayment(bill);
    validateReview(bill, review, options.bundle, clock());
    if (options.dryRun) {
      return complete({
        status: "dry-run",
        message: "The guest-payment review passed; final submission was not activated.",
        review,
      });
    }

    const confirmation = await options.portal.submitPayment(async () => {
      const boundaryTime = clock();
      await options.store.renewLease(lease.id, boundaryTime);
      intent = await options.store.beginIntent(
        lease.id,
        billFingerprint,
        review,
        boundaryTime,
      );
      crossedSubmissionBoundary = true;
    });
    if (!intent) {
      throw new PaymentUncertainError();
    }
    await options.store.confirmIntent(intent.id, confirmation, clock());
    return complete({
      status: "paid",
      message: "SCE returned a payment confirmation.",
      review,
      confirmation,
    });
  } catch (error) {
    if (crossedSubmissionBoundary && intent) {
      await options.store.markIntentUnknown(intent.id, clock());
      throw new PaymentUncertainError();
    }
    throw error;
  } finally {
    await options.portal.close().catch(() => undefined);
    await options.store.releaseLease(lease.id).catch(() => undefined);
  }
}

export const workflowInternals = {
  fingerprint,
  randomIntentId: () => randomUUID(),
};
