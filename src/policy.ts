import type { BillSnapshot, GuestBundle, PaymentReview } from "./domain.js";
import { PolicyStopError } from "./errors.js";

const DAY_MS = 86_400_000;

export function daysUntil(isoDate: string, now: Date): number {
  const due = new Date(`${isoDate}T23:59:59.999Z`);
  if (Number.isNaN(due.getTime())) {
    throw new PolicyStopError("The SCE due date could not be verified.");
  }
  return Math.ceil((due.getTime() - now.getTime()) / DAY_MS);
}

export function validateBill(
  bill: BillSnapshot,
  bundle: GuestBundle,
  now: Date,
): "eligible" | "not-due" {
  if (!Number.isSafeInteger(bill.amountCents) || bill.amountCents <= 0) {
    throw new PolicyStopError("The full current amount due was invalid.");
  }
  if (bill.amountCents > bundle.maxBillCents) {
    throw new PolicyStopError("The bill exceeds the authorized bill ceiling.");
  }
  return daysUntil(bill.dueDate, now) > bundle.payWhenDueWithinDays
    ? "not-due"
    : "eligible";
}

export function validateReview(
  bill: BillSnapshot,
  review: PaymentReview,
  bundle: GuestBundle,
): void {
  if (
    review.accountReference !== bill.accountReference ||
    review.amountCents !== bill.amountCents ||
    review.dueDate !== bill.dueDate
  ) {
    throw new PolicyStopError("The payment review no longer matches the inspected bill.");
  }
  if (review.paymentMethodLast4 !== bundle.paymentMethodLast4) {
    throw new PolicyStopError("The review does not show the authorized payment method.");
  }
  if (
    !Number.isSafeInteger(review.feeCents) ||
    review.feeCents < 0 ||
    review.feeCents >= bundle.feeLimitCentsExclusive
  ) {
    throw new PolicyStopError("The convenience fee is not below the authorized fee ceiling.");
  }
  if (review.totalCents !== review.amountCents + review.feeCents) {
    throw new PolicyStopError("The review total does not equal bill amount plus fee.");
  }
}
