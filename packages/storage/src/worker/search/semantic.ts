import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { SearchError, searchDigest } from "@quixi/search";
import { assertSearchArgs, SEMANTIC_DIMENSIONS, canonicalJson } from "@quixi/core/contracts";
import type {
  EmbeddingModelIdentity,
  SearchOperations,
  SemanticClaim,
  SemanticIndexStatus,
  SemanticPublication,
} from "@quixi/core/contracts";
import type { JsonValue } from "@quixi/core/model";
import type { CanonicalSqlite, SqlValue } from "../canonical/repository.ts";
import { rows } from "./sources.ts";

/** Product §71–75: derived, rebuildable vectors in the pinned sqlite-vec
 * build. Every vector is keyed by the SHA-256 of its exact UTF-8 embedding
 * input, and a chunk links to at most one vector. Enrolment, deletion and a
 * model change start a new generation; publications from older generations
 * are rejected individually. Nothing here is canonical or exported. */
export const SEMANTIC_SCHEMA = `
CREATE TABLE quixi_semantic_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),state TEXT NOT NULL,model TEXT,generation INTEGER NOT NULL,revision INTEGER NOT NULL) STRICT;
CREATE TABLE quixi_semantic_vectors(id INTEGER PRIMARY KEY,digest TEXT NOT NULL UNIQUE,generation INTEGER NOT NULL) STRICT;
CREATE VIRTUAL TABLE quixi_semantic_vec USING vec0(embedding float[${SEMANTIC_DIMENSIONS}]);
CREATE TABLE quixi_semantic_links(chunk_id TEXT PRIMARY KEY,digest TEXT NOT NULL,vector_id INTEGER,generation INTEGER NOT NULL,claimed_at INTEGER,failure TEXT) STRICT;
CREATE INDEX quixi_semantic_link_vector ON quixi_semantic_links(vector_id);
CREATE INDEX quixi_semantic_link_digest ON quixi_semantic_links(digest);
CREATE TABLE quixi_semantic_operations(id TEXT PRIMARY KEY,generation INTEGER NOT NULL) STRICT;
`;
export const SEMANTIC_SCHEMA_CHECKSUM = searchDigest(SEMANTIC_SCHEMA);
/** Ledger version 2 (ADR 0036): the int8 coarse projection. Existing version-1
 * namespaces upgrade in place; the projection is backfilled by maintenance. */
export const SEMANTIC_PROJECTION_SCHEMA = `
CREATE VIRTUAL TABLE quixi_semantic_int8 USING vec0(embedding int8[${SEMANTIC_DIMENSIONS}]);
CREATE TABLE quixi_semantic_projection(singleton INTEGER PRIMARY KEY CHECK(singleton=1),representation TEXT NOT NULL,scale REAL NOT NULL,generation INTEGER NOT NULL) STRICT;
`;
export const SEMANTIC_PROJECTION_CHECKSUM = searchDigest(SEMANTIC_PROJECTION_SCHEMA);
/** Fixed symmetric int8 scale covering the observed |component| maximum of
 * Arctic XS vectors (0.376–0.382 on the plan 16 corpus at 100k–1M) with margin;
 * a fixed scale keeps quantization incremental and identical across devices. */
