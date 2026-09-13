import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import initialize from "../../sqlite/dist/sqlite3.mjs";
import { CanonicalRepository } from "../../src/worker/canonical/index.ts";
import type { CanonicalSqlite } from "../../src/worker/canonical/index.ts";
import { ViewRepository } from "../../src/worker/views.ts";
import { PreferenceRepository } from "../../src/worker/preferences.ts";
import { RoutingAliasRepository } from "../../src/worker/routing-aliases.ts";
import { routingAliasSnapshot } from "@quixi/core/contracts";
import { assertPreferenceArgs, DEFAULT_LOCAL_PREFERENCES } from "@quixi/core/contracts";
import type { CanonicalMutation } from "@quixi/core/contracts";
const wasm = await readFile(
  new URL("../../sqlite/dist/sqlite3.wasm", import.meta.url),
);
(
  globalThis as typeof globalThis & { sqlite3ApiConfig: unknown }
).sqlite3ApiConfig = { disable: { vfs: { opfs: true, "opfs-wl": true } } };
const initOptions = {
  instantiateWasm: async (
    imports: WebAssembly.Imports,
    ready: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ) => {
    const result = await WebAssembly.instantiate(wasm, imports);
    ready(result.instance, result.module);
  },
  print: () => {},
  printErr: () => {},
};
const sqlite = (await initialize(initOptions)) as {
  oo1: {
    DB: new (
      name: string,
      flags: string,
    ) => CanonicalSqlite & { close(): void };
  };
};
const id = () => crypto.randomUUID(),
  now = 1_788_870_000_000;
const page = { maxItems: 16, maxBytes: 100_000, cursor: null };
const routingAlias = () => ({ id: id(), name: "Coding", primary: { provider: "a", model: "first" }, candidates: [{ provider: "b", model: "next" }], requirements: { contextAtLeast: 100000 }, allowPrivacyChange: false });
const interactionPreferences = { showTimestamps: true, showModelBadges: false, composerLayout: "compact", modelSwitcherStyle: "list" } as const;
function open() {
  const db = new sqlite.oo1.DB(`/${id()}.sqlite3`, "c");
  const repository = new CanonicalRepository(db, {
    assertBlobAvailable: () => {},
  });
  repository.migrate();
  return { db, repository, views: new ViewRepository(db, repository) };
}

test("routing aliases persist independently, reject stale/duplicate writes and reopen exactly", () => {
  const { db } = open();
  const aliases = new RoutingAliasRepository(db), value = routingAlias();
  assert.deepEqual(aliases.read(), { version: 1, revision: 0, aliases: [] });
  assert.equal(db.selectValue("SELECT count(*) FROM quixi_local_state"), 0);
  const saved = aliases.write("putRoutingAlias", { expectedRevision: 0, alias: value });
  assert.equal(db.selectValue("SELECT count(*) FROM quixi_sync_ops"), 0);
  assert.throws(() => aliases.write("removeRoutingAlias", { expectedRevision: 0, aliasId: value.id }), /changed/);
  assert.throws(() => aliases.write("putRoutingAlias", { expectedRevision: 1, alias: { ...value, id: id() } }), /unique/);
  assert.deepEqual(aliases.read(), saved);
  const name = String(db.selectValue("SELECT file FROM pragma_database_list WHERE name='main'"));
  db.close();
  const next = new sqlite.oo1.DB(name, "w");
  try {
    const reopened = new RoutingAliasRepository(next);
    assert.deepEqual(reopened.read(), saved);
    assert.equal(reopened.write("putRoutingAlias", { expectedRevision: 1, alias: { ...value, name: "Fast" } }).revision, 2);
    assert.deepEqual(reopened.write("removeRoutingAlias", { expectedRevision: 2, aliasId: value.id }), { version: 1, revision: 3, aliases: [] });
    assert.equal(new PreferenceRepository(next).read().sendKey, "mod-enter");
  } finally { next.close(); }
});

