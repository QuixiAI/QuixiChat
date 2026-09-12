import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import initialize from "../../sqlite/dist/sqlite3.mjs";
import { CanonicalRepository } from "../../src/worker/canonical/index.ts";
import type { CanonicalSqlite } from "../../src/worker/canonical/index.ts";
import { StructuralChunker } from "@quixi/search";
import { canonicalJson } from "@quixi/core/contracts";
import {
  ExtractionRepository,
  extractionDigest,
  extractionMapDigest,
  extractionTextDigest,
} from "../../src/worker/extraction/index.ts";
import type {
  CanonicalExtractionIdentity,
  ExtractionRepositoryOptions,
} from "../../src/worker/extraction/index.ts";
import {
  assertExtractionArgs,
  EXTRACTION_LIMITS,
  ExtractionStorageError,
} from "../../../core/src/contracts/extraction.ts";
import type {
  ExtractionOperations,
  ExtractionIdentity,
  ExtractionPageWrite,
  PageSourceSpan,
  PublishedPageRef,
} from "../../../core/src/contracts/extraction.ts";
const wasm = await readFile(
  new URL("../../sqlite/dist/sqlite3.wasm", import.meta.url),
);
const artifact = JSON.parse(
  await readFile(
    new URL("../../sqlite/artifacts.json", import.meta.url),
    "utf8",
  ),
);
assert.equal(
  createHash("sha256").update(wasm).digest("hex"),
  artifact.artifacts["sqlite3.wasm"].sha256,
);
(
  globalThis as typeof globalThis & { sqlite3ApiConfig: unknown }
).sqlite3ApiConfig = { disable: { vfs: { opfs: true, "opfs-wl": true } } };
const initOptions = {
  instantiateWasm: async (
    imports: WebAssembly.Imports,
    success: (
      instance: WebAssembly.Instance,
      module: WebAssembly.Module,
    ) => void,
  ) => {
    const { instance, module } = await WebAssembly.instantiate(wasm, imports);
    success(instance, module);
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
const original = await readFile(
  new URL("../../../documents/tests/fixtures/pages-1.pdf", import.meta.url),
);
const sourceSha = createHash("sha256").update(original).digest("hex");
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let recordedSchema = false;
let serial = 1000;
const next = () => uuid(serial++);
const identity: ExtractionIdentity = {
  documentId: uuid(2),
  attachmentId: uuid(1),
  attachmentSha256: sourceSha,
  attachmentByteLength: original.length,
  extractorVersion: "quixi-extract-1/pdfjs-6.3.289",
  normalizerVersion: "identity-v1",
};
function rows(
  db: CanonicalSqlite,
  sql: string,
  bind: (string | number)[] = [],
) {
  return db.exec({
    sql,
    bind,
    rowMode: "object",
    returnValue: "resultRows",
  }) as Record<string, string | number | null>[];
}
function code(expected: string) {
  return (e: unknown) =>
    e instanceof ExtractionStorageError && e.code === expected;
}
function fixture(limits?: ExtractionRepositoryOptions["limits"]) {
  const filename = `/extraction-${serial++}.db`;
  let db = new sqlite.oo1.DB(filename, "c");
  let canonical = new CanonicalRepository(db, {
    assertBlobAvailable: (sha, length) => {
      assert.equal(sha, sourceSha);
      assert.equal(length, original.length);
    },
  });
  canonical.migrate();
  if (!recordedSchema) {
    recordedSchema = true;
    console.log(
      "quixi-extraction-schema " +
        JSON.stringify(
          rows(
            db,
            "SELECT version,name,checksum FROM quixi_schema_migrations ORDER BY version",
          ),
        ),
    );
  }
  db.exec(
    "CREATE TABLE proof_operation_claims(id TEXT PRIMARY KEY,domain TEXT,digest TEXT) STRICT",
  );
  const attachmentOp = next();
  canonical.commit({
    transactionId: next(),
    expectedThreadRevisions: [],
    stagedBlobIds: [],
    mutations: [
      {
        version: 1,
        operationId: attachmentOp,
        kind: "RegisterAttachment",
        recordedAt: 1,
        payload: {
          attachment: {
            id: uuid(1),
            availability: "available",
            filename: "synthetic.pdf",
            mimeType: "application/pdf",
            sizeBytes: original.length,
            blobSha256: sourceSha,
            rawObjectId: null,
          },
        },
      },
    ],
  });
  canonical.commit({
    transactionId: next(),
    expectedThreadRevisions: [],
    stagedBlobIds: [],
    mutations: [
      {
        version: 1,
        operationId: next(),
        kind: "RegisterDocument",
        recordedAt: 1,
        payload: {
          document: {
            id: uuid(2),
            workspaceId: uuid(3),
            attachmentId: uuid(1),
            title: "Synthetic PDF",
            createdAt: null,
            recordedAt: 1,
            importSourceId: null,
          },
        },
      },
    ],
  });
  let failCommit = false,
    override: Partial<CanonicalExtractionIdentity> | null = null;
  const make = () => {
    const repo = new ExtractionRepository(db, {
      lookupIdentity(documentId) {
        const doc = canonical.get("documents", documentId);
        const attachment = doc
          ? canonical.get("attachments", doc.attachmentId)
          : null;
        return doc && attachment
          ? {
              documentId: doc.id,
              attachmentId: attachment.id,
              attachmentSha256: attachment.blobSha256,
              attachmentByteLength: attachment.sizeBytes,
              available: attachment.availability === "available",
              mediaType: attachment.mimeType ?? "",
              ...override,
            }
          : null;
      },
      supportedVersions: [
        {
          extractorVersion: identity.extractorVersion,
          normalizerVersion: "identity-v1",
        },
        {
          extractorVersion: identity.extractorVersion,
          normalizerVersion: "identity-v2",
        },
      ],
      operations: {
        claim({ operationId, domain, requestDigest }) {
          if (canonical.operationStatus(operationId).status === "committed")
            throw new ExtractionStorageError(
              "CONFLICT",
              "Canonical operation ID is reserved.",
            );
          const old = rows(
            db,
            "SELECT domain,digest FROM proof_operation_claims WHERE id=?",
            [operationId],
          )[0];
          if (old && (old.domain !== domain || old.digest !== requestDigest))
            throw new ExtractionStorageError(
              "CONFLICT",
              "Operation is claimed by another domain or payload.",
            );
          if (!old)
            db.exec({
              sql: "INSERT INTO proof_operation_claims VALUES(?,?,?)",
              bind: [operationId, domain, requestDigest],
            });
        },
      },
      beforeCommit: () => {
        if (failCommit) throw new Error("synthetic precommit failure");
      },
      ...(limits ? { limits } : {}),
    });
    repo.initialize();
    return repo;
  };
  let repo = make();
  return {
    get db() {
      return db;
    },
    get repo() {
      return repo;
    },
    get canonical() {
      return canonical;
    },
    attachmentOp,
    fail(value: boolean) {
      failCommit = value;
    },
    override(value: Partial<CanonicalExtractionIdentity> | null) {
      override = value;
    },
    reopen() {
      repo.close();
      db.close();
      db = new sqlite.oo1.DB(filename, "w");
      canonical = new CanonicalRepository(db, {
        assertBlobAvailable: () => {},
      });
      repo = make();
    },
    close() {
      repo.close();
      db.close();
    },
  };
}
function begin(
  f: ReturnType<typeof fixture>,
  override: Partial<ExtractionIdentity> = {},
) {
  return f.repo.execute("beginDocumentExtraction", {
    operationId: next(),
    identity: { ...identity, ...override },
  });
}
function page(
  f: ReturnType<typeof fixture>,
  runId: string,
  number = 1,
  count = 1,
  writerEpoch = 1,
) {
  const value = f.repo.execute("beginExtractionPage", {
    operationId: next(),
    runId,
    writerEpoch,
    page: number,
    documentPageCount: count,
  });
  return { runId, writerEpoch, pageAttemptId: value.pageAttemptId };
}
function span(start: number, text: string, itemIndex = 0): PageSourceSpan {
  return {
    start,
    end: start + text.length,
    source: {
      itemIndex,
      itemStart: start,
      itemEnd: start + text.length,
      transform: [1, 0, 0, 1, 40, 750],
      width: 200,
      height: 12,
      direction: "ltr",
    },
  };
}
function stage(
  f: ReturnType<typeof fixture>,
  p: Omit<ExtractionPageWrite, "operationId">,
  text: string,
  sequence = 0,
  offset = 0,
  spans = [span(offset, text)],
) {
  const args = {
    ...p,
    operationId: next(),
    sequence,
    expectedUTF16Offset: offset,
    text,
    spans,
  };
  return { args, receipt: f.repo.execute("stagePageText", args) };
}
function publish(
  f: ReturnType<typeof fixture>,
  p: Omit<ExtractionPageWrite, "operationId">,
  text: string,
  spans: PageSourceSpan[],
  lastSequence = 0,
) {
  const args = {
    ...p,
    operationId: next(),
    lastSequence,
    expectedUTF16Length: text.length,
    expectedTextSha256: extractionTextDigest(text),
    expectedMapSha256: extractionMapDigest(spans),
    itemCount: Math.max(
      0,
      ...spans.map((s) => (s.source?.itemIndex ?? -1) + 1),
    ),
    classification: (text.trim().length < 8 ? "possible_scanned" : "text") as
      | "text"
      | "possible_scanned",
  };
  return { args, receipt: f.repo.execute("publishExtractionPage", args) };
}
function status(f: ReturnType<typeof fixture>) {
  return f.repo.execute("getDocumentExtraction", {
    documentId: identity.documentId,
  })!;
}
function clean(f: ReturnType<typeof fixture>) {
  let count = 0;
  for (let i = 0; i < 200; i++) {
    const slice = f.repo.cleanup({ maxRows: 7 });
    assert.ok(slice.rows <= 7 && slice.bytes <= 1048576);
    count += slice.rows;
    if (!slice.rows) return count;
  }
  throw new Error("Cleanup failed to converge");
}
function canonicalFingerprint(f: ReturnType<typeof fixture>) {
  return extractionDigest({
    records: rows(
      f.db,
      "SELECT collection,id,payload FROM quixi_records ORDER BY collection,id",
    ),
    sync: rows(f.db, "SELECT * FROM quixi_sync_ops ORDER BY sequence"),
  });
}

test("atomic page source preserves cross-event lexical phrase, Unicode/NUL maps and canonical history", () => {
  const f = fixture();
  try {
    const before = canonicalFingerprint(f),
      run = begin(f),
      p = page(f, run.runId);
    const parts = ["A silver ", "fox café 😀\0 crosses events."];
    let offset = 0;
    const maps: PageSourceSpan[] = [];
    for (const [sequence, text] of parts.entries()) {
      const s = span(offset, text);
      stage(f, p, text, sequence, offset, [s]);
      maps.push(s);
      offset += text.length;
      assert.equal(f.repo.publishedSources.loadPage(p.pageAttemptId), null);
      assert.deepEqual(f.repo.publishedSources.readPublicationBatch(32), []);
    }
    const completed = publish(f, p, parts.join(""), maps, 1);
    assert.equal(status(f).completedPage, 1);
    assert.equal(status(f).currentPage, null);
    const material = f.repo.publishedSources.loadPage(p.pageAttemptId)!;
    assert.equal(material.text, parts.join(""));
    assert.deepEqual(material.ref, completed.receipt.pageRef);
    const chunker = new StructuralChunker({
      sourceType: "document",
      sourceId: identity.documentId,
      partId: null,
      sourceDigest: material.ref.sourceDigest,
      contextPrefix: "Synthetic PDF",
      page: 1,
    });
    f.db.exec("CREATE VIRTUAL TABLE proof_fts USING fts5(text)");
    for (const chunk of [
      ...chunker.push(material.text.slice(0, 9)),
      ...chunker.push(material.text.slice(9)),
      ...chunker.finish(),
    ])
      f.db.exec({
        sql: "INSERT INTO proof_fts VALUES(?)",
        bind: [chunk.text.replaceAll("\0", " ")],
      });
    assert.equal(
      f.db.selectValue(
        "SELECT count(*) FROM proof_fts WHERE proof_fts MATCH ?",
        ['"silver fox"'],
      ),
      1,
    );
    assert.equal(canonicalFingerprint(f), before);
    assert.equal(f.db.selectValue("PRAGMA integrity_check"), "ok");
  } finally {
    f.close();
  }
});

test("stage and publication lost-reply retries return original immutable receipts after completion", () => {
  const f = fixture();
  try {
    const run = begin(f),
      p = page(f, run.runId),
      a = stage(f, p, "stable result");
    const b = publish(f, p, a.args.text, a.args.spans);
    f.repo.execute("completeDocumentExtraction", {
      operationId: next(),
      runId: run.runId,
      writerEpoch: 1,
    });
    assert.deepEqual(f.repo.execute("stagePageText", a.args), a.receipt);
    assert.deepEqual(
      f.repo.execute("publishExtractionPage", b.args),
      b.receipt,
    );
    assert.deepEqual(f.repo.operationStatus(a.args.operationId), {
      status: "committed",
      requestDigest: extractionDigest({
        operation: "stagePageText",
        args: a.args,
      }),
      result: a.receipt,
    });
    assert.throws(
      () => f.repo.execute("stagePageText", { ...a.args, text: "x" }),
      code("INVALID_REQUEST"),
    );
    assert.throws(
      () =>
        f.repo.execute("stagePageText", { ...a.args, text: "stable resulX" }),
      code("CONFLICT"),
    );
    assert.throws(
      () =>
        f.repo.execute("publishExtractionPage", {
          ...b.args,
          expectedTextSha256: "0".repeat(64),
        }),
      code("CONFLICT"),
    );
    assert.equal(status(f).completedPage, 1);
  } finally {
    f.close();
  }
});

test("precommit failure rolls back stage, publication, checkpoint, outbox and durable claims", () => {
  const f = fixture();
  try {
    const run = begin(f),
      p = page(f, run.runId);
    f.fail(true);
    const args = {
      ...p,
      operationId: next(),
      sequence: 0,
      expectedUTF16Offset: 0,
      text: "rollback",
      spans: [span(0, "rollback")],
    };
    assert.throws(() => f.repo.execute("stagePageText", args), /precommit/);
    f.fail(false);
    assert.equal(status(f).currentPage!.nextSequence, 0);
    assert.equal(f.repo.operationStatus(args.operationId).status, "not_found");
    assert.equal(
      rows(f.db, "SELECT id FROM proof_operation_claims WHERE id=?", [
        args.operationId,
      ]).length,
      0,
    );
    f.repo.execute("stagePageText", args);
    const end = {
      ...p,
      operationId: next(),
      lastSequence: 0,
      expectedUTF16Length: 8,
      expectedTextSha256: extractionTextDigest("rollback"),
      expectedMapSha256: extractionMapDigest(args.spans),
      itemCount: 1,
      classification: "text" as const,
    };
    f.fail(true);
    assert.throws(
      () => f.repo.execute("publishExtractionPage", end),
      /precommit/,
    );
    f.fail(false);
    assert.equal(status(f).completedPage, 0);
    assert.equal(f.repo.publishedSources.loadPage(p.pageAttemptId), null);
    assert.equal(f.repo.publishedSources.readPublicationBatch(32).length, 0);
    assert.equal(f.repo.operationStatus(end.operationId).status, "not_found");
    f.repo.execute("publishExtractionPage", end);
  } finally {
    f.close();
  }
});

test("interruption retains completed pages, resume CAS fences old writer and cleans abandoned attempts", () => {
  const f = fixture();
  try {
    const run = begin(f),
      p1 = page(f, run.runId, 1, 2),
      s1 = stage(f, p1, "completed first page"),
      ref = publish(f, p1, s1.args.text, s1.args.spans).receipt.pageRef;
    const p2 = page(f, run.runId, 2, 2);
    stage(f, p2, "unfinished");
    f.repo.execute("interruptDocumentExtraction", {
      operationId: next(),
      runId: run.runId,
      writerEpoch: 1,
      reason: "user_cancelled",
    });
    assert.equal(status(f).completedPage, 1);
    assert.equal(f.repo.publishedSources.current(ref), true);
    const claim = {
      operationId: next(),
      runId: run.runId,
      expectedWriterEpoch: 1,
    };
    const resumed = f.repo.execute("resumeDocumentExtraction", claim);
    assert.equal(resumed.writerEpoch, 2);
    assert.throws(
      () =>
        f.repo.execute("resumeDocumentExtraction", {
          ...claim,
          operationId: next(),
        }),
      code("STALE_WRITER"),
    );
    assert.throws(() => stage(f, p2, "late", 1, 10), code("STALE_WRITER"));
    assert.throws(() => page(f, run.runId, 2, 2, 2), code("OVERLOADED"));
    assert.ok(clean(f) > 0);
    const retry = page(f, run.runId, 2, 2, 2);
    const s2 = stage(f, retry, "finished second page");
    publish(f, retry, s2.args.text, s2.args.spans);
    assert.equal(f.repo.publishedSources.current(ref), true);
    assert.equal(status(f).completedPage, 2);
  } finally {
    f.close();
  }
});

test("actual SQLite close/reopen retains staged sequence, checkpoints and receipts without producer-loss inference", () => {
  const f = fixture();
  try {
    const run = begin(f),
      p = page(f, run.runId),
      a = stage(f, p, "owner ");
    f.reopen();
    assert.equal(status(f).state, "working");
    assert.equal(status(f).writerEpoch, 1);
    assert.equal(status(f).currentPage!.nextSequence, 1);
    assert.deepEqual(f.repo.execute("stagePageText", a.args), a.receipt);
    const b = stage(f, p, "handoff", 1, 6);
    const out = publish(
      f,
      p,
      a.args.text + b.args.text,
      [...a.args.spans, ...b.args.spans],
      1,
    );
    f.reopen();
    assert.equal(
      f.repo.publishedSources.loadPage(p.pageAttemptId)!.text,
      "owner handoff",
    );
    assert.deepEqual(
      f.repo.execute("publishExtractionPage", out.args),
      out.receipt,
    );
  } finally {
    f.close();
  }
});

test("replacement versions switch atomically and stale hash/page refs are suppressed before outbox drain", () => {
  const f = fixture();
  try {
    const old = begin(f),
      p = page(f, old.runId),
      a = stage(f, p, "same visible text"),
      ref = publish(f, p, a.args.text, a.args.spans).receipt.pageRef;
    f.repo.execute("completeDocumentExtraction", {
      operationId: next(),
      runId: old.runId,
      writerEpoch: 1,
    });
    const replacement = begin(f, { normalizerVersion: "identity-v2" });
    assert.equal(f.repo.publishedSources.current(ref), true);
    const nextPage = page(f, replacement.runId),
      b = stage(f, nextPage, a.args.text),
      newRef = publish(f, nextPage, b.args.text, b.args.spans).receipt.pageRef;
    assert.notEqual(newRef.sourceDigest, ref.sourceDigest);
    assert.equal(f.repo.publishedSources.current(ref), false);
    assert.equal(f.repo.publishedSources.current(newRef), true);
    assert.throws(
      () =>
        f.repo.execute("readExtractedPageText", {
          pageRef: ref,
          startUTF16: 0,
          maxUTF16: 16,
        }),
      code("CONFLICT"),
    );
    assert.equal(f.repo.publishedSources.readPublicationBatch(32).length, 2);
    f.override({ attachmentSha256: "0".repeat(64) });
    assert.equal(f.repo.publishedSources.current(newRef), false);
    assert.equal(
      f.repo.publishedSources.loadPage(nextPage.pageAttemptId),
      null,
    );
    assert.throws(
      () =>
        f.repo.execute("completeDocumentExtraction", {
          operationId: next(),
          runId: replacement.runId,
          writerEpoch: 1,
        }),
      code("SOURCE_UNAVAILABLE"),
    );
  } finally {
    f.close();
  }
});

test("bounded map cursors preserve original spans and reject changed ranges and surrogate slicing", () => {
  const f = fixture();
  try {
    const run = begin(f),
      p = page(f, run.runId),
      parts = ["😀\0" + "a".repeat(120), "b".repeat(120)],
      all: PageSourceSpan[] = [];
    let offset = 0;
    for (const [sequence, text] of parts.entries()) {
      const maps: PageSourceSpan[] = [];
      let at = offset;
      for (const scalar of text) {
        maps.push(span(at, scalar));
        at += scalar.length;
      }
      stage(f, p, text, sequence, offset, maps);
      all.push(...maps);
      offset = at;
    }
    const ref = publish(f, p, parts.join(""), all, 1).receipt.pageRef;
    let cursor: string | null = null;
    const found: PageSourceSpan[] = [];
    let steps = 0;
    do {
      const result: ExtractionOperations["readExtractedPageMap"]["result"] =
        f.repo.execute("readExtractedPageMap", {
          pageRef: ref,
          startUTF16: 0,
          endUTF16: offset,
          maxItems: 3,
          maxBytes: 2048,
          cursor,
        });
      assert.ok(result.items.length <= 3 && result.bytes <= 2048);
      found.push(...result.items);
      cursor = result.nextCursor;
      if (cursor)
        assert.throws(
          () =>
            f.repo.execute("readExtractedPageMap", {
              pageRef: ref,
              startUTF16: 1,
              endUTF16: offset,
              maxItems: 3,
              maxBytes: 2048,
              cursor,
            }),
          code("CONFLICT"),
        );
      assert.ok(++steps < 100);
    } while (cursor);
    assert.deepEqual(found, all);
    assert.throws(
      () =>
        f.repo.execute("readExtractedPageText", {
          pageRef: ref,
          startUTF16: 1,
          maxUTF16: 10,
        }),
      code("INVALID_REQUEST"),
    );
    assert.equal(
      f.repo.execute("readExtractedPageText", {
        pageRef: ref,
        startUTF16: 0,
        maxUTF16: 3,
      }).text,
      "😀\0",
    );
  } finally {
    f.close();
  }
});

test("published page above legacy65536 limit remains one bounded source and cleanup preserves original receipts", () => {
  const f = fixture();
  try {
    const before = canonicalFingerprint(f),
      run = begin(f),
      p = page(f, run.runId),
      text = "a".repeat(65530) + "\0 café 😀" + "z".repeat(9000);
    const maps: PageSourceSpan[] = [];
    let sequence = 0;
    for (let offset = 0; offset < text.length; ) {
      let end = Math.min(offset + 4096, text.length);
      if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
      const part = text.slice(offset, end),
        s = span(offset, part);
      stage(f, p, part, sequence++, offset, [s]);
      maps.push(s);
      offset = end;
    }
    const published = publish(f, p, text, maps, sequence - 1);
    assert.equal(f.repo.publishedSources.loadPage(p.pageAttemptId)!.text, text);
    assert.equal(
      f.repo.execute("readExtractedPageText", {
        pageRef: published.receipt.pageRef,
        startUTF16: 65530,
        maxUTF16: 8,
      }).text,
      "\0 café ",
    );
    const current = status(f);
    const cleared = f.repo.execute("clearDocumentExtraction", {
      operationId: next(),
      documentId: identity.documentId,
      expectedRunId: run.runId,
      expectedDocumentRevision: current.documentRevision,
    });
    assert.equal(cleared.cleared, true);
    assert.equal(
      f.repo.publishedSources.current(published.receipt.pageRef),
      false,
    );
    assert.ok(clean(f) > 0);
    assert.equal(
      f.db.selectValue("SELECT count(*) FROM quixi_extract_pages"),
      0,
    );
    assert.deepEqual(
      f.repo.execute("publishExtractionPage", published.args),
      published.receipt,
    );
    assert.equal(canonicalFingerprint(f), before);
  } finally {
    f.close();
  }
});

test("logical capacity rejection atomically retains earlier page and does not claim failed operation", () => {
  const f = fixture({ runBytes: 13000 });
  try {
    const run = begin(f),
      p = page(f, run.runId, 1, 2),
      a = stage(f, p, "first survives");
    const ref = publish(f, p, a.args.text, a.args.spans).receipt.pageRef;
    clean(f);
    const second = page(f, run.runId, 2, 2);
    const text = "z".repeat(4096),
      args = {
        ...second,
        operationId: next(),
        sequence: 0,
        expectedUTF16Offset: 0,
        text,
        spans: [span(0, text)],
      };
    let failed = args;
    try {
      f.repo.execute("stagePageText", args);
      failed = {
        ...args,
        operationId: next(),
        sequence: 1,
        expectedUTF16Offset: 4096,
        spans: [span(4096, text)],
      };
      assert.throws(
        () => f.repo.execute("stagePageText", failed),
        code("CAPACITY"),
      );
    } catch (e) {
      assert.ok(code("CAPACITY")(e));
    }
    assert.equal(
      f.repo.operationStatus(failed.operationId).status,
      "not_found",
    );
    assert.equal(f.repo.publishedSources.current(ref), true);
    assert.equal(status(f).completedPage, 1);
    assert.ok(status(f).retainedBytes <= 13000);
  } finally {
    f.close();
  }
});

test("empty/scanned pages publish checkpoint and bad final digest leaves page invisible", () => {
  const f = fixture();
  try {
    const run = begin(f),
      p = page(f, run.runId);
    const bad = {
      ...p,
      operationId: next(),
      lastSequence: -1,
      expectedUTF16Length: 0,
      expectedTextSha256: "0".repeat(64),
      expectedMapSha256: extractionMapDigest([]),
      itemCount: 0,
      classification: "possible_scanned" as const,
    };
    assert.throws(
      () => f.repo.execute("publishExtractionPage", bad),
      code("CONFLICT"),
    );
    assert.equal(status(f).completedPage, 0);
    const out = publish(f, p, "", [], -1);
    assert.equal(status(f).completedPage, 1);
    assert.equal(
      f.repo.publishedSources.loadPage(p.pageAttemptId)!.classification,
      "possible_scanned",
    );
    assert.equal(f.repo.publishedSources.loadPage(p.pageAttemptId)!.text, "");
    assert.equal(f.repo.execute('readExtractedPageText', {
      pageRef: out.receipt.pageRef, startUTF16: 0, maxUTF16: 1,
    }).classification, 'possible_scanned');
    assert.ok(out.receipt.pageRef.sourceDigest);
  } finally {
    f.close();
  }
});

test('bounded text windows retain the published page classification, independently of window length', () => {
  for (const [text, classification] of [['1', 'possible_scanned'], ['Enough native text to classify this page.', 'text']] as const) {
    const f = fixture();
    try {
      const run = begin(f), p = page(f, run.runId);
      const spans = [span(0, text)];
      stage(f, p, text, 0, 0, spans);
      const out = publish(f, p, text, spans);
      const window = f.repo.execute('readExtractedPageText', {
        pageRef: out.receipt.pageRef, startUTF16: 0, maxUTF16: 1,
      });
      assert.equal(window.text, text[0]);
      assert.equal(window.classification, classification);
      assert.equal(window.totalUTF16, text.length);
    } finally { f.close(); }
  }
});

test("outbox ack composes with owner transaction; subsequent page leaves earlier ref and document revision stable", () => {
  const f = fixture();
  try {
    const run = begin(f),
      p = page(f, run.runId, 1, 2),
      a = stage(f, p, "first page"),
      ref = publish(f, p, a.args.text, a.args.spans).receipt.pageRef;
    const event = f.repo.publishedSources.readPublicationBatch(32)[0]!;
    assert.equal(event.kind, "replace");
    f.db.exec("BEGIN IMMEDIATE");
    f.repo.publishedSources.acknowledgePublications([event.revision]);
    f.db.exec("ROLLBACK");
    assert.equal(f.repo.publishedSources.readPublicationBatch(32).length, 1);
    f.db.exec("BEGIN IMMEDIATE");
    f.repo.publishedSources.acknowledgePublications([event.revision]);
    f.db.exec("COMMIT");
    assert.equal(f.repo.publishedSources.readPublicationBatch(32).length, 0);
    const revision = status(f).documentRevision,
      p2 = page(f, run.runId, 2, 2),
      b = stage(f, p2, "second page");
    publish(f, p2, b.args.text, b.args.spans);
    assert.equal(status(f).documentRevision, revision);
    assert.equal(f.repo.publishedSources.current(ref), true);
    assert.equal(
      f.repo.publishedSources.readPublicationBatch(32)[0]!.kind,
      "page",
    );
    assert.equal(
      f.repo.publishedSources.listVisiblePages(identity.documentId, null, 32)
        .length,
      2,
    );
  } finally {
    f.close();
  }
});

test("derived schema failure leaves canonical writes usable and does not install canonical trigger dependencies", () => {
  const f = fixture();
  try {
    begin(f);
    f.repo.close();
    f.db.exec("DROP TABLE quixi_extract_map_batches");
    const broken = new ExtractionRepository(f.db, {
      lookupIdentity: () => null,
      operations: { claim: () => {} },
      supportedVersions: [],
    });
    assert.throws(() => broken.initialize(), code("MIGRATION_FAILED"));
    assert.equal(broken.publishedSources.ready(), false);
    f.canonical.commit({
      transactionId: next(),
      expectedThreadRevisions: [],
      stagedBlobIds: [],
      mutations: [
        {
          version: 1,
          operationId: next(),
          kind: "SetDocumentTitle",
          recordedAt: 2,
          payload: {
            documentId: identity.documentId,
            value: "Canonical remains writable",
          },
        },
      ],
    });
    assert.equal(
      f.canonical.get("documents", identity.documentId)!.title,
      "Canonical remains writable",
    );
    assert.equal(
      f.db.selectValue(
        "SELECT count(*) FROM sqlite_schema WHERE type='trigger' AND sql LIKE '%quixi_extract_%'",
      ),
      0,
    );
  } finally {
    f.close();
  }
});

test("durable claim adapter rejects canonical/other-domain ID reuse and cleans claim on failure", () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        f.repo.execute("beginDocumentExtraction", {
          operationId: f.attachmentOp,
          identity,
        }),
      code("CONFLICT"),
    );
    assert.equal(
      f.db.selectValue("SELECT count(*) FROM quixi_extract_runs"),
      0,
    );
    const reserved = next();
    f.db.exec({
      sql: "INSERT INTO proof_operation_claims VALUES(?,?,?)",
      bind: [reserved, "other", "abc"],
    });
    assert.throws(
      () =>
        f.repo.execute("beginDocumentExtraction", {
          operationId: reserved,
          identity,
        }),
      code("CONFLICT"),
    );
    assert.equal(f.repo.operationStatus(reserved).status, "not_found");
  } finally {
    f.close();
  }
});

