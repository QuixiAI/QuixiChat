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
/** vec0 keeps vectors in chunk blobs and a point lookup reads a whole chunk;
 * 16 rows (24 KiB) per chunk keeps the coarse→rerank point lookups to a few
 * pages each (ADR 0036 browser measurement) at a ~13% slower exact scan. */
export const SEMANTIC_FLOAT_CHUNK_SIZE = 16;
const floatTable = (chunkSize: number | null) => `CREATE VIRTUAL TABLE quixi_semantic_vec USING vec0(embedding float[${SEMANTIC_DIMENSIONS}]${chunkSize === null ? "" : `, chunk_size=${chunkSize}`});`;
const baseSchema = (chunkSize: number | null) => `
CREATE TABLE quixi_semantic_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),state TEXT NOT NULL,model TEXT,generation INTEGER NOT NULL,revision INTEGER NOT NULL) STRICT;
CREATE TABLE quixi_semantic_vectors(id INTEGER PRIMARY KEY,digest TEXT NOT NULL UNIQUE,generation INTEGER NOT NULL) STRICT;
${floatTable(chunkSize)}
CREATE TABLE quixi_semantic_links(chunk_id TEXT PRIMARY KEY,digest TEXT NOT NULL,vector_id INTEGER,generation INTEGER NOT NULL,claimed_at INTEGER,failure TEXT) STRICT;
CREATE INDEX quixi_semantic_link_vector ON quixi_semantic_links(vector_id);
CREATE INDEX quixi_semantic_link_digest ON quixi_semantic_links(digest);
CREATE TABLE quixi_semantic_operations(id TEXT PRIMARY KEY,generation INTEGER NOT NULL) STRICT;
`;
export const SEMANTIC_SCHEMA = baseSchema(SEMANTIC_FLOAT_CHUNK_SIZE);
export const SEMANTIC_SCHEMA_CHECKSUM = searchDigest(SEMANTIC_SCHEMA);
/** The first build's base schema (default 1024-row float chunks); a namespace
 * recorded under it has its float table rebuilt in place at open. */
export const SEMANTIC_SCHEMA_LEGACY_CHECKSUM = searchDigest(baseSchema(null));
/** Ledger version 3 (ADR 0036 amendment 2): the sign-bit coarse projection,
 * 48 bytes per vector in a plain table, scanned from worker memory. Version-1
 * namespaces gain it in place; the version-2 int8 vec0 projection (slower
 * than the float scan in every measured configuration) is dropped. */
export const SEMANTIC_PROJECTION_SCHEMA = `
CREATE TABLE quixi_semantic_bits(vector_id INTEGER PRIMARY KEY,bits BLOB NOT NULL) STRICT;
CREATE TABLE quixi_semantic_projection(singleton INTEGER PRIMARY KEY CHECK(singleton=1),representation TEXT NOT NULL,generation INTEGER NOT NULL) STRICT;
`;
export const SEMANTIC_PROJECTION_CHECKSUM = searchDigest(SEMANTIC_PROJECTION_SCHEMA);
export const SEMANTIC_BITS_BYTES = SEMANTIC_DIMENSIONS / 8;
/** Coarse stage: Hamming top-`coarseCandidates` over the resident sign bits,
 * then an exact float32 rerank of those candidates through vec0 point
 * lookups. 5,000 candidates reproduce every judged float metric at 100k–1M
 * and keep 0.82–0.98 of the exact top-64 neighbours (ADR 0036 amendment 2). */
export const SEMANTIC_PROJECTION = Object.freeze({ representation: "sign-bit-v1", bytesPerVector: SEMANTIC_BITS_BYTES, coarseCandidates: 5_000 });
/** Vector count from which queries use the coarse stage; `null` keeps the
 * exact float KNN at every size. Measured crossover: at 100k the float scan
 * (49 ms) and coarse→rerank (43 ms) cost the same; at 500k coarse→rerank is
 * 3.7× faster (ADR 0036 amendment 2). */
export const SEMANTIC_COARSE_THRESHOLD: number | null = 100_000;
/** Sign bits, little-endian within each byte: bit d set when component d ≥ 0
 * (the same layout as sqlite-vec's vec_quantize_binary). */
