# Restore controller checks

From the repository root with its pinned dependencies installed:

```sh
node --experimental-transform-types --test packages/app/src/features/archives/tests/restore-controller.test.mjs
npx tsc --noEmit -p tsconfig.json
```

The 16 Node tests exercise the real `stageArchiveRestore` workflow with controlled HostClient and StorageClient fixtures. They check chunk splitting and the submitted SHA-256, file/transfer cleanup, explicit review, source revision and selection invalidation, unsent draft/live work fences (including an asynchronous race), cancellation before and after file selection, stable cleanup retries, frozen activation arguments retained before dispatch, global receipt reconciliation, mismatched receipts and concurrent confirmation. They do not claim real TAR validation, browser dialog behavior, SQLite/OPFS execution or app remount acceptance; those require the production archive and shared-app browser suites.

`createRestoreController` takes storage, host, the fixed app-session selection, a global activation-status reader and `canReplace`. It exposes `choose`, explicit `resume(jobId)` for a ready candidate, `prepareReview`, `activate`, `checkActivation`, `release`, `cancel`, `dispose`, `subscribe` and `getSnapshot`. `RestorePanel` takes that controller and `onOpenRestored(receipt)`. The callback belongs to the parent app, which handles opening errors and session disposal. It is invoked from a separate button after controller work ends, never inside the activation job.

A dispatched activation keeps its full frozen arguments and operation UUID in this controller's app-session state. An unknown reply triggers one global status lookup and offers subsequent explicit checks; it never silently dispatches another activation, changes the expected selection or releases the candidate. This is not a cross-reload receipt-discovery mechanism. A known failed activation also stays associated with its original operation for inspection rather than automatically offering a new replacement.

Releasing ready restore work follows the storage contract: candidate storage remains retained. Cancelling preparation never activates the candidate. Saved unfinished response prefixes are preserved; this UI neither resumes provider requests nor infers producer loss from archive restoration.

Saved ready jobs are advanced under the current owner in slices capped at 64 records and 256 KiB before review. Cancellation cancels the outstanding request and releases the job (preserving candidate storage). A changed candidate summary is rejected. Focused tests cover multi-slice validation, cancellation and candidate identity fencing.
