import { openActiveStorageClient } from "@quixi/storage/client";
import type { ArchiveStorageClient } from "@quixi/storage/client";
import { persistPdfDocument } from "@quixi/documents/storage";
import { canonicalJson } from "@quixi/core/contracts";
import type { JsonValue } from "@quixi/core/model";
import type {
  StorageOperations,
  MutationBatch,
  ExtractionRunStatus,
} from "@quixi/core/contracts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
const id = () => crypto.randomUUID();
let client: ArchiveStorageClient | undefined;
let controller: AbortController | undefined,
  resumeGate: (() => void) | undefined,
  running: Promise<void> | undefined;
let outcome: {
  state: "idle" | "running" | "completed" | "failed";
  result?: ExtractionRunStatus;
  error?: { code?: string; message: string };
} = { state: "idle" };
let paused = false;
let latest: {
  phase: string;
  runId: string | null;
  page: number;
  pages: number | null;
  indexedThroughPage: number;
} | null = null;
let firstExtractingPage: number | null = null;
const parserStartPages: number[] = [];
let activePdfWorkers = 0,
  parserWorkersStarted = 0;
let dropNextStage = false;
let droppedRequestId: string | undefined;
let droppedStage: {
  requestId: string;
  operationId: string;
  requestDigest: string;
  repliesSuppressed: number;
  recoveryLookups: number;
  stageDispatches: number;
} | null = null;
const NativeWorker = Worker;
globalThis.Worker = class extends NativeWorker {
  private released = false;
  private readonly pdf: boolean;
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    this.pdf =
      options?.name === "quixi-pdf-parser" ||
      options?.name === "quixi-document-extractor";
    this.addEventListener("message", (event) => {
      if (
        event.data.type === "reply" &&
        event.data.ok &&
        event.data.id === droppedRequestId
      ) {
        droppedRequestId = undefined;
        droppedStage!.repliesSuppressed++;
        event.stopImmediatePropagation();
      }
    });
    if (this.pdf) activePdfWorkers++;
    if (options?.name === "quixi-pdf-parser") parserWorkersStarted++;
  }
  override postMessage(
    message: unknown,
    transfer: Transferable[] | StructuredSerializeOptions = [],
  ) {
    const record = message as {
      kind?: string;
      startPage?: number;
      call?: {
        id: string;
        request?: { operation: string; args: { operationId?: string } };
      };
    };
    const call = record?.call,
      request = call?.request;
    if (dropNextStage && request?.operation === "stagePageText") {
      dropNextStage = false;
      droppedRequestId = call!.id;
      droppedStage = {
        requestId: call!.id,
        operationId: request.args.operationId!,
        requestDigest: bytesToHex(
          sha256(
            new TextEncoder().encode(
              canonicalJson({
                operation: request.operation,
                args: request.args,
              } as JsonValue),
            ),
          ),
        ),
        repliesSuppressed: 0,
        recoveryLookups: 0,
        stageDispatches: 0,
      };
    }
    if (
      droppedStage &&
      request?.args?.operationId === droppedStage.operationId
    ) {
      if (request.operation === "stagePageText") droppedStage.stageDispatches++;
      if (request.operation === "getExtractionOperation")
        droppedStage.recoveryLookups++;
    }
    if (record?.kind === "init" && Number.isInteger(record.startPage)) {
      if (parserStartPages.length >= 12)
        throw new Error("Unexpected parser restart growth");
      parserStartPages.push(record.startPage!);
    }
    if (Array.isArray(transfer)) super.postMessage(message, transfer);
    else super.postMessage(message, transfer);
  }
  override terminate() {
    if (!this.released && this.pdf) {
      activePdfWorkers--;
      this.released = true;
    }
    super.terminate();
  }
};
function request<K extends keyof StorageOperations>(
  operation: K,
  args: StorageOperations[K]["args"],
) {
  return client!.request(id(), operation, args);
}
async function seed(pages: 1 | 100) {
  const url =
    pages === 1
      ? new URL("../fixtures/pages-1.pdf", import.meta.url)
      : new URL("../fixtures/pages-100.pdf", import.meta.url);
  const data = new Uint8Array(await (await fetch(url)).arrayBuffer());
  if (data.length > 131072)
    throw new Error("Fixture source exceeded bounded setup admission");
  const byteLength = data.length,
    hash = bytesToHex(sha256(data)),
    attachmentId = id(),
    documentId = id();
  const upload = await request("beginBlobTransfer", {
    operationId: id(),
    purpose: "document",
    expectedBytes: byteLength,
    expectedSha256: hash,
  });
  for (
    let offset = 0, sequence = 0;
    offset < byteLength;
    offset += 65536, sequence++
  ) {
    const bytes = data.slice(offset, Math.min(byteLength, offset + 65536));
    await client!.sendChunk({
      transferId: upload.transferId,
      sequence,
      offset,
      bytes,
      final: offset + bytes.length === byteLength,
    });
  }
  await request("finishBlobTransfer", {
    operationId: id(),
    transferId: upload.transferId,
    expectedBytes: byteLength,
    expectedSha256: hash,
  });
  const { workspaceId } = await request("archiveWorkspace", null);
  const batch: MutationBatch = {
    transactionId: id(),
    expectedThreadRevisions: [],
    stagedBlobIds: [upload.transferId],
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
            filename: `actual-${pages}-pages.pdf`,
            mimeType: "application/pdf",
            sizeBytes: byteLength,
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
            title: `Actual ${pages}-page PDF`,
            createdAt: null,
            recordedAt: 1,
            importSourceId: null,
          },
        },
      },
    ],
  };
  await request("commit", batch);
  return { documentId, attachmentId, sha256: hash, byteLength, pages };
}
function start(documentId: string, pauseAtOne = false) {
  if (outcome.state === "running") throw new Error("Workflow already running");
  controller = new AbortController();
  paused = false;
  latest = null;
  firstExtractingPage = null;
  outcome = { state: "running" };
  running = persistPdfDocument({
    storage: client!,
    documentId,
    signal: controller.signal,
    onProgress: async (progress) => {
      latest = { ...progress };
      if (
        progress.phase === "extracting" &&
        progress.page > 0 &&
        firstExtractingPage === null
      )
        firstExtractingPage = progress.page;
      if (
        pauseAtOne &&
        progress.phase === "indexing" &&
        progress.indexedThroughPage === 1 &&
        !paused
      ) {
        paused = true;
        await new Promise<void>((resolve) => {
          resumeGate = resolve;
        });
      }
    },
  }).then(
    (result) => {
      outcome = { state: "completed", result };
    },
    (error) => {
      outcome = {
        state: "failed",
        error: { code: error?.code, message: String(error) },
      };
    },
  );
  return null;
}
async function chat() {
  const { workspaceId } = await request("archiveWorkspace", null),
    threadId = id(),
    contextId = id(),
    messageId = id();
  await request("commit", {
    transactionId: id(),
    expectedThreadRevisions: [],
    stagedBlobIds: [],
    mutations: [
      {
        version: 1,
        operationId: id(),
        recordedAt: 1,
        kind: "CreateThread",
        payload: {
          thread: {
            id: threadId,
            workspaceId,
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
            title: "Chat during PDF persistence",
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
        operationId: id(),
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
              id: id(),
              messageId,
              order: 0,
              kind: "Text",
              data: { text: "Concurrent chat stays usable: evergreen harmony" },
            },
          ],
        },
      },
    ],
  });
  return {
    threadId,
    messageId,
    parts: await request("readMessageParts", {
      messageId,
      page: { cursor: null, maxItems: 8, maxBytes: 8192 },
    }),
  };
}
const api = {
  async open() {
    client = await openActiveStorageClient({ timeoutMs: 5000 });
    return request("diagnostics", null);
  },
  async close() {
    controller?.abort();
    resumeGate?.();
    await running;
    await client?.close();
    client = undefined;
  },
  request,
  seed,
  start,
  chat,
  dropStageReply() {
    dropNextStage = true;
    droppedStage = null;
  },
  droppedStage: () => droppedStage,
  state: () => ({
    outcome,
    paused,
    latest,
    firstExtractingPage,
    parserStartPages: [...parserStartPages],
    activePdfWorkers,
    parserWorkersStarted,
  }),
  async cancel() {
    controller?.abort();
    resumeGate?.();
    resumeGate = undefined;
    await running;
    return { outcome, latest };
  },
  async finish() {
    resumeGate?.();
    resumeGate = undefined;
    await running;
    return outcome;
  },
  query: (query: string, documentId?: string) =>
    request("searchArchive", {
      query,
      mode: "exact",
      filters: documentId ? { documentIds: [documentId] } : {},
      page: { cursor: null, maxItems: 16, maxBytes: 100000 },
    }),
  async source(sha: string) {
    const read = await request("readBlobTransfer", { sha256: sha }),
      hash = sha256.create();
    let byteLength = 0;
    for (;;) {
      const chunk = await client!.readChunk(read.transferId);
      hash.update(chunk.bytes);
      byteLength += chunk.bytes.length;
      await client!.acknowledgeChunk({
        transferId: read.transferId,
        sequence: chunk.sequence,
        committedOffset: chunk.offset + chunk.bytes.length,
      });
      if (chunk.final) break;
    }
    return { sha256: bytesToHex(hash.digest()), byteLength };
  },
};
(window as unknown as { persistenceTest: typeof api }).persistenceTest = api;
