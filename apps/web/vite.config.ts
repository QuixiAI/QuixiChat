import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig, type Plugin, type ViteDevServer } from 'vite';
import shared, { isolationHeaders } from '../../tooling/vite.ts';

export const callbackHeaders = {
  ...isolationHeaders,
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function oauthCallbackHeaders(): Plugin {
  const install = (server: Pick<ViteDevServer, 'middlewares'>) => {
    server.middlewares.use((request, response, next) => {
      if (request.url?.split('?')[0] === '/oauth/callback.html') {
        for (const [name, value] of Object.entries(callbackHeaders)) response.setHeader(name, value);
      }
      next();
    });
  };
  return { name: 'quixi-oauth-callback-headers', configureServer: install, configurePreviewServer: install };
}

export default mergeConfig(shared, defineConfig({
  plugins: [oauthCallbackHeaders()],
  build: { rollupOptions: { input: {
    app: fileURLToPath(new URL('./index.html', import.meta.url)),
    oauthCallback: fileURLToPath(new URL('./oauth/callback.html', import.meta.url)),
  } } },
}));
