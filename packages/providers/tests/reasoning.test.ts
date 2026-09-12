import test from 'node:test';
import assert from 'node:assert/strict';
import { Normalizer, SSEDecoder, LIMITS, type ProviderEvent } from '../src/index.ts';
import { sse } from './fixtures.ts';
const ev = (type: string, fields: Record<string, unknown> = {}) => sse({ type, ...fields }, type);
const start = ev('message_start', { message: { id: 'synthetic-thinking', model: 'synthetic-model', usage: {} } });
const block = (index: number, content_block: unknown) => ev('content_block_start', { index, content_block });
const delta = (index: number, delta: unknown) => ev('content_block_delta', { index, delta });
const stop = (index: number) => ev('content_block_stop', { index });
const end = ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: {} }) + ev('message_stop');
function read(source: string, step = 31) {
  const parser = new SSEDecoder(), normalizer = new Normalizer('anthropic');
  const events: ProviderEvent[] = [], bytes = new TextEncoder().encode(source);
  for (let i = 0; i < bytes.length; i += step)
    for (const record of parser.push(bytes.subarray(i, i + step), i + step >= bytes.length)) events.push(...normalizer.accept(record));
  return { normalizer, events, receipts: events.filter(e => e.type === 'reasoning_block') };
}
test('closed thinking joins exact text and split signatures across byte-fragmented SSE', () => {
  const text = '\ufeff first\n\"🧪\" ';
  const result = read(start + block(0, { type: 'thinking', thinking: text, signature: '' }) + delta(0, { type: 'thinking_delta', thinking: '\ud83e' }) + delta(0, { type: 'thinking_delta', thinking: '\uddea\r\nlast' }) + delta(0, { type: 'signature_delta', signature: 'opaque+' }) + delta(0, { type: 'signature_delta', signature: '/==\n' }) + stop(0) + end, 1);
  assert.equal(result.normalizer.ended, true);
  assert.deepEqual(result.receipts, [{ type: 'reasoning_block', index: 0, startRecord: 2, endRecord: 7, block: { type: 'thinking', thinking: text + '🧪\r\nlast', signature: 'opaque+/==\n' } }]);
  assert.equal(result.events.filter(e => e.type === 'artifact').length, 5);
});
test('omitted display and encrypted redacted blocks retain exact opaque values and indexes', () => {
  const result = read(start + block(2, { type: 'thinking', thinking: '', signature: 'opaque' }) + stop(2) + block(4, { type: 'redacted_thinking', data: 'opaque+/=\n' }) + stop(4) + end);
  assert.deepEqual(result.receipts.map(e => [e.index, e.block]), [[2, { type: 'thinking', thinking: '', signature: 'opaque' }], [4, { type: 'redacted_thinking', data: 'opaque+/=\n' }]]);
});
test('an interrupted block never emits a complete receipt, even after its signature', () => {
  for (const tail of ['', delta(0, { type: 'signature_delta', signature: 'opaque' })]) {
    const result = read(start + block(0, { type: 'thinking', thinking: 'partial' }) + tail);
    assert.equal(result.receipts.length, 0); assert.equal(result.normalizer.ended, false);
  }
  assert.throws(() => read(start + block(0, { type: 'thinking', thinking: 'partial' }) + stop(0)), /signature/);
});
test('unknown, malformed and out-of-order reasoning fields cannot become a receipt', () => {
  for (const source of [
    block(0, { type: 'thinking', thinking: 42 }),
    block(0, { type: 'thinking', thinking: '', extra: 'future field' }),
    block(0, { type: 'redacted_thinking', data: '' }),
    block(0, { type: 'thinking', thinking: '' }) + delta(0, { type: 'signature_delta', signature: 42 }),
    block(0, { type: 'thinking', thinking: '' }) + delta(0, { type: 'future_delta', value: 'x' }),
    block(0, { type: 'thinking', thinking: '', signature: 'opaque' }) + delta(0, { type: 'thinking_delta', thinking: 'late' }),
    block(0, { type: 'redacted_thinking', data: 'opaque' }) + delta(0, { type: 'thinking_delta', thinking: 'x' }),
    block(0, { type: 'thinking', thinking: '' }) + delta(0, { type: 'thinking_delta', thinking: 'x', extra: 'lost' }),
  ]) assert.throws(() => read(start + source), /thinking/i);
});
test('duplicate block indexes, deltas after closure and unsigned closure fail', () => {
  const closed = block(0, { type: 'thinking', thinking: '', signature: 'opaque' }) + stop(0);
  assert.throws(() => read(start + closed + block(0, { type: 'thinking', thinking: '' })), /duplicate/);
  assert.throws(() => read(start + closed + delta(0, { type: 'signature_delta', signature: 'late' })), /open content block/);
});
test('thinking capture limits escaped bytes before concatenating fragments', () => {
  const fragment = '\n'.repeat(40_000);
  const source = start + block(0, { type: 'thinking', thinking: '' }) + Array.from({ length: 4 }, () => delta(0, { type: 'thinking_delta', thinking: fragment })).join('');
  assert.throws(() => read(source, 8192), /byte limit/);
  assert.equal(LIMITS.reasoningBlockBytes, 262144);
});
test('total thinking credit is not reset when a block closes', () => {
  let source = start;
  for (let i = 0; i < 6; i++) source += block(i, { type: 'thinking', thinking: 'x'.repeat(200_000), signature: 'opaque' }) + stop(i);
  assert.throws(() => read(source, 65536), /byte limit/);
});
