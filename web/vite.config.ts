import { resolve } from "node:path";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    // Circle's web SDK bundles Node-only libraries (jsonwebtoken, jws) that call util.inherits,
    // stream, Buffer and process at load time. Give the browser the standard stand-ins.
    nodePolyfills({
      include: ["buffer", "util", "stream", "events", "process"],
      globals: { Buffer: true, global: true, process: true },
    }),
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
});
