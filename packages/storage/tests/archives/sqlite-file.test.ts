import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import initialize from "../../sqlite/dist/sqlite3.mjs";
import { withSqliteFileReader } from "../../src/worker/archives/sqlite-file.ts";
import type {
  FileSqlite,
  FileDatabase,
} from "../../src/worker/archives/sqlite-file.ts";
const wasm = await readFile(
  new URL("../../sqlite/dist/sqlite3.wasm", import.meta.url),
);
const manifest = JSON.parse(
  await readFile(
    new URL("../../sqlite/artifacts.json", import.meta.url),
    "utf8",
  ),
);
assert.equal(
  createHash("sha256").update(wasm).digest("hex"),
  manifest.artifacts["sqlite3.wasm"].sha256,
);
(globalThis as any).sqlite3ApiConfig = {
  disable: { vfs: { opfs: true, "opfs-wl": true } },
};
const options = {
  instantiateWasm: async (
    imports: WebAssembly.Imports,
    success: (
      instance: WebAssembly.Instance,
      module: WebAssembly.Module,
    ) => void,
  ) => {
    const result = await WebAssembly.instantiate(wasm, imports);
    success(result.instance, result.module);
  },
  print: () => {},
  printErr: () => {},
};
const sqlite = (await initialize(options)) as FileSqlite & {
  oo1: {
    DB: new (name: string, flags: string) => FileDatabase & { close(): void };
  };
  capi: FileSqlite["capi"] & { sqlite3_js_db_export(db: number): Uint8Array };
};

test("pinned WASM file-pointer copy uses <=64 KiB blocks and matches independent SQLite export", async () => {
  const db = new sqlite.oo1.DB("/archive-copy-proof.sqlite3", "c");
  try {
    db.exec(
      "PRAGMA journal_mode=DELETE; CREATE TABLE proof(id INTEGER PRIMARY KEY, body BLOB); INSERT INTO proof VALUES(1,zeroblob(5242897));",
    );
    const expected = createHash("sha256")
      .update(sqlite.capi.sqlite3_js_db_export(db.pointer))
      .digest("hex");
    let blocks = 0,
      peak = 0;
    const actual = await withSqliteFileReader(sqlite, db, async (reader) => {
      const hash = createHash("sha256");
      for (let offset = 0; offset < reader.byteLength; offset += 65536) {
        const block = reader.read(offset, 65536);
        peak = Math.max(peak, block.length);
        hash.update(block);
        blocks++;
      }
      return hash.digest("hex");
    });
    assert.equal(actual, expected);
    assert.equal(peak, 65536);
    assert(blocks > 80);
    db.exec("INSERT INTO proof VALUES(2,zeroblob(1))");
    assert.equal(db.selectValue("SELECT count(*) FROM proof"), 2);
  } finally {
    db.close();
  }
});
test("cancelled bounded copy releases its read transaction and invalidates retained readers", async () => {
  const db = new sqlite.oo1.DB("/archive-copy-cancel.sqlite3", "c"),
    controller = new AbortController();
  try {
    db.exec("CREATE TABLE proof(id INTEGER)");
    let retained:
      | Parameters<Parameters<typeof withSqliteFileReader>[2]>[0]
      | undefined;
    await assert.rejects(
      withSqliteFileReader(
        sqlite,
        db,
        async (reader) => {
          retained = reader;
          controller.abort();
          reader.read(0, 512);
        },
        controller.signal,
      ),
      /cancelled/,
    );
    assert.throws(() => retained!.read(0, 512), /closed/);
    db.exec("INSERT INTO proof VALUES(1)");
  } finally {
    db.close();
  }
});

