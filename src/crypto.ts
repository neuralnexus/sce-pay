import type { EncryptedBundle, GuestBundle } from "./domain.js";
import { ScePayError } from "./errors.js";

const ENVELOPE_CONTEXT = "sce-pay:guest-bundle:v2";

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (
    value.length === 0 ||
    value.length > 1_000_000 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new ScePayError("BUNDLE_INVALID", "Encrypted setup data is malformed.");
  }
  if (typeof Buffer !== "undefined") {
    const source = Buffer.from(value, "base64");
    const result = new Uint8Array(source.byteLength);
    result.set(source);
    return result;
  }
  const decoded = atob(value);
  const result = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    result[index] = decoded.charCodeAt(index);
  }
  return result;
}

async function sha256Base64Url(value: Uint8Array): Promise<string> {
  const input = new Uint8Array(value.byteLength);
  input.set(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  const base64 = bytesToBase64(digest);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

export function generateBundleKey(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
}

async function importKey(keyBase64: string): Promise<CryptoKey> {
  const bytes = base64ToBytes(keyBase64);
  if (bytes.byteLength !== 32) {
    throw new ScePayError("BUNDLE_INVALID", "The encrypted setup key is invalid.");
  }
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptBundle(
  bundle: GuestBundle,
  keyBase64: string,
): Promise<EncryptedBundle> {
  const key = await importKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(bundle));
  const bundleId = await sha256Base64Url(plaintext);
  const additionalData = new TextEncoder().encode(`${ENVELOPE_CONTEXT}:${bundleId}`);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData, tagLength: 128 },
    key,
    plaintext,
  );
  return {
    version: 2,
    algorithm: "AES-256-GCM",
    bundleId,
    createdAt: new Date().toISOString(),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptBundle(
  encrypted: EncryptedBundle,
  keyBase64: string,
): Promise<GuestBundle> {
  try {
    if (
      encrypted.version !== 2 ||
      encrypted.algorithm !== "AES-256-GCM" ||
      !/^[A-Za-z0-9_-]{43}$/.test(encrypted.bundleId) ||
      Number.isNaN(new Date(encrypted.createdAt).getTime())
    ) {
      throw new Error("unsupported bundle");
    }
    const key = await importKey(keyBase64);
    const iv = base64ToBytes(encrypted.iv);
    if (iv.byteLength !== 12) throw new Error("invalid IV");
    const additionalData = new TextEncoder().encode(
      `${ENVELOPE_CONTEXT}:${encrypted.bundleId}`,
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData, tagLength: 128 },
      key,
      base64ToBytes(encrypted.ciphertext),
    );
    const bytes = new Uint8Array(plaintext);
    if ((await sha256Base64Url(bytes)) !== encrypted.bundleId) {
      throw new Error("bundle digest mismatch");
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as GuestBundle;
  } catch (error) {
    throw new ScePayError(
      "BUNDLE_INVALID",
      "The encrypted guest-payment setup could not be opened.",
      { cause: error },
    );
  }
}
