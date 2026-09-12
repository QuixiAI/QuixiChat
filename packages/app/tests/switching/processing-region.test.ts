import test from 'node:test';
import assert from 'node:assert/strict';
import type { RegionalProcessingEvidence, RoutingRequirements } from '@quixi/core/contracts';
import { openAIRegionalEvidence, openAIRelayRegionalEvidence } from '@quixi/providers';
import type { ModelDescription, ProviderAdapter } from '@quixi/providers';
import { assessProcessingRegion, processingRegionKey, regionalAttemptOrigin } from '../../src/runtime/processing-region.ts';

const modelId = 'gpt-4.1-mini-2025-04-14';
function target(region: 'us' | 'eu') {
  const regionalProcessing = openAIRegionalEvidence(region);
  // The evaluator uses only binding, protocol, and reviewed model availability.
  // Credential eligibility and host admission have separate adapter/host tests.
  const adapter = {
    protocol: 'openai-compatible', binding: { ...regionalProcessing.binding },
    describeModel: (requested: string) => requested === modelId ? { id: modelId } as ModelDescription : null,
  } as ProviderAdapter;
  return { adapter, regionalProcessing };
}
function relayTarget(region: 'us' | 'eu') {
  const provider = target(region);
  provider.regionalProcessing = openAIRelayRegionalEvidence(region, { configurationId: 'a'.repeat(64), operator: 'Synthetic regional operator', origin: 'https://relay.example.test', region, destinationId: `openai_${region}` });
  Object.assign(provider.adapter, { binding: { ...provider.regionalProcessing.binding } });
  return provider;
}

test('admitted regional relay evidence qualifies with distinct historical origin and an evidence-bound key', () => {
  for (const processingRegion of ['us', 'eu'] as const) {
    const provider = relayTarget(processingRegion), result = assessProcessingRegion({ processingRegion }, provider, modelId);
    assert.equal(result.allowed, true); assert.equal(result.basis, provider.regionalProcessing.configurationId);
    assert.equal(assessProcessingRegion({ processingRegion: processingRegion === 'us' ? 'eu' : 'us' }, provider, modelId).allowed, false);
    assert.notEqual(processingRegionKey(provider), processingRegionKey(target(processingRegion)));
    assert.deepEqual(regionalAttemptOrigin({ provider: 'openai', compatibility: [result.reason] }), { id: `openai-${processingRegion}-relay`, label: `OpenAI · ${processingRegion === 'us' ? 'United States' : 'Europe (EEA + Switzerland)'} · relay`, privacy: null });
    const original = processingRegionKey(provider); provider.regionalProcessing.relay!.configurationId = 'b'.repeat(64);
    assert.notEqual(processingRegionKey(provider), original);
    assert.equal(assessProcessingRegion({ processingRegion }, provider, modelId).allowed, false, 'a changed server declaration must not reuse the old combined review');
  }
});

test('relay evaluator rejects a native binding, malformed declarations and cross-region relay claims', () => {
  for (const change of [
    (provider: ReturnType<typeof relayTarget>) => { Object.assign(provider.adapter, { binding: openAIRegionalEvidence('us').binding }); },
    (provider: ReturnType<typeof relayTarget>) => { provider.regionalProcessing.relay!.region = 'eu'; },
    (provider: ReturnType<typeof relayTarget>) => { provider.regionalProcessing.relay!.origin = 'http://untrusted.example'; },
    (provider: ReturnType<typeof relayTarget>) => { Object.assign(provider.regionalProcessing.relay!, { unknown: true }); },
  ]) {
    const provider = relayTarget('us'); change(provider);
    assert.equal(assessProcessingRegion({ processingRegion: 'us' }, provider, modelId).allowed, false);
  }
});

test('required US and EU processing accept exact reviewed target evidence and expose its configuration basis', () => {
  for (const processingRegion of ['us', 'eu'] as const) {
    const provider = target(processingRegion), result = assessProcessingRegion({ processingRegion }, provider, modelId);
    assert.equal(result.allowed, true); assert.equal(result.basis, provider.regionalProcessing.configurationId);
    assert.match(result.reason, /matches the requirement/);
    assert.equal(assessProcessingRegion({}, null, modelId).allowed, true, 'an absent requirement does not require regional configuration');
  }
});

