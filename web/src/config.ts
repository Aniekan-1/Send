import { type Address, createPublicClient, defineChain, getAddress, http } from "viem";

const env = import.meta.env;

export const config = {
  chainId: Number(env.VITE_CHAIN_ID || 5042),
  rpcUrl: env.VITE_RPC_URL || "https://rpc.mainnet.arc.io",
  contract: env.VITE_DOLLARDROP_ADDRESS ? getAddress(env.VITE_DOLLARDROP_ADDRESS) : undefined,
  deployBlock: BigInt(env.VITE_DEPLOY_BLOCK || 0),
  relayerUrl: (env.VITE_RELAYER_URL || "http://localhost:8000").replace(/\/$/, ""),
  explorerUrl: (env.VITE_EXPLORER_URL || "").replace(/\/$/, ""),
  circleAppId: env.VITE_CIRCLE_APP_ID || "",
  googleClientId: env.VITE_GOOGLE_CLIENT_ID || "",
};

/** USDC's ERC-20 interface on Arc (6 decimals). Native USDC (gas) uses 18 decimals. */
export const USDC: Address = "0x3600000000000000000000000000000000000000";

export const arc = defineChain({
  id: config.chainId,
  name: ({ 5042: "Arc", 5042002: "Arc Testnet" } as Record<number, string>)[config.chainId] ?? "Local test chain",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
  ...(config.explorerUrl && { blockExplorers: { default: { name: "Explorer", url: config.explorerUrl } } }),
});

export const publicClient = createPublicClient({ chain: arc, transport: http() });

/** Circle sign-in is optional; the SDK is only loaded when someone actually picks it. */
export const circleEnabled = () => Boolean(config.circleAppId);
export const googleEnabled = () => circleEnabled() && Boolean(config.googleClientId);
/** sessionStorage key marking a Google sign-in in progress (the page navigates away and back). */
export const PENDING_GOOGLE = "dd:circle-google";

export function requireContract(): Address {
  if (!config.contract) throw new Error("VITE_DOLLARDROP_ADDRESS is not set (see web/.env.example)");
  return config.contract;
}

export function txLink(hash: string): string | null {
  return config.explorerUrl ? `${config.explorerUrl}/tx/${hash}` : null;
}