test("pure boundary validators reject getters, unknown keys, malformed maps, oversized payload and lone surrogates", () => {
  const args = {
    operationId: next(),
    runId: next(),
    writerEpoch: 1,
    pageAttemptId: next(),
    sequence: 0,
    expectedUTF16Offset: 0,
    text: "x",
    spans: [span(0, "x")],
  };
  assertExtractionArgs("stagePageText", args);
  for (const invalid of [
    { ...args, extra: true },
    { ...args, text: "\ud800" },
    { ...args, spans: [{ ...span(0, "x"), start: 1 }] },
    { ...args, text: "x".repeat(4097) },
    {
      ...args,
      spans: [
        {
          ...span(0, "x"),
          source: {
            ...span(0, "x").source!,
            transform: [Infinity, 0, 0, 1, 0, 0],
          },
        },
      ],
    },
  ])
    assert.throws(
      () => assertExtractionArgs("stagePageText", invalid),
      code("INVALID_REQUEST"),
    );
  let getter = false;
  assert.throws(
    () =>
      assertExtractionArgs("stagePageText", {
        ...args,
        get text() {
          getter = true;
          return "x";
        },
      }),
    code("INVALID_REQUEST"),
  );
  assert.equal(getter, false);
  assert.equal(EXTRACTION_LIMITS.runBytes, 256 * 1024 * 1024);
  assert.equal(EXTRACTION_LIMITS.archiveBytes, 1024 * 1024 * 1024);
});

