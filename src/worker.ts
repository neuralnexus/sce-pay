import { PaymentAccount, type Env } from "./account.js";

export { PaymentAccount };

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

async function authorized(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_TOKEN) return false;
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  return constantTimeEqual(header.slice(7), env.ADMIN_TOKEN);
}

function accountStub(env: Env): DurableObjectStub<PaymentAccount> {
  const id = env.PAYMENT_ACCOUNT.idFromName("primary");
  return env.PAYMENT_ACCOUNT.get(id);
}

async function runScheduled(env: Env): Promise<void> {
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
      httpStatus: response.status,
      outcome: body.result?.status ?? body.error?.code ?? "unknown",
    }),
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({
        product: "sce-pay",
        runtime: "cloudflare-workers",
        schedule: "daily",
        healthy: true,
      });
    }
    if (!url.pathname.startsWith("/api/")) {
      return json({ error: "not found" }, 404);
    }
    if (!(await authorized(request, env))) {
      return json({ error: "unauthorized" }, 401);
    }

    const route = url.pathname.slice("/api".length);
    const allowedRoutes = new Set([
      "/setup",
      "/status",
      "/run",
      "/arm",
      "/disarm",
      "/reconcile",
    ]);
    if (!allowedRoutes.has(route)) return json({ error: "not found" }, 404);
    const body = request.method === "GET" ? undefined : await request.arrayBuffer();
    return accountStub(env).fetch(`https://account${route}`, {
      method: request.method,
      headers: { "content-type": request.headers.get("content-type") ?? "application/json" },
      ...(body ? { body } : {}),
    });
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
