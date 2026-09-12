import { createReadStream, existsSync, statSync, copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';

/** The compiled Arctic XS model is a separately provisioned build input. This
 * serves it under /models/ from packages/quixi-embed/build in dev/preview and
 * copies it beside the built application when present. Its SHA-256 is verified
 * by the embedding worker against the pinned lock, never trusted from disk. */
export const EMBEDDING_MODEL_FILE = 'arctic-xs.qxmodel';
export const EMBEDDING_MODEL_ROUTE = `/models/${EMBEDDING_MODEL_FILE}`;
export const embeddingModelSource = () => resolve(fileURLToPath(new URL('../packages/quixi-embed/build/', import.meta.url)), EMBEDDING_MODEL_FILE);
export function embeddingModelAssets(): Plugin {
  const source = embeddingModelSource();
  const install = (server: Pick<ViteDevServer, 'middlewares'> | Pick<PreviewServer, 'middlewares'>) => {
    server.middlewares.use((request, response, next) => {
      if (request.url?.split('?')[0] !== EMBEDDING_MODEL_ROUTE) return next();
      if (!existsSync(source)) { response.statusCode = 404; response.end('Embedding model is not provisioned on this host.'); return; }
      const size = statSync(source).size;
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Length', String(size));
      response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      if (request.method === 'HEAD') { response.end(); return; }
      createReadStream(source).pipe(response);
    });
  };
  let outDir = 'dist';
  return {
    name: 'quixi-embedding-model-assets',
    configResolved(config) { outDir = config.build.outDir; },
    configureServer: install,
    configurePreviewServer: install,
    closeBundle() {
      if (!existsSync(source)) return;
      const target = resolve(outDir, 'models');
      mkdirSync(target, { recursive: true });
      copyFileSync(source, resolve(target, EMBEDDING_MODEL_FILE));
    },
  };
}
