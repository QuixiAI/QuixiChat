import { openActiveStorageClient } from "@quixi/storage/client";
import type { ArchiveStorageClient } from "@quixi/storage/client";
import {
  DOCUMENT_EXTRACTION_VERSIONS,
  canonicalJson,
} from "@quixi/core/contracts";
import type {
  StorageOperations,
  MutationBatch,
  ExtractionPageWrite,
  PageSourceSpan,
  ExtractionIdentity,
  PublishedPageRef,
} from "@quixi/core/contracts";
import type { JsonValue } from "@quixi/core/model";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
const id = () => crypto.randomUUID();
let client: ArchiveStorageClient | undefined,
  dropped = 0,
  dropId: string | undefined;
const NativeWorker = Worker;
globalThis.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    this.addEventListener("message", (event) => {
      if (
        event.data.type === "reply" &&
        event.data.ok &&
        event.data.id === dropId
      ) {
        dropId = undefined;
        dropped++;
        event.stopImmediatePropagation();
      }
    });
  }
};
async function request<K extends keyof StorageOperations>(
  operation: K,
  args: StorageOperations[K]["args"],
  drop = false,
): Promise<StorageOperations[K]["result"]> {
  const requestId = id();
  if (drop) dropId = requestId;
  return client!.request(requestId, operation, args);
}
const digest = (text: string) =>
  bytesToHex(sha256(new TextEncoder().encode(text)));
const spansFor = (offset: number, text: string): PageSourceSpan[] =>
  text
    ? [
        {
          start: offset,
          end: offset + text.length,
          source: {
            itemIndex: 0,
            itemStart: offset,
            itemEnd: offset + text.length,
            transform: [1, 0, 0, 1, 40, 750],
            width: 200,
            height: 12,
            direction: "ltr",
          },
        },
      ]
    : [];
