import test from 'node:test';
import assert from 'node:assert/strict';
import { assertBlobInventoryArgs } from '../src/contracts/blob-inventory.ts';
import { assertStorageRequest } from '../src/contracts/storage.ts';
import type { StorageRequest } from '../src/contracts/storage.ts';

const scanId = crypto.randomUUID();
test('inventory commands require a closed scan identity and expose no deletion arguments', () => {
  for (const operation of ['beginBlobInventory', 'blobInventoryStatus', 'cancelBlobInventory'] as const) {
    assert.doesNotThrow(() => assertBlobInventoryArgs(operation, { scanId }));
    for (const args of [null, [], {}, { scanId: 'other' }, { scanId, delete: true }, { scanId, path: '../database' }]) assert.throws(() => assertBlobInventoryArgs(operation, args));
  }
});
test('inventory work is bounded independently of caller input size', () => {
  for (const maxItems of [1, 64]) assert.doesNotThrow(() => assertBlobInventoryArgs('advanceBlobInventory', { scanId, maxItems }));
  for (const maxItems of [0, -1, 65, 1.5, Infinity, NaN, '64', null, undefined]) assert.throws(() => assertBlobInventoryArgs('advanceBlobInventory', { scanId, maxItems }));
  assert.throws(() => assertBlobInventoryArgs('advanceBlobInventory', { scanId, maxItems: 1, unchecked: true }));
});
test('inventory findings have bounded pages and opaque bounded cursors', () => {
  const page = { maxItems: 64, maxBytes: 65_536, cursor: null };
  assert.doesNotThrow(() => assertBlobInventoryArgs('readBlobInventoryFindings', { scanId, page }));
  assert.doesNotThrow(() => assertBlobInventoryArgs('readBlobInventoryFindings', { scanId, page: { maxItems: 1, maxBytes: 1024, cursor: 'opaque-scan-cursor' } }));
  for (const change of [{ maxItems: 65 }, { maxItems: 0 }, { maxItems: '1' }, { maxBytes: 65_537 }, { maxBytes: 1023 }, { cursor: 'x'.repeat(257) }, { cursor: 1 }, { rawContent: true }]) assert.throws(() => assertBlobInventoryArgs('readBlobInventoryFindings', { scanId, page: { ...page, ...change } }));
});
test('public storage envelopes route inventory through the same strict validation', () => {
  const request = { version: 1, requestId: crypto.randomUUID(), operation: 'advanceBlobInventory', args: { scanId, maxItems: 16 } };
  assert.doesNotThrow(() => assertStorageRequest(request as StorageRequest));
  assert.throws(() => assertStorageRequest({ ...request, args: { ...request.args, maxItems: 1000 } } as StorageRequest));
  assert.throws(() => assertStorageRequest({ ...request, args: { ...request.args, deleteOrphans: true } } as unknown as StorageRequest));
});
