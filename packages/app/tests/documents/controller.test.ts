import { test } from "node:test";
import assert from "node:assert/strict";
import { createDocumentController } from "../../src/features/documents/controller.ts";
import { PendingDocumentImportError } from "../../src/features/documents/import-pdf.ts";
import {
  canonicalJson,
  DOCUMENT_EXTRACTION_VERSIONS,
} from "@quixi/core/contracts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
const id = () => crypto.randomUUID();
const deferred = () => {
  let resolve!: (value?: any) => void;
  const promise = new Promise<any>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const failure = (code: string, message = code) =>
  Object.assign(new Error(message), { code });
function fixture() {
  const document = {
    id: id(),
    workspaceId: id(),
    attachmentId: id(),
    title: "First PDF",
    createdAt: 1,
    recordedAt: 1,
    importSourceId: null,
  };
  const second = {
    ...document,
    id: id(),
    attachmentId: id(),
    title: "Second PDF",
  };
  const attachments = [document, second].map((doc) => ({
    id: doc.attachmentId,
    availability: "available",
    filename: "synthetic.pdf",
    mimeType: "application/pdf",
    sizeBytes: 100,
    blobSha256: "a".repeat(64),
    rawObjectId: null,
  }));
  const runs = [document, second].map((doc) => ({
    runId: id(),
    identity: {
      documentId: doc.id,
      attachmentId: doc.attachmentId,
      attachmentSha256: "a".repeat(64),
      attachmentByteLength: 100,
      ...DOCUMENT_EXTRACTION_VERSIONS,
    },
    state: "completed",
    writerEpoch: 1,
    pageCount: 2,
    completedPage: 2,
    currentPage: null,
    visibleRunId: null as string | null,
    documentRevision: 2,
    retainedBytes: 100,
    failure: null,
  }));
  runs.forEach((run) => {
    run.visibleRunId = run.runId;
  });
  const refs = runs.map((run) => ({
    runId: run.runId,
    pageAttemptId: id(),
    page: 1,
    identity: run.identity,
    sourceDigest: "b".repeat(64),
    publicationRevision: 1,
  }));
  const text = "text🙂 " + "x".repeat(40000),
    position = { partId: null, start: 4, end: 9, page: 1, sectionPath: [] };
  const hit = {
    chunkId: "c".repeat(64),
    sourceType: "document",
    sourceId: "page-source",
    documentId: document.id,
    threadId: null,
    messageId: null,
    title: "First PDF",
    role: null,
    provider: null,
    model: null,
    date: null,
    score: 1,
    explanation: "Exact text match",
    excerpt: { text: "text", highlights: [] },
    position,
  };
  const calls: any[] = [];
  let listener: (selection: any) => void = () => {},
    closed = 0,
    requestHook: ((op: string, args: any) => Promise<any> | undefined) | null =
      null;
  let receipt: any = { status: "not_found" },
    resolution: any = {
      documentId: document.id,
      attachmentId: document.attachmentId,
      pageRef: refs[0],
      position,
    };
  const storage: any = {
    async request(requestId: string, operation: string, args: any) {
      assert.equal(this, storage);
      calls.push({ operation, args: structuredClone(args), requestId });
      if (requestHook) {
        const override = requestHook(operation, args);
        if (override !== undefined) return override;
      }
      const n = (docId: string) => (docId === document.id ? 0 : 1);
      switch (operation) {
        case "readEntities":
          return {
            items: args.page.cursor ? [second] : [document],
            nextCursor: args.page.cursor ? null : "cursor-next",
            bytes: 100,
          };
        case "readEntity":
          return args.collection === "documents"
            ? structuredClone(
                [document, second].find((doc) => doc.id === args.id) ?? null,
              )
            : structuredClone(
                attachments.find((a) => a.id === args.id) ?? null,
              );
        case "getDocumentExtraction":
          return structuredClone(runs[n(args.documentId)]);
        case "getPublishedExtractionPage":
          return args.page === 1
            ? structuredClone(
                refs.find((ref) => ref.runId === args.runId) ?? null,
              )
            : null;
        case "readExtractedPageText": {
          if (/[\uDC00-\uDFFF]/.test(text[args.startUTF16] ?? ""))
            throw failure(
              "INVALID_REQUEST",
              "Text range starts inside a surrogate pair.",
            );
          let end = Math.min(text.length, args.startUTF16 + args.maxUTF16);
          if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? ""))
            end--;
          return {
            text: text.slice(args.startUTF16, end),
            startUTF16: args.startUTF16,
            endUTF16: end,
            totalUTF16: text.length,
            classification: 'text',
            layout: null,
          };
        }
        case "resolveDocumentSearchHit":
          return structuredClone(resolution);
        case "getExtractionOperation":
          return structuredClone(receipt);
        case "resumeDocumentExtraction":
          return structuredClone(runs[0]);
        default:
          throw new Error(`Unexpected ${operation}`);
      }
    },
    async sendChunk() {
      assert.equal(this, storage);
    },
    async readChunk() {
      assert.equal(this, storage);
    },
    async acknowledgeChunk() {
      assert.equal(this, storage);
    },
    async cancel() {
      assert.equal(this, storage);
    },
    onProgress() {
      assert.equal(this, storage);
      return () => {};
    },
    onChange() {
      assert.equal(this, storage);
      return () => {};
    },
    async close() {
      closed++;
    },
  };
  const options: any = {
    archiveId: "default",
    storage,
    host: {},
    archiveSession: {
      selection: { archiveId: "default", selectionRevision: 0 },
      onSelectionChange(fn: any) {
        listener = fn;
        return () => {};
      },
      async reconcilePreviousOperations() {
        return "committed";
      },
      async reconcilePreviousExtractionOperation() {
        return "committed";
      },
    },
  };
  let persist: any = async () => structuredClone(runs[0]);
  let clear: any = async ({ target }: any) => {
    const run = runs.find((value) => value.runId === target.expectedRunId)!;
    run.state = 'cleared';
    run.visibleRunId = null;
    run.documentRevision++;
    return { documentId: target.documentId, documentRevision: run.documentRevision, cleared: true };
  };
  let acquireProducer: any = async () => ({ async release() {} });
  let importFn: any = async () => document,
    reconcileImport: any = async () => document;
  const controller = createDocumentController(options, {
    workersAvailable: () => true,
    persist: (args) => persist(args),
    clear: (args) => clear(args),
    acquireProducer: (...args) => acquireProducer(...args),
    importPdf: (args) => importFn(args),
    reconcileImport: (client, pending) => reconcileImport(client, pending),
  });
  return {
    controller,
    options,
    calls,
    document,
    second,
    attachments,
    runs,
    refs,
    text,
    hit,
    get closed() {
      return closed;
    },
    set persist(value: any) {
      persist = value;
    },
    set clear(value: any) {
      clear = value;
    },
    set acquireProducer(value: any) { acquireProducer = value; },
    set importFn(value: any) {
      importFn = value;
    },
    set reconcileImport(value: any) {
      reconcileImport = value;
    },
    set hook(value: any) {
      requestHook = value;
    },
    set receipt(value: any) {
      receipt = value;
    },
    set resolution(value: any) {
      resolution = value;
    },
    switch() {
      listener({ archiveId: id(), selectionRevision: 1 });
    },
  };
}
function pending(f: ReturnType<typeof fixture>) {
  const operation: any = {
    operation: "resumeDocumentExtraction",
    args: {
      operationId: id(),
      runId: f.runs[0]!.runId,
      expectedWriterEpoch: 1,
    },
  };
  operation.requestDigest = bytesToHex(
    sha256(
      new TextEncoder().encode(
        canonicalJson({ operation: operation.operation, args: operation.args }),
      ),
    ),
  );
  return Object.assign(new Error("Exact extraction receipt unavailable"), {
    name: "PendingExtractionOperationError",
    code: "UNKNOWN_OUTCOME",
    pending: operation,
  });
}
async function uncertain(f: ReturnType<typeof fixture>) {
  const error = pending(f);
  f.persist = async () => {
    throw error;
  };
  await f.controller.open(f.document.id);
  await f.controller.extract();
  assert.equal(f.controller.getSnapshot().pending?.kind, "extraction");
  return error;
}
function clearTarget(f: ReturnType<typeof fixture>) {
  return { documentId: f.document.id, expectedRunId: f.runs[0]!.runId,
    expectedDocumentRevision: f.runs[0]!.documentRevision };
}
async function uncertainClear(f: ReturnType<typeof fixture>) {
  await f.controller.openHit(f.hit as any);
  const exact = { operation: 'clearDocumentExtraction', args: { ...clearTarget(f), operationId: id() } };
  const requestDigest = bytesToHex(sha256(new TextEncoder().encode(canonicalJson(exact))));
  f.clear = async () => { throw Object.assign(new Error('Clear receipt unavailable'), {
    name: 'PendingExtractionOperationError', code: 'UNKNOWN_OUTCOME', pending: { ...exact, requestDigest },
  }); };
  await f.controller.clearExtraction(clearTarget(f));
  assert.equal(f.controller.getSnapshot().pending?.kind, 'extraction');
  return { ...exact, requestDigest };
}
test('pending clear replay reacquires producer exclusion and retains the operation on contention', async () => {
  const f = fixture(), exact = await uncertainClear(f);
  const retained = f.controller.getSnapshot().pending;
  f.acquireProducer = async (archive: string, documentId: string, signal: AbortSignal) => {
    assert.equal(archive, 'default'); assert.equal(documentId, f.document.id); assert.equal(signal.aborted, false);
    throw failure('CAPACITY', 'Another extraction producer is active');
  };
  await f.controller.reconcile();
  assert.equal(f.controller.getSnapshot().pending, retained);
  assert.equal(f.calls.filter(call => call.operation === exact.operation).length, 0);
  assert.match(f.controller.getSnapshot().error!, /producer is active/);
  let held = false, released = 0;
  f.acquireProducer = async () => { held = true; return { async release() { held = false; released++; } }; };
  f.hook = (op: string, args: any) => {
    if (op === exact.operation) {
      assert.equal(held, true); assert.deepEqual(args, exact.args);
      f.receipt = { status: 'committed', requestDigest: exact.requestDigest, result: {} };
      return Promise.resolve({});
    }
    return undefined;
  };
  await f.controller.reconcile();
  assert.equal(released, 1); assert.equal(held, false);
  assert.equal(f.controller.getSnapshot().pending, null);
  await f.controller.dispose();
});
test('Stop during clear receipt lookup prevents replay; pending clear admits no page reads', async () => {
  const f = fixture(); await uncertainClear(f);
  const entered = deferred(), gate = deferred();
  f.hook = (op: string) => {
    if (op !== 'getExtractionOperation') return undefined;
    entered.resolve(); return gate.promise;
  };
  const recovering = f.controller.reconcile(); await entered.promise;
  const beforeReads = f.calls.length;
  await f.controller.open(f.document.id); await f.controller.page(1); await f.controller.openHit(f.hit as any);
  assert.equal(f.calls.length, beforeReads);
  assert.equal(f.controller.getSnapshot().textWindow, null);
  f.controller.stop(); gate.resolve({ status: 'not_found' }); await recovering;
  assert.equal(f.calls.some(call => call.operation === 'clearDocumentExtraction'), false);
  assert.ok(f.controller.getSnapshot().pending);
  assert.match(f.controller.getSnapshot().error!, /cancelled/i);
  await f.controller.dispose();
});
test('clear removes the displayed text and refreshes only the reviewed derived run', async () => {
  const f = fixture();
  await f.controller.openHit(f.hit as any);
  assert.ok(f.controller.getSnapshot().textWindow);
  const original = structuredClone(f.attachments);
  await f.controller.clearExtraction(clearTarget(f));
  const state = f.controller.getSnapshot();
  assert.equal(state.run?.state, 'cleared');
  assert.equal(state.run?.documentRevision, 3);
  assert.equal(state.textWindow, null);
  assert.equal(state.pageRef, null);
  assert.equal(state.highlight, null);
  assert.equal(state.progress, null);
  assert.match(state.notice!, /original PDF is unchanged/i);
  assert.deepEqual(f.attachments, original);
  assert.equal(f.calls.some(call => /delete|write|remove/i.test(call.operation)), false);
  await f.controller.dispose();
  assert.equal(f.closed, 0);
});
test('clear captures the reviewed target and archive, drains cancellation and fences archive changes', async () => {
  const f = fixture(), gate = deferred(), entered = deferred();
  let captured: any;
  f.clear = async (args: any) => { captured = args; entered.resolve(); await gate.promise; throw failure('CANCELLED'); };
  await f.controller.open(f.document.id);
  const target = clearTarget(f), reviewed = structuredClone(target);
  f.options.archiveId = 'changed-services';
  const clearing = f.controller.clearExtraction(target);
  await entered.promise;
  target.expectedRunId = id(); target.documentId = f.second.id;
  assert.deepEqual(captured.target, reviewed);
  assert.ok(Object.isFrozen(captured.target));
  assert.equal(captured.storage.archiveId, 'default');
  const callsBeforeNavigation = f.calls.length;
  await f.controller.open(f.document.id);
  await f.controller.page(1);
  assert.equal(f.calls.length, callsBeforeNavigation);
  assert.equal(f.controller.getSnapshot().textWindow, null);
  f.controller.stop();
  assert.equal(captured.signal.aborted, true);
  assert.equal(f.controller.getSnapshot().busy, true);
  f.switch();
  await assert.rejects(() => captured.storage.request(id(), 'clearDocumentExtraction', { ...reviewed, operationId: id() }), /selection changed/);
  gate.resolve(); await clearing;
  assert.equal(f.controller.getSnapshot().busy, false);
  assert.equal(f.calls.some(call => call.operation === 'clearDocumentExtraction'), false);
  await f.controller.dispose(); assert.equal(f.closed, 0);
});
test('stale clear review and pending extraction refuse new helper dispatch', async () => {
  const f = fixture(); let dispatched = 0;
  f.clear = async () => { dispatched++; };
  await f.controller.open(f.document.id);
  const target = clearTarget(f);
  f.runs[0]!.documentRevision++;
  await f.controller.open(f.document.id);
  await f.controller.clearExtraction(target);
  assert.match(f.controller.getSnapshot().error!, /Review it again/);
  await uncertain(f);
  await f.controller.clearExtraction(clearTarget(f));
  assert.match(f.controller.getSnapshot().error!, /pending document operation/);
  assert.equal(dispatched, 0);
  await f.controller.dispose();
});
test('uncertain clear keeps the text hidden and reconciles only the exact same-ID mutation', async () => {
  const f = fixture();
  await f.controller.openHit(f.hit as any);
  const exact = { operation: 'clearDocumentExtraction', args: { ...clearTarget(f), operationId: id() } };
  const requestDigest = bytesToHex(sha256(new TextEncoder().encode(canonicalJson(exact))));
  f.clear = async () => { throw Object.assign(new Error('Clear receipt unavailable'), {
    name: 'PendingExtractionOperationError', code: 'UNKNOWN_OUTCOME', pending: { ...exact, requestDigest },
  }); };
  await f.controller.clearExtraction(clearTarget(f));
  assert.equal(f.controller.getSnapshot().textWindow, null);
  assert.equal(f.controller.getSnapshot().pending?.kind, 'extraction');
  const beforeReads = f.calls.length;
  await f.controller.open(f.document.id); await f.controller.page(1); await f.controller.openHit(f.hit as any);
  assert.equal(f.calls.length, beforeReads);
  assert.equal(f.controller.getSnapshot().textWindow, null);
  f.hook = (op: string, args: any) => {
    if (op !== exact.operation) return undefined;
    assert.deepEqual(args, exact.args);
    f.runs[0]!.state = 'cleared'; f.runs[0]!.visibleRunId = null; f.runs[0]!.documentRevision++;
    const result = { documentId: f.document.id, documentRevision: 3, cleared: true };
    f.receipt = { status: 'committed', requestDigest, result };
    return Promise.resolve(result);
  };
  await f.controller.reconcile();
  assert.equal(f.calls.filter(call => call.operation === exact.operation).length, 1);
  assert.equal(f.controller.getSnapshot().pending, null);
  assert.equal(f.controller.getSnapshot().run?.state, 'cleared');
  assert.equal(f.controller.getSnapshot().textWindow, null);
  await f.controller.dispose();
});
test("bounded document pagination replaces its page and bounded source text preserves original reference", async () => {
  const f = fixture();
  await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().documents.length, 1);
  await f.controller.refresh("cursor-next");
  assert.equal(f.controller.getSnapshot().documents[0]!.id, f.second.id);
  assert.ok(
    f.calls
      .filter((call) => call.operation === "readEntities")
      .every(
        (call) =>
          call.args.page.maxItems === 24 && call.args.page.maxBytes === 200000,
      ),
  );
  await f.controller.open(f.document.id);
  assert.deepEqual(f.controller.getSnapshot().pageRef, f.refs[0]);
  assert.equal(f.controller.getSnapshot().textWindow!.text.length, 16384);
  assert.equal(f.controller.getSnapshot().progress, null);
  await f.controller.textWindow(16384);
  assert.equal(f.controller.getSnapshot().textWindow!.startUTF16, 16384);
  assert.ok(
    f.calls
      .filter((call) => call.operation === "readExtractedPageText")
      .every((call) => call.args.maxUTF16 === 16384),
  );
  await f.controller.dispose();
  assert.equal(f.closed, 0);
});
test("document and code hits keep exact authoritative pageRef and position; stale identity never falls back", async () => {
  const f = fixture();
  await f.controller.openHit({ ...f.hit, sourceType: "code" } as any);
  assert.deepEqual(f.controller.getSnapshot().pageRef, f.refs[0]);
  assert.deepEqual(f.controller.getSnapshot().highlight, f.hit.position);
  const reads = f.calls.filter(
    (call) => call.operation === "getPublishedExtractionPage",
  ).length;
  f.resolution = {
    documentId: f.document.id,
    attachmentId: f.document.attachmentId,
    pageRef: f.refs[0],
    position: { ...f.hit.position, start: 99 },
  };
  await f.controller.openHit(f.hit as any);
  assert.match(f.controller.getSnapshot().error!, /stale/);
  assert.equal(f.controller.getSnapshot().textWindow, null);
  assert.equal(
    f.calls.filter((call) => call.operation === "getPublishedExtractionPage")
      .length,
    reads,
  );
  await f.controller.dispose();
});
test("publication invalidation during exact hit read refuses stale source and retains no alternate text", async () => {
  const f = fixture();
  await f.controller.open(f.document.id);
  f.hook = (op: string) =>
    op === "readExtractedPageText"
      ? Promise.reject(failure("CONFLICT", "Published source is stale"))
      : undefined;
  await f.controller.openHit(f.hit as any);
  assert.equal(f.controller.getSnapshot().textWindow, null);
  assert.match(f.controller.getSnapshot().error!, /stale/);
  await f.controller.dispose();
});
test("opening an unavailable page clears previously displayed page", async () => {
  const f = fixture();
  await f.controller.open(f.document.id);
  await f.controller.page(2);
  assert.equal(f.controller.getSnapshot().pageRef, null);
  assert.equal(f.controller.getSnapshot().textWindow, null);
  assert.match(f.controller.getSnapshot().error!, /no current published/);
  await f.controller.dispose();
});
test("progress is per-document and completed stored pages never imply indexed progress", async () => {
  const f = fixture();
  f.persist = async ({ onProgress }: any) => {
    await onProgress({
      phase: "completed",
      runId: f.runs[0]!.runId,
      page: 100,
      pages: 100,
      indexedThroughPage: 100,
    });
    return f.runs[0];
  };
  await f.controller.open(f.document.id);
  assert.equal(f.controller.getSnapshot().progress, null);
  await f.controller.extract();
  assert.equal(f.controller.getSnapshot().progress!.indexedThroughPage, 100);
  await f.controller.open(f.second.id);
  assert.equal(f.controller.getSnapshot().progress, null);
  assert.equal(f.controller.getSnapshot().progressDocId, null);
  await f.controller.open(f.document.id);
  await f.controller.extract();
  const gate = deferred();
  let entered = false;
  f.importFn = async () => {
    entered = true;
    await gate.promise;
    return f.second;
  };
  const importing = f.controller.import(f.document.workspaceId);
  while (!entered) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.controller.getSnapshot().document!.id, f.document.id);
  assert.equal(f.controller.getSnapshot().busy, true);
  assert.equal(f.controller.getSnapshot().progress, null);
  assert.equal(f.controller.getSnapshot().progressDocId, null);
  gate.resolve();
  await importing;
  assert.equal(f.controller.getSnapshot().document!.id, f.second.id);
  await f.controller.dispose();
});
test("delayed opening fences new workflow and cannot change an active operation document", async () => {
  const f = fixture();
  await f.controller.open(f.second.id);
  const gate = deferred();
  let entered = false,
    started = 0;
  f.hook = (op: string, args: any) => {
    if (
      op === "readEntity" &&
      args.collection === "documents" &&
      args.id === f.document.id
    ) {
      entered = true;
      return gate.promise.then(() => f.document);
    }
    return undefined;
  };
  f.persist = async () => {
    started++;
    return f.runs[1];
  };
  const opening = f.controller.open(f.document.id);
  while (!entered) await new Promise((resolve) => setTimeout(resolve, 0));
  await f.controller.extract();
  assert.equal(started, 0);
  assert.match(f.controller.getSnapshot().error!, /finish opening/);
  gate.resolve();
  await opening;
  assert.equal(f.controller.getSnapshot().document!.id, f.document.id);
  await f.controller.dispose();
});
test("same active-document hit can open early; another document is refused; stop and dispose await cleanup", async () => {
  const f = fixture(),
    gate = deferred();
  let started = false,
    stopped = false,
    cleaned = false;
  f.persist = async ({ signal, storage }: any) => {
    assert.equal(storage.archiveId, "default");
    started = true;
    signal.addEventListener("abort", () => {
      stopped = true;
    });
    await gate.promise;
    await storage.close();
    cleaned = true;
    return f.runs[0];
  };
  await f.controller.open(f.document.id);
  const extracting = f.controller.extract();
  while (!started) await new Promise((resolve) => setTimeout(resolve, 0));
  await f.controller.openHit(f.hit as any);
  assert.deepEqual(f.controller.getSnapshot().pageRef, f.refs[0]);
  await f.controller.open(f.second.id);
  assert.equal(f.controller.getSnapshot().document!.id, f.document.id);
  assert.match(f.controller.getSnapshot().error!, /active document/);
  assert.ok(f.controller.replacementBlock());
  f.controller.stop();
  assert.equal(stopped, true);
  const closing = f.controller.dispose();
  await Promise.resolve();
  assert.equal(cleaned, false);
  gate.resolve();
  await Promise.all([extracting, closing]);
  assert.equal(cleaned, true);
  assert.equal(f.closed, 0);
});
test("pending extraction retains frozen exact identity, blocks new work and only reconciles matching receipt", async () => {
  const f = fixture(),
    error = await uncertain(f),
    pendingState = f.controller.getSnapshot().pending;
  assert.ok(Object.isFrozen((pendingState as any).operation.args));
  assert.ok(f.controller.replacementBlock());
  await f.controller.extract();
  assert.equal(f.controller.getSnapshot().pending, pendingState);
  f.receipt = {
    status: "committed",
    requestDigest: "f".repeat(64),
    result: {},
  };
  await f.controller.reconcile();
  assert.equal(f.controller.getSnapshot().pending, pendingState);
  f.receipt = {
    status: "committed",
    requestDigest: error.pending.requestDigest,
    result: {},
  };
  await f.controller.reconcile();
  assert.equal(f.controller.getSnapshot().pending, null);
  assert.equal(f.controller.replacementBlock(), null);
  assert.equal(
    f.calls.filter((call) => call.operation === "resumeDocumentExtraction")
      .length,
    0,
  );
  await f.controller.dispose();
});
test("not-found receipt permits exact same-ID replay once, then requires durable digest confirmation", async () => {
  const f = fixture(),
    error = await uncertain(f);
  f.hook = (op: string, args: any) => {
    if (op === "resumeDocumentExtraction") {
      assert.deepEqual(args, error.pending.args);
      f.receipt = {
        status: "committed",
        requestDigest: error.pending.requestDigest,
        result: {},
      };
      return Promise.resolve(f.runs[0]);
    }
    return undefined;
  };
  await f.controller.reconcile();
  assert.equal(
    f.calls.filter((call) => call.operation === "resumeDocumentExtraction")
      .length,
    1,
  );
  assert.equal(f.controller.getSnapshot().pending, null);
  await f.controller.dispose();
});
test("selection change aborts extraction and blocks fresh or replayed writes in the captured facade", async () => {
  const f = fixture(),
    gate = deferred();
  let bound: any, signal: AbortSignal | undefined;
  f.persist = async (args: any) => {
    bound = args.storage;
    signal = args.signal;
    await gate.promise;
    return f.runs[0];
  };
  await f.controller.open(f.document.id);
  f.options.archiveId = "mutated-services";
  const extracting = f.controller.extract();
  while (!bound) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(bound.archiveId, "default");
  f.switch();
  assert.equal(signal!.aborted, true);
  await assert.rejects(
    () =>
      bound.request(id(), "resumeDocumentExtraction", {
        operationId: id(),
        runId: f.runs[0]!.runId,
        expectedWriterEpoch: 1,
      }),
    /selection changed/,
  );
  assert.equal(
    f.calls.filter((call) => call.operation === "resumeDocumentExtraction")
      .length,
    0,
  );
  gate.resolve();
  await extracting;
  await f.controller.extract();
  assert.match(f.controller.getSnapshot().error!, /active archive changed/);
  await f.controller.dispose();
});
test("retained extraction recovery sends only original ID/digest and retains pending on unavailable receipt", async () => {
  const f = fixture(),
    error = await uncertain(f);
  f.switch();
  let calls = 0;
  f.options.archiveSession.reconcilePreviousExtractionOperation = async (
    args: any,
  ) => {
    calls++;
    assert.deepEqual(args, {
      operationId: error.pending.args.operationId,
      requestDigest: error.pending.requestDigest,
    });
    throw new Error("Original receipt unavailable");
  };
  await f.controller.reconcile();
  assert.ok(f.controller.getSnapshot().pending);
  assert.match(f.controller.getSnapshot().error!, /unavailable/);
  f.options.archiveSession.reconcilePreviousExtractionOperation = async () =>
    "committed";
  const before = f.calls.length;
  await f.controller.reconcile();
  assert.equal(f.controller.getSnapshot().pending, null);
  assert.equal(f.calls.length, before);
  assert.equal(calls, 1);
  await f.controller.dispose();
});
test("retained recovery waits for outstanding view reads before closing stale client", async () => {
  const f = fixture();
  await uncertain(f);
  const gate = deferred();
  let entered = false,
    recovered = false;
  f.hook = (op: string) => {
    if (op === "readEntities") {
      entered = true;
      return gate.promise.then(() => ({
        items: [f.document],
        nextCursor: null,
        bytes: 100,
      }));
    }
    return undefined;
  };
  const reading = f.controller.refresh();
  while (!entered) await new Promise((resolve) => setTimeout(resolve, 0));
  f.switch();
  f.options.archiveSession.reconcilePreviousExtractionOperation = async () => {
    recovered = true;
    return "not_committed";
  };
  const recovery = f.controller.reconcile();
  await Promise.resolve();
  assert.equal(recovered, false);
  gate.resolve();
  await Promise.all([reading, recovery]);
  assert.equal(recovered, true);
  assert.equal(f.controller.getSnapshot().pending, null);
  assert.match(f.controller.getSnapshot().notice!, /did not commit/);
  await f.controller.dispose();
});
test("import recovery reuses exact facade/error; selection recovery uses only original canonical IDs", async () => {
  const f = fixture();
  let facade: any,
    replays = 0;
  const batch: any = {
      transactionId: id(),
      expectedThreadRevisions: [],
      stagedBlobIds: [id()],
      mutations: [{ operationId: id() }, { operationId: id() }],
    },
    error = new PendingDocumentImportError(batch, f.document);
  f.importFn = async ({ storage }: any) => {
    facade = storage;
    throw error;
  };
  f.reconcileImport = async (storage: any, pending: any) => {
    assert.equal(storage, facade);
    assert.equal(pending, error);
    replays++;
    throw error;
  };
  await f.controller.import(f.document.workspaceId);
  assert.equal(f.controller.getSnapshot().pending?.kind, "import");
  await f.controller.reconcile();
  assert.equal(replays, 1);
  assert.ok(f.controller.getSnapshot().pending);
  f.switch();
  f.options.archiveSession.reconcilePreviousOperations = async (ids: any) => {
    assert.deepEqual(
      ids,
      batch.mutations.map((m: any) => m.operationId),
    );
    return "committed";
  };
  await f.controller.reconcile();
  assert.equal(replays, 1);
  assert.equal(f.controller.getSnapshot().pending, null);
  await f.controller.dispose();
  assert.equal(f.closed, 0);
});
test("unsupported original source capability refuses parser dispatch honestly", async () => {
  const f = fixture();
  f.attachments[0]!.sizeBytes = 33554433;
  let calls = 0;
  f.persist = async () => {
    calls++;
    return f.runs[0];
  };
  await f.controller.open(f.document.id);
  assert.match(
    f.controller.getSnapshot().extractionUnavailableReason!,
    /32 MiB/,
  );
  await f.controller.extract();
  assert.equal(calls, 0);
  await f.controller.dispose();
});