test("bounded fresh-schema copy retains canonical bytes and omits residual private staging pages", async () => {
  const { CanonicalRepository } = await import(
    "../../src/worker/canonical/repository.ts"
  );
  const { CleanSnapshotCopy } = await import(
    "../../src/worker/archives/clean-copy.ts"
  );
  const { snapshotSummary } = await import(
    "../../src/worker/archives/snapshot.ts"
  );
  const source = new sqlite.oo1.DB("/archive-clean-source.sqlite3", "c"),
    target = new sqlite.oo1.DB("/archive-clean-target.sqlite3", "c");
  try {
    new CanonicalRepository(source, { assertBlobAvailable() {} }).migrate();
    const privateMarker = "excluded_uncommitted_import_" + "z".repeat(100000);
    source.exec({
      sql: "INSERT INTO quixi_import_runs VALUES(?,?)",
      bind: [
        "synthetic-private-run",
        JSON.stringify({ privateMarker: privateMarker.slice(0, 60000) }),
      ],
    });
    source.exec({
      sql: "INSERT INTO quixi_local_state VALUES('defaultWorkspaceId',?)",
      bind: [JSON.stringify("00000000-0000-4000-8000-000000000007")],
    });
    const { PreferenceRepository } = await import("../../src/worker/preferences.ts");
    new PreferenceRepository(source).setSendKey({ expectedRevision: 0, sendKey: "enter" });
    const savedPreferences = new PreferenceRepository(source).setInteractionPreferences({ expectedRevision: 1, preferences: {
      showTimestamps: true, showModelBadges: false, composerLayout: "compact", modelSwitcherStyle: "list",
    } });
    const { RoutingAliasRepository } = await import("../../src/worker/routing-aliases.ts");
    new RoutingAliasRepository(source).write("putRoutingAlias", { expectedRevision: 0, alias: {
      id: "00000000-0000-4000-8000-000000000008", name: "Coding", primary: { provider: "synthetic", model: "first" }, candidates: [], requirements: {}, allowPrivacyChange: false,
    } });
    const record = {
      id: "00000000-0000-4000-8000-000000000001",
      provider: "synthetic",
      method: "fixture",
      sourceThreadId: null,
      sourceUrl: null,
      importerName: "archive-proof",
      importerVersion: "1",
      sourceFormatVersion: null,
      sourceFingerprint: null,
      importedAt: 1700000000000,
    };
    source.exec({
      sql: "INSERT INTO quixi_records(collection,id,payload) VALUES('importSources',?,?)",
      bind: [record.id, JSON.stringify(record)],
    });
    const copier = new CleanSnapshotCopy(source, target);
    let steps = 0;
    while (!copier.step(1)) {
      if (++steps > 100) throw new Error("Copy did not finish.");
    }
    assert.equal(
      target.selectValue("SELECT payload FROM quixi_records"),
      JSON.stringify(record),
    );
    assert.equal(
      target.selectValue("SELECT count(*) FROM quixi_import_runs"),
      0,
    );
    assert.equal(
      snapshotSummary(target).defaultWorkspaceId,
      "00000000-0000-4000-8000-000000000007",
    );
    assert.equal(
      Buffer.from(sqlite.capi.sqlite3_js_db_export(target.pointer)).includes(
        Buffer.from("excluded_uncommitted_import_"),
      ),
      false,
    );
    assert.equal(target.selectValue("PRAGMA integrity_check"), "ok");
    const { DEFAULT_LOCAL_PREFERENCES } = await import("@quixi/core/contracts");
    assert.deepEqual(new PreferenceRepository(target).read(), DEFAULT_LOCAL_PREFERENCES);
    assert.equal(target.selectValue("SELECT count(*) FROM quixi_local_state"), 1);
    assert.deepEqual(new PreferenceRepository(source).read(), savedPreferences);
    assert.deepEqual(new RoutingAliasRepository(target).read().aliases, []);
    assert.equal(new RoutingAliasRepository(source).read().aliases.length, 1);
    assert.equal(
      source.selectValue("SELECT count(*) FROM quixi_import_runs"),
      1,
    );
  } finally {
    source.close();
    target.close();
  }
});

test("snapshot admission and mid-copy failures preserve source and unlink only private output", async () => {
  const { copySnapshot } = await import("../../src/worker/archives/snapshot.ts");
  const source = new sqlite.oo1.DB("/archive-failed-copy.sqlite3", "c");
  source.exec("CREATE TABLE proof(id INTEGER); INSERT INTO proof VALUES(1)");
  const unlinked: string[] = [];
  const pool = {
    OpfsSAHPoolDb: class { constructor(_name: string) { throw new Error("Synthetic capacity write failure"); } },
    async reserveMinimumCapacity() { return 10; },
    unlink(name: string) { unlinked.push(name); return true; },
  };
  const name = "/export-00000000-0000-4000-8000-000000000010.sqlite3";
  try {
    await assert.rejects(copySnapshot(sqlite as any, pool as any, source, name), /capacity write/);
    assert.deepEqual(unlinked, [name]);
    assert.equal(source.selectValue("SELECT count(*) FROM proof"), 1);
    source.exec("INSERT INTO proof VALUES(2)");
    const admission = { ...pool, async reserveMinimumCapacity() { throw new Error("Synthetic pool admission failure"); } };
    await assert.rejects(copySnapshot(sqlite as any, admission as any, source, name), /admission/);
    assert.equal(source.selectValue("SELECT count(*) FROM proof"), 2);
    assert.deepEqual(unlinked, [name], "admission failure opens nothing, so nothing more is unlinked");
  } finally {
    source.close();
  }
});

