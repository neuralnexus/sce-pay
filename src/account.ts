import type { EncryptedBundle, GuestBundle, RunRecord } from "./domain.js";
import { DurableObject } from "cloudflare:workers";
import { validateGuestBundle } from "./bundle.js";
import { decryptBundle } from "./crypto.js";
import { safeError, ScePayError } from "./errors.js";
import { CloudflareGuestPortal } from "./portal/guestPortal.js";
import { DurablePaymentStore } from "./store.js";
import { runPaymentWorkflow } from "./workflow.js";

export interface Env {
  BROWSER: Fetcher;
  PAYMENT_ACCOUNT: DurableObjectNamespace<PaymentAccount>;
  BUNDLE_KEY?: string;
  ADMIN_TOKEN?: string;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function notify(bundle: GuestBundle, body: unknown): Promise<void> {
  if (!bundle.notificationWebhookUrl) return;
  await fetch(bundle.notificationWebhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => undefined);
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

  async #loadBundle(): Promise<GuestBundle> {
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
    return validateGuestBundle(
      await decryptBundle(encrypted, this.#env.BUNDLE_KEY),
    );
  }

  async #run(request: Request): Promise<Response> {
    const payload = (await request.json().catch(() => ({}))) as {
      source?: "cron" | "manual";
      dryRun?: boolean;
    };
    const source = payload.source === "cron" ? "cron" : "manual";
    const dryRun = payload.dryRun === true;
    const armed = (await this.#state.storage.get<boolean>("armed")) === true;
    if (!dryRun && !armed) {
      return json(
        {
          ok: false,
          error: {
            code: "CONFIGURATION_REQUIRED",
            message: "Automatic submission is disarmed.",
            attentionRequired: true,
          },
        },
        409,
      );
    }

    let bundle: GuestBundle | undefined;
    try {
      bundle = await this.#loadBundle();
      const result = await runPaymentWorkflow({
        bundle,
        portal: new CloudflareGuestPortal(this.#env.BROWSER, bundle),
        store: this.#store,
        dryRun,
      });
      const record: RunRecord = {
        at: new Date().toISOString(),
        source,
        dryRun,
        outcome: result.status,
        message: result.message,
      };
      await this.#store.recordRun(record);
      await notify(bundle, {
        product: "sce-pay",
        ok: true,
        outcome: result.status,
        message: result.message,
      });
      return json({ ok: true, result });
    } catch (error) {
      const safe = safeError(error);
      const record: RunRecord = {
        at: new Date().toISOString(),
        source,
        dryRun,
        outcome: safe.code,
        message: safe.message,
      };
      await this.#store.recordRun(record);
      if (bundle) {
        await notify(bundle, {
          product: "sce-pay",
          ok: false,
          error: safe,
        });
      }
      return json({ ok: false, error: safe }, safe.attentionRequired ? 409 : 503);
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status") {
      return json(await this.#store.status());
    }
    if (request.method === "POST" && url.pathname === "/setup") {
      const encrypted = (await request.json()) as EncryptedBundle;
      if (
        encrypted.version !== 1 ||
        encrypted.algorithm !== "AES-GCM" ||
        typeof encrypted.iv !== "string" ||
        typeof encrypted.ciphertext !== "string" ||
        encrypted.ciphertext.length > 500_000
      ) {
        return json({ ok: false, error: "invalid encrypted setup bundle" }, 400);
      }
      await this.#state.storage.put({
        bundle: encrypted,
        configured: true,
        armed: false,
      });
      return json({ ok: true, armed: false });
    }
    if (request.method === "POST" && url.pathname === "/run") {
      return this.#run(request);
    }
    if (request.method === "POST" && url.pathname === "/arm") {
      await this.#loadBundle();
      await this.#state.storage.put("armed", true);
      return json({ ok: true, armed: true });
    }
    if (request.method === "POST" && url.pathname === "/disarm") {
      await this.#state.storage.put("armed", false);
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
        !input.note ||
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
