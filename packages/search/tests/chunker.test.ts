import test from 'node:test';
import assert from 'node:assert/strict';
import { StructuralChunker, chunkText } from '../src/chunker.ts';
import type { LocatedSearchChunk, ChunkSource } from '../src/chunker.ts';
import { validateSearchChunk } from '@quixi/core/model';
const source: ChunkSource = { sourceType: 'message', sourceId: '00000000-0000-4000-8000-000000000001', partId: '00000000-0000-4000-8000-000000000002', sourceDigest: 'a'.repeat(64), contextPrefix: 'A thread > Assistant' };
function coverage(text: string, chunks: LocatedSearchChunk[]): void {
  let end = 0;
  for (const chunk of chunks) {
    assert.deepEqual(validateSearchChunk(chunk), []);
    assert.equal(text.slice(chunk.position.start, chunk.position.end), chunk.text);
    assert(chunk.position.start <= end, 'source gap');
    assert(chunk.position.end > end, 'chunk repeated without source progress');
    assert(chunk.position.end - chunk.position.start <= 4096);
    if (chunk.position.start > 0) assert(!(/[\ud800-\udbff]/.test(text[chunk.position.start - 1]!) && /[\udc00-\udfff]/.test(text[chunk.position.start]!)));
    end = chunk.position.end;
  }
  assert.equal(end, text.length);
}
test('stream fragment boundaries do not change chunks, identity or exact source coverage', () => {
  const text = ('# Heading\n\nRésumé 🌍 and e\u0301. A sentence!\n- list item\n- another\n\n```ts\nconst code = "quoted";\n```\n').repeat(180);
  const expected = [...chunkText(text, source)]; coverage(text, expected);
  for (const size of [1, 2, 7, 127, 4096, 65536]) {
    const chunker = new StructuralChunker(source), actual: LocatedSearchChunk[] = [];
    for (let at = 0; at < text.length; at += size) actual.push(...chunker.push(text.slice(at, at + size)));
    actual.push(...chunker.finish()); assert.deepEqual(actual, expected);
    assert(chunker.peakBufferedCharacters <= 4098);
  }
});
test('long code/identifier and late text remain covered with overlap only at forced splits', () => {
  const text = 'x'.repeat(60_000) + ' 🌍 late_unique_marker';
  const chunks = [...chunkText(text, source)]; coverage(text, chunks);
  assert(chunks.some(chunk => chunk.text.includes('late_unique_marker')));
  assert.equal(chunks[1]!.position.start, 4096 - 64);
  const paragraph = ('A complete paragraph.\n\n').repeat(1000);
  const structural = [...chunkText(paragraph, source)]; coverage(paragraph, structural);
  for (let i = 1; i < structural.length; i++) assert.equal(structural[i]!.position.start, structural[i - 1]!.position.end);
});
test('document and message sources use identical segmentation with distinct navigable identities', () => {
  const text = 'A paragraph.\n\n'.repeat(1000);
  const message = [...chunkText(text, source)];
  const document = [...chunkText(text, { ...source, sourceType: 'document', sourceId: 'document', partId: null, page: 7, sectionPath: ['Chapter', 'Section'] })];
  assert.deepEqual(document.map(chunk => chunk.text), message.map(chunk => chunk.text));
  assert.notEqual(document[0]!.id, message[0]!.id);
  assert.equal(document[0]!.position.page, 7);
  assert.notEqual([...chunkText(text, { ...source, sourceType: 'document', sourceId: 'document', partId: null, page: 8, sectionPath: ['Chapter', 'Section'] })][0]!.id, document[0]!.id);
  assert.deepEqual(document[0]!.position.sectionPath, ['Chapter', 'Section']);
  assert.notEqual([...chunkText(text, { ...source, sourceDigest: 'b'.repeat(64) })][0]!.id, message[0]!.id);
  assert.notEqual([...chunkText(text, { ...source, contextPrefix: 'Renamed > Assistant' })][0]!.id, message[0]!.id);
});
test('injected untruncated token offsets constrain chunks independently of inference weights', () => {
  const text = ('word '.repeat(3000)).trim();
  const tokenizer = { version: 'fixture-word-offsets-v1', offsets: (value: string) => [...value.matchAll(/\S+/gu)].map(match => ({ start: match.index, end: match.index + match[0].length })) };
  const chunks = [...chunkText(text, source, { tokenizer, maxTokens: 32, overlapCharacters: 0 })];
  coverage(text, chunks);
  for (const chunk of chunks) assert(tokenizer.offsets(chunk.text).length <= 32);
  assert(chunks.length > 80);
  assert.equal(chunks[0]!.tokenizerVersion, tokenizer.version);
});
test('bounded fragments, policy, lifetime and malformed token offsets fail explicitly', () => {
  assert.throws(() => new StructuralChunker(source, { maxCharacters: 0 }));
  assert.throws(() => [...new StructuralChunker(source).push('a'.repeat(65537))]);
  assert.throws(() => new StructuralChunker(source, { maxTokens: 32 }));
  assert.throws(() => [...chunkText('a'.repeat(5000), source, { maxTokens: 1, tokenizer: { version: 'bad', offsets: () => [{ start: -1, end: 2 }] } })]);
  const chunker = new StructuralChunker(source); assert.deepEqual([...chunker.finish()], []);
  assert.throws(() => [...chunker.push('late')]);
});