export const SEMANTIC_PROJECTION = Object.freeze({ representation: "int8-fixed-symmetric-v1", scale: 0.4 / 127, coarseCandidates: 500 });
/** Below this many vectors the exact float table is scanned directly. */
export const SEMANTIC_COARSE_THRESHOLD = 20_000;
export function quantizeInt8(vector: ArrayLike<number>): Int8Array {
  const out = new Int8Array(SEMANTIC_DIMENSIONS);
  for (let i = 0; i < SEMANTIC_DIMENSIONS; i++) out[i] = Math.max(-127, Math.min(127, Math.round(vector[i]! / SEMANTIC_PROJECTION.scale)));
  return out;
}
/** A claimed chunk whose vector never arrives is offered again after this. */
export const SEMANTIC_CLAIM_LEASE_MS = 5 * 60_000;
export const VECTOR_BYTES = SEMANTIC_DIMENSIONS * 4;
export const SEMANTIC_CONTEXT_SEPARATOR = "\n\n";
export type SemanticInspect = (text: string, role: "query" | "document") => { tokenCount: number; overflow: boolean };
export interface VisibleChunkSql {
  /** FROM/JOIN clause exposing visible active-epoch chunks as `c` and heads as `h`. */
  from: string;
  where: string;
  bind: SqlValue[];
}
export const semanticInputDigest = (input: string) => bytesToHex(sha256(new TextEncoder().encode(input)));
/** Product §48/§49 embedding input: context prefix, blank line, chunk text. */
export function semanticInput(contextPrefix: string, text: string): string {
  return contextPrefix ? `${contextPrefix}${SEMANTIC_CONTEXT_SEPARATOR}${text}` : text;
}
function validVector(vector: readonly number[]): boolean {
  if (vector.length !== SEMANTIC_DIMENSIONS) return false;
  let squared = 0;
  for (const value of vector) {
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    squared += value * value;
  }
  return Math.abs(squared - 1) <= 0.01;
}
export class SemanticRepository {
  private unavailable: string | null = null;
  constructor(private readonly db: CanonicalSqlite, private readonly now: () => number = () => Date.now(), private readonly coarseThreshold: number = SEMANTIC_COARSE_THRESHOLD) {}
  private rows(sql: string, bind: SqlValue[] = []) {
    return rows(this.db, sql, bind);
  }
  private scalar(sql: string, bind: SqlValue[] = []) {
    return Number(bind.length ? this.db.selectValue(sql, bind) : this.db.selectValue(sql));
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
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    }
  }
  /** Why semantic operations are refused, or null when the namespace is usable. */
  get failure(): string | null {
    return this.unavailable;
  }
  private install(): void {
    this.exec("CREATE TABLE quixi_semantic_schema(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL) STRICT");
    this.db.exec(SEMANTIC_SCHEMA);
    this.exec("INSERT INTO quixi_semantic_schema VALUES(1,?)", [SEMANTIC_SCHEMA_CHECKSUM]);
    this.exec("INSERT INTO quixi_semantic_meta VALUES(1,'disabled',NULL,1,0)");
    this.installProjection();
  }
  private installProjection(): void {
    this.db.exec(SEMANTIC_PROJECTION_SCHEMA);
    this.exec("INSERT INTO quixi_semantic_schema VALUES(2,?)", [SEMANTIC_PROJECTION_CHECKSUM]);
    this.exec("INSERT INTO quixi_semantic_projection VALUES(1,?,?,?)", [SEMANTIC_PROJECTION.representation, SEMANTIC_PROJECTION.scale, Number(this.rows("SELECT generation FROM quixi_semantic_meta")[0]?.generation ?? 1)]);
  }
  private validate(): void {
    const ledger = this.rows("SELECT version,checksum FROM quixi_semantic_schema ORDER BY version");
    if (!ledger.length || ledger[0]!.version !== 1 || ledger[0]!.checksum !== SEMANTIC_SCHEMA_CHECKSUM)
      throw new SearchError("MIGRATION_FAILED", "The semantic index schema is from another build; delete and rebuild the semantic index.");
    // A version-1 namespace gains the projection in place; vectors are kept.
    if (ledger.length === 1) this.tx(() => this.installProjection());
    else if (ledger.length !== 2 || ledger[1]!.version !== 2 || ledger[1]!.checksum !== SEMANTIC_PROJECTION_CHECKSUM)
      throw new SearchError("MIGRATION_FAILED", "The semantic projection schema is from another build; delete and rebuild the semantic index.");
    for (const match of `${SEMANTIC_SCHEMA}${SEMANTIC_PROJECTION_SCHEMA}`.matchAll(/CREATE (?:VIRTUAL )?(TABLE|INDEX) (quixi_semantic_\w+)/g))
      if (!this.rows("SELECT 1 FROM sqlite_schema WHERE type=? AND name=?", [match[1]!.toLowerCase(), match[2]!]).length)
        throw new SearchError("MIGRATION_FAILED", `Semantic index object ${match[2]} is missing; delete and rebuild the semantic index.`);
    this.rows("SELECT state,model,generation,revision FROM quixi_semantic_meta WHERE singleton=1 LIMIT 0");
    this.rows("SELECT rowid FROM quixi_semantic_vec LIMIT 0");
    this.rows("SELECT rowid FROM quixi_semantic_int8 LIMIT 0");
    // A projection built under another representation or scale is never
    // mixed with this build's: it is dropped and rebuilt by maintenance.
    const projection = this.rows("SELECT representation,scale FROM quixi_semantic_projection WHERE singleton=1")[0];
    if (!projection || projection.representation !== SEMANTIC_PROJECTION.representation || Number(projection.scale) !== SEMANTIC_PROJECTION.scale)
      this.tx(() => { this.exec("DELETE FROM quixi_semantic_int8"); this.exec("INSERT INTO quixi_semantic_projection VALUES(1,?,?,(SELECT generation FROM quixi_semantic_meta)) ON CONFLICT(singleton) DO UPDATE SET representation=excluded.representation,scale=excluded.scale,generation=excluded.generation", [SEMANTIC_PROJECTION.representation, SEMANTIC_PROJECTION.scale]); });
  }
  /** Never throws: a broken semantic namespace leaves lexical search intact. */
  initialize(): void {
    try {
      if (!this.rows("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='quixi_semantic_schema'").length)
        this.tx(() => this.install());
      this.validate();
      this.unavailable = null;
    } catch (error) {
      this.unavailable = error instanceof Error ? error.message : String(error);
    }
  }
  private check(): void {
    if (this.unavailable) throw new SearchError("MIGRATION_FAILED", this.unavailable);
  }
  private meta() {
    return this.rows("SELECT state,model,generation,revision FROM quixi_semantic_meta WHERE singleton=1")[0]!;
  }
  private dropNamespace(): void {
    const objects = this.rows("SELECT type,name FROM sqlite_schema WHERE type IN('table','index') AND name LIKE 'quixi\\_semantic\\_%' ESCAPE '\\'");
    const drop = (type: string, name: string) => this.exec(`DROP ${type} IF EXISTS "${name.replaceAll('"', '""')}"`);
    // Virtual tables own their shadow tables; drop them before plain tables.
    drop("TABLE", "quixi_semantic_vec");
    drop("TABLE", "quixi_semantic_int8");
    for (const object of objects)
      if (object.type === "table" && !["quixi_semantic_vec", "quixi_semantic_int8"].includes(String(object.name)) && !/^quixi_semantic_(vec|int8)_/.test(String(object.name))) drop("TABLE", String(object.name));
  }
  revision(): number {
    return this.unavailable ? -1 : Number(this.meta().revision);
  }
  model(): EmbeddingModelIdentity | null {
    if (this.unavailable) return null;
    const meta = this.meta();
    return meta.model === null ? null : (JSON.parse(String(meta.model)) as EmbeddingModelIdentity);
  }
  state(): SemanticIndexStatus["state"] {
    return this.unavailable ? "disabled" : (String(this.meta().state) as SemanticIndexStatus["state"]);
  }
  status(visible: VisibleChunkSql): SemanticIndexStatus {
    const emptyProjection = { representation: SEMANTIC_PROJECTION.representation, scale: SEMANTIC_PROJECTION.scale, projected: 0, complete: true, coarseRetrieval: false, threshold: this.coarseThreshold };
    if (this.unavailable) return { state: "disabled", model: null, generation: 0, indexedChunks: 0, pendingChunks: 0, vectors: 0, vectorBytes: 0, projection: emptyProjection };
    const meta = this.meta();
    const model = meta.model === null ? null : (JSON.parse(String(meta.model)) as EmbeddingModelIdentity);
    const indexed = model ? this.scalar(`SELECT count(*) ${visible.from} JOIN quixi_semantic_links l ON l.chunk_id=c.chunk_id WHERE ${visible.where} AND l.vector_id IS NOT NULL`, visible.bind) : 0;
    const pending = model ? this.scalar(`SELECT count(*) ${visible.from} LEFT JOIN quixi_semantic_links l ON l.chunk_id=c.chunk_id WHERE ${visible.where} AND (l.chunk_id IS NULL OR (l.vector_id IS NULL AND l.failure IS NULL))`, visible.bind) : 0;
    const vectors = this.scalar("SELECT count(*) FROM quixi_semantic_vectors");
    const projected = this.scalar("SELECT count(*) FROM quixi_semantic_int8");
    const projection = { ...emptyProjection, projected, complete: projected === vectors, coarseRetrieval: vectors >= this.coarseThreshold && projected === vectors };
    return { state: String(meta.state) as SemanticIndexStatus["state"], model, generation: Number(meta.generation), indexedChunks: indexed, pendingChunks: pending, vectors, vectorBytes: vectors * VECTOR_BYTES, projection };
  }
  enroll(args: SearchOperations["enrollSemantic"]["args"], visible: VisibleChunkSql): SemanticIndexStatus {
    this.check();
    assertSearchArgs("enrollSemantic", args);
    this.tx(() => {
      if (this.rows("SELECT id FROM quixi_semantic_operations WHERE id=?", [args.operationId]).length) return;
      const meta = this.meta();
      const same = meta.model !== null && canonicalJson(JSON.parse(String(meta.model)) as JsonValue) === canonicalJson({ ...args.model } as unknown as JsonValue);
      let generation = Number(meta.generation);
      if (!same) {
        generation += 1;
        this.exec("DELETE FROM quixi_semantic_vec");
        this.exec("DELETE FROM quixi_semantic_int8");
        this.exec("DELETE FROM quixi_semantic_vectors");
        this.exec("DELETE FROM quixi_semantic_links");
        this.exec("UPDATE quixi_semantic_projection SET generation=?", [generation]);
      }
      this.exec("UPDATE quixi_semantic_meta SET state='enrolled',model=?,generation=?,revision=revision+1", [canonicalJson({ ...args.model } as unknown as JsonValue), generation]);
      this.exec("INSERT INTO quixi_semantic_operations VALUES(?,?)", [args.operationId, generation]);
    });
    return this.status(visible);
  }
  setState(args: SearchOperations["setSemanticState"]["args"], visible: VisibleChunkSql): SemanticIndexStatus {
    this.check();
    assertSearchArgs("setSemanticState", args);
    this.tx(() => {
      const meta = this.meta();
      if (meta.model === null) throw new SearchError("CONFLICT", "Enable semantic search before pausing or resuming it.");
      if (meta.state !== args.state) this.exec("UPDATE quixi_semantic_meta SET state=?,revision=revision+1", [args.state]);
    });
    return this.status(visible);
  }
  /** Drops vectors and the enrolment; a damaged namespace is replaced whole.
   * Canonical history and the lexical index are never touched. */
  remove(args: SearchOperations["deleteSemanticIndex"]["args"], visible: VisibleChunkSql): SemanticIndexStatus {
    assertSearchArgs("deleteSemanticIndex", args);
    this.tx(() => {
      if (!this.unavailable) {
        if (this.rows("SELECT id FROM quixi_semantic_operations WHERE id=?", [args.operationId]).length) return;
        const generation = Number(this.meta().generation) + 1;
        this.exec("DELETE FROM quixi_semantic_vec");
        this.exec("DELETE FROM quixi_semantic_int8");
        this.exec("DELETE FROM quixi_semantic_vectors");
        this.exec("DELETE FROM quixi_semantic_links");
        this.exec("UPDATE quixi_semantic_projection SET generation=?", [generation]);
        this.exec("UPDATE quixi_semantic_meta SET state='disabled',model=NULL,generation=?,revision=revision+1", [generation]);
        this.exec("INSERT INTO quixi_semantic_operations VALUES(?,?)", [args.operationId, generation]);
        return;
      }
      this.dropNamespace();
      this.install();
      this.exec("INSERT INTO quixi_semantic_operations VALUES(?,1)", [args.operationId]);
    });
    this.unavailable = null;
    return this.status(visible);
  }
  /** Newest visible chunks without a vector, each with its exact embedding
   * input. Inputs that cannot fit the model with their context prefix are
   * retried without it; an input that still overflows is recorded as failed
   * rather than truncated. Existing vectors for the same input are linked
   * without inference. */
  claim(args: SearchOperations["claimSemanticChunks"]["args"], visible: VisibleChunkSql, inspect: SemanticInspect | null): SemanticClaim {
    this.check();
    assertSearchArgs("claimSemanticChunks", args);
    return this.tx(() => {
      const meta = this.meta();
      const model = meta.model === null ? null : (JSON.parse(String(meta.model)) as EmbeddingModelIdentity);
      const generation = Number(meta.generation);
      if (!model || meta.state !== "enrolled") return { generation, model, items: [], reused: 0 };
      const now = this.now();
      const candidates = this.rows(
        `SELECT c.chunk_id,c.payload ${visible.from} LEFT JOIN quixi_semantic_links l ON l.chunk_id=c.chunk_id WHERE ${visible.where} AND (l.chunk_id IS NULL OR (l.vector_id IS NULL AND l.failure IS NULL AND (l.claimed_at IS NULL OR l.claimed_at<?))) ORDER BY c.rowid DESC LIMIT ?`,
        [...visible.bind, now - SEMANTIC_CLAIM_LEASE_MS, args.maxChunks],
      );
      const items: SemanticClaim["items"] = [];
      let reused = 0, bytes = 0, changed = false;
      for (const row of candidates) {
        const payload = JSON.parse(String(row.payload)) as { text: string; contextPrefix: string };
        const chunkId = String(row.chunk_id);
        let input = semanticInput(payload.contextPrefix, payload.text);
        if (inspect) {
          if (inspect(input, "document").overflow) input = payload.text;
          if (inspect(input, "document").overflow) {
            this.exec("INSERT INTO quixi_semantic_links(chunk_id,digest,vector_id,generation,claimed_at,failure) VALUES(?,?,NULL,?,NULL,'oversized') ON CONFLICT(chunk_id) DO UPDATE SET digest=excluded.digest,generation=excluded.generation,claimed_at=NULL,failure='oversized'", [chunkId, semanticInputDigest(input), generation]);
            changed = true;
            continue;
          }
        }
        const digest = semanticInputDigest(input);
        const existing = this.rows("SELECT id FROM quixi_semantic_vectors WHERE digest=?", [digest])[0];
        if (existing) {
          this.exec("INSERT INTO quixi_semantic_links(chunk_id,digest,vector_id,generation,claimed_at,failure) VALUES(?,?,?,?,NULL,NULL) ON CONFLICT(chunk_id) DO UPDATE SET digest=excluded.digest,vector_id=excluded.vector_id,generation=excluded.generation,claimed_at=NULL,failure=NULL", [chunkId, digest, Number(existing.id), generation]);
          reused++;
          changed = true;
          continue;
        }
        const length = new TextEncoder().encode(input).length;
        if (items.length && bytes + length > args.maxBytes) break;
        bytes += length;
        this.exec("INSERT INTO quixi_semantic_links(chunk_id,digest,vector_id,generation,claimed_at,failure) VALUES(?,?,NULL,?,?,NULL) ON CONFLICT(chunk_id) DO UPDATE SET digest=excluded.digest,vector_id=NULL,generation=excluded.generation,claimed_at=excluded.claimed_at,failure=NULL", [chunkId, digest, generation, now]);
        items.push({ chunkId, textDigest: digest, text: input });
      }
      if (changed) this.exec("UPDATE quixi_semantic_meta SET revision=revision+1");
      return { generation, model, items, reused };
    });
  }
  publish(args: SearchOperations["publishSemanticVectors"]["args"], visible: VisibleChunkSql): SemanticPublication {
    this.check();
    assertSearchArgs("publishSemanticVectors", args);
    const rejected: SemanticPublication["rejected"] = [];
    let accepted = 0;
    this.tx(() => {
      const meta = this.meta();
      const generation = Number(meta.generation);
      const seen = new Set<string>();
      for (const item of args.items) {
        const reject = (reason: SemanticPublication["rejected"][number]["reason"]) => rejected.push({ chunkId: item.chunkId, reason });
        if (args.generation !== generation) { reject("stale_generation"); continue; }
        if (meta.model === null) { reject("model_mismatch"); continue; }
        if (seen.has(item.chunkId)) { reject("duplicate"); continue; }
        seen.add(item.chunkId);
        const link = this.rows("SELECT digest,vector_id,failure FROM quixi_semantic_links WHERE chunk_id=?", [item.chunkId])[0];
        if (!link || link.digest !== item.textDigest || link.failure !== null) { reject("chunk_changed"); continue; }
        if (link.vector_id !== null) { reject("duplicate"); continue; }
        if (!validVector(item.vector)) { reject("invalid_vector"); continue; }
        let vectorId = this.rows("SELECT id FROM quixi_semantic_vectors WHERE digest=?", [item.textDigest])[0]?.id;
        if (vectorId === undefined) {
          this.exec("INSERT INTO quixi_semantic_vectors(digest,generation) VALUES(?,?)", [item.textDigest, generation]);
          vectorId = Number(this.db.selectValue("SELECT last_insert_rowid()"));
          this.exec("INSERT INTO quixi_semantic_vec(rowid,embedding) VALUES(?,?)", [Number(vectorId), new Uint8Array(new Float32Array(item.vector).buffer)]);
          // The coarse projection stays complete as vectors arrive.
          this.exec("INSERT INTO quixi_semantic_int8(rowid,embedding) VALUES(?,vec_int8(?))", [Number(vectorId), new Uint8Array(quantizeInt8(item.vector).buffer)]);
        }
        this.exec("UPDATE quixi_semantic_links SET vector_id=?,claimed_at=NULL WHERE chunk_id=?", [Number(vectorId), item.chunkId]);
        accepted++;
      }
      if (accepted) this.exec("UPDATE quixi_semantic_meta SET revision=revision+1");
    });
    return { accepted, rejected, status: this.status(visible) };
  }
  /** Nearest stored vectors joined to visible chunks; the caller applies its
   * filters and ranking over this bounded candidate set. */
  candidates(vector: readonly number[], k: number, visible: VisibleChunkSql, extraWhere: string[], extraBind: SqlValue[]): { rowid: number; chunk_id: string; distance: number }[] {
    this.check();
    if (!validVector(vector)) throw new SearchError("INVALID_REQUEST", "Query vectors must be 384 finite, approximately unit values.");
    const bytes = new Uint8Array(new Float32Array(vector).buffer);
    const vectors = this.scalar("SELECT count(*) FROM quixi_semantic_vectors");
    const projected = this.scalar("SELECT count(*) FROM quixi_semantic_int8");
    // ADR 0036: above the threshold, int8 coarse retrieval over a generous
    // candidate set, then an exact float32 rerank of those candidates. A
    // projection that is not yet complete never serves queries.
    const knn = vectors >= this.coarseThreshold && projected === vectors
      ? `SELECT v.rowid AS vector_id,vec_distance_L2(v.embedding,?) AS distance FROM quixi_semantic_vec v WHERE v.rowid IN (SELECT rowid FROM quixi_semantic_int8 WHERE embedding MATCH vec_int8(?) AND k=?)`
      : `SELECT rowid AS vector_id,distance FROM quixi_semantic_vec WHERE embedding MATCH ? AND k=?`;
    const knnBind: SqlValue[] = vectors >= this.coarseThreshold && projected === vectors
      ? [bytes, new Uint8Array(quantizeInt8(vector).buffer), Math.max(k, SEMANTIC_PROJECTION.coarseCandidates)]
      : [bytes, k];
    return this.rows(
      `SELECT c.rowid AS rowid,c.chunk_id,knn.distance ${visible.from} JOIN quixi_semantic_links l ON l.chunk_id=c.chunk_id JOIN (${knn}) knn ON knn.vector_id=l.vector_id WHERE ${[visible.where, ...extraWhere].join(" AND ")} ORDER BY knn.distance,c.rowid LIMIT ?`,
      [...knnBind, ...visible.bind, ...extraBind, k],
    ).map((row) => ({ rowid: Number(row.rowid), chunk_id: String(row.chunk_id), distance: Number(row.distance) }));
  }
  /** Bounded maintenance: links whose chunk no longer exists in any epoch and
   * vectors no link references. Returns whether work remains. */
  maintain(max: number): { remaining: boolean; progressed: boolean } {
    if (this.unavailable) return { remaining: false, progressed: false };
    let progressed = false;
    this.tx(() => {
      const before = this.scalar("SELECT total_changes()");
      this.exec("DELETE FROM quixi_semantic_links WHERE chunk_id IN(SELECT l.chunk_id FROM quixi_semantic_links l WHERE NOT EXISTS(SELECT 1 FROM quixi_search_chunks c WHERE c.chunk_id=l.chunk_id) LIMIT ?)", [max]);
      const orphans = this.rows("SELECT v.id FROM quixi_semantic_vectors v WHERE NOT EXISTS(SELECT 1 FROM quixi_semantic_links l WHERE l.vector_id=v.id) LIMIT ?", [max]);
      for (const orphan of orphans) {
        this.exec("DELETE FROM quixi_semantic_vec WHERE rowid=?", [Number(orphan.id)]);
        this.exec("DELETE FROM quixi_semantic_int8 WHERE rowid=?", [Number(orphan.id)]);
        this.exec("DELETE FROM quixi_semantic_vectors WHERE id=?", [Number(orphan.id)]);
      }
      // Backfill the projection for vectors stored before it existed (or after
      // a representation change), bounded per slice, from the exact floats.
      const missing = this.rows("SELECT v.id,f.embedding FROM quixi_semantic_vectors v JOIN quixi_semantic_vec f ON f.rowid=v.id WHERE NOT EXISTS(SELECT 1 FROM quixi_semantic_int8 p WHERE p.rowid=v.id) LIMIT ?", [max]);
      for (const row of missing) {
        const floats = new Float32Array((row.embedding as Uint8Array).buffer.slice((row.embedding as Uint8Array).byteOffset, (row.embedding as Uint8Array).byteOffset + (row.embedding as Uint8Array).byteLength));
        this.exec("INSERT INTO quixi_semantic_int8(rowid,embedding) VALUES(?,vec_int8(?))", [Number(row.id), new Uint8Array(quantizeInt8(floats).buffer)]);
      }
      progressed = this.scalar("SELECT total_changes()") > before;
      if (progressed) this.exec("UPDATE quixi_semantic_meta SET revision=revision+1");
    });
    const remaining = this.scalar("SELECT EXISTS(SELECT 1 FROM quixi_semantic_links l WHERE NOT EXISTS(SELECT 1 FROM quixi_search_chunks c WHERE c.chunk_id=l.chunk_id)) OR EXISTS(SELECT 1 FROM quixi_semantic_vectors v WHERE NOT EXISTS(SELECT 1 FROM quixi_semantic_links l WHERE l.vector_id=v.id)) OR EXISTS(SELECT 1 FROM quixi_semantic_vectors v WHERE NOT EXISTS(SELECT 1 FROM quixi_semantic_int8 p WHERE p.rowid=v.id))") === 1;
    return { remaining, progressed };
  }
}