test("unsupported alias data is preserved and an interrupted registry update rolls back", () => {
  const { db } = open(), value = routingAlias();
  try {
    const aliases = new RoutingAliasRepository(db);
    db.exec("INSERT INTO quixi_local_state VALUES('routingAliases','{\"version\":999}')");
    assert.throws(() => aliases.read(), /preserved/);
    assert.throws(() => aliases.write("putRoutingAlias", { expectedRevision: 0, alias: value }), /preserved/);
    assert.equal(db.selectValue("SELECT value FROM quixi_local_state WHERE key='routingAliases'"), '{"version":999}');
    db.exec("DELETE FROM quixi_local_state"); db.exec("BEGIN");
    aliases.write("putRoutingAlias", { expectedRevision: 0, alias: value }); db.exec("ROLLBACK");
    assert.deepEqual(aliases.read().aliases, []);
  } finally { db.close(); }
});

test("alias application is an atomic canonical copy; edits and deletion never change it", () => {
  const { db, repository } = open();
  try {
    const threadId = thread(repository, "Applied alias"), value = routingAlias();
    const aliases = new RoutingAliasRepository(db);
    aliases.write("putRoutingAlias", { expectedRevision: 0, alias: value });
    const snapshot = routingAliasSnapshot(value, 1);
    const mutation: CanonicalMutation = { version: 1, operationId: id(), recordedAt: now, kind: "SetRoutingProfile", payload: { threadId, value: snapshot } };
    const batch = { transactionId: id(), mutations: [mutation], expectedThreadRevisions: [{ threadId, revision: repository.get("threadStates", threadId)!.revision }], stagedBlobIds: [] };
    const refusing = new CanonicalRepository(db, { assertBlobAvailable() {}, beforeCommit() { throw new Error("Interrupted before commit"); } });
    assert.throws(() => refusing.commit(batch), /Interrupted/);
    assert.equal(repository.get("threadStates", threadId)!.routingProfile, null);
    assert.equal(repository.operationStatus(mutation.operationId).status, "not_found");
    repository.commit(batch);
    aliases.write("putRoutingAlias", { expectedRevision: 1, alias: { ...value, name: "Changed", primary: { provider: "elsewhere", model: "new" } } });
    aliases.write("removeRoutingAlias", { expectedRevision: 2, aliasId: value.id });
    assert.deepEqual(repository.get("threadStates", threadId)!.routingProfile, snapshot);
    const stored = JSON.parse(String(db.selectValue("SELECT payload FROM quixi_sync_ops WHERE operation_id=?", [mutation.operationId])));
    assert.deepEqual(stored, mutation.payload);
    assert.doesNotThrow(() => repository.commit(batch));
    assert.deepEqual(repository.get("threadStates", threadId)!.routingProfile, snapshot);
  } finally { db.close(); }
});
const commit = (repo: CanonicalRepository, ...mutations: CanonicalMutation[]) =>
  repo.commit({
    transactionId: id(),
    mutations,
    expectedThreadRevisions: [],
    stagedBlobIds: [],
  });

test("local preferences default without writes, reject stale edits and survive reopening the database", () => {
  const { db } = open();
  const preferences = new PreferenceRepository(db);
  assert.deepEqual(preferences.read(), DEFAULT_LOCAL_PREFERENCES);
  assert.equal(db.selectValue("SELECT count(*) FROM quixi_local_state"), 0);
  const interactions = preferences.setInteractionPreferences({ expectedRevision: 0, preferences: interactionPreferences });
  assert.deepEqual(interactions, { ...DEFAULT_LOCAL_PREFERENCES, ...interactionPreferences, revision: 1 });
  const saved = preferences.setSendKey({ expectedRevision: 1, sendKey: "enter" });
  assert.deepEqual(saved, { ...interactions, revision: 2, sendKey: "enter" });
  assert.throws(() => preferences.setSendKey({ expectedRevision: 0, sendKey: "mod-enter" }), /changed in another view/);
  assert.throws(() => preferences.setInteractionPreferences({ expectedRevision: 1, preferences: interactionPreferences }), /changed in another view/);
  assert.deepEqual(preferences.read(), saved);
  assert.equal(db.selectValue("SELECT count(*) FROM quixi_sync_ops"), 0);
  assert.equal(db.selectValue("SELECT count(*) FROM quixi_records"), 0);
  // Reopen the actual SQLite file rather than reconstructing a repository only.
  const name = db.selectValue("SELECT file FROM pragma_database_list WHERE name='main'");
  db.close();
  const reopened = new sqlite.oo1.DB(String(name), "w");
  try { assert.deepEqual(new PreferenceRepository(reopened).read(), saved); }
  finally { reopened.close(); }
});

