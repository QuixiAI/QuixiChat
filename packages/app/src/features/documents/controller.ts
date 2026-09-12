import {
  assertExtractionArgs,
  assertPublishedPageRef,
  assertPageLayout,
  canonicalJson,
  EXTRACTION_LIMITS,
  jsonByteLength,
  sameArchiveSelection,
} from "@quixi/core/contracts";
import type {
  ChunkPosition,
  ExtractionRunStatus,
  PublishedPageRef,
  SearchHit,
  StorageClient,
  StorageOperations,
} from "@quixi/core/contracts";
import { isQuixiId, validateEntityShape } from "@quixi/core/model";
import type { Attachment, Document, JsonValue } from "@quixi/core/model";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type {
  PendingExtractionOperation,
  PdfPersistenceProgress,
  ClearPdfExtractionTarget,
} from "@quixi/documents/storage";
import type { AppServices } from "../../runtime/library.ts";
import {
  importPdf,
  PendingDocumentImportError,
  reconcileDocumentImport,
} from "./import-pdf.ts";

export type DocumentPending =
  | {
      kind: "extraction";
      documentId: string;
      operation: PendingExtractionOperation;
    }
  | {
      kind: "import";
      documentId: string;
      operationIds: readonly string[];
      committed: boolean;
    }
  | { kind: "unknown"; documentId: string | null; reason: string };
export interface DocumentSnapshot {
  documents: readonly Document[];
  nextCursor: string | null;
  document: Document | null;
  attachment: Attachment | null;
  run: ExtractionRunStatus | null;
  progress: Readonly<PdfPersistenceProgress> | null;
  progressDocId: string | null;
  pageRef: PublishedPageRef | null;
  textWindow: StorageOperations["readExtractedPageText"]["result"] | null;
  highlight: ChunkPosition | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  pending: DocumentPending | null;
  selectionChanged: boolean;
  extractionUnavailableReason: string | null;
}
/** Test injection changes orchestration dependencies only; production defaults
 * always use the real stored-source/parser and canonical import workflows. */
export interface DocumentControllerDependencies {
  persist?: (typeof import("@quixi/documents/storage"))["persistPdfDocument"];
  clear?: (typeof import("@quixi/documents/storage"))["clearStoredPdfExtraction"];
  acquireProducer?: (typeof import("@quixi/documents/storage"))["acquireStoredPdfProducerLease"];
  importPdf?: typeof importPdf;
  reconcileImport?: typeof reconcileDocumentImport;
  workersAvailable?: () => boolean;
}
const id = () => crypto.randomUUID();
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const code = (error: unknown) => (error as { code?: string })?.code;
const fail = (message: string) =>
  Object.assign(new Error(message), { code: "CONFLICT" });
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const copy = <T>(value: T): T => freeze(structuredClone(value));
const digest = (
  pending: Pick<PendingExtractionOperation, "operation" | "args">,
) =>
  bytesToHex(
    sha256(
      new TextEncoder().encode(
        canonicalJson({
          operation: pending.operation,
          args: pending.args,
        } as unknown as JsonValue),
      ),
    ),
  );
const same = (a: unknown, b: unknown) =>
  canonicalJson(a as JsonValue) === canonicalJson(b as JsonValue);
const listBudget = { maxItems: 24, maxBytes: 200000 };

