# WebKit OPFS initialization diagnosis

Measured on 2026-09-08 using the current `apps/web/dist` and the pinned SQLite 3.53.4 + sqlite-vec 0.1.9 distribution. Reproduce with:

```sh
node tests/diagnostics/webkit-storage.mjs
```

The script serves local diagnostic assets and the application on port 4177 (override `QUIXI_DIAGNOSTIC_PORT`). It owns and removes fresh temporary browser profiles. No application files are modified.

| Browser/context | Main-thread OPFS root | Worker OPFS/SAH | Worker Web Lock | SQLite SAH-pool and SQL | Actual proof UI |
| --- | --- | --- | --- | --- | --- |
| Chromium 153.0.8010.12, ephemeral | Pass | Pass, including write/flush/close | Pass | Pass | Local database ready |
| WebKit 26.6, ephemeral | `UnknownError` | Fails at `navigator.storage.getDirectory()` | Not reached | Not reached | Initialization error |
| WebKit 26.6, persistent | Pass | Pass, including write/flush/close | Pass | Pass | Local database ready |

The ephemeral failure is exactly `The operation failed for an unknown transient reason (e.g. out of memory).` It occurs before importing SQLite, installing its VFS, or entering Quixi's ownership coordination. API presence checks still report a secure context, Web Locks, StorageManager, and FileSystemSyncAccessHandle. Changing only the browser context to `webkit.launchPersistentContext(freshTemporaryProfile)` makes the unchanged binary and application work.

This establishes an ephemeral-session limitation for this tested Playwright WebKit build. It does not establish an application, WebLock, or sqlite-vec defect, nor does it establish behavior for every Safari/private-browsing release. WebKit's [OPFS introduction](https://webkit.org/blog/12257/the-file-system-access-api-with-origin-private-file-system/) documents private-session unavailability; current support claims should be based on the measured context and browser version.

Recommended changes:

- Use a fresh persistent WebKit profile for each supported-storage test fixture. Keep normal Chromium fixtures. Tests needing multiple tabs should create pages within the same persistent context.
- Add a distinct unavailable-storage test using the ephemeral WebKit context. Test actionable failure and disabled storage controls rather than expecting database initialization.
- Probe actual `navigator.storage.getDirectory()` availability in the Storage Worker before SQLite initialization. Wrap failure with an OPFS-specific explanation that mentions private/restricted sessions as possible causes. Preserve the original error details for diagnostics.
- Keep the universal OPFS backend. Do not introduce a memory, IndexedDB, or native canonical fallback to pass the unsupported-context test.

The diagnostic validates initialization and an actual SQL write, not complete reload/restart durability, owner failover, or the full host acceptance suite.
