import { loadStorageSqlite } from "../../src/worker/sqlite-module.ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/** Private fixture inspection only: no application client, migrations or writes. */
export async function inspectRetainedCandidate(archiveId: string, digest: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(archiveId) || !/^[0-9a-f]{64}$/.test(digest))
    throw new Error("Invalid retained candidate fixture identity");
  return navigator.locks.request(`quixi:archive:${archiveId}:owner`, { ifAvailable: true }, async lock => {
    if (!lock) throw new Error("Candidate fixture is still owned");
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(`quixi-${archiveId}`);
    const sqlite = await loadStorageSqlite();
    const pool = await sqlite.installOpfsSAHPoolVfs({ name: "quixi-candidate-reader-proof", directory: `/quixi-${archiveId}/database`, initialCapacity: 10 });
    let db: InstanceType<typeof pool.OpfsSAHPoolDb> | undefined;
    try {
      db = new pool.OpfsSAHPoolDb("/archive.sqlite3");
      db.exec("PRAGMA query_only=ON");
      const canonicalRecords = Number(db.selectValue("SELECT count(*) FROM quixi_records"));
      const syncOperations = Number(db.selectValue("SELECT count(*) FROM quixi_sync_ops"));
      const integrity = String(db.selectValue("PRAGMA integrity_check"));
      const blobs = await (await directory.getDirectoryHandle("blobs")).getDirectoryHandle(digest.slice(0, 2));
      const file = await (await blobs.getFileHandle(digest)).getFile();
      const hash = sha256.create();
      for (let at = 0; at < file.size; at += 65536) hash.update(new Uint8Array(await file.slice(at, at + 65536).arrayBuffer()));
      return { canonicalRecords, syncOperations, integrity, blobBytes: file.size, blobSha256: bytesToHex(hash.digest()) };
    } finally { db?.close(); pool.pauseVfs(); }
  });
}