test("reserved logical admission permits clear after payload exhaustion and bounded queues reclaim it", () => {
  const f = fixture({ runBytes: 13000, archiveBytes: 18000 });
  try {
    const run = begin(f),
      p = page(f, run.runId, 1, 2),
      first = stage(f, p, "first retained page"),
      ref = publish(f, p, first.args.text, first.args.spans).receipt.pageRef;
    clean(f);
    const pending = page(f, run.runId, 2, 2);
    let sequence = 0,
      offset = 0;
    for (; sequence < 10; sequence++) {
      try {
        stage(f, pending, "q".repeat(2048), sequence, offset);
        offset += 2048;
      } catch (e) {
        assert.ok(code("CAPACITY")(e));
        break;
      }
    }
    assert.ok(sequence < 10);
    const current = status(f);
    f.repo.execute("clearDocumentExtraction", {
      operationId: next(),
      documentId: identity.documentId,
      expectedRunId: run.runId,
      expectedDocumentRevision: current.documentRevision,
    });
    assert.equal(f.repo.publishedSources.current(ref), false);
    assert.ok(clean(f) > 0);
    assert.equal(
      f.db.selectValue("SELECT count(*) FROM quixi_extract_pages"),
      0,
    );
    assert.equal(
      f.db.selectValue("SELECT count(*) FROM quixi_extract_cleanup_pages"),
      0,
    );
    assert.equal(
      f.db.selectValue("SELECT count(*) FROM quixi_extract_cleanup_runs"),
      0,
    );
    assert.equal(
      f.db.selectValue("SELECT used_bytes FROM quixi_extract_meta"),
      f.db.selectValue("SELECT sum(used_bytes) FROM quixi_extract_runs"),
    );
  } finally {
    f.close();
  }
});