test("backward text navigation repairs only a split scalar start while retaining its exact page reference", async () => {
  const f = fixture();
  await f.controller.open(f.document.id);
  await f.controller.textWindow(5);
  assert.equal(f.controller.getSnapshot().textWindow!.startUTF16, 4);
  assert.ok(f.controller.getSnapshot().textWindow!.text.startsWith("🙂"));
  assert.deepEqual(f.controller.getSnapshot().pageRef, f.refs[0]);
  await f.controller.dispose();
});

test("bounded page layout warnings are retained and malformed assessments clear the text view", async () => {
  const f = fixture();
  let layout: any = { mode: 'source_order', reasons: ['rotated_or_skewed'], columns: 1 };
  f.hook = (operation: string) => operation === 'readExtractedPageText' ? Promise.resolve({
    text: 'rotated text', startUTF16: 0, endUTF16: 12, totalUTF16: 12, classification: 'text', layout,
  }) : undefined;
  await f.controller.open(f.document.id);
  assert.deepEqual(f.controller.getSnapshot().textWindow!.layout, layout);
  layout.reasons.push('unexpected');
  assert.deepEqual(f.controller.getSnapshot().textWindow!.layout!.reasons, ['rotated_or_skewed']);
  await f.controller.page(1);
  assert.equal(f.controller.getSnapshot().textWindow, null);
  assert.ok(f.controller.getSnapshot().error);
  layout = null;
  await f.controller.page(1);
  assert.equal(f.controller.getSnapshot().textWindow!.layout, null, 'Legacy absence does not invent a geometric assessment');
  await f.controller.dispose();
});

test("retained recovery admits no new view reads while closing or after it closes the stale client", async () => {
  const f = fixture();
  await uncertain(f);
  f.switch();
  const gate = deferred();
  let entered = false;
  f.options.archiveSession.reconcilePreviousExtractionOperation = async () => {
    entered = true;
    await gate.promise;
    return "committed";
  };
  const recovery = f.controller.reconcile();
  while (!entered) await new Promise((resolve) => setTimeout(resolve, 0));
  const count = f.calls.length;
  await f.controller.refresh();
  assert.equal(f.calls.length, count);
  gate.resolve();
  await recovery;
  await f.controller.open(f.document.id);
  assert.equal(f.calls.length, count);
  await f.controller.dispose();
});
