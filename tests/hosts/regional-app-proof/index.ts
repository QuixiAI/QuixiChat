import { invoke } from '@tauri-apps/api/core';
import { mountApp } from '@quixi/app';
import { canonicalJson } from '@quixi/core/contracts';
import type { EntityPage } from '@quixi/core/contracts';
import type { CanonicalHistory, ContentPart, Generation, JsonValue, Message, SummaryProposal, ThreadState } from '@quixi/core/model';
import { openAIRegionalEvidence } from '@quixi/providers';
import { createDesktopHost } from '../../../apps/desktop/src/host/index.ts';
import { desktopProviderConnections } from '../../../apps/desktop/src/host/provider-connections.ts';
import { createIsolatedStorageClient } from '../../../packages/storage/tests/isolated-client.ts';

type Phase = 'write' | 'restart' | 'cleanup' | 'tls-untrusted-ca' | 'tls-wrong-hostname';
type Configuration = { profile: string; phase: Phase };
type WireCounts = Record<'us' | 'eu' | 'global', { models: number; content: number }>;
type Checkpoint = {
  threadIds: { us: string; eu: string }; generationIds: string[]; canonicalSha256: string;
  summary: { id: string; generationId: string; inputSha256: string; inputByteLength: number; verifiedSavedInputSha256: string };
};
const config = (window as Window & { __QUIXI_REGIONAL_APP_PROOF__?: Configuration }).__QUIXI_REGIONAL_APP_PROOF__;
const marker = 'quixi.native-regional-app-proof.profile';
const savedKey = 'quixi.native-regional-app-proof.checkpoint';
const labels = { us: 'OpenAI · US', eu: 'OpenAI · Europe (EEA + Switzerland)', global: 'OpenAI' };
const eligibilityLabel = 'I confirmed this credential is eligible for regional processing';
const modelId = 'gpt-4.1-mini-2025-04-14';
const expectedWireCounts: WireCounts = { us: { models: 0, content: 0 }, eu: { models: 0, content: 0 }, global: { models: 0, content: 0 } };
const report = {
  status: 'running', success: false, phase: config?.phase, profile: config?.profile,
  url: location.href, userAgent: navigator.userAgent, secureContext: isSecureContext,
  scope: 'Actual production AppRoot, desktop connection settings, native HostClient, canonical worker and OS Keychain in an isolated synthetic profile. The controlled TLS fixture verifies registered US/EU destination routing, not physical geography or provider account eligibility.',
  checks: [] as string[], provenanceChecks: [] as string[], wireCheckpoints: [] as { stage: string; expectedWireCounts: WireCounts }[],
  expectedWireCounts, cspViolations: [] as { directive: string; blockedURI: string }[], stage: 'starting',
} as Record<string, unknown> & {
  status: string; success: boolean; checks: string[]; provenanceChecks: string[];
  wireCheckpoints: { stage: string; expectedWireCounts: WireCounts }[];
  expectedWireCounts: WireCounts; cspViolations: { directive: string; blockedURI: string }[]; stage: string;
};
let host: Awaited<ReturnType<typeof createDesktopHost>> | undefined;
let storage: ReturnType<typeof createIsolatedStorageClient> | undefined;
let unmount: (() => Promise<void>) | undefined;
const id = () => crypto.randomUUID();
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function checked(value: unknown, message: string) { assert(value, message); report.checks.push(message); }
function normalized(value: string | null | undefined) { return (value ?? '').replace(/\s+/g, ' ').trim(); }
function visible(element: Element) { return element.getClientRects().length > 0; }
async function boundedRead<T>(label: string, read: Promise<T>, timeout = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out awaiting ${label}`)), timeout);
    })]);
  } finally { clearTimeout(timer); }
}
async function poll<T>(label: string, read: () => T | null | false | undefined | Promise<T | null | false | undefined>, timeout = 20_000): Promise<T> {
  const deadline = performance.now() + timeout;
  do { const value = await boundedRead(label, Promise.resolve().then(read), Math.max(1, deadline - performance.now())); if (value !== null && value !== undefined && value !== false) return value; await sleep(40); } while (performance.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}
const buttons = (name: string, root: ParentNode = document) => [...root.querySelectorAll<HTMLButtonElement>('button')].filter(element => visible(element) && normalized(element.getAttribute('aria-label') ?? element.textContent) === name);
function button(name: string, root: ParentNode = document) { return buttons(name, root)[0]; }
async function click(name: string, root: ParentNode = document) {
  const element = await poll(`enabled button ${name}`, () => { const found = button(name, root); return found && !found.disabled ? found : null; });
  element.click(); await sleep(0);
}
type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
function field(name: string, root: ParentNode = document): Field | undefined {
  const explicit = [...root.querySelectorAll<Field>('input,textarea,select')].find(element => element.getAttribute('aria-label') === name && visible(element));
  if (explicit) return explicit;
  const label = [...root.querySelectorAll<HTMLLabelElement>('label')].find(element => {
    const clone = element.cloneNode(true) as HTMLLabelElement; clone.querySelectorAll('input,select,textarea,small').forEach(child => child.remove());
    return normalized(clone.textContent) === name && visible(element);
  });
  return label?.control as Field | undefined;
}
async function fill(name: string, value: string, root: ParentNode = document) {
  const element = await poll(`enabled field ${name}`, () => { const found = field(name, root); return found && !found.disabled ? found : null; });
  if (element instanceof HTMLSelectElement) assert([...element.options].some(option => option.value === value), `${name} has no option ${value}`);
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
  await poll(`${name} retains entered value`, () => field(name, root)?.value === value);
  await sleep(40);
}
async function check(name: string, value: boolean, root: ParentNode = document) {
  const element = await poll(`enabled checkbox ${name}`, () => { const found = field(name, root); return found instanceof HTMLInputElement && !found.disabled ? found : null; });
  if (element.checked !== value) element.click();
  await poll(`${name} checked=${value}`, () => (field(name, root) as HTMLInputElement | undefined)?.checked === value);
}
function region(name: string) { return [...document.querySelectorAll<HTMLElement>('section[aria-label]')].find(element => element.getAttribute('aria-label') === name && visible(element)); }
function card(which: keyof typeof labels) { return [...document.querySelectorAll<HTMLElement>('article')].find(element => normalized(element.querySelector('h3')?.textContent) === labels[which]); }
async function checkpoint(stage: string) {
  report.stage = stage;
  report.wireCheckpoints.push({ stage, expectedWireCounts: structuredClone(expectedWireCounts) });
  await invoke('regional_app_proof_checkpoint', { report: JSON.stringify(report) });
}
async function hash(text: string) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
async function records<T>(collection: Exclude<keyof CanonicalHistory, 'version'>): Promise<T[]> {
  assert(storage, 'Storage is not open');
  const items: unknown[] = []; let cursor: string | null = null;
  for (let pageIndex = 0; pageIndex < 8; pageIndex++) {
    const page: EntityPage = await boundedRead(`canonical ${collection} page`, storage.request(id(), 'readEntities', { collection, threadId: null, page: { maxItems: 64, maxBytes: 900000, cursor } }));
    items.push(...page.items); cursor = page.nextCursor; if (!cursor) return items as T[];
  }
  throw new Error('Synthetic regional proof exceeded its bounded record read');
}
const attempts = async (threadId?: string) => (await records<Generation>('generations')).filter(value => !threadId || value.threadId === threadId).sort((a, b) => a.recordedAt - b.recordedAt || a.id.localeCompare(b.id));
async function thread(threadId: string) { const value = (await records<ThreadState>('threadStates')).find(value => value.threadId === threadId); assert(value, 'Expected canonical conversation'); return value; }
async function canonicalFingerprint() {
  const entries: Record<string, unknown[]> = {};
  for (const collection of ['threadStates', 'contexts', 'messages', 'parts', 'generations', 'summaryProposals', 'events', 'rawObjects'] as const) {
    entries[collection] = (await records<Record<string, unknown>>(collection)).sort((a, b) => String(a.id ?? a.threadId).localeCompare(String(b.id ?? b.threadId)));
  }
  return hash(canonicalJson(entries as unknown as JsonValue));
}
async function noAttemptsSince(before: number, label: string) {
  await sleep(100);
  checked((await attempts()).length === before, label);
}
async function openProviders() { await click('Providers'); await poll('provider settings', () => card('us') && field('API key', card('us'))); }
async function openThread(title: string) {
  await click('Library'); await click(title);
  await poll(`opened ${title}`, () => [...document.querySelectorAll('h1,h2')].some(value => normalized(value.textContent) === title));
}
async function selectProvider(provider: string, threadId: string) {
  const storedPrimary = (await thread(threadId)).routingProfile?.primary;
  await fill('Provider', provider);
  if (storedPrimary) await poll(`canonical primary ${provider}`, async () => ((await thread(threadId)).routingProfile?.primary as { provider?: string } | undefined)?.provider === provider);
  await fill('Maximum output tokens', '128');
}
async function selectRegion(value: 'us' | 'eu', threadId: string) {
  await fill('Required processing region', value);
  await poll(`canonical processing region ${value}`, async () => ((await thread(threadId)).routingProfile?.requirements as { processingRegion?: string } | undefined)?.processingRegion === value);
}
async function createThread(title: string) {
  await click('Library'); const before = new Set((await records<ThreadState>('threadStates')).map(value => value.threadId));
  await click('New conversation');
  const created = await poll('new canonical conversation', async () => (await records<ThreadState>('threadStates')).find(value => !before.has(value.threadId)));
  await poll('new conversation visible', () => [...document.querySelectorAll('h1,h2')].some(value => normalized(value.textContent) === created.title));
  const details = await poll('conversation settings', () => document.querySelector<HTMLDetailsElement>('details.thread-details'));
  if (!details.open) details.querySelector('summary')!.click();
  await fill('Title', title); await click('Rename'); await poll('saved conversation title', async () => (await thread(created.threadId)).title === title);
  return created.threadId;
}
async function addFallback(provider: string, threadId: string) {
  await fill('Fallback candidate', `${provider}:${modelId}`); await click('Add candidate');
  await poll(`saved fallback ${provider}`, async () => ((await thread(threadId)).routingProfile?.candidates as { provider: string }[] | undefined)?.some(value => value.provider === provider));
}
async function reviewedSwitch() {
  const panel = document.querySelector<HTMLElement>('.switch-report');
  if (!panel || !visible(panel)) return;
  const checkbox = [...panel.querySelectorAll<HTMLInputElement>('input[type=checkbox]')][0];
  assert(checkbox && !checkbox.disabled, 'Visible provider switch needs an actionable review');
  if (!checkbox.checked) checkbox.click(); await sleep(40);
}
async function send(text: string, threadId: string, regionName: 'us' | 'eu', terminal: Generation['status'] = 'complete') {
  const prior = new Set((await attempts()).map(value => value.id));
  await fill('Message', text); await reviewedSwitch(); await click('Send message');
  const generation = await poll(`terminal ${terminal} native generation`, async () => (await attempts(threadId)).find(value => !prior.has(value.id) && value.status === terminal));
  await poll('idle composer', () => button('Send message'));
  expectedWireCounts[regionName].content++;
  return generation;
}
async function denyInitial(threadId: string, reason: string) {
  const before = (await attempts()).length, messages = (await records<Message>('messages')).length;
  await fill('Message', 'Synthetic request that must remain local.');
  await poll('regional route refusal', () => document.querySelector('.route-plan')?.textContent?.includes(reason));
  checked(button('Send message')?.disabled, `Initial route refuses ${reason}`);
  field('Message')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, metaKey: true, bubbles: true }));
  await click('Count prompt tokens');
  await poll('explicit regional count refusal', () => document.querySelector('.prompt-count')?.textContent?.includes(reason));
  await noAttemptsSince(before, 'Refused keyboard send and token count create no canonical attempt');
  checked((await records<Message>('messages')).length === messages, 'Refused initial route preserves canonical message history');
  checked(((await thread(threadId)).routingProfile?.requirements as { processingRegion?: string }).processingRegion === 'us', 'Refused route retains the required US policy');
}
async function summaryProof(threadId: string): Promise<Checkpoint['summary']> {
  const originals = await records<Message>('messages'), parts = await records<ContentPart>('parts'), priorState = await thread(threadId);
  const panel = region('Conversation summary'); assert(panel, 'Summary panel is missing');
  await click('Review conversation summaries', panel); await click('Prepare summary request', panel);
  const review = await poll('summary request review', () => region('Review summary request'));
  await check('I reviewed this summary request and its destination', true, review);
  checked(review.textContent?.includes('openai-us-gpt41-mini-2026-09-10'), 'Summary request review names the actual native US processing basis');
  await click('Generate summary proposal', review);
  await poll('complete summary output', () => { const value = field('Reviewed summary', panel); return value && !value.disabled; });
  expectedWireCounts.us.content++;
  const proposals = await records<SummaryProposal>('summaryProposals'); assert(proposals.length === 1, 'Expected one independent summary proposal');
  const proposal = proposals[0]!;
  await click('Inspect saved summary input', panel);
  const savedBody = await poll('verified saved summary bytes', () => [...panel.querySelectorAll('details')].find(value => normalized(value.querySelector('summary')?.textContent) === 'Verified saved request body')?.querySelector('pre')?.textContent);
  const verifiedSavedInputSha256 = await hash(savedBody);
  checked(verifiedSavedInputSha256 === proposal.inputSha256 && new TextEncoder().encode(savedBody).length === proposal.inputByteLength, 'Canonical summary input hash and length match the verified frozen request bytes');
  const body = JSON.parse(savedBody) as { model: string; max_completion_tokens: number };
  checked(body.model === modelId && body.max_completion_tokens === 128, 'Frozen summary input names the reviewed model and bounded output limit');
  const generated = (await attempts(threadId)).find(value => value.id === proposal.generationId);
  checked(generated?.status === 'complete' && generated.purpose === 'context_summary' && generated.compatibility.some(value => value.includes('openai-us-gpt41-mini-2026-09-10')), 'Complete summary attempt records separate purpose and native regional basis');
  const afterMessages = await records<Message>('messages'), afterParts = await records<ContentPart>('parts');
  checked(originals.every(original => JSON.stringify(afterMessages.find(value => value.id === original.id)) === JSON.stringify(original)) && parts.every(original => JSON.stringify(afterParts.find(value => value.id === original.id)) === JSON.stringify(original)), 'Generating a summary preserves every original message and content part byte for byte');
  checked((await thread(threadId)).activeLeafMessageId === priorState.activeLeafMessageId, 'Summary output does not become the ordinary transcript branch');
  await click('Close summary review', panel);
  report.provenanceChecks.push('Original canonical message and part records retained exactly', 'Saved summary input verified through the production UI blob reader, then independently SHA-256 hashed');
  return { id: proposal.id, generationId: proposal.generationId, inputSha256: proposal.inputSha256, inputByteLength: proposal.inputByteLength, verifiedSavedInputSha256 };
}

async function latePolicyRefusal(threadId: string) {
  assert(host && storage, 'Late policy proof requires the actual mounted native app');
  const original = host.startProviderHttp, before = new Set((await attempts()).map(value => value.id));
  let intercepted = 0;
  // This single, explicitly negative scheduling hook changes canonical policy
  // after the real provider adapter has staged the body. Every positive call
  // uses the unmodified host. The original host/callback perform the refusal.
  host.startProviderHttp = async (request, beforeDispatch) => {
    if (request.method === 'POST' && request.binding.destinationId === 'quixi-openai-us-api-v1') {
      intercepted++;
      assert(intercepted === 1 && request.bodyTransferId && beforeDispatch, 'Late policy hook must receive one fully staged native request with its production guard');
      const current = await thread(threadId), routingProfile = structuredClone(current.routingProfile)!;
      routingProfile.requirements = { ...(routingProfile.requirements as Record<string, JsonValue>), processingRegion: 'eu' };
      await storage!.request(id(), 'commit', {
        transactionId: id(), expectedThreadRevisions: [{ threadId, revision: current.revision }], stagedBlobIds: [],
        mutations: [{ version: 1, operationId: id(), kind: 'SetRoutingProfile', recordedAt: Date.now(), payload: { threadId, value: routingProfile } }],
      });
    }
    return original(request, beforeDispatch);
  };
  try {
    await fill('Message', 'Synthetic late canonical policy change before native HTTP.'); await reviewedSwitch(); await click('Send message');
    const failure = await poll('late-policy failed canonical attempt', async () => (await attempts(threadId)).find(value => !before.has(value.id) && value.status === 'failed'));
    checked(intercepted === 1 && (await attempts()).length === before.size + 1, 'Changing canonical policy after body staging causes exactly one failed attempt before native HTTP');
    report.latePolicyProof = { generationId: failure.id, originalRegion: 'us', changedRegion: 'eu', hook: 'Negative-only scheduling wrapper commits current canonical policy immediately before calling the unchanged native HostClient with its original beforeDispatch callback.', expectedAdditionalWireRequests: 0 };
    await poll('idle after late-policy refusal', () => button('Send message'));
  } finally { host.startProviderHttp = original; }
  await fill('Message', '');
  await selectRegion('us', threadId);
  await checkpoint('late-canonical-policy-refused-before-native-http');
}

async function writePhase() {
  checked((await attempts()).length === 0 && (await records<ThreadState>('threadStates')).length === 0, 'Explicit test archive starts without conversations or attempts');
  await openProviders();
  for (const which of ['global', 'us', 'eu'] as const) {
    const panel = card(which); assert(panel, `Missing ${which} production settings card`);
    await fill('API key', `synthetic-native-${which}`, panel); await click('Connect credential', panel);
    await poll(`${which} connected through Keychain`, () => panel.textContent?.includes('Credential connected · Connection not checked'));
    if (which === 'global') continue;
    checked(!(field(eligibilityLabel, panel) as HTMLInputElement).checked, `${which} credential storage does not confirm eligibility`);
    await click('Check connection', panel); await poll(`${which} native model listing`, () => panel.textContent?.includes('Credential connected · healthy'));
    expectedWireCounts[which].models++;
    checked(!(field(eligibilityLabel, panel) as HTMLInputElement).checked, `${which} real model discovery does not confirm eligibility`);
    await check(eligibilityLabel, true, panel); await poll(`${which} explicit text eligibility`, () => panel.textContent?.includes('Eligibility: user-confirmed for text.'));
    checked(!(field('I confirmed regional image-processing eligibility', panel) as HTMLInputElement).checked, `${which} text confirmation does not grant image eligibility`);
  }
  await checkpoint('connected-and-explicitly-confirmed');
  const us = await createThread('Native US regional notebook');
  await selectProvider('openai', us); await selectRegion('us', us); await addFallback('openai-eu', us);
  await denyInitial(us, 'Processing region is unknown'); await checkpoint('unknown-primary-and-wrong-fallback-refused');
  await selectProvider('openai-eu', us);
  await denyInitial(us, 'does not match required United States'); await checkpoint('wrong-primary-refused');
  await selectProvider('openai-us', us);
  // Restore both refused alternatives after switching the selected primary.
  const candidates = (await thread(us)).routingProfile?.candidates as { provider: string }[];
  if (!candidates.some(value => value.provider === 'openai-eu')) await addFallback('openai-eu', us);
  if (!candidates.some(value => value.provider === 'openai')) await addFallback('openai', us);
  await send('Synthetic first native US regional question.', us, 'us');
  await send('Synthetic second native US regional question.', us, 'us');
  checked(button('Attach image')?.disabled, 'Text-only account confirmation keeps native regional image attachment disabled');
  await checkpoint('two-us-generations-complete');
  const summary = await summaryProof(us); await checkpoint('summary-frozen-input-retained');
  const prior = new Set((await attempts()).map(value => value.id));
  await reviewedSwitch(); await click('Generate another response');
  await poll('complete native regeneration', async () => (await attempts(us)).find(value => !prior.has(value.id) && value.status === 'complete'));
  await poll('idle after regeneration', () => button('Send message')); expectedWireCounts.us.content++;
  await checkpoint('us-regeneration-complete');
  const beforeFailure = (await attempts()).length;
  await send('REGION_FORCE_FAILURE: keep this synthetic failure in the required US region.', us, 'us', 'failed');
  await poll('fallback refusal explanation', () => [...document.querySelectorAll('[role=alert]')].some(value => value.textContent?.includes('Fallback was not used') && value.textContent.includes('Processing region')));
  checked((await attempts()).length === beforeFailure + 1, 'Failed US primary creates one attempt while wrong-region and global fallbacks are skipped');
  await checkpoint('failed-us-primary-skips-eu-and-global');
  await fill('Message', '');
  await latePolicyRefusal(us);
  // Real settings revocation removes the regional adapter from the app without
  // altering the canonical route or selecting a global substitute.
  await openProviders(); const usCard = card('us')!; await check(eligibilityLabel, false, usCard);
  await poll('US eligibility revoked', () => usCard.textContent?.includes('Confirm eligibility to make this connection available in chat.'));
  await openThread('Native US regional notebook'); const revokedBefore = (await attempts()).length;
  await fill('Message', 'Synthetic request after eligibility revocation.');
  await poll('revoked route disabled', () => button('Send message')?.disabled);
  field('Message')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, metaKey: true, bubbles: true }));
  await noAttemptsSince(revokedBefore, 'Revoking eligibility refuses subsequent keyboard send without a new native attempt');
  checked(((await thread(us)).routingProfile?.requirements as { processingRegion: string }).processingRegion === 'us', 'Revocation keeps the stored US processing requirement and refuses a global substitute');
  await fill('Message', ''); await checkpoint('revoked-us-eligibility-refused');
  const eu = await createThread('Native EU regional notebook'); await selectProvider('openai-eu', eu); await selectRegion('eu', eu);
  await send('Synthetic native EU regional question.', eu, 'eu'); await checkpoint('eu-generation-complete');
  const generations = await attempts();
  checked(generations.length === 7 && generations.filter(value => value.status === 'complete').length === 5 && generations.filter(value => value.status === 'failed').length === 2, 'Canonical archive retains five complete attempts and two failed attempts across US/EU threads, including the pre-HTTP policy refusal');
  for (const generation of generations) {
    const which = generation.threadId === us ? 'us' : 'eu';
    assert(generation.provider === 'openai' && generation.model === modelId && generation.compatibility.some(value => value.includes(`openai-${which}-gpt41-mini-2026-09-10`)), 'Attempt provenance must name the exact required native regional basis');
  }
  report.provenanceChecks.push('Every complete, failed, regenerated and summary attempt retains its matching native regional review basis');
  const saved: Checkpoint = { threadIds: { us, eu }, generationIds: generations.map(value => value.id), summary, canonicalSha256: await canonicalFingerprint() };
  localStorage.setItem(savedKey, JSON.stringify(saved)); report.canonical = saved;
  report.canonicalFingerprint = saved.canonicalSha256; report.verifiedSavedInputSha256 = summary.verifiedSavedInputSha256;
  await checkpoint('write-canonical-checkpoint');
}

async function restartPhase() {
  const saved = JSON.parse(localStorage.getItem(savedKey) ?? 'null') as Checkpoint | null;
  assert(saved && /^[0-9a-f]{64}$/.test(saved.canonicalSha256), 'Restart proof metadata is missing');
  checked(await canonicalFingerprint() === saved.canonicalSha256, 'Full native process restart preserves exact canonical policy, contexts, attempts, original history, events and summary provenance');
  await openProviders();
  for (const which of ['us', 'eu'] as const) {
    const panel = card(which)!;
    await poll(`${which} Keychain credential reopened`, () => panel.textContent?.includes('Credential connected'));
    checked(!(field(eligibilityLabel, panel) as HTMLInputElement).checked && !(field('I confirmed regional image-processing eligibility', panel) as HTMLInputElement).checked, `${which} Keychain reopen does not restore text or image eligibility`);
  }
  for (const which of ['us', 'eu'] as const) {
    await openThread(`Native ${which.toUpperCase()} regional notebook`);
    await poll(`${which} policy visible after restart`, () => field('Required processing region')?.value === which);
    await fill('Message', 'Synthetic restart request that must remain local.');
    checked(button('Send message')?.disabled, `${which} restart requires eligibility confirmation before sending`);
    field('Message')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, metaKey: true, bubbles: true }));
    await noAttemptsSince(saved.generationIds.length, `${which} unconfirmed restart creates no new attempt`);
    await fill('Message', '');
  }
  checked(await canonicalFingerprint() === saved.canonicalSha256, 'Refused restart sends preserve the complete canonical checkpoint');
  report.canonical = saved; report.canonicalFingerprint = saved.canonicalSha256; await checkpoint('restart-history-retained-and-unconfirmed');
}

async function main() {
  assert(config && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(config.profile) && ['write', 'restart', 'cleanup', 'tls-untrusted-ca', 'tls-wrong-hostname'].includes(config.phase), 'Isolated native UUIDv4 profile and phase are required');
  if (config.phase === 'write') { assert(localStorage.getItem(marker) === null, 'Synthetic WK profile must be fresh'); localStorage.setItem(marker, config.profile); }
  else if (config.phase === 'restart') assert(localStorage.getItem(marker) === config.profile, 'Native restart used a different WKWebsiteDataStore');
  else if (config.phase === 'cleanup') assert(localStorage.getItem(marker) === null || localStorage.getItem(marker) === config.profile, 'Cleanup marker belongs to another synthetic WKWebsiteDataStore');
  const archiveId = `test-regional-${config.profile}`; report.archiveId = archiveId;
  host = await createDesktopHost();
  checked(host.secretStore.available, 'Actual macOS Keychain backend is available for the isolated proof service');
  const capabilities = await host.capabilities(); report.hostCapabilities = capabilities;
  for (const which of ['us', 'eu'] as const) {
    const expected = openAIRegionalEvidence(which), transport = capabilities.providerTransports.find(value => value.id === expected.binding.transportId);
    checked(transport?.kind === 'native_direct' && transport.privacy === 'direct_provider' && transport.endpointOrigin === expected.upstreamOrigin && transport.capability.available && canonicalJson(transport.regionalProcessing as unknown as JsonValue) === canonicalJson(expected as unknown as JsonValue), `${which} production native capability exactly matches the registered origin, model, route and reviewed evidence`);
  }
  if (config.phase === 'tls-untrusted-ca' || config.phase === 'tls-wrong-hostname') {
    const binding = openAIRegionalEvidence('us').binding;
    assert(await host.openSecret(id(), binding) === null, 'TLS negative needs an empty isolated US credential binding');
    const value = new TextEncoder().encode('synthetic-native-us');
    const handle = await host.storeSecret(id(), binding, value, null); value.fill(0);
    try {
      let failure: { code?: string; message?: string } | undefined;
      try { await host.startProviderHttp({ requestId: id(), binding, method: 'GET', path: '/v1/models', headers: {}, credential: handle, bodyTransferId: null, timeout: { connectMs: 5000, idleMs: 5000, totalMs: 10000 } }); }
      catch (error) { failure = error as typeof failure; }
      checked(failure?.code === 'IO_ERROR', `${config.phase} refuses the exact registered native US HTTPS route before HTTP`);
      report.tlsNegative = { case: config.phase, errorCode: failure?.code, providerContentBytes: 0 };
    } finally { await host.deleteSecret(id(), handle); }
    checked(await host.openSecret(id(), binding) === null, 'TLS negative removes its synthetic Keychain credential');
    await checkpoint(config.phase); return;
  }
  if (config.phase === 'cleanup') {
    const deleted: string[] = [];
    for (const connection of desktopProviderConnections()) {
      const handle = await host.openSecret(id(), connection.binding);
      if (handle) { await host.deleteSecret(id(), handle); deleted.push(connection.id); }
      checked(await host.openSecret(id(), connection.binding) === null, `${connection.id} synthetic Keychain binding is absent after cleanup`);
    }
    const root = await navigator.storage.getDirectory();
    try { await root.removeEntry(`quixi-${archiveId}`, { recursive: true }); } catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; }
    localStorage.removeItem(savedKey); localStorage.removeItem(marker); report.deletedConnections = deleted;
    checked(true, 'Cleanup removes only this explicit test archive and synthetic profile checkpoint');
    await checkpoint('cleanup-complete'); return;
  }
  checked(isSecureContext && !!navigator.locks && !!navigator.storage?.getDirectory, 'Native bundled context provides secure OPFS and Web Locks');
  storage = createIsolatedStorageClient({ archiveId });
  const app = document.getElementById('app'); assert(app, 'App mount element is missing');
  unmount = mountApp(app, { archiveId, storage, host, providerSettings: { connections: desktopProviderConnections(), credentialCapability: { ...host.secretStore, permission: 'not_required' } } });
  await poll('production library ready', () => button('New conversation'));
  if (config.phase === 'write') await writePhase(); else await restartPhase();
  checked(report.cspViolations.length === 0, 'No main-document CSP violation occurred under the unchanged production policy');
}
document.addEventListener('securitypolicyviolation', event => { if (report.cspViolations.length < 16) report.cspViolations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI }); });
try { await main(); report.status = 'passed'; report.success = true; }
catch (error) {
  const failure = error as { code?: string; message?: string; stack?: string };
  report.status = 'failed'; report.error = { message: failure?.message ?? String(error), code: failure?.code, stack: failure?.stack };
  report.failureVisibleText = document.body.innerText.slice(-7000);
  // Preserve the actual failure before awaiting worker/host teardown: a stuck
  // cleanup must not replace the useful cause with the native watchdog alone.
  await checkpoint('failed-before-cleanup');
}
finally {
  try { await unmount?.(); await storage?.close(); await host?.dispose(); }
  catch (error) { report.status = 'failed'; report.success = false; report.cleanupError = String(error); }
  await invoke('regional_app_proof_report', { report: JSON.stringify(report), success: report.success });
}
