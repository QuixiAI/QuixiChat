import test from "node:test";
import assert from "node:assert/strict";
import { SearchRepository } from "../../src/worker/search/index.ts";
import type { SearchBlobAccess } from "../../src/worker/search/index.ts";
import type { PublishedExtractionSources } from "../../src/worker/extraction/index.ts";
import type { PageSourceSpan } from "../../../core/src/contracts/extraction.ts";
import {
  fixture,
  begin,
  page,
  span,
  stage,
  publish,
  status,
  next,
  identity,
  rows,
  canonicalFingerprint,
} from "./fixture.ts";
const noBlobs: SearchBlobAccess = {
  async beginVerifiedRead() { throw new Error("Unexpected original verification"); },
  async advanceVerifiedRead() { throw new Error("Unexpected original verification"); },
  async openRead() {
    throw new Error("Published PDF text must not reopen original blobs");
  },
  sliceRead() {
    throw new Error("Unexpected byte read");
  },
  readChunk() {
    throw new Error("Unexpected byte read");
  },
  acknowledge() {
    throw new Error("Unexpected byte acknowledgement");
  },
  async discard() {
    throw new Error("Unexpected byte release");
  },
};
function search(
  f: ReturnType<typeof fixture>,
  adapter: PublishedExtractionSources = f.repo.publishedSources,
) {
  const repo = new SearchRepository(f.db, noBlobs, {
    publishedSources: adapter,
  });
  repo.initialize();
  return repo;
}
function query(repo: SearchRepository, text: string) {
  return repo.search({
    query: text,
    mode: "exact",
    filters: {},
    page: { cursor: null, maxItems: 32, maxBytes: 100_000 },
  });
}
async function drain(f: ReturnType<typeof fixture>, repo: SearchRepository) {
  for (let n = 0; n < 500; n++) {
    const before = Number(
      f.db.selectValue("SELECT count(*) FROM quixi_search_chunks"),
    );
    const state = await repo.advance({ maxChunks: 4 });
    const after = Number(
      f.db.selectValue("SELECT count(*) FROM quixi_search_chunks"),
    );
    assert.ok(
      after - before <= 4,
      "Every extraction admission writes at most four shared chunks",
    );
    if (state.state === "ready") return;
    assert.notEqual(state.state, "failed", JSON.stringify(state));
  }
  throw new Error("Bounded fixture did not drain");
}
function writePage(
  f: ReturnType<typeof fixture>,
  runId: string,
  text: string,
  number = 1,
  count = 1,
) {
  const p = page(f, runId, number, count),
    maps: PageSourceSpan[] = [];
  let offset = 0,
    sequence = 0;
  while (offset < text.length) {
    let end = Math.min(text.length, offset + 4096);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    const fragment = text.slice(offset, end),
      map = span(offset, fragment);
    maps.push(map);
    stage(f, p, fragment, sequence++, offset, [map]);
    offset = end;
  }
  return { p, maps, published: publish(f, p, text, maps, sequence - 1) };
}
function conversation(f: ReturnType<typeof fixture>) {
  const threadId = next(),
    contextId = next(),
    messageId = next();
  f.canonical.commit({
    transactionId: next(),
    expectedThreadRevisions: [],
    stagedBlobIds: [],
    mutations: [
      {
        version: 1,
        operationId: next(),
        recordedAt: 1,
        kind: "CreateThread",
        payload: {
          thread: {
            id: threadId,
            workspaceId: identity.documentId,
            createdAt: 1,
            recordedAt: 1,
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
            recordedAt: 1,
          },
          state: {
            threadId,
            title: "Canonical conversation",
            tags: [],
            pinned: false,
            archived: false,
            activeLeafMessageId: null,
            contextSnapshotId: contextId,
            routingProfile: null,
            revision: 0,
          },
        },
      },
      {
        version: 1,
        operationId: next(),
        recordedAt: 1,
        kind: "CreateMessage",
        payload: {
          message: {
            id: messageId,
            threadId,
            parentId: null,
            role: "user",
            createdAt: 1,
            recordedAt: 1,
            generationId: null,
            editedFromMessageId: null,
            partCount: 1,
            sealed: true,
          },
          parts: [
            {
              id: next(),
              messageId,
              order: 0,
              kind: "Text",
              data: { text: "canonical evergreen remains searchable" },
            },
          ],
        },
      },
    ],
  });
}

