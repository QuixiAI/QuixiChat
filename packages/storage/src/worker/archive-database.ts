import { summarySourceInfo } from './canonical/summary-source.ts';
import { loadStorageSqlite } from "./sqlite-module.ts";
import { PreferenceRepository } from './preferences.ts';
import { RoutingAliasRepository } from './routing-aliases.ts';
import { DOCUMENT_EXTRACTION_VERSIONS } from '@quixi/core/contracts';
import type {
  ArchivesOperations,
  CanonicalMutation,
  SearchIndexStatus,
  StagedImportRecord,
  StorageRequest,
} from "@quixi/core/contracts";
import type { ContentPart, JsonValue } from "@quixi/core/model";
import { BlobCatalog } from "./blob-catalog.ts";
import { BlobInventoryRepository } from './blob-inventory.ts';
import { OpfsBlobStore, BlobStorageError } from "./blobs.ts";
import { CanonicalRepository } from "./canonical/index.ts";
import type { CanonicalSqlite } from "./canonical/index.ts";
import type { ArchiveCall } from "../archive-protocol.ts";
import { ArchiveStorageError, archiveError } from "../archive-protocol.ts";
import { ProducerRepository } from "./producers.ts";
import { SearchRepository } from "./search/index.ts";
import type { SearchChunkTokenizer } from "./search/index.ts";
import { loadChunkTokenizer } from "./chunk-tokenizer.ts";
import { ViewRepository } from "./views.ts";
import { ArchiveRepository } from "./archives/index.ts";
import type {
  ArchiveDatabaseFile,
  ArchivePool,
  ArchiveSqlite,
} from "./archives/snapshot.ts";
import { installArchiveOperationFences } from "./archive-operation-fences.ts";
import { OperationClaimError, OperationClaimRegistry, installArchiveOperationClaimFences } from './operation-claims.ts';
import { ExtractionRepository } from './extraction/index.ts';

