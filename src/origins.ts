import { SiteChangedError } from "./errors.js";

export const SCE_GUEST_ORIGIN = "https://www.sce.com";
export const SCE_GUEST_PATH_PREFIX = "/mysce/billsnpayments/paybills";

export function normalizedOrigin(url: string): string | null {
  if (url === "about:blank" || url.startsWith("data:")) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function isAllowedSceTopLevelUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin.toLowerCase() === SCE_GUEST_ORIGIN &&
      (parsed.pathname === SCE_GUEST_PATH_PREFIX ||
        parsed.pathname.startsWith(`${SCE_GUEST_PATH_PREFIX}/`))
    );
  } catch {
    return false;
  }
}

export function assertAllowedTopLevelUrl(url: string): void {
  if (!isAllowedSceTopLevelUrl(url)) {
    throw new SiteChangedError(
      "Top-level navigation left the current SCE Guest Pay application.",
    );
  }
}

export function assertAllowedOrigin(
  url: string,
  allowedOrigins: readonly string[],
  kind: "top-level" | "frame",
): void {
  const origin = normalizedOrigin(url);
  if (
    origin === null ||
    !allowedOrigins.some((allowed) => allowed.toLowerCase() === origin)
  ) {
    throw new SiteChangedError(
      `The ${kind} payment origin is not part of the reviewed onboarding capture.`,
    );
  }
}

export function isLocallySafeRequestUrl(url: string): boolean {
  return url === "about:blank" || url.startsWith("data:") || url.startsWith("blob:");
}
