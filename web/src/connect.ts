// Browser-wallet connection (MetaMask, Rabby, …) shared by the organizer page and the dashboard.
import { type Address, type WalletClient, createWalletClient, custom, erc20Abi } from "viem";
import { USDC, arc, publicClient } from "./config";

export interface Connection {
  wallet: WalletClient;
  account: Address;
}

export async function connectWallet(): Promise<Connection> {
  if (!window.ethereum) throw new Error("No browser wallet found. Install MetaMask or a similar wallet, then reload.");
  const wallet = createWalletClient({ chain: arc, transport: custom(window.ethereum) });
  const [account] = await wallet.requestAddresses();
  await ensureArc(wallet);
  return { wallet, account };
}

export async function ensureArc(wallet: WalletClient) {
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
