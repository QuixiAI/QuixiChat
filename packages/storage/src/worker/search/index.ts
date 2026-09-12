import {
  StructuralChunker,
  CodeChunkClassifier,
  SearchError,
  lexicalQuery,
  searchExcerpt,
  searchDigest,
  fuseRanked,
  LEXICAL_CHUNKER_VERSION,
} from "@quixi/search";
import type { LocatedSearchChunk, ChunkPolicy, ChunkTokenizer } from "@quixi/search";
import {
  assertSearchArgs,
  assertPageBudget,
  jsonByteLength,
  canonicalJson,
} from "@quixi/core/contracts";
import type {
  ByteChunk,
  ChunkAcknowledgement,
  SearchIndexStatus,
  SearchOperations,
  SearchPage,
  SearchHit,
  SemanticClaim,
  SemanticIndexStatus,
  SemanticPublication,
} from "@quixi/core/contracts";
import { isQuixiId } from "@quixi/core/model";
import type { CanonicalSqlite, SqlValue } from "../canonical/repository.ts";
import {
  SEARCH_SCHEMA,
  SEARCH_SCHEMA_CHECKSUM,
  SEARCH_POLICY,
  searchVersion,
  VISIBLE_HEAD,
} from "./schema.ts";
import { SemanticRepository } from "./semantic.ts";
import type { SemanticInspect, VisibleChunkSql } from "./semantic.ts";
import { resolveDocumentHitSource, resolveConversationHitSource } from "./navigation.ts";
import { loadSource, record, rows } from "./sources.ts";
import type { Source, Extraction } from "./sources.ts";
import { assertPublishedPageRef } from "@quixi/core/contracts";
import type { PublishedPageRef } from "@quixi/core/contracts";
import { ExtractionVisibility } from "./extraction.ts";
import type { PublishedExtractionSources } from "../extraction/index.ts";
export type { Extraction } from "./sources.ts";
export interface SearchBlobAccess {
  openRead(
    sha256: string,
    nextId: () => string,
    signal?: AbortSignal,
  ): Promise<{ transferId: string; byteLength: number }>;
  beginVerifiedRead(
    sha256: string,
    nextId: () => string,
    signal?: AbortSignal,
  ): Promise<{ transferId: string; byteLength: number; verifiedBytes: number; complete: boolean }>;
  advanceVerifiedRead(
    transferId: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<{ transferId: string; byteLength: number; verifiedBytes: number; complete: boolean }>;
  sliceRead(
    parent: string,
    nextId: () => string,
    range: { offset: number; byteLength: number },
  ): { transferId: string };
  readChunk(transferId: string): ByteChunk;
  acknowledge(ack: ChunkAcknowledgement): void;
  discard(transferId: string): Promise<unknown>;
}
/** The frozen model tokenizer with source offsets and an exact admission
 * check; production hosts always inject it so chunk identity is stable. */
export interface SearchChunkTokenizer extends ChunkTokenizer {
  inspect: SemanticInspect;
}
export interface SearchRepositoryOptions {
  chunkTokenizer?: SearchChunkTokenizer;
  now?: () => number;
  /** Vectors at or above which queries use the int8 coarse projection (ADR 0036); fixtures lower it. */
  semanticCoarseThreshold?: number;
  publishedSources?: PublishedExtractionSources;
  nextId?: () => string;
  onProgress?: (status: SearchIndexStatus) => void;
}
export type DetailedSearchStatus = SearchIndexStatus & {
  activeSource: {
    sourceId: string;
    phase: "verifying" | "chunking";
    readBytes: number;
    sourceBytes: number;
  } | null;
  lastFailure: { sourceId: string; code: string; reason: string } | null;
};
type Work = {
  epoch: number;
  key: string;
  runId: string;
  source: Source;
  signature: number[];
  chunker: StructuralChunker;
  classifier: CodeChunkClassifier;
  iterator: Generator<LocatedSearchChunk> | null;
  reader: string | null;
  offset: number;
  readBytes: number;
  verifiedBytes: number;
  decoder: TextDecoder;
  inputEnded: boolean;
  phase: "verifying" | "chunking";
};
export class SearchRepository {
  private active: Work | null = null;
  private busy = false;
  private closed = false;
  private readonly nextId: () => string;
  private readonly extractionVisibility: ExtractionVisibility;
  private extractionUnavailable = false;
  private readonly semantic: SemanticRepository;
  /** Shared chunk policy; its version is part of the derived index version. */
  readonly policy: ChunkPolicy;
  readonly version: string;
  constructor(
    private readonly db: CanonicalSqlite,
    private readonly blobs: SearchBlobAccess,
    private readonly options: SearchRepositoryOptions = {},
  ) {
    this.nextId = options.nextId ?? (() => crypto.randomUUID());
    this.policy = Object.freeze({
      maxCharacters: SEARCH_POLICY.maxCharacters,
      overlapCharacters: SEARCH_POLICY.overlapCharacters,
      ...(options.chunkTokenizer ? { tokenizer: options.chunkTokenizer, maxTokens: SEARCH_POLICY.maxTokens } : {}),
    });
    this.version = searchVersion(`${LEXICAL_CHUNKER_VERSION}:${this.policy.maxCharacters}:${this.policy.overlapCharacters}:${options.chunkTokenizer?.version ?? "none"}:${options.chunkTokenizer ? SEARCH_POLICY.maxTokens : "none"}`);
    this.semantic = new SemanticRepository(db, options.now ?? (() => Date.now()), options.semanticCoarseThreshold);
    this.extractionVisibility = new ExtractionVisibility(
      db,
      options.publishedSources,
    );
  }
  private rows(sql: string, bind: SqlValue[] = []) {
    return rows(this.db, sql, bind);
  }
  private scalar(sql: string, bind: SqlValue[] = []) {
    return Number(
      bind.length ? this.db.selectValue(sql, bind) : this.db.selectValue(sql),
    );
  }
  private exec(sql: string, bind: SqlValue[] = []) {
    this.db.exec({ sql, ...(bind.length ? { bind } : {}) });
  }
  private tx<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* SQLITE_FULL may already have rolled back. */
      }
      throw error;
    }
  }
  private check() {
    if (this.closed)
      throw new SearchError("CONFLICT", "Search repository is closed.");
  }
  private meta() {
    return this.rows("SELECT * FROM quixi_search_meta")[0]!;
  }
  /** Canonical writes must remain possible when derived schema cannot open. */
  disableDerivedTriggers(): void {
    for (const event of ["insert", "update", "delete"])
      this.exec(`DROP TRIGGER IF EXISTS quixi_search_dirty_${event}`);
  }
  private installDerived(): void {
    this.exec(
      "CREATE TABLE quixi_search_schema(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL) STRICT",
    );
    this.db.exec(SEARCH_SCHEMA);
    this.exec("INSERT INTO quixi_search_schema VALUES(1,?)", [
      SEARCH_SCHEMA_CHECKSUM,
    ]);
    this.exec("INSERT INTO quixi_search_meta VALUES(1,?,1,NULL,2,0)", [
      this.version,
    ]);
    this.exec(
      "INSERT INTO quixi_search_queue(epoch,scope,id,revision) VALUES(1,'global','*',0)",
    );
  }
  private validateDerived(): void {
    const expected = [
      ...SEARCH_SCHEMA.matchAll(
        /CREATE (?:VIRTUAL )?(TABLE|TRIGGER|INDEX) (quixi_search_\w+)/g,
      ),
    ];
    for (const match of expected)
      if (
        !this.rows("SELECT 1 FROM sqlite_schema WHERE type=? AND name=?", [
          match[1]!.toLowerCase(),
          match[2]!,
        ]).length
      )
        throw new SearchError(
          "MIGRATION_FAILED",
          `Derived search object ${match[2]} is missing; rebuild the search index.`,
        );
    // Prepare bounded reads too: the ledger alone cannot establish schema health.
    this.rows(
      "SELECT epoch,scope,id,revision,after_id,failed,error FROM quixi_search_queue LIMIT 0",
    );
    if (
      !this.rows(
        "SELECT active_epoch,rebuilding_epoch,next_epoch,revision,version FROM quixi_search_meta WHERE singleton=1",
      ).length
    )
      throw new SearchError(
        "MIGRATION_FAILED",
        "Derived search metadata is missing.",
      );
  }
  initialize(): void {
    this.check();
    try {
      if (
        !this.rows(
          "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='quixi_search_schema'",
        ).length
      )
        this.tx(() => this.installDerived());
      const ledger = this.rows(
        "SELECT version,checksum FROM quixi_search_schema ORDER BY version",
      );
      if (
        ledger.length !== 1 ||
        ledger[0]!.version !== 1 ||
        ledger[0]!.checksum !== SEARCH_SCHEMA_CHECKSUM
      )
        throw new SearchError(
          "MIGRATION_FAILED",
          "Derived search schema is unsupported or changed; rebuild the search index while preserving canonical history.",
        );
      this.validateDerived();
      // A source is restarted after owner loss; incomplete runs never become heads.
      this.exec("DELETE FROM quixi_search_builds");
      if (this.meta().version !== this.version)
        this.rebuild({ operationId: this.nextId() });
      // A broken semantic namespace never disables lexical search.
      this.semantic.initialize();
    } catch (error) {
      this.disableDerivedTriggers();
      throw error;
    }
  }
  /** Explicit recovery replaces only the reserved derived search namespace. */
  repairDerived(
    args: SearchOperations["rebuildSearch"]["args"],
  ): SearchIndexStatus {
    this.check();
    assertSearchArgs("rebuildSearch", args);
    if (this.busy || this.active)
      throw new SearchError(
        "CONFLICT",
        "Yield search resources before repairing the index.",
      );
    try {
      // A successfully repaired operation remains idempotent. Broken schemas
      // cannot take this shortcut and are rebuilt below.
      let repeated = false;
      try {
        this.validateDerived();
        const ledger = this.rows(
          "SELECT version,checksum FROM quixi_search_schema",
        );
        repeated =
          ledger.length === 1 &&
          ledger[0]!.version === 1 &&
          ledger[0]!.checksum === SEARCH_SCHEMA_CHECKSUM &&
          !!this.rows("SELECT id FROM quixi_search_operations WHERE id=?", [
            args.operationId,
          ]).length;
      } catch {
        /* Explicit repair is still required. */
      }
      if (repeated) return this.status();
      this.tx(() => {
        const objects = this.rows(
          "SELECT type,name FROM sqlite_schema WHERE type IN('table','trigger','view')",
        ).filter((row) => String(row.name).startsWith("quixi_search_"));
        const drop = (type: string, name: string) =>
          this.exec(`DROP ${type} IF EXISTS "${name.replaceAll('"', '""')}"`);
        for (const object of objects)
          if (object.type === "trigger") drop("TRIGGER", String(object.name));
        for (const object of objects)
          if (object.type === "view") drop("VIEW", String(object.name));
        // Drop the virtual table first; SQLite removes its own shadow tables.
        drop("TABLE", "quixi_search_fts");
        for (const object of objects)
          if (object.type === "table" && object.name !== "quixi_search_fts")
            drop("TABLE", String(object.name));
        this.installDerived();
        this.exec("INSERT INTO quixi_search_operations VALUES(?,1)", [
          args.operationId,
        ]);
      });
      return this.status();
    } catch (error) {
      this.disableDerivedTriggers();
      throw error;
    }
  }
  /** Serialized after aborting/awaiting advance; the dirty source stays queued. */
  async yieldResources(): Promise<void> {
    this.check();
    if (this.busy)
      throw new SearchError(
        "CONFLICT",
        "Await the cancelled indexing slice before yielding resources.",
      );
    if (this.active) await this.release(this.active);
    this.progress();
  }
  private signature(source: Source): number[] {
    return [
      ["source", source.key],
      ["message", source.messageId],
      ["thread", source.threadId],
      ["document", source.documentId],
      ["global", "*"],
    ].map(([scope, id]) =>
      id
        ? this.scalar(
            "SELECT coalesce((SELECT revision FROM quixi_search_scopes WHERE scope=? AND id=?),0)",
            [scope!, id],
          )
        : 0,
    );
  }
  private visibleHead(): string {
    return `${VISIBLE_HEAD} AND ${this.extractionVisibility.predicate(!this.extractionUnavailable)}`;
  }
  private extractionReady(): boolean {
    return !this.extractionUnavailable && this.extractionVisibility.ready();
  }
  private quarantineExtraction(documentId: string): void {
    this.exec(
      "INSERT INTO quixi_search_scopes VALUES('extraction_failed',?,0) ON CONFLICT(scope,id) DO NOTHING",
      [documentId],
    );
    this.exec("UPDATE quixi_search_meta SET revision=revision+1");
  }
  private current(work: Work): boolean {
    if (work.source.extractionRef) {
      if (!this.extractionReady()) return false;
      try {
        if (!this.options.publishedSources!.current(work.source.extractionRef))
          return false;
      } catch {
        this.quarantineExtraction(
          work.source.extractionRef.identity.documentId,
        );
        return false;
      }
    }
    return (
      JSON.stringify(this.signature(work.source)) ===
      JSON.stringify(work.signature)
    );
  }
  status(): DetailedSearchStatus {
    const meta = this.meta();
    const publicationPending = this.pendingExtractionPublications();
    const queued =
      publicationPending +
      this.scalar("SELECT count(*) FROM quixi_search_queue WHERE failed=0");
    const failed = this.scalar(
      "SELECT count(*) FROM quixi_search_queue WHERE failed=1",
    );
    const cleanup = this.obsolete() ? 1 : 0;
    const indexed = this.scalar(
      `SELECT count(*) FROM quixi_search_chunks c JOIN quixi_search_heads h ON h.epoch=c.epoch AND h.source_key=c.source_key AND h.run_id=c.run_id WHERE h.epoch=? AND ${this.visibleHead()}`,
      [Number(meta.active_epoch)],
    );
    const failure = this.rows(
      "SELECT id,error FROM quixi_search_queue WHERE failed=1 ORDER BY epoch,id LIMIT 1",
    )[0];
    return {
      state:
        meta.rebuilding_epoch !== null
          ? "rebuilding"
          : queued || cleanup
            ? "indexing"
            : failed
              ? "failed"
              : "ready",
      version: this.version,
      indexedChunks: indexed,
      pendingSources: queued + cleanup,
      failedSources: failed,
      activeEpoch: Number(meta.active_epoch),
      rebuildingEpoch:
        meta.rebuilding_epoch === null ? null : Number(meta.rebuilding_epoch),
      revision: Number(meta.revision),
      semantic: this.semanticAvailability(),
      ...(this.active
        ? {
            activeSource: {
              sourceId: this.active.key,
              phase: this.active.phase,
              readBytes: this.active.phase === "verifying" ? this.active.verifiedBytes : this.active.readBytes,
              sourceBytes:
                this.active.source.blob?.byteLength ??
                new TextEncoder().encode(this.active.source.text ?? "").length,
            },
          }
        : { activeSource: null }),
      lastFailure: failure
        ? {
            sourceId: String(failure.id),
            code: String(failure.error).split(":", 1)[0]!,
            reason: String(failure.error),
          }
        : null,
    } as DetailedSearchStatus;
  }
  private progress() {
    try {
      this.options.onProgress?.(this.status());
    } catch {
      /* Subscribers cannot fail derived maintenance. */
    }
  }
  rebuild(args: SearchOperations["rebuildSearch"]["args"]): SearchIndexStatus {
    this.check();
    assertSearchArgs("rebuildSearch", args);
    if (
      this.rows("SELECT id FROM quixi_search_operations WHERE id=?", [
        args.operationId,
      ]).length
    )
      return this.status();
    this.tx(() => {
      const meta = this.meta(),
        epoch = Number(meta.rebuilding_epoch ?? meta.next_epoch);
      if (meta.rebuilding_epoch === null) {
        this.exec(
          "UPDATE quixi_search_meta SET rebuilding_epoch=?,next_epoch=?,revision=revision+1",
          [epoch, epoch + 1],
        );
        this.exec(
          "INSERT INTO quixi_search_queue(epoch,scope,id,revision) VALUES(?,'global','*',?)",
          [epoch, Number(meta.revision)],
        );
      } else
        this.exec(
          "INSERT INTO quixi_search_queue(epoch,scope,id,revision,after_id,failed) VALUES(?,'global','*',?,'',0) ON CONFLICT(epoch,scope,id) DO UPDATE SET after_id='',failed=0",
          [epoch, Number(meta.revision)],
        );
      this.exec("INSERT INTO quixi_search_operations VALUES(?,?)", [
        args.operationId,
        epoch,
      ]);
    });
    return this.status();
  }
  /** Derived extraction registration. Canonical attachment identity/digest fences
   * stale pages. Large page/blob extraction registration belongs to plan14. */
  registerExtractedText(value: Extraction): void {
    this.check();
    if (
      !isQuixiId(value.id) ||
      !isQuixiId(value.documentId) ||
      !/^[0-9a-f]{64}$/.test(value.attachmentSha256) ||
      !value.extractorVersion ||
      value.extractorVersion.length > 128 ||
      typeof value.text !== "string" ||
      value.text.length > 65536 ||
      (value.page !== null &&
        (!Number.isSafeInteger(value.page) || value.page < 1)) ||
      !Number.isSafeInteger(value.offsetBase) ||
      value.offsetBase < 0 ||
      value.sectionPath.length > 32 ||
      value.sectionPath.some(
        (part) => typeof part !== "string" || part.length > 1024,
      )
    )
      throw new SearchError(
        "INVALID_REQUEST",
        "Extracted page text or metadata exceeds its bounded registration contract.",
      );
    const previous = this.rows(
      "SELECT document_id FROM quixi_search_extractions WHERE id=?",
      [value.id],
    )[0];
    const document = record(this.db, "documents", value.documentId),
      attachment = document
        ? record(this.db, "attachments", document.attachmentId)
        : null;
    if (!attachment || attachment.blobSha256 !== value.attachmentSha256)
      throw new SearchError(
        "CONFLICT",
        "Extracted text does not describe the current document attachment.",
      );
    this.tx(() => {
      this.exec(
        "INSERT INTO quixi_search_extractions VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET document_id=excluded.document_id,attachment_sha256=excluded.attachment_sha256,extractor_version=excluded.extractor_version,text=excluded.text,page=excluded.page,section_path=excluded.section_path,offset_base=excluded.offset_base",
        [
          value.id,
          value.documentId,
          value.attachmentSha256,
          value.extractorVersion,
          value.text,
          value.page,
          JSON.stringify(value.sectionPath),
          value.offsetBase,
        ],
      );
      if (previous && previous.document_id !== value.documentId)
        this.dirty("document", String(previous.document_id));
      this.dirty("document", value.documentId);
    });
  }
  private pendingExtractionPublications(): number {
    if (!this.extractionReady()) return 0;
    try {
      return this.options.publishedSources!.readPublicationBatch(1).length;
    } catch {
      this.extractionUnavailable = true;
      return 0;
    }
  }
  /** Called in the owner's serial queue; ACK and all dirtiness share one txn. */
  drainExtractionPublications(limit = 32): number {
    this.check();
    if (!Number.isInteger(limit) || limit < 1 || limit > 32)
      throw new SearchError(
        "INVALID_REQUEST",
        "Extraction outbox budget must be 1–32.",
      );
    if (!this.extractionReady()) return 0;
    let batch;
    try {
      batch = this.options.publishedSources!.readPublicationBatch(limit);
    } catch {
      this.extractionUnavailable = true;
      return 0;
    }
    if (!batch.length) return 0;
    this.tx(() => {
      for (const entry of batch) {
        this.exec(
          "DELETE FROM quixi_search_scopes WHERE scope='extraction_failed' AND id=?",
          [entry.documentId],
        );
        if (entry.kind === "page" && entry.pageAttemptId)
          this.dirty("source", `e:${entry.pageAttemptId}`);
        else this.dirty("document", entry.documentId);
      }
      this.options.publishedSources!.acknowledgePublications(
        batch.map((entry) => entry.revision),
      );
    });
    return batch.length;
  }
  /** Page-specific producer credit; an empty/scanned page can have a complete
   * head with zero chunks. Overall search readiness cannot establish this. */
  isExtractionPageIndexed(ref: PublishedPageRef): boolean {
    this.check();
    assertPublishedPageRef(ref);
    if (!this.extractionReady()) return false;
    try {
      if (!this.options.publishedSources!.current(ref)) return false;
    } catch {
      this.quarantineExtraction(ref.identity.documentId);
      return false;
    }
    return (
      this.scalar(
        `SELECT EXISTS(SELECT 1 FROM quixi_search_heads h WHERE h.epoch=(SELECT active_epoch FROM quixi_search_meta) AND h.source_key=? AND ${this.visibleHead()})`,
        [`e:${ref.pageAttemptId}`],
      ) === 1
    );
  }
  /** Foreground extraction credit admits at most four shared chunk writes. */
  advanceExtractionIndex(signal?: AbortSignal): Promise<void> {
    // The caller needs exact page credit, not a full-archive status summary.
    // Visibility predicates fence stale heads until ordinary maintenance cleans
    // them up; global sweeps here make sequential page publication quadratic.
    return this.advanceSlice({ maxChunks: 4 }, signal, true);
  }
  private dirty(scope: string, id: string) {
    this.exec("UPDATE quixi_search_meta SET revision=revision+1");
    const meta = this.meta(),
      revision = Number(meta.revision);
    this.exec(
      "INSERT INTO quixi_search_scopes VALUES(?,?,?) ON CONFLICT(scope,id) DO UPDATE SET revision=excluded.revision",
      [scope, id, revision],
    );
    for (const epoch of [meta.active_epoch, meta.rebuilding_epoch])
      if (epoch !== null)
        this.exec(
          "INSERT INTO quixi_search_queue(epoch,scope,id,revision,after_id,failed) VALUES(?,?,?,?,'',0) ON CONFLICT(epoch,scope,id) DO UPDATE SET revision=excluded.revision,after_id='',failed=0",
          [Number(epoch), scope, id, revision],
        );
  }
  private expand(queue: Record<string, SqlValue>): void {
    const scope = String(queue.scope),
      id = String(queue.id),
      after = String(queue.after_id);
    let sql: string, bind: SqlValue[];
    if (scope === "message") {
      sql =
        "SELECT 'p:'||id AS key FROM quixi_records WHERE collection='parts' AND message_id=? UNION ALL SELECT 'f:'||id FROM quixi_records WHERE collection='parts' AND message_id=? AND json_extract(payload,'$.kind')='Image'";
      bind = [id, id];
    } else if (scope === "thread") {
      sql =
        "SELECT 'p:'||p.id AS key FROM quixi_records p JOIN quixi_records m ON m.collection='messages' AND m.id=p.message_id WHERE p.collection='parts' AND m.thread_id=? UNION ALL SELECT 'f:'||p.id FROM quixi_records p JOIN quixi_records m ON m.collection='messages' AND m.id=p.message_id WHERE p.collection='parts' AND m.thread_id=? AND json_extract(p.payload,'$.kind')='Image'";
      bind = [id, id];
    } else if (scope === "document") {
      sql =
        "SELECT 'd:'||id AS key FROM quixi_records WHERE collection='documents' AND id=? UNION ALL SELECT 'x:'||id FROM quixi_search_extractions WHERE document_id=?";
      bind = [id, id];
    } else {
      sql =
        "SELECT 'p:'||id AS key FROM quixi_records WHERE collection='parts' UNION ALL SELECT 'f:'||id FROM quixi_records WHERE collection='parts' AND json_extract(payload,'$.kind')='Image' UNION ALL SELECT 'd:'||id FROM quixi_records WHERE collection='documents' UNION ALL SELECT 'x:'||id FROM quixi_search_extractions";
      bind = [];
    }
    let entries = this.rows(
      `SELECT key FROM (${sql}) WHERE key>? ORDER BY key LIMIT 32`,
      [...bind, after],
    );
    if (
      (scope === "document" || scope === "global") &&
      this.extractionReady() &&
      after < "f:"
    ) {
      try {
        const pages = this.options.publishedSources!.listVisiblePages(
          scope === "document" ? id : null,
          after.startsWith("e:") ? after.slice(2) : null,
          32,
        );
        entries = [
          ...entries,
          ...pages.map((page) => ({ key: `e:${page.pageAttemptId}` })),
        ]
          .filter((entry) => String(entry.key) > after)
          .sort((a, b) => String(a.key).localeCompare(String(b.key)))
          .slice(0, 32);
      } catch {
        this.extractionUnavailable = true;
      }
    }
    this.tx(() => {
      for (const entry of entries)
        this.exec(
          "INSERT INTO quixi_search_queue(epoch,scope,id,revision,failed) VALUES(?,'source',?,?,0) ON CONFLICT(epoch,scope,id) DO UPDATE SET revision=excluded.revision,failed=0",
          [Number(queue.epoch), String(entry.key), Number(queue.revision)],
        );
      if (entries.length < 32)
        this.exec(
          "DELETE FROM quixi_search_queue WHERE epoch=? AND scope=? AND id=?",
          [Number(queue.epoch), scope, id],
        );
      else
        this.exec(
          "UPDATE quixi_search_queue SET after_id=? WHERE epoch=? AND scope=? AND id=?",
          [String(entries.at(-1)!.key), Number(queue.epoch), scope, id],
        );
    });
  }
  private acceptVerification(work: Work, result: { transferId: string; byteLength: number; verifiedBytes: number; complete: boolean }) {
    const size = work.source.blob?.byteLength;
    if (result.transferId !== work.reader || result.byteLength !== size ||
        !Number.isSafeInteger(result.verifiedBytes) || result.verifiedBytes < work.verifiedBytes ||
        result.verifiedBytes > size || result.verifiedBytes < 0 ||
        result.complete && result.verifiedBytes !== size)
      throw new SearchError("IO_ERROR", "Indexed source verification does not match its canonical reference.");
    work.verifiedBytes = result.verifiedBytes;
    work.phase = result.complete ? "chunking" : "verifying";
  }
  private async release(work: Work) {
    try {
      if (work.reader) await this.blobs.discard(work.reader).catch(() => {});
    } finally {
      work.reader = null;
      try {
        work.iterator?.return(undefined);
      } finally {
        work.iterator = null;
        if (this.active === work) this.active = null;
      }
    }
    this.exec(
      "DELETE FROM quixi_search_builds WHERE epoch=? AND source_key=? AND run_id=?",
      [work.epoch, work.key, work.runId],
    );
  }
  private publish(work: Work) {
    if (!this.current(work)) return false;
    const source = work.source;
    this.tx(() => {
      if (!this.current(work))
        throw new SearchError(
          "CONFLICT",
          "Extracted source changed before publication.",
        );
      const ref = source.extractionRef;
      if (ref)
        this.exec(
          `INSERT INTO quixi_search_page_refs VALUES(${Array(13).fill("?").join(",")}) ON CONFLICT(epoch,source_key) DO UPDATE SET run_id=excluded.run_id,page_id=excluded.page_id,extraction_run_id=excluded.extraction_run_id,page=excluded.page,document_id=excluded.document_id,attachment_id=excluded.attachment_id,attachment_sha256=excluded.attachment_sha256,attachment_bytes=excluded.attachment_bytes,source_digest=excluded.source_digest,publication_revision=excluded.publication_revision,identity=excluded.identity`,
          [
            work.epoch,
            work.key,
            work.runId,
            ref.pageAttemptId,
            ref.runId,
            ref.page,
            ref.identity.documentId,
            ref.identity.attachmentId,
            ref.identity.attachmentSha256,
            ref.identity.attachmentByteLength,
            ref.sourceDigest,
            ref.publicationRevision,
            canonicalJson({ ...ref.identity }),
          ],
        );
      this.exec(
        `INSERT INTO quixi_search_heads VALUES(${Array(22).fill("?").join(",")}) ON CONFLICT(epoch,source_key) DO UPDATE SET run_id=excluded.run_id,source_type=excluded.source_type,source_id=excluded.source_id,part_id=excluded.part_id,thread_id=excluded.thread_id,message_id=excluded.message_id,document_id=excluded.document_id,title=excluded.title,role=excluded.role,provider=excluded.provider,model=excluded.model,date=excluded.date,tags=excluded.tags,media_type=excluded.media_type,origin=excluded.origin,source_revision=excluded.source_revision,message_revision=excluded.message_revision,thread_revision=excluded.thread_revision,document_revision=excluded.document_revision,global_revision=excluded.global_revision`,
        [
          work.epoch,
          work.key,
          work.runId,
          source.chunk.sourceType,
          source.chunk.sourceId,
          source.chunk.partId,
          source.threadId,
          source.messageId,
          source.documentId,
          source.title,
          source.role,
          source.provider,
          source.model,
          source.date,
          JSON.stringify(source.tags),
          source.mediaType,
          source.origin,
          ...work.signature,
        ],
      );
      this.exec(
        "DELETE FROM quixi_search_queue WHERE epoch=? AND scope='source' AND id=?",
        [work.epoch, work.key],
      );
      this.exec("UPDATE quixi_search_meta SET revision=revision+1");
    });
    return true;
  }
  private obsolete(): boolean {
    if (
      this.scalar(
        `SELECT EXISTS(SELECT 1 FROM quixi_search_page_refs er LEFT JOIN quixi_search_heads h ON h.epoch=er.epoch AND h.source_key=er.source_key AND h.run_id=er.run_id WHERE h.source_key IS NULL OR NOT (${this.visibleHead()}))`,
      )
    )
      return true;
    return (
      this.scalar(
        `SELECT EXISTS(SELECT 1 FROM quixi_search_chunks c WHERE NOT EXISTS(SELECT 1 FROM quixi_search_builds b WHERE b.epoch=c.epoch AND b.source_key=c.source_key AND b.run_id=c.run_id) AND (c.epoch NOT IN(SELECT active_epoch FROM quixi_search_meta UNION SELECT rebuilding_epoch FROM quixi_search_meta WHERE rebuilding_epoch IS NOT NULL) OR NOT EXISTS(SELECT 1 FROM quixi_search_heads h WHERE h.epoch=c.epoch AND h.source_key=c.source_key AND h.run_id=c.run_id))) OR EXISTS(SELECT 1 FROM quixi_search_heads WHERE epoch NOT IN(SELECT active_epoch FROM quixi_search_meta UNION SELECT rebuilding_epoch FROM quixi_search_meta WHERE rebuilding_epoch IS NOT NULL)) OR EXISTS(SELECT 1 FROM quixi_search_queue WHERE epoch NOT IN(SELECT active_epoch FROM quixi_search_meta UNION SELECT rebuilding_epoch FROM quixi_search_meta WHERE rebuilding_epoch IS NOT NULL))`,
      ) === 1
    );
  }
  private cleanup(max: number): void {
    this.tx(() => {
      this.exec(
        `DELETE FROM quixi_search_heads WHERE rowid IN(SELECT h.rowid FROM quixi_search_page_refs er JOIN quixi_search_heads h ON h.epoch=er.epoch AND h.source_key=er.source_key AND h.run_id=er.run_id WHERE NOT (${this.visibleHead()}) LIMIT ?)`,
        [max],
      );
      this.exec(
        `DELETE FROM quixi_search_chunks WHERE rowid IN(SELECT c.rowid FROM quixi_search_chunks c WHERE NOT EXISTS(SELECT 1 FROM quixi_search_builds b WHERE b.epoch=c.epoch AND b.source_key=c.source_key AND b.run_id=c.run_id) AND (c.epoch NOT IN(SELECT active_epoch FROM quixi_search_meta UNION SELECT rebuilding_epoch FROM quixi_search_meta WHERE rebuilding_epoch IS NOT NULL) OR NOT EXISTS(SELECT 1 FROM quixi_search_heads h WHERE h.epoch=c.epoch AND h.source_key=c.source_key AND h.run_id=c.run_id)) LIMIT ?)`,
        [max],
      );
      this.exec(
        "DELETE FROM quixi_search_heads WHERE rowid IN(SELECT rowid FROM quixi_search_heads WHERE epoch NOT IN(SELECT active_epoch FROM quixi_search_meta UNION SELECT rebuilding_epoch FROM quixi_search_meta WHERE rebuilding_epoch IS NOT NULL) LIMIT ?)",
        [max],
      );
      this.exec(
        "DELETE FROM quixi_search_page_refs WHERE rowid IN(SELECT er.rowid FROM quixi_search_page_refs er WHERE NOT EXISTS(SELECT 1 FROM quixi_search_heads h WHERE h.epoch=er.epoch AND h.source_key=er.source_key AND h.run_id=er.run_id) LIMIT ?)",
        [max],
      );
      this.exec(
        "DELETE FROM quixi_search_queue WHERE rowid IN(SELECT rowid FROM quixi_search_queue WHERE epoch NOT IN(SELECT active_epoch FROM quixi_search_meta UNION SELECT rebuilding_epoch FROM quixi_search_meta WHERE rebuilding_epoch IS NOT NULL) LIMIT ?)",
        [max],
      );
      this.exec("UPDATE quixi_search_meta SET revision=revision+1");
    });
  }
  /** maxChunks bounds writes. Initial verification and later byte work share a
   * 128 KiB admission budget; a held verifier survives between owner turns. */
  async advance(
    args: SearchOperations["advanceSearchIndex"]["args"],
    signal?: AbortSignal,
  ): Promise<SearchIndexStatus> {
    await this.advanceSlice(args, signal, false);
    return this.status();
  }
  private async advanceSlice(
    args: SearchOperations["advanceSearchIndex"]["args"],
    signal: AbortSignal | undefined,
    pageCredit: boolean,
  ): Promise<void> {
    this.check();
    assertSearchArgs("advanceSearchIndex", args);
    if (this.busy)
      throw new SearchError(
        "CONFLICT",
        "An indexing slice is already running.",
      );
    this.busy = true;
    let writes = 0,
      bytes = 0,
      steps = 0;
    // A document page is immutable during the synchronous part of this owned
    // worker slice. Reuse its full source check only until an await or the end
    // of this admission; publication still checks again inside its transaction.
    let checkedPage: Work | null = null;
    const current = (work: Work) => {
      if (pageCredit && work.source.extractionRef && checkedPage === work) return true;
      const valid = this.current(work);
      if (valid && pageCredit && work.source.extractionRef) checkedPage = work;
      return valid;
    };
    const release = async (work: Work) => {
      checkedPage = null;
      await this.release(work);
    };
    try {
      // A write/ACK failure is a retryable transaction outcome, not evidence
      // that extraction schema is corrupt. Preserve it for the owner caller.
      this.drainExtractionPublications();
      while (writes < args.maxChunks && bytes < 131072 && steps++ < 64) {
        if (signal?.aborted) {
          if (this.active) await release(this.active);
          break;
        }
        let work = this.active;
        if (work && !current(work)) {
          await release(work);
          continue;
        }
        if (!work) {
          if (!pageCredit && this.obsolete()) {
            this.cleanup(args.maxChunks - writes);
            break;
          }
          const queue = this.rows(
            "SELECT * FROM quixi_search_queue WHERE failed=0 ORDER BY CASE scope WHEN 'source' THEN 0 ELSE 1 END,epoch,scope,id LIMIT 1",
          )[0];
          if (!queue) {
            const meta = this.meta();
            if (
              meta.rebuilding_epoch !== null &&
              !this.scalar(
                "SELECT count(*) FROM quixi_search_queue WHERE epoch=?",
                [Number(meta.rebuilding_epoch)],
              )
            ) {
              this.tx(() =>
                this.exec(
                  "UPDATE quixi_search_meta SET active_epoch=rebuilding_epoch,rebuilding_epoch=NULL,version=?,revision=revision+1",
                  [this.version],
                ),
              );
            }
            if (!pageCredit && this.obsolete()) this.cleanup(args.maxChunks - writes);
            break;
          }
          if (queue.scope !== "source") {
            this.expand(queue);
            continue;
          }
          const key = String(queue.id),
            epoch = Number(queue.epoch);
          if (
            this.scalar(
              `SELECT EXISTS(SELECT 1 FROM quixi_search_heads h WHERE h.epoch=? AND h.source_key=? AND ${this.visibleHead()})`,
              [epoch, key],
            )
          ) {
            this.exec(
              "DELETE FROM quixi_search_queue WHERE epoch=? AND scope='source' AND id=?",
              [epoch, key],
            );
            continue;
          }
          try {
            const source =
              key.startsWith("e:") && !this.extractionReady()
                ? null
                : loadSource(this.db, key, this.options.publishedSources);
            if (!source) {
              this.tx(() => {
                this.exec(
                  "DELETE FROM quixi_search_heads WHERE epoch=? AND source_key=?",
                  [epoch, key],
                );
                this.exec(
                  "DELETE FROM quixi_search_queue WHERE epoch=? AND scope='source' AND id=?",
                  [epoch, key],
                );
                this.exec("UPDATE quixi_search_meta SET revision=revision+1");
              });
              continue;
            }
            work = {
              epoch,
              key,
              runId: this.nextId(),
              source,
              signature: this.signature(source),
              chunker: new StructuralChunker(source.chunk, this.policy),
              classifier: new CodeChunkClassifier(),
              iterator: null,
              reader: null,
              offset: 0,
              readBytes: 0,
              verifiedBytes: 0,
              decoder: new TextDecoder("utf-8", { fatal: true }),
              inputEnded: false,
              phase: source.blob ? "verifying" : "chunking",
            };
            this.active = work;
            this.exec(
              "INSERT INTO quixi_search_builds VALUES(?,?,?) ON CONFLICT(epoch,source_key) DO UPDATE SET run_id=excluded.run_id",
              [epoch, key, work.runId],
            );
            if (!pageCredit) this.progress();
            if (source.blob) {
              checkedPage = null;
              const reader = await this.blobs.beginVerifiedRead(
                source.blob.sha256,
                this.nextId,
                signal,
              );
              work.reader = reader.transferId;
              this.acceptVerification(work, reader);
              if (!pageCredit) this.progress();
            }
          } catch (error) {
            if (this.active) await release(this.active);
            if (
              signal?.aborted ||
              ["OVERLOADED", "CANCELLED"].includes(
                (error as { code?: string }).code ?? "",
              )
            )
              break;
            if (key.startsWith("e:") && this.extractionReady()) {
              const ref = this.rows(
                "SELECT r.document_id FROM quixi_extract_pages p JOIN quixi_extract_runs r ON r.id=p.run_id WHERE p.id=?",
                [key.slice(2)],
              )[0];
              if (ref) this.quarantineExtraction(String(ref.document_id));
            }
            this.exec(
              "UPDATE quixi_search_queue SET failed=1,error=? WHERE epoch=? AND scope='source' AND id=?",
              [
                `${(error as { code?: string }).code ?? "IO_ERROR"}: ${(error as Error).message ?? "Source verification failed"}`.slice(
                  0,
                  1024,
                ),
                epoch,
                key,
              ],
            );
            continue;
          }
        }
        if (!work || !current(work)) continue;
        try {
          if (work.phase === "verifying") {
            checkedPage = null;
            const allowance = 131072 - bytes;
            const verification = await this.blobs.advanceVerifiedRead(work.reader!, allowance, signal);
            // Charge the full admitted allowance even if a foreground reader
            // completed this shared hash between turns. Progress can then jump
            // without charging that foreground work to this maintenance turn.
            bytes += allowance;
            this.acceptVerification(work, verification);
            if (signal?.aborted || !current(work)) await release(work);
            continue;
          }
          if (work.iterator) {
            const next = work.iterator.next();
            if (!next.done) {
              const chunk = work.classifier.classify(next.value);
              this.tx(() => {
                this.exec(
                  "INSERT INTO quixi_search_chunks(epoch,source_key,run_id,chunk_id,source_type,has_code,text,context,position,payload) VALUES(?,?,?,?,?,?,?,?,?,?)",
                  [
                    work!.epoch,
                    work!.key,
                    work!.runId,
                    chunk.id,
                    chunk.sourceType,
                    work!.classifier.codePresent ? 1 : 0,
                    chunk.text.replaceAll("\0", " "),
                    chunk.contextPrefix.replaceAll("\0", " "),
                    JSON.stringify(chunk.position),
                    JSON.stringify(chunk),
                  ],
                );
                this.exec("UPDATE quixi_search_meta SET revision=revision+1");
              });
              writes++;
              continue;
            }
            work.iterator = null;
          }
          if (work.inputEnded) {
            this.publish(work);
            await release(work);
            continue;
          }
          const total =
            work.source.blob?.byteLength ?? work.source.text!.length;
          if (work.offset >= total) {
            const tail = work.source.blob ? work.decoder.decode() : "";
            work.iterator = (function* (chunker: StructuralChunker) {
              if (tail) yield* chunker.push(tail);
              yield* chunker.finish();
            })(work.chunker);
            work.inputEnded = true;
            continue;
          }
          if (work.source.blob) {
            const length = Math.min(65536, total - work.offset, 131072 - bytes),
              child = this.blobs.sliceRead(work.reader!, this.nextId, {
                offset: work.offset,
                byteLength: length,
              });
            try {
              const chunk = this.blobs.readChunk(child.transferId);
              if (chunk.bytes.length !== length || !chunk.final)
                throw new SearchError(
                  "IO_ERROR",
                  "Indexed byte range violated its bound.",
                );
              const fragment = work.decoder.decode(chunk.bytes, {
                stream: true,
              });
              this.blobs.acknowledge({
                transferId: chunk.transferId,
                sequence: chunk.sequence,
                committedOffset: chunk.offset + chunk.bytes.length,
              });
              work.offset += length;
              work.readBytes += length;
              bytes += length;
              work.iterator = work.chunker.push(fragment);
            } finally {
              checkedPage = null;
              await this.blobs.discard(child.transferId).catch(() => {});
            }
          } else {
            const allowance = Math.min(16384, Math.floor((131072 - bytes) / 3));
            if (allowance < 1) break;
            const fragment = work.source.text!.slice(
              work.offset,
              work.offset + allowance,
            );
            work.offset += fragment.length;
            const encodedLength = new TextEncoder().encode(fragment).length;
            bytes += encodedLength;
            work.readBytes += encodedLength;
            work.iterator = work.chunker.push(fragment);
          }
        } catch (error) {
          if (
            signal?.aborted ||
            (error as { code?: string }).code === "CANCELLED"
          ) {
            await release(work);
            break;
          }
          if ((error as { code?: string }).code === "OVERLOADED") break;
          if (work.phase === "verifying" && work.source.extractionRef && work.source.documentId)
            this.quarantineExtraction(work.source.documentId);
          this.exec(
            "UPDATE quixi_search_queue SET failed=1,error=? WHERE epoch=? AND scope='source' AND id=?",
            [
              `${(error as { code?: string }).code ?? "IO_ERROR"}: ${(error as Error).message}`.slice(
                0,
                1024,
              ),
              work.epoch,
              work.key,
            ],
          );
          await release(work);
        }
      }
      if (!pageCredit) this.progress();
    } finally {
      this.busy = false;
    }
  }
  resolveConversationHit(
    args: SearchOperations["resolveConversationSearchHit"]["args"],
  ): SearchOperations["resolveConversationSearchHit"]["result"] {
    this.check();
    try { assertSearchArgs("resolveConversationSearchHit", args); }
    catch { throw new SearchError("INVALID_REQUEST", "Invalid exact conversation search identity."); }
    // Conversation sources have no dependency on optional extraction tables.
    return resolveConversationHitSource(this.db, args, VISIBLE_HEAD);
  }
  resolveDocumentHit(
    args: SearchOperations["resolveDocumentSearchHit"]["args"],
  ): SearchOperations["resolveDocumentSearchHit"]["result"] {
    this.check();
    try {
      assertSearchArgs("resolveDocumentSearchHit", args);
    } catch {
      throw new SearchError(
        "INVALID_REQUEST",
        "Invalid exact document search identity.",
      );
    }
    return resolveDocumentHitSource(
      this.db,
      args,
      this.visibleHead(),
      this.extractionReady() ? this.options.publishedSources : undefined,
    );
  }
  /** Visible active-epoch chunks (`c`) with their heads (`h`). */
  private visibleChunks(): VisibleChunkSql {
    return {
      from: "FROM quixi_search_chunks c JOIN quixi_search_heads h ON h.epoch=c.epoch AND h.source_key=c.source_key AND h.run_id=c.run_id",
      where: `h.epoch=? AND ${this.visibleHead()}`,
      bind: [Number(this.meta().active_epoch)],
    };
  }
  private semanticAvailability(): SearchIndexStatus["semantic"] {
    if (this.semantic.failure) return { state: "unavailable", reason: `The semantic index is unusable: ${this.semantic.failure}` };
    if (!this.semantic.model()) return { state: "unavailable", reason: "Semantic search is not enabled for this archive. Enable it under Semantic search to index meaning locally." };
    return { state: "ready", reason: null };
  }
  semanticStatus(): SemanticIndexStatus {
    this.check();
    return this.semantic.status(this.visibleChunks());
  }
  enrollSemantic(args: SearchOperations["enrollSemantic"]["args"]): SemanticIndexStatus {
    this.check();
    const status = this.semantic.enroll(args, this.visibleChunks());
    this.progress();
    return status;
  }
  setSemanticState(args: SearchOperations["setSemanticState"]["args"]): SemanticIndexStatus {
    this.check();
    const status = this.semantic.setState(args, this.visibleChunks());
    this.progress();
    return status;
  }
  claimSemanticChunks(args: SearchOperations["claimSemanticChunks"]["args"]): SemanticClaim {
    this.check();
    const inspect = this.options.chunkTokenizer?.inspect ?? null;
    return this.semantic.claim(args, this.visibleChunks(), inspect);
  }
  publishSemanticVectors(args: SearchOperations["publishSemanticVectors"]["args"]): SemanticPublication {
    this.check();
    const publication = this.semantic.publish(args, this.visibleChunks());
    if (publication.accepted) this.progress();
    return publication;
  }
  deleteSemanticIndex(args: SearchOperations["deleteSemanticIndex"]["args"]): SemanticIndexStatus {
    this.check();
    const status = this.semantic.remove(args, this.visibleChunks());
    this.progress();
    return status;
  }
  /** Orphaned links/vectors after source edits or lexical rebuilds. */
  maintainSemantic(max = 64): { remaining: boolean; progressed: boolean } {
    try {
      return this.semantic.maintain(max);
    } catch {
      return { remaining: false, progressed: false };
    }
  }
  private filterClauses(f: SearchOperations["searchArchive"]["args"]["filters"]): { where: string[]; bind: SqlValue[] } {
    const where: string[] = [], bind: SqlValue[] = [];
    const many = (column: string, values: readonly string[] | undefined) => {
      if (values) {
        where.push(`${column} IN(${values.map(() => "?").join(",")})`);
        bind.push(...values);
      }
    };
    many("c.source_type", f.sourceTypes);
    many("h.provider", f.providers);
    many("h.model", f.models);
    many("h.thread_id", f.threadIds);
    many("h.document_id", f.documentIds);
    many("h.media_type", f.mediaTypes);
    if (f.after !== undefined) { where.push("h.date>=?"); bind.push(f.after); }
    if (f.before !== undefined) { where.push("h.date<=?"); bind.push(f.before); }
    if (f.origin) { where.push("h.origin=?"); bind.push(f.origin); }
    if (f.hasCode !== undefined) { where.push("c.has_code=?"); bind.push(f.hasCode ? 1 : 0); }
    for (const tag of f.tags ?? []) { where.push("EXISTS(SELECT 1 FROM json_each(h.tags) WHERE value=?)"); bind.push(tag); }
    return { where, bind };
  }
  private hitFromRow(row: Record<string, SqlValue>, explanation: SearchHit["explanation"], score: number, marked: string | null, open: string, close: string): SearchHit {
    const text = JSON.parse(String(row.text)) as string;
    return {
      chunkId: String(row.chunk_id),
      sourceType: row.source_type as SearchHit["sourceType"],
      sourceId: String(row.source_id),
      position: JSON.parse(String(row.position)),
      threadId: row.thread_id === null ? null : String(row.thread_id),
      messageId: row.message_id === null ? null : String(row.message_id),
      documentId: row.document_id === null ? null : String(row.document_id),
      title: JSON.parse(String(row.title)),
      role: row.role === null ? null : String(row.role),
      provider: row.provider === null ? null : String(row.provider),
      model: row.model === null ? null : String(row.model),
      date: row.date === null ? null : Number(row.date),
      score,
      explanation,
      excerpt: searchExcerpt(text, marked ?? text.replaceAll("\0", " "), open, close),
    };
  }
  private static readonly HIT_COLUMNS = "c.rowid,c.chunk_id,c.source_type,json_quote(json_extract(c.payload,'$.text')) AS text,c.position,h.source_id,h.thread_id,h.message_id,h.document_id,json_quote(h.title) AS title,h.role,h.provider,h.model,h.date";
  /** Ranked lists are bounded (product §43): the top 256 lexical hits and a
   * bounded vector candidate set, fused by reciprocal rank with k=60. */
  static readonly LEXICAL_CANDIDATES = 256;
  static readonly SEMANTIC_CANDIDATES = 256;
  static readonly SEMANTIC_FILTERED_CANDIDATES = 1024;
  search(args: SearchOperations["searchArchive"]["args"]): SearchPage {
    this.check();
    assertSearchArgs("searchArchive", args);
    assertPageBudget(args.page);
    if (args.page.maxBytes < 2)
      throw new SearchError(
        "OVERLOADED",
        "Search page byte budget must hold an empty result array.",
      );
    if (args.filters.portability)
      throw new SearchError(
        "UNSUPPORTED",
        "Portability filtering requires the plan10 compatibility analysis.",
      );
    if (args.filters.sourceTypes?.includes("ocr"))
      throw new SearchError(
        "UNSUPPORTED",
        "OCR sources require plan15 extraction; this index contains no OCR implementation.",
      );
    const index = this.status();
    if (args.mode === "semantic") {
      if (index.semantic.state !== "ready")
        throw new SearchError("UNSUPPORTED", index.semantic.reason ?? "Semantic search is unavailable.");
      if (!args.queryVector)
        throw new SearchError("INVALID_REQUEST", "Semantic search needs the query embedded by the local embedding worker.");
    }
    const useVector = args.mode !== "exact" && index.semantic.state === "ready" && !!args.queryVector;
    const query = lexicalQuery(args.query),
      scope = searchDigest([
        args.query,
        args.mode,
        args.filters,
        useVector ? searchDigest(args.queryVector) : null,
        useVector ? this.semantic.revision() : null,
        // Selection publication changes visible page heads before outbox drain.
        // Bind cursors to that independent revision as well as search writes.
        this.extractionReady()
          ? this.scalar(
              "SELECT revision FROM quixi_extract_meta WHERE singleton=1",
            )
          : null,
      ]);
    const marker = this.nextId(),
      open = `<quixi-${marker}>`,
      close = `</quixi-${marker}>`;
    const filters = this.filterClauses(args.filters);
    const lexicalSql = (limit: string) => {
      const where = ["quixi_search_fts MATCH ?", "h.epoch=?", this.visibleHead(), ...filters.where];
      return {
        sql: `SELECT ${SearchRepository.HIT_COLUMNS},bm25(quixi_search_fts,1.0,2.0) AS score,json_quote(highlight(quixi_search_fts,0,?,?)) AS marked FROM quixi_search_fts JOIN quixi_search_chunks c ON c.rowid=quixi_search_fts.rowid JOIN quixi_search_heads h ON h.epoch=c.epoch AND h.source_key=c.source_key AND h.run_id=c.run_id WHERE ${where.join(" AND ")}${limit}`,
        bind: [open, close, query, index.activeEpoch, ...filters.bind] as SqlValue[],
      };
    };
    if (!useVector) {
      // Exact and lexical-only Best: bounded FTS pages ordered by BM25, then rowid.
      let cursor: { epoch: number; revision: number; scope: string; score: number; row: number } | null = null;
      if (args.page.cursor) {
        try {
          if (args.page.cursor.length > 1024) throw 0;
          cursor = JSON.parse(args.page.cursor);
          if (!cursor || cursor.epoch !== index.activeEpoch || cursor.revision !== index.revision || cursor.scope !== scope || !Number.isFinite(cursor.score) || !Number.isSafeInteger(cursor.row) || cursor.row < 1) throw 0;
        } catch {
          throw new SearchError("CONFLICT", "Search results changed or the cursor does not describe this query; restart pagination.");
        }
      }
      const modeUsed = args.mode === "best" ? "best_lexical" : args.mode === "semantic" ? "semantic" : "exact";
      if (!query) return { items: [], nextCursor: null, bytes: 2, modeUsed, index };
      const lexical = lexicalSql("");
      const values = this.rows(
        `SELECT * FROM (${lexical.sql}) ${cursor ? "WHERE score>? OR (score=? AND rowid>?)" : ""} ORDER BY score,rowid LIMIT ?`,
        [...lexical.bind, ...(cursor ? [cursor.score, cursor.score, cursor.row] : []), Math.min(args.page.maxItems + 1, 65)],
      );
      const items: SearchHit[] = [];
      let nextCursor: string | null = null;
      let last: Record<string, SqlValue> | undefined;
      const cursorFor = (row: Record<string, SqlValue>) => JSON.stringify({ epoch: index.activeEpoch, revision: index.revision, scope, score: Number(row.score), row: Number(row.rowid) });
      for (const row of values) {
        const hit = this.hitFromRow(row, "Exact text match", -Number(row.score), JSON.parse(String(row.marked)), open, close);
        if (items.length >= args.page.maxItems || items.length >= 64 || jsonByteLength([...items, hit]) > args.page.maxBytes) {
          if (!items.length) throw new SearchError("OVERLOADED", "The page byte budget cannot hold one search result; increase maxBytes.");
          nextCursor = cursorFor(last!);
          break;
        }
        items.push(hit);
        last = row;
      }
      if (!nextCursor && values.length === 65 && last) nextCursor = cursorFor(last);
      return { items, nextCursor, bytes: jsonByteLength(items), modeUsed, index };
    }
    // Hybrid Best and Semantic: both bounded rankings are recomputed for each
    // page and the cursor is an offset into the deterministic fused list.
    let offset = 0;
    if (args.page.cursor) {
      try {
        if (args.page.cursor.length > 1024) throw 0;
        const cursor = JSON.parse(args.page.cursor) as { epoch: number; revision: number; scope: string; offset: number };
        if (!cursor || cursor.epoch !== index.activeEpoch || cursor.revision !== index.revision || cursor.scope !== scope || !Number.isSafeInteger(cursor.offset) || cursor.offset < 1) throw 0;
        offset = cursor.offset;
      } catch {
        throw new SearchError("CONFLICT", "Search results changed or the cursor does not describe this query; restart pagination.");
      }
    }
    const loaded = new Map<number, { row: Record<string, SqlValue>; marked: string | null }>();
    const lexicalRanked: { id: string; item: number }[] = [];
    if (args.mode === "best" && query) {
      const lexical = lexicalSql(" ORDER BY score,rowid LIMIT ?");
      for (const row of this.rows(lexical.sql, [...lexical.bind, SearchRepository.LEXICAL_CANDIDATES])) {
        loaded.set(Number(row.rowid), { row, marked: JSON.parse(String(row.marked)) });
        lexicalRanked.push({ id: String(row.rowid), item: Number(row.rowid) });
      }
    }
    const k = filters.where.length ? SearchRepository.SEMANTIC_FILTERED_CANDIDATES : SearchRepository.SEMANTIC_CANDIDATES;
    const semanticRanked = this.semantic.candidates(args.queryVector!, k, this.visibleChunks(), filters.where, filters.bind).map((row) => ({ id: String(row.rowid), item: row.rowid }));
    const fused = args.mode === "semantic"
      ? semanticRanked.map((entry, rank) => ({ id: entry.id, item: entry.item, score: 1 / (60 + rank + 1), explanation: "Semantic match" as const }))
      : fuseRanked(lexicalRanked, semanticRanked).map((entry) => ({ id: entry.id, item: entry.item, score: entry.score, explanation: entry.explanation }));
    const missing = fused.slice(offset, offset + 65).map((entry) => entry.item).filter((rowid) => !loaded.has(rowid));
    if (missing.length) {
      const visible = this.visibleChunks();
      for (const row of this.rows(`SELECT ${SearchRepository.HIT_COLUMNS} ${visible.from} WHERE c.rowid IN(${missing.map(() => "?").join(",")})`, missing))
        loaded.set(Number(row.rowid), { row, marked: null });
    }
    const items: SearchHit[] = [];
    let nextCursor: string | null = null, at = offset;
    for (; at < fused.length; at++) {
      const entry = fused[at]!, source = loaded.get(entry.item);
      if (!source) continue; // Vanished between the ranking and the hit read.
      const hit = this.hitFromRow(source.row, entry.explanation, entry.score, source.marked, open, close);
      if (items.length >= args.page.maxItems || items.length >= 64 || jsonByteLength([...items, hit]) > args.page.maxBytes) {
        if (!items.length) throw new SearchError("OVERLOADED", "The page byte budget cannot hold one search result; increase maxBytes.");
        nextCursor = JSON.stringify({ epoch: index.activeEpoch, revision: index.revision, scope, offset: at });
        break;
      }
      items.push(hit);
    }
    return { items, nextCursor, bytes: jsonByteLength(items), modeUsed: args.mode === "semantic" ? "semantic" : "hybrid", index };
  }
  async close(): Promise<void> {
    if (this.active) await this.release(this.active);
    this.closed = true;
  }
  /** Stale owner teardown: the enclosing blob store closes handles. Leave
   * transient derived rows for the next permitted owner's normal recovery. */
  abandon(): void {
    try {
      this.active?.iterator?.return(undefined);
    } finally {
      this.active = null;
      this.closed = true;
    }
  }
}
