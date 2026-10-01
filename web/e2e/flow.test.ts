// End-to-end: real contract on anvil + the Python relayer + the same modules the pages use.
//
//   uv run python scripts/local_stack.py      (terminal 1)
//   E2E=1 npx vitest run e2e                   (terminal 2, in web/)
import { createWalletClient, erc20Abi, http, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { ApiError, api } from "../src/api";
import { USDC, arc, publicClient, requireContract } from "../src/config";
import { signClaim } from "../src/eip712";
import { dollarDropAbi } from "../src/generated/abi";
import { claimLink, newClaimSecret, secretFromHash } from "../src/links";

const organizer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const wallet = createWalletClient({ account: organizer, chain: arc, transport: http() });
const balanceOf = (who: `0x${string}`) =>
  publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [who] });

describe.skipIf(!process.env.E2E)("organizer funds, recipient claims through the relayer", () => {
  it("works end to end", async () => {
    const contract = requireContract();
    const amount = 5_000_000n; // $5
    const secrets = [newClaimSecret(), newClaimSecret()];
    const links = secrets.map((s) => claimLink("http://localhost:5173", s));

    // --- organizer page: approve + createCampaign
    await publicClient.waitForTransactionReceipt({
      hash: await wallet.writeContract({
        address: USDC, abi: erc20Abi, functionName: "approve", args: [contract, amount * 2n],
      }),
    });
    const keys = secrets.map((s) => privateKeyToAccount(s).address);
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: await wallet.writeContract({
        address: contract, abi: dollarDropAbi, functionName: "createCampaign",
        args: [amount, expiresAt, 50_000n, keys],
      }),
    });
    const [created] = parseEventLogs({ abi: dollarDropAbi, eventName: "CampaignCreated", logs: receipt.logs });
    expect(created.args.amountPerDrop).toBe(amount);

    // --- claim page: read the link, ask the relayer, sign, submit
    const recipient = privateKeyToAccount(newClaimSecret()).address; // a brand-new, empty wallet
    const secret = secretFromHash(new URL(links[0]).hash)!;
    const drop = await api.drop(privateKeyToAccount(secret).address);
    expect(drop.status).toBe("active");
    expect(drop.receive).toBe(Number(amount) - drop.fee);

    const signature = await signClaim(secret, {
      chainId: drop.chainId, contract: drop.contract, recipient, relayer: drop.relayer, fee: BigInt(drop.fee),
    });
    const result = await api.claim({ claimKey: drop.claim_key, recipient, fee: drop.fee, signature });

    expect(result.amount).toBe(drop.receive);
    expect(await balanceOf(recipient)).toBe(BigInt(drop.receive));
    expect((await api.drop(drop.claim_key)).status).toBe("claimed");

    // --- the same link can't be used twice
    const again = await signClaim(secret, {
      chainId: drop.chainId, contract: drop.contract, recipient: organizer.address, relayer: drop.relayer, fee: BigInt(drop.fee),
    });
    const err = await api.claim({ claimKey: drop.claim_key, recipient: organizer.address, fee: drop.fee, signature: again })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);

    // --- organizer refunds the unclaimed drop, found via DropCreated events (no links needed)
    const logs = await publicClient.getContractEvents({
      address: contract, abi: dollarDropAbi, eventName: "DropCreated",
      args: { campaignId: created.args.campaignId }, fromBlock: 0n,
    });
    expect(logs.map((l) => l.args.claimKey)).toEqual(keys);
    const before = await balanceOf(organizer.address);
    await publicClient.waitForTransactionReceipt({
      hash: await wallet.writeContract({ address: contract, abi: dollarDropAbi, functionName: "refund", args: [[keys[1]]] }),
    });
    expect(await balanceOf(organizer.address)).toBe(before + amount);
  }, 60_000);
});
