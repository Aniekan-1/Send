import { describe, expect, it } from "vitest";
import { usd, parseUsd } from "./format";
import { claimLink, decodeSecret, encodeSecret, newClaimSecret, secretFromHash } from "./links";

describe("claim links", () => {
  it("round-trips a secret through the link", () => {
    for (let i = 0; i < 50; i++) {
      const secret = newClaimSecret();
      const link = claimLink("https://drop.example/", secret);
      expect(link).toMatch(/^https:\/\/drop\.example\/claim\.html#k=[A-Za-z0-9_-]{43}$/);
      expect(secretFromHash(new URL(link).hash)).toBe(secret);
    }
  });

  it("keeps secrets with leading zero bytes intact", () => {
    const secret = ("0x00" + "ab".repeat(31)) as `0x${string}`;
    expect(decodeSecret(encodeSecret(secret))).toBe(secret);
  });

  it("ignores hashes that are not claim links", () => {
    expect(secretFromHash("")).toBeNull();
    expect(secretFromHash("#state=abc&id_token=xyz")).toBeNull();
    expect(secretFromHash("#k=too-short")).toBeNull();
    expect(secretFromHash("#k=" + "!".repeat(43))).toBeNull();
  });
});

describe("dollar formatting", () => {
  it("formats and parses USDC amounts", () => {
    expect(usd(9_990_000n)).toBe("$9.99");
    expect(usd(4_200)).toBe("$0.0042");
    expect(usd(0)).toBe("$0.00");
    expect(parseUsd("$10.50")).toBe(10_500_000n);
    expect(() => parseUsd("-1")).toThrow();
    expect(() => parseUsd("1.1234567")).toThrow();
  });
});
