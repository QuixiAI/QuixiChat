# Self-hosted web

From the repository root:

```sh
docker build -f deploy/docker/Dockerfile -t quixi-web .
docker run --rm -p 8080:8080 quixi-web
```

Open `http://localhost:8080`. The container serves the shared web application;
it has no user-history service or archive volume. Each browser profile/origin owns
its worker-managed OPFS archive; measured host support and remaining gates are in
the [storage matrix](../../docs/validation/storage-proof.md).

The image contains no embedding model: the Docker context excludes `build/` and
`*.qxmodel`, so Semantic search reports the model as unavailable while Exact and
lexical Best keep working. To offer local semantic search, provision the pinned
`arctic-xs.qxmodel` (SHA-256 in `packages/quixi-embed/artifacts/model/lock.json`)
at `/usr/share/nginx/html/models/arctic-xs.qxmodel`, for example through a
volume or a derived image; the browser verifies the digest before use. The
`/models/` location answers a missing file with 404 (never the application
document), which is what onboarding and the loader read as "not served".
`node tests/hosts/web-hosting-proof.mjs` checks the built image's headers,
media types, fallback behavior and both browser engines
([web-hosting.md](../../docs/validation/web-hosting.md)).

Use HTTPS for remote deployments; localhost is the development exception.
Preserve the COOP/COEP response headers through any reverse proxy. Keep the origin
stable because a different origin uses a different local archive. Browser/WebView
storage support still requires A1 verification.

The build includes `/oauth/callback.html`. Keep that exact route's COOP/COEP,
`Referrer-Policy: no-referrer`, `Cache-Control: no-store` and restrictive CSP intact.
Its nginx access/error logging is disabled because callback query strings contain
authorization codes. Configure every upstream proxy, CDN and request logger to
omit those query strings too; clearing the callback URL in the browser cannot
remove an already-recorded request. Never rewrite this route to the main app.
Production OAuth registrations remain empty until a provider's public-client,
issuer-response and CORS requirements are qualified. See
[ADR 0026](../../docs/decisions/0026-browser-oauth-callbacks.md).

To verify the built callback with an already-local nginx image, without pulling
or publishing an image:

```sh
npm run build --workspace @quixi/web
python3 tests/hosts/browser-oauth-deployment.py --image YOUR_LOCAL_NGINX_IMAGE
```