test("closed legacy preference rows normalize on read without rewriting and upgrade only on explicit edit", () => {
  const { db } = open();
  const legacy = '{"version":1,"revision":7,"sendKey":"enter"}';
  db.exec({ sql: "INSERT INTO quixi_local_state VALUES('interactionPreferences',?)", bind: [legacy] });
  const expected = { ...DEFAULT_LOCAL_PREFERENCES, revision: 7, sendKey: "enter" };
  assert.deepEqual(new PreferenceRepository(db).read(), expected);
  assert.equal(db.selectValue("SELECT value FROM quixi_local_state WHERE key='interactionPreferences'"), legacy);
  const name = String(db.selectValue("SELECT file FROM pragma_database_list WHERE name='main'"));
  db.close();
  const reopened = new sqlite.oo1.DB(name, "w");
  try {
    const preferences = new PreferenceRepository(reopened);
    assert.deepEqual(preferences.read(), expected);
    assert.equal(reopened.selectValue("SELECT value FROM quixi_local_state WHERE key='interactionPreferences'"), legacy);
    const saved = preferences.setInteractionPreferences({ expectedRevision: 7, preferences: interactionPreferences });
    assert.deepEqual(saved, { ...expected, ...interactionPreferences, revision: 8 });
    assert.deepEqual(JSON.parse(String(reopened.selectValue("SELECT value FROM quixi_local_state WHERE key='interactionPreferences'"))), saved);
    assert.equal(reopened.selectValue("SELECT count(*) FROM quixi_sync_ops"), 0);
    assert.equal(reopened.selectValue("SELECT count(*) FROM quixi_records"), 0);
  } finally { reopened.close(); }
});

test("local preferences preserve unsupported rows and roll back interrupted writes", () => {
  const { db } = open();
  try {
    const preferences = new PreferenceRepository(db);
    for (const value of [{ version: 2, revision: 0, sendKey: "enter" }, { ...DEFAULT_LOCAL_PREFERENCES, version: 5 },
      { ...DEFAULT_LOCAL_PREFERENCES, showTimestamps: "yes" }, { ...DEFAULT_LOCAL_PREFERENCES, future: true },
      { version: 1, revision: 0, sendKey: "unknown" }, {}, { version: 1, revision: 1, sendKey: "enter", secret: "refused" }]) {
      db.exec({ sql: "INSERT OR REPLACE INTO quixi_local_state VALUES('interactionPreferences',?)", bind: [JSON.stringify(value)] });
      assert.throws(() => preferences.read(), /preserved/);
      assert.throws(() => preferences.setSendKey({ expectedRevision: 0, sendKey: "enter" }), /preserved/);
      assert.throws(() => preferences.setInteractionPreferences({ expectedRevision: 0, preferences: interactionPreferences }), /preserved/);
      assert.equal(db.selectValue("SELECT value FROM quixi_local_state WHERE key='interactionPreferences'"), JSON.stringify(value));
    }
    db.exec("DELETE FROM quixi_local_state");
    db.exec("BEGIN");
    preferences.setSendKey({ expectedRevision: 0, sendKey: "enter" });
    preferences.setInteractionPreferences({ expectedRevision: 1, preferences: interactionPreferences });
    db.exec("ROLLBACK");
    assert.deepEqual(preferences.read(), DEFAULT_LOCAL_PREFERENCES);
  } finally { db.close(); }
});

