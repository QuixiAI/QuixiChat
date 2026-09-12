# 0001: Shared product monorepo with thin hosts

Date: 2026-09-07
Status: accepted for the repository restructure

The original repository organized a native Gemma chat application into desktop,
server, engine, and kernel crates. The product specification instead requires a
provider-neutral local archive using one Storage Worker/SQLite WASM/OPFS backend
across desktop and web.

Use thin applications under `apps/`, shared product packages under `packages/`,
and independently deployable future services under `services/`. Keep QuixiEmbed
independently buildable inside the same repository so model contracts, numerical
validation, and product integration can change atomically.

Preserve the original implementation in `legacy/prototype/` as a standalone Cargo
workspace. Its source, lockfile, relative kernel paths, vendor patch, and build
instructions stay together. A local `archive/gemma-prototype` branch also records
the pre-restructure commit `d0eabe7`; the checked-in legacy directory provides
preservation in fresh clones without relying on that local branch.

The initial JavaScript toolchain is npm workspaces, TypeScript, and Vite. The
scaffold uses a minimal DOM shell and does not settle the product UI framework,
CPU kernel language, extension framework, relay stack, or Cloud implementation.
Subdirectories and additional packages should be created when concrete work
needs them. A1 and the first importer should drive subsequent architecture changes.
