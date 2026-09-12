import test from "node:test";
import assert from "node:assert/strict";
import type { StorageClient, ThreadView } from "@quixi/core/contracts";
import type { ContentPart, ContextSnapshot, JsonObject, Message } from "@quixi/core/model";
import type { CompatibilityReport, Pricing, ProviderAdapter, ProviderInput } from "@quixi/providers";
import { initialProviderCatalogs, openAIRegionalEvidence } from "@quixi/providers";
import type { AppServices, ConfiguredProvider, LibraryController, LibrarySnapshot } from "../../src/runtime/library.ts";
import { createChatController } from "../../src/workflows/chat.ts";

const id = () => crypto.randomUUID();
const COMMIT_SENTINEL = "Reached canonical commit after cost approval.";
const pricing: Pricing = {
  currency: "USD", inputPerMillion: "1", outputPerMillion: "5",
  cachedInputPerMillion: null, cacheWriteInputPerMillion: null,
  sourceUrl: "https://example.test/reviewed-pricing", verifiedAt: 1,
};
const cappedProfile = (): JsonObject => ({
  version: 4, alias: null, candidates: [], allowPrivacyChange: false,
  requirements: { maxEstimatedRequestCost: "0.006" },
});

function fixture(options: { pricing?: Pricing | null; profile?: JsonObject } = {}) {
  const threadId = id();
  const parent: Message = {
    id: id(), threadId, parentId: null, role: "user", createdAt: 1, recordedAt: 1,
    generationId: null, editedFromMessageId: null, partCount: 1, sealed: true,
  };
  const part: ContentPart = { id: id(), messageId: parent.id, order: 0, kind: "Text", data: { text: "Existing history." } };
  const context: ContextSnapshot = {
    id: id(), threadId, previousId: null, version: 1, recordedAt: 1,
    systemPrompt: "Keep the request precise.", preferredRoute: null,
  };
  let state = {
    thread: { thread: { id: threadId }, state: { revision: 1, routingProfile: options.profile ?? cappedProfile() }, context },
    leaf: parent.id, busy: false, pendingMutation: false, error: null,
  } as LibrarySnapshot;
  const calls = { count: 0, stream: 0, commit: 0 };
  let canonicalView: ThreadView | undefined;
  let beforeCount = async () => {};
  const preparedInputs: ProviderInput[] = [], bodies: JsonObject[] = [];
  let countImpl = async (): Promise<{ tokens: number | null; source: "provider" | "unavailable"; reason: string | null }> => ({ tokens: 10, source: "provider", reason: null });
  const adapter = {
    analyze(input: ProviderInput): CompatibilityReport {
      return {
        target: { protocol: "anthropic", modelId: input.modelId }, preserved: { parts: input.messages.length, byKind: { Text: input.messages.length } },
        blocked: [], constraints: [], sendable: true, requestBytes: 100,
        context: { contextWindow: 200_000, maxOutputTokens: input.parameters.maxOutputTokens, inputRoom: 200_000 - input.parameters.maxOutputTokens },
        pricing: options.pricing === undefined ? pricing : options.pricing,
      };
    },
    prepare(input: ProviderInput) {
      preparedInputs.push(input);
      // Like a real adapter, omit fresh request/message/part IDs from wire data.
      const body: JsonObject = {
        model: input.modelId, system: input.systemPrompt,
        messages: input.messages.map(message => ({ role: message.role, content: message.parts.map(value => {
          assert.equal(value.kind, "Text");
          assert("text" in value.data && typeof value.data.text === "string");
          return { type: "text", text: value.data.text };
        }) })),
        max_tokens: input.parameters.maxOutputTokens,
        ...(input.parameters.temperature !== undefined ? { temperature: input.parameters.temperature } : {}),
        ...(input.parameters.topP !== undefined ? { top_p: input.parameters.topP } : {}),
        ...(input.parameters.stopSequences ? { stop_sequences: [...input.parameters.stopSequences] } : {}),
      };
      bodies.push(body);
      return { body };
    },
    async countTokens(_input: ProviderInput, beforeDispatch?: () => Promise<void>) { await beforeCount(); await beforeDispatch?.(); calls.count++; return countImpl(); },
    stream() { calls.stream++; assert.fail("No test may dispatch generation HTTP."); },
  } as unknown as ProviderAdapter;
  const provider: ConfiguredProvider = { id: "synthetic", label: "Synthetic", adapter, models: [] };
  const storage = {
    async request(_requestId: string, operation: string, args: { messageId?: string; leafMessageId?: string }) {
      if (operation === "readThreadView") return canonicalView ?? state.thread;
      if (operation === "readConversationWindow") {
        assert.equal(args.leafMessageId, parent.id);
        return { items: [parent], nextCursor: null };
      }
      if (operation === "readMessageParts") {
        assert.equal(args.messageId, parent.id);
        return { items: [part], nextCursor: null };
      }
      assert.fail(`Unexpected storage request: ${operation}`);
    },
  } as unknown as StorageClient;
  const library = {
    getSnapshot: () => state,
    patch(patch: Partial<LibrarySnapshot>) { state = { ...state, ...patch }; },
    mutation(kind: string, payload: object) { return { kind, ...payload }; },
    async commit() { calls.commit++; throw new Error(COMMIT_SENTINEL); },
  } as unknown as LibraryController;
  const controller = createChatController(library, { storage } as AppServices);
  const changeThread = (change: Partial<ThreadView>) => library.patch({ thread: { ...state.thread!, ...change } });
  const setProfile = (profile: JsonObject) => changeThread({ state: { ...state.thread!.state, routingProfile: profile } });
  return { controller, library, provider, parent, calls, preparedInputs, bodies, changeThread, setProfile,
    setCanonicalView: (value: ThreadView) => { canonicalView = value; },
    setBeforeCount: (value: typeof beforeCount) => { beforeCount = value; },
    setCountImpl: (value: typeof countImpl) => { countImpl = value; } };
}

