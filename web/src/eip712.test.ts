// TypeScript half of the cross-language check; tests/test_vectors.py is the Python half.
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import vector from "../../tests/vectors/claim-signature.json";
import { signClaim } from "./eip712";

describe("claim signature", () => {
  it("derives the same claim key address as Python", () => {
    expect(privateKeyToAccount(vector.claimKeySecret as Hex).address).toBe(vector.claimKeyAddress);
  });

  it("produces exactly the signature Python produces", async () => {
    const sig = await signClaim(vector.claimKeySecret as Hex, {
      chainId: vector.chainId,
      contract: getAddress(vector.contract),
      recipient: getAddress(vector.recipient),
      relayer: getAddress(vector.relayer),
      fee: BigInt(vector.fee),
    });
    expect(sig).toBe(vector.signature);
  });
});