test("published pages use one continuous source; page 1 remains searchable while page 2 stages and publishes", async () => {
  const f = fixture(),
    repo = search(f);
  try {
    const before = canonicalFingerprint(f),
      run = begin(f),
      p1 = page(f, run.runId, 1, 2);
    const a = "A silver ",
      b = "fox café 🧪\0 crosses extraction events.",
      maps = [span(0, a), span(a.length, b)];
    stage(f, p1, a, 0, 0, [maps[0]!]);
    stage(f, p1, b, 1, a.length, [maps[1]!]);
    await drain(f, repo);
    assert.equal(query(repo, "silver fox").items.length, 0);
    const published1 = publish(f, p1, a + b, maps, 1);
    assert.ok(
      repo.status().pendingSources > 0,
      "Undrained publication wakes background scheduler",
    );
    assert.equal(
      repo.isExtractionPageIndexed(published1.receipt.pageRef),
      false,
    );
    await drain(f, repo);
    assert.equal(query(repo, '"silver fox"').items.length, 1);
    assert.equal(
      repo.isExtractionPageIndexed(published1.receipt.pageRef),
      true,
    );
    assert.equal(query(repo, "events").items[0]!.position.page, 1);
    const originalHead = rows(
      f.db,
      "SELECT * FROM quixi_search_heads WHERE source_key=?",
      [`e:${p1.pageAttemptId}`],
    );
    const documentRevision = rows(
      f.db,
      "SELECT revision FROM quixi_search_scopes WHERE scope='document' AND id=?",
      [identity.documentId],
    );
    const p2 = page(f, run.runId, 2, 2),
      text2 = "Secondpage pendingamber content";
    stage(f, p2, text2);
    await drain(f, repo);
    assert.equal(query(repo, "pendingamber").items.length, 0);
    assert.equal(query(repo, "silver").items.length, 1);
    publish(f, p2, text2, [span(0, text2)]);
    assert.equal(
      query(repo, "silver").items.length,
      1,
      "Visibility is independent of pending page2 outbox",
    );
    await drain(f, repo);
    assert.equal(query(repo, "pendingamber").items[0]!.position.page, 2);
    assert.deepEqual(
      rows(f.db, "SELECT * FROM quixi_search_heads WHERE source_key=?", [
        `e:${p1.pageAttemptId}`,
      ]),
      originalHead,
    );
    assert.deepEqual(
      rows(
        f.db,
        "SELECT revision FROM quixi_search_scopes WHERE scope='document' AND id=?",
        [identity.documentId],
      ),
      documentRevision,
    );
    assert.equal(
      f.repo.publishedSources.current(published1.receipt.pageRef),
      true,
    );
    assert.equal(
      Number(f.db.selectValue("SELECT count(*) FROM quixi_search_extractions")),
      0,
    );
    assert.equal(canonicalFingerprint(f), before);
  } finally {
    await repo.close();
    f.close();
  }
});

test("a Unicode/NUL page above 65536 UTF-16 units indexes across all staging fragments with original offsets", async () => {
  const f = fixture(),
    repo = search(f);
  try {
    const text =
      "Paragraph café 🧪\0 words follow in the source.\n".repeat(3900) +
      "uniquetailneedle";
    assert.ok(text.length > 65536 && text.length <= 262144);
    const run = begin(f),
      written = writePage(f, run.runId, text);
    await repo.advanceExtractionIndex();
    assert.equal(
      query(repo, "uniquetailneedle").items.length,
      0,
      "Partial chunk writes have no visible page head",
    );
    assert.equal(
      repo.isExtractionPageIndexed(written.published.receipt.pageRef),
      false,
    );
    await drain(f, repo);
    assert.equal(
      repo.isExtractionPageIndexed(written.published.receipt.pageRef),
      true,
    );
    const hits = query(repo, "uniquetailneedle").items;
    assert.equal(hits.length, 1);
    assert.ok(hits[0]!.position.start <= text.indexOf("uniquetailneedle"));
    assert.ok(hits[0]!.position.end >= text.length);
    assert.equal(
      Number(
        f.db.selectValue(
          "SELECT count(DISTINCT source_key) FROM quixi_search_chunks",
        ),
      ),
      1,
    );
    assert.equal(
      rows(f.db, "SELECT source_key FROM quixi_search_heads")[0]!.source_key,
      `e:${written.p.pageAttemptId}`,
    );
    const chunks = rows(
      f.db,
      "SELECT payload FROM quixi_search_chunks ORDER BY rowid",
    ).map((row) => JSON.parse(String(row.payload)));
    assert.ok(chunks.some((chunk) => chunk.text.includes("\0")));
    for (const chunk of chunks)
      assert.equal(
        chunk.text,
        text.slice(chunk.position.start, chunk.position.end),
      );
  } finally {
    await repo.close();
    f.close();
  }
});