test("restore rejects unexpected executable schema before any canonical validation", async () => {
  const { CanonicalRepository } = await import(
    "../../src/worker/canonical/repository.ts"
  );
  const { ArchiveSchemaValidator, restrictRestoreConnection } = await import(
    "../../src/worker/archives/schema-validation.ts"
  );
  const { sqlRows } = await import("../../src/worker/archives/snapshot.ts");
  const source = new sqlite.oo1.DB("/archive-schema-reject.sqlite3", "c");
  try {
    new CanonicalRepository(source, { assertBlobAvailable() {} }).migrate();
    const expected = sqlRows(
      source,
      "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name",
    ).map((row) => ({
      type: String(row.type),
      name: String(row.name),
      table: String(row.tbl_name),
      sql: row.sql === null ? null : String(row.sql),
    }));
    source.exec(
      "CREATE TRIGGER archive_unapproved_trigger BEFORE INSERT ON quixi_records BEGIN SELECT RAISE(ABORT,'must never execute'); END;",
    );
    restrictRestoreConnection(sqlite, source);
    assert.throws(
      () => new ArchiveSchemaValidator(source, expected).step(4),
      /unexpected/,
    );
    assert.equal(source.selectValue("SELECT count(*) FROM quixi_records"), 0);
  } finally {
    source.close();
  }
});

