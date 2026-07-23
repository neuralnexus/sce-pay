import { randomUUID } from "node:crypto";

import type {
  PaymentConfirmation,
  PaymentIntent,
  PaymentReview,
  PaymentStore,
  PublicStatus,
  RunLease,
  RunRecord,
} from "./domain.js";
import { ScePayError } from "./errors.js";

const LEASE_MS = 15 * 60 * 1000;
const INTENT_PREFIX = "intent:";
const FINGERPRINT_PREFIX = "fingerprint:";

export class DurablePaymentStore implements PaymentStore {
  readonly #storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }

  async acquireLease(now: Date): Promise<RunLease> {
    return this.#storage.transaction(async (transaction) => {
      const current = await transaction.get<RunLease>("activeLease");
      if (current && new Date(current.expiresAt).getTime() > now.getTime()) {
        throw new ScePayError(
          "ALREADY_RUNNING",
          "Another payment check is already active.",
          { attentionRequired: false },
        );
      }
      const lease: RunLease = {
        id: randomUUID(),
        expiresAt: new Date(now.getTime() + LEASE_MS).toISOString(),
      };
      transaction.put("activeLease", lease);
      return lease;
    });
  }

  async releaseLease(leaseId: string): Promise<void> {
    await this.#storage.transaction(async (transaction) => {
      const current = await transaction.get<RunLease>("activeLease");
      if (current?.id === leaseId) transaction.delete("activeLease");
    });
  }

  async findBlockingIntent(): Promise<PaymentIntent | undefined> {
    const intentId = await this.#storage.get<string>("blockingIntentId");
    return intentId
      ? this.#storage.get<PaymentIntent>(`${INTENT_PREFIX}${intentId}`)
      : undefined;
  }

  async isFingerprintConfirmed(fingerprint: string): Promise<boolean> {
    return (await this.#storage.get<boolean>(`${FINGERPRINT_PREFIX}${fingerprint}`)) === true;
  }

  async beginIntent(
    fingerprint: string,
    review: PaymentReview,
    now: Date,
  ): Promise<PaymentIntent> {
    return this.#storage.transaction(async (transaction) => {
      const blocking = await transaction.get<string>("blockingIntentId");
      const confirmed = await transaction.get<boolean>(
        `${FINGERPRINT_PREFIX}${fingerprint}`,
      );
      if (blocking || confirmed) {
        throw new ScePayError(
          "POLICY_STOP",
          "The bill became duplicate-protected before submission.",
        );
      }
      const intent: PaymentIntent = {
        id: randomUUID(),
        fingerprint,
        status: "submitting",
        amountCents: review.amountCents,
        feeCents: review.feeCents,
        totalCents: review.totalCents,
        dueDate: review.dueDate,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      transaction.put(`${INTENT_PREFIX}${intent.id}`, intent);
      transaction.put("blockingIntentId", intent.id);
      return intent;
    });
  }

  async confirmIntent(
    intentId: string,
    confirmation: PaymentConfirmation,
    now: Date,
  ): Promise<void> {
    await this.#storage.transaction(async (transaction) => {
      const key = `${INTENT_PREFIX}${intentId}`;
      const intent = await transaction.get<PaymentIntent>(key);
      if (!intent) throw new Error("payment intent missing");
      const confirmed: PaymentIntent = {
        ...intent,
        status: "confirmed",
        updatedAt: now.toISOString(),
        confirmationNumber: confirmation.confirmationNumber,
      };
      transaction.put(key, confirmed);
      transaction.put(`${FINGERPRINT_PREFIX}${intent.fingerprint}`, true);
      transaction.delete("blockingIntentId");
    });
  }

  async markIntentUnknown(intentId: string, now: Date): Promise<void> {
    await this.#storage.transaction(async (transaction) => {
      const key = `${INTENT_PREFIX}${intentId}`;
      const intent = await transaction.get<PaymentIntent>(key);
      if (!intent) return;
      transaction.put(key, {
        ...intent,
        status: "unknown",
        updatedAt: now.toISOString(),
      } satisfies PaymentIntent);
      transaction.put("blockingIntentId", intent.id);
    });
  }

  async reconcile(
    intentId: string,
    result: "paid" | "not-paid",
    note: string,
    confirmationNumber?: string,
  ): Promise<PaymentIntent> {
    return this.#storage.transaction(async (transaction) => {
      const key = `${INTENT_PREFIX}${intentId}`;
      const intent = await transaction.get<PaymentIntent>(key);
      if (!intent || !["submitting", "unknown"].includes(intent.status)) {
        throw new ScePayError(
          "POLICY_STOP",
          "The requested unresolved payment intent was not found.",
        );
      }
      const now = new Date().toISOString();
      const reconciled: PaymentIntent =
        result === "paid"
          ? {
              ...intent,
              status: "confirmed",
              updatedAt: now,
              confirmationNumber: confirmationNumber ?? "MANUALLY-VERIFIED",
              reconciliationNote: note,
            }
          : {
              ...intent,
              status: "reconciled-not-paid",
              updatedAt: now,
              reconciliationNote: note,
            };
      transaction.put(key, reconciled);
      if (result === "paid") {
        transaction.put(`${FINGERPRINT_PREFIX}${intent.fingerprint}`, true);
      }
      const blocking = await transaction.get<string>("blockingIntentId");
      if (blocking === intentId) transaction.delete("blockingIntentId");
      return reconciled;
    });
  }

  async status(): Promise<PublicStatus> {
    const [configured, armed, activeLease, blockingIntent, intentMap, lastRun] =
      await Promise.all([
        this.#storage.get<boolean>("configured"),
        this.#storage.get<boolean>("armed"),
        this.#storage.get<RunLease>("activeLease"),
        this.findBlockingIntent(),
        this.#storage.list<PaymentIntent>({ prefix: INTENT_PREFIX }),
        this.#storage.get<RunRecord>("lastRun"),
      ]);
    const now = Date.now();
    const confirmedPayments = [...intentMap.values()]
      .filter((intent) => intent.status === "confirmed")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 12);
    return {
      configured: configured === true,
      armed: armed === true,
      activeRun:
        activeLease !== undefined &&
        new Date(activeLease.expiresAt).getTime() > now,
      ...(blockingIntent ? { blockingIntent } : {}),
      ...(lastRun ? { lastRun } : {}),
      confirmedPayments,
    };
  }

  async recordRun(record: RunRecord): Promise<void> {
    await this.#storage.put("lastRun", record);
  }
}
