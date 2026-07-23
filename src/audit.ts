import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { AppPaths } from "./paths.js";

export type AuditEvent = {
  at: string;
  event: string;
  runId?: string;
  intentId?: string;
  status?: string;
  amountCents?: number;
  feeCents?: number;
  totalCents?: number;
  dueDate?: string;
  detail?: string;
};

function redact(value: string): string {
  return value
    .replaceAll(/\b\d{7,}\b/g, "[redacted-number]")
    .replaceAll(
      /(?:password|passcode|card number|security code)\s*[:=]\s*\S+/gi,
      "[redacted-secret]",
    );
}

export class AuditLog {
  readonly #paths: AppPaths;

  constructor(paths: AppPaths) {
    this.#paths = paths;
  }

  async append(event: AuditEvent): Promise<void> {
    await mkdir(dirname(this.#paths.auditFile), { recursive: true, mode: 0o700 });
    const sanitized = Object.fromEntries(
      Object.entries(event).map(([key, value]) => [
        key,
        typeof value === "string" ? redact(value) : value,
      ]),
    );
    await appendFile(this.#paths.auditFile, `${JSON.stringify(sanitized)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}