for (const [name, damage, pattern] of [
  [
    "cycle",
    (db: any, ids: string[]) => {
      const sql = db.selectValue(
        "SELECT sql FROM sqlite_schema WHERE name='quixi_message_immutable'",
      );
      db.exec("DROP TRIGGER quixi_message_immutable");
      db.exec({
        sql: "UPDATE quixi_records SET payload=json_set(payload,'$.parentId',?) WHERE collection='messages' AND id=?",
        bind: [ids[3], ids[2]],
      });
      db.exec({
        sql: "INSERT INTO quixi_edges VALUES('messages',?,'parentId','messages',?)",
        bind: [ids[2], ids[3]],
      });
      db.exec(sql);
    },
    /cycle/,
  ],
  [
    "edge",
    (db: any) =>
      db.exec(
        "DELETE FROM quixi_edges WHERE field='threadId' AND owner_collection='messages'",
      ),
    /edge coverage/,
  ],
  [
    "journal digest",
    (db: any) =>
      db.exec("UPDATE quixi_sync_ops SET identity='corrupt' WHERE sequence=1"),
    /digest differs/,
  ],
  [
    "journal coverage",
    (db: any) =>
      db.exec("UPDATE quixi_sync_ops SET affects='[]' WHERE sequence=1"),
    /coverage differs/,
  ],
  [
    "orphan published import",
    (db: any, ids: string[]) =>
      db.exec({
        sql: "INSERT INTO quixi_import_jobs(id,thread_id,mode,recorded_at,state,publication_operation_id) VALUES(?,?,'extend',0,'published',?)",
        bind: [crypto.randomUUID(), ids[0], crypto.randomUUID()],
      }),
    /matching journal group/,
  ],
] as const)
  test(
    "bounded restore validation rejects " +
      name +
      " without modifying candidate",
    async () => {
      const { CanonicalRepository } = await import(
          "../../src/worker/canonical/repository.ts"
        ),
        { CanonicalArchiveValidator } = await import(
          "../../src/worker/archives/validation.ts"
        ),
        { snapshotSummary, sqlRows } = await import(
          "../../src/worker/archives/snapshot.ts"
        ),
        { ARCHIVE_EXCLUDED } = await import(
          "../../src/worker/archives/format.ts"
        ),
        { restrictRestoreConnection } = await import(
          "../../src/worker/archives/schema-validation.ts"
        );
      const candidate = new sqlite.oo1.DB(
          "/invalid-" + crypto.randomUUID() + ".sqlite3",
          "c",
        ),
        scratch = new sqlite.oo1.DB(
          "/scratch-" + crypto.randomUUID() + ".sqlite3",
          "c",
        ),
        ids = Array.from({ length: 4 }, () => crypto.randomUUID()),
        now = 1700000000000;
      try {
        const canonical = new CanonicalRepository(candidate, {
          assertBlobAvailable() {},
        });
        canonical.migrate();
        const mutation = (kind: string, payload: unknown) => ({
          version: 1,
          operationId: crypto.randomUUID(),
          kind,
          recordedAt: now,
          payload,
        });
        const threadId = ids[0]!,
          contextId = ids[1]!;
        canonical.commit({
          transactionId: crypto.randomUUID(),
          expectedThreadRevisions: [],
          stagedBlobIds: [],
          mutations: [
            mutation("CreateThread", {
              thread: {
                id: threadId,
                workspaceId: crypto.randomUUID(),
                createdAt: now,
                recordedAt: now,
                systemPrompt: null,
                preferredRoute: null,
                importSourceId: null,
              },
              context: {
                id: contextId,
                threadId,
                previousId: null,
                version: 1,
                systemPrompt: null,
                preferredRoute: null,
                recordedAt: now,
              },
              state: {
                threadId,
                title: "Fixture",
                tags: [],
                pinned: false,
                archived: false,
                activeLeafMessageId: null,
                contextSnapshotId: contextId,
                routingProfile: null,
                revision: 0,
              },
            }),
            ...ids
              .slice(2)
              .map((id, index) =>
                mutation("CreateMessage", {
                  message: {
                    id,
                    threadId,
                    parentId: index ? ids[2] : null,
                    role: "user",
                    createdAt: now,
                    recordedAt: now,
                    generationId: null,
                    editedFromMessageId: null,
                    partCount: 0,
                    sealed: true,
                  },
                  parts: [],
                }),
              ),
          ] as any,
        });
        damage(candidate, ids);
        scratch.exec(
          "CREATE TABLE quixi_archive_received_entries(job_id TEXT,path TEXT,byte_length INTEGER,sha256 TEXT)",
        );
        const manifest = {
          format: "quixi-archive",
          version: 1,
          kind: "portable",
          source: {
            ...snapshotSummary(candidate),
            migrations: sqlRows(
              candidate,
              "SELECT version,name,checksum FROM quixi_schema_migrations ORDER BY version",
            ),
          },
          inventory: {
            path: "checksums.jsonl",
            byteLength: 0,
            sha256: "0".repeat(64),
            entries: 2,
          },
          excluded: ARCHIVE_EXCLUDED,
        };
        const before = createHash("sha256")
          .update(sqlite.capi.sqlite3_js_db_export(candidate.pointer))
          .digest("hex");
        restrictRestoreConnection(sqlite, candidate);
        const validator = new CanonicalArchiveValidator(
          candidate,
          scratch,
          crypto.randomUUID(),
          manifest as any,
        );
        assert.throws(() => {
          for (let step = 0; step < 1000; step++) {
            if (validator.step(1).phase === "ready") return;
          }
          throw new Error("Unbounded validation");
        }, pattern);
        assert.equal(
          createHash("sha256")
            .update(sqlite.capi.sqlite3_js_db_export(candidate.pointer))
            .digest("hex"),
          before,
        );
      } finally {
        candidate.close();
        scratch.close();
      }
    },
  );

