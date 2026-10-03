import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { backupCsv, fundingEntry, unlockFunding } from "./backup";
import { claimLink, newClaimSecret } from "./links";
import { decryptKey, encryptKey } from "./vault";

const PASSWORD = "correct horse battery";

describe("vault", () => {
  it("round-trips a key with the right password", async () => {
    const key = newClaimSecret();
    const blob = await encryptKey(key, PASSWORD);
    expect(blob).toMatch(/^enc:v1:[\w-]+:[\w-]+:[\w-]+$/);
    expect(blob).not.toContain(key.slice(2));
    expect(await decryptKey(blob, PASSWORD)).toBe(key);
  });

  it("fails cleanly with the wrong password", async () => {
    const blob = await encryptKey(newClaimSecret(), PASSWORD);
    await expect(decryptKey(blob, "wrong password!!")).rejects.toThrow("doesn't open");
  });

  it("uses a fresh salt every time", async () => {
    const key = newClaimSecret();
    expect(await encryptKey(key, PASSWORD)).not.toBe(await encryptKey(key, PASSWORD));
  });

  it("refuses short passwords", async () => {
    await expect(encryptKey(newClaimSecret(), "short")).rejects.toThrow("at least");
  });
});

describe("backup file", () => {
  const secrets = [newClaimSecret(), newClaimSecret()];
  const links = secrets.map((s) => claimLink("https://x", s));
  const fundingKey = newClaimSecret();
  const fundingAddress = privateKeyToAccount(fundingKey).address;

  it("stores an encrypted funding key that unlocks with the password", async () => {
    const csv = backupCsv({ amountUsd: "1.00", secrets, links, funding: { address: fundingAddress, secret: await encryptKey(fundingKey, PASSWORD) } });
    expect(csv.split("\n")[0]).toBe("kind,number,amount_usd,address,link_or_key");
    expect(csv).not.toContain(fundingKey.slice(2));
    const entry = fundingEntry(csv.replace(/\n/g, "\r\n"))!; // survives Excel line endings
    expect(entry.encrypted).toBe(true);
    expect(await unlockFunding(entry, PASSWORD)).toBe(fundingKey);
    await expect(unlockFunding(entry)).rejects.toThrow("password-protected");
  });

  it("still opens older files with a plain key", async () => {
    const csv = backupCsv({ amountUsd: "1.00", secrets, links, funding: { address: fundingAddress, secret: fundingKey } });
    const entry = fundingEntry(csv)!;
    expect(entry.encrypted).toBe(false);
    expect(await unlockFunding(entry)).toBe(fundingKey);
  });

  it("has no funding entry for browser-wallet campaigns", () => {
    expect(fundingEntry(backupCsv({ amountUsd: "1.00", secrets, links }))).toBeNull();
  });

  it("rejects a key that doesn't match its address", async () => {
    const other = privateKeyToAccount(newClaimSecret()).address;
    const entry = fundingEntry(backupCsv({ amountUsd: "1.00", secrets, links, funding: { address: other, secret: await encryptKey(fundingKey, PASSWORD) } }))!;
    await expect(unlockFunding(entry, PASSWORD)).rejects.toThrow("doesn't match");
  });
});
