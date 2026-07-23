import { type Env, PaymentAccount } from "./account.js";
import { authorized, readBody } from "./http.js";

export { PaymentAccount };

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "cross-origin-resource-policy": "same-origin",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

function accountStub(env: Env): DurableObjectStub<PaymentAccount> {
  const id = env.PAYMENT_ACCOUNT.idFromName("primary");
  return env.PAYMENT_ACCOUNT.get(id);
}

async function runScheduled(env: Env): Promise<void> {
  try {
    const response = await accountStub(env).fetch("https://account/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "cron", dryRun: false }),
    });
    const body = (await response.json()) as {
      result?: { status?: string };
      error?: { code?: string };
    };
    console.log(
      JSON.stringify({
        event: "scheduled-run",
        releaseId: env.CF_VERSION_METADATA.id,
        httpStatus: response.status,
        outcome: body.result?.status ?? body.error?.code ?? "unknown",
      }),
    );
  } catch {
    console.error(
      JSON.stringify({
        event: "scheduled-run",
        releaseId: env.CF_VERSION_METADATA.id,
        outcome: "internal-dispatch-failure",
      }),
    );
  }
}

const ROUTES = new Map<
  string,
  { method: "GET" | "POST"; target: string; maxBodyBytes: number }
>([
  ["/status", { method: "GET", target: "/status", maxBodyBytes: 0 }],
  ["/ready", { method: "GET", target: "/status", maxBodyBytes: 0 }],
  ["/setup", { method: "POST", target: "/setup", maxBodyBytes: 520_000 }],
  ["/run", { method: "POST", target: "/run", maxBodyBytes: 2_048 }],
  ["/arm", { method: "POST", target: "/arm", maxBodyBytes: 2_048 }],
  ["/disarm", { method: "POST", target: "/disarm", maxBodyBytes: 2_048 }],
  ["/reconcile", { method: "POST", target: "/reconcile", maxBodyBytes: 4_096 }],
]);

function harden(response: Response): Response {
  const hardened = new Response(response.body, response);
  hardened.headers.set("cache-control", "no-store");
  hardened.headers.set(
    "content-security-policy",
    "default-src 'none'; frame-ancestors 'none'",
  );
  hardened.headers.set("cross-origin-resource-policy", "same-origin");
  hardened.headers.set("referrer-policy", "no-referrer");
  hardened.headers.set("x-content-type-options", "nosniff");
  hardened.headers.set("x-frame-options", "DENY");
  return hardened;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/health")
    ) {
      return json({
        product: "sce-pay",
        runtime: "cloudflare-workers",
        releaseId: env.CF_VERSION_METADATA.id,
        status: "alive",
      });
    }
    if (!url.pathname.startsWith("/api/")) {
      return json({ error: "not found" }, 404);
    }
    if (!(await authorized(request, env))) {
      return json({ error: "unauthorized" }, 401);
    }

    const route = url.pathname.slice("/api".length);
    const definition = ROUTES.get(route);
    if (!definition) return json({ error: "not found" }, 404);
    if (request.method !== definition.method) {
      return json({ error: "method not allowed" }, 405);
    }
    try {
      const body = await readBody(request, definition.maxBodyBytes);
      const response = await accountStub(env).fetch(
        `https://account${definition.target}`,
        {
          method: definition.method,
          headers: { "content-type": "application/json" },
          ...(body.byteLength > 0 ? { body } : {}),
        },
      );
      if (route === "/ready") {
        const status = (await response.clone().json()) as {
          configured?: boolean;
          armed?: boolean;
          blockingIntent?: unknown;
        };
        if (
          status.configured !== true ||
          status.armed !== true ||
          status.blockingIntent
        ) {
          return json({ ready: false, status }, 503);
        }
        return json({ ready: true, status });
      }
      return harden(response);
    } catch (error) {
      if (error instanceof Response) {
        return json({ error: await error.text() }, error.status);
      }
      return json({ error: "invalid request" }, 400);
    }
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    context: ExecutionContext,
  ): Promise<void> {
    controller.noRetry();
    context.waitUntil(runScheduled(env));
  },
} satisfies ExportedHandler<Env>;