test("maximum admitted PDF page publishes without SQL length/NUL truncation and rejects one extra scalar", () => {
  const f = fixture();
  try {
    const run = begin(f),
      p = page(f, run.runId);
    const text = "\0" + "x".repeat(EXTRACTION_LIMITS.pageUTF16 - 1),
      maps: PageSourceSpan[] = [];
    for (let offset = 0; offset < text.length; offset += 4096) {
      const value = text.slice(offset, offset + 4096),
        m = span(offset, value);
      stage(f, p, value, offset / 4096, offset, [m]);
      maps.push(m);
    }
    const extra = {
      ...p,
      operationId: next(),
      sequence: 64,
      expectedUTF16Offset: text.length,
      text: "x",
      spans: [span(text.length, "x")],
    };
    assert.throws(
      () => f.repo.execute("stagePageText", extra),
      code("INVALID_REQUEST"),
    );
    const start = performance.now();
    const published = publish(f, p, text, maps, 63);
    assert.ok(performance.now() >= start);
    assert.equal(f.repo.publishedSources.loadPage(p.pageAttemptId)!.text, text);
    assert.equal(
      f.repo.publishedSources.loadPage(p.pageAttemptId)!.utf16,
      262144,
    );
    const current = status(f);
    f.repo.execute("clearDocumentExtraction", {
      operationId: next(),
      documentId: identity.documentId,
      expectedRunId: run.runId,
      expectedDocumentRevision: current.documentRevision,
    });
    clean(f);
    assert.equal(
      f.db.selectValue("SELECT count(*) FROM quixi_extract_pages"),
      0,
    );
    assert.equal(
      f.repo.operationStatus(published.args.operationId).status,
      "committed",
    );
  } finally {
    f.close();
  }
});

