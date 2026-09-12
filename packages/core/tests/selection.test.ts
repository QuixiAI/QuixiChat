import test from 'node:test';
import assert from 'node:assert/strict';
import { assertArchiveSelection, assertArchiveActivationArgs, assertStorageRequest, canonicalJson, sameArchiveSelection } from '../src/contracts/index.ts';
import type { ArchiveActivationArgs } from '../src/contracts/index.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const review = (): ArchiveActivationArgs => ({
  operationId: id(1), expectedSelection: { archiveId: 'default', selectionRevision: 4 },
  review: { token: id(2), jobId: id(3), expectedActiveArchiveId: 'default', expectedRevision: 101,
    candidate: { archiveId: id(4), schemaVersion: 9, canonicalRecords: 12, syncOperations: 2,
      blobCount: 1, blobBytes: 8192, streamingGenerations: 0, defaultWorkspaceId: id(5), manifestSha256: 'a'.repeat(64) } },
});

test('selection revisions distinguish returned archive identities without conflating history high water', () => {
  const original = { archiveId: 'default', selectionRevision: 0 };
  assertArchiveSelection(original);
  assert.equal(sameArchiveSelection(original, { ...original, selectionRevision: 2 }), false);
  const args = review();
  assert.equal(args.review.expectedRevision, 101);
  assert.equal(args.review.candidate.syncOperations, 2);
  assertStorageRequest({ version: 1, requestId: id(10), operation: 'activateRestoredArchive', args });
  assertStorageRequest({ version: 1, requestId: id(11), operation: 'readArchiveActivationContext', args: null });
  for (const selection of [null, {}, { archiveId: '../quixi', selectionRevision: 0 }, { ...original, selectionRevision: -1 }, { ...original, selectionRevision: 0.5 }, { ...original, selectionRevision: Number.MAX_SAFE_INTEGER + 1 }, { ...original, revision: 0 }])
    assert.throws(() => assertArchiveSelection(selection));
});

test('activation requires every source and candidate field and rejects ignored control metadata', () => {
  const args = review();
  const before = JSON.stringify(args);
  assertArchiveActivationArgs(args);
  assert.equal(JSON.stringify(args), before);
  for (const path of [[], ['expectedSelection'], ['review'], ['review', 'candidate']]) {
    const source = path.reduce((value: any, key) => value[key], args);
    for (const key of Object.keys(source)) {
      const changed: any = structuredClone(args);
      const target = path.reduce((value: any, part) => value[part], changed);
      delete target[key];
      assert.throws(() => assertArchiveActivationArgs(changed), `missing ${[...path, key].join('.')}`);
    }
    const changed: any = structuredClone(args);
    path.reduce((value: any, part) => value[part], changed).ignored = true;
    assert.throws(() => assertArchiveActivationArgs(changed));
  }
  for (const update of [
    (a: any) => { a.review.expectedActiveArchiveId = id(90); },
    (a: any) => { a.review.candidate.archiveId = 'default'; },
    (a: any) => { a.review.candidate.manifestSha256 = 'A'.repeat(64); },
    (a: any) => { a.review.candidate.blobBytes = Infinity; },
    (a: any) => { a.review.candidate.schemaVersion = 0; },
    (a: any) => { a.review.candidate.defaultWorkspaceId = ''; },
  ]) {
    const changed = structuredClone(args); update(changed);
    assert.throws(() => assertArchiveActivationArgs(changed));
  }
});

test('complete normalized activation identity includes counts and review high water', () => {
  const args = review();
  const original = canonicalJson(args as any);
  for (const field of ['canonicalRecords', 'syncOperations', 'blobCount', 'blobBytes', 'streamingGenerations'] as const) {
    const changed = structuredClone(args);
    changed.review.candidate[field]++;
    assertArchiveActivationArgs(changed);
    assert.notEqual(canonicalJson(changed as any), original);
  }
  const changed = structuredClone(args); changed.review.expectedRevision++;
  assert.notEqual(canonicalJson(changed as any), original);
});
