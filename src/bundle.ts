import type { BrowserStateSnapshot, GuestBundle } from "./domain.js";
import { ScePayError } from "./errors.js";
import {
  isAllowedSceTopLevelUrl,
  normalizedOrigin,
  SCE_GUEST_ORIGIN,
} from "./origins.js";

const MAX_BUNDLE_JSON_BYTES = 384_000;
const MAX_ORIGINS = 64;
const MAX_STORAGE_ITEMS = 2_000;
const MAX_STORAGE_VALUE_LENGTH = 64_000;

function invalid(message: string): never {
  throw new ScePayError("BUNDLE_INVALID", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateOrigins(origins: unknown, label: string): string[] {
  if (
    !Array.isArray(origins) ||
    origins.length > MAX_ORIGINS ||
    origins.some(
      (origin) =>
        typeof origin !== "string" ||
        origin.length > 255 ||
        normalizedOrigin(origin) !== origin,
    )
  ) {
    invalid(`The reviewed ${label} origin list is invalid.`);
  }
  return [...new Set(origins)];
}

function validateBrowserState(value: GuestBundle): void {
  if (!isRecord(value.storageState)) {
    invalid("The tokenized browser state is missing.");
  }
  const cookies = value.storageState.cookies;
  const origins = value.storageState.origins;
  if (!Array.isArray(cookies) || !Array.isArray(origins)) {
    invalid("The tokenized browser state has an invalid structure.");
  }
  if (cookies.length + origins.length > MAX_STORAGE_ITEMS) {
    invalid("The tokenized browser state is unexpectedly large.");
  }
  for (const cookie of cookies) {
    if (
      !isRecord(cookie) ||
      typeof cookie.name !== "string" ||
      cookie.name.length === 0 ||
      cookie.name.length > 1_024 ||
      typeof cookie.value !== "string" ||
      cookie.value.length > MAX_STORAGE_VALUE_LENGTH ||
      typeof cookie.domain !== "string" ||
      cookie.domain.length === 0 ||
      cookie.domain.length > 255 ||
      !cookieDomainAllowed(value, cookie.domain) ||
      typeof cookie.path !== "string" ||
      cookie.path.length === 0 ||
      cookie.path.length > 2_048
    ) {
      invalid("The tokenized browser state contains an invalid cookie.");
    }
  }
  for (const storedOrigin of origins) {
    if (
      !isRecord(storedOrigin) ||
      typeof storedOrigin.origin !== "string" ||
      normalizedOrigin(storedOrigin.origin) !== storedOrigin.origin ||
      !candidateOriginAllowed(value, storedOrigin.origin) ||
      !Array.isArray(storedOrigin.localStorage)
    ) {
      invalid("The tokenized browser state contains an invalid origin.");
    }
    for (const entry of storedOrigin.localStorage) {
      if (
        !isRecord(entry) ||
        typeof entry.name !== "string" ||
        entry.name.length === 0 ||
        entry.name.length > 1_024 ||
        typeof entry.value !== "string" ||
        entry.value.length > MAX_STORAGE_VALUE_LENGTH
      ) {
        invalid("The tokenized browser state contains an invalid local-storage item.");
      }
    }
  }
  if (!isRecord(value.sessionStorageByOrigin)) {
    invalid("The tokenized session state has an invalid structure.");
  }
  let sessionItems = 0;
  for (const [origin, entries] of Object.entries(value.sessionStorageByOrigin)) {
    if (
      normalizedOrigin(origin) !== origin ||
      !candidateOriginAllowed(value, origin) ||
      !isRecord(entries)
    ) {
      invalid("The tokenized session state contains an invalid origin.");
    }
    for (const [key, storedValue] of Object.entries(entries)) {
      sessionItems += 1;
      if (
        key.length === 0 ||
        key.length > 1_024 ||
        typeof storedValue !== "string" ||
        storedValue.length > MAX_STORAGE_VALUE_LENGTH
      ) {
        invalid("The tokenized session state contains an invalid item.");
      }
    }
  }
  if (sessionItems > MAX_STORAGE_ITEMS) {
    invalid("The tokenized session state is unexpectedly large.");
  }
  assertNoRawCardLikeStorage({
    storageState: value.storageState,
    sessionStorageByOrigin: value.sessionStorageByOrigin,
  });
}

function candidateOriginAllowed(value: GuestBundle, origin: string): boolean {
  return (
    Array.isArray(value.allowedRequestOrigins) &&
    value.allowedRequestOrigins.includes(origin)
  );
}

function cookieDomainAllowed(value: GuestBundle, domain: string): boolean {
  const normalizedDomain = domain.replace(/^\./u, "").toLowerCase();
  return value.allowedRequestOrigins.some((origin) => {
    const hostname = new URL(origin).hostname.toLowerCase();
    return hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`);
  });
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number.parseInt(digits[index] ?? "", 10);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function assertNoRawCardLikeStorage(state: BrowserStateSnapshot): void {
  const serialized = JSON.stringify(state);
  const candidates = serialized.match(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/gu);
  if (
    candidates?.some((candidate) => {
      const digits = candidate.replace(/\D/g, "");
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
    })
  ) {
    invalid("Browser state appeared to contain a raw payment-card number.");
  }
  if (
    /"(?:card_?number|primary_?account_?number|pan|cvv|cvc|security_?code)"\s*:/iu.test(
      serialized,
    )
  ) {
    invalid("Browser state contained a prohibited raw card-data field.");
  }
}

function validateWebhook(value: GuestBundle): void {
  if (!value.notificationWebhookUrl && !value.notificationWebhookSecret) return;
  if (!value.notificationWebhookUrl || !value.notificationWebhookSecret) {
    invalid("Webhook URL and signing secret must be configured together.");
  }
  let url: URL;
  try {
    url = new URL(value.notificationWebhookUrl);
  } catch {
    invalid("The notification webhook URL is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.port
  ) {
    invalid("The notification webhook must be a credential-free HTTPS URL.");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(value.notificationWebhookSecret)) {
    invalid("The notification webhook signing secret is invalid.");
  }
}

export function validateGuestBundle(value: unknown): GuestBundle {
  if (!isRecord(value)) invalid("The onboarding bundle is invalid.");
  const candidate = value as unknown as GuestBundle;
  if (candidate.version !== 2) {
    invalid("The onboarding bundle version is unsupported.");
  }
  if (!/^[A-Za-z0-9_-]{22}$/.test(candidate.configurationId)) {
    invalid("The onboarding configuration identifier is invalid.");
  }
  const capturedAt = new Date(candidate.capturedAt);
  if (
    Number.isNaN(capturedAt.getTime()) ||
    capturedAt.getTime() > Date.now() + 5 * 60_000
  ) {
    invalid("The onboarding capture timestamp is invalid.");
  }
  if (!/^\d{10,16}$/.test(candidate.accountNumber.replace(/\D/g, ""))) {
    invalid("The SCE account number is invalid.");
  }
  if (!/^\d{5}$/.test(candidate.mailingZip)) {
    invalid("The mailing ZIP code is invalid.");
  }
  if (!/^\d{4}$/.test(candidate.paymentMethodLast4)) {
    invalid("The payment method last four digits are invalid.");
  }
  if (
    !Number.isSafeInteger(candidate.maxBillCents) ||
    candidate.maxBillCents <= 0 ||
    candidate.maxBillCents > 10_000_000 ||
    !Number.isSafeInteger(candidate.feeLimitCentsExclusive) ||
    candidate.feeLimitCentsExclusive <= 0 ||
    candidate.feeLimitCentsExclusive > 400
  ) {
    invalid("The payment authorization limits are invalid.");
  }
  if (
    !Number.isInteger(candidate.payWhenDueWithinDays) ||
    candidate.payWhenDueWithinDays < 0 ||
    candidate.payWhenDueWithinDays > 31
  ) {
    invalid("The due-window setting is invalid.");
  }
  const topLevelOrigins = validateOrigins(
    candidate.allowedTopLevelOrigins,
    "top-level",
  );
  const frameOrigins = validateOrigins(candidate.allowedFrameOrigins, "frame");
  const requestOrigins = validateOrigins(
    candidate.allowedRequestOrigins,
    "network-request",
  );
  if (
    topLevelOrigins.length !== 1 ||
    topLevelOrigins[0] !== SCE_GUEST_ORIGIN ||
    !isAllowedSceTopLevelUrl(candidate.guestUrl)
  ) {
    invalid("Top-level payment navigation must remain in SCE Guest Pay.");
  }
  if (!requestOrigins.includes(SCE_GUEST_ORIGIN)) {
    invalid("The network allowlist does not include SCE Guest Pay.");
  }
  for (const origin of [...topLevelOrigins, ...frameOrigins]) {
    if (!requestOrigins.includes(origin)) {
      invalid("Every reviewed page and frame origin must be network-allowlisted.");
    }
  }
  validateBrowserState(candidate);
  validateWebhook(candidate);
  if (
    new TextEncoder().encode(JSON.stringify(candidate)).byteLength >
    MAX_BUNDLE_JSON_BYTES
  ) {
    invalid("The onboarding bundle is unexpectedly large.");
  }
  return {
    ...candidate,
    allowedTopLevelOrigins: topLevelOrigins,
    allowedFrameOrigins: frameOrigins,
    allowedRequestOrigins: requestOrigins,
  };
}

export function mergeBrowserState(
  bundle: GuestBundle,
  state: BrowserStateSnapshot,
): GuestBundle {
  return validateGuestBundle({ ...bundle, ...state });
}