test("replacement, held sources and canonical attachment changes fence hits without draining outbox; rebuild keeps only current pages", async () => {
  const f = fixture();
  let delay = false;
  const adapter = {
    ...f.repo.publishedSources,
    readPublicationBatch: (limit: number) =>
      delay ? [] : f.repo.publishedSources.readPublicationBatch(limit),
  };
  const repo = search(f, adapter);
  try {
    const first = begin(f);
    writePage(f, first.runId, "firstvisible oldwillow");
    await drain(f, repo);
    assert.equal(query(repo, "oldwillow").items.length, 1);
    f.repo.execute("completeDocumentExtraction", {
      operationId: next(),
      runId: first.runId,
      writerEpoch: 1,
    });
    const replacement = begin(f, { normalizerVersion: "identity-v2" });
    const text = "neworchid paragraph.\n".repeat(7000),
      newPage = writePage(f, replacement.runId, text);
    delay = true;
    assert.equal(
      query(repo, "oldwillow").items.length,
      0,
      "Visible run fences old head before outbox drain",
    );
    delay = false;
    await repo.advanceExtractionIndex();
    assert.equal(query(repo, "neworchid").items.length, 0);
    const clear = f.repo.execute("clearDocumentExtraction", {
      operationId: next(),
      documentId: identity.documentId,
      expectedRunId: replacement.runId,
      expectedDocumentRevision: status(f).documentRevision,
    });
    assert.ok(clear);
    delay = true;
    await repo.advanceExtractionIndex();
    assert.equal(
      query(repo, "neworchid").items.length,
      0,
      "Held source cannot publish after run clear even with delayed outbox",
    );
    assert.equal(
      Number(
        f.db.selectValue(
          "SELECT count(*) FROM quixi_search_heads WHERE source_key=?",
          [`e:${newPage.p.pageAttemptId}`],
        ),
      ),
      0,
    );
    delay = false;
    const last = begin(f);
    writePage(f, last.runId, "currentbirch current page");
    await drain(f, repo);
    repo.rebuild({ operationId: next() });
    await drain(f, repo);
    assert.equal(query(repo, "currentbirch").items.length, 1);
    assert.equal(query(repo, "oldwillow").items.length, 0);
    repo.disableDerivedTriggers(); // Deliberately bypass scope/outbox evidence to test the independent source identity predicate.
    f.db.exec("DROP TRIGGER quixi_attachment_bytes"); // Test-only physical corruption; normal canonical mutations reject this.
    f.db.exec({
      sql: "UPDATE quixi_records SET payload=json_set(payload,'$.blobSha256',?) WHERE collection='attachments' AND id=?",
      bind: ["a".repeat(64), identity.attachmentId],
    });
    assert.equal(query(repo, "currentbirch").items.length, 0);
  } finally {
    await repo.close();
    f.close();
  }
});

test("publication ACK and source dirtiness commit together; failed ACK leaves both untouched and exact retry succeeds", async () => {
  const f = fixture();
  let failAck = false;
  const adapter = {
    ...f.repo.publishedSources,
    acknowledgePublications: (ids: readonly number[]) => {
      f.repo.publishedSources.acknowledgePublications(ids);
      if (failAck) throw new Error("Synthetic ACK failure after SQL");
    },
  };
  const repo = search(f, adapter);
  try {
    await drain(f, repo);
    const run = begin(f);
    writePage(f, run.runId, "Atomic ack boundary");
    const before = rows(f.db, "SELECT * FROM quixi_search_meta"),
      outbox = f.repo.publishedSources.readPublicationBatch(32);
    failAck = true;
    assert.throws(() => repo.drainExtractionPublications(32), /Synthetic ACK/);
    assert.deepEqual(rows(f.db, "SELECT * FROM quixi_search_meta"), before);
    assert.deepEqual(f.repo.publishedSources.readPublicationBatch(32), outbox);
    failAck = false;
    assert.equal(repo.drainExtractionPublications(32), outbox.length);
    assert.equal(repo.drainExtractionPublications(32), 0);
    assert.throws(() => repo.drainExtractionPublications(33));
    await drain(f, repo);
    assert.equal(query(repo, "Atomic").items.length, 1);
  } finally {
    await repo.close();
    f.close();
  }
});

