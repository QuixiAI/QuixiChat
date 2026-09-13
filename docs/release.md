# Release: host support, measured limits, known issues, migration and checklist

Plan [24](plans/24_validate_scale_and_release_hosts.md) task 8. Every row
below points at retained evidence; nothing here is a promise beyond what was
measured. Optional Quixi Cloud (plans 25–26) and OCR (plan 15) are deferred
and are not local release blockers.

## Host support

| Host | State | Evidence |
| --- | --- | --- |
| Web, Chromium (Playwright build) on macOS | Supported | [storage-proof.md](validation/storage-proof.md), [shared-app.md](validation/shared-app.md) (101 checks per engine) |
| Web, WebKit (Playwright build) on macOS | Supported; persistent profile required for OPFS | same |
| Self-hosted web (Docker/nginx) | Supported with the shipped `nginx.conf` headers preserved by any proxy | [web-hosting.md](validation/web-hosting.md) |
| Desktop, macOS (Tauri 2, WKWebView) | Supported as an ad-hoc-signed developer bundle; not distributable until signed with a Developer ID | [desktop-bundle.md](validation/desktop-bundle.md), [storage-proof.md](validation/storage-proof.md) |
| Installed Safari | Unverified (remote automation disabled on the test machine) | [tests/hosts/safari.md](../tests/hosts/safari.md) |
| Linux desktop (WebKitGTK 2.50.6) | No-go: worker synchronous OPFS handles unsupported | [tests/hosts/linux/README.md](../tests/hosts/linux/README.md) |
| Windows (WebView2), other browsers and OS combinations | Unverified; provisional until the same artifact runs there | — |
| Browser extension (Chromium MV3) | Import path implemented; real chatgpt.com run pending | [extension-import.md](validation/extension-import.md) |

## Measured limits

Single runs on one macOS machine under development load unless noted.

| Area | Measured | Evidence |
| --- | --- | --- |
| Archive size | 100,000 conversations / 1,000,000 messages seeded through the worker (4.7 GB database) | [storage-stress.md](validation/storage-stress.md) |
| Startup at that size | landing 0.3–0.5 s after a cold reopen; first library page 9–42 ms; integrity check on request 56–67 s | same |
| Portable export at that size | 3,980 MB in 10,214 s over 62,679 bounded steps before the clean-copy batching; streamed to disk in 243 s | same (sixth attempt) |
| Export and restore at 30,000 messages | export 106 MB in 85–430 s; restore validation 133–178 s | [archive-scale.md](validation/archive-scale.md) |
| Lexical and semantic search | 101k chunks indexed; semantic query median about 0.45–0.49 s at 30,000 vectors | [search-scale.md](validation/search-scale.md), [semantic-search.md](validation/semantic-search.md) |
| PDF extraction | 1,000 pages in 30.7–54.9 s end to end; 1,001+ pages and files above 32 MiB refused by declared limits | [pdf-scale.md](validation/pdf-scale.md) |
| Attachments | quota on this machine about 10 GB (Chromium) and 20 GB (WebKit); 10–50 GB workloads not measurable here | [storage-stress.md](validation/storage-stress.md) |
| Startup integrity read | verified automatically up to 256 MiB; larger archives verify from Storage health | [ADR 0040](decisions/0040-diagnostics-outcomes.md) |

## Known issues

- Exporting a million-message archive takes hours in the browser; the
  per-step budgets (64 records / 256 KiB in the app) bound each step, not
  the total. The clean copy's per-row statement cost was cut after the
  sixth run; the seventh run measures the rest.
- The WebKit content process grew to about 5 GB resident during that
  export (observed, not yet attributed).
- The macOS bundle is ad-hoc signed and has no updater; Gatekeeper on
  another Mac will refuse it until it is signed and notarized.
- No embedding model ships in the Docker image or the desktop bundle; the
  model is provisioned separately and verified by digest.
- Live-provider qualification, official ChatGPT/Claude export captures,
  real chatgpt.com extension runs, assistive-technology sessions and
  other-hardware GPU runs remain open (plans 04, 06, 10, 11, 13, 19, 21).
- Hosted CI is disabled by the user's decision; verification is local.

## Migration and rollback

- The canonical schema is a ledger of 13 immutable migrations; a build
  applies missing ones forward on open and refuses an archive whose ledger
  is newer or differs ([ADR 0006](decisions/0006-canonical-persistence.md),
  [ADR 0016](decisions/0016-startup-failure-and-schema-recovery.md)).
  There is no silent downgrade.
- **Rollback** is a restore: take a portable export before upgrading (or
  use the previous build's export), install the previous build, and restore
  it into an isolated candidate that is validated and reviewed before
  activation ([ADR 0010](decisions/0010-portable-archives.md)). A newer
  archive cannot be opened by an older build; the retained reader can read
  an older archive read-only, and a rescue export copies exact bytes out of
  an archive that will not open.
- Portable archives from schema 8 onward restore into the current schema
  through the migration-aware candidate upgrade; the received bytes never
  change ([cross-host-restore.md](validation/cross-host-restore.md)).

## Release checklist

1. `npm run check` (SQLite artifact verification, typecheck, builds).
2. Storage: `npm run test:storage:canonical`, `test:storage:diagnostics`,
   `test:storage:archives`, `test:storage:protocol`, `test:storage:activation`,
   `test:storage:retained`.
3. Application: `npm run test:app:storage-health:browser`,
   `test:app:onboarding:browser`, the shared-app proof
   (`node packages/app/tests/browser/run.mjs`), `test:app:archives`.
4. Scale: `npm run test:app:stress:browser` (smoke); the full 1M run when
   storage code changed ([storage-stress.md](validation/storage-stress.md)).
5. Web hosting: `docker build -f deploy/docker/Dockerfile -t quixi-web:local .`
   then `node tests/hosts/web-hosting-proof.mjs`.
6. Desktop: `npm run build:desktop` with `APPLE_SIGNING_IDENTITY` set for
   distribution, then `node tests/hosts/desktop-bundle-proof.mjs`; notarize
   before publishing.
7. Update this page's measured limits and known issues from the retained
   reports, and the roadmap handoff.