function assertRefused(f: ReturnType<typeof fixture>, pattern = /Request cost limit:/) {
  assert.equal(f.calls.commit, 0, "cost refusal must precede canonical writes");
  assert.equal(f.calls.stream, 0, "cost refusal must precede generation HTTP");
  assert.match(f.library.getSnapshot().error!, pattern);
  assert.equal(f.library.getSnapshot().busy, false);
}

test("direct workflow send enforces the conservative cost bound without counting automatically", async () => {
  const f = fixture();
  assert.equal(await f.controller.send("Draft.", f.provider, "model"), false);
  assertRefused(f, /Conservative context bound.*exceeds/);
  assert.equal(f.calls.count, 0);
});

test("unknown pricing refuses before writes or generation even after explicit token counting", async () => {
  const f = fixture({ pricing: null });
  await f.controller.countPrompt("Draft.", f.provider, "model");
  assert.equal(await f.controller.send("Draft.", f.provider, "model"), false);
  assertRefused(f, /Verified USD input and output pricing is required/);
  assert.equal(f.calls.count, 1);
});

test("an explicit count unlocks identical wire content despite fresh canonical and request IDs", async () => {
  const f = fixture();
  assert.equal((await f.controller.countPrompt("Draft.", f.provider, "model"))?.tokens, 10);
  const counted = f.preparedInputs[0]!;
  assert.equal(await f.controller.send("Draft.", f.provider, "model"), false, "sentinel stops before any generation");
  assert.equal(f.calls.commit, 1);
  assert.equal(f.calls.count, 1);
  assert.equal(f.calls.stream, 0);
  assert.equal(f.library.getSnapshot().error, COMMIT_SENTINEL);
  const sent = f.preparedInputs.at(-1)!;
  assert.notEqual(counted.requestId, sent.requestId);
  assert.notEqual(counted.messages.at(-1)!.parts[0]!.id, sent.messages.at(-1)!.parts[0]!.id);
  assert.deepEqual(f.bodies[0], f.bodies.at(-1));
});

test("changed draft, system, model, adapter or output limit cannot reuse a count", async () => {
  for (const change of ["draft", "system", "model", "adapter", "output"] as const) {
    const f = fixture();
    await f.controller.countPrompt("Draft.", f.provider, "model");
    if (change === "system") f.changeThread({ context: { ...f.library.getSnapshot().thread!.context, id: id(), systemPrompt: "Changed system instruction." } });
    const provider = change === "adapter" ? { ...f.provider, adapter: { ...f.provider.adapter } } : f.provider;
    await f.controller.send(change === "draft" ? "Changed draft." : "Draft.", provider, change === "model" ? "different-model" : "model", { maxOutputTokens: change === "output" ? 1_025 : 1_024 });
    assertRefused(f, /Conservative context bound/);
    assert.equal(f.calls.count, 1, change);
  }
});