test("conditional preference update refuses a changed SQL revision without overwriting the competing value", () => {
  const { db } = open();
  try {
    const preferences = new PreferenceRepository(db);
    preferences.setSendKey({ expectedRevision: 0, sendKey: "enter" });
    const competing = { ...DEFAULT_LOCAL_PREFERENCES, revision: 2, sendKey: "enter" };
    let inject = true;
    const concurrent: CanonicalSqlite = {
      selectValue: (sql, bind) => db.selectValue(sql, bind),
      exec(options) {
        if (inject) {
          inject = false;
          db.exec({ sql: "UPDATE quixi_local_state SET value=? WHERE key='interactionPreferences'", bind: [JSON.stringify(competing)] });
        }
        return db.exec(options);
      },
    };
    assert.throws(() => new PreferenceRepository(concurrent).setInteractionPreferences({ expectedRevision: 1, preferences: interactionPreferences }), /changed in another view/);
    assert.deepEqual(preferences.read(), competing);
    assert.equal(db.selectValue("SELECT count(*) FROM quixi_sync_ops"), 0);
    assert.equal(db.selectValue("SELECT count(*) FROM quixi_records"), 0);
  } finally { db.close(); }
});

test("invalid interaction writes refuse before any database access", () => {
  const preferences = new PreferenceRepository({
    selectValue() { assert.fail("Invalid arguments must not read SQL."); },
    exec() { assert.fail("Invalid arguments must not write SQL."); },
  });
  for (const args of [{ expectedRevision: -1, preferences: interactionPreferences },
    { expectedRevision: 0, preferences: { ...interactionPreferences, arbitrary: true } },
    { expectedRevision: 0, preferences: { ...interactionPreferences, showTimestamps: "true" } }]) {
    assert.throws(() => preferences.setInteractionPreferences(args as Parameters<PreferenceRepository["setInteractionPreferences"]>[0]), /Invalid/);
  }
});

