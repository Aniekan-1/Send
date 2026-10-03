import { resolve } from "node:path";
import { type Plugin, loadEnv } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { defineConfig } from "vitest/config";

/**
 * Content-Security-Policy for the built pages, as a <meta> tag so it names the exact relayer and RPC
 * this build talks to (a host's static header can't know them). Build only: the dev server needs
 * inline scripts and websockets. frame-ancestors can't go in a meta tag; the host sets it (render.yaml).
 */
function contentSecurityPolicy(env: Record<string, string>): Plugin {
  const origin = (url: string | undefined, fallback: string) => new URL(url || fallback).origin;
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // style="" attributes in the markup
    "img-src 'self' data:", // QR codes are data: URLs
    `connect-src 'self' ${origin(env.VITE_RELAYER_URL, "http://localhost:8000")} ${origin(env.VITE_RPC_URL, "https://rpc.mainnet.arc.io")}`,
    "frame-src https://pw-auth.circle.com", // Circle's PIN / approval window
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
  return {
    name: "content-security-policy",
    apply: "build",
    transformIndexHtml: () => [
      { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: policy }, injectTo: "head-prepend" },
    ],
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [
    // Circle's web SDK bundles Node-only libraries (jsonwebtoken, jws) that call util.inherits,
    // stream, Buffer and process at load time. Give the browser the standard stand-ins.
    nodePolyfills({
      include: ["buffer", "util", "stream", "events", "process"],
      globals: { Buffer: true, global: true, process: true },
    }),
    contentSecurityPolicy(loadEnv(mode, import.meta.dirname, "VITE_")),
  ],
  build: {
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        claim: resolve(import.meta.dirname, "claim.html"),
        organize: resolve(import.meta.dirname, "organize.html"),
        wallet: resolve(import.meta.dirname, "wallet.html"),
        dashboard: resolve(import.meta.dirname, "dashboard.html"),
      },
    },
  },
  test: {
    environment: "node",
  },
}));