test("FTS repair retains extraction text/maps/checkpoints/receipts; corrupt extraction schema suppresses only extracted hits", async () => {
  const f = fixture(),
    repo = search(f);
  try {
    conversation(f);
    const run = begin(f),
      written = writePage(f, run.runId, "pdf amberfox derived page");
    await drain(f, repo);
    const before = canonicalFingerprint(f),
      checkpoint = status(f);
    const extraction = () =>
      [
        "quixi_extract_pages",
        "quixi_extract_map_batches",
        "quixi_extract_runs",
        "quixi_extract_operations",
      ].map((table) => rows(f.db, `SELECT * FROM ${table} ORDER BY rowid`));
    const retained = extraction();
    f.db.exec("DROP TABLE quixi_search_queue");
    repo.repairDerived({ operationId: next() });
    await drain(f, repo);
    assert.deepEqual(extraction(), retained);
    assert.deepEqual(status(f), checkpoint);
    assert.equal(query(repo, "amberfox").items.length, 1);
    assert.equal(query(repo, "evergreen").items.length, 1);
    assert.ok(
      f.repo.publishedSources.current(written.published.receipt.pageRef),
    );
    f.db.exec("DROP TABLE quixi_extract_map_batches");
    assert.equal(query(repo, "amberfox").items.length, 0);
    assert.equal(query(repo, "evergreen").items.length, 1);
    repo.rebuild({ operationId: next() });
    await drain(f, repo);
    assert.equal(query(repo, "evergreen").items.length, 1);
    assert.equal(query(repo, "amberfox").items.length, 0);
    assert.equal(canonicalFingerprint(f), before);
    const triggers = rows(
      f.db,
      "SELECT sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='quixi_records'",
    );
    assert.ok(
      triggers.every((row) => !String(row.sql).includes("quixi_extract_")),
    );
  } finally {
    await repo.close();
    f.close();
  }
});

test("forty published pages drain at most32 events and enumerate bounded pages across rebuild and actual SQLite reopen", async () => {
  const f = fixture();
  let repo: SearchRepository | undefined;
  const observed = { listCalls: 0, outboxCalls: 0, peakList: 0, peakOutbox: 0 };
  const adapter = (): PublishedExtractionSources => ({
    ...f.repo.publishedSources,
    listVisiblePages(doc, after, limit) {
      assert.ok(limit <= 32);
      observed.listCalls++;
      const result = f.repo.publishedSources.listVisiblePages(
        doc,
        after,
        limit,
      );
      observed.peakList = Math.max(observed.peakList, result.length);
      return result;
    },
    readPublicationBatch(limit) {
      assert.ok(limit <= 32);
      observed.outboxCalls++;
      const result = f.repo.publishedSources.readPublicationBatch(limit);
      observed.peakOutbox = Math.max(observed.peakOutbox, result.length);
      return result;
    },
  });
  try {
    repo = search(f, adapter());
    const run = begin(f);
    for (let number = 1; number <= 40; number++)
      writePage(f, run.runId, `Pagecountneedle number ${number}`, number, 40);
    assert.equal(
      Number(
        f.db.selectValue("SELECT count(*) FROM quixi_extract_publications"),
      ),
      40,
    );
    assert.equal(repo.drainExtractionPublications(), 32);
    assert.equal(
      Number(
        f.db.selectValue("SELECT count(*) FROM quixi_extract_publications"),
      ),
      8,
    );
    await drain(f, repo);
    assert.equal(
      Number(f.db.selectValue("SELECT count(*) FROM quixi_search_page_refs")),
      40,
    );
    const checkpoint = status(f),
      before = canonicalFingerprint(f);
    await repo.close();
    repo = undefined;
    f.reopen();
    repo = search(f, adapter());
    assert.equal(query(repo, "Pagecountneedle").items.length, 32);
    repo.rebuild({ operationId: next() });
    await drain(f, repo);
    assert.ok(
      observed.listCalls >= 2 &&
        observed.peakList <= 32 &&
        observed.peakOutbox === 32,
    );
    assert.equal(
      Number(f.db.selectValue("SELECT count(*) FROM quixi_search_heads")),
      40,
    );
    assert.deepEqual(status(f), checkpoint);
    assert.equal(canonicalFingerprint(f), before);
  } finally {
    await repo?.close();
    f.close();
  }
});

test("text corruption detected while rebuilding quarantines document extraction and leaves canonical conversation searchable", async () => {
  const f = fixture(),
    repo = search(f);
  try {
    conversation(f);
    const run = begin(f),
      first = writePage(f, run.runId, "soundpage amber fern", 1, 2),
      second = writePage(f, run.runId, "damagedpage oak grove", 2, 2);
    await drain(f, repo);
    assert.equal(query(repo, "soundpage").items.length, 1);
    f.db.exec({
      sql: "UPDATE quixi_extract_pages SET text='corrupt bytes' WHERE id=?",
      bind: [second.p.pageAttemptId],
    });
    repo.rebuild({ operationId: next() });
    for (let n = 0; n < 20; n++) await repo.advanceExtractionIndex();
    assert.equal(query(repo, "soundpage").items.length, 0);
    assert.equal(query(repo, "damagedpage").items.length, 0);
    assert.equal(query(repo, "evergreen").items.length, 1);
    assert.equal(
      f.repo.publishedSources.current(first.published.receipt.pageRef),
      true,
      "Unmodified page provenance remains recoverable outside quarantined search",
    );
  } finally {
    await repo.close();
    f.close();
  }
});

