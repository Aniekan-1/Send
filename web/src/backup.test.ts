import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { backupCsv, fundingKeyFromCsv } from "./backup";
import { claimLink, newClaimSecret } from "./links";

describe("backup file", () => {
  const secrets = [newClaimSecret(), newClaimSecret()];
  const links = secrets.map((s) => claimLink("https://x", s));

  it("round-trips the funding key", () => {
    const fundingKey = newClaimSecret();
    const csv = backupCsv({ amountUsd: "1.00", secrets, links, fundingKey });
    expect(csv.split("\n")[0]).toBe("kind,number,amount_usd,address,link_or_key");
    expect(csv).toContain(privateKeyToAccount(secrets[1]).address);
    expect(fundingKeyFromCsv(csv)).toBe(fundingKey);
    expect(fundingKeyFromCsv(csv.replace(/\n/g, "\r\n"))).toBe(fundingKey); // edited in Excel
  });

  it("has no funding key for browser-wallet campaigns", () => {
    expect(fundingKeyFromCsv(backupCsv({ amountUsd: "1.00", secrets, links }))).toBeNull();
  });

  it("rejects a key that doesn't match its address", () => {
    const csv = backupCsv({ amountUsd: "1.00", secrets, links, fundingKey: newClaimSecret() });
    const tampered = csv.replace(/funding_wallet,,,0x[0-9a-fA-F]{40}/, "funding_wallet,,,0x" + "1".repeat(40));
    expect(fundingKeyFromCsv(tampered)).toBeNull();
  });
});
