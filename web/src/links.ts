// Claim links: https://<site>/claim.html#k=<secret>
//
// The secret is a 32-byte claim key, base64url-encoded (43 chars, so QR codes stay small).
// It lives after "#", which browsers never send to any server.
import { type Hex, bytesToHex, hexToBytes } from "viem";
import { generatePrivateKey } from "viem/accounts";

export function newClaimSecret(): Hex {
  return generatePrivateKey();
}

export function encodeSecret(secret: Hex): string {
  const binary = String.fromCharCode(...hexToBytes(secret));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeSecret(encoded: string): Hex | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) return null;
  const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/") + "=");
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return bytes.length === 32 ? bytesToHex(bytes) : null;
}

export function claimLink(siteUrl: string, secret: Hex): string {
  return `${siteUrl.replace(/\/$/, "")}/claim.html#k=${encodeSecret(secret)}`;
}

/** Read the secret from a URL hash like "#k=...". Returns null for any other hash (e.g. an OAuth redirect). */
export function secretFromHash(hash: string): Hex | null {
  const k = new URLSearchParams(hash.replace(/^#/, "")).get("k");
  return k ? decodeSecret(k) : null;
}
