import test from 'node:test';
import assert from 'node:assert/strict';
import { prepare, analyzeCompatibility } from '../src/request.ts';
import { adapterCatalog, initialProviderCatalogs, AUDIO_MEDIA_TYPES, normalizeAudioMediaType, LIMITS, CompatibilityError, type ProviderInput, type ModelDescription } from '../src/index.ts';
import { input } from './fixtures.ts';

const audioId = crypto.randomUUID();
const clip = new Uint8Array([82, 73, 70, 70, 0, 1, 2, 255]);
const model = (): ModelDescription => adapterCatalog(initialProviderCatalogs()[0]!).find(value => value.id === 'gpt-audio-1.5')!;
const issue = (code: string) => (error: unknown) => error instanceof CompatibilityError && error.issues.some(value => value.code === code);
function request(): ProviderInput {
  const value = input(model().id), messageId = crypto.randomUUID();
  return { ...value, tools: [], messages: [{ role: 'user', parts: [
    { id: crypto.randomUUID(), messageId, order: 0, kind: 'Text', data: { text: 'Describe this recording.' } },
    { id: crypto.randomUUID(), messageId, order: 1, kind: 'Audio', data: { attachmentId: audioId, description: null } },
    { id: crypto.randomUUID(), messageId, order: 2, kind: 'Text', data: { text: 'Keep the answer brief.' } },
  ] }], attachments: { [audioId]: { mediaType: 'audio/wav', bytes: clip } } };
}
const userBlocks = (value: ProviderInput, selected = model()): any[] =>
  (prepare('openai-compatible', value, selected).body.messages as { role: string; content: any[] }[]).find(message => message.role === 'user')!.content;

test('reviewed audio catalog keeps provider audio output separate from implemented text output and declines misleading prices', () => {
  const catalog = initialProviderCatalogs()[0]!, effective = adapterCatalog(catalog);
  assert.equal(catalog.model.id, 'gpt-4.1-mini-2025-04-14');
  assert.deepEqual(effective.map(value => value.id), [catalog.model.id, 'gpt-audio-1.5']);
  const extra = catalog.additionalModels![0]!;
  assert.deepEqual(extra.model.capabilities.inputModalities, ['text', 'audio']);
  assert.deepEqual(extra.model.capabilities.outputModalities, ['text', 'audio']);
  assert.deepEqual(extra.adapterCapabilities.outputModalities, ['text']);
  assert.deepEqual(effective[1]!.raw!.providerOutputModalities, ['text', 'audio']);
  assert.deepEqual(effective[1]!.capabilities.audioMediaTypes, AUDIO_MEDIA_TYPES);
  assert.equal(effective[1]!.capabilities.contextWindow, 128000);
  assert.equal(effective[1]!.capabilities.maxOutputTokens, 16384);
  assert.equal(effective[1]!.capabilities.streaming, 'supported');
  assert.equal(effective[1]!.capabilities.tools, 'supported');
  for (const key of ['images', 'files', 'reasoning', 'structuredOutput'] as const) assert.equal(effective[1]!.capabilities[key], 'unsupported');
  assert.equal(extra.model.pricing, null); assert.equal(effective[1]!.pricing, null);
  assert.ok(extra.limitations.some(value => value.includes('different token rates')));
  assert.equal(initialProviderCatalogs()[1]!.additionalModels, undefined);
  effective[1]!.capabilities.outputModalities = ['audio'];
  assert.deepEqual(extra.adapterCapabilities.outputModalities, ['text'], 'effective catalog copies cannot mutate reviewed facts');
});

test('WAV and MP3 plus historical MIME aliases map exact bytes and canonical order to input_audio', () => {
  for (const [mime, format] of [
    ['audio/wav', 'wav'], ['audio/wave', 'wav'], ['audio/x-wav', 'wav'], ['audio/vnd.wave', 'wav'],
    ['audio/mpeg', 'mp3'], ['audio/mp3', 'mp3'], ['audio/x-mp3', 'mp3'], ['audio/x-mpeg', 'mp3'], ['audio/mpeg3', 'mp3'], ['audio/x-mpeg-3', 'mp3'],
    [' Audio/X-WAV ; codecs=pcm ', 'wav'],
  ]) {
    const value = request(); value.attachments![audioId]!.mediaType = mime!;
    const blocks = userBlocks(value);
    assert.deepEqual(blocks, [
      { type: 'text', text: 'Describe this recording.' },
      { type: 'input_audio', input_audio: { data: Buffer.from(clip).toString('base64'), format } },
      { type: 'text', text: 'Keep the answer brief.' },
    ]);
    const prepared = prepare('openai-compatible', value, model());
    assert.deepEqual(prepared.body.modalities, ['text']); assert.equal(prepared.body.audio, undefined);
    assert.equal(prepared.body.stream, true); assert.equal(prepared.body.max_completion_tokens, 100);
    const report = analyzeCompatibility('openai-compatible', value, model());
    assert.equal(report.sendable, true); assert.equal(report.preserved.byKind.Audio, 1); assert.equal(report.preserved.byKind.Text, 2);
    assert.equal(report.requestBytes, new TextEncoder().encode(JSON.stringify(prepared.body)).length);
  }
  for (const mime of ['application/octet-stream', 'audio/ogg', 'audio/aac', 'video/mp4', 'wav', '']) assert.equal(normalizeAudioMediaType(mime), null);
});

