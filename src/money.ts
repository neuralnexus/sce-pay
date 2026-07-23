import { SafetyStopError } from "./errors.js";

const MONEY_PATTERN = /\$?\s*([\d,]+)(?:\.(\d{2}))?/;

export function parseMoneyToCents(value: string): number {
  const match = MONEY_PATTERN.exec(value);
  if (match === null) {
    throw new SafetyStopError(`Could not parse a monetary amount from "${value}".`);
  }

  const dollars = Number.parseInt((match[1] ?? "").replaceAll(",", ""), 10);
  const cents = Number.parseInt(match[2] ?? "00", 10);
  const result = dollars * 100 + cents;

  if (!Number.isSafeInteger(result) || result < 0) {
    throw new SafetyStopError(`The parsed amount "${value}" is not safe to use.`);
  }

  return result;
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