test("map-byte corruption fails the local batch digest instead of returning incorrect provenance", () => {
  const f = fixture();
  try {
    const run = begin(f),
      p = page(f, run.runId),
      a = stage(f, p, "original map"),
      ref = publish(f, p, a.args.text, a.args.spans).receipt.pageRef;
    f.db.exec({
      sql: "UPDATE quixi_extract_map_batches SET maps=? WHERE page_id=?",
      bind: [
        JSON.stringify([{ ...a.args.spans[0], source: null }]),
        p.pageAttemptId,
      ],
    });
    assert.throws(
      () =>
        f.repo.execute("readExtractedPageMap", {
          pageRef: ref,
          startUTF16: 0,
          endUTF16: a.args.text.length,
          maxItems: 128,
          maxBytes: 65536,
          cursor: null,
        }),
      code("MIGRATION_FAILED"),
    );
  } finally {
    f.close();
  }
});

test("array getters are rejected without execution and shared source spans do not split surrogate pairs", () => {
  let called = false;
  const text = "😀",
    maps = [span(0, text)];
  const args = {
    operationId: next(),
    runId: next(),
    writerEpoch: 1,
    pageAttemptId: next(),
    sequence: 0,
    expectedUTF16Offset: 0,
    text,
    spans: maps,
  };
  const hostile: unknown[] = [];
  Object.defineProperty(hostile, 0, {
    enumerable: true,
    get() {
      called = true;
      return maps[0];
    },
  });
  assert.throws(
    () => assertExtractionArgs("stagePageText", { ...args, spans: hostile }),
    code("INVALID_REQUEST"),
  );
  assert.equal(called, false);
  assert.throws(
    () =>
      assertExtractionArgs("stagePageText", {
        ...args,
        spans: [
          { start: 0, end: 1, source: null },
          { start: 1, end: 2, source: null },
        ],
      }),
    code("INVALID_REQUEST"),
  );
});

