import type { BillSnapshot, GuestBundle, PaymentReview } from "./domain.js";
import { PolicyStopError } from "./errors.js";

const DAY_MS = 86_400_000;
const MAX_OBSERVATION_AGE_MS = 5 * 60_000;
const SCE_TIME_ZONE = "America/Los_Angeles";

function calendarDayInSceTime(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SCE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const year = Number.parseInt(values.year ?? "", 10);
  const month = Number.parseInt(values.month ?? "", 10);
  const day = Number.parseInt(values.day ?? "", 10);
  if (![year, month, day].every(Number.isInteger)) {
    throw new PolicyStopError("The current SCE billing date could not be verified.");
  }
  return Date.UTC(year, month - 1, day);
}

export function daysUntil(isoDate: string, now: Date): number {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new PolicyStopError("The SCE due date could not be verified.");
  }
  const due = Date.UTC(
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10) - 1,
    Number.parseInt(match[3], 10),
  );
  const dueDate = new Date(due);
  if (
    dueDate.getUTCFullYear() !== Number.parseInt(match[1], 10) ||
    dueDate.getUTCMonth() !== Number.parseInt(match[2], 10) - 1 ||
    dueDate.getUTCDate() !== Number.parseInt(match[3], 10)
  ) {
    throw new PolicyStopError("The SCE due date could not be verified.");
  }
  return Math.round((due - calendarDayInSceTime(now)) / DAY_MS);
}

export function validateBill(
  bill: BillSnapshot,
  bundle: GuestBundle,
  now: Date,
): "eligible" | "not-due" {
  const observedAt = new Date(bill.observedAt).getTime();
  if (
    Number.isNaN(observedAt) ||
    observedAt > now.getTime() + 30_000 ||
    now.getTime() - observedAt > MAX_OBSERVATION_AGE_MS
  ) {
    throw new PolicyStopError("The SCE bill observation is not current.");
  }
  if (!Number.isSafeInteger(bill.amountCents) || bill.amountCents <= 0) {
    throw new PolicyStopError("The full current amount due was invalid.");
  }
  if (bill.amountCents > bundle.maxBillCents) {
    throw new PolicyStopError("The bill exceeds the authorized bill ceiling.");
  }
  const days = daysUntil(bill.dueDate, now);
  if (days < -60 || days > 90) {
    throw new PolicyStopError(
      "The displayed due date is outside a current bill cycle.",
    );
  }
  return days > bundle.payWhenDueWithinDays ? "not-due" : "eligible";
}

export function validateReview(
  bill: BillSnapshot,
  review: PaymentReview,
  bundle: GuestBundle,
  now: Date,
): void {
  const billObservedAt = new Date(bill.observedAt).getTime();
  const reviewObservedAt = new Date(review.observedAt).getTime();
  if (
    Number.isNaN(reviewObservedAt) ||
    reviewObservedAt < billObservedAt ||
    reviewObservedAt - billObservedAt > MAX_OBSERVATION_AGE_MS ||
    reviewObservedAt > now.getTime() + 30_000 ||
    now.getTime() - reviewObservedAt > MAX_OBSERVATION_AGE_MS
  ) {
    throw new PolicyStopError("The payment review is not current.");
  }
  if (
    review.accountReference !== bill.accountReference ||
    review.amountCents !== bill.amountCents ||
    review.dueDate !== bill.dueDate
  ) {
    throw new PolicyStopError(
      "The payment review no longer matches the inspected bill.",
    );
  }
  if (review.paymentMethodLast4 !== bundle.paymentMethodLast4) {
    throw new PolicyStopError(
      "The review does not show the authorized payment method.",
    );
  }
  if (
    !Number.isSafeInteger(review.feeCents) ||
    review.feeCents < 0 ||
    review.feeCents >= bundle.feeLimitCentsExclusive
  ) {
    throw new PolicyStopError(
      "The convenience fee is not below the authorized fee ceiling.",
    );
  }
  if (review.totalCents !== review.amountCents + review.feeCents) {
    throw new PolicyStopError("The review total does not equal bill amount plus fee.");
  }
}