test("preference boundary refuses malformed revisions, values and arbitrary fields", () => {
  for (const value of [null, {}, { expectedRevision: -1, sendKey: "enter" }, { expectedRevision: 0.5, sendKey: "enter" }, { expectedRevision: Number.MAX_SAFE_INTEGER, sendKey: "enter" }, { expectedRevision: 0, sendKey: "unknown" }, { expectedRevision: 0, sendKey: "enter", key: "secret" }])
    assert.throws(() => assertPreferenceArgs("setSendKey", value));
  assert.throws(() => assertPreferenceArgs("readLocalPreferences", {}));
  assert.doesNotThrow(() => assertPreferenceArgs("setSendKey", { expectedRevision: 0, sendKey: "mod-enter" }));
});
function thread(repo: CanonicalRepository, title: string, time = now) {
  const threadId = id(),
    contextId = id();
  commit(repo, {
    version: 1,
    operationId: id(),
    recordedAt: time,
    kind: "CreateThread",
    payload: {
      thread: {
        id: threadId,
        workspaceId: id(),
        createdAt: time,
        recordedAt: time,
        systemPrompt: "",
        preferredRoute: null,
        importSourceId: null,
      },
      context: {
        id: contextId,
        threadId,
        previousId: null,
        version: 1,
        systemPrompt: "",
        preferredRoute: null,
        recordedAt: time,
      },
      state: {
        threadId,
        title,
        tags: [],
        pinned: false,
        archived: false,
        activeLeafMessageId: null,
        contextSnapshotId: contextId,
        routingProfile: null,
        revision: 0,
      },
    },
  });
  return threadId;
}
function message(
  repo: CanonicalRepository,
  threadId: string,
  parentId: string | null,
  time = now,
) {
  const messageId = id();
  commit(repo, {
    version: 1,
    operationId: id(),
    recordedAt: time,
    kind: "CreateMessage",
    payload: {
      message: {
        id: messageId,
        threadId,
        parentId,
        role: "user",
        createdAt: time,
        recordedAt: time,
        generationId: null,
        editedFromMessageId: null,
        partCount: 0,
        sealed: true,
      },
      parts: [],
    },
  });
  return messageId;
}
test("library sorts pins/recency, filters literal titles/archive, bounds metadata and rejects stale pages", () => {
  const { db, repository: r, views: v } = open();
  try {
    const old = thread(r, "100%_literal", now),
      recent = thread(r, "Recent", now + 1),
      hidden = thread(r, "Archived", now + 2);
    commit(
      r,
      {
        version: 1,
        operationId: id(),
        recordedAt: now + 2,
        kind: "SetArchived",
        payload: { threadId: hidden, value: true },
      },
      {
        version: 1,
        operationId: id(),
        recordedAt: now + 2,
        kind: "SetPinned",
        payload: { threadId: old, value: true },
      },
    );
    const args = { archived: false, title: "", page: { ...page, maxItems: 1 } };
    const first = v.library(args);
    assert.equal(first.items[0]!.threadId, old);
    assert(first.nextCursor);
    assert.equal(
      v.library({ ...args, page: { ...args.page, cursor: first.nextCursor } })
        .items[0]!.threadId,
      recent,
    );
    assert.equal(
      v.library({ archived: false, title: "%_", page }).items[0]!.threadId,
      old,
    );
    assert.equal(
      v.library({ archived: true, title: "", page }).items[0]!.threadId,
      hidden,
    );
    message(r, recent, null, now + 3);
    assert.throws(
      () =>
        v.library({
          ...args,
          page: { ...args.page, cursor: first.nextCursor },
        }),
      /library changed/,
    );
    commit(r, {
      version: 1,
      operationId: id(),
      recordedAt: now + 3,
      kind: "SetTitle",
      payload: { threadId: old, value: "x".repeat(20_000) },
    });
    const bounded = v.library({ archived: false, title: "", page });
    assert.equal(bounded.items[0]!.title.length, 512);
    assert(bounded.items[0]!.titleTruncated);
    assert(bounded.bytes < 4000);
    assert.throws(
      () => v.library({ ...args, page: { ...page, maxBytes: 2 } }),
      /byte budget/,
    );
    assert.equal(
      v.workspace().workspaceId,
      new ViewRepository(db, r).workspace().workspaceId,
    );
  } finally {
    db.close();
  }
});
test("deep paths page backwards without loading siblings, preserve ordering and reject unrelated cursor/leaf", () => {
  const { db, repository: r, views: v } = open();
  try {
    const t = thread(r, "Deep path"),
      other = thread(r, "Other");
    const path: string[] = [];
    for (let i = 0; i < 101; i++)
      path.push(message(r, t, path.at(-1) ?? null, now + i));
    const sibling = message(r, t, path[0]!, now + 200),
      foreign = message(r, other, null);
    commit(r, {
      version: 1,
      operationId: id(),
      recordedAt: now + 201,
      kind: "SetActiveBranch",
      payload: { threadId: t, value: path.at(-1)! },
    });
    let cursor: string | null = null;
    const collected: string[] = [];
    do {
      const result = v.window({
        threadId: t,
        leafMessageId: null,
        page: { ...page, cursor },
      });
      assert(result.items.length <= 16);
      collected.unshift(...result.items.map((m) => m.id));
      cursor = result.nextCursor;
    } while (cursor);
    assert.deepEqual(collected, path);
    assert(!collected.includes(sibling));
    assert.deepEqual(
      new Set(
        v
          .children({ threadId: t, parentMessageId: path[0]!, page })
          .items.map((m) => m.id),
      ),
      new Set([path[1], sibling]),
    );
    assert.throws(
      () => v.window({ threadId: t, leafMessageId: foreign, page }),
      /missing or deleted/,
    );
    assert.throws(
      () =>
        v.window({
          threadId: t,
          leafMessageId: path.at(-1)!,
          page: {
            ...page,
            cursor: JSON.stringify({
              threadId: t,
              leaf: path.at(-1),
              before: sibling,
            }),
          },
        }),
      /outside/,
    );
  } finally {
    db.close();
  }
});
test("deleted subtrees and whole threads disappear from views while retained siblings stay readable", () => {
  const { db, repository: r, views: v } = open();
  try {
    const t = thread(r, "Branch deletion"),
      root = message(r, t, null),
      deleted = message(r, t, root),
      descendant = message(r, t, deleted),
      sibling = message(r, t, root);
    commit(r, {
      version: 1,
      operationId: id(),
      recordedAt: now,
      kind: "SetActiveBranch",
      payload: { threadId: t, value: sibling },
    });
    const state = v.thread({ threadId: t }).state;
    commit(r, {
      version: 1,
      operationId: id(),
      recordedAt: now,
      kind: "TombstoneBranch",
      payload: {
        tombstone: {
          id: id(),
          threadId: t,
          rootMessageId: deleted,
          createdAt: now,
          reason: null,
        },
        state: {
          ...state,
          activeLeafMessageId: sibling,
          revision: state.revision + 1,
        },
      },
    });
    assert.deepEqual(
      v
        .children({ threadId: t, parentMessageId: root, page })
        .items.map((value) => value.id),
      [sibling],
    );
    assert.throws(
      () => v.window({ threadId: t, leafMessageId: descendant, page }),
      /missing or deleted/,
    );
    assert.throws(
      () => v.children({ threadId: t, parentMessageId: descendant, page }),
      /missing or deleted/,
    );
    assert.deepEqual(
      v
        .window({ threadId: t, leafMessageId: sibling, page })
        .items.map((value) => value.id),
      [root, sibling],
    );
    const next = v.thread({ threadId: t }).state;
    commit(r, {
      version: 1,
      operationId: id(),
      recordedAt: now,
      kind: "TombstoneThread",
      payload: {
        tombstone: {
          id: id(),
          threadId: t,
          rootMessageId: null,
          createdAt: now,
          reason: null,
        },
        state: {
          ...next,
          activeLeafMessageId: null,
          revision: next.revision + 1,
        },
      },
    });
    assert.deepEqual(v.library({ archived: false, title: "", page }).items, []);
    assert.throws(() => v.thread({ threadId: t }), /missing or deleted/);
    assert(r.get("messages", descendant));
  } finally {
    db.close();
  }
});

