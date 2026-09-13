# Self-hosted web (Docker/nginx): headers and origin behavior

Plan [24](../plans/24_validate_scale_and_release_hosts.md) task 7, the web
hosting part. `node tests/hosts/web-hosting-proof.mjs` builds nothing and
pulls nothing: it runs an already-built `quixi-web:local` image
(`docker build -f deploy/docker/Dockerfile -t quixi-web:local .`) on
loopback and checks it over HTTP and in Playwright's Chromium and WebKit.
Last run 2026-09-13 on macOS 26.6.2 (arm64), Docker 29.7.2, image
`sha256:2778ee3a6916…`; [retained report](results/web-hosting-macos.json),
41 HTTP checks and 7 per engine.

## What is checked

- **Isolation headers.** The root document and every asset it references
  (136 built files; the two embedding WASM modules and the SQLite module)
  carry `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`; both engines report
  `crossOriginIsolated === true` and still do after a reload on the same
  origin.
- **Media types.** Scripts as JavaScript, stylesheets as `text/css`, and
  every `.wasm` file as `application/wasm` (streaming compilation).
- **Origin behavior.** An application route (`/library/<id>`) falls back to
  the root document byte for byte; a missing asset under `/assets/` is a
  404, not the document; the assets directory is not listed.
- **Absent model.** `/models/arctic-xs.qxmodel` is a 404. Before this run
  the SPA fallback answered it with the application document and HTTP 200,
  which the embedding loader would have reported as a digest mismatch
  rather than "unavailable"; `nginx.conf` now has a `/models/` location.
- **Callback route.** `/oauth/callback.html` keeps its own policy
  (`Referrer-Policy: no-referrer`, `Cache-Control: no-store`, the
  restrictive CSP, COOP/COEP), does not reflect its query, and its requests
  are absent from nginx logs while ordinary requests are logged.
- **In the browser.** Onboarding's step 2 on the container origin reports
  `SQLite WASM / OPFS · schema 13 · integrity ok`, FTS5, WASM SIMD, WebGPU
  as the engine has it, and, new with this run, that the host names a local
  model it does not serve. Before this run the step claimed "Local model
  provided by this host" whenever the host was *configured* with a model
  URL; the onboarding controller now probes the URL with a same-origin
  HEAD (`probeModelUrl`: non-HTML success is available, any other answer,
  including a SPA fallback document, is missing, a failed request is
  unknown), with unit tests (`npm run test:app:onboarding`) and the
  onboarding browser proof (8 checks per engine) rerun.
- No page errors in either engine.

## Not covered

- TLS, a public reverse proxy or CDN, and Linux desktop browsers (the
  engines are Playwright's on macOS); an upstream proxy must preserve the
  headers above and the callback logging policy, as
  [deploy/docker/README.md](../../deploy/docker/README.md) states.
- Desktop installation, native integrations, release artifact integrity,
  signing/update configuration and upgrade persistence remain open on the
  same plan 24 task.
