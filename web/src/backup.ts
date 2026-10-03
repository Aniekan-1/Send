// The organizer's backup file: every claim link, plus (for exchange-funded campaigns) the
// one-time funding wallet's key, which is needed later to pause, refund and withdraw.
// The funding key is password-protected (see vault.ts); claim links stay readable because
// they are meant to be printed and shared.
//
//   kind,number,amount_usd,address,link_or_key
//   drop,1,10.00,0xClaimKey…,https://…/claim.html#k=…
//   funding_wallet,,,0xFunding…,enc:v1:<salt>:<iv>:<ciphertext>
import { type Address, type Hex, getAddress, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decryptKey, isEncrypted } from "./vault";

export interface BackupInput {
  amountUsd: string; // "10.00"
  secrets: Hex[];
  links: string[];
  funding?: { address: Address; secret: string }; // secret: encrypted (enc:v1:…) or, in old files, a raw key
}

export function backupCsv(b: BackupInput): string {
  const rows = [["kind", "number", "amount_usd", "address", "link_or_key"]];
  b.secrets.forEach((s, i) => rows.push(["drop", String(i + 1), b.amountUsd, privateKeyToAccount(s).address, b.links[i]]));
  if (b.funding) rows.push(["funding_wallet", "", "", b.funding.address, b.funding.secret]);
  return rows.map((r) => r.join(",")).join("\n") + "\n";
}

/** The funding wallet entry of a backup file, or null if it has none (browser-wallet campaigns). */
export function fundingEntry(text: string): { address: Address; secret: string; encrypted: boolean } | null {
  for (const line of text.split(/\r?\n/)) {
    const cols = line.split(",");
    if (cols[0] === "funding_wallet" && isAddress(cols[3]) && cols[4]) {
      return { address: getAddress(cols[3]), secret: cols[4], encrypted: isEncrypted(cols[4]) };
    }
  }
  return null;
}

/** Unlock a funding entry (password needed if encrypted) and check the key really belongs to its address. */
export async function unlockFunding(entry: { address: Address; secret: string; encrypted: boolean }, password?: string): Promise<Hex> {
  let key: Hex;
  if (entry.encrypted) {
    if (!password) throw new Error("This backup file is password-protected.");
    key = await decryptKey(entry.secret, password);
  } else {
    if (!/^0x[0-9a-fA-F]{64}$/.test(entry.secret)) throw new Error("The funding key in this file is damaged.");
    key = entry.secret as Hex;
  }
  if (privateKeyToAccount(key).address !== entry.address) throw new Error("The funding key in this file doesn't match its address.");
  return key;
}

export function downloadText(filename: string, text: string, type = "text/csv") {
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([text], { type })),
    download: filename,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}
