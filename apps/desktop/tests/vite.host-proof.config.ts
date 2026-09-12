import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  build: {
    outDir: fileURLToPath(new URL("./build", import.meta.url)), emptyOutDir: true,
    lib: { entry: fileURLToPath(new URL("./host-proof.ts", import.meta.url)), name: "QuixiNativeHostProof", formats: ["iife"], fileName: () => "host-proof.js" },
  },
});