function stageArgs(
  write: Omit<ExtractionPageWrite, "operationId">,
  text: string,
  sequence = 0,
  offset = 0,
) {
  return {
    ...write,
    operationId: id(),
    sequence,
    expectedUTF16Offset: offset,
    text,
    spans: spansFor(offset, text),
  };
}
function publishArgs(
  write: Omit<ExtractionPageWrite, "operationId">,
  fragments: string[],
) {
  const hash = sha256.create();
  let offset = 0;
  for (const text of fragments) {
    for (const span of spansFor(offset, text))
      hash.update(
        new TextEncoder().encode(
          canonicalJson(span as unknown as JsonValue) + "\n",
        ),
      );
    offset += text.length;
  }
  return {
    ...write,
    operationId: id(),
    lastSequence: fragments.length - 1,
    expectedUTF16Length: offset,
    expectedTextSha256: digest(fragments.join("")),
    expectedMapSha256: bytesToHex(hash.digest()),
    itemCount: offset ? 1 : 0,
    classification: (offset ? "text" : "possible_scanned") as
      | "text"
      | "possible_scanned",
  };
}
async function seed() {
  const bytes = new Uint8Array(
    await (
      await fetch(
        new URL(
          "../../../documents/tests/fixtures/pages-100.pdf",
          import.meta.url,
        ),
      )
    ).arrayBuffer(),
  );
  if (bytes.length > 131072)
    throw new Error("Small checked-in PDF fixture exceeded explicit admission");
  const hash = bytesToHex(sha256(bytes)),
    attachmentId = id(),
    documentId = id();
  const beginArgs = {
    operationId: id(),
    purpose: "document" as const,
    expectedBytes: bytes.length,
    expectedSha256: hash,
  };
  const transfer = await request("beginBlobTransfer", beginArgs);
  await client!.sendChunk({
    transferId: transfer.transferId,
    sequence: 0,
    offset: 0,
    bytes,
    final: true,
  });
  await request("finishBlobTransfer", {
    operationId: id(),
    transferId: transfer.transferId,
    expectedBytes: beginArgs.expectedBytes,
    expectedSha256: hash,
  });
  const { workspaceId } = await request("archiveWorkspace", null);
  const batch: MutationBatch = {
    transactionId: id(),
    expectedThreadRevisions: [],
    stagedBlobIds: [transfer.transferId],
    mutations: [
      {
        version: 1,
        operationId: id(),
        recordedAt: 1,
        kind: "RegisterAttachment",
        payload: {
          attachment: {
            id: attachmentId,
            availability: "available",
            filename: "redistributable-fixture.pdf",
            mimeType: "application/pdf",
            sizeBytes: beginArgs.expectedBytes,
            blobSha256: hash,
            rawObjectId: null,
          },
        },
      },
      {
        version: 1,
        operationId: id(),
        recordedAt: 1,
        kind: "RegisterDocument",
        payload: {
          document: {
            id: documentId,
            workspaceId,
            attachmentId,
            title: "Public PDF persistence fixture",
            createdAt: null,
            recordedAt: 1,
            importSourceId: null,
          },
        },
      },
    ],
  };
  await request("commit", batch);
  const identity: ExtractionIdentity = {
    documentId,
    attachmentId,
    attachmentSha256: hash,
    attachmentByteLength: beginArgs.expectedBytes,
    ...DOCUMENT_EXTRACTION_VERSIONS,
  };
  return {
    identity,
    canonicalOperationIds: batch.mutations.map((m) => m.operationId),
    blobOperationId: beginArgs.operationId,
    diagnostics: await request("diagnostics", null),
  };
}
async function original(identity: ExtractionIdentity) {
  const read = await request("readBlobTransfer", {
      sha256: identity.attachmentSha256,
    }),
    hash = sha256.create();
  let total = 0,
    peak = 0;
  for (;;) {
    const chunk = await client!.readChunk(read.transferId);
    hash.update(chunk.bytes);
    total += chunk.bytes.length;
    peak = Math.max(peak, chunk.bytes.length);
    await client!.acknowledgeChunk({
      transferId: read.transferId,
      sequence: chunk.sequence,
      committedOffset: chunk.offset + chunk.bytes.length,
    });
    if (chunk.final) break;
  }
  return { sha256: bytesToHex(hash.digest()), byteLength: total, peak };
}
async function allocationLoss(identity: ExtractionIdentity) {
  const fast = await openActiveStorageClient({ timeoutMs: 250 });
  const before = dropped;
  const ensure = (ok: unknown, why: string) => {
    if (!ok) throw new Error(why);
  };
  const lose = async (
    operation: "readBlobTransfer" | "sliceBlobTransfer",
    args:
      | { sha256: string }
      | { transferId: string; offset: number; byteLength: number },
  ) => {
    const requestId = id();
    dropId = requestId;
    try {
      await fast.request(requestId, operation, args);
      throw new Error("Expected a lost creation reply");
    } catch (error) {
      ensure(
        (error as { code?: string }).code === "UNKNOWN_OUTCOME",
        String(error),
      );
    }
    const cleanup = await fast.request(id(), "discardBlobTransfer", {
      transferId: requestId,
    });
    ensure(
      cleanup.discarded,
      "Known request ID did not release the committed allocation",
    );
  };
  try {
    for (let n = 0; n < 10; n++)
      await lose("readBlobTransfer", { sha256: identity.attachmentSha256 });
    const all = [];
    for (let n = 0; n < 8; n++) {
      const requestId = id();
      const value = await fast.request(requestId, "readBlobTransfer", {
        sha256: identity.attachmentSha256,
      });
      ensure(value.transferId === requestId, "Read transfer identity changed");
      all.push(value.transferId);
    }
    for (const transferId of all)
      await fast.request(id(), "discardBlobTransfer", { transferId });
    const parentId = id(),
      parent = await fast.request(parentId, "readBlobTransfer", {
        sha256: identity.attachmentSha256,
      });
    for (let n = 0; n < 10; n++)
      await lose("sliceBlobTransfer", {
        transferId: parent.transferId,
        offset: 0,
        byteLength: 16,
      });
    const children = [];
    for (let n = 0; n < 7; n++) {
      const requestId = id();
      const value = await fast.request(requestId, "sliceBlobTransfer", {
        transferId: parent.transferId,
        offset: 0,
        byteLength: 16,
      });
      ensure(value.transferId === requestId, "Slice transfer identity changed");
      children.push(value.transferId);
    }
    for (const transferId of children) {
      const chunk = await fast.readChunk(transferId);
      ensure(
        chunk.bytes.length === 16 &&
          new TextDecoder().decode(chunk.bytes).startsWith("%PDF-"),
        "Surviving child did not read original PDF bytes",
      );
      await fast.acknowledgeChunk({
        transferId,
        sequence: chunk.sequence,
        committedOffset: chunk.bytes.length,
      });
    }
    await fast.request(id(), "discardBlobTransfer", { transferId: parentId });
    ensure(
      dropped - before === 20,
      "Each successful creation reply must actually be suppressed",
    );
    return {
      lostReadReplies: 10,
      lostSliceReplies: 10,
      admittedFullReadsAfterCleanup: 8,
      admittedChildrenWithParent: 7,
    };
  } finally {
    await fast.close();
  }
}
const api = {
  async open() {
    client = await openActiveStorageClient({ timeoutMs: 1500 });
    return request("diagnostics", null);
  },
  async close() {
    await client?.close();
    client = undefined;
  },
  request,
  allocationLoss,
  seed,
  stageArgs,
  publishArgs,
  original,
  diagnostics: () => request("diagnostics", null),
  dropped: () => dropped,
  query: (query: string) =>
    request("searchArchive", {
      query,
      mode: "exact",
      filters: {},
      page: { cursor: null, maxItems: 16, maxBytes: 100000 },
    }),
  async indexed(pageRef: PublishedPageRef) {
    for (let n = 0; n < 300; n++)
      if ((await request("advanceExtractionPageIndex", { pageRef })).indexed)
        return n + 1;
    throw new Error("Page never obtained public FTS publication credit");
  },
  collision: (operationId: string, documentId: string) =>
    request("commit", {
      transactionId: id(),
      expectedThreadRevisions: [],
      stagedBlobIds: [],
      mutations: [
        {
          version: 1,
          operationId,
          recordedAt: 2,
          kind: "SetDocumentTitle",
          payload: {
            documentId,
            value: "A collision must not rename this document",
          },
        },
      ],
    }),
};
(window as unknown as { extractionTest: typeof api }).extractionTest = api;