test("near-limit source maps finalize through bounded batches without retaining a whole map array", (t) => {
  const f = fixture();
  try {
    const run = begin(f),
      p = page(f, run.runId),
      mapHash = createHash("sha256");
    let sequence = 0,
      offset = 0,
      mapCount = 0;
    for (; sequence < 256; sequence++) {
      const text = "x\n".repeat(64),
        maps: PageSourceSpan[] = [];
      for (let i = 0; i < 128; i++) {
        const start = offset + i;
        if (i % 2 === 0) {
          const copied = span(start, "x");
          copied.source!.itemStart = start / 2;
          copied.source!.itemEnd = start / 2 + 1;
          maps.push(copied);
        } else maps.push({ start, end: start + 1, source: null });
      }
      try {
        stage(f, p, text, sequence, offset, maps);
      } catch (e) {
        assert.ok(code("CAPACITY")(e));
        break;
      }
      for (const map of maps)
        mapHash.update(
          canonicalJson(map as unknown as Parameters<typeof canonicalJson>[0]) +
            "\n",
        );
      offset += 128;
      mapCount += 128;
    }
    assert.ok(mapCount >= 24000 && mapCount <= 32768);
    const text = "x\n".repeat(offset / 2),
      start = performance.now();
    const out = f.repo.execute("publishExtractionPage", {
      ...p,
      operationId: next(),
      lastSequence: sequence - 1,
      expectedUTF16Length: offset,
      expectedTextSha256: extractionTextDigest(text),
      expectedMapSha256: mapHash.digest("hex"),
      itemCount: 1,
      classification: "text",
    });
    const elapsedMs = performance.now() - start;
    assert.equal(f.repo.publishedSources.loadPage(p.pageAttemptId)!.text, text);
    t.diagnostic(
      "quixi-extraction-metric " +
        JSON.stringify({
          fixture: "near-map-limit",
          mapCount,
          utf16: offset,
          batches: sequence,
          publishElapsedMs: elapsedMs,
          sourceDigest: out.pageRef.sourceDigest,
        }),
    );
  } finally {
    f.close();
  }
});

