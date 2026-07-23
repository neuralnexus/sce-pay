import { createHash } from "node:crypto";

import { PolicyStopError } from "./errors.js";
import { parseMoneyToCents } from "./money.js";

export function labeledMoney(text: string, labels: readonly string[]): number {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const after = text.match(
      new RegExp(`${escaped}\\s*(?:amount)?\\s*:?\\s*(\\$\\s*[\\d,]+(?:\\.\\d{1,2})?)`, "i"),
    );
    if (after?.[1]) return parseMoneyToCents(after[1]);
  }
  throw new PolicyStopError(`A required labeled amount (${labels.join(" or ")}) was not found.`);
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
  const numeric = text.match(
    /(?:due(?:\s+date|\s+by)?|payment\s+due)\s*:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i,
  );
  if (numeric?.[1] && numeric[2] && numeric[3]) {
    return isoDate(
      Number.parseInt(numeric[3], 10),
      Number.parseInt(numeric[1], 10),
      Number.parseInt(numeric[2], 10),
    );
  }

  const named = text.match(
    /(?:due(?:\s+date|\s+by)?|payment\s+due)\s*:?\s*([A-Z][a-z]+)\s+(\d{1,2}),?\s+(\d{4})/i,
  );
  if (named?.[1] && named[2] && named[3]) {
    const parsed = new Date(`${named[1]} ${named[2]}, ${named[3]} 12:00:00 UTC`);
    if (!Number.isNaN(parsed.getTime())) {
      return isoDate(
        parsed.getUTCFullYear(),
        parsed.getUTCMonth() + 1,
        parsed.getUTCDate(),
      );
    }
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

export function safeAccountReference(accountNumber: string): string {
  return `sce-${createHash("sha256")
    .update(accountNumber.replace(/\D/g, ""))
    .digest("hex")
    .slice(0, 12)}`;
}
