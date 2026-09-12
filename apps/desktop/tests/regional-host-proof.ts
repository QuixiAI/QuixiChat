import type { HostClient, ProviderBinding, ProviderHttpRequest } from '@quixi/core/contracts';
import { desktopProviderConnections } from '../src/host/provider-connections.ts';

/** Registry metadata is production configuration. Wire requests use explicitly
 * different loopback bindings and cannot establish provider processing location. */
export async function exerciseRegionalHost(host: HostClient) {
  const checks: string[] = [];
  const registrations: unknown[] = [];
  const id = () => crypto.randomUUID();
  const check = (condition: unknown, name: string) => {
    if (!condition) throw new Error(`Regional host check failed: ${name}`);
    checks.push(name);
  };
  const reject = async (operation: () => Promise<unknown>, name: string) => {
    try { await operation(); } catch (error) {
      check((error as { code?: unknown }).code === 'INVALID_REQUEST', name); return;
    }
    throw new Error(`Regional host expected refusal: ${name}`);
  };
  const read = async (transferId: string) => {
    const chunks: Uint8Array[] = []; let length = 0;
    for (;;) {
      const chunk = await host.readChunk(transferId); length += chunk.bytes.length;
      if (length > 4096) throw new Error('Regional fixture reply exceeds its bound');
      chunks.push(chunk.bytes);
      await host.acknowledgeChunk({ transferId, sequence: chunk.sequence, committedOffset: chunk.offset + chunk.bytes.length });
      if (chunk.final) break;
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    await host.releaseTransfer(id(), transferId);
    return new TextDecoder().decode(bytes);
  };
  const request = (binding: ProviderBinding, path: string, extra: Partial<ProviderHttpRequest> = {}): ProviderHttpRequest => ({
    requestId: id(), binding, path, method: 'GET', headers: {}, credential: null, bodyTransferId: null,
    timeout: { connectMs: 3000, idleMs: 3000, totalMs: 10000 }, ...extra,
  });
  const canonical = (value: unknown): string => {
    const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize)
      : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, normalize(nested)])) : item;
    return JSON.stringify(normalize(value));
  };
  const capabilities = await host.capabilities();
  const connections = desktopProviderConnections();
  check(connections.length === 4 && connections[0]?.id === 'openai' && connections[1]?.id === 'anthropic', 'existing global connection IDs and order remain available');
  for (const global of connections.filter(connection => !connection.processingRegion)) {
    const transport = capabilities.providerTransports.find(item => item.id === global.binding.transportId);
    check(transport?.regionalProcessing === undefined, `${global.id}: global transport makes no regional claim`);
  }
  for (const region of ['us', 'eu'] as const) {
    const connection = connections.find(item => item.id === `openai-${region}`)!;
    const transport = capabilities.providerTransports.find(item => item.id === connection.binding.transportId)!;
    const upstreamOrigin = `https://${region}.api.openai.com`;
    const expected = {
      version: 1, configurationId: `openai-${region}-gpt41-mini-2026-09-10`, binding: connection.binding,
      region, upstreamOrigin, modelIds: ['gpt-4.1-mini-2025-04-14'], endpoints: ['/v1/chat/completions'],
      inputModalities: ['text', 'image'], sourceUrl: 'https://developers.openai.com/api/docs/guides/your-data',
      reviewedAt: Date.parse('2026-09-10T00:00:00Z'),
    };
    const evidence = transport.regionalProcessing!;
    check(connection.processingRegion === region && transport.kind === 'native_direct' && transport.privacy === 'direct_provider' && transport.endpointOrigin === upstreamOrigin,
      `${region}: desktop connection resolves to exact production native regional transport`);
    check(canonical(evidence) === canonical(expected),
      `${region}: native capability exposes the exact fixed review, model, endpoint, modalities, origin and binding`);
    registrations.push({ connectionId: connection.id, transport });
    const loopback = { ...connection.binding, destinationId: `${connection.binding.destinationId}-loopback-proof`, transportId: `${connection.binding.transportId}-loopback-proof` };
    const synthetic = capabilities.providerTransports.find(item => item.id === loopback.transportId)!;
    check(synthetic.privacy === 'local' && synthetic.endpointOrigin.startsWith('http://127.0.0.1:') && synthetic.regionalProcessing === undefined,
      `${region}: synthetic loopback registration cannot claim regional processing`);
    const credential = await host.storeSecret(id(), loopback, new TextEncoder().encode('synthetic-secret'), null);
    try {
      const models = await host.startProviderHttp(request(loopback, '/v1/models', { credential }));
      const modelResult = await read(models.bodyTransferId!);
      check(JSON.parse(modelResult).authorized === true && !modelResult.includes('synthetic-secret'), `${region}: native model discovery injects only the bound opaque credential without returning secret text`);
      const bytes = new TextEncoder().encode(JSON.stringify({ model: 'gpt-4.1-mini-2025-04-14', messages: [{ role: 'user', content: 'Synthetic regional registration proof' }], max_completion_tokens: 32, stream: false }));
      const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const staged = await host.beginTransfer(id(), { purpose: 'provider_request', expectedBytes: bytes.length, expectedSha256: sha256 });
      try {
        await host.writeChunk({ transferId: staged.transferId, sequence: 0, offset: 0, bytes, final: true });
        await host.finishTransfer(id(), staged.transferId, { byteLength: bytes.length, sha256 });
        const completion = await host.startProviderHttp(request(loopback, '/v1/chat/completions', { method: 'POST', credential, bodyTransferId: staged.transferId, headers: { 'content-type': 'application/json' } }));
        const completionResult = await read(completion.bodyTransferId!); const parsed = JSON.parse(completionResult);
        check(parsed.authorized === true && parsed.sha256 === sha256 && parsed.bytes === bytes.length && !completionResult.includes('synthetic-secret'), `${region}: real Rust HTTP dispatch preserves exact synthetic Chat Completions bytes and opaque credential isolation`);
      } finally { await host.releaseTransfer(id(), staged.transferId); }
      await reject(() => host.startProviderHttp(request({ ...loopback, accountId: 'other' }, '/v1/models', { credential })), `${region}: wrong account refused before HTTP`);
      const otherRegion = region === 'us' ? 'eu' : 'us';
      const otherBinding = { ...loopback, destinationId: `quixi-openai-${otherRegion}-api-v1-loopback-proof`, transportId: `quixi-openai-${otherRegion}-native-v1-loopback-proof` };
      await reject(() => host.startProviderHttp(request(otherBinding, '/v1/models', { credential })), `${region}: regional credential cannot cross into the other registered destination`);
      await reject(() => host.startProviderHttp(request(loopback, '/v1/responses', { method: 'POST', credential })), `${region}: unreviewed endpoint refused before HTTP`);
      await reject(() => host.startProviderHttp(request(loopback, '/v1/chat/completions', { credential })), `${region}: wrong generation method refused before HTTP`);
      await reject(() => host.startProviderHttp(request(loopback, upstreamOrigin + '/v1/models', { credential })), `${region}: caller supplied absolute URL refused before HTTP`);
    } finally { await host.deleteSecret(id(), credential); }
    check(await host.openSecret(id(), loopback) === null, `${region}: synthetic regional credential removed from OS keychain`);
  }
  return { checks, registrations, scope: 'Production metadata plus separate synthetic loopback dispatch; no physical location or provider account eligibility assertion.' };
}
