import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SearchRepository } from "../../src/worker/search/index.ts";
import type { SearchBlobAccess } from "../../src/worker/search/index.ts";
import { CanonicalRepository } from "../../src/worker/canonical/index.ts";
import { assertSearchArgs } from "@quixi/core/contracts";
import type { PageSourceSpan } from "@quixi/core/contracts";
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
} from "../extraction-search/fixture.ts";
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
class Bytes implements SearchBlobAccess {
  readonly data = new Map<string, Uint8Array>();
  readonly readers = new Map<string, Uint8Array>();
  opens = 0;
  async beginVerifiedRead(sha: string, allocate: () => string) {
    const read = await this.openRead(sha, allocate);
    return { ...read, verifiedBytes: read.byteLength, complete: true };
  }
  async advanceVerifiedRead(): Promise<never> { throw new Error("Fixture reader is already verified"); }
  async openRead(sha: string, allocate: () => string) {
    this.opens++;
    const bytes = this.data.get(sha)!;
    assert.equal(hash(bytes), sha);
    const transferId = allocate();
    this.readers.set(transferId, bytes);
    return { transferId, byteLength: bytes.length };
  }
  sliceRead(
    parent: string,
    allocate: () => string,
    range: { offset: number; byteLength: number },
  ) {
    const transferId = allocate();
    this.readers.set(
      transferId,
      this.readers
        .get(parent)!
        .slice(range.offset, range.offset + range.byteLength),
    );
    return { transferId };
  }
  readChunk(transferId: string) {
    return {
      transferId,
      sequence: 0,
      offset: 0,
      bytes: this.readers.get(transferId)!,
      final: true,
    };
  }
  acknowledge(ack: { transferId: string }) {
    this.readers.delete(ack.transferId);
  }
  async discard(transferId: string) {
    this.readers.delete(transferId);
  }
}
function query(repo: SearchRepository, query: string) {
  return repo.search({
    query,
    mode: "exact",
    filters: {},
    page: { cursor: null, maxItems: 16, maxBytes: 100000 },
  }).items;
}
async function drain(repo: SearchRepository) {
  for (let n = 0; n < 400; n++) {
    const s = await repo.advance({ maxChunks: 4 });
    if (s.state === "ready") return;
    assert.notEqual(s.state, "failed");
  }
  throw new Error("Fixture index did not drain");
}
function published(f: ReturnType<typeof fixture>, runId: string, text: string) {
  const p = page(f, runId),
    maps: PageSourceSpan[] = [];
  let offset = 0,
    sequence = 0;
  while (offset < text.length) {
    let end = Math.min(text.length, offset + 4096);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    const fragment = text.slice(offset, end),
      s = span(offset, fragment);
    maps.push(s);
    stage(f, p, fragment, sequence++, offset, [s]);
    offset = end;
  }
  return publish(f, p, text, maps, sequence - 1).receipt.pageRef;
}
function plain(f: ReturnType<typeof fixture>, bytes: Bytes) {
  const data = new TextEncoder().encode(
      "Plainoverview café 🧪\0 tail\n```ts\nconst codeNavigation = 1;\n```",
    ),
    sha = hash(data),
    attachmentId = next(),
    documentId = next();
  bytes.data.set(sha, data);
  const canonical = new CanonicalRepository(f.db, {
    assertBlobAvailable: (h, n) => {
      assert.equal(h, sha);
      assert.equal(n, data.length);
    },
  });
  canonical.commit({
    transactionId: next(),
    expectedThreadRevisions: [],
    stagedBlobIds: [],
    mutations: [
      {
        version: 1,
        operationId: next(),
        recordedAt: 1,
        kind: "RegisterAttachment",
        payload: {
          attachment: {
            id: attachmentId,
            availability: "available",
            filename: "plain.txt",
            mimeType: "text/plain",
            sizeBytes: data.length,
            blobSha256: sha,
            rawObjectId: null,
          },
        },
      },
      {
        version: 1,
        operationId: next(),
        recordedAt: 1,
        kind: "RegisterDocument",
        payload: {
          document: {
            id: documentId,
            workspaceId: identity.documentId,
            attachmentId,
            title: "Plain overview",
            createdAt: null,
            recordedAt: 1,
            importSourceId: null,
          },
        },
      },
    ],
  });
  return { documentId, attachmentId, sha };
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
            title: "Retained conversation",
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
              data: { text: "canonicalevergreen conversation remains usable" },
            },
          ],
        },
      },
    ],
  });
}
const conflict = (error: unknown) =>
  (error as { code?: string }).code === "CONFLICT";

