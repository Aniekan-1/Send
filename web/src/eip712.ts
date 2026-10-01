// Must match DollarDrop.sol (EIP712("DollarDrop", "1"), CLAIM_TYPEHASH) and dollardrop/claims.py.
// eip712.test.ts checks this against tests/vectors/claim-signature.json, which Python checks too.
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const claimTypes = {
  Claim: [
    { name: "recipient", type: "address" },
    { name: "relayer", type: "address" },
    { name: "fee", type: "uint256" },
  ],
} as const;

export interface ClaimParams {
  chainId: number;
  contract: Address;
  recipient: Address;
  relayer: Address;
  fee: bigint;
}

export function claimDomain(chainId: number, contract: Address) {
  return { name: "DollarDrop", version: "1", chainId, verifyingContract: contract } as const;
}

/** Sign a claim with the drop's claim key (the secret from the link). Runs only in the browser. */
export function signClaim(secret: Hex, p: ClaimParams): Promise<Hex> {
  return privateKeyToAccount(secret).signTypedData({
    domain: claimDomain(p.chainId, p.contract),
    types: claimTypes,
    primaryType: "Claim",
    message: { recipient: p.recipient, relayer: p.relayer, fee: p.fee },
  });
}
