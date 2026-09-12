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

export {
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
  sourceSha,
};