test('unknown or global processing cannot satisfy a region requirement', () => {
  for (const provider of [null, { adapter: target('us').adapter }]) {
    const result = assessProcessingRegion({ processingRegion: 'us' }, provider, modelId);
    assert.equal(result.allowed, false); assert.equal(result.basis, null); assert.match(result.reason, /unknown/);
  }
  const global = target('us');
  Object.assign(global.regionalProcessing, { region: 'global' });
  assert.equal(assessProcessingRegion({ processingRegion: 'us' }, global, modelId).allowed, false);
  const unsupported = assessProcessingRegion({ processingRegion: 'global' } as unknown as RoutingRequirements, target('us'), modelId);
  assert.equal(unsupported.allowed, false); assert.match(unsupported.reason, /unsupported/);
});

test('reviewed processing in the other region is explicitly refused', () => {
  for (const processingRegion of ['us', 'eu'] as const) {
    const result = assessProcessingRegion({ processingRegion }, target(processingRegion === 'us' ? 'eu' : 'us'), modelId);
    assert.equal(result.allowed, false); assert.equal(result.basis, null); assert.match(result.reason, /does not match required/);
  }
});

test('binding account destination transport protocol and model must all match the reviewed region', () => {
  for (const key of ['providerId', 'accountId', 'destinationId', 'transportId'] as const) {
    const provider = target('us'); provider.adapter.binding[key] = 'different';
    const result = assessProcessingRegion({ processingRegion: 'us' }, provider, modelId);
    assert.equal(result.allowed, false, key); assert.equal(result.basis, null);
  }
  const wrongProtocol = target('us'); Object.assign(wrongProtocol.adapter, { protocol: 'anthropic' });
  assert.equal(assessProcessingRegion({ processingRegion: 'us' }, wrongProtocol, modelId).allowed, false);
  assert.equal(assessProcessingRegion({ processingRegion: 'us' }, target('us'), 'gpt-4.1-mini').allowed, false, 'undated aliases are not covered by the reviewed dated model');
  const unavailable = target('us'); unavailable.adapter.describeModel = () => null;
  assert.equal(assessProcessingRegion({ processingRegion: 'us' }, unavailable, modelId).allowed, false);
});

test('tampered review metadata and broadened model endpoint or modality claims are refused', () => {
  const changes: ((evidence: RegionalProcessingEvidence) => void)[] = [
    value => { value.configurationId += '-changed'; }, value => { value.binding.accountId = 'other'; },
    value => { value.upstreamOrigin = 'https://api.openai.com'; }, value => { value.modelIds.push('other'); },
    value => { value.endpoints.push('/v1/responses'); }, value => { value.inputModalities = ['text']; },
    value => { value.sourceUrl = 'https://example.invalid/claim'; }, value => { value.reviewedAt++; },
    value => { Object.assign(value, { callerClaim: true }); },
  ];
  for (const change of changes) {
    const provider = target('us'); change(provider.regionalProcessing);
    const result = assessProcessingRegion({ processingRegion: 'us' }, provider, modelId);
    assert.equal(result.allowed, false); assert.equal(result.basis, null);
  }
});

test('region evidence keys ignore object ordering but invalidate on changed review scope', () => {
  const provider = target('us'), original = processingRegionKey(provider);
  const reordered = Object.fromEntries(Object.entries(provider.regionalProcessing).reverse()) as unknown as RegionalProcessingEvidence;
  assert.equal(processingRegionKey({ adapter: provider.adapter, regionalProcessing: reordered }), original);
  for (const change of [
    (value: RegionalProcessingEvidence) => { value.binding.accountId = 'other'; },
    (value: RegionalProcessingEvidence) => { value.modelIds = ['other']; },
    (value: RegionalProcessingEvidence) => { value.configurationId += '-changed'; },
    (value: RegionalProcessingEvidence) => { value.reviewedAt++; },
  ]) {
    const revised = target('us'); change(revised.regionalProcessing);
    assert.notEqual(processingRegionKey(revised), original);
  }
  assert.notEqual(processingRegionKey(target('eu')), original);
  assert.equal(processingRegionKey({ adapter: provider.adapter }), 'null');
});

test('historical regional destinations remain distinct without a configured adapter or current review revision', () => {
  for (const region of ['us', 'eu'] as const) {
    const note = assessProcessingRegion({ processingRegion: region }, target(region), modelId).reason;
    for (const compatibility of [[note], [note.replace('2026-09-10', 'older-review')]]) {
      assert.equal(regionalAttemptOrigin({ provider: 'openai', compatibility })?.id, `openai-${region}`);
      assert.equal(regionalAttemptOrigin({ provider: 'anthropic', compatibility }), null);
    }
  }
  assert.equal(regionalAttemptOrigin({ provider: 'openai', compatibility: ['No processing region required.'] }), null);
});