export function createDocumentController(
  services: AppServices,
  dependencies: DocumentControllerDependencies = {},
) {
  const archiveId = services.archiveId,
    client = services.storage;
  const session = services.archiveSession,
    selection = session ? copy(session.selection) : null;
  const persist =
    dependencies.persist ??
    (async (options) =>
      (await import("@quixi/documents/storage")).persistPdfDocument(options));
  const importSource = dependencies.importPdf ?? importPdf,
    reconcileImport = dependencies.reconcileImport ?? reconcileDocumentImport;
  const clear = dependencies.clear ?? (async (options) =>
    (await import('@quixi/documents/storage')).clearStoredPdfExtraction(options));
  const acquireProducer = dependencies.acquireProducer ?? (async (archiveId: string, documentId: string, signal?: AbortSignal) =>
    (await import('@quixi/documents/storage')).acquireStoredPdfProducerLease(archiveId, documentId, signal));
  const workersAvailable =
    dependencies.workersAvailable ??
    (() => typeof Worker === "function" && !!globalThis.navigator?.locks);
  let state: DocumentSnapshot = freeze({
    documents: [],
    nextCursor: null,
    document: null,
    attachment: null,
    run: null,
    progress: null,
    progressDocId: null,
    pageRef: null,
    textWindow: null,
    highlight: null,
    loading: false,
    busy: false,
    error: null,
    notice: null,
    pending: null,
    selectionChanged: false,
    extractionUnavailableReason: "Open a PDF document first.",
  });
  const listeners = new Set<() => void>();
  let readingBlocked = false;
  let disposed = false,
    viewTask: Promise<void> | null = null,
    workflowTask: Promise<void> | null = null;
  let abort: AbortController | null = null,
    activeDocumentId: string | null = null,
    pendingImport: PendingDocumentImportError | null = null;
  function patch(value: Partial<DocumentSnapshot>) {
    if (disposed) return;
    state = freeze({ ...state, ...value });
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* observer only */
      }
    }
  }
  function active() {
    if (disposed) throw fail("Document view was closed.");
  }
  function writable() {
    active();
    if (viewTask)
      throw fail(
        "Wait for the document view to finish opening before starting work.",
      );
    if (state.selectionChanged)
      throw fail(
        "The active archive changed. This document operation remains bound to the original archive; open the selected archive before starting new work.",
      );
    if (state.pending)
      throw fail(
        "Resolve the pending document operation before starting new work.",
      );
  }
  const storage: StorageClient & { readonly archiveId: string } = Object.freeze(
    {
      archiveId,
      request<K extends keyof StorageOperations>(
        requestId: string,
        operation: K,
        args: StorageOperations[K]["args"],
      ) {
        const mutation =
          operation === "commit" ||
          operation === "advanceExtractionPageIndex" ||
          !!(args && typeof args === "object" && "operationId" in args);
        if (state.selectionChanged && mutation)
          return Promise.reject(
            fail(
              "Archive selection changed; this document write was not dispatched.",
            ),
          );
        return client.request(requestId, operation, args);
      },
      sendChunk: client.sendChunk.bind(client),
      readChunk: client.readChunk.bind(client),
      acknowledgeChunk: client.acknowledgeChunk.bind(client),
      cancel: client.cancel.bind(client),
      onProgress: client.onProgress.bind(client),
      onChange: client.onChange.bind(client),
      // These workflows borrow the application client. They never own its lifetime.
      close: async () => {},
    },
  );
  const unsubscribe = session?.onSelectionChange((next) => {
    if (selection && !sameArchiveSelection(next, selection)) {
      abort?.abort();
      patch({
        selectionChanged: true,
        notice:
          "The archive selection changed. This view and any pending document operation remain here.",
      });
    }
  });
  async function work(kind: "view" | "workflow", action: () => Promise<void>) {
    if (
      disposed ||
      (kind === "view" && (readingBlocked || state.pending?.kind === 'extraction' &&
        state.pending.operation.operation === 'clearDocumentExtraction')) ||
      (kind === "view" ? viewTask : workflowTask)
    )
      return;
    let done!: () => void;
    const task = new Promise<void>((resolve) => {
      done = resolve;
    });
    if (kind === "view") viewTask = task;
    else workflowTask = task;
    patch(
      kind === "view"
        ? { loading: true, error: null }
        : { busy: true, error: null, notice: null },
    );
    try {
      await action();
    } catch (error) {
      patch({ error: errorText(error) });
    } finally {
      if (kind === "view") {
        viewTask = null;
        patch({ loading: false });
      } else {
        workflowTask = null;
        abort = null;
        activeDocumentId = null;
        patch({ busy: false });
      }
      done();
    }
  }
  function navigationAllowed(documentId: string) {
    active();
    if (workflowTask && activeDocumentId !== documentId)
      throw fail(
        "Wait for the active document operation or stop it before opening another document.",
      );
  }
  function reason(attachment: Attachment | null) {
    if (!attachment) return "The original attachment is unavailable.";
    if (attachment.availability !== "available")
      return "The original PDF bytes are unavailable. Import an available original before extracting text.";
    if (
      attachment.mimeType?.split(";")[0]?.trim().toLowerCase() !==
      "application/pdf"
    )
      return "This extraction workflow supports PDF documents only.";
    if (
      !attachment.sizeBytes ||
      attachment.sizeBytes > EXTRACTION_LIMITS.sourceBytes
    )
      return "This PDF exceeds the current 32 MiB extraction limit or is empty.";
    if (!workersAvailable())
      return "PDF extraction requires Worker and Web Locks support in this host.";
    return null;
  }
  async function metadata(documentId: string) {
    if (!isQuixiId(documentId)) throw fail("Invalid document identity.");
    const value = await storage.request(id(), "readEntity", {
      collection: "documents",
      id: documentId,
    });
    active();
    if (validateEntityShape("documents", value).length)
      throw fail("Document is missing or malformed.");
    const document = value as unknown as Document;
    if (document.id !== documentId) throw fail("Document identity changed.");
    const original = await storage.request(id(), "readEntity", {
      collection: "attachments",
      id: document.attachmentId,
    });
    active();
    const attachment =
      original && validateEntityShape("attachments", original).length === 0
        ? (original as unknown as Attachment)
        : null;
    if (attachment && attachment.id !== document.attachmentId)
      throw fail("Original attachment identity changed.");
    const run = await storage.request(id(), "getDocumentExtraction", {
      documentId,
    });
    active();
    if (run && run.identity.documentId !== documentId)
      throw fail("Extraction belongs to a different document.");
    return {
      document: copy(document),
      attachment: copy(attachment),
      run: copy(run),
      extractionUnavailableReason: reason(attachment),
    };
  }
  async function text(ref: PublishedPageRef, startUTF16: number) {
    assertPublishedPageRef(ref);
    assertExtractionArgs("readExtractedPageText", {
      pageRef: ref,
      startUTF16,
      maxUTF16: EXTRACTION_LIMITS.textReadUTF16,
    });
    const value = await storage.request(id(), "readExtractedPageText", {
      pageRef: ref,
      startUTF16,
      maxUTF16: EXTRACTION_LIMITS.textReadUTF16,
    });
    active();
    if (
      value.startUTF16 !== startUTF16 ||
      value.text.length > EXTRACTION_LIMITS.textReadUTF16 ||
      value.endUTF16 - value.startUTF16 !== value.text.length ||
      value.totalUTF16 > EXTRACTION_LIMITS.pageUTF16
      || !['text', 'possible_scanned'].includes(value.classification)
    )
      throw fail("Stored page text exceeds its requested bounds.");
    if (value.layout !== null) assertPageLayout(value.layout);
    return copy(value);
  }
  async function loadPage(number: number) {
    if (
      !Number.isSafeInteger(number) ||
      number < 1 ||
      number > EXTRACTION_LIMITS.pages
    )
      throw fail("Choose a page within the document page limit.");
    const document = state.document;
    if (!document) throw fail("Open a document first.");
    navigationAllowed(document.id);
    patch({ pageRef: null, textWindow: null, highlight: null });
    const run = await storage.request(id(), "getDocumentExtraction", {
      documentId: document.id,
    });
    active();
    if (!run || !run.visibleRunId)
      throw fail("No published text is available for this document yet.");
    const ref = await storage.request(id(), "getPublishedExtractionPage", {
      runId: run.visibleRunId,
      page: number,
    });
    active();
    if (
      !ref ||
      ref.identity.documentId !== document.id ||
      ref.identity.attachmentId !== document.attachmentId ||
      ref.page !== number
    )
      throw fail("This page has no current published text.");
    const pageRef = copy(ref),
      window = await text(pageRef, 0);
    navigationAllowed(document.id);
    if (state.document?.id !== document.id)
      throw fail("Document view changed while reading its page.");
    patch({
      run: copy(run),
      pageRef,
      textWindow: window,
      highlight: null,
      notice:
        window.totalUTF16 === 0
          ? "No native text was extracted from this page."
          : null,
    });
  }
  async function openDocument(documentId: string) {
    navigationAllowed(documentId);
    const value = await metadata(documentId);
    navigationAllowed(documentId);
    patch({
      ...(state.document?.id !== documentId
        ? { progress: null, progressDocId: null }
        : {}),
      ...value,
      pageRef: null,
      textWindow: null,
      highlight: null,
      notice: null,
    });
    if (value.run?.visibleRunId) await loadPage(1);
  }
  async function refreshList(cursor: string | null = null) {
    if (cursor !== null && (typeof cursor !== "string" || cursor.length > 4096))
      throw fail("Invalid document list cursor.");
    const result = await storage.request(id(), "readEntities", {
      collection: "documents",
      threadId: null,
      page: { ...listBudget, cursor },
    });
    active();
    jsonByteLength(result.items, listBudget.maxBytes);
    if (
      result.items.length > listBudget.maxItems ||
      result.items.some(
        (value) => validateEntityShape("documents", value).length,
      )
    )
      throw fail("Document list exceeds its bounded contract.");
    patch({
      documents: copy(result.items as unknown as Document[]),
      nextCursor: result.nextCursor,
    });
  }
  function preserve(error: unknown, documentId: string | null) {
    if (error instanceof PendingDocumentImportError) {
      pendingImport = error;
      patch({
        pending: copy({
          kind: "import",
          documentId: error.document.id,
          operationIds: error.batch.mutations.map((item) => item.operationId),
          committed: error.committed,
        }),
      });
      return;
    }
    const value = error as {
      name?: string;
      pending?: PendingExtractionOperation;
    };
    if (
      value?.name === "PendingExtractionOperationError" &&
      value.pending &&
      documentId
    ) {
      try {
        const pending = copy(value.pending);
        jsonByteLength(pending, 65536);
        assertExtractionArgs(pending.operation, pending.args);
        if (
          !("operationId" in pending.args) ||
          digest(pending) !== pending.requestDigest
        )
          throw fail("Pending extraction identity is invalid.");
        patch({
          pending: copy({ kind: "extraction", documentId, operation: pending }),
        });
      } catch {
        patch({
          pending: copy({
            kind: "unknown",
            documentId,
            reason:
              "An extraction write has an unresolved or invalid recovery identity.",
          }),
        });
      }
    } else if (code(error) === "UNKNOWN_OUTCOME")
      patch({
        pending: copy({
          kind: "unknown",
          documentId,
          reason: "The document operation outcome is unresolved.",
        }),
      });
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh(cursor: string | null = null) {
      return work("view", () => refreshList(cursor));
    },
    open(documentId: string) {
      return work("view", () => openDocument(documentId));
    },
    openHit(hit: SearchHit) {
      const captured = copy(hit);
      return work("view", async () => {
        if (
          !["document", "code"].includes(captured.sourceType) ||
          !captured.documentId
        )
          throw fail("This search result is not a document.");
        navigationAllowed(captured.documentId);
        jsonByteLength(captured, 65536);
        patch({ pageRef: null, textWindow: null, highlight: null });
        const resolved = await storage.request(
          id(),
          "resolveDocumentSearchHit",
          { chunkId: captured.chunkId, documentId: captured.documentId },
        );
        active();
        if (
          resolved.documentId !== captured.documentId ||
          !same(resolved.position, captured.position)
        )
          throw fail(
            "This search result is stale. Search again; its location will not be retargeted.",
          );
        const value = await metadata(captured.documentId);
        navigationAllowed(captured.documentId);
        const resetProgress =
          state.document?.id !== captured.documentId
            ? { progress: null, progressDocId: null }
            : {};
        if (value.document.attachmentId !== resolved.attachmentId)
          throw fail(
            "The search result refers to a different original attachment.",
          );
        if (!resolved.pageRef) {
          if (resolved.position.page !== null)
            throw fail("This search page is no longer available.");
          patch({
            ...resetProgress,
            ...value,
            pageRef: null,
            textWindow: null,
            highlight: null,
          });
          return;
        }
        const ref = copy(resolved.pageRef);
        assertPublishedPageRef(ref);
        if (
          ref.identity.documentId !== captured.documentId ||
          ref.identity.attachmentId !== resolved.attachmentId ||
          ref.page !== resolved.position.page
        )
          throw fail("Search page identity differs from its original.");
        const start = resolved.position.start;
        if (
          !Number.isSafeInteger(start) ||
          start < 0 ||
          resolved.position.end < start
        )
          throw fail("Search position is invalid.");
        const window = await text(ref, start);
        navigationAllowed(captured.documentId);
        patch({
          ...resetProgress,
          ...value,
          pageRef: ref,
          textWindow: window,
          highlight: copy(resolved.position),
          notice: null,
        });
      });
    },
    page(number: number) {
      return work("view", () => loadPage(number));
    },
    textWindow(startUTF16: number) {
      return work("view", async () => {
        if (!state.pageRef) throw fail("Open a published page first.");
        const ref = state.pageRef;
        navigationAllowed(ref.identity.documentId);
        try {
          let window: StorageOperations["readExtractedPageText"]["result"];
          try {
            window = await text(ref, startUTF16);
          } catch (error) {
            if (
              startUTF16 > 0 &&
              code(error) === "INVALID_REQUEST" &&
              errorText(error).includes("starts inside a surrogate pair")
            )
              window = await text(ref, startUTF16 - 1);
            else throw error;
          }
          navigationAllowed(ref.identity.documentId);
          if (state.document?.id !== ref.identity.documentId)
            throw fail("Document view changed during text read.");
          patch({ textWindow: window });
        } catch (error) {
          patch({ textWindow: null });
          throw error;
        }
      });
    },
    extract() {
      return work("workflow", async () => {
        writable();
        if (!state.document) throw fail("Open a PDF first.");
        if (state.extractionUnavailableReason)
          throw fail(state.extractionUnavailableReason);
        const documentId = state.document.id;
        activeDocumentId = documentId;
        abort = new AbortController();
        patch({ progress: null, progressDocId: documentId });
        try {
          const run = await persist({
            storage,
            documentId,
            signal: abort.signal,
            onProgress: async (progress) => {
              patch({ progress: copy(progress) });
              if (disposed) return;
              const run = await storage.request(id(), "getDocumentExtraction", {
                documentId,
              });
              if (state.document?.id === documentId) patch({ run: copy(run) });
            },
          });
          if (state.document?.id === documentId)
            patch({
              run: copy(run),
              notice:
                "Published document pages are saved. Search availability follows page indexing progress.",
            });
        } catch (error) {
          preserve(error, documentId);
          throw error;
        }
      });
    },
    clearExtraction(target: ClearPdfExtractionTarget) {
      const captured = copy(target);
      return work('workflow', async () => {
        writable();
        assertExtractionArgs('clearDocumentExtraction', { ...captured, operationId: id() });
        if (state.document?.id !== captured.documentId || state.run?.runId !== captured.expectedRunId ||
          state.run.documentRevision !== captured.expectedDocumentRevision || state.run.state === 'cleared')
          throw fail('The selected extraction changed. Review it again before clearing saved text.');
        activeDocumentId = captured.documentId;
        abort = new AbortController();
        patch({ pageRef: null, textWindow: null, highlight: null, progress: null, progressDocId: null });
        // A read admitted while the clear is in flight could repaint the old
        // publication after its deletion. writable() already drained prior reads.
        readingBlocked = true;
        try {
          await clear({ storage, target: captured, signal: abort.signal });
          const run = await storage.request(id(), 'getDocumentExtraction', { documentId: captured.documentId });
          if (state.document?.id === captured.documentId) patch({ run: copy(run),
            notice: 'Saved text and its document search entries were cleared. The original PDF is unchanged; you can extract it again.' });
        } catch (error) {
          preserve(error, captured.documentId);
          throw error;
        } finally {
          readingBlocked = false;
        }
      });
    },
    import(workspaceId: string) {
      return work("workflow", async () => {
        writable();
        patch({ progress: null, progressDocId: null });
        if (!isQuixiId(workspaceId))
          throw fail("A valid workspace is required to import a PDF.");
        abort = new AbortController();
        try {
          const document = await importSource({
            storage,
            host: services.host,
            workspaceId,
            signal: abort.signal,
          });
          activeDocumentId = document.id;
          await refreshList();
          await openDocument(document.id);
          patch({
            notice:
              "Original PDF imported. Extract its native text when ready.",
          });
        } catch (error) {
          preserve(error, null);
          throw error;
        }
      });
    },
    stop() {
      abort?.abort();
    },
    reconcile() {
      return work("workflow", async () => {
        const pending = state.pending;
        if (!pending) throw fail("There is no pending document operation.");
        if (pending.kind === "unknown") throw fail(pending.reason);
        activeDocumentId = pending.documentId;
        // Retained recovery closes the stale shared client, so finish every
        // admitted view read first and never refresh through it afterward.
        if (state.selectionChanged) {
          readingBlocked = true;
          try {
            await viewTask;
            active();
            let outcome: "committed" | "not_committed";
            if (pending.kind === "import") {
              if (!session)
                throw fail(
                  "Original archive receipt recovery is unavailable; pending work is retained.",
                );
              outcome = await session.reconcilePreviousOperations(
                pending.operationIds,
              );
            } else {
              if (!session?.reconcilePreviousExtractionOperation)
                throw fail(
                  "Original extraction receipt recovery is unavailable; pending work is retained.",
                );
              outcome = await session.reconcilePreviousExtractionOperation({
                operationId: pending.operation.args.operationId,
                requestDigest: pending.operation.requestDigest,
              });
            }
            if (outcome !== "committed" && outcome !== "not_committed")
              throw fail(
                "Original archive outcome is unresolved; pending work is retained.",
              );
            pendingImport = null;
            patch({
              pending: null,
              notice:
                outcome === "committed"
                  ? "The original document operation committed in the previous archive. Open the selected archive when ready."
                  : "The original document operation did not commit in the previous archive. Open the selected archive when ready.",
            });
            return;
          } finally {
            if (state.pending) readingBlocked = false;
          }
        }
        if (viewTask)
          throw fail(
            "Wait for the document view to finish before checking pending work.",
          );
        if (pending.kind === "import") {
          if (!pendingImport)
            throw fail("Original import recovery state is unavailable.");
          const document = await reconcileImport(storage, pendingImport);
          pendingImport = null;
          patch({ pending: null });
          await refreshList();
          await openDocument(document.id);
        } else {
          const exact = pending.operation;
          const clearing = exact.operation === 'clearDocumentExtraction';
          if (clearing) {
            abort = new AbortController();
            patch({ pageRef: null, textWindow: null, highlight: null, progress: null, progressDocId: null });
          }
          let receipt = await storage.request(id(), "getExtractionOperation", {
            operationId: exact.args.operationId,
          });
          if (receipt.status === "not_found") {
            if (state.selectionChanged)
              throw fail(
                "Archive changed; pending operation was not replayed.",
              );
            // Replaying the retained ID is still a clear mutation: reacquire
            // producer exclusion and honor Stop before dispatching it.
            const producer = clearing ? await acquireProducer(archiveId, pending.documentId, abort!.signal) : null;
            try {
              if (clearing && abort!.signal.aborted)
                throw Object.assign(new Error('Clear recovery cancelled; its exact operation remains pending.'), { code: 'CANCELLED' });
              const requestId = id();
              const cancel = () => { void storage.cancel(requestId, exact.args.operationId).catch(() => {}); };
              if (clearing) abort!.signal.addEventListener('abort', cancel, { once: true });
              try { await storage.request(requestId, exact.operation, exact.args); }
              finally { if (clearing) abort!.signal.removeEventListener('abort', cancel); }
              receipt = await storage.request(id(), "getExtractionOperation", {
                operationId: exact.args.operationId,
              });
            } finally { await producer?.release(); }
          }
          if (
            receipt.status !== "committed" ||
            receipt.requestDigest !== exact.requestDigest
          )
            throw fail(
              "The exact extraction receipt could not be confirmed. Pending work is retained.",
            );
          patch({ pending: null });
          if (state.document?.id === pending.documentId)
            patch({
              run: copy(
                await storage.request(id(), "getDocumentExtraction", {
                  documentId: pending.documentId,
                }),
              ),
            });
        }
        patch({
          notice:
            "The original document operation is confirmed. Continue extraction explicitly when ready.",
        });
      });
    },
    replacementBlock() {
      return state.pending
        ? "Resolve the pending document operation before replacing or opening another archive."
        : state.busy
          ? "Stop document processing and wait for cleanup before replacing or opening another archive."
          : null;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      abort?.abort();
      unsubscribe?.();
      await Promise.allSettled([viewTask, workflowTask]);
      listeners.clear();
    },
  };
}
export type DocumentController = ReturnType<typeof createDocumentController>;