test("exact published navigation preserves Unicode/NUL offsets and original ref without loading page text, maps or blob bytes", async () => {
  const f = fixture(),
    bytes = new Bytes();
  let forbidText = false,
    currentCalls = 0,
    allowCurrent = true;
  const repo = new SearchRepository(f.db, bytes, {
    publishedSources: {
      ...f.repo.publishedSources,
      loadPage(id) {
        assert.equal(
          forbidText,
          false,
          "Resolver must not load full extracted text",
        );
        return f.repo.publishedSources.loadPage(id);
      },
      current(ref) {
        currentCalls++;
        return allowCurrent && f.repo.publishedSources.current(ref);
      },
    },
  });
  repo.initialize();
  try {
    const run = begin(f),
      text =
        "Alpha café 🧪\0 ordinary words\n".repeat(2800) +
        "uniquenavigationneedle";
    const ref = published(f, run.runId, text);
    await drain(repo);
    const hit = query(repo, "uniquenavigationneedle")[0]!;
    assert.ok(hit.position.start > 65536);
    const beforeCalls = currentCalls,
      beforeChanges = f.db.selectValue("SELECT total_changes()");
    forbidText = true;
    const result = repo.resolveDocumentHit({
      chunkId: hit.chunkId,
      documentId: identity.documentId,
    });
    assert.deepEqual(result, {
      documentId: identity.documentId,
      attachmentId: identity.attachmentId,
      pageRef: ref,
      position: hit.position,
    });
    assert.ok(currentCalls > beforeCalls);
    assert.equal(bytes.opens, 0);
    assert.equal(f.db.selectValue("SELECT total_changes()"), beforeChanges);
    const plan = rows(
      f.db,
      "EXPLAIN QUERY PLAN SELECT rowid FROM quixi_search_chunks WHERE epoch=? AND chunk_id=?",
      [repo.status().activeEpoch, hit.chunkId],
    );
    assert.ok(
      plan.some((row) =>
        String(row.detail).includes("quixi_search_chunk_lookup"),
      ),
    );
    allowCurrent = false;
    assert.throws(
      () =>
        repo.resolveDocumentHit({
          chunkId: hit.chunkId,
          documentId: identity.documentId,
        }),
      conflict,
    );
  } finally {
    await repo.close();
    f.close();
  }
});

test("old hit never resolves a changed replacement page or cleared run even before outbox drain", async () => {
  const f = fixture(),
    repo = new SearchRepository(f.db, new Bytes(), {
      publishedSources: f.repo.publishedSources,
    });
  repo.initialize();
  try {
    const first = begin(f);
    published(f, first.runId, "oldnavigation original page");
    await drain(repo);
    const old = query(repo, "oldnavigation")[0]!;
    f.repo.execute("completeDocumentExtraction", {
      operationId: next(),
      runId: first.runId,
      writerEpoch: 1,
    });
    const replacement = begin(f, { normalizerVersion: "identity-v2" });
    published(f, replacement.runId, "newnavigation replacement page");
    assert.throws(
      () =>
        repo.resolveDocumentHit({
          chunkId: old.chunkId,
          documentId: identity.documentId,
        }),
      conflict,
    );
    await drain(repo);
    const current = query(repo, "newnavigation")[0]!;
    assert.notEqual(old.chunkId, current.chunkId);
    assert.throws(
      () =>
        repo.resolveDocumentHit({
          chunkId: old.chunkId,
          documentId: identity.documentId,
        }),
      conflict,
    );
    assert.equal(
      repo.resolveDocumentHit({
        chunkId: current.chunkId,
        documentId: identity.documentId,
      }).pageRef!.runId,
      replacement.runId,
    );
    f.repo.execute("clearDocumentExtraction", {
      operationId: next(),
      documentId: identity.documentId,
      expectedRunId: replacement.runId,
      expectedDocumentRevision: status(f).documentRevision,
    });
    assert.throws(
      () =>
        repo.resolveDocumentHit({
          chunkId: current.chunkId,
          documentId: identity.documentId,
        }),
      conflict,
    );
  } finally {
    await repo.close();
    f.close();
  }
});

