import { loadStorageSqlite } from '../../src/worker/sqlite-module.ts';
import { CANONICAL_MIGRATIONS } from '../../migrations/index.ts';
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
      if (command === 'database-bytes') {
        const opaque = await (await root.getDirectoryHandle('database')).getDirectoryHandle('.opaque');
        for await (const entry of opaque.values()) {
          const file = await entry.getFile(), head = new Uint8Array(await file.slice(0, 512).arrayBuffer());
          if (new TextDecoder().decode(head.subarray(0, head.indexOf(0))) !== '/archive.sqlite3') continue;
          const digest = sha256.create();
          for (let at = 4096; at < file.size; at += 65536) digest.update(new Uint8Array(await file.slice(at, Math.min(file.size, at + 65536)).arrayBuffer()));
          return { byteLength: file.size - 4096, sha256: bytesToHex(digest.digest()) };
        }
        throw new Error('Fixture database slot is absent');
      }
      if (command === 'clone') {
        if (!isQuixiId(data.targetId)) throw new Error('Clone destination must be a fixture UUID');
        return navigator.locks.request(`quixi:archive:${data.targetId}:owner`, { ifAvailable: true }, async targetLock => {
          if (!targetLock) throw new Error('Clone destination is owned');
          const destination = await directory(data.targetId, true);
          await copy(root, destination); return snapshot(destination);
        });
      }
      if (archiveId === 'default') throw new Error('Private damage fixtures only modify cloned UUID namespaces');
      if (command === 'plant-blob') {
        const content = new TextEncoder().encode('rescue blob content 😀 '.repeat(1000)), digest = bytesToHex(sha256(content));
        const bucket = await (await root.getDirectoryHandle('blobs', { create: true })).getDirectoryHandle(digest.slice(0, 2), { create: true });
        for (const [fileName, bytes] of [[digest, content], ['junk.tmp', new Uint8Array([1, 2, 3])]]) {
          const handle = await (await bucket.getFileHandle(fileName, { create: true })).createSyncAccessHandle();
          try { handle.truncate(0); handle.write(bytes, { at: 0 }); handle.flush(); } finally { handle.close(); }
        }
        return { sha256: digest, byteLength: content.length };
      }
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
        if (command === 'ledger8') db.exec('DELETE FROM quixi_schema_migrations WHERE version>8');
        else if (command === 'ledger7') db.exec('DELETE FROM quixi_schema_migrations WHERE version>=8');
        else if (command === 'bad-ledger') db.exec("UPDATE quixi_schema_migrations SET checksum='wrong' WHERE version=1");
        else if (command === 'future-ledger') db.exec("INSERT INTO quixi_schema_migrations SELECT max(version)+1,'future','unknown' FROM quixi_schema_migrations");
        else if (command === 'downgrade') {
          // Reverse every migration after the requested version structurally:
          // drop the objects later migrations introduced or redefined and
          // recreate the historical definitions, then trim the ledger. The
          // result is checked against a fresh database built from the
          // immutable migrations 1..version; search, extraction and archive
          // job tables outside the migrations stay as the clone had them.
          const version = Number(data.targetId);
          if (!Number.isInteger(version) || version < 1 || version >= CANONICAL_MIGRATIONS.length) throw new Error('Downgrade version must precede the current schema');
          const objects = database => database.exec({ sql: "SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name", rowMode: 'object', returnValue: 'resultRows' });
          const key = object => `${object.type}\n${object.name}\n${object.sql}`;
          const model = async upTo => {
            const scratch = await sqlite.installOpfsSAHPoolVfs({ name: `retained-model-${upTo}`, directory: `/retained-model-${upTo}`, initialCapacity: 4 });
            const built = new scratch.OpfsSAHPoolDb('/model.sqlite3', 'c');
            try {
              built.exec('CREATE TABLE IF NOT EXISTS quixi_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL) STRICT');
              for (const migration of CANONICAL_MIGRATIONS.filter(item => item.version <= upTo)) built.exec(migration.sql);
              return objects(built);
            } finally { built.close(); scratch.unlink('/model.sqlite3'); scratch.pauseVfs(); }
          };
          const want = await model(version), all = await model(CANONICAL_MIGRATIONS.length);
          const wantKeys = new Set(want.map(key)), wantNames = new Set(want.map(object => object.name));
          const remove = all.filter(object => !wantKeys.has(key(object))).sort((a, b) => Number(a.type === 'table') - Number(b.type === 'table'));
          for (const object of remove) db.exec(`DROP ${object.type.toUpperCase()} IF EXISTS "${object.name}"`);
          const have = new Set(objects(db).map(key));
          const recreate = want.filter(object => !have.has(key(object)) && object.sql);
          for (const object of recreate) db.exec(object.sql);
          db.exec({ sql: 'DELETE FROM quixi_schema_migrations WHERE version>?', bind: [version] });
          const after = objects(db), afterKeys = new Set(after.map(key));
          const matchesFresh = want.every(object => afterKeys.has(key(object))) && !after.some(object => !wantNames.has(object.name) && all.some(item => item.name === object.name));
          return { dropped: remove.length, recreated: recreate.length, matchesFresh, ledger: Number(db.selectValue('SELECT max(version) FROM quixi_schema_migrations')), integrity: String(db.selectValue('PRAGMA integrity_check')) };
        }
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