test("regeneration refuses a tight cap because the counted draft is a different request", async () => {
  const f = fixture();
  await f.controller.countPrompt("Draft.", f.provider, "model");
  await f.controller.regenerate(f.parent, f.provider, "model");
  assertRefused(f, /Conservative context bound/);
  assert.equal(f.calls.count, 1);
  assert.notDeepEqual(f.bodies[0], f.bodies.at(-1));
});

test("malformed or unsupported routing cost policies fail closed at the workflow boundary", async () => {
  for (const profile of [
    { ...cappedProfile(), version: 5 },
    { ...cappedProfile(), requirements: {} },
    { ...cappedProfile(), requirements: { maxEstimatedRequestCost: "NaN" } },
    { ...cappedProfile(), version: 3, primary: { provider: "synthetic", model: "model" } },
  ]) {
    const f = fixture({ profile });
    await assert.rejects(f.controller.countPrompt("Draft.", f.provider, "model"), /unsupported routing profile/);
    await f.controller.send("Draft.", f.provider, "model");
    assertRefused(f, /unsupported routing profile/);
    assert.equal(f.calls.count, 0);
    assert.deepEqual(f.preparedInputs, []);
  }
});

test("counts taken without a cap do not silently become cost authorization later", async () => {
  const f = fixture({ profile: { version: 2, alias: null, candidates: [], requirements: {}, allowPrivacyChange: false } });
  await f.controller.countPrompt("Draft.", f.provider, "model");
  f.setProfile(cappedProfile());
  await f.controller.send("Draft.", f.provider, "model");
  assertRefused(f, /Conservative context bound/);
  assert.equal(f.calls.count, 1);
});

test("the bounded count cache evicts older requests while retaining the other sixteen", async () => {
  const f = fixture();
  for (let index = 0; index < 17; index++) await f.controller.countPrompt(`Draft ${index}.`, f.provider, "model");
  await f.controller.send("Draft 0.", f.provider, "model");
  assertRefused(f, /Conservative context bound/);
  await f.controller.send("Draft 1.", f.provider, "model");
  assert.equal(f.calls.commit, 1);
  assert.equal(f.library.getSnapshot().error, COMMIT_SENTINEL);
  assert.equal(f.calls.count, 17);
  assert.equal(f.calls.stream, 0);
});

test("unavailable or invalid count results cannot unlock capped requests", async () => {
  for (const tokens of [null, NaN, -1, 0.5, 200_001]) {
    const f = fixture();
    f.setCountImpl(async () => ({ tokens, source: tokens === null ? "unavailable" : "provider", reason: null }));
    await f.controller.countPrompt("Draft.", f.provider, "model");
    await f.controller.send("Draft.", f.provider, "model");
    assertRefused(f);
    assert.equal(f.calls.count, 1);
  }
});

test("a late count after cancellation or context replacement cannot authorize a send", async () => {
  for (const change of ["cancel", "context"] as const) {
    const f = fixture();
    let started!: () => void, finish!: () => void;
    const countingStarted = new Promise<void>(resolve => { started = resolve; });
    const release = new Promise<void>(resolve => { finish = resolve; });
    f.setCountImpl(async () => { started(); await release; return { tokens: 10, source: "provider", reason: null }; });
    const counting = f.controller.countPrompt("Draft.", f.provider, "model");
    await countingStarted;
    if (change === "cancel") await f.controller.stop();
    else f.changeThread({ context: { ...f.library.getSnapshot().thread!.context, id: id() } });
    finish();
    assert.equal(await counting, null);
    await f.controller.send("Draft.", f.provider, "model");
    assertRefused(f, /Conservative context bound/);
    assert.equal(f.calls.count, 1);
  }
});

const regionalModel = 'gpt-4.1-mini-2025-04-14';
function regionalProfile(region: 'us' | 'eu'): JsonObject {
  return { version: 5, alias: null, candidates: [], allowPrivacyChange: false, requirements: { processingRegion: region } };
}
function regionalProvider(f: ReturnType<typeof fixture>, region: 'us' | 'eu'): ConfiguredProvider {
  const regionalProcessing = openAIRegionalEvidence(region);
  return { ...f.provider, regionalProcessing, adapter: { ...f.provider.adapter,
    binding: regionalProcessing.binding, protocol: 'openai-compatible',
    describeModel: () => initialProviderCatalogs()[0]!.model,
  } as ProviderAdapter };
}

