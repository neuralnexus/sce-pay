import { DurableObject } from "cloudflare:workers";
import { randomUUID } from "node:crypto";
import { mergeBrowserState, validateGuestBundle } from "./bundle.js";
import { decryptBundle, encryptBundle } from "./crypto.js";
import type { EncryptedBundle, GuestBundle, RunRecord } from "./domain.js";
import { ScePayError, safeError } from "./errors.js";
import { sendNotification } from "./notifications.js";
import { CloudflareGuestPortal } from "./portal/guestPortal.js";
import { nextCheckAfterOutcome, nextCheckAfterSafeFailure } from "./schedule.js";
import { DurablePaymentStore } from "./store.js";
import { runPaymentWorkflow } from "./workflow.js";

export interface Env {
  BROWSER: Fetcher;
  PAYMENT_ACCOUNT: DurableObjectNamespace<PaymentAccount>;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  BUNDLE_KEY?: string;
  ADMIN_TOKEN?: string;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export class PaymentAccount extends DurableObject<Env> {
  readonly #state: DurableObjectState;
  readonly #env: Env;
  readonly #store: DurablePaymentStore;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.#state = state;
    this.#env = env;
    this.#store = new DurablePaymentStore(state.storage);
  }

  async #loadBundle(): Promise<{
    bundle: GuestBundle;
    encrypted: EncryptedBundle;
  }> {
    if (!this.#env.BUNDLE_KEY) {
      throw new ScePayError(
        "CONFIGURATION_REQUIRED",
        "The Worker encryption key is not configured.",
      );
    }
    const encrypted = await this.#state.storage.get<EncryptedBundle>("bundle");
    if (!encrypted) {
      throw new ScePayError(
        "CONFIGURATION_REQUIRED",
        "Run the onboarding wizard before checking a bill.",
      );
    }
    return {
      bundle: validateGuestBundle(await decryptBundle(encrypted, this.#env.BUNDLE_KEY)),
      encrypted,
    };
  }

  async #run(request: Request): Promise<Response> {
    const payload = (await request.json().catch(() => ({}))) as {
      source?: "cron" | "manual";
      dryRun?: boolean;
    };
    const source = payload.source === "cron" ? "cron" : "manual";
    const dryRun = payload.dryRun === true;
    const releaseId = this.#env.CF_VERSION_METADATA.id;
    const now = new Date();

    let bundle: GuestBundle | undefined;
    try {
      ({ bundle } = await this.#loadBundle());
      if (!dryRun) {
        await this.#store.assertArmed(bundle.configurationId, releaseId);
      }
      if (source === "cron" && !dryRun) {
        const nextCheckAt = await this.#store.deferredUntil(now);
        if (nextCheckAt) {
          const result = {
            status: "deferred" as const,
            nextCheckAt,
            message: "The next browser check is not due yet.",
          };
          const record: RunRecord = {
            id: randomUUID(),
            at: now.toISOString(),
            source,
            dryRun,
            outcome: result.status,
            message: result.message,
            releaseId,
          };
          await this.#store.recordRun(record);
          return json({ ok: true, result });
        }
      }
      const execution = await runPaymentWorkflow({
        bundle,
        portal: new CloudflareGuestPortal(this.#env.BROWSER, bundle),
        store: this.#store,
        dryRun,
        now,
      });
      const result = execution.outcome;
      if (execution.refreshedBrowserState && this.#env.BUNDLE_KEY) {
        try {
          bundle = mergeBrowserState(bundle, execution.refreshedBrowserState);
          const refreshed = await encryptBundle(bundle, this.#env.BUNDLE_KEY);
          await this.#store.updateBundleMetadata(
            bundle.configurationId,
            refreshed.bundleId,
            refreshed,
          );
        } catch {
          console.error(
            JSON.stringify({
              event: "browser-state-refresh-failed",
              releaseId,
              outcome: result.status,
            }),
          );
        }
      }
      if (result.status === "dry-run") {
        await this.#store.recordDryRunValidation(
          bundle.configurationId,
          releaseId,
          new Date(),
        );
      }
      const nextCheckAt =
        result.status === "dry-run"
          ? undefined
          : nextCheckAfterOutcome(result, bundle, new Date());
      const record: RunRecord = {
        id: randomUUID(),
        at: new Date().toISOString(),
        source,
        dryRun,
        outcome: result.status,
        message: result.message,
        releaseId,
      };
      await this.#store.recordRun(record, nextCheckAt);
      if (result.status === "paid") {
        await sendNotification(bundle, {
          kind: "payment-confirmed",
          outcome: result.status,
          message: result.message,
        });
      }
      return json({ ok: true, result });
    } catch (error) {
      const safe = safeError(error);
      const record: RunRecord = {
        id: randomUUID(),
        at: new Date().toISOString(),
        source,
        dryRun,
        outcome: safe.code,
        message: safe.message,
        releaseId,
      };
      await this.#store.recordRun(
        record,
        source === "cron" && safe.code !== "PAYMENT_UNCERTAIN"
          ? nextCheckAfterSafeFailure(new Date())
          : undefined,
      );
      if (bundle) {
        await sendNotification(bundle, {
          kind: "attention-required",
          outcome: safe.code,
          message: safe.message,
        });
      }
      return json({ ok: false, error: safe }, safe.attentionRequired ? 409 : 503);
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status") {
      return json(await this.#store.status(this.#env.CF_VERSION_METADATA.id));
    }
    if (request.method === "POST" && url.pathname === "/setup") {
      if (!this.#env.BUNDLE_KEY) {
        return json({ ok: false, error: "encryption key not configured" }, 409);
      }
      const encrypted = (await request.json().catch(() => undefined)) as
        | EncryptedBundle
        | undefined;
      if (
        encrypted?.version !== 2 ||
        encrypted.algorithm !== "AES-256-GCM" ||
        typeof encrypted.bundleId !== "string" ||
        typeof encrypted.createdAt !== "string" ||
        typeof encrypted.iv !== "string" ||
        typeof encrypted.ciphertext !== "string" ||
        encrypted.ciphertext.length > 512_000
      ) {
        return json({ ok: false, error: "invalid encrypted setup bundle" }, 400);
      }
      let bundle: GuestBundle;
      try {
        bundle = validateGuestBundle(
          await decryptBundle(encrypted, this.#env.BUNDLE_KEY),
        );
      } catch {
        return json({ ok: false, error: "invalid encrypted setup bundle" }, 400);
      }
      await this.#store.configure(
        bundle.configurationId,
        encrypted.bundleId,
        encrypted,
        new Date(),
      );
      return json({ ok: true, armed: false });
    }
    if (request.method === "POST" && url.pathname === "/run") {
      return this.#run(request);
    }
    if (request.method === "POST" && url.pathname === "/arm") {
      const { bundle } = await this.#loadBundle();
      await this.#store.arm(
        bundle.configurationId,
        this.#env.CF_VERSION_METADATA.id,
        new Date(),
      );
      return json({ ok: true, armed: true });
    }
    if (request.method === "POST" && url.pathname === "/disarm") {
      await this.#store.disarm();
      return json({ ok: true, armed: false });
    }
    if (request.method === "POST" && url.pathname === "/reconcile") {
      const input = (await request.json()) as {
        intentId?: string;
        result?: "paid" | "not-paid";
        note?: string;
        confirmationNumber?: string;
      };
      if (
        !input.intentId ||
        !/^[0-9a-f-]{36}$/i.test(input.intentId) ||
        !input.note ||
        input.note.length > 500 ||
        (input.confirmationNumber?.length ?? 0) > 128 ||
        !["paid", "not-paid"].includes(input.result ?? "")
      ) {
        return json({ ok: false, error: "invalid reconciliation" }, 400);
      }
      const reconciled = await this.#store.reconcile(
        input.intentId,
        input.result as "paid" | "not-paid",
        input.note,
        input.confirmationNumber,
      );
      return json({ ok: true, intent: reconciled });
    }
    return json({ ok: false, error: "not found" }, 404);
  }
}
