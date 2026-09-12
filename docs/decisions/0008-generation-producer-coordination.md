# 0008 — Recover generations from producer loss

Status: Accepted; browser integration verified on Chromium and WebKit.

The [multi-tab storage owner](../product.md#12-multi-tab-ownership) and the context
running a provider request have different lifetimes. Closing the SQLite owner
must not end a [Generation](../product.md#18-generation) whose HTTP producer is
still alive in another tab.

The application acquires an exclusive per-archive, per-generation Web Lock in
the HTTP context before registering a durable producer row and before creating
the canonical attempt. The storage worker owns a separate archive lock. The
application holds its producer lock until transport and checkpoint persistence
finish. It never uses a heartbeat timeout to infer a crash.

The storage owner reconciles at most eight registered producers per maintenance
slice (explicit calls allow up to 32). It requests each producer lock with
`ifAvailable`. A held lock leaves that generation untouched. An acquired lock is
positive evidence that the original producer released it or its context ended.
While holding it, the worker commits a partial terminal state and one recovery
event atomically with their sync operations, preserving the committed prefix.
It then records a durable lost fence. Terminal generations settle without a
second terminal write. Unregistered/imported history is never guessed lost.

Registration precedes generation creation so that a crash between these steps
also leaves a fence: a delayed queued creation cannot resurrect that attempt.
Ordinary writes to a fenced attempt fail. Replaying an already committed
transaction still succeeds because replay reconciliation precedes the liveness
check. A new attempt uses new generation and producer identities.

`startCoordinatedGeneration` in `@quixi/app/workflows/generation` composes the
lease with provider persistence. A failed release-control reply does not hide
the generation result: dropping the lock still permits recovery from the durable
row. Provider HTTP is never retried by this coordinator. Actual disk quota can
also prevent the recovery transaction; the row remains eligible for a later
maintenance attempt after storage becomes writable.

This protocol coordinates cooperating contexts in one origin/storage partition.
It is not an authorization boundary between arbitrary same-origin scripts or a
cross-device liveness protocol. Cloud uses the separate plans 25–26 design.

Evidence: [production archive acceptance](../validation/archive-client.md)
exercises actual owner-tab termination, producer-tab termination, browser-process
restart, delayed creation, prefix preservation and committed retries.
`npm run test:providers:browser` exercises the application wrapper with actual
controlled HTTP streams, storage-owner handoff and interrupted persistence.
The provider quota case injects write failure at the client boundary; the
separate blob suite tests actual Chromium quota exhaustion.
