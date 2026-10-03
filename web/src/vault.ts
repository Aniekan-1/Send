// Password protection for the funding-wallet key in the backup file.
//
// Format: enc:v1:<salt>:<iv>:<ciphertext>   (base64url parts)
//   key  = PBKDF2-SHA256(password, salt, 600 000 iterations) -> 256-bit AES key
//   data = AES-256-GCM(key, iv, the 32-byte private key, or several of them back to back)
// GCM authenticates the data, so a wrong password fails instead of yielding a wrong key.
// Everything runs in the browser's Web Crypto; the password is never stored or sent.
import { type Hex, bytesToHex, concat, hexToBytes } from "viem";

const PREFIX = "enc:v1:";
const ITERATIONS = 600_000; // OWASP 2023 guidance for PBKDF2-SHA256
export const MIN_PASSWORD = 10;

const b64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4)), (c) =>
    c.charCodeAt(0),
  );

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: ITERATIONS },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function isEncrypted(secret: string): boolean {
  return secret.startsWith(PREFIX);
}

export async function encryptKey(key: Hex, password: string): Promise<string> {
  if (password.length < MIN_PASSWORD) throw new Error(`Use a password of at least ${MIN_PASSWORD} characters.`);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await deriveKey(password, salt), hexToBytes(key) as BufferSource);
  return `${PREFIX}${b64(salt)}:${b64(iv)}:${b64(new Uint8Array(data))}`;
}

export async function decryptKey(blob: string, password: string): Promise<Hex> {
  const [salt, iv, data] = blob.slice(PREFIX.length).split(":").map(unb64);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, await deriveKey(password, salt), data as BufferSource);
    return bytesToHex(new Uint8Array(plain));
  } catch {
    throw new Error("That password doesn't open this backup file.");
  }
}

/** Several 32-byte keys under one password, e.g. a pending campaign's claim keys. */
export async function encryptKeys(keys: Hex[], password: string): Promise<string> {
  return encryptKey(concat(keys), password);
}

export async function decryptKeys(blob: string, password: string): Promise<Hex[]> {
  const bytes = hexToBytes(await decryptKey(blob, password));
  return Array.from({ length: bytes.length / 32 }, (_, i) => bytesToHex(bytes.slice(i * 32, (i + 1) * 32)));
}
