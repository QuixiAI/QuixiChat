# Canonical migrations

`index.ts` is the authoritative ordered SQL source imported by the Storage Worker and the real WASM SQL tests. The private canonical migration runner commits each upgrade and its checksummed ledger entry together, rejects altered/future history, and preserves prior data on failure. A1 proof `user_version` is independent.

1. Canonical records, indexed ownership, deferred reference edges, atomic sync and transaction results.
2. Native identity/candidate/part uniqueness and SQL immutability guards.
3. Verified blob catalog, transfer state and local blob-operation idempotency.

These migrations are unreleased. After release, append a migration instead of editing an applied entry. Do not initialize canonical/blob tables through a second independent DDL path. See [ADR 0006](../../../docs/decisions/0006-canonical-persistence.md) and [SQL acceptance tests](../tests/canonical/repository.test.ts).
