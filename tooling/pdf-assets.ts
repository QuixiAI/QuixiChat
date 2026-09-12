import { readFile, readdir } from 'node:fs/promises';
import type { Plugin } from 'vite';

/** PDF.js assets are emitted from explicit URL imports in the parser worker.
 * Retain their pinned redistribution notices in every product build too. */
export function pdfAssetNotices(): Plugin {
  return {
    name: 'quixi-pdf-asset-notices',
    async generateBundle() {
      const directory = new URL('../packages/documents/third-party/', import.meta.url);
      for (const name of await readdir(directory)) {
        this.emitFile({ type: 'asset', fileName: `third-party/${name}`, source: await readFile(new URL(name, directory)) });
      }
    },
  };
}
