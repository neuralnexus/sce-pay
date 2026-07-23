import { SiteChangedError } from "./errors.js";

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
