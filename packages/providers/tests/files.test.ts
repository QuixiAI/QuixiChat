import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createWebHost } from '../../../apps/web/src/host/index.ts';
import { prepare, analyzeCompatibility } from '../src/request.ts';
import { adapterCatalog, initialProviderCatalogs, createAnthropicAdapter, createOpenAICompatibleAdapter, CompatibilityError, FILE_MEDIA_TYPES, LIMITS, type ProviderInput, type Protocol, type ModelDescription } from '../src/index.ts';
import { input, fixture } from './fixtures.ts';
const pdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n%%EOF');
const attachmentId = crypto.randomUUID();
const imageId = crypto.randomUUID();
const issue = (code: string) => (error: unknown): boolean => error instanceof CompatibilityError && error.issues.some(value => value.code === code);
const catalog = (protocol: Protocol): ModelDescription => adapterCatalog(initialProviderCatalogs().find(value => value.model.protocol === protocol)!)[0]!;
function request(protocol: Protocol): ProviderInput {
  const model = catalog(protocol), base = input(model.id), messageId = crypto.randomUUID();
  return { ...base, tools: [], messages: [{ role: 'user', parts: [
    { id: crypto.randomUUID(), messageId, order: 0, kind: 'Text', data: { text: 'Inspect this PDF.' } },
    { id: crypto.randomUUID(), messageId, order: 1, kind: 'File', data: { attachmentId, description: null } },
  ] }], attachments: { [attachmentId]: { mediaType: 'application/pdf', bytes: pdf, filename: 'review.pdf' } } };
}
for (const protocol of ['openai-compatible', 'anthropic'] as const) {
  test(`${protocol}: reviewed existing model maps a PDF and text in canonical order with exact bytes`, () => {
    const value = request(protocol), model = catalog(protocol);
    assert.deepEqual(model.capabilities.fileMediaTypes, FILE_MEDIA_TYPES);
    assert.equal(model.capabilities.files, 'supported');
    const prepared = prepare(protocol, value, model);
    assert.equal(prepared.path, protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions');
    assert.equal(prepared.body.model, model.id);
    const messages = prepared.body.messages as { role: string; content: any[] }[];
    const blocks = messages.find(value => value.role === 'user')!.content;
    assert.equal(blocks[0].text, 'Inspect this PDF.');
    const block = blocks[1];
    const data = protocol === 'anthropic' ? block.source.data : block.file.file_data.slice('data:application/pdf;base64,'.length);
    assert.deepEqual(new Uint8Array(Buffer.from(data, 'base64')), pdf);
    if (protocol === 'anthropic') assert.deepEqual(block, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: 'review.pdf' });
    else assert.deepEqual(block, { type: 'file', file: { filename: 'review.pdf', file_data: `data:application/pdf;base64,${data}` } });
    const report = analyzeCompatibility(protocol, value, model);
    assert.equal(report.sendable, true); assert.equal(report.preserved.byKind.File, 1); assert.equal(report.preserved.byKind.Text, 1);
    assert.equal(report.requestBytes, new TextEncoder().encode(JSON.stringify(prepared.body)).length);
    delete value.attachments![attachmentId]!.filename;
    const fallback = (prepare(protocol, value, model).body.messages as { role: string; content: any[] }[]).find(value => value.role === 'user')!.content[1];
    assert.equal(protocol === 'anthropic' ? fallback.title : fallback.file.filename, 'attachment.pdf');
    value.attachments![attachmentId]!.filename = ' report café.pdf';
    assert.equal(analyzeCompatibility(protocol, value, model).sendable, true);
  });
  test(`${protocol}: PDF capability, bytes, roles, MIME, filename, size and count refusals are explicit`, () => {
    const capable = catalog(protocol);
    for (const mutate of [
      (model: ModelDescription) => { model.capabilities.files = 'unknown'; },
      (model: ModelDescription) => { model.capabilities.inputModalities = ['text', 'image']; },
      (model: ModelDescription) => { delete model.capabilities.fileMediaTypes; },
      (model: ModelDescription) => { model.capabilities.fileMediaTypes = []; },
    ]) { const model = structuredClone(capable); mutate(model); assert.throws(() => prepare(protocol, request(protocol), model), issue('files_unsupported')); }
    const check = (code: string, mutate: (value: ProviderInput) => void): void => {
      const value = request(protocol); mutate(value);
      assert.throws(() => prepare(protocol, value, capable), issue(code));
      const report = analyzeCompatibility(protocol, value, capable);
      assert.equal(report.sendable, false); assert(report.blocked.some(value => value.kind === 'File' && value.code === code));
    };
    check('file_role', value => { value.messages = [{ ...value.messages[0]!, role: 'assistant' }]; });
    check('file_unavailable', value => { value.attachments = {}; });
    check('file_unavailable', value => { value.attachments![attachmentId]!.bytes = new Uint8Array(); });
    check('file_media_unsupported', value => { value.attachments![attachmentId]!.mediaType = 'text/plain'; });
    check('file_media_unsupported', value => { value.attachments![attachmentId]!.mediaType = 'application/zip'; value.attachments![attachmentId]!.bytes = new Uint8Array(); });
    for (const filename of ['', '../secret.pdf', 'bad\nname.pdf', 'x'.repeat(256)])
      check('file_name', value => { value.attachments![attachmentId]!.filename = filename; });
    check('file_too_large', value => { value.attachments![attachmentId]!.bytes = new Uint8Array(LIMITS.fileBytes + 1); });
    check('file_limit', value => { const file = value.messages[0]!.parts[1]!; value.messages = [{ role: 'user', parts: Array.from({ length: LIMITS.filesPerRequest + 1 }, (_, order) => ({ ...file, id: crypto.randomUUID(), order })) }]; });
    const twenty = request(protocol), file = twenty.messages[0]!.parts[1]!;
    twenty.messages = [{ role: 'user', parts: Array.from({ length: LIMITS.filesPerRequest }, (_, order) => ({ ...file, id: crypto.randomUUID(), order })) }];
    assert.equal(analyzeCompatibility(protocol, twenty, capable).preserved.byKind.File, 20);
  });
  test(`${protocol}: repeated PDFs and mixed image/file occurrences share a pre-base64 raw byte bound`, () => {
    for (const mixed of [false, true]) {
      const value = request(protocol), first = value.messages[0]!.parts[1]!;
      value.attachments = { [attachmentId]: { mediaType: 'application/pdf', bytes: new Uint8Array(LIMITS.attachmentBytes) }, [imageId]: { mediaType: 'image/png', bytes: new Uint8Array([1]) } };
      value.messages = [{ role: 'user', parts: [first, { ...first, id: crypto.randomUUID(), order: 2, kind: mixed ? 'Image' : 'File', data: { attachmentId: mixed ? imageId : attachmentId, description: null } }] }];
      const original = globalThis.btoa; let encoded = 0;
      globalThis.btoa = value => { encoded++; return original(value); };
      try { assert.throws(() => prepare(protocol, value, catalog(protocol)), issue('attachment_total_limit')); assert.equal(encoded, 1, 'refused bytes are never base64 allocated'); }
      finally { globalThis.btoa = original; }
    }
  });
  test(`${protocol}: final four-MiB JSON cap still rejects a valid raw-size PDF plus text`, () => {
    const value = request(protocol), text = value.messages[0]!.parts[0]!;
    assert.equal(text.kind, 'Text'); if (text.kind === 'Text') text.data = { text: 'x'.repeat(800000) };
    value.attachments![attachmentId]!.bytes = new Uint8Array(LIMITS.fileBytes);
    assert.throws(() => prepare(protocol, value, catalog(protocol)), issue('request_limit'));
  });
}