test("thread view sums attempt usage in SQL, keeping unreported values out and one currency for estimates", () => {
  const { db, repository, views } = open();
  const threadId = thread(repository, "Usage"), parent = message(repository, threadId, null);
  const attempt = (n: number, complete: null | { tokensIn: number | null; tokensOut: number | null; cachedTokens: number | null; estimatedCost: { amount: string; currency: string } | null }) => {
    const generationId = id(), outputId = id();
    commit(repository, {
      version: 1, operationId: id(), recordedAt: now + n, kind: "CreateGeneration",
      payload: {
        generation: { id: generationId, threadId, parentMessageId: parent, outputMessageId: outputId, contextSnapshotId: repository.get("threadStates", threadId)!.contextSnapshotId, provider: "synthetic", providerAccountId: "primary", model: "synthetic-model", parameters: {}, status: "streaming", createdAt: now + n, recordedAt: now + n, completedAt: null, tokensIn: null, tokensOut: null, cachedTokens: null, estimatedCost: null, reportedCost: null, lastSequence: 0, rawResponseId: null, compatibility: [] },
        output: { id: outputId, threadId, parentId: parent, role: "assistant", createdAt: now + n, recordedAt: now + n, generationId, editedFromMessageId: null, partCount: 0, sealed: false },
        parts: [],
      },
    });
    if (complete)
      commit(repository, {
        version: 1, operationId: id(), recordedAt: now + n, kind: "CompleteGeneration",
        payload: { generationId, status: "complete", completedAt: now + n, ...complete, reportedCost: null, rawResponseId: null },
      });
  };
  assert.deepEqual(views.thread({ threadId }).usage, { attempts: 0, tokensIn: null, tokensOut: null, cachedTokens: null, estimatedCost: null, unpricedAttempts: 0 });
  attempt(1, { tokensIn: 12, tokensOut: 20, cachedTokens: 0, estimatedCost: { amount: "0.000112000", currency: "USD" } });
  attempt(2, { tokensIn: 30, tokensOut: 5, cachedTokens: 10, estimatedCost: { amount: "0.000050000", currency: "USD" } });
  attempt(3, { tokensIn: null, tokensOut: null, cachedTokens: null, estimatedCost: null });
  attempt(4, null);
  assert.deepEqual(views.thread({ threadId }).usage, { attempts: 4, tokensIn: 42, tokensOut: 25, cachedTokens: 10, estimatedCost: { amount: "0.000162", currency: "USD", attempts: 2 }, unpricedAttempts: 2 });
  attempt(5, { tokensIn: 1, tokensOut: 1, cachedTokens: 0, estimatedCost: { amount: "0.5", currency: "EUR" } });
  assert.equal(views.thread({ threadId }).usage.estimatedCost, null, "mixed currencies produce no total");
  db.close();
});

