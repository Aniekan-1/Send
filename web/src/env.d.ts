/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CHAIN_ID?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_DOLLARDROP_ADDRESS?: string;
  readonly VITE_DEPLOY_BLOCK?: string;
  readonly VITE_RELAYER_URL?: string;
  readonly VITE_EXPLORER_URL?: string;
  readonly VITE_CIRCLE_APP_ID?: string;
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}

interface Window {
  /** EIP-1193 browser wallet (MetaMask, Rabby, …) */
  ethereum?: import("viem").EIP1193Provider;
}