export function signBits(vector: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(SEMANTIC_BITS_BYTES);
  for (let d = 0; d < SEMANTIC_DIMENSIONS; d++) if (vector[d]! >= 0) out[d >> 3] = (out[d >> 3] ?? 0) | (1 << (d & 7));
  return out;
}
const POPCOUNT = new Uint8Array(256);
for (let i = 0; i < 256; i++) { let c = 0, v = i; while (v) { c += v & 1; v >>= 1; } POPCOUNT[i] = c; }
/** The resident coarse index: vector ids and their sign bits, appended on
 * publish, rebuilt from the table after removals or a generation change. */
interface ResidentBits { generation: number; count: number; ids: Int32Array; bits: Uint8Array }
/** Hamming top-k over the resident bits with a bounded max-heap; ties keep the
 * lower vector id. Returns vector ids, nearest first. */
export function hammingTopK(index: { count: number; ids: Int32Array; bits: Uint8Array }, query: Uint8Array, k: number): number[] {
  const size = Math.min(k, index.count), heapId = new Int32Array(size), heapD = new Int32Array(size);
  let count = 0;
  const worse = (a: number, b: number) => heapD[a]! > heapD[b]! || (heapD[a] === heapD[b] && heapId[a]! > heapId[b]!);
  const swap = (a: number, b: number) => { const d = heapD[a]!, i = heapId[a]!; heapD[a] = heapD[b]!; heapId[a] = heapId[b]!; heapD[b] = d; heapId[b] = i; };
  const { bits, ids } = index;
  for (let n = 0, base = 0; n < index.count; n++, base += SEMANTIC_BITS_BYTES) {
    let d = 0;
    for (let b = 0; b < SEMANTIC_BITS_BYTES; b++) d += POPCOUNT[(bits[base + b] ?? 0) ^ (query[b] ?? 0)] ?? 0;
    if (count < size) {
      let c = count++;
      heapId[c] = ids[n]!; heapD[c] = d;
      while (c > 0) { const p = (c - 1) >> 1; if (worse(c, p)) { swap(c, p); c = p; } else break; }
    } else if (d < heapD[0]! || (d === heapD[0] && ids[n]! < heapId[0]!)) {
      heapId[0] = ids[n]!; heapD[0] = d;
      let c = 0;
      for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; if (l < count && worse(l, m)) m = l; if (r < count && worse(r, m)) m = r; if (m === c) break; swap(c, m); c = m; }
    }
  }
  const order: number[] = [];
  for (let i = 0; i < count; i++) order.push(i);
  return order.sort((a, b) => heapD[a]! - heapD[b]! || heapId[a]! - heapId[b]!).map((i) => heapId[i]!);
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
  private resident: ResidentBits | null = null;
  constructor(private readonly db: CanonicalSqlite, private readonly now: () => number = () => Date.now(), private readonly coarseThreshold: number | null = SEMANTIC_COARSE_THRESHOLD) {}
  private coarse(vectors: number, projected: number): boolean { return this.coarseThreshold !== null && vectors >= this.coarseThreshold && projected === vectors; }
  /** Bytes the resident coarse index holds in worker memory right now. */
  residentBytes(): number { return this.resident ? this.resident.count * SEMANTIC_BITS_BYTES : 0; }
  /** Loads the sign bits for the current generation; bounded by 48 bytes per vector. */
  private loadResident(generation: number): ResidentBits {
    if (this.resident && this.resident.generation === generation) return this.resident;
    const count = this.scalar("SELECT count(*) FROM quixi_semantic_bits");
    const ids = new Int32Array(Math.max(count, 16)), bits = new Uint8Array(ids.length * SEMANTIC_BITS_BYTES);
    let n = 0;
    for (const row of this.rows("SELECT vector_id,bits FROM quixi_semantic_bits ORDER BY vector_id")) {
      ids[n] = Number(row.vector_id);
      bits.set(row.bits as Uint8Array, n * SEMANTIC_BITS_BYTES);
      n++;
    }
    this.resident = { generation, count: n, ids, bits };
    return this.resident;
  }
  private appendResident(vectorId: number, bits: Uint8Array): void {
    const resident = this.resident;
    if (!resident) return;
    if (resident.count === resident.ids.length) {
      const ids = new Int32Array(resident.ids.length * 2), grown = new Uint8Array(ids.length * SEMANTIC_BITS_BYTES);
      ids.set(resident.ids);
      grown.set(resident.bits);
      resident.ids = ids;
      resident.bits = grown;
    }
    resident.ids[resident.count] = vectorId;
    resident.bits.set(bits, resident.count * SEMANTIC_BITS_BYTES);
    resident.count++;
  }
  /** Removals and generation changes rebuild the resident index lazily. */
  private dropResident(): void { this.resident = null; }
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
    this.exec("INSERT INTO quixi_semantic_schema VALUES(3,?)", [SEMANTIC_PROJECTION_CHECKSUM]);
    this.exec("INSERT INTO quixi_semantic_projection VALUES(1,?,?)", [SEMANTIC_PROJECTION.representation, Number(this.rows("SELECT generation FROM quixi_semantic_meta")[0]?.generation ?? 1)]);
  }
  /** Rebuilds the float table with this build's chunk size, keeping every
   * vector: the rows pass through a plain table because vec0 tables cannot
   * be altered. Bounded by the index size; runs once per namespace. */
  private rebuildFloatTable(): void {
    this.exec("CREATE TABLE quixi_semantic_migrate(id INTEGER PRIMARY KEY,embedding BLOB NOT NULL) STRICT");
    this.exec("INSERT INTO quixi_semantic_migrate(id,embedding) SELECT rowid,embedding FROM quixi_semantic_vec");
    this.exec("DROP TABLE quixi_semantic_vec");
    this.exec(floatTable(SEMANTIC_FLOAT_CHUNK_SIZE));
    this.exec("INSERT INTO quixi_semantic_vec(rowid,embedding) SELECT id,embedding FROM quixi_semantic_migrate ORDER BY id");
    this.exec("DROP TABLE quixi_semantic_migrate");
    this.exec("UPDATE quixi_semantic_schema SET checksum=? WHERE version=1", [SEMANTIC_SCHEMA_CHECKSUM]);
  }
  private validate(): void {
    let ledger = this.rows("SELECT version,checksum FROM quixi_semantic_schema ORDER BY version");
    if (!ledger.length || ledger[0]!.version !== 1 || ![SEMANTIC_SCHEMA_CHECKSUM, SEMANTIC_SCHEMA_LEGACY_CHECKSUM].includes(String(ledger[0]!.checksum)))
      throw new SearchError("MIGRATION_FAILED", "The semantic index schema is from another build; delete and rebuild the semantic index.");
    // Upgrades in place, vectors kept: the legacy float chunk size, the
    // version-2 int8 projection (dropped), and the missing version-3 projection.
    if (ledger[0]!.checksum === SEMANTIC_SCHEMA_LEGACY_CHECKSUM) this.tx(() => this.rebuildFloatTable());
    if (ledger.some((row) => row.version === 2)) this.tx(() => {
      this.exec("DROP TABLE IF EXISTS quixi_semantic_int8");
      this.exec("DROP TABLE IF EXISTS quixi_semantic_projection");
      this.exec("DELETE FROM quixi_semantic_schema WHERE version=2");
    });
    ledger = this.rows("SELECT version,checksum FROM quixi_semantic_schema ORDER BY version");
    if (ledger.length === 1) this.tx(() => this.installProjection());
    else if (ledger.length !== 2 || ledger[1]!.version !== 3 || ledger[1]!.checksum !== SEMANTIC_PROJECTION_CHECKSUM)
      throw new SearchError("MIGRATION_FAILED", "The semantic projection schema is from another build; delete and rebuild the semantic index.");
    for (const match of `${SEMANTIC_SCHEMA}${SEMANTIC_PROJECTION_SCHEMA}`.matchAll(/CREATE (?:VIRTUAL )?(TABLE|INDEX) (quixi_semantic_\w+)/g))
      if (!this.rows("SELECT 1 FROM sqlite_schema WHERE type=? AND name=?", [match[1]!.toLowerCase(), match[2]!]).length)
        throw new SearchError("MIGRATION_FAILED", `Semantic index object ${match[2]} is missing; delete and rebuild the semantic index.`);
    this.rows("SELECT state,model,generation,revision FROM quixi_semantic_meta WHERE singleton=1 LIMIT 0");
    this.rows("SELECT rowid FROM quixi_semantic_vec LIMIT 0");
    this.rows("SELECT vector_id FROM quixi_semantic_bits LIMIT 0");
    // A projection built under another representation is never mixed with
    // this build's: it is dropped and rebuilt by maintenance.
    const projection = this.rows("SELECT representation FROM quixi_semantic_projection WHERE singleton=1")[0];
    if (!projection || projection.representation !== SEMANTIC_PROJECTION.representation)
      this.tx(() => {
        this.exec("DELETE FROM quixi_semantic_bits");
        this.exec("INSERT INTO quixi_semantic_projection VALUES(1,?,(SELECT generation FROM quixi_semantic_meta)) ON CONFLICT(singleton) DO UPDATE SET representation=excluded.representation,generation=excluded.generation", [SEMANTIC_PROJECTION.representation]);
      });
    this.dropResident();
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
    this.dropResident();
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
    const emptyProjection = { representation: SEMANTIC_PROJECTION.representation, bytesPerVector: SEMANTIC_PROJECTION.bytesPerVector, candidates: SEMANTIC_PROJECTION.coarseCandidates, projected: 0, complete: true, coarseRetrieval: false, threshold: this.coarseThreshold, residentBytes: 0 };
    if (this.unavailable) return { state: "disabled", model: null, generation: 0, indexedChunks: 0, pendingChunks: 0, vectors: 0, vectorBytes: 0, projection: emptyProjection };
    const meta = this.meta();
    const model = meta.model === null ? null : (JSON.parse(String(meta.model)) as EmbeddingModelIdentity);
    const indexed = model ? this.scalar(`SELECT count(*) ${visible.from} JOIN quixi_semantic_links l ON l.chunk_id=c.chunk_id WHERE ${visible.where} AND l.vector_id IS NOT NULL`, visible.bind) : 0;
    const pending = model ? this.scalar(`SELECT count(*) ${visible.from} LEFT JOIN quixi_semantic_links l ON l.chunk_id=c.chunk_id WHERE ${visible.where} AND (l.chunk_id IS NULL OR (l.vector_id IS NULL AND l.failure IS NULL))`, visible.bind) : 0;
    const vectors = this.scalar("SELECT count(*) FROM quixi_semantic_vectors");
    const projected = this.scalar("SELECT count(*) FROM quixi_semantic_bits");
    const projection = { ...emptyProjection, projected, complete: projected === vectors, coarseRetrieval: this.coarse(vectors, projected), residentBytes: this.residentBytes() };
    return { state: String(meta.state) as SemanticIndexStatus["state"], model, generation: Number(meta.generation), indexedChunks: indexed, pendingChunks: pending, vectors, vectorBytes: vectors * VECTOR_BYTES, projection };
  }
  private clearVectors(generation: number): void {
    this.exec("DELETE FROM quixi_semantic_vec");
    this.exec("DELETE FROM quixi_semantic_bits");
    this.exec("DELETE FROM quixi_semantic_vectors");
    this.exec("DELETE FROM quixi_semantic_links");
    this.exec("UPDATE quixi_semantic_projection SET generation=?", [generation]);
    this.dropResident();
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
        this.clearVectors(generation);
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
        this.clearVectors(generation);
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
          // The coarse projection stays complete as vectors arrive, on disk
          // and in the resident index when it is loaded.
          const bits = signBits(item.vector);
          this.exec("INSERT INTO quixi_semantic_bits(vector_id,bits) VALUES(?,?)", [Number(vectorId), bits]);
          if (this.resident?.generation === generation) this.appendResident(Number(vectorId), bits);
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
    const projected = this.scalar("SELECT count(*) FROM quixi_semantic_bits");
    // ADR 0036 amendment 2: above the threshold, Hamming top-N over the
    // resident sign bits, then an exact float32 rerank of those candidates
    // through vec0 point lookups (a join on rowid; `rowid IN (subquery)`
    // would scan the whole float table). A projection that is not yet
    // complete never serves queries.
    let knn = "SELECT rowid AS vector_id,distance FROM quixi_semantic_vec WHERE embedding MATCH ? AND k=?";
    let knnBind: SqlValue[] = [bytes, k];
    if (this.coarse(vectors, projected)) {
      const resident = this.loadResident(Number(this.meta().generation));
      const candidates = hammingTopK(resident, signBits(vector), Math.max(k, SEMANTIC_PROJECTION.coarseCandidates));
      this.exec("CREATE TEMP TABLE IF NOT EXISTS quixi_semantic_coarse(id INTEGER PRIMARY KEY)");
      this.exec("DELETE FROM quixi_semantic_coarse");
      this.exec("INSERT INTO quixi_semantic_coarse(id) SELECT value FROM json_each(?)", [JSON.stringify(candidates)]);
      knn = "SELECT v.rowid AS vector_id,vec_distance_L2(v.embedding,?) AS distance FROM quixi_semantic_coarse t CROSS JOIN quixi_semantic_vec v ON v.rowid=t.id";
      knnBind = [bytes];
    }
    return this.rows(
      `SELECT c.rowid AS rowid,c.chunk_id,knn.distance ${visible.from} JOIN quixi_semantic_links l ON l.chunk_id=c.chunk_id JOIN (${knn}) knn ON knn.vector_id=l.vector_id WHERE ${[visible.where, ...extraWhere].join(" AND ")} ORDER BY knn.distance,c.rowid LIMIT ?`,
      [...knnBind, ...visible.bind, ...extraBind, k],
    ).map((row) => ({ rowid: Number(row.rowid), chunk_id: String(row.chunk_id), distance: Number(row.distance) }));
  }
  /** Bounded maintenance: links whose chunk no longer exists in any epoch,
   * vectors no link references, and projection rows missing for stored
   * vectors (after an upgrade or a representation change). Returns whether
   * work remains. */
  maintain(max: number): { remaining: boolean; progressed: boolean } {
    if (this.unavailable) return { remaining: false, progressed: false };
    let progressed = false;
    this.tx(() => {
      const before = this.scalar("SELECT total_changes()");
      this.exec("DELETE FROM quixi_semantic_links WHERE chunk_id IN(SELECT l.chunk_id FROM quixi_semantic_links l WHERE NOT EXISTS(SELECT 1 FROM quixi_search_chunks c WHERE c.chunk_id=l.chunk_id) LIMIT ?)", [max]);
      const orphans = this.rows("SELECT v.id FROM quixi_semantic_vectors v WHERE NOT EXISTS(SELECT 1 FROM quixi_semantic_links l WHERE l.vector_id=v.id) LIMIT ?", [max]);
      for (const orphan of orphans) {
        this.exec("DELETE FROM quixi_semantic_vec WHERE rowid=?", [Number(orphan.id)]);
        this.exec("DELETE FROM quixi_semantic_bits WHERE vector_id=?", [Number(orphan.id)]);
        this.exec("DELETE FROM quixi_semantic_vectors WHERE id=?", [Number(orphan.id)]);
      }
      if (orphans.length) this.dropResident();
      const missing = this.rows("SELECT v.id,f.embedding FROM quixi_semantic_vectors v JOIN quixi_semantic_vec f ON f.rowid=v.id WHERE NOT EXISTS(SELECT 1 FROM quixi_semantic_bits p WHERE p.vector_id=v.id) LIMIT ?", [max]);
      for (const row of missing) {
        const blob = row.embedding as Uint8Array;
        const floats = new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
        this.exec("INSERT INTO quixi_semantic_bits(vector_id,bits) VALUES(?,?)", [Number(row.id), signBits(floats)]);
      }
      if (missing.length) this.dropResident();
      progressed = this.scalar("SELECT total_changes()") > before;
      if (progressed) this.exec("UPDATE quixi_semantic_meta SET revision=revision+1");
    });
    const remaining = this.scalar("SELECT EXISTS(SELECT 1 FROM quixi_semantic_links l WHERE NOT EXISTS(SELECT 1 FROM quixi_search_chunks c WHERE c.chunk_id=l.chunk_id)) OR EXISTS(SELECT 1 FROM quixi_semantic_vectors v WHERE NOT EXISTS(SELECT 1 FROM quixi_semantic_links l WHERE l.vector_id=v.id)) OR EXISTS(SELECT 1 FROM quixi_semantic_vectors v WHERE NOT EXISTS(SELECT 1 FROM quixi_semantic_bits p WHERE p.vector_id=v.id))") === 1;
    return { remaining, progressed };
  }
}