test("schema 13 library reads one ordered index walk that matches the per-item scan, after upgrade and every kind of change", () => {
  const db = new sqlite.oo1.DB(`/${id()}.sqlite3`, "c");
  const r = new CanonicalRepository(db, { assertBlobAvailable: () => {} });
  try {
    // Seed at schema 12 (no materialized rows), then upgrade: the backfill must equal what the triggers maintain.
    r.migrate(12);
    const threads = Array.from({ length: 9 }, (_, i) => thread(r, `Thread ${i}`, now + i));
    message(r, threads[0]!, null, now + 100);
    message(r, threads[2]!, null, now + 50);
    const pin = (t: string, value: boolean) => commit(r, { version: 1, operationId: id(), recordedAt: now + 200, kind: "SetPinned", payload: { threadId: t, value } });
    const archive = (t: string, value: boolean) => commit(r, { version: 1, operationId: id(), recordedAt: now + 200, kind: "SetArchived", payload: { threadId: t, value } });
    pin(threads[4]!, true); archive(threads[5]!, true);
    const legacy = new ViewRepository(db, r, { materializedLibrary: false });
    const all = (v: ViewRepository, archived = false, title = "") => {
      const items = []; let cursor: string | null = null;
      do { const p = v.library({ archived, title, page: { maxItems: 3, maxBytes: 100_000, cursor } }); items.push(...p.items); cursor = p.nextCursor; } while (cursor);
      return items;
    };
    const before = all(legacy);
    assert.equal(db.selectValue("SELECT count(*) FROM sqlite_schema WHERE name='quixi_library_activity'"), 0);
    r.migrate();
    assert.equal(db.selectValue("SELECT count(*) FROM quixi_library_activity"), 9);
    const fast = new ViewRepository(db, r);
    assert.deepEqual(all(fast), before);
    assert.equal(before[0]!.threadId, threads[4], "pinned first");
    assert.equal(before[1]!.threadId, threads[0], "latest message wins over creation");
    assert.deepEqual(all(fast, true), all(legacy, true));
    // Every later change keeps both readings equal: new message, pin/unpin, archive/unarchive, whole-thread deletion, title filter.
    message(r, threads[7]!, null, now + 300);
    pin(threads[1]!, true); pin(threads[4]!, false); archive(threads[5]!, false); archive(threads[3]!, true);
    const gone = fast.thread({ threadId: threads[8]! }).state;
    commit(r, { version: 1, operationId: id(), recordedAt: now + 400, kind: "TombstoneThread", payload: { tombstone: { id: id(), threadId: threads[8]!, rootMessageId: null, createdAt: now + 400, reason: null }, state: { ...gone, activeLeafMessageId: null, revision: gone.revision + 1 } } });
    for (const [archived, title] of [[false, ""], [true, ""], [false, "Thread 7"], [false, "%"]] as const) {
      const expected = all(legacy, archived, title);
      assert.deepEqual(all(fast, archived, title), expected, `archived=${archived} title=${JSON.stringify(title)}`);
    }
    const after = all(fast);
    assert.equal(after[0]!.threadId, threads[1]);
    assert.equal(after[1]!.threadId, threads[7]);
    assert.ok(!after.some((item) => item.threadId === threads[8] || item.threadId === threads[3]));
    assert.equal(all(fast, true).map((item) => item.threadId).join(), threads[3]);
    // The walk is one statement per page: the materialized query never scans threads beyond the page and the cursor.
    assert.equal(db.selectValue("SELECT count(*) FROM quixi_library_activity WHERE deleted=1"), 1);
    assert.equal(db.selectValue("PRAGMA integrity_check"), "ok");
  } finally {
    db.close();
  }
});
