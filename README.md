# Quixi

Your AI history, independent of the company that generated it.

Quixi is being rebuilt around a provider-neutral local archive shared by desktop
and web. The [product specification](docs/product.md) describes the destination;
the [architecture guide](docs/architecture.md) defines repository boundaries.

## Current status

The shared React app now has a durable conversation library, ChatGPT/Claude import,
lexical search, provider setup, streaming chat, and edit/regenerate branches.
Controlled HTTP tests exercise both provider adapters and browser-process restart
through the production SQLite WASM/OPFS worker. Archive export/restore and the
embedding scheduler are being integrated; the full roadmap is unfinished.
See [application evidence](docs/validation/shared-app.md), the
[implementation roadmap](docs/plans/README.md), and the
[platform matrix](docs/validation/storage-proof.md) for remaining gates.

The original runnable Gemma/Metal application is preserved intact in
[legacy/prototype](legacy/prototype/README.md), with its own Cargo workspace,
lockfile, kernels, vendor patch, build script, and documentation.

## Develop

Use Node.js 22.13 or newer and npm. Building the pinned SQLite distribution also
requires Python 3.12+, curl, and Docker with Linux containers. Desktop development
requires Rust 1.92+ and the platform's Tauri prerequisites.

```sh
npm ci
npm run sqlite:build
npm run dev
```

The web application is available at `http://127.0.0.1:5173`.
Visit `/storage-proof` for the developer harness. SQLite binaries are generated,
ignored artifacts; build them once before frontend development or checks, and
rebuild when the pinned sources change. `npm run sqlite:verify` checks their
hashes and executes the SQL smoke tests. CI builds this same artifact on Linux
and verifies it again in each consuming job. Docker builds it in a pinned SDK
stage without requiring generated files in the build context.

```sh
npm run dev:desktop
npm run check
npm run check:desktop
npm run build:desktop
```

`check` typechecks all TypeScript source and builds both frontend entry points.
`check:desktop` also checks the native host. `build:desktop` builds and bundles the
desktop application for the current platform; signing is not configured yet.
Cross-platform storage support remains subject to A1.

Desktop provider setup uses the native registered OpenAI and Anthropic endpoints.
The browser requires an operator-configured relay; without one, local import,
browsing and text search remain available. Set `VITE_QUIXI_RELAY_CONFIG` at build
or development-server startup to a JSON object containing `origin`, `operator`,
`privacy` (`self_hosted_remote`, `custom_remote` or `quixi_relay`) and
`destinations: {"openai": "registered-server-id", "anthropic": "registered-server-id"}`.
Use an HTTPS origin. This configuration is public routing metadata; enter provider
and relay credentials through the Providers screen, never in build variables.
The relay service must independently register the matching destinations.
Optional `regional` entries add US/Europe connections with a server-computed
configuration identity; each can name a separate reviewed relay origin/operator.
See the [regional relay setup](apps/web/src/host/README.md#regional-relays) for
provisioning and the operator trust boundary.

Browser integration checks run against production bundles:

```sh
npx playwright install chromium webkit
npm run test:app:browser
npm run test:e2e
```

Playwright WebKit results do not establish installed Safari or Tauri WebView
support. Browser reports and traces are generated under `test-results/`.

The independent encoder has a separate provisioning and validation entry:

```sh
python3 packages/quixi-embed/native/ci.py --browsers
```

It requires uv, clang, Docker, and Node, and provisions its pinned Python/model
inputs. Add `--full` for all scalar numerical and retrieval gates. CI runs the
smoke/browser checks on pushes and pull requests; a manual workflow run includes
the full scalar gate. See [QuixiEmbed](packages/quixi-embed/README.md) for the
runtime's current coverage and optimization work still outstanding.

## Layout

| Path | Responsibility |
| --- | --- |
| `apps/web` | Browser entry point and browser host adapter |
| `apps/desktop` | Desktop entry point and Tauri privileges |
| `apps/extension` | Future provider extraction and bundle transfer |
| `packages/app` | Shared UI and application workflows |
| `packages/core` | Canonical model, contracts, and pure rules |
| `packages/storage` | Storage Worker, SQLite WASM, OPFS, migrations, archives |
| `packages/providers` | Live provider adapters |
| `packages/importers` | Historical normalization, identity, provenance |
| `packages/search` | Shared chunking, retrieval orchestration, rank fusion |
| `packages/documents` | Document worker and text normalization |
| `packages/quixi-embed` | Independent embedding runtime and model compiler |
| `services` | Relay and planned optional Cloud services |
| `deploy` | Deployment configuration |
| `tests` | Cross-package integration, host tests, shared fixtures |
| `perf` | Product-scale benchmarks |
| `tooling` | Build and release orchestration |
| `legacy/prototype` | Original Gemma application, outside the active workspaces |

## Run the original prototype

On Apple silicon with the Metal toolchain:

```sh
cd legacy/prototype
cargo test --workspace --locked
cargo run --locked
```

The prototype still downloads its pinned model on first launch. Its history and
inference behavior are unchanged. It is not the implementation of the new spec.
