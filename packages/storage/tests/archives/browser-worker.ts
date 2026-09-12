import { archiveRoundtrip } from "./browser-roundtrip.ts";
import { inspectRetainedCandidate } from "./candidate-reader.ts";
import type {
  ArchiveSqlite,
  ArchivePool,
  ArchiveDatabaseFile,
} from "../../src/worker/archives/snapshot.ts";
import initialize from "../../sqlite/dist/sqlite3.mjs";
import wasmUrl from "../../sqlite/dist/sqlite3.wasm?url";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { withSqliteFileReader } from "../../src/worker/archives/sqlite-file.ts";
import type {
  FileSqlite,
  FileDatabase,
} from "../../src/worker/archives/sqlite-file.ts";
type Database = FileDatabase & { close(): void };
interface Pool {
  OpfsSAHPoolDb: new (name: string) => Database;
  importDb(
    name: string,
    read: () => Promise<Uint8Array | undefined>,
  ): Promise<number>;
  unlink(name: string): boolean;
  pauseVfs(): void;
}
self.onmessage = async (event) => {
  if (event.data.command === "inspect-retained-candidate") {
    try { self.postMessage({ ok: true, result: await inspectRetainedCandidate(event.data.archiveId, event.data.digest) }); }
    catch (error) { self.postMessage({ ok: false, error: String(error) }); }
    return;
  }
  let pool: Pool | undefined,
    db: Database | undefined,
    snapshot: Database | undefined;
  try {
    (
      globalThis as typeof globalThis & { sqlite3ApiConfig: unknown }
    ).sqlite3ApiConfig = { disable: { vfs: { opfs: true, "opfs-wl": true } } };
    const sqlite = (await initialize({
      locateFile: (file: string) => (file.endsWith(".wasm") ? wasmUrl : file),
    })) as FileSqlite & {
      installOpfsSAHPoolVfs(options: object): Promise<Pool>;
    };
    pool = await sqlite.installOpfsSAHPoolVfs({
      name: "archive-copy-proof",
      directory: `/quixi-archive-copy-${event.data.namespace}`,
      initialCapacity: 6,
    });
    db = new pool.OpfsSAHPoolDb("/source.sqlite3");
    db.exec(
      "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE proof(id INTEGER PRIMARY KEY,body BLOB); INSERT INTO proof VALUES(1,zeroblob(5242897));",
    );
    let peakBlock = 0,
      blocks = 0,
      sourceDigest = "",
      copiedBytes = 0;
    await withSqliteFileReader(sqlite, db, async (reader) => {
      let offset = 0;
      const hash = sha256.create();
      copiedBytes = await pool!.importDb("/snapshot.sqlite3", async () => {
        if (offset === reader.byteLength) {
          sourceDigest = bytesToHex(hash.digest());
          return undefined;
        }
        const block = reader.read(offset, 65536);
        offset += block.length;
        blocks++;
        peakBlock = Math.max(peakBlock, block.length);
        hash.update(block);
        await new Promise((resolve) => setTimeout(resolve, 0));
        return block;
      });
    });
    db.exec("INSERT INTO proof VALUES(2,zeroblob(1))");
    snapshot = new pool.OpfsSAHPoolDb("/snapshot.sqlite3");
    if (
      snapshot.selectValue("SELECT count(*) FROM proof") !== 1 ||
      snapshot.selectValue("PRAGMA integrity_check") !== "ok"
    )
      throw new Error("Snapshot is not independently consistent.");
    const snapshotDigest = await withSqliteFileReader(
      sqlite,
      snapshot,
      async (reader) => {
        const hash = sha256.create();
        for (let at = 0; at < reader.byteLength; at += 65536)
          hash.update(reader.read(at, 65536));
        return bytesToHex(hash.digest());
      },
    );
    if (snapshotDigest !== sourceDigest)
      throw new Error("Snapshot bytes differ from the captured source.");
    const roundtrip = await archiveRoundtrip(
      sqlite as ArchiveSqlite,
      pool as ArchivePool,
      db as ArchiveDatabaseFile,
      event.data.namespace,
    );
    self.postMessage({
      ok: true,
      result: {
        roundtrip,
        origin: location.origin,
        userAgent: navigator.userAgent,
        copiedBytes,
        peakBlock,
        blocks,
        sourceDigest,
        snapshotDigest,
        snapshotRows: 1,
        sourceRows: 2,
        integrity: "ok",
        mechanism: "FILE_POINTER/xRead -> SAHPool.importDb(callback)",
        backend: "actual SQLite WASM OPFS SAH-pool",
      },
    });
  } catch (error) {
    self.postMessage({ ok: false, error: String(error) });
  } finally {
    snapshot?.close();
    db?.close();
    if (pool) {
      pool.unlink("/snapshot.sqlite3");
      pool.unlink("/source.sqlite3");
      pool.pauseVfs();
    }
  }
};
