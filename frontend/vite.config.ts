import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Assets are embedded into the Rust binary and served from the loopback
// service root, so relative URLs keep working wherever that lands.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  server: { port: 5173, strictPort: true },
});
