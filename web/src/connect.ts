// Browser-wallet connection (MetaMask, Rabby, …) shared by the organizer page and the dashboard.
import { type Account, type Address, type Hex, type WalletClient, createWalletClient, custom, erc20Abi, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { USDC, arc, publicClient } from "./config";

export interface Connection {
  wallet: WalletClient;
  account: Address;
  /** What to sign with: the browser wallet's address, or a local key (exchange funding wallet). */
  signer: Account | Address;
  /** True when signing with a key from a backup file rather than a browser wallet. */
  local: boolean;
}

export async function connectWallet(): Promise<Connection> {
  if (!window.ethereum) throw new Error("No browser wallet found. Install MetaMask or a similar wallet, then reload.");
  const wallet = createWalletClient({ chain: arc, transport: custom(window.ethereum) });
  const [account] = await wallet.requestAddresses();
  await ensureArc(wallet);
  return { wallet, account, signer: account, local: false };
}

/** Sign in-page with a private key (the one-time funding wallet used for exchange deposits). */
export function connectWithKey(key: Hex): Connection {
  const signer = privateKeyToAccount(key);
  const wallet = createWalletClient({ account: signer, chain: arc, transport: http() });
  return { wallet, account: signer.address, signer, local: true };
}

export async function ensureArc(wallet: WalletClient) {
  if (wallet.transport.type !== "custom") return; // local key: already talks to Arc over HTTP
  if ((await wallet.getChainId()) === arc.id) return;
  try {
    await wallet.switchChain({ id: arc.id });
  } catch {
    await wallet.addChain({ chain: arc });
    await wallet.switchChain({ id: arc.id });
  }
}

export function usdcBalance(account: Address): Promise<bigint> {
  return publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account] });
}

/** Send USDC out of a connected wallet (used to return exchange-funded money). Returns the tx hash. */
export async function sendUsdc(c: Connection, to: Address, amount: bigint): Promise<Hex> {
  await ensureArc(c.wallet);
  const { request } = await publicClient.simulateContract({
    account: c.signer, address: USDC, abi: erc20Abi, functionName: "transfer", args: [to, amount],
  });
  const hash = await c.wallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("The transfer failed.");
  return hash;
}
