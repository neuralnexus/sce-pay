import type { GuestBundle, WorkflowOutcome } from "./domain.js";

const DAY_MS = 86_400_000;

function plusDays(now: Date, days: number): string {
  return new Date(now.getTime() + days * DAY_MS).toISOString();
}

export function nextCheckAfterOutcome(
  outcome: Exclude<WorkflowOutcome, { status: "deferred" | "dry-run" }>,
  bundle: GuestBundle,
  now: Date,
): string {
  switch (outcome.status) {
    case "paid":
      return plusDays(now, 14);
    case "already-paid":
    case "no-balance":
      return plusDays(now, 7);
    case "not-due": {
      const due = new Date(`${outcome.dueDate}T17:00:00.000Z`);
      const target = new Date(due.getTime() - bundle.payWhenDueWithinDays * DAY_MS);
      return target.getTime() > now.getTime() ? target.toISOString() : plusDays(now, 1);
    }
  }
}

export function nextCheckAfterSafeFailure(now: Date): string {
  return plusDays(now, 1);
}