test('audio-only user messages remain content blocks and text-only messages on audio models explicitly request text output', () => {
  const value = request(); value.messages[0]!.parts = [value.messages[0]!.parts[1]!];
  assert.equal(userBlocks(value)[0].type, 'input_audio');
  const textOnly = input(model().id); textOnly.tools = [];
  const prepared = prepare('openai-compatible', textOnly, model());
  assert.deepEqual(prepared.body.modalities, ['text']);
  assert.equal(typeof (prepared.body.messages as any[]).find(value => value.role === 'user').content, 'string');
  const primary = adapterCatalog(initialProviderCatalogs()[0]!)[0]!;
  assert.equal(prepare('openai-compatible', input(primary.id), primary).body.modalities, undefined);
});

test('audio capability, protocol, role, bytes, format, size and occurrence refusals identify the affected part', () => {
  const check = (code: string, mutate: (value: ProviderInput, selected: ModelDescription) => void): void => {
    const value = request(), selected = model(); mutate(value, selected);
    assert.throws(() => prepare(selected.protocol, value, selected), issue(code));
    const report = analyzeCompatibility(selected.protocol, value, selected);
    assert.equal(report.sendable, false);
    assert.ok(report.blocked.some(item => item.kind === 'Audio' && item.code === code));
  };
  check('audio_protocol_unsupported', (_, selected) => { selected.protocol = 'anthropic'; selected.capabilities.systemPromptMode = 'top_level'; });
  check('audio_unsupported', (_, selected) => { selected.capabilities.inputModalities = ['text']; });
  check('audio_unsupported', (_, selected) => { delete selected.capabilities.audioMediaTypes; });
  check('audio_unsupported', (_, selected) => { selected.capabilities.audioMediaTypes = []; });
  for (const role of ['assistant', 'tool', 'system'] as const) check('audio_role', value => { value.messages[0]!.role = role; });
  check('audio_unavailable', value => { value.attachments = {}; });
  check('audio_unavailable', value => { value.attachments![audioId]!.bytes = new Uint8Array(); });
  check('audio_media_unsupported', value => { value.attachments![audioId]!.mediaType = 'audio/ogg'; });
  check('audio_media_unsupported', (_, selected) => { selected.capabilities.audioMediaTypes = ['audio/mpeg']; });
  check('audio_too_large', value => { value.attachments![audioId]!.bytes = new Uint8Array(LIMITS.audioBytes + 1); });
  check('audio_limit', value => {
    const part = value.messages[0]!.parts[1]!;
    value.messages[0]!.parts = Array.from({ length: 21 }, (_, order) => ({ ...part, id: crypto.randomUUID(), order }));
  });
  const twenty = request(), part = twenty.messages[0]!.parts[1]!;
  twenty.messages[0]!.parts = Array.from({ length: 20 }, (_, order) => ({ ...part, id: crypto.randomUUID(), order }));
  assert.equal(analyzeCompatibility('openai-compatible', twenty, model()).preserved.byKind.Audio, 20);
});

for (const kind of ['Audio', 'Image', 'File'] as const) test(`${kind} occurrences share the audio raw request budget before rejected base64 allocation`, () => {
  const value = request(), selected = model(), secondId = crypto.randomUUID(), first = value.messages[0]!.parts[1]!;
  selected.capabilities.inputModalities = ['text', 'audio', 'image', 'file'];
  selected.capabilities.images = 'supported'; selected.capabilities.files = 'supported'; selected.capabilities.fileMediaTypes = ['application/pdf'];
  value.attachments = {
    [audioId]: { mediaType: 'audio/wav', bytes: new Uint8Array(LIMITS.attachmentBytes) },
    [secondId]: { mediaType: kind === 'Image' ? 'image/png' : kind === 'File' ? 'application/pdf' : 'audio/wav', bytes: new Uint8Array([1]) },
  };
  value.messages[0]!.parts = [first, { ...first, id: crypto.randomUUID(), order: 1, kind, data: { attachmentId: kind === 'Audio' ? audioId : secondId, description: null } }];
  const original = globalThis.btoa; let encoded = 0;
  globalThis.btoa = value => { encoded++; return original(value); };
  try { assert.throws(() => prepare('openai-compatible', value, selected), issue('attachment_total_limit')); assert.equal(encoded, 1); }
  finally { globalThis.btoa = original; }
});

test('audio bytes plus text still enforce the final encoded JSON request bound', () => {
  const value = request(); value.attachments![audioId]!.bytes = new Uint8Array(LIMITS.audioBytes);
  const text = value.messages[0]!.parts[0]!;
  assert.equal(text.kind, 'Text');
  if (text.kind === 'Text') text.data = { text: 'x'.repeat(800000) };
  assert.throws(() => prepare('openai-compatible', value, model()), issue('request_limit'));
});

test('audio model applies reviewed Chat Completions parameters, output cap and unknown price', () => {
  const value = request();
  value.parameters = { maxOutputTokens: 16384, temperature: 0.5, topP: 0.9, stopSequences: ['END'] };
  const prepared = prepare('openai-compatible', value, model());
  assert.equal(prepared.body.max_completion_tokens, 16384); assert.equal(prepared.body.temperature, 0.5);
  assert.equal(prepared.body.top_p, 0.9); assert.deepEqual(prepared.body.stop, ['END']);
  assert.equal((prepared.body.messages as any[])[0].role, 'system');
  const report = analyzeCompatibility('openai-compatible', value, model());
  assert.equal(report.pricing, null); assert.equal(report.context.contextWindow, 128000);
  value.parameters.maxOutputTokens = 16385;
  assert.throws(() => prepare('openai-compatible', value, model()), issue('token_limit'));
});
