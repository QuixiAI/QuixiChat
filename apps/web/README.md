# Web host

Browser composition root for the shared application. Run `npm run dev` from the
repository root. The same production build is served by hosted and Docker web.
The browser HostClient lives under `src/host/`; canonical storage stays in the
shared Storage Worker.

Local semantic search needs the separately provisioned embedding model. The
shared Vite tooling serves `packages/quixi-embed/build/arctic-xs.qxmodel` at
`/models/arctic-xs.qxmodel` in dev/preview and copies it to `dist/models/` when
it exists at build time; without it the Semantic search panel reports the model
as unavailable and Exact/Best lexical search keep working. The embedding worker
verifies the file against the pinned SHA-256 before use and caches the verified
copy in OPFS. Compile the model with `packages/quixi-embed/compiler/compile_model.py`
from the frozen reference (see `packages/quixi-embed/README.md`).
