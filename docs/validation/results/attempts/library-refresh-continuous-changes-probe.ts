import assert from 'node:assert/strict';
import { createLibraryController } from '/Users/eric/QuixiChat/packages/app/src/runtime/library.ts';
import type { AppServices } from '/Users/eric/QuixiChat/packages/app/src/runtime/library.ts';
const id = crypto.randomUUID();
const page = { items: [], nextCursor: null, bytes: 2 };
const thread = { thread: { id, importSourceId: null }, state: { activeLeafMessageId: null }, context: { id: crypto.randomUUID() } };
const reads: { resolve: (value: unknown) => void; started: number }[] = [];
const waiters = new Map<number, () => void>();
let changed: (() => void) | null = null;
let snapshotsWithThread = 0;
const started = performance.now();
const storage = {
  async request(_id: string, operation: string) {
    if (operation === 'archiveWorkspace') return { workspaceId: crypto.randomUUID() };
    if (['listLibrary', 'readConversationWindow', 'readEntities', 'readMessageChildren'].includes(operation)) return page;
    if (operation === 'readThreadView') return new Promise(resolve => {
      const index = reads.length;
      reads.push({ resolve, started: Math.round(performance.now() - started) });
      waiters.get(index)?.(); waiters.delete(index);
    });
    throw new Error(`Unexpected operation ${operation}`);
  },
  onChange(listener: () => void) { changed = listener; return () => { changed = null; }; },
};
const library = createLibraryController({ storage } as unknown as AppServices);
library.subscribe(() => { if (library.getSnapshot().thread) snapshotsWithThread++; });
const waitRead = (index: number): Promise<void> => reads[index] ? Promise.resolve() : new Promise(resolve => waiters.set(index, resolve));
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const timeout = setTimeout(() => { throw new Error('Bounded probe deadline elapsed'); }, 5000);
try {
  await library.initialize();
  const opening = library.open(id);
  await waitRead(0);
  const cycles = 5;
  for (let index = 0; index < cycles; index++) {
    assert(changed); changed();
    // Each real 200 ms onChange refresh timer starts another real controller read
    // before the preceding >200 ms read is allowed to complete.
    await waitRead(index + 1);
    reads[index]!.resolve(thread);
    await tick();
    assert.equal(library.getSnapshot().thread, null);
  }
  await opening;
  assert.equal(snapshotsWithThread, 0);
  reads[cycles]!.resolve(thread);
  await tick();
  assert.equal(library.getSnapshot().thread?.thread.id, id);
  console.log(JSON.stringify({ result: 'starvation reproduced while notifications continue; publication recovers after notifications stop', changeCycles: cycles, viewReads: reads.length, supersededCompletions: cycles, publicationsBeforeLast: 0, publicationsAfterLast: snapshotsWithThread, readStartMs: reads.map(value => value.started), initialOpenResolvedBeforeAnyThreadPublication: true }));
} finally { clearTimeout(timeout); await library.dispose(); }
