import type { EncryptedBundle, GuestBundle } from "./domain.js";
import { ScePayError } from "./errors.js";

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
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
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext,
  );
  return {
    version: 1,
    algorithm: "AES-GCM",
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptBundle(
  encrypted: EncryptedBundle,
  keyBase64: string,
): Promise<GuestBundle> {
  try {
    if (encrypted.version !== 1 || encrypted.algorithm !== "AES-GCM") {
      throw new Error("unsupported bundle");
    }
    const key = await importKey(keyBase64);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(encrypted.iv) },
      key,
      base64ToBytes(encrypted.ciphertext),
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as GuestBundle;
  } catch (error) {
    throw new ScePayError(
      "BUNDLE_INVALID",
      "The encrypted guest-payment setup could not be opened.",
      { cause: error },
    );
  }
}
