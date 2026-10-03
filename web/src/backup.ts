// The organizer's backup file: every claim link, plus (for exchange-funded campaigns) the
// one-time funding wallet's key, which is needed later to pause, refund and withdraw.
//
//   kind,number,amount_usd,address,link_or_key
//   drop,1,10.00,0xClaimKey…,https://…/claim.html#k=…
//   funding_wallet,,,0xFunding…,0x<private key>
import { type Hex, isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface BackupInput {
  amountUsd: string; // "10.00"
  secrets: Hex[];
  links: string[];
  fundingKey?: Hex;
}

export function backupCsv(b: BackupInput): string {
  const rows = [["kind", "number", "amount_usd", "address", "link_or_key"]];
  b.secrets.forEach((s, i) => rows.push(["drop", String(i + 1), b.amountUsd, privateKeyToAccount(s).address, b.links[i]]));
  if (b.fundingKey) rows.push(["funding_wallet", "", "", privateKeyToAccount(b.fundingKey).address, b.fundingKey]);
  return rows.map((r) => r.join(",")).join("\n") + "\n";
}

/** The funding wallet's key from a backup file, or null if the file has none (browser-wallet campaigns). */
export function fundingKeyFromCsv(text: string): Hex | null {
  for (const line of text.split(/\r?\n/)) {
    const cols = line.split(",");
    if (cols[0] === "funding_wallet" && isHex(cols[4]) && cols[4].length === 66) {
      const key = cols[4] as Hex;
      return privateKeyToAccount(key).address.toLowerCase() === cols[3].toLowerCase() ? key : null;
    }
  }
  return null;
}

export function downloadText(filename: string, text: string, type = "text/csv") {
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([text], { type })),
    download: filename,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}