test('both adapters count/analyze/stream the same reviewed PDF mapping, with no dispatch on unsupported files', async () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  const requests: { path: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ path: req.url!, body });
    if (req.url === '/v1/messages/count_tokens') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ input_tokens: 42 })); }
    else { res.setHeader('content-type', 'text/event-stream'); res.end(fixture(req.url === '/v1/messages' ? 'anthropic' : 'openai-compatible')); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    for (const protocol of ['openai-compatible', 'anthropic'] as const) {
      const binding = { providerId: protocol, accountId: 'fixture', destinationId: protocol, transportId: 'fixture' };
      const host = createWebHost({ destinations: [{ binding, baseUrl: `http://127.0.0.1:${port}`, allowInsecureLoopback: true, routes: ['/v1/chat/completions', '/v1/messages', '/v1/messages/count_tokens'].map(path => ({ path, methods: ['POST'], headers: ['content-type', 'anthropic-version'] })), credential: { header: 'Authorization', prefix: 'Bearer ' }, transport: { kind: 'browser_direct', privacy: 'local', relayIdentity: null } }] });
      try {
        const model = catalog(protocol), adapter = (protocol === 'anthropic' ? createAnthropicAdapter : createOpenAICompatibleAdapter)({ host, binding, credential: null, catalog: [model], nextId: () => crypto.randomUUID(), now: Date.now });
        const value = request(protocol), expected = adapter.prepare(value).body;
        assert.equal(adapter.analyze(value).preserved.byKind.File, 1);
        const before = requests.length, count = await adapter.countTokens(value);
        if (protocol === 'anthropic') {
          assert.equal(count.tokens, 42); assert.equal(count.source, 'provider');
          assert.deepEqual(requests.at(-1)!.body.messages, expected.messages);
          assert.equal('stream' in requests.at(-1)!.body, false); assert.equal('max_tokens' in requests.at(-1)!.body, false);
        } else { assert.equal(count.source, 'unavailable'); assert.equal(requests.length, before); }
        const stream = adapter.stream(value);
        // No caller bytes/names/message mutation may alter the prepared wire request.
        value.attachments![attachmentId]!.bytes = new Uint8Array([0]); value.attachments![attachmentId]!.filename = 'changed.pdf'; value.messages = [];
        const events = []; for await (const event of stream.events) events.push(event);
        assert.deepEqual(requests.at(-1)!.body, expected);
        assert.equal(events.at(-1)?.type, 'terminal');
        assert.equal((events.at(-1) as { status: string }).status, 'complete');
        const blocked = request(protocol); blocked.attachments![attachmentId]!.mediaType = 'text/plain';
        const current = requests.length;
        assert.equal(adapter.analyze(blocked).sendable, false);
        assert.throws(() => adapter.stream(blocked), issue('file_media_unsupported'));
        await assert.rejects(adapter.countTokens(blocked), issue('file_media_unsupported'));
        assert.equal(requests.length, current);
      } finally { await host.dispose(); }
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
  }
});