test("real SQLite FULL during ACK rolls back dirty writes and outbox together, preserving the original capacity error", async () => {
  const f = fixture();
  let pressure = true;
  f.db.exec("CREATE TABLE proof_quota_pressure(bytes BLOB)");
  const adapter = {
    ...f.repo.publishedSources,
    acknowledgePublications: (ids: readonly number[]) => {
      f.repo.publishedSources.acknowledgePublications(ids);
      if (pressure)
        f.db.exec("INSERT INTO proof_quota_pressure VALUES(zeroblob(1048576))");
    },
  };
  const repo = search(f, adapter);
  try {
    const run = begin(f);
    writePage(f, run.runId, "capacity survives publication");
    const meta = rows(f.db, "SELECT * FROM quixi_search_meta"),
      outbox = f.repo.publishedSources.readPublicationBatch(32),
      oldLimit = f.db.selectValue("PRAGMA max_page_count");
    f.db.exec(
      `PRAGMA max_page_count=${Number(f.db.selectValue("PRAGMA page_count")) + 4}`,
    );
    assert.throws(
      () => repo.drainExtractionPublications(),
      /SQLITE_FULL|database or disk is full/,
    );
    await assert.rejects(
      () => repo.advanceExtractionIndex(),
      /SQLITE_FULL|database or disk is full/,
    );
    assert.deepEqual(rows(f.db, "SELECT * FROM quixi_search_meta"), meta);
    assert.deepEqual(f.repo.publishedSources.readPublicationBatch(32), outbox);
    f.db.exec(`PRAGMA max_page_count=${oldLimit}`);
    pressure = false;
    await drain(f, repo);
    assert.equal(query(repo, "capacity").items.length, 1);
    assert.equal(f.db.selectValue("PRAGMA integrity_check"), "ok");
  } finally {
    await repo.close();
    f.close();
  }
});

test("empty scanned page receives indexed credit only after its complete zero-chunk head; stale refs never receive credit", async () => {
  const f = fixture(),
    repo = search(f);
  try {
    const run = begin(f),
      p = page(f, run.runId);
    const result = publish(f, p, "", [], -1);
    assert.equal(repo.isExtractionPageIndexed(result.receipt.pageRef), false);
    await drain(f, repo);
    assert.equal(repo.isExtractionPageIndexed(result.receipt.pageRef), true);
    assert.equal(
      Number(f.db.selectValue("SELECT count(*) FROM quixi_search_chunks")),
      0,
    );
    f.repo.execute("clearDocumentExtraction", {
      operationId: next(),
      documentId: identity.documentId,
      expectedRunId: run.runId,
      expectedDocumentRevision: status(f).documentRevision,
    });
    assert.equal(repo.isExtractionPageIndexed(result.receipt.pageRef), false);
  } finally {
    await repo.close();
    f.close();
  }
});

test("a search cursor cannot cross extraction replacement before outbox drain changes search revision", async () => {
  const f = fixture(),
    repo = search(f);
  try {
    const first = begin(f);
    writePage(f, first.runId, "cursorreed phrase.\n".repeat(2000));
    await drain(f, repo);
    const args = {
      query: "cursorreed",
      mode: "exact" as const,
      filters: {},
      page: { cursor: null as string | null, maxItems: 1, maxBytes: 100_000 },
    };
    const result = repo.search(args);
    assert.ok(result.nextCursor);
    f.repo.execute("completeDocumentExtraction", {
      operationId: next(),
      runId: first.runId,
      writerEpoch: 1,
    });
    const replacement = begin(f, { normalizerVersion: "identity-v2" });
    writePage(f, replacement.runId, "replacement page");
    assert.equal(
      repo.status().revision,
      result.index.revision,
      "No search dirty write has occurred yet",
    );
    assert.throws(
      () =>
        repo.search({
          ...args,
          page: { ...args.page, cursor: result.nextCursor },
        }),
      (error) => (error as { code?: string }).code === "CONFLICT",
    );
  } finally {
    await repo.close();
    f.close();
  }
});