test("actual SQLite FULL rolls back new stage/claim while retaining committed pages", () => {
  const f = fixture();
  try {
    const before = canonicalFingerprint(f),
      run = begin(f),
      p1 = page(f, run.runId, 1, 2),
      a = stage(f, p1, "committed before full"),
      ref = publish(f, p1, a.args.text, a.args.spans).receipt.pageRef;
    clean(f);
    const p2 = page(f, run.runId, 2, 2);
    const pageCount = Number(f.db.selectValue("PRAGMA page_count"));
    f.db.exec(`PRAGMA max_page_count=${pageCount}`);
    let rejected: ReturnType<typeof stage>["args"] | null = null;
    for (let sequence = 0; sequence < 16; sequence++) {
      const text = "s".repeat(4096),
        offset = sequence * 4096,
        args = {
          ...p2,
          operationId: next(),
          sequence,
          expectedUTF16Offset: offset,
          text,
          spans: [span(offset, text)],
        };
      try {
        f.repo.execute("stagePageText", args);
      } catch (e) {
        assert.ok(code("CAPACITY")(e), String(e));
        rejected = args;
        break;
      }
    }
    assert.ok(rejected, "Fixture did not reach actual SQLite page capacity");
    assert.equal(
      f.repo.operationStatus(rejected.operationId).status,
      "not_found",
    );
    assert.equal(status(f).currentPage!.nextSequence, rejected.sequence);
    assert.equal(f.repo.publishedSources.current(ref), true);
    assert.equal(canonicalFingerprint(f), before);
    f.db.exec("PRAGMA max_page_count=2147483646");
    const retry = f.repo.execute("stagePageText", rejected);
    assert.equal(retry.sequence, rejected.sequence);
    assert.equal(
      f.repo.operationStatus(rejected.operationId).status,
      "committed",
    );
  } finally {
    f.close();
  }
});
