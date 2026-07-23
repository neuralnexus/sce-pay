import { PolicyStopError } from "./errors.js";

export function parseMoneyToCents(text: string): number {
  const match = text.match(/(-?)\$?\s*([\d,]+)(?:\.(\d{1,2}))?/);
  if (!match?.[2]) {
    throw new PolicyStopError("A required monetary value could not be read.");
  }
  if (match[1] === "-") {
    throw new PolicyStopError("A required monetary value was negative.");
  }
  const dollars = Number.parseInt(match[2].replaceAll(",", ""), 10);
  const cents = Number.parseInt((match[3] ?? "").padEnd(2, "0"), 10);
  const amount = dollars * 100 + cents;
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new PolicyStopError("A monetary value was invalid.");
  }
  return amount;
}

export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new TypeError("cents must be a non-negative safe integer");
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}