test("stepped snapshot copy never exceeds a step's byte budget, matches the independent export and closes cleanly", async () => {
  const { SnapshotCopier } = await import("../../src/worker/archives/snapshot.ts");
  const source = new sqlite.oo1.DB("/archive-stepped-copy.sqlite3", "c");
  try {
    source.exec("PRAGMA journal_mode=DELETE; CREATE TABLE proof(id INTEGER PRIMARY KEY, body BLOB); INSERT INTO proof VALUES(1,zeroblob(1048577));");
    const expected = createHash("sha256").update(sqlite.capi.sqlite3_js_db_export(source.pointer)).digest("hex");
    const unlinked: string[] = [];
    const pool = {
      OpfsSAHPoolDb: class { constructor(name: string) { return new sqlite.oo1.DB(name, "c"); } },
      async reserveMinimumCapacity() { return 10; },
      unlink(name: string) { unlinked.push(name); return true; },
    };
    const name = "/export-00000000-0000-4000-8000-000000000011.sqlite3";
    const copier = new SnapshotCopier(sqlite as any, pool as any, source, name);
    const budget = 70_000; let steps = 0, previous = 0, db = null;
    while (!db) {
      db = await copier.advance(budget); steps++;
      assert.ok(copier.copiedBytes - previous <= budget, "a step copied more than its budget");
      assert.ok(db || copier.copiedBytes > previous, "a step made no progress");
      previous = copier.copiedBytes;
    }
    assert.equal(copier.copiedBytes, copier.totalBytes);
    assert.equal(steps, Math.ceil(copier.totalBytes! / budget));
    const copy = db as unknown as FileDatabase & { close(): void };
    assert.equal(createHash("sha256").update(sqlite.capi.sqlite3_js_db_export(copy.pointer)).digest("hex"), expected);
    assert.equal(copy.selectValue("SELECT count(*) FROM proof"), 1);
    copy.close();
    // A completed copy is kept.
    assert.deepEqual(unlinked, []);
    // The source is writable again once the copy released its read transaction.
    source.exec("INSERT INTO proof VALUES(2,zeroblob(1))");
    // Closing between steps releases the transaction and unlinks the private output.
    const released = new SnapshotCopier(sqlite as any, pool as any, source, name);
    assert.equal(await released.advance(budget), null);
    released.close();
    await assert.rejects(released.advance(budget), /closed/);
    assert.deepEqual(unlinked, [name]);
    source.exec("INSERT INTO proof VALUES(3,zeroblob(1))");
    // Closing before the first step.
    const early = new SnapshotCopier(sqlite as any, pool as any, source, name);
    early.close();
    await assert.rejects(early.advance(budget), /closed/);
    assert.equal(source.selectValue("SELECT count(*) FROM proof"), 3);
  } finally {
    source.close();
  }
});

test("a bounded copy from a plain byte source lands the exact bytes as a pool database in budgeted steps", async () => {
  const { BoundedFileCopier } = await import("../../src/worker/archives/snapshot.ts");
  const source = new sqlite.oo1.DB("/archive-byte-source.sqlite3", "c");
  try {
    source.exec("PRAGMA journal_mode=DELETE; CREATE TABLE proof(id INTEGER PRIMARY KEY, body BLOB); INSERT INTO proof VALUES(1,zeroblob(524289)), (2,zeroblob(7));");
    const bytes = sqlite.capi.sqlite3_js_db_export(source.pointer);
    const expected = createHash("sha256").update(bytes).digest("hex");
    const unlinked: string[] = [];
    const pool = { OpfsSAHPoolDb: class { constructor(name: string) { return new sqlite.oo1.DB(name, "c"); } }, async reserveMinimumCapacity() { return 10; }, unlink(name: string) { unlinked.push(name); return true; } };
    let closedSource = 0;
    const open = () => ({ byteLength: bytes.length, read: (offset: number, max: number) => bytes.slice(offset, Math.min(offset + max, bytes.length)), close: () => { closedSource++; } });
    const copier = new BoundedFileCopier(sqlite as any, pool as any, "/archive.sqlite3", open, () => "finished");
    let steps = 0, previous = 0, value: string | null = null;
    while (!value) { value = await copier.advance(100_000); steps++; assert.ok(copier.copiedBytes - previous <= 100_000); previous = copier.copiedBytes; }
    assert.equal(value, "finished"); assert.equal(steps, Math.ceil(bytes.length / 100_000)); assert.equal(closedSource, 1);
    const copy = new sqlite.oo1.DB("/archive.sqlite3", "r");
    try { assert.equal(createHash("sha256").update(sqlite.capi.sqlite3_js_db_export(copy.pointer)).digest("hex"), expected); assert.equal(copy.selectValue("SELECT count(*) FROM proof"), 2); } finally { copy.close(); }
    assert.deepEqual(unlinked, []);
    const released = new BoundedFileCopier(sqlite as any, pool as any, "/archive-released.sqlite3", open, () => true);
    assert.equal(await released.advance(65_536), null); released.close();
    await assert.rejects(released.advance(65_536), /closed/); assert.deepEqual(unlinked, ["/archive-released.sqlite3"]); assert.equal(closedSource, 2);
  } finally { source.close(); }
});
