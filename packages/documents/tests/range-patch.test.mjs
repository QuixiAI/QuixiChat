import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { patchedSha256, rangeBytes, sha256, installPatch, patchParser } from '../tooling/pdfjs-range-patch.mjs';

const require = createRequire(import.meta.url);
const source = await readFile(require.resolve('pdfjs-dist/build/pdf.worker.mjs'), 'utf8');
assert.equal(sha256(source), patchedSha256);
const start = source.indexOf('  async sendRequest(begin, end)', source.indexOf('class ChunkedStreamManager'));
const end = source.indexOf('  requestAllChunks(', start);
assert.ok(start > 0 && end > start);
// Execute the actual installed transport methods, including upstream read/abort
// behavior. Browser tests separately exercise the complete parser and storage.
const Manager = runInNewContext(`(class {
  #aborted = false;
  abort() { this.#aborted = true; }
  ${source.slice(start, end)}
})`, {
  arrayBuffersToBytes(chunks) {
    const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    assert.ok(size <= rangeBytes, 'range assembly must fit the transfer cap');
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { output.set(new Uint8Array(chunk), offset); offset += chunk.byteLength; }
    return output;
  },
});

test('near-cap grouped range delivers every byte with bounded sequential complete replies', async () => {
  const manager = new Manager();
  let active = 0, peak = 0, delivered = 65536, calls = 0;
  const end = 31 * rangeBytes + 173;
  manager.pdfStream = {
    getRangeReader(begin, finish) {
      calls++; peak = Math.max(peak, ++active);
      assert.equal(begin, delivered);
      assert.ok(finish - begin <= rangeBytes);
      let at = begin;
      return { async read() {
        await Promise.resolve();
        if (at === finish) { active--; return { done: true }; }
        const bytes = new Uint8Array(Math.min(65536, finish - at));
        for (let i = 0; i < bytes.length; i++) bytes[i] = (at + i) % 251;
        at += bytes.length;
        return { value: bytes.buffer, done: false };
      } };
    },
  };
  manager.onReceiveData = ({ chunk, begin }) => {
    assert.equal(begin, delivered);
    const bytes = new Uint8Array(chunk);
    for (let i = 0; i < bytes.length; i++) assert.equal(bytes[i], (begin + i) % 251);
    delivered += bytes.length;
  };
  await manager.sendRequest(delivered, end);
  assert.equal(delivered, end);
  assert.equal(calls, 31);
  assert.equal(active, 0);
  assert.equal(peak, 1);
});

test('abort during a range discards its bytes and starts no later ranges', async () => {
  const manager = new Manager();
  let calls = 0;
  manager.pdfStream = { getRangeReader() {
    calls++;
    return { async read() { manager.abort(); return { value: new ArrayBuffer(65536), done: false }; } };
  } };
  manager.onReceiveData = () => assert.fail('aborted bytes must not publish');
  await manager.sendRequest(0, rangeBytes * 3);
  assert.equal(calls, 1);
});

test('range failure propagates without requesting subsequent slices', async () => {
  const manager = new Manager();
  const failure = new Error('source read failed');
  let calls = 0;
  manager.pdfStream = { getRangeReader() { calls++; return { async read() { throw failure; } }; } };
  await assert.rejects(manager.sendRequest(0, rangeBytes * 3), error => error === failure);
  assert.equal(calls, 1);
});

test('installation is idempotent and unknown upstream bytes are refused', async () => {
  assert.equal((await installPatch()).parserSha256, patchedSha256);
  assert.equal(await readFile(require.resolve('pdfjs-dist/build/pdf.worker.mjs'), 'utf8'), source);
  assert.throws(() => patchParser(source + '\n'), /Unexpected PDF.js parser bytes/);
});
