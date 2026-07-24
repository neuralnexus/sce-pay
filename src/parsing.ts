import { createHash } from "node:crypto";

import { PolicyStopError } from "./errors.js";
import { parseMoneyToCents } from "./money.js";

export function labeledMoney(text: string, labels: readonly string[]): number {
  const matches = new Set<number>();
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `${escaped}\\s*(?:amount)?\\s*:?\\s*(\\$\\s*[\\d,]+(?:\\.\\d{1,2})?)`,
      "gi",
    );
    for (const match of text.matchAll(pattern)) {
      if (match[1]) matches.add(parseMoneyToCents(match[1]));
    }
  }
  if (matches.size === 1) {
    const [value] = matches;
    if (value !== undefined) return value;
  }
  if (matches.size > 1) {
    throw new PolicyStopError(
      `Conflicting values were shown for ${labels.join(" or ")}.`,
    );
  }
  throw new PolicyStopError(
    `A required labeled amount (${labels.join(" or ")}) was not found.`,
  );
}

function isoDate(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new PolicyStopError("The SCE due date was invalid.");
  }
  return `${year.toString().padStart(4, "0")}-${month
    .toString()
    .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

export function extractDueDate(text: string): string {
  const dates = new Set<string>();
  const numericPattern =
    /(?:due(?:\s+date|\s+by)?|payment\s+due)\s*:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/gi;
  for (const numeric of text.matchAll(numericPattern)) {
    if (numeric[1] && numeric[2] && numeric[3]) {
      dates.add(
        isoDate(
          Number.parseInt(numeric[3], 10),
          Number.parseInt(numeric[1], 10),
          Number.parseInt(numeric[2], 10),
        ),
      );
    }
  }

  const namedPattern =
    /(?:due(?:\s+date|\s+by)?|payment\s+due)\s*:?\s*([A-Z][a-z]+)\s+(\d{1,2}),?\s+(\d{4})/gi;
  for (const named of text.matchAll(namedPattern)) {
    if (named[1] && named[2] && named[3]) {
      const parsed = new Date(`${named[1]} ${named[2]}, ${named[3]} 12:00:00 UTC`);
      if (!Number.isNaN(parsed.getTime())) {
        dates.add(
          isoDate(
            parsed.getUTCFullYear(),
            parsed.getUTCMonth() + 1,
            parsed.getUTCDate(),
          ),
        );
      }
    }
  }
  if (dates.size === 1) {
    const [date] = dates;
    if (date) return date;
  }
  if (dates.size > 1) {
    throw new PolicyStopError("Conflicting SCE due dates were visible.");
  }
  throw new PolicyStopError("The SCE due date could not be read.");
}

export function extractConfirmation(text: string): string {
  const match = text.match(
    /(?:confirmation|reference|receipt)(?:\s+(?:number|no\.?|#))?\s*:?\s*([A-Z0-9][A-Z0-9-]{3,})/i,
  );
  if (!match?.[1]) {
    throw new PolicyStopError("A payment confirmation number was not visible.");
  }
  return match[1];
}

export function extractDisplayedCardLast4(text: string): string {
  const matches = new Set<string>();
  const patterns = [
    /(?:card|credit card|debit card|payment method|visa|mastercard|amex|american express|discover)\s*(?:ending(?:\s+in)?|ends\s+in)\s*[:#-]?\s*(\d{4})\b/gi,
    /(?:\*{2,}|x{2,}|[•·]{2,})\s*(\d{4})\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) matches.add(match[1]);
    }
  }
  if (matches.size !== 1) {
    throw new PolicyStopError(
      matches.size === 0
        ? "The reviewed payment method ending digits were not visible."
        : "More than one payment method ending was visible on review.",
    );
  }
  const [last4] = matches;
  if (!last4) throw new PolicyStopError("The payment method could not be verified.");
  return last4;
}

export function safeAccountReference(accountNumber: string): string {
  return `sce-${createHash("sha256")
    .update(accountNumber.replace(/\D/g, ""))
    .digest("hex")
    .slice(0, 12)}`;
}
