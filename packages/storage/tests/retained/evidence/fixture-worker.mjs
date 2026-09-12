import { loadStorageSqlite } from '../../src/worker/sqlite-module.ts';
import { isQuixiId } from '@quixi/core/model';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const directory = async (archiveId, create = false) => (await navigator.storage.getDirectory()).getDirectoryHandle(archiveId === 'default' ? 'quixi' : `quixi-${archiveId}`, { create });
async function snapshot(handle, prefix = '') {
  const records = [];
  for await (const [name, entry] of handle.entries()) {
    const path = prefix + name;
    if (entry.kind === 'directory') records.push(...await snapshot(entry, path + '/'));
    else {
      const file = await entry.getFile(), digest = sha256.create();
      if (file.size > 64 * 1048576) throw new Error('Fixture file exceeds its bound');
      for (let at = 0; at < file.size; at += 65536) digest.update(new Uint8Array(await file.slice(at, at + 65536).arrayBuffer()));
      records.push({ path, bytes: file.size, sha256: bytesToHex(digest.digest()) });
    }
    if (records.length > 512) throw new Error('Fixture inventory bound exceeded');
  }
  return records.sort((a, b) => a.path.localeCompare(b.path));
}
async function copy(source, target) {
  for await (const [name, entry] of source.entries()) {
    if (entry.kind === 'directory') await copy(entry, await target.getDirectoryHandle(name, { create: true }));
    else {
      const file = await entry.getFile(), out = await (await target.getFileHandle(name, { create: true })).createSyncAccessHandle();
      try {
        out.truncate(0);
        for (let at = 0; at < file.size; at += 65536) out.write(new Uint8Array(await file.slice(at, at + 65536).arrayBuffer()), { at });
        out.flush();
      } finally { out.close(); }
    }
  }
}
self.onmessage = ({ data }) => void (async () => {
  const { command, archiveId } = data;
  try {
    if (!(archiveId === 'default' || isQuixiId(archiveId))) throw new Error('Invalid private fixture archive');
    const result = await navigator.locks.request(`quixi:archive:${archiveId}:owner`, { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('Fixture archive still has an owner');
      if (command === 'missing') {
        if (archiveId === 'default') throw new Error('Missing fixture cannot replace default');
        await (await (await directory(archiveId, true)).getDirectoryHandle('database', { create: true })).getDirectoryHandle('.opaque', { create: true });
        return true;
      }
      const root = await directory(archiveId);
      if (command === 'snapshot') return snapshot(root);
      if (command === 'clone') {
        if (!isQuixiId(data.targetId)) throw new Error('Clone destination must be a fixture UUID');
        return navigator.locks.request(`quixi:archive:${data.targetId}:owner`, { ifAvailable: true }, async targetLock => {
          if (!targetLock) throw new Error('Clone destination is owned');
          const destination = await directory(data.targetId, true);
          await copy(root, destination); return snapshot(destination);
        });
      }
      if (archiveId === 'default') throw new Error('Private damage fixtures only modify cloned UUID namespaces');
      if (command === 'metadata') {
        const opaque = await (await root.getDirectoryHandle('database')).getDirectoryHandle('.opaque');
        for await (const entry of opaque.values()) {
          const file = await entry.getFile(), head = new Uint8Array(await file.slice(0, 524).arrayBuffer());
          if (new TextDecoder().decode(head.subarray(0, head.indexOf(0))) !== '/archive.sqlite3') continue;
          const handle = await entry.createSyncAccessHandle();
          try { head[516] ^= 255; handle.write(head, { at: 0 }); handle.flush(); } finally { handle.close(); }
          return true;
        }
        throw new Error('Fixture database slot is absent');
      }
      const sqlite = await loadStorageSqlite();
      const pool = await sqlite.installOpfsSAHPoolVfs({ name: 'retained-private-fixture', directory: `/quixi-${archiveId}/database`, initialCapacity: 1 });
      let db;
      try {
        db = new pool.OpfsSAHPoolDb('/archive.sqlite3', 'w');
        if (command === 'ledger8') db.exec('DELETE FROM quixi_schema_migrations WHERE version=9');
        else if (command === 'ledger7') db.exec('DELETE FROM quixi_schema_migrations WHERE version>=8');
        else if (command === 'bad-ledger') db.exec("UPDATE quixi_schema_migrations SET checksum='wrong' WHERE version=1");
        else if (command === 'future-ledger') db.exec("INSERT INTO quixi_schema_migrations VALUES(10,'future','unknown')");
        else if (command === 'hot') {
          db.exec('PRAGMA cache_size=1; BEGIN IMMEDIATE; CREATE TABLE retained_interrupted_fixture(value BLOB); INSERT INTO retained_interrupted_fixture VALUES(zeroblob(2097152));');
          self.postMessage({ ok: true, held: true, files: pool.getFileNames() });
          await new Promise(() => {}); // Driver terminates this actual uncommitted SQLite worker.
        } else throw new Error('Unknown private fixture command');
        return true;
      } finally { db?.close(); pool.pauseVfs(); }
    });
    self.postMessage({ ok: true, result });
  } catch (error) { self.postMessage({ ok: false, error: String(error) }); }
})();
