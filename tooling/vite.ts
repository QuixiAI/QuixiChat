import { defineConfig } from "vite";
import { pdfAssetNotices } from './pdf-assets.ts';
import { embeddingModelAssets } from './embedding-assets.ts';

// Keep development and deployed hosts aligned for the A1 storage proof.
export const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [pdfAssetNotices(), embeddingModelAssets()],
  worker: { format: 'es' },
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
});