test('required processing region refuses count, send and regeneration before dispatch or canonical writes', async () => {
  for (const connection of ['unknown', 'eu'] as const) {
    const f = fixture({ profile: regionalProfile('us') });
    const provider = connection === 'unknown' ? f.provider : regionalProvider(f, 'eu');
    await assert.rejects(f.controller.countPrompt('Draft.', provider, regionalModel), /Processing region/);
    await f.controller.send('Draft.', provider, regionalModel);
    assertRefused(f, /Processing region/);
    await f.controller.regenerate(f.parent, provider, regionalModel);
    assertRefused(f, /Processing region/);
    assert.equal(f.calls.count, 0);
    assert.deepEqual(f.preparedInputs, []);
  }
});

test('matching processing evidence permits preparation up to the canonical commit boundary', async () => {
  for (const region of ['us', 'eu'] as const) {
    const f = fixture({ profile: regionalProfile(region) }), provider = regionalProvider(f, region);
    assert.equal((await f.controller.countPrompt('Draft.', provider, regionalModel))?.tokens, 10);
    await f.controller.send('Draft.', provider, regionalModel);
    assert.equal(f.calls.commit, 1);
    assert.equal(f.library.getSnapshot().error, COMMIT_SENTINEL);
    assert.equal(f.calls.stream, 0, 'This fixture stops before real generation; browser proof verifies dispatch.');
  }
});

test('a tightened canonical region during count preparation refuses before the dispatch callback returns', async () => {
  const f = fixture({ profile: { version: 2, alias: null, candidates: [], requirements: {}, allowPrivacyChange: false } });
  f.setBeforeCount(async () => {
    const current = f.library.getSnapshot().thread!;
    f.setCanonicalView({ ...current, state: { ...current.state, revision: 2, routingProfile: regionalProfile('us') } });
  });
  await assert.rejects(f.controller.countPrompt('Draft.', f.provider, 'model'), /Processing region is unknown/);
  assert.equal(f.calls.count, 0);
  assert.equal(f.calls.commit, 0);
});

test('other canonical policy changes during count preparation also require a fresh review before dispatch', async () => {
  const f = fixture();
  f.setBeforeCount(async () => {
    const current = f.library.getSnapshot().thread!;
    f.setCanonicalView({ ...current, state: { ...current.state, revision: 2, routingProfile: { ...cappedProfile(), requirements: { maxEstimatedRequestCost: '0' } } } });
  });
  await assert.rejects(f.controller.countPrompt('Draft.', f.provider, 'model'), /policy or revision changed/);
  assert.equal(f.calls.count, 0);
  assert.equal(f.calls.commit, 0);
});

test('a late count is discarded after policy, canonical view or connection evidence changes', async () => {
  for (const change of ['policy', 'canonical', 'evidence'] as const) {
    const f = fixture({ profile: regionalProfile('us') }), provider = regionalProvider(f, 'us');
    f.setCountImpl(async () => {
      if (change === 'policy') f.setProfile(regionalProfile('eu'));
      if (change === 'canonical') {
        const current = f.library.getSnapshot().thread!;
        // Simulate a second client's commit not yet delivered to the UI cache.
        f.setCanonicalView({ ...current, state: { ...current.state, revision: 2, routingProfile: regionalProfile('eu') } });
      }
      if (change === 'evidence') provider.regionalProcessing = { ...provider.regionalProcessing!, configurationId: 'changed' };
      return { tokens: 10, source: 'provider', reason: null };
    });
    assert.equal(await f.controller.countPrompt('Draft.', provider, regionalModel), null, change);
    assert.equal(f.calls.count, 1);
    assert.equal(f.calls.commit, 0);
  }
});

test('revoked regional eligibility rejects an otherwise current late count', async () => {
  const f = fixture({ profile: regionalProfile('us') }), provider = regionalProvider(f, 'us');
  f.setCountImpl(async () => {
    provider.adapter.prepare = () => { throw new Error('Regional eligibility was revoked.'); };
    return { tokens: 10, source: 'provider', reason: null };
  });
  await assert.rejects(f.controller.countPrompt('Draft.', provider, regionalModel), /eligibility was revoked/);
  assert.equal(f.calls.count, 1);
  assert.equal(f.calls.commit, 0);
});