type Database = ArchiveDatabaseFile;
type Pool = ArchivePool;
type SQLite = ArchiveSqlite;
const archiveOperations = new Set<keyof ArchivesOperations>([
  "listArchiveJobs",
  "beginArchiveExport",
  "advanceArchiveJob",
  "archiveJobStatus",
  "openArchiveExport",
  "beginArchiveRestore",
  "finishArchiveRestore",
  "cancelArchiveJob",
  "releaseArchiveJob",
  "prepareArchiveActivation",
]);
type BlobReference = { sha256: string; byteLength: number; encoding?: "utf-8" };
function importReferences(entry: StagedImportRecord): BlobReference[] {
  switch (entry.collection) {
    case "attachments": {
      const a = entry.record;
      return a.availability === "available" &&
        a.blobSha256 &&
        a.sizeBytes !== null
        ? [{ sha256: a.blobSha256, byteLength: a.sizeBytes }]
        : [];
    }
    case "rawObjects": {
      const raw = entry.record;
      return raw.availability === "available" &&
        raw.sha256 &&
        raw.byteLength !== null
        ? [{ sha256: raw.sha256, byteLength: raw.byteLength }]
        : [];
    }
    case "parts": {
      const part = entry.record;
      return (part.kind === "Text" || part.kind === "Note") &&
        part.data.textBlob
        ? [{ ...part.data.textBlob }]
        : [];
    }
    default:
      return [];
  }
}
function references(mutation: CanonicalMutation): BlobReference[] {
  const parts = (items: ContentPart[]): BlobReference[] =>
    items.flatMap((part) =>
      (part.kind === "Text" || part.kind === "Note") && part.data.textBlob
        ? [{ ...part.data.textBlob }]
        : [],
    );
  switch (mutation.kind) {
    case "RegisterAttachment": {
      const a = mutation.payload.attachment;
      return a.availability === "available" &&
        a.blobSha256 &&
        a.sizeBytes !== null
        ? [{ sha256: a.blobSha256, byteLength: a.sizeBytes }]
        : [];
    }
    case "ResolveAttachment":
      return [
        {
          sha256: mutation.payload.blobSha256,
          byteLength: mutation.payload.sizeBytes,
        },
      ];
    case "RegisterImportSource":
      return mutation.payload.rawObjects.flatMap((raw) =>
        raw.availability === "available" &&
        raw.sha256 &&
        raw.byteLength !== null
          ? [{ sha256: raw.sha256, byteLength: raw.byteLength }]
          : [],
      );
    case "RegisterRawObject": {
      const raw = mutation.payload.rawObject;
      return raw.availability === "available" &&
        raw.sha256 &&
        raw.byteLength !== null
        ? [{ sha256: raw.sha256, byteLength: raw.byteLength }]
        : [];
    }
    case "CreateMessage":
    case "EditMessage":
    case "CreateGeneration":
    case "AttachContent":
      return parts(mutation.payload.parts);
    case "AppendGenerationOutput":
      return parts(mutation.payload.newParts);
    default:
      return [];
  }
}
export class ArchiveDatabase {
  readonly repository: CanonicalRepository;
  readonly catalog: BlobCatalog;
  readonly producers: ProducerRepository;
  readonly views: ViewRepository;
  readonly archives: ArchiveRepository;
  private readonly operationClaims: OperationClaimRegistry;
  private readonly extraction: ExtractionRepository;
  private extractionFailure: unknown;
  private search: SearchRepository | undefined;
  private inventory: BlobInventoryRepository | undefined;
  private searchFailure: unknown;
  private readonly tokenizerFailure: unknown;
  private readonly schemaVersion: number;
  private constructor(
    private readonly db: Database,
    private readonly pool: Pool,
    private readonly blobs: OpfsBlobStore,
    archiveId: string,
    onSearch: (status: SearchIndexStatus) => void,
    sqlite: SQLite,
    quixiDirectory: FileSystemDirectoryHandle,
    opfsRoot: FileSystemDirectoryHandle,
    chunkTokenizer: SearchChunkTokenizer | null,
    tokenizerFailure: unknown,
  ) {
    this.catalog = new BlobCatalog(db, blobs);
    this.repository = new CanonicalRepository(db, {
      assertBlobAvailable: (...args) => this.catalog.assertAvailable(...args),
    });
    this.schemaVersion = this.repository.migrate();
    this.catalog.initialize();
    this.catalog.reconcileOwnerStart();
    this.producers = new ProducerRepository(db, this.repository, archiveId);
    this.views = new ViewRepository(db, this.repository);
    this.archives = new ArchiveRepository({
      db,
      sqlite,
      pool,
      archiveId,
      quixiDirectory,
      opfsRoot,
      blobs: this.catalog,
    });
    installArchiveOperationFences(db);
    installArchiveOperationClaimFences(db);
    this.operationClaims = new OperationClaimRegistry(db, sqlite);
    this.extraction = new ExtractionRepository(db, {
      operations: this.operationClaims,
      supportedVersions: [DOCUMENT_EXTRACTION_VERSIONS],
      lookupIdentity: documentId => {
        const document = this.repository.get('documents', documentId);
        if (!document) return null;
        const attachment = this.repository.get('attachments', document.attachmentId);
        if (!attachment) return null;
        return {
          documentId, attachmentId: attachment.id,
          attachmentSha256: attachment.blobSha256,
          attachmentByteLength: attachment.sizeBytes,
          available: attachment.availability === 'available',
          mediaType: attachment.mimeType ?? '',
        };
      },
    });
    try { this.extraction.initialize(); }
    catch (error) { this.extractionFailure = error; }
    this.tokenizerFailure = chunkTokenizer ? undefined : (tokenizerFailure ?? new Error("The chunk tokenizer is unavailable"));
    this.search = new SearchRepository(db, this.catalog, {
      onProgress: onSearch,
      publishedSources: this.extraction.publishedSources,
      ...(chunkTokenizer ? { chunkTokenizer } : {}),
    });
    try {
      // Production chunking requires the frozen tokenizer so chunk identity is
      // stable across hosts; without it the derived index is refused, not
      // silently rebuilt under another policy.
      if (!chunkTokenizer) throw tokenizerFailure ?? new Error("The chunk tokenizer is unavailable");
      this.search.initialize();
    } catch (error) {
      this.searchFailure = error;
      try { this.search.disableDerivedTriggers(); } catch { /* preserve the original failure */ }
    }
  }
  /** True when the namespace's blob directory holds any published or
   * in-flight content file; used only to refuse first-run creation. */
  private static async namespaceHasBlobs(quixi: FileSystemDirectoryHandle): Promise<boolean> {
    let blobs: FileSystemDirectoryHandle;
    try { blobs = await quixi.getDirectoryHandle('blobs'); }
    catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return false;
      throw error;
    }
    for await (const [, entry] of blobs.entries()) {
      if (entry.kind !== 'directory') return true;
      for await (const _inner of entry.entries()) return true;
    }
    return false;
  }
  static async open(
    archiveId: string,
    onSearch: (status: SearchIndexStatus) => void = () => {},
    /** `create: 'if-empty'` is first-run initialization: a namespace that
     * holds neither a pool database nor any blob file is treated as a torn
     * earlier first run and created; any namespace with data is opened as is
     * or refused, never replaced by an empty archive. */
    options: { create: boolean | 'if-empty'; requireUnclaimedSelectionBootstrap?: boolean } = { create: true },
  ): Promise<ArchiveDatabase> {
    const root = await navigator.storage.getDirectory();
    const directoryName =
      archiveId === "default" ? "quixi" : `quixi-${archiveId}`;
    const quixi = await root.getDirectoryHandle(directoryName, {
      create: options.create !== false,
    });
    if (options.create === false) await quixi.getDirectoryHandle('database');
    const sqlite = await loadStorageSqlite();
    let chunkTokenizer: SearchChunkTokenizer | null = null, tokenizerFailure: unknown;
    try { chunkTokenizer = await loadChunkTokenizer(); } catch (error) { tokenizerFailure = error; }
    const pool = await sqlite.installOpfsSAHPoolVfs({
      name: "quixi-archive",
      directory: `/${directoryName}/database`,
      initialCapacity: 10,
    });
    await pool.unpauseVfs();
    let db: Database | undefined;
    let blobs: OpfsBlobStore | undefined;
    try {
      const hasDatabase = pool.getFileNames().includes('/archive.sqlite3');
      let create = options.create === true;
      if (options.create === 'if-empty') {
        if (hasDatabase) create = false;
        else if (await ArchiveDatabase.namespaceHasBlobs(quixi))
          throw new BlobStorageError('IO_ERROR', 'Selected archive database is missing while attachment files exist; restore its existing data instead of creating an empty archive.');
        else create = true;
      }
      if (!create && !hasDatabase)
        throw new BlobStorageError('IO_ERROR', 'Selected archive database is missing; restore its existing data instead of creating an empty archive.');
      db = new pool.OpfsSAHPoolDb("/archive.sqlite3", create ? 'c' : 'w');
      db.exec(
        "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA temp_store=FILE; PRAGMA temp.cache_size=-1024;",
      );
      if (options.requireUnclaimedSelectionBootstrap &&
          db.selectValue("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='quixi_local_state'") &&
          db.selectValue("SELECT 1 FROM quixi_local_state WHERE key='selectionBootstrap'"))
        throw new BlobStorageError('IO_ERROR', 'The archive selection catalog is missing after prior initialization; recover the retained catalog before reopening.');
      blobs = await OpfsBlobStore.open(quixi);
      return new ArchiveDatabase(
        db,
        pool,
        blobs,
        archiveId,
        onSearch,
        sqlite,
        quixi,
        root,
        chunkTokenizer,
        tokenizerFailure,
      );
    } catch (error) {
      try {
        blobs?.close();
        db?.close();
      } finally {
        pool.pauseVfs();
      }
      throw error;
    }
  }
  /** Only the fresh catalog's guarded bootstrap may claim this marker. Its
   * survival prevents silent default adoption after loss of the catalog root. */
  claimSelectionBootstrap(): void {
    if (this.db.selectValue("SELECT 1 FROM quixi_local_state WHERE key='selectionBootstrap'"))
      throw new BlobStorageError('IO_ERROR', 'The archive selection catalog is missing after prior initialization; recovery is required. Existing archives remain retained.');
    this.db.exec({ sql: "INSERT INTO quixi_local_state VALUES('selectionBootstrap',?)", bind: [JSON.stringify({ version: 1, id: crypto.randomUUID() })] });
  }
  async quiesce(): Promise<void> { await this.search?.yieldResources(); }
  sourceHighWater(): number {
    return Number(this.db.selectValue('SELECT coalesce(max(sequence),0) FROM quixi_sync_ops'));
  }
  assertActivationIdle(): void {
    // Registered producers with a pending attempt must be stopped explicitly.
    // Imported streaming prefixes have no local producer and remain exact.
    if (this.db.selectValue("SELECT 1 FROM quixi_generation_producers p LEFT JOIN quixi_records g ON g.collection='generations' AND g.id=p.generation_id WHERE p.state IN('active','released') AND (g.id IS NULL OR json_extract(g.payload,'$.status')='streaming') LIMIT 1"))
      throw new BlobStorageError('CONFLICT', 'Stop active generations and finish producer recovery before replacing the active archive.');
  }
  async close(mode: 'cleanup' | 'handles' = 'cleanup'): Promise<void> {
    try {
      await this.inventory?.close();
      if (mode === 'handles') this.search?.abandon();
      else await this.search?.close();
    } finally {
      this.extraction.close();
      try {
        await this.archives.close();
      } finally {
        try {
          this.blobs.close();
        } finally {
          try {
            this.db.close();
          } finally {
            this.pool.pauseVfs();
          }
        }
      }
    }
  }
  private searchRepository(): SearchRepository {
    if (this.searchFailure || !this.search)
      throw this.searchFailure ?? new Error("Search initialization failed");
    return this.search;
  }
  async advanceSearch(
    signal: AbortSignal,
  ): Promise<{ remaining: boolean; progressed: boolean }> {
    if (!this.search || this.searchFailure)
      return { remaining: false, progressed: false };
    try {
      const before = this.search.status();
      if (!before.pendingSources) return this.search.maintainSemantic(64);
      const after = await this.search.advance({ maxChunks: 8 }, signal);
      const semantic = after.pendingSources ? { remaining: false, progressed: false } : this.search.maintainSemantic(64);
      return {
        remaining: after.pendingSources > 0 || semantic.remaining,
        progressed:
          after.revision !== before.revision ||
          after.activeSource?.readBytes !== before.activeSource?.readBytes || semantic.progressed,
      };
    } catch (error) {
      this.searchFailure = error;
      try {
        this.search.disableDerivedTriggers();
      } catch {
        /* Preserve the original derived failure for explicit repair. */
      }
      return { remaining: false, progressed: false };
    }
  }
  /** Derived cleanup stays inside the same selection-fenced owner queue. A
   * broken extraction schema cannot disable canonical access or conversation FTS. */
  cleanupExtraction(): { remaining: boolean; progressed: boolean } {
    if (this.extractionFailure) return { remaining: false, progressed: false };
    try {
      const result = this.extraction.cleanup();
      const remaining = Boolean(this.db.selectValue('SELECT EXISTS(SELECT 1 FROM quixi_extract_cleanup_pages) OR EXISTS(SELECT 1 FROM quixi_extract_cleanup_runs)'));
      return { remaining, progressed: result.rows > 0 };
    } catch (error) {
      this.extractionFailure = error;
      return { remaining: false, progressed: false };
    }
  }
  /** One bounded maintenance slice, serialized with foreground operations. The
   * durable mapping remains until cleanup succeeds, including across owner loss.
   */
  async cleanupImportBlobs(): Promise<{ remaining: boolean; failed: boolean }> {
    let failed = false;
    try {
      const eligible =
        "FROM quixi_import_blob_transfers b JOIN quixi_import_jobs j ON j.id=b.import_id WHERE j.state IN('published','cancelled') AND NOT EXISTS(SELECT 1 FROM quixi_import_blob_transfers other JOIN quixi_import_jobs active ON active.id=other.import_id WHERE other.transfer_id=b.transfer_id AND active.state NOT IN('published','cancelled'))";
      const rows = this.db.exec({
        sql: `SELECT b.import_id,b.transfer_id ${eligible} ORDER BY b.import_id,b.transfer_id LIMIT 32`,
        rowMode: "object",
        returnValue: "resultRows",
      }) as { import_id: string; transfer_id: string }[];
      for (const row of rows) {
        try {
          if (await this.catalog.cleanupImportTransfer(row.transfer_id))
            this.repository.forgetImportBlobTransfer(
              row.import_id,
              row.transfer_id,
            );
          else failed = true;
        } catch {
          failed = true;
        }
      }
      const remaining = Boolean(
        this.db.selectValue(`SELECT EXISTS(SELECT 1 ${eligible})`),
      );
      return { remaining, failed };
    } catch {
      return { remaining: true, failed: true };
    }
  }
  async execute(
    call: ArchiveCall,
    ownerId: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (signal.aborted)
      throw new BlobStorageError(
        "CANCELLED",
        "Storage operation cancelled before execution",
      );
    if (
      call.kind === "request" &&
      ["beginBlobTransfer", "readBlobTransfer", "sliceBlobTransfer"].includes(
        call.request.operation,
      )
    ) {
      try {
        await this.search?.yieldResources();
      } catch (error) {
        this.searchFailure = error;
      }
    }
    switch (call.kind) {
      case "upload":
        return this.archives.ownsTransfer(call.chunk.transferId)
          ? this.archives.append(call.chunk, signal)
          : this.catalog.append(call.chunk);
      case "read":
        return this.archives.ownsTransfer(call.transferId)
          ? this.archives.readChunk(call.transferId)
          : this.catalog.readChunk(call.transferId);
      case "ack":
        if (this.archives.ownsTransfer(call.acknowledgement.transferId))
          this.archives.acknowledge(call.acknowledgement);
        else this.catalog.acknowledge(call.acknowledgement);
        return null;
      case "request":
        return this.request(call.request, ownerId, signal);
      default:
        throw new BlobStorageError(
          "INVALID_REQUEST",
          "Cancellation is handled by the owner coordinator",
        );
    }
  }
  operationStatus(operationId: string) {
    const canonical = this.repository.operationStatus(operationId);
    if (canonical.status === "committed") return canonical;
    const result = this.archives.operationStatus(operationId);
    if (result !== null) return { status: 'committed' as const, result };
    const claim = this.operationClaims.lookup(operationId);
    if (!claim) return canonical;
    if (claim.domain === 'extraction' && !this.extractionFailure) {
      const receipt = this.extraction.operationStatus(operationId);
      if (receipt.status === 'committed' && receipt.requestDigest === claim.requestDigest)
        return { status: 'committed' as const, result: receipt.result as JsonValue };
    }
    throw new OperationClaimError('UNKNOWN_OUTCOME', 'This operation has a durable claim but its original receipt is unavailable. Preserve the operation ID for recovery.');
  }
  private extractionRepository(): ExtractionRepository {
    if (this.extractionFailure) throw this.extractionFailure;
    return this.extraction;
  }
  private async request(
    request: StorageRequest,
    ownerId: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    const isArchive = archiveOperations.has(
      request.operation as keyof ArchivesOperations,
    );
    const operationIds =
      request.operation === "commit"
        ? request.args.mutations.map((value) => value.operationId)
        : request.operation !== "operationStatus" &&
            request.args &&
            "operationId" in request.args
          ? [String(request.args.operationId)]
          : [];
    for (const operationId of operationIds)
      if (
        isArchive
          ? this.repository.operationStatus(operationId).status === "committed"
          : this.archives.operationStatus(operationId) !== null
      )
        throw new BlobStorageError(
          "CONFLICT",
          "Operation identity belongs to a different storage journal",
        );
    switch (request.operation) {
      case 'beginBlobInventory':
        this.inventory ??= new BlobInventoryRepository(this.db, this.blobs);
        return this.inventory.begin(request.args.scanId);
      case 'advanceBlobInventory': case 'blobInventoryStatus':
      case 'readBlobInventoryFindings': case 'cancelBlobInventory': {
        if (!this.inventory) throw new BlobStorageError('NOT_FOUND', 'Blob inventory belongs to a previous storage owner; start a new scan.');
        if (request.operation === 'advanceBlobInventory') return this.inventory.advance(request.args.scanId, request.args.maxItems, signal);
        if (request.operation === 'blobInventoryStatus') return this.inventory.status(request.args.scanId);
        if (request.operation === 'readBlobInventoryFindings') return this.inventory.findings(request.args.scanId, request.args.page);
        return this.inventory.cancel(request.args.scanId);
      }
      case 'getExtractionOperation': {
        const status = this.operationStatus(request.args.operationId);
        if (status.status === 'not_found') return { status: 'not_found' };
        const claim = this.operationClaims.lookup(request.args.operationId);
        if (claim?.domain !== 'extraction')
          throw new BlobStorageError('CONFLICT', 'Operation identity belongs to another storage journal.');
        return { status: 'committed', requestDigest: claim.requestDigest, result: status.result };
      }
      case 'advanceExtractionPageIndex': {
        const extraction = this.extractionRepository();
        if (!extraction.publishedSources.current(request.args.pageRef))
          throw new BlobStorageError('CONFLICT', 'Published document page changed; refresh extraction progress.');
        const search = this.searchRepository();
        if (search.isExtractionPageIndexed(request.args.pageRef)) return { indexed: true };
        await search.advanceExtractionIndex(signal);
        return { indexed: search.isExtractionPageIndexed(request.args.pageRef) };
      }
      case 'beginDocumentExtraction': case 'resumeDocumentExtraction':
      case 'beginExtractionPage': case 'stagePageText': case 'publishExtractionPage':
      case 'completeDocumentExtraction': case 'interruptDocumentExtraction':
      case 'getDocumentExtraction': case 'getPublishedExtractionPage': case 'readExtractedPageText':
      case 'readExtractedPageMap': case 'clearDocumentExtraction':
        return this.extractionRepository().execute(request.operation, request.args);
      case "commit": {
        const replay = this.repository.committedTransaction(request.args);
        if (replay) return replay;
        await this.catalog.preparePublication(
          request.args.stagedBlobIds,
          signal,
        );
        const seen = new Set<string>();
        for (const mutation of request.args.mutations)
          for (const ref of references(mutation)) {
            const key = `${ref.sha256}:${ref.byteLength}:${ref.encoding ?? "bytes"}`;
            if (seen.has(key)) continue;
            seen.add(key);
            await this.catalog.verifyExisting(
              ref.sha256,
              ref.byteLength,
              ref.encoding,
              signal,
            );
          }
        if (signal.aborted)
          throw new BlobStorageError(
            "CANCELLED",
            "Canonical mutation cancelled before commit",
          );
        await this.producers.assertWritable(request.args.mutations);
        if (signal.aborted)
          throw new BlobStorageError(
            "CANCELLED",
            "Canonical mutation cancelled before commit",
          );
        const result = this.repository.commit(request.args);
        // Cleanup cannot turn known commit success into an uncertain write outcome.
        await this.catalog.consumeAfterCommit(request.args.stagedBlobIds);
        return result;
      }
      case "readEntities":
        return this.repository.readEntities(request.args);
      case "readMessageParts":
        return this.repository.readMessageParts(request.args);
      case "readSyncOperations":
        return this.repository.readSyncOperations(request.args);
      case "operationStatus":
        return this.operationStatus(request.args.operationId);
      case "readEntity":
        return this.repository.get(request.args.collection, request.args.id);
      case "listArchiveJobs":
      case "beginArchiveExport":
      case "advanceArchiveJob":
      case "archiveJobStatus":
      case "openArchiveExport":
      case "beginArchiveRestore":
      case "finishArchiveRestore":
      case "cancelArchiveJob":
      case "releaseArchiveJob":
      case "prepareArchiveActivation": {
        try {
          await this.search?.yieldResources();
        } catch (error) {
          this.searchFailure = error;
        }
        return this.archives.request(request.operation, request.args, signal);
      }
      case "archiveWorkspace":
        return this.views.workspace();
      case "readLocalPreferences":
        return new PreferenceRepository(this.db).read();
      case "readRoutingAliases":
        return new RoutingAliasRepository(this.db).read();
      case "putRoutingAlias": case "removeRoutingAlias":
        return new RoutingAliasRepository(this.db).write(request.operation, request.args);
      case "setSendKey":
        return new PreferenceRepository(this.db).setSendKey(request.args);
      case "setInteractionPreferences":
        return new PreferenceRepository(this.db).setInteractionPreferences(request.args);
      case "setOnboardingState":
        return new PreferenceRepository(this.db).setOnboardingState(request.args);
      case "listLibrary":
        return this.views.library(request.args);
      case "readSummarySourceInfo": return summarySourceInfo(this.db,request.args.contextSnapshotId,request.args.throughMessageId);
      case "readThreadView":
        return this.views.thread(request.args);
      case "readConversationWindow":
        return this.views.window(request.args);
      case "readMessageChildren":
        return this.views.children(request.args);
      case "registerGenerationProducer":
        return this.producers.register(request.args);
      case "releaseGenerationProducer":
        return this.producers.release(request.args);
      case "reconcileGenerationProducers":
        return this.producers.reconcile(request.args.maxProducers);
      case "searchArchive":
        return this.searchRepository().search(request.args);
      case "resolveDocumentSearchHit":
        return this.searchRepository().resolveDocumentHit(request.args);
      case "resolveConversationSearchHit":
        return this.searchRepository().resolveConversationHit(request.args);
      case "searchStatus":
        return this.searchRepository().status();
      case "rebuildSearch": {
        // Without the bundled tokenizer no derived policy is valid; repair
        // cannot silently rebuild under the lexical-only fixture policy.
        if (this.tokenizerFailure) throw this.tokenizerFailure;
        if (this.searchFailure && this.search) {
          try {
            await this.search.yieldResources();
          } catch {
            /* Repair also replaces damaged derived cleanup tables. */
          }
          const status = await this.search.repairDerived(request.args);
          this.searchFailure = undefined;
          return status;
        }
        return this.searchRepository().rebuild(request.args);
      }
      case "advanceSearchIndex":
        return this.searchRepository().advance(request.args, signal);
      case "semanticStatus":
        return this.searchRepository().semanticStatus();
      case "enrollSemantic":
        return this.searchRepository().enrollSemantic(request.args);
      case "setSemanticState":
        return this.searchRepository().setSemanticState(request.args);
      case "claimSemanticChunks":
        return this.searchRepository().claimSemanticChunks(request.args);
      case "publishSemanticVectors":
        return this.searchRepository().publishSemanticVectors(request.args);
      case "deleteSemanticIndex":
        return this.searchRepository().deleteSemanticIndex(request.args);
      case "resolveSourceIdentity":
        return this.repository.resolveSourceIdentity(request.args.scope);
      case "importRunBegin":
        return this.repository.importRunBegin(request.args);
      case "importRunList":
        return this.repository.importRunList(request.args);
      case "importRunStatus":
        return this.repository.importRunStatus(request.args);
      case "importRunSetState":
        return this.repository.importRunSetState(request.args);
      case "importRunReadGroups":
        return this.repository.importRunReadGroups(request.args);
      case "importAllocateIds":
        return this.repository.importAllocateIds(request.args, () =>
          crypto.randomUUID(),
        );
      case "importWorkStage":
        return this.repository.importWorkStage(request.args);
      case "importWorkSeal":
        return this.repository.importWorkSeal(request.args);
      case "importWorkGroupStatus":
        return this.repository.importWorkGroupStatus(request.args);
      case "importWorkRead":
        return this.repository.importWorkRead(request.args);
      case "importWorkGet":
        return this.repository.importWorkGet(request.args);
      case "importWorkResolve":
        return this.repository.importWorkResolve(request.args);
      case "importWorkCheckpoint":
        return this.repository.importWorkCheckpoint(request.args);
      case "importGroupFinish":
        return this.repository.importGroupFinish(request.args);
      case "beginNormalizedImport":
        return this.repository.beginNormalizedImport(request.args);
      case "stageImportRecords":
        return this.repository.stageImportRecords(request.args);
      case "normalizedImportStatus":
        return this.repository.normalizedImportStatus(request.args);
      case "readStagedImportRecords":
        return this.repository.readStagedImportRecords(request.args);
      case "prepareImportBlobs": {
        const replay = this.repository.committedImportOperation(
          "prepareImportBlobs",
          request.args,
        );
        if (replay) return replay;
        this.repository.recordImportBlobTransfers(
          request.args.importId,
          request.args.stagedBlobIds,
        );
        await this.catalog.preparePublication(
          request.args.stagedBlobIds,
          signal,
        );
        if (signal.aborted)
          throw new BlobStorageError(
            "CANCELLED",
            "Import byte publication cancelled before its checkpoint",
          );
        return this.repository.completeImportBlobPreparation(request.args);
      }
      case "validateImportStep": {
        const replay = this.repository.committedImportOperation(
          "validateImportStep",
          request.args,
        );
        if (replay) return replay;
        const status = this.repository.normalizedImportStatus({
          importId: request.args.importId,
        });
        if (status.state === "published" || status.state === "cancelled")
          return this.repository.validateImportStep(request.args);
        this.repository.recordImportBlobTransfers(
          request.args.importId,
          request.args.stagedBlobIds,
        );
        await this.catalog.preparePublication(
          request.args.stagedBlobIds,
          signal,
        );
        for (const entry of this.repository.importValidationRecords(
          request.args,
        )) {
          for (const ref of importReferences(entry))
            await this.catalog.verifyExisting(
              ref.sha256,
              ref.byteLength,
              ref.encoding,
              signal,
            );
        }
        if (signal.aborted)
          throw new BlobStorageError(
            "CANCELLED",
            "Import validation cancelled before its checkpoint",
          );
        return this.repository.validateImportStep(request.args);
      }
      case "finalizeNormalizedImport":
        return this.repository.finalizeNormalizedImport(request.args);
      case "cancelNormalizedImport":
        return this.repository.cancelNormalizedImport(request.args);
      case "beginBlobTransfer":
        return this.catalog.begin(request.args, () => crypto.randomUUID());
      case "finishBlobTransfer":
        return this.catalog.finish(request.args, signal);
      case "readBlobTransfer":
        return this.catalog.openRead(
          request.args.sha256,
          () => request.requestId,
          signal,
        );
      case "sliceBlobTransfer":
        return this.catalog.sliceRead(
          request.args.transferId,
          () => request.requestId,
          { offset: request.args.offset, byteLength: request.args.byteLength },
        );
      case "discardBlobTransfer":
        return this.catalog.discard(request.args.transferId);
      case "diagnostics": {
        const [estimate, persisted] = await Promise.all([
          navigator.storage.estimate().catch(() => null),
          navigator.storage.persisted().catch(() => null),
        ]);
        return {
          backend: "sqlite-wasm-opfs-sahpool",
          ownerId,
          schemaVersion: this.schemaVersion,
          integrity: String(this.db.selectValue("PRAGMA integrity_check")),
          canonicalRecords: Number(
            this.db.selectValue("SELECT count(*) FROM quixi_records"),
          ),
          syncOperations: Number(
            this.db.selectValue("SELECT count(*) FROM quixi_sync_ops"),
          ),
          persisted,
          usage: estimate?.usage ?? null,
          quota: estimate?.quota ?? null,
        };
      }
      default:
        throw new ArchiveStorageError(
          archiveError(
            new Error(
              `Storage operation ${request.operation} is not integrated yet`,
            ),
            request.requestId,
            null,
            "UNSUPPORTED",
          ),
        );
    }
  }
}
