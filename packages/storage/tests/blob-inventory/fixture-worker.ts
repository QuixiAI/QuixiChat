import { ArchiveDatabase } from '../../src/worker/archive-database.ts';
import type { CanonicalSqlite, SqlValue } from '../../src/worker/canonical/repository.ts';
import type { CanonicalMutation, StorageRequest } from '@quixi/core/contracts';
import type { BlobInventoryFingerprint, BlobInventoryFixture } from './fixture.ts';

const id = () => crypto.randomUUID();
const encode = (value: string) => new TextEncoder().encode(value);
const hash = async (value: Uint8Array<ArrayBuffer>) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', value))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const rows = (db: CanonicalSqlite, sql: string, bind: SqlValue[] = []) => db.exec({ sql, bind, rowMode: 'object', returnValue: 'resultRows' }) as Record<string, SqlValue>[];
async function writeFile(directory: FileSystemDirectoryHandle, name: string, data: Uint8Array<ArrayBuffer>) {
  const file = await directory.getFileHandle(name, { create: true });
  const handle = await (file as FileSystemFileHandle & { createSyncAccessHandle(): Promise<{ truncate(size: number): void; write(bytes: Uint8Array): number; flush(): void; close(): void }> }).createSyncAccessHandle();
  try { handle.truncate(0); if (data.length) handle.write(data); handle.flush(); } finally { handle.close(); }
}
async function physical(directory: FileSystemDirectoryHandle, digest: string, data: Uint8Array<ArrayBuffer>) {
  const blobs = await directory.getDirectoryHandle('blobs', { create: true });
  const prefix = await blobs.getDirectoryHandle(digest.slice(0, 2), { create: true });
  await writeFile(prefix, digest, data);
}
async function fileFingerprints(directory: FileSystemDirectoryHandle, prefix = ''): Promise<{ path: string; bytes: number; sha256: string }[]> {
  const result: { path: string; bytes: number; sha256: string }[] = [];
  for await (const [name, entry] of directory.entries()) {
    const path = prefix + name;
    if (!prefix && name === 'database') continue;
    if (entry.kind === 'directory') result.push(...await fileFingerprints(entry, path + '/'));
    else { const file = await entry.getFile(); result.push({ path, bytes: file.size, sha256: await hash(new Uint8Array(await file.arrayBuffer())) }); }
    if (result.length > 1024) throw new Error('Fixture physical fingerprint exceeded its bound');
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}
async function fingerprint(database: ArchiveDatabase, directory: FileSystemDirectoryHandle): Promise<BlobInventoryFingerprint> {
  const db = (database as unknown as { db: CanonicalSqlite }).db;
  const canonical = rows(db, 'SELECT collection,id,payload FROM quixi_records ORDER BY collection,id');
  const operations = rows(db, 'SELECT * FROM quixi_sync_ops ORDER BY sequence');
  const blobOperations = rows(db, 'SELECT * FROM quixi_blob_operations ORDER BY operation_id');
  const blobCatalog = rows(db, 'SELECT sha256,byte_length,utf8_verified,availability FROM quixi_blob_catalog ORDER BY sha256');
  const blobTransfers = rows(db, 'SELECT * FROM quixi_blob_transfers ORDER BY id');
  const files = await fileFingerprints(directory);
  return { canonicalSha256: await hash(encode(JSON.stringify(canonical))), operationsSha256: await hash(encode(JSON.stringify(operations))), blobOperationsSha256: await hash(encode(JSON.stringify(blobOperations))), blobCatalogSha256: await hash(encode(JSON.stringify(blobCatalog))), blobTransfersSha256: await hash(encode(JSON.stringify(blobTransfers))), blobsSha256: await hash(encode(JSON.stringify(files))), canonicalRecords: canonical.length, syncOperations: operations.length, physicalFiles: files.length, sqliteTemporaryStore: Number(db.selectValue('PRAGMA temp_store')), sqliteTemporaryCacheKiB: Number(db.selectValue('PRAGMA temp.cache_size')) };
}
async function setup(database: ArchiveDatabase, directory: FileSystemDirectoryHandle, archiveId: string, orphanCount: number): Promise<BlobInventoryFixture> {
  const db = (database as unknown as { db: CanonicalSqlite }).db;
  if (Number(db.selectValue('SELECT count(*) FROM quixi_records')) !== 0) throw new Error('Fixture setup requires a fresh empty isolated archive.');
  if (!Number.isSafeInteger(orphanCount) || orphanCount < 0 || orphanCount > 256) throw new Error('Fixture orphan count exceeds its bound.');
  const digests: Record<string, string> = {}, transferIds: Record<string, string> = {}, lengths: Record<string, number> = {};
  const staged = async (name: string, publish = true) => {
    const bytes = encode(`Synthetic inventory fixture ${name}. Original bytes must remain unchanged.`), digest = await hash(bytes);
    digests[name] = digest; lengths[name] = bytes.length;
    const begun = await database.catalog.begin({ operationId: id(), purpose: name === 'text' ? 'canonical_text' : 'attachment', expectedBytes: bytes.length, expectedSha256: digest }, id);
    transferIds[name] = begun.transferId;
    database.catalog.append({ transferId: begun.transferId, sequence: 0, offset: 0, bytes, final: true });
    await database.catalog.finish({ operationId: id(), transferId: begun.transferId, expectedBytes: bytes.length, expectedSha256: digest });
    if (publish) await database.catalog.preparePublication([begun.transferId]);
  };
  for (const name of ['attachment', 'raw', 'text', 'missing', 'catalogMissing', 'wrongSize', 'registeredOrphan', 'publishedProtected', 'importProtected']) await staged(name);
  await staged('verifiedProtected', false);
  const threadId = id(), contextId = id(), messageId = id(), at = Date.now();
  const mutation = <K extends CanonicalMutation['kind']>(kind: K, payload: Extract<CanonicalMutation, { kind: K }>['payload']): CanonicalMutation => ({ version: 1, operationId: id(), kind, recordedAt: at, payload }) as CanonicalMutation;
  const mutations: CanonicalMutation[] = [
    mutation('CreateThread', { thread: { id: threadId, workspaceId: id(), createdAt: at, recordedAt: at, systemPrompt: null, preferredRoute: null, importSourceId: null }, context: { id: contextId, threadId, previousId: null, version: 1, systemPrompt: null, preferredRoute: null, recordedAt: at }, state: { threadId, title: 'Synthetic inventory notebook', tags: [], pinned: false, archived: false, activeLeafMessageId: null, contextSnapshotId: contextId, routingProfile: null, revision: 0 } }),
    mutation('RegisterRawObject', { rawObject: { id: id(), availability: 'available', sha256: digests.raw!, byteLength: lengths.raw!, mediaType: 'application/json', storageRef: `sha256:${digests.raw}` } }),
    mutation('CreateMessage', { message: { id: messageId, threadId, parentId: null, role: 'user', createdAt: at, recordedAt: at, generationId: null, editedFromMessageId: null, partCount: 1, sealed: true }, parts: [{ id: id(), messageId, order: 0, kind: 'Text', data: { textBlob: { sha256: digests.text!, byteLength: lengths.text!, encoding: 'utf-8' } } }] }),
  ];
  for (const name of ['attachment', 'missing', 'catalogMissing', 'wrongSize']) mutations.push(mutation('RegisterAttachment', { attachment: { id: id(), availability: 'available', filename: `synthetic-${name}.txt`, mimeType: 'text/plain', sizeBytes: lengths[name]!, blobSha256: digests[name]!, rawObjectId: null } }));
  database.repository.commit({ transactionId: id(), expectedThreadRevisions: [], stagedBlobIds: [], mutations });
  for (let offset = 0; offset < 96; offset += 24) {
    const extra = Array.from({ length: 24 }, (_, index) => mutation('RegisterAttachment', { attachment: { id: id(), availability: 'available', filename: `synthetic-scale-${offset + index}.txt`, mimeType: 'text/plain', sizeBytes: lengths.attachment!, blobSha256: digests.attachment!, rawObjectId: null } }));
    database.repository.commit({ transactionId: id(), expectedThreadRevisions: [], stagedBlobIds: [], mutations: extra });
  }
  await database.catalog.consumeAfterCommit(['attachment', 'raw', 'text', 'missing', 'catalogMissing', 'wrongSize', 'registeredOrphan', 'importProtected'].map(name => transferIds[name]!));
  // Controlled impossible states are created only here, outside the production
  // client protocol, after valid canonical publication has completed.
  const blobs = await directory.getDirectoryHandle('blobs');
  await (await blobs.getDirectoryHandle(digests.missing!.slice(0, 2))).removeEntry(digests.missing!);
  db.exec({ sql: 'DELETE FROM quixi_blob_catalog WHERE sha256=?', bind: [digests.catalogMissing!] });
  await physical(directory, digests.wrongSize!, encode('short'));
  const unregistered = encode('Synthetic uncatalogued original file.'); digests.physicalOrphan = await hash(unregistered); await physical(directory, digests.physicalOrphan, unregistered);
  for (let index = 0; index < orphanCount; index++) { const bytes = encode(`Synthetic unreferenced physical blob ${index}`); await physical(directory, await hash(bytes), bytes); }
  const staging = await (await directory.getDirectoryHandle('temp', { create: true })).getDirectoryHandle('blob-transfers', { create: true });
  transferIds.strayStage = id(); await writeFile(staging, `${transferIds.strayStage}.stage`, encode('Synthetic stray staging bytes.'));
  await writeFile(blobs, 'unrecognized-private-name.txt', encode('Synthetic unrecognized content; never reveal its name in a finding.'));
  await writeFile(staging, 'unrecognized-stage-name.tmp', encode('Synthetic unrecognized staging content.'));
  const invalidPrefix = await blobs.getDirectoryHandle('not-a-digest-prefix', { create: true });
  await writeFile(invalidPrefix, 'private-child.txt', encode('Synthetic unrecognized child content.'));
  const active = encode('Synthetic unfinished transfer'); digests.activeProtected = await hash(active);
  const begun = await database.catalog.begin({ operationId: id(), purpose: 'attachment', expectedBytes: active.length, expectedSha256: digests.activeProtected }, id);
  transferIds.activeProtected = begun.transferId;
  database.catalog.append({ transferId: begun.transferId, sequence: 0, offset: 0, bytes: active.slice(0, 3), final: false });
  // Production beginNormalizedImport creates the durable protection owner; the
  // fixture-only link represents a resumable group holding verified staging.
  const importId = id();
  await database.execute({ id: id(), kind: 'request', request: { version: 1, requestId: id(), operation: 'beginNormalizedImport', args: { operationId: id(), importId, threadId: id(), mode: 'create', expectedThreadRevision: null, recordedAt: at } } as StorageRequest }, id(), new AbortController().signal);
  await database.execute({ id: id(), kind: 'request', request: { version: 1, requestId: id(), operation: 'stageImportRecords', args: { operationId: id(), importId, sequence: 0, records: [{ collection: 'rawObjects', operationId: id(), recordedAt: at, record: { id: id(), availability: 'available', sha256: digests.importProtected!, byteLength: lengths.importProtected!, mediaType: 'application/json', storageRef: `sha256:${digests.importProtected}` } }] } } as StorageRequest }, id(), new AbortController().signal);
  db.exec({ sql: 'INSERT INTO quixi_import_blob_transfers(import_id,transfer_id) VALUES(?,?)', bind: [importId, transferIds.verifiedProtected!] });
  await database.execute({ id: id(), kind: 'request', request: { version: 1, requestId: id(), operation: 'archiveWorkspace', args: null } }, id(), new AbortController().signal);
  // Baseline starts after the documented recovery of the interrupted fixture
  // upload. A separate live-client case tests an actively writing transfer.
  database.catalog.reconcileOwnerStart();
  return { archiveId, threadId, orphanCount, digests, transferIds, baseline: await fingerprint(database, directory) };
}

self.onmessage = async (event: MessageEvent<{ operation: string; archiveId: string; orphanCount?: number }>) => {
  const { operation, archiveId } = event.data;
  try {
    if (!/^test-[A-Za-z0-9_-]{1,59}$/.test(archiveId)) throw new Error('Refusing fixture access outside an isolated test-* archive.');
    const result = await navigator.locks.request(`quixi:archive:${archiveId}:owner`, async () => {
      const root = await navigator.storage.getDirectory();
      if (operation === 'cleanup') { await root.removeEntry(`quixi-${archiveId}`, { recursive: true }); return; }
      const database = await ArchiveDatabase.open(archiveId, () => {}, { create: operation === 'setup' });
      try {
        const directory = await root.getDirectoryHandle(`quixi-${archiveId}`);
        if (operation === 'setup') return await setup(database, directory, archiveId, event.data.orphanCount ?? 96);
        if (operation === 'fingerprint') return await fingerprint(database, directory);
        if (operation === 'malformed-reference') {
          const db = (database as unknown as { db: CanonicalSqlite }).db, attachmentId = id();
          db.exec({ sql: "INSERT INTO quixi_records(collection,id,payload) VALUES('attachments',?,?)", bind: [attachmentId, JSON.stringify({ id: attachmentId, availability: 'available', filename: 'synthetic-malformed.txt', mimeType: 'text/plain', sizeBytes: 12, blobSha256: null, rawObjectId: null })] });
          return await fingerprint(database, directory);
        }
        if (operation === 'derived-failure') {
          const db = (database as unknown as { db: CanonicalSqlite }).db;
          await database.quiesce();
          db.exec("UPDATE quixi_search_schema SET checksum='0000000000000000000000000000000000000000000000000000000000000000' WHERE version=1");
          return { fault: operation };
        }
        if (operation === 'corrupt-database') {
          const db = (database as unknown as { db: CanonicalSqlite }).db;
          db.exec('CREATE INDEX quixi_fixture_damage ON quixi_records(collection)');
          db.exec('PRAGMA writable_schema=ON');
          db.exec("DELETE FROM sqlite_master WHERE type='index' AND name='quixi_fixture_damage'");
          db.exec('PRAGMA writable_schema=OFF');
          return { fault: operation };
        }
        throw new Error('Unknown fixture operation');
      } finally { await database.close('handles'); }
    });
    self.postMessage({ result });
  } catch (error) { self.postMessage({ error: String(error instanceof Error ? `${error.message}\n${error.stack}` : error) }); }
};
