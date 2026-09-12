# 0002 — One SQLite owner with the OPFS SAH pool

**Status:** Accepted for the A1 proof and subsequent canonical storage work.

## Decision

Use the pinned SQLite WASM distribution containing FTS5 and sqlite-vec through
SQLite's official OPFS synchronous-access-handle pool VFS. The same worker and
artifact run in browser, Docker-served browser, and Tauri hosts. There is no native
or server-side canonical database. The proof's schema and records are isolated
from the forthcoming canonical archive.

Each client starts a dedicated worker. Workers compete for an exclusive Web Lock
scoped to the database namespace before initializing SQLite or acquiring pool
handles. Only the winner opens the database. Other workers forward bounded typed
requests over a same-origin BroadcastChannel; the owner serializes execution and
publishes change notifications. SQL handles never cross this boundary.

The owner holds the Web Lock until queued work drains, SQLite closes, and the VFS
releases its handles. Abrupt worker termination releases browser-owned locks;
the next owner opens the same files and SQLite recovers any uncommitted journal.
Previously dispatched requests are never automatically replayed after ownership
changes. They return `UNKNOWN_OUTCOME`, since a write might have committed before
its reply was lost. Canonical mutation identities and reconciliation in plans
02–03 must preserve this distinction.

## Rationale and constraints

- SAH-pool provides synchronous I/O inside the Storage Worker and does not require
  SharedArrayBuffer. Tauri's tested non-isolated custom origin works; web can keep
  isolation headers for later features without making them a storage prerequisite.
- SQLite's proxy-worker OPFS VFS and Web-Locks VFS are disabled at initialization.
  A single coordination mechanism makes database ownership explicit.
- Request payloads are checked before structured cloning and at worker ingress.
  Each client and owner queue is limited to 64 pending requests. Proof text is
  limited to 65,536 characters and list pages to 100 rows. These are proof limits;
  canonical streaming contracts will replace them with workload-specific limits.
- API presence does not establish OPFS availability. The worker probes the actual
  directory operation and reports denied/restricted sessions before opening an
  archive. The measured WebKit ephemeral context fails this operation, while a
  persistent profile succeeds.
- Browser quota errors can surface from SQLite as I/O errors. Keep the original
  error, provide storage/permission guidance, and do not mislabel every I/O failure
  as quota exhaustion. Do not retry writes automatically.

## Evidence and follow-up

See the [storage proof matrix](../validation/storage-proof.md),
[distribution checks](../../packages/storage/sqlite/VALIDATION.md),
[browser quota test](../../tests/diagnostics/QUOTA.md), and
[bundled Tauri proof](../../tests/hosts/README.md).

The proof establishes backend feasibility on the measured environments. It does
not establish all release hosts, large-archive limits, eviction resistance, or
power-loss durability. Those remain explicit A1/release validation work. Production
storage must add migration/version recovery, canonical transactions, blob
integrity, operation reconciliation, and archive restore without changing this
ownership boundary.
