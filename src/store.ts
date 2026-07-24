import { randomUUID } from "node:crypto";

import type {
  EncryptedBundle,
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
const DRY_RUN_VALIDITY_MS = 60 * 60 * 1000;
const INTENT_PREFIX = "intent:";
const FINGERPRINT_PREFIX = "fingerprint:";
const RUN_PREFIX = "run:";

interface ConfigurationRecord {
  configurationId: string;
  bundleId: string;
  configuredAt: string;
}

interface DryRunAttestation {
  configurationId: string;
  releaseId: string;
  validatedAt: string;
}

interface ArmRecord {
  configurationId: string;
  releaseId: string;
  armedAt: string;
}

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

  async renewLease(leaseId: string, now: Date): Promise<void> {
    await this.#storage.transaction(async (transaction) => {
      const current = await transaction.get<RunLease>("activeLease");
      if (
        current?.id !== leaseId ||
        new Date(current.expiresAt).getTime() <= now.getTime()
      ) {
        throw new ScePayError(
          "ALREADY_RUNNING",
          "The exclusive payment lease expired before submission.",
        );
      }
      transaction.put("activeLease", {
        id: leaseId,
        expiresAt: new Date(now.getTime() + LEASE_MS).toISOString(),
      } satisfies RunLease);
    });
  }

  async releaseLease(leaseId: string): Promise<void> {
    await this.#storage.transaction(async (transaction) => {
      const current = await transaction.get<RunLease>("activeLease");
      if (current?.id === leaseId) transaction.delete("activeLease");
    });
  }

  async configure(
    configurationId: string,
    bundleId: string,
    encryptedBundle: EncryptedBundle,
    now: Date,
  ): Promise<void> {
    await this.#storage.transaction(async (transaction) => {
      const blocking = await transaction.get<string>("blockingIntentId");
      if (blocking) {
        throw new ScePayError(
          "POLICY_STOP",
          "Resolve the uncertain payment before replacing configuration.",
        );
      }
      transaction.put("configuration", {
        configurationId,
        bundleId,
        configuredAt: now.toISOString(),
      } satisfies ConfigurationRecord);
      transaction.put("bundle", encryptedBundle);
      transaction.put("configured", true);
      transaction.put("nextCheckAt", now.toISOString());
      transaction.delete("armed");
      transaction.delete("arm");
      transaction.delete("dryRunAttestation");
    });
  }

  async updateBundleMetadata(
    configurationId: string,
    bundleId: string,
    encryptedBundle: EncryptedBundle,
  ): Promise<void> {
    await this.#storage.transaction(async (transaction) => {
      const configuration = await transaction.get<ConfigurationRecord>("configuration");
      if (configuration?.configurationId !== configurationId) {
        throw new ScePayError(
          "CONFIGURATION_REQUIRED",
          "The refreshed browser state no longer matches active configuration.",
        );
      }
      transaction.put("bundle", encryptedBundle);
      transaction.put("configuration", { ...configuration, bundleId });
    });
  }

  async recordDryRunValidation(
    configurationId: string,
    releaseId: string,
    now: Date,
  ): Promise<void> {
    await this.#storage.put("dryRunAttestation", {
      configurationId,
      releaseId,
      validatedAt: now.toISOString(),
    } satisfies DryRunAttestation);
  }

  async arm(configurationId: string, releaseId: string, now: Date): Promise<void> {
    await this.#storage.transaction(async (transaction) => {
      const [configuration, attestation] = await Promise.all([
        transaction.get<ConfigurationRecord>("configuration"),
        transaction.get<DryRunAttestation>("dryRunAttestation"),
      ]);
      const validatedAt = attestation
        ? new Date(attestation.validatedAt).getTime()
        : Number.NaN;
      if (
        configuration?.configurationId !== configurationId ||
        attestation?.configurationId !== configurationId ||
        attestation.releaseId !== releaseId ||
        Number.isNaN(validatedAt) ||
        now.getTime() - validatedAt > DRY_RUN_VALIDITY_MS ||
        validatedAt > now.getTime() + 30_000
      ) {
        throw new ScePayError(
          "CONFIGURATION_REQUIRED",
          "This exact Worker release and configuration need a recent cloud dry run.",
        );
      }
      transaction.put("arm", {
        configurationId,
        releaseId,
        armedAt: now.toISOString(),
      } satisfies ArmRecord);
      transaction.put("armed", true);
    });
  }

  async disarm(): Promise<void> {
    await this.#storage.delete(["arm", "armed"]);
  }

  async assertArmed(configurationId: string, releaseId: string): Promise<void> {
    const arm = await this.#storage.get<ArmRecord>("arm");
    if (arm?.configurationId !== configurationId || arm.releaseId !== releaseId) {
      throw new ScePayError(
        "CONFIGURATION_REQUIRED",
        "Automatic submission is disarmed for this Worker release.",
      );
    }
  }

  async deferredUntil(now: Date): Promise<string | undefined> {
    const nextCheckAt = await this.#storage.get<string>("nextCheckAt");
    if (!nextCheckAt) return undefined;
    const timestamp = new Date(nextCheckAt).getTime();
    return !Number.isNaN(timestamp) && timestamp > now.getTime()
      ? nextCheckAt
      : undefined;
  }

  async findBlockingIntent(): Promise<PaymentIntent | undefined> {
    const intentId = await this.#storage.get<string>("blockingIntentId");
    return intentId
      ? this.#storage.get<PaymentIntent>(`${INTENT_PREFIX}${intentId}`)
      : undefined;
  }

  async isFingerprintConfirmed(fingerprint: string): Promise<boolean> {
    return (
      (await this.#storage.get<boolean>(`${FINGERPRINT_PREFIX}${fingerprint}`)) === true
    );
  }

  async beginIntent(
    leaseId: string,
    fingerprint: string,
    review: PaymentReview,
    now: Date,
  ): Promise<PaymentIntent> {
    return this.#storage.transaction(async (transaction) => {
      const lease = await transaction.get<RunLease>("activeLease");
      const blocking = await transaction.get<string>("blockingIntentId");
      const confirmed = await transaction.get<boolean>(
        `${FINGERPRINT_PREFIX}${fingerprint}`,
      );
      if (
        lease?.id !== leaseId ||
        new Date(lease.expiresAt).getTime() <= now.getTime()
      ) {
        throw new ScePayError(
          "ALREADY_RUNNING",
          "The exclusive payment lease is no longer valid.",
        );
      }
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
      if (intent.status === "confirmed") {
        if (intent.confirmationNumber === confirmation.confirmationNumber) return;
        throw new Error("payment intent confirmation conflict");
      }
      if (intent.status !== "submitting") {
        throw new Error("payment intent is no longer submitting");
      }
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
      if (intent?.status !== "submitting") return;
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

  async status(releaseId: string): Promise<PublicStatus> {
    const [
      configured,
      configuration,
      arm,
      dryRunAttestation,
      nextCheckAt,
      activeLease,
      blockingIntent,
      intentMap,
      lastRun,
      runMap,
    ] = await Promise.all([
      this.#storage.get<boolean>("configured"),
      this.#storage.get<ConfigurationRecord>("configuration"),
      this.#storage.get<ArmRecord>("arm"),
      this.#storage.get<DryRunAttestation>("dryRunAttestation"),
      this.#storage.get<string>("nextCheckAt"),
      this.#storage.get<RunLease>("activeLease"),
      this.findBlockingIntent(),
      this.#storage.list<PaymentIntent>({ prefix: INTENT_PREFIX }),
      this.#storage.get<RunRecord>("lastRun"),
      this.#storage.list<RunRecord>({ prefix: RUN_PREFIX }),
    ]);
    const now = Date.now();
    const isArmed =
      configuration !== undefined &&
      arm?.configurationId === configuration.configurationId &&
      arm.releaseId === releaseId;
    const confirmedPayments = [...intentMap.values()]
      .filter((intent) => intent.status === "confirmed")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 12);
    const recentRuns = [...runMap.values()]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 20);
    let armBlockReason: string | undefined;
    if (!configuration) armBlockReason = "onboarding-required";
    else if (!arm) armBlockReason = "not-armed";
    else if (arm.configurationId !== configuration.configurationId) {
      armBlockReason = "configuration-changed";
    } else if (arm.releaseId !== releaseId) {
      armBlockReason = "release-changed";
    }
    return {
      configured: configured === true,
      armed: isArmed,
      releaseId,
      ...(configuration
        ? {
            configurationId: configuration.configurationId,
            configuredAt: configuration.configuredAt,
          }
        : {}),
      ...(arm ? { armedAt: arm.armedAt } : {}),
      ...(dryRunAttestation
        ? { dryRunValidatedAt: dryRunAttestation.validatedAt }
        : {}),
      ...(nextCheckAt ? { nextCheckAt } : {}),
      ...(armBlockReason ? { armBlockReason } : {}),
      activeRun:
        activeLease !== undefined && new Date(activeLease.expiresAt).getTime() > now,
      ...(blockingIntent ? { blockingIntent } : {}),
      ...(lastRun ? { lastRun } : {}),
      confirmedPayments,
      recentRuns,
    };
  }

  async recordRun(record: RunRecord, nextCheckAt?: string): Promise<void> {
    await this.#storage.put({
      lastRun: record,
      [`${RUN_PREFIX}${record.at}:${record.id}`]: record,
      ...(nextCheckAt ? { nextCheckAt } : {}),
    });
    const runs = await this.#storage.list<RunRecord>({ prefix: RUN_PREFIX });
    const stale = [...runs.entries()]
      .sort((left, right) => right[1].at.localeCompare(left[1].at))
      .slice(100)
      .map(([key]) => key);
    if (stale.length > 0) await this.#storage.delete(stale);
  }
}
