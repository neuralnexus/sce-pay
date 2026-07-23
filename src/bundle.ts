import type { GuestBundle } from "./domain.js";
import { ScePayError } from "./errors.js";
import { normalizedOrigin } from "./origins.js";

function invalid(message: string): never {
  throw new ScePayError("BUNDLE_INVALID", message);
}

export function validateGuestBundle(value: GuestBundle): GuestBundle {
  if (value.version !== 1) invalid("The onboarding bundle version is unsupported.");
  if (!/^\d{10,16}$/.test(value.accountNumber.replace(/\D/g, ""))) {
    invalid("The SCE account number is invalid.");
  }
  if (!/^\d{5}$/.test(value.mailingZip)) invalid("The mailing ZIP code is invalid.");
  if (!/^\d{4}$/.test(value.paymentMethodLast4)) {
    invalid("The payment method last four digits are invalid.");
  }
  if (
    !Number.isSafeInteger(value.maxBillCents) ||
    value.maxBillCents <= 0 ||
    !Number.isSafeInteger(value.feeLimitCentsExclusive) ||
    value.feeLimitCentsExclusive <= 0 ||
    value.feeLimitCentsExclusive > 400
  ) {
    invalid("The payment authorization limits are invalid.");
  }
  if (
    !Number.isInteger(value.payWhenDueWithinDays) ||
    value.payWhenDueWithinDays < 0 ||
    value.payWhenDueWithinDays > 31
  ) {
    invalid("The due-window setting is invalid.");
  }
  if (
    value.allowedTopLevelOrigins.length === 0 ||
    value.allowedTopLevelOrigins.some((origin) => normalizedOrigin(origin) !== origin)
  ) {
    invalid("The reviewed top-level origin list is invalid.");
  }
  if (value.allowedFrameOrigins.some((origin) => normalizedOrigin(origin) !== origin)) {
    invalid("The reviewed frame-origin list is invalid.");
  }
  const guestOrigin = normalizedOrigin(value.guestUrl);
  if (guestOrigin === null || !value.allowedTopLevelOrigins.includes(guestOrigin)) {
    invalid("The guest-payment URL is outside the reviewed origins.");
  }
  if (typeof value.storageState !== "object" || value.storageState === null) {
    invalid("The tokenized browser state is missing.");
  }
  if (
    value.notificationWebhookUrl &&
    normalizedOrigin(value.notificationWebhookUrl) === null
  ) {
    invalid("The notification webhook must use HTTPS.");
  }
  return value;
}
