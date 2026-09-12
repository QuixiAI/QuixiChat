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
  constructor(private readonly db: CanonicalSqlite, private readonly now: () => number = () => Date.now()) {}
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
  }
  private validate(): void {
    const ledger = this.rows("SELECT version,checksum FROM quixi_semantic_schema ORDER BY version");
    if (ledger.length !== 1 || ledger[0]!.version !== 1 || ledger[0]!.checksum !== SEMANTIC_SCHEMA_CHECKSUM)
      throw new SearchError("MIGRATION_FAILED", "The semantic index schema is from another build; delete and rebuild the semantic index.");
    for (const match of SEMANTIC_SCHEMA.matchAll(/CREATE (?:VIRTUAL )?(TABLE|INDEX) (quixi_semantic_\w+)/g))
      if (!this.rows("SELECT 1 FROM sqlite_schema WHERE type=? AND name=?", [match[1]!.toLowerCase(), match[2]!]).length)
        throw new SearchError("MIGRATION_FAILED", `Semantic index object ${match[2]} is missing; delete and rebuild the semantic index.`);
    this.rows("SELECT state,model,generation,revision FROM quixi_semantic_meta WHERE singleton=1 LIMIT 0");
    this.rows("SELECT rowid FROM quixi_semantic_vec LIMIT 0");
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
    // The virtual table owns its shadow tables; drop it before plain tables.
    drop("TABLE", "quixi_semantic_vec");
    for (const object of objects)
      if (object.type === "table" && object.name !== "quixi_semantic_vec" && !String(object.name).startsWith("quixi_semantic_vec_")) drop("TABLE", String(object.name));
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
    if (this.unavailable) return { state: "disabled", model: null, generation: 0, indexedChunks: 0, pendingChunks: 0, vectors: 0, vectorBytes: 0 };
    const meta = this.meta();
    const model = meta.model === null ? null : (JSON.parse(String(meta.model)) as EmbeddingModelIdentity);
    const indexed = model ? this.scalar(`SELECT count(*) ${visible.from} JOIN quixi_semantic_links l ON l.chunk_id=c.chunk_id WHERE ${visible.where} AND l.vector_id IS NOT NULL`, visible.bind) : 0;
    const pending = model ? this.scalar(`SELECT count(*) ${visible.from} LEFT JOIN quixi_semantic_links l ON l.chunk_id=c.chunk_id WHERE ${visible.where} AND (l.chunk_id IS NULL OR (l.vector_id IS NULL AND l.failure IS NULL))`, visible.bind) : 0;
    const vectors = this.scalar("SELECT count(*) FROM quixi_semantic_vectors");
    return { state: String(meta.state) as SemanticIndexStatus["state"], model, generation: Number(meta.generation), indexedChunks: indexed, pendingChunks: pending, vectors, vectorBytes: vectors * VECTOR_BYTES };
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
        this.exec("DELETE FROM quixi_semantic_vectors");
        this.exec("DELETE FROM quixi_semantic_links");
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
        this.exec("DELETE FROM quixi_semantic_vectors");
        this.exec("DELETE FROM quixi_semantic_links");
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
    return this.rows(
      `SELECT c.rowid AS rowid,c.chunk_id,knn.distance ${visible.from} JOIN quixi_semantic_links l ON l.chunk_id=c.chunk_id JOIN (SELECT rowid AS vector_id,distance FROM quixi_semantic_vec WHERE embedding MATCH ? AND k=?) knn ON knn.vector_id=l.vector_id WHERE ${[visible.where, ...extraWhere].join(" AND ")} ORDER BY knn.distance,c.rowid`,
      [bytes, k, ...visible.bind, ...extraBind],
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
        this.exec("DELETE FROM quixi_semantic_vectors WHERE id=?", [Number(orphan.id)]);
      }
      progressed = this.scalar("SELECT total_changes()") > before;
      if (progressed) this.exec("UPDATE quixi_semantic_meta SET revision=revision+1");
    });
    const remaining = this.scalar("SELECT EXISTS(SELECT 1 FROM quixi_semantic_links l WHERE NOT EXISTS(SELECT 1 FROM quixi_search_chunks c WHERE c.chunk_id=l.chunk_id)) OR EXISTS(SELECT 1 FROM quixi_semantic_vectors v WHERE NOT EXISTS(SELECT 1 FROM quixi_semantic_links l WHERE l.vector_id=v.id))") === 1;
    return { remaining, progressed };
  }
}
