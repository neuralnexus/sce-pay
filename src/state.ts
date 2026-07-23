import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

import type { BillSnapshot, PaymentConfirmation, PaymentReview } from "./domain.js";
import type { AppPaths } from "./paths.js";

const runSchema = z.object({
  id: z.string(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  status: z.enum(["running", "succeeded", "skipped", "failed"]),
  dryRun: z.boolean(),
  message: z.string().nullable(),
});

const paymentIntentSchema = z.object({
  id: z.string(),
  fingerprint: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  accountReference: z.string(),
  amountCents: z.number().int().nonnegative(),
  feeCents: z.number().int().nonnegative(),
  totalCents: z.number().int().nonnegative(),
  dueDate: z.iso.date(),
  paymentMethodLast4: z.string().regex(/^\d{4}$/),
  status: z.enum(["submitting", "confirmed", "unknown", "cancelled"]),
  confirmationNumber: z.string().nullable(),
  paidAt: z.iso.datetime().nullable(),
  reconciliationNote: z.string().nullable(),
});

const stateSchema = z.object({
  version: z.literal(1),
  runs: z.array(runSchema),
  paymentIntents: z.array(paymentIntentSchema),
});

export type RunRecord = z.infer<typeof runSchema>;
export type PaymentIntent = z.infer<typeof paymentIntentSchema>;
export type AppState = z.infer<typeof stateSchema>;

const EMPTY_STATE: AppState = {
  version: 1,
  runs: [],
  paymentIntents: [],
};

const MAX_RUNS = 100;
const MAX_INTENTS = 120;

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

export class StateStore {
  readonly #paths: AppPaths;
  #state: AppState | null = null;

  constructor(paths: AppPaths) {
    this.#paths = paths;
  }

  async load(): Promise<AppState> {
    if (this.#state !== null) {
      return this.#state;
    }

    try {
      this.#state = stateSchema.parse(
        JSON.parse(await readFile(this.#paths.stateFile, "utf8")) as unknown,
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        this.#state = structuredClone(EMPTY_STATE);
      } else {
        throw error;
      }
    }

    return this.#state;
  }

  async beginRun(startedAt: string, dryRun: boolean): Promise<RunRecord> {
    const state = await this.load();
    const run: RunRecord = {
      id: randomUUID(),
      startedAt,
      finishedAt: null,
      status: "running",
      dryRun,
      message: null,
    };
    state.runs.push(run);
    state.runs = state.runs.slice(-MAX_RUNS);
    await this.#save();
    return run;
  }

  async finishRun(
    runId: string,
    status: Exclude<RunRecord["status"], "running">,
    message: string,
    finishedAt: string,
  ): Promise<void> {
    const state = await this.load();
    const run = state.runs.find((candidate) => candidate.id === runId);
    if (run !== undefined) {
      run.status = status;
      run.message = message;
      run.finishedAt = finishedAt;
      await this.#save();
    }
  }

  async findConfirmed(fingerprint: string): Promise<PaymentIntent | undefined> {
    const state = await this.load();
    return state.paymentIntents.find(
      (intent) => intent.fingerprint === fingerprint && intent.status === "confirmed",
    );
  }

  async findBlockingIntent(): Promise<PaymentIntent | undefined> {
    const state = await this.load();
    return state.paymentIntents.find(
      (intent) => intent.status === "submitting" || intent.status === "unknown",
    );
  }

  async createSubmittingIntent(
    fingerprint: string,
    bill: BillSnapshot,
    review: PaymentReview,
    now: string,
  ): Promise<PaymentIntent> {
    const state = await this.load();
    const intent: PaymentIntent = {
      id: randomUUID(),
      fingerprint,
      createdAt: now,
      updatedAt: now,
      accountReference: bill.accountReference,
      amountCents: review.amountCents,
      feeCents: review.feeCents,
      totalCents: review.totalCents,
      dueDate: bill.dueDate,
      paymentMethodLast4: review.paymentMethodLast4,
      status: "submitting",
      confirmationNumber: null,
      paidAt: null,
      reconciliationNote: null,
    };
    state.paymentIntents.push(intent);
    state.paymentIntents = state.paymentIntents.slice(-MAX_INTENTS);
    await this.#save();
    return intent;
  }

  async confirmIntent(
    intentId: string,
    confirmation: PaymentConfirmation,
    now: string,
  ): Promise<void> {
    const intent = await this.#requireIntent(intentId);
    intent.status = "confirmed";
    intent.confirmationNumber = confirmation.confirmationNumber;
    intent.paidAt = confirmation.paidAt;
    intent.updatedAt = now;
    await this.#save();
  }

  async markIntentUnknown(intentId: string, note: string, now: string): Promise<void> {
    const intent = await this.#requireIntent(intentId);
    intent.status = "unknown";
    intent.reconciliationNote = note;
    intent.updatedAt = now;
    await this.#save();
  }

  async reconcileIntent(
    intentId: string,
    result: "paid" | "not-paid",
    note: string,
    now: string,
    confirmationNumber?: string,
  ): Promise<PaymentIntent> {
    const intent = await this.#requireIntent(intentId);
    intent.status = result === "paid" ? "confirmed" : "cancelled";
    intent.confirmationNumber =
      result === "paid" ? (confirmationNumber ?? "manually-verified") : null;
    intent.paidAt = result === "paid" ? now : null;
    intent.reconciliationNote = note;
    intent.updatedAt = now;
    await this.#save();
    return intent;
  }

  async snapshot(): Promise<AppState> {
    return structuredClone(await this.load());
  }

  async #requireIntent(intentId: string): Promise<PaymentIntent> {
    const state = await this.load();
    const intent = state.paymentIntents.find((candidate) => candidate.id === intentId);
    if (intent === undefined) {
      throw new Error(`Payment intent ${intentId} was not found.`);
    }
    return intent;
  }

  async #save(): Promise<void> {
    const state = stateSchema.parse(await this.load());
    await writePrivateJson(this.#paths.stateFile, state);
  }
}