test("same deterministic chunk legitimately resolves after rebuild; missing repair head refuses until rebuilt", async () => {
  const f = fixture(),
    repo = new SearchRepository(f.db, new Bytes(), {
      publishedSources: f.repo.publishedSources,
    });
  repo.initialize();
  try {
    const run = begin(f),
      ref = published(f, run.runId, "rebuildnavigation exact source");
    await drain(repo);
    const hit = query(repo, "rebuildnavigation")[0]!;
    repo.rebuild({ operationId: next() });
    await drain(repo);
    assert.equal(query(repo, "rebuildnavigation")[0]!.chunkId, hit.chunkId);
    assert.deepEqual(
      repo.resolveDocumentHit({
        chunkId: hit.chunkId,
        documentId: identity.documentId,
      }).pageRef,
      ref,
    );
    repo.repairDerived({ operationId: next() });
    assert.throws(
      () =>
        repo.resolveDocumentHit({
          chunkId: hit.chunkId,
          documentId: identity.documentId,
        }),
      conflict,
    );
    await drain(repo);
    assert.deepEqual(
      repo.resolveDocumentHit({
        chunkId: hit.chunkId,
        documentId: identity.documentId,
      }).pageRef,
      ref,
    );
  } finally {
    await repo.close();
    f.close();
  }
});

test("plain document and code hits open metadata overview; malformed IDs, wrong document and altered positions refuse", async () => {
  const f = fixture(),
    bytes = new Bytes(),
    repo = new SearchRepository(f.db, bytes, {
      publishedSources: f.repo.publishedSources,
    });
  repo.initialize();
  try {
    const doc = plain(f, bytes);
    await drain(repo);
    const hit = query(repo, "Plainoverview")[0]!,
      code = query(repo, "codeNavigation")[0]!;
    const opens = bytes.opens;
    for (const found of [hit, code])
      assert.deepEqual(
        repo.resolveDocumentHit({
          chunkId: found.chunkId,
          documentId: doc.documentId,
        }),
        {
          documentId: doc.documentId,
          attachmentId: doc.attachmentId,
          pageRef: null,
          position: found.position,
        },
      );
    assert.equal(bytes.opens, opens);
    assert.throws(
      () =>
        repo.resolveDocumentHit({
          chunkId: hit.chunkId,
          documentId: identity.documentId,
        }),
      conflict,
    );
    for (const chunkId of [
      "",
      "not-a-chunk",
      "a".repeat(65),
      hit.chunkId.toUpperCase(),
    ])
      assert.throws(
        () => repo.resolveDocumentHit({ chunkId, documentId: doc.documentId }),
        (error) => (error as { code?: string }).code === "INVALID_REQUEST",
      );
    assert.throws(() =>
      assertSearchArgs("resolveDocumentSearchHit", {
        chunkId: hit.chunkId,
        documentId: doc.documentId,
        page: 1,
      }),
    );
    assert.throws(() =>
      assertSearchArgs("resolveDocumentSearchHit", {
        chunkId: hit.chunkId,
        documentId: "bad-id",
      }),
    );
    assert.throws(
      () =>
        repo.resolveDocumentHit({
          chunkId: "0".repeat(64),
          documentId: doc.documentId,
        }),
      conflict,
    );
    f.db.exec({
      sql: "UPDATE quixi_search_chunks SET position=json_set(position,'$.start',1) WHERE chunk_id=?",
      bind: [hit.chunkId],
    });
    assert.throws(
      () =>
        repo.resolveDocumentHit({
          chunkId: hit.chunkId,
          documentId: doc.documentId,
        }),
      (error) => (error as { code?: string }).code === "MIGRATION_FAILED",
    );
  } finally {
    await repo.close();
    f.close();
  }
});

