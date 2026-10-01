import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The Circle SDK expects Node's Buffer; give the browser the standard polyfill.
  resolve: { alias: { buffer: "buffer/" } },
  define: { global: "globalThis" },
  build: {
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        claim: resolve(import.meta.dirname, "claim.html"),
        organize: resolve(import.meta.dirname, "organize.html"),
      },
    },
  },
  test: {
    environment: "node",
  },
});
