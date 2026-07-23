import { randomUUID } from "node:crypto";

import type { GuestBundle } from "./domain.js";

export interface NotificationEvent {
  id: string;
  occurredAt: string;
  product: "sce-pay";
  kind: "payment-confirmed" | "attention-required";
  outcome: string;
  message: string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

export async function signNotification(
  body: string,
  secret: string,
  timestamp: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  return `v1=${base64Url(new Uint8Array(signature))}`;
}

export async function sendNotification(
  bundle: GuestBundle,
  event: Omit<NotificationEvent, "id" | "occurredAt" | "product">,
): Promise<boolean> {
  if (!bundle.notificationWebhookUrl || !bundle.notificationWebhookSecret) {
    return false;
  }
  const notification: NotificationEvent = {
    id: randomUUID(),
    occurredAt: new Date().toISOString(),
    product: "sce-pay",
    ...event,
  };
  const body = JSON.stringify(notification);
  const signature = await signNotification(
    body,
    bundle.notificationWebhookSecret,
    notification.occurredAt,
  );
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(bundle.notificationWebhookUrl, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
        headers: {
          "content-type": "application/json",
          "user-agent": "sce-pay/0.3",
          "x-sce-pay-event-id": notification.id,
          "x-sce-pay-timestamp": notification.occurredAt,
          "x-sce-pay-signature": signature,
        },
        body,
      });
      if (response.ok) return true;
    } catch {
      // Notification delivery never changes the payment result.
    }
  }
  return false;
}