test("source SHA changes are fenced independently of normal dirty triggers for extracted and plain hits", async () => {
  const f = fixture(),
    bytes = new Bytes(),
    repo = new SearchRepository(f.db, bytes, {
      publishedSources: f.repo.publishedSources,
    });
  repo.initialize();
  try {
    const doc = plain(f, bytes),
      run = begin(f);
    published(f, run.runId, "extractedsourceidentity");
    await drain(repo);
    const extracted = query(repo, "extractedsourceidentity")[0]!,
      metadata = query(repo, "Plainoverview")[0]!;
    repo.disableDerivedTriggers();
    f.db.exec("DROP TRIGGER quixi_attachment_bytes"); // Deliberate physical corruption; ordinary canonical mutations reject it.
    for (const attachmentId of [identity.attachmentId, doc.attachmentId])
      f.db.exec({
        sql: "UPDATE quixi_records SET payload=json_set(payload,'$.blobSha256',?) WHERE collection='attachments' AND id=?",
        bind: ["a".repeat(64), attachmentId],
      });
    assert.throws(
      () =>
        repo.resolveDocumentHit({
          chunkId: extracted.chunkId,
          documentId: identity.documentId,
        }),
      conflict,
    );
    assert.throws(
      () =>
        repo.resolveDocumentHit({
          chunkId: metadata.chunkId,
          documentId: doc.documentId,
        }),
      conflict,
    );
  } finally {
    await repo.close();
    f.close();
  }
});

test("missing extraction schema excludes page navigation without joining absent tables; plain sources stay usable", async () => {
  const f = fixture(),
    bytes = new Bytes(),
    repo = new SearchRepository(f.db, bytes, {
      publishedSources: f.repo.publishedSources,
    });
  repo.initialize();
  try {
    conversation(f);
    const doc = plain(f, bytes),
      run = begin(f);
    published(f, run.runId, "missingextractionlookup");
    await drain(repo);
    const extracted = query(repo, "missingextractionlookup")[0]!,
      metadata = query(repo, "Plainoverview")[0]!;
    f.db.exec("DROP TABLE quixi_extract_pages");
    const statements: string[] = [],
      exec = f.db.exec.bind(f.db);
    f.db.exec = ((input: any) => {
      statements.push(typeof input === "string" ? input : input.sql);
      return exec(input);
    }) as typeof f.db.exec;
    assert.throws(
      () =>
        repo.resolveDocumentHit({
          chunkId: extracted.chunkId,
          documentId: identity.documentId,
        }),
      conflict,
    );
    assert.equal(
      repo.resolveDocumentHit({
        chunkId: metadata.chunkId,
        documentId: doc.documentId,
      }).pageRef,
      null,
    );
    assert.equal(query(repo, "Plainoverview").length, 1);
    assert.equal(query(repo, "canonicalevergreen").length, 1);
    assert.ok(
      statements.every((sql) => !/(?:JOIN|FROM) quixi_extract_/i.test(sql)),
    );
  } finally {
    await repo.close();
    f.close();
  }
});

test("legacy extracted x: hits cannot fabricate a durable published-page navigation reference", async () => {
  const f = fixture(),
    repo = new SearchRepository(f.db, new Bytes(), {
      publishedSources: f.repo.publishedSources,
    });
  repo.initialize();
  try {
    repo.registerExtractedText({
      id: next(),
      documentId: identity.documentId,
      attachmentSha256: identity.attachmentSha256,
      extractorVersion: "legacy-registration",
      text: "legacylookup without original published map identity",
      page: 1,
      sectionPath: [],
      offsetBase: 0,
    });
    await drain(repo);
    const hit = query(repo, "legacylookup")[0]!;
    assert.ok(hit);
    assert.throws(
      () =>
        repo.resolveDocumentHit({
          chunkId: hit.chunkId,
          documentId: identity.documentId,
        }),
      conflict,
    );
  } finally {
    await repo.close();
    f.close();
  }
});
