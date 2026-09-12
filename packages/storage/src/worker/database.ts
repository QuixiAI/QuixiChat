import initialize from "../../sqlite/dist/sqlite3.mjs";
import wasmUrl from "../../sqlite/dist/sqlite3.wasm?url";
import { MAX_TEXT_LENGTH } from "../protocol.ts";
import type { StorageDiagnostics, StorageRequest } from "../protocol.ts";

type Value = string | number | null | Uint8Array;
type Row = Record<string, Value>;
interface Database {
  exec(options: string | { sql: string; bind?: Value[]; rowMode?: "object"; returnValue?: "resultRows" }): unknown;
  selectValue(sql: string, bind?: Value[]): Value;
  close(): void;
}
interface Pool {
  OpfsSAHPoolDb: new (filename: string) => Database;
  getCapacity(): number;
  pauseVfs(): void;
}
interface SQLite {
  installOpfsSAHPoolVfs(options: { name: string; directory: string; initialCapacity: number }): Promise<Pool>;
}

export class ProofDatabase {
  private interrupted = false;
  private constructor(private readonly db: Database, private readonly pool: Pool, readonly namespace: string) {}

  static async open(namespace: string): Promise<ProofDatabase> {
    try { await navigator.storage.getDirectory(); }
    catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw new Error(`Local archive storage (OPFS) is unavailable in this session. Try a regular browser profile with site storage enabled. Private or restricted sessions may prevent access. No archive was opened. ${detail}`, { cause: error });
    }
    (globalThis as typeof globalThis & { sqlite3ApiConfig: unknown }).sqlite3ApiConfig = {
      disable: { vfs: { opfs: true, "opfs-wl": true } },
    };
    const sqlite = await initialize({ locateFile: (file: string) => file.endsWith(".wasm") ? wasmUrl : file }) as SQLite;
    const pool = await sqlite.installOpfsSAHPoolVfs({ name: "quixi-proof", directory: `/quixi/database/proof-${namespace}`, initialCapacity: 6 });
    let db: Database | undefined;
    try {
      db = new pool.OpfsSAHPoolDb("/proof.sqlite3");
      db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
      const version = Number(db.selectValue("PRAGMA user_version"));
      if (version > 1) throw new Error(`Unsupported proof schema version ${version}`);
      if (version === 0) {
        db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE proof_records(id TEXT PRIMARY KEY, text TEXT NOT NULL, updated_at INTEGER NOT NULL);
          CREATE TABLE proof_ops(id TEXT PRIMARY KEY, record_id TEXT NOT NULL, kind TEXT NOT NULL);
          CREATE VIRTUAL TABLE proof_fts USING fts5(id UNINDEXED, text);
          CREATE VIRTUAL TABLE proof_vectors USING vec0(embedding float[3]);
          INSERT INTO proof_vectors(rowid, embedding) VALUES (1, '[1,0,0]'), (2, '[0,1,0]');
          PRAGMA user_version=1;
          COMMIT;`);
      }
      return new ProofDatabase(db, pool, namespace);
    } catch (error) {
      db?.close();
      pool.pauseVfs();
      throw error;
    }
  }

  close(): void {
    try { this.db.close(); } finally { this.pool.pauseVfs(); }
  }

  async execute(request: StorageRequest, ownerId: string): Promise<unknown> {
    if (this.interrupted) throw new Error("Crash probe is armed; terminate or close the owning worker before further operations");
    switch (request.operation) {
      case "diagnostics": return this.diagnostics(ownerId);
      case "put": {
        this.validateId(request.args.id);
        if (typeof request.args.text !== "string" || request.args.text.length > MAX_TEXT_LENGTH) throw new Error("Proof text exceeds 65536 characters");
        const record = { ...request.args, updatedAt: Date.now() };
        this.transaction(() => {
          this.db.exec({ sql: "INSERT INTO proof_records VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text, updated_at=excluded.updated_at", bind: [record.id, record.text, record.updatedAt] });
          this.db.exec({ sql: "DELETE FROM proof_fts WHERE id=?", bind: [record.id] });
          this.db.exec({ sql: "INSERT INTO proof_fts(id,text) VALUES (?,?)", bind: [record.id, record.text] });
          this.db.exec({ sql: "INSERT INTO proof_ops VALUES (?,?,'put')", bind: [request.id, record.id] });
        });
        return record;
      }
      case "list": return this.rows("SELECT id,text,updated_at AS updatedAt FROM proof_records WHERE id>? ORDER BY id LIMIT ?", [request.args.afterId ?? "", this.limit(request.args.limit)]);
      case "search": {
        if (typeof request.args.query !== "string" || request.args.query.length > 1024) throw new Error("Invalid search query");
        if (!request.args.query.trim()) return [];
        const phrase = '"' + request.args.query.replaceAll('"', '""') + '"';
        return this.rows("SELECT r.id,r.text,r.updated_at AS updatedAt FROM proof_fts f JOIN proof_records r ON r.id=f.id WHERE proof_fts MATCH ? ORDER BY bm25(proof_fts),r.id LIMIT ?", [phrase, this.limit(request.args.limit)]);
      }
      case "remove": {
        this.validateId(request.args.id);
        const exists = Number(this.db.selectValue("SELECT count(*) FROM proof_records WHERE id=?", [request.args.id])) > 0;
        this.transaction(() => {
          this.db.exec({ sql: "DELETE FROM proof_fts WHERE id=?", bind: [request.args.id] });
          this.db.exec({ sql: "DELETE FROM proof_records WHERE id=?", bind: [request.args.id] });
          if (exists) this.db.exec({ sql: "INSERT INTO proof_ops VALUES (?,?,'remove')", bind: [request.id, request.args.id] });
        });
        return exists;
      }
      case "vectorProbe": {
        const [row] = this.rows("SELECT rowid,distance FROM proof_vectors WHERE embedding MATCH '[0.9,0.1,0]' AND k=1");
        if (!row) throw new Error("Vector probe returned no result");
        return { nearestId: Number(row.rowid), distance: Number(row.distance) };
      }
      case "rollbackProbe": {
        const id = crypto.randomUUID();
        try {
          this.transaction(() => {
            this.db.exec({ sql: "INSERT INTO proof_records VALUES (?, 'must roll back', 0)", bind: [id] });
            this.db.exec({ sql: "INSERT INTO proof_ops VALUES (?,?,'put')", bind: [id, id] });
            throw new Error("Deliberate rollback probe");
          });
        } catch { /* Verify records and operation log below. */ }
        return { rolledBack: Number(this.db.selectValue("SELECT count(*) FROM proof_records WHERE id=?", [id])) === 0 && Number(this.db.selectValue("SELECT count(*) FROM proof_ops WHERE id=?", [id])) === 0 };
      }
      case "migrationProbe": {
        try {
          this.transaction(() => {
            this.db.exec("CREATE TABLE proof_failed_migration(id TEXT); PRAGMA user_version=2;");
            this.db.exec("INSERT INTO proof_missing_table VALUES(1)");
          });
        } catch { /* Both schema and version must roll back. */ }
        return { rolledBack: Number(this.db.selectValue("PRAGMA user_version")) === 1 && Number(this.db.selectValue("SELECT count(*) FROM sqlite_master WHERE name='proof_failed_migration'")) === 0 };
      }
      case "fullProbe": {
        // Isolate the page-limit failure from the record DB and its free pages.
        const probe = new this.pool.OpfsSAHPoolDb("/full-probe.sqlite3");
        let rejected = false;
        try {
          probe.exec("PRAGMA max_page_count=8; BEGIN IMMEDIATE;");
          probe.exec("CREATE TABLE proof_full_probe(value BLOB)");
          probe.exec("INSERT INTO proof_full_probe VALUES(zeroblob(1048576))");
        } catch (error) { rejected = /full/i.test(String(error)); }
        finally {
          try { probe.exec("ROLLBACK"); } catch { /* SQLITE_FULL can roll back automatically. */ }
          probe.close();
        }
        return { rejected, integrity: String(this.db.selectValue("PRAGMA integrity_check")) };
      }
      case "beginInterruptedWrite": {
        this.validateId(request.args.id);
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db.exec({ sql: "INSERT INTO proof_records VALUES (?,'uncommitted',0)", bind: [request.args.id] });
          this.interrupted = true;
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
        return { pending: true };
      }
      default: throw new Error("Unknown proof operation");
    }
  }

  private async diagnostics(ownerId: string): Promise<StorageDiagnostics> {
    const [estimate, persisted] = await Promise.all([
      navigator.storage.estimate().catch(() => undefined), navigator.storage.persisted().catch(() => null),
    ]);
    return {
      backend: "sqlite-wasm-opfs-sahpool", sqliteVersion: String(this.db.selectValue("SELECT sqlite_version()")),
      vectorVersion: String(this.db.selectValue("SELECT vec_version()")), schemaVersion: Number(this.db.selectValue("PRAGMA user_version")),
      integrity: String(this.db.selectValue("PRAGMA integrity_check")), recordCount: Number(this.db.selectValue("SELECT count(*) FROM proof_records")),
      operationCount: Number(this.db.selectValue("SELECT count(*) FROM proof_ops")), ownerId, namespace: this.namespace,
      poolCapacity: this.pool.getCapacity(), persisted, usage: estimate?.usage ?? null, quota: estimate?.quota ?? null,
    };
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* SQLITE_FULL may already roll back. */ }
      throw error;
    }
  }

  private rows(sql: string, bind: Value[] = []): Row[] {
    return this.db.exec({ sql, bind, rowMode: "object", returnValue: "resultRows" }) as Row[];
  }
  private limit(value = 50): number {
    if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error("Limit must be an integer from 1 to 100");
    return value;
  }
  private validateId(id: string): void {
    if (typeof id !== "string" || !id.length || id.length > 128) throw new Error("Invalid record ID");
  }
}
