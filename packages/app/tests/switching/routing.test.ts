import test from "node:test";
import assert from "node:assert/strict";
import type { CompatibilityReport } from "@quixi/providers";
import {
  chooseRoute,
  parseRoutingProfile,
  routingProfileJson,
  type RouteCandidate,
  type RoutingProfile,
} from "../../src/runtime/routing.ts";

const healthy = { blocksSending: false, label: "Healthy", detail: null };
const candidate = (
  provider: string,
  model: string,
  overrides: Partial<RouteCandidate> = {},
): RouteCandidate => ({
  requested: { provider, model },
  provider: { id: provider, label: provider === "anthropic" ? "Anthropic" : "OpenAI", privacy: "direct_provider" },
  model: {
    id: model,
    name: model === "claude" ? "Claude Haiku 4.5" : "GPT-4.1 mini",
    capabilities: { tools: "supported", images: "supported", contextWindow: model === "claude" ? 200_000 : 1_047_576 },
  },
  health: healthy,
  report: null,
  cost: null,
  ...overrides,
});
const report = (sendable: boolean): CompatibilityReport => ({
  target: { protocol: "anthropic", modelId: "claude" },
  preserved: { parts: 1, byKind: { Text: 1 } },
  blocked: sendable ? [] : [{ partId: "p", kind: "Image", code: "images_unsupported", message: "x" }],
  constraints: [],
  requestBytes: 100,
  sendable,
  context: { contextWindow: 200_000, maxOutputTokens: 1_024, inputRoom: 198_976 },
  pricing: null,
});
const profile = (overrides: Partial<RoutingProfile> = {}): RoutingProfile => ({
  alias: null,
  candidates: [{ provider: "openai", model: "gpt" }],
  requirements: {},
  allowPrivacyChange: false,
  ...overrides,
});

test("version 3 retains an applied primary and attribution without changing version 2 profiles", () => {
  const value = { ...profile(), primary: { provider: "anthropic", model: "claude" }, aliasSource: { id: "source", revision: 4 } };
  assert.deepEqual(parseRoutingProfile(routingProfileJson(null, value)), value);
  assert.equal(routingProfileJson(null, value)!.version, 3);
  assert.equal(parseRoutingProfile({ version: 3, primary: { provider: "", model: "x" } }), null);
  assert.equal(parseRoutingProfile({ version: 999 }), null);
  assert.equal(parseRoutingProfile({ version: 3, primary: value.primary, candidates: [], requirements: { region: "unknown" }, allowPrivacyChange: false }), null);
});

test("a version 1 fallback policy reads as a one-candidate profile and version 2 round-trips", () => {
  assert.deepEqual(parseRoutingProfile({ version: 1, fallback: { provider: "openai", model: "gpt", allowPrivacyChange: true } }), {
    alias: null,
    candidates: [{ provider: "openai", model: "gpt" }],
    requirements: {},
    allowPrivacyChange: true,
  });
  const full = profile({ alias: "Coding", requirements: { tools: true, contextAtLeast: 100_000, maxRequestCost: "0.50" } });
  const json = routingProfileJson(null, full);
  assert.deepEqual(json, { version: 2, alias: "Coding", candidates: [{ provider: "openai", model: "gpt" }], requirements: { tools: true, contextAtLeast: 100_000, maxRequestCost: "0.50" }, allowPrivacyChange: false });
  assert.deepEqual(parseRoutingProfile(json), full);
  assert.equal(parseRoutingProfile({ version: 2, candidates: [{ provider: "" }] }), null);
  assert.equal(parseRoutingProfile({ version: 2, requirements: { contextAtLeast: -1, maxRequestCost: "abc" } }), null);
  assert.equal(routingProfileJson(null, { alias: null, candidates: [], requirements: {}, allowPrivacyChange: false }), null);
  assert.deepEqual(routingProfileJson({ other: 1 }, null), { other: 1, version: 2, alias: null, candidates: [], requirements: {}, allowPrivacyChange: false });
});

test("a qualifying primary is chosen and the remaining candidates are not examined", () => {
  const decision = chooseRoute(profile(), candidate("anthropic", "claude"), [candidate("openai", "gpt")]);
  assert.equal(decision.chosenIndex, 0);
  assert.deepEqual(decision.reasons, ["Anthropic · Claude Haiku 4.5: chosen."]);
});

test("a primary that cannot send now or fails a requirement is routed around before the first attempt", () => {
  const blocked = chooseRoute(
    profile(),
    candidate("anthropic", "claude", { health: { blocksSending: true, label: "Authentication expired", detail: "reconnect it in Providers" } }),
    [candidate("openai", "gpt")],
  );
  assert.equal(blocked.chosenIndex, 1);
  assert.deepEqual(blocked.reasons, [
    "Anthropic · Claude Haiku 4.5: skipped — cannot send now: Authentication expired · reconnect it in Providers.",
    "OpenAI · GPT-4.1 mini: chosen.",
  ]);
  const context = chooseRoute(profile({ requirements: { contextAtLeast: 500_000 } }), candidate("anthropic", "claude"), [candidate("openai", "gpt")]);
  assert.equal(context.chosenIndex, 1);
  assert.equal(context.reasons[0], "Anthropic · Claude Haiku 4.5: skipped — context window 200,000 is below 500,000.");
  const none = chooseRoute(profile({ requirements: { contextAtLeast: 2_000_000 } }), candidate("anthropic", "claude"), [candidate("openai", "gpt")]);
  assert.equal(none.chosen, null);
  assert.equal(none.reasons[1], "OpenAI · GPT-4.1 mini: skipped — context window 1,047,576 is below 2,000,000.");
});

test("capability, privacy, cost and configuration requirements name their refusal", () => {
  const tools = chooseRoute(
    profile({ requirements: { tools: true, images: true } }),
    candidate("anthropic", "claude", { model: { id: "claude", name: "Claude Haiku 4.5", capabilities: { tools: "unsupported", images: "supported", contextWindow: 200_000 } } }),
    [candidate("openai", "gpt", { model: { id: "gpt", name: "GPT-4.1 mini", capabilities: { tools: "supported", images: "unknown", contextWindow: 1 } } })],
  );
  assert.equal(tools.chosen, null);
  assert.deepEqual(tools.reasons, [
    "Anthropic · Claude Haiku 4.5: skipped — does not declare tool support.",
    "OpenAI · GPT-4.1 mini: skipped — does not declare image input.",
  ]);
  const privacy = chooseRoute(
    profile(),
    candidate("anthropic", "claude", { health: { blocksSending: true, label: "Offline", detail: null } }),
    [candidate("openai", "gpt", { provider: { id: "openai", label: "OpenAI", privacy: "quixi_relay" } })],
  );
  assert.equal(privacy.chosen, null);
  assert.match(privacy.reasons[1] ?? "", /would change the privacy class from Direct provider to Quixi relay, which this conversation does not allow/);
  const allowed = chooseRoute(profile({ allowPrivacyChange: true }), candidate("anthropic", "claude", { health: { blocksSending: true, label: "Offline", detail: null } }), [
    candidate("openai", "gpt", { provider: { id: "openai", label: "OpenAI", privacy: "quixi_relay" } }),
  ]);
  assert.equal(allowed.chosenIndex, 1);
  const cost = chooseRoute(profile({ requirements: { maxRequestCost: "0.001" } }), candidate("anthropic", "claude", { cost: { allowed: false, reason: "Counted input cost exceeds the input limit", inputAmount: "0.005", totalAmount: "0.01", basis: "counted" } }), [candidate("openai", "gpt")]);
  assert.equal(cost.chosen, null);
  assert.match(cost.reasons[0]!, /Counted input cost exceeds the input limit/);
  assert.match(cost.reasons[1]!, /request cost has not been assessed/);
  const missing = chooseRoute(profile(), candidate("anthropic", "claude", { health: { blocksSending: true, label: "Offline", detail: null } }), [
    candidate("openai", "gpt", { provider: null, model: null, health: null }),
    candidate("openai", "other", { model: null }),
  ]);
  assert.deepEqual(missing.reasons.slice(1), [
    "openai · gpt: skipped — not configured on this device.",
    'openai · other: skipped — OpenAI has no reviewed model "other".',
  ]);
});

test("a primary whose report refuses the path is still chosen when nothing else qualifies", () => {
  const decision = chooseRoute(profile(), candidate("anthropic", "claude", { report: report(false) }), [candidate("openai", "gpt", { report: report(false) })]);
  assert.equal(decision.chosenIndex, 0);
  assert.equal(decision.reasons[0], "Anthropic · Claude Haiku 4.5: chosen; its compatibility report refuses the path, so sending waits on that report.");
  const routed = chooseRoute(profile(), candidate("anthropic", "claude", { report: report(false) }), [candidate("openai", "gpt", { report: report(true) })]);
  assert.equal(routed.chosenIndex, 1);
});


test("total request caps require v4 and round-trip with or without a primary while legacy caps remain independent", () => {
  for (const primary of [undefined, { provider: 'anthropic', model: 'claude' }]) {
    const value = profile({ ...(primary ? { primary } : {}), requirements: { maxRequestCost: '0.25', maxEstimatedRequestCost: '0.5' } });
    const json = routingProfileJson(null, value)!;
    assert.equal(json.version, 4);
    assert.deepEqual(parseRoutingProfile(json), value);
    assert.equal(parseRoutingProfile({ ...json, version: 2 }), null);
    assert.equal(parseRoutingProfile({ ...json, version: 3 }), null);
    assert.equal(parseRoutingProfile({ ...json, requirements: { maxEstimatedRequestCost: '-1' } }), null);
    assert.equal(parseRoutingProfile({ ...json, requirements: {} }), null);
  }
});

test("processing regions require v5 and round-trip independently of primary and total cost requirements", () => {
  for (const primary of [undefined, { provider: 'anthropic', model: 'claude' }]) {
    for (const maxEstimatedRequestCost of [undefined, '0.5']) {
      const value = profile({ ...(primary ? { primary, aliasSource: { id: 'saved-alias', revision: 8 } } : {}), requirements: { processingRegion: 'us', maxRequestCost: '0.25', ...(maxEstimatedRequestCost ? { maxEstimatedRequestCost } : {}) } });
      const json = routingProfileJson(null, value)!;
      assert.equal(json.version, 5);
      assert.deepEqual(parseRoutingProfile(json), value);
      for (const version of [1, 2, 3, 4]) assert.equal(parseRoutingProfile({ ...json, version, fallback: { provider: 'openai', model: 'gpt', allowPrivacyChange: false } }), null, `version ${version} must refuse region requirements`);
      assert.equal(parseRoutingProfile({ ...json, requirements: { maxEstimatedRequestCost: '0.5' } }), null);
      for (const processingRegion of ['US', 'global', null]) assert.equal(parseRoutingProfile({ ...json, requirements: { processingRegion } }), null);
      const parsed = parseRoutingProfile(json)!; parsed.requirements.processingRegion = 'eu';
      assert.equal((json.requirements as { processingRegion: string }).processingRegion, 'us');
    }
  }
});

test("region routing refuses unknown and denied candidates and names the qualifying fallback evidence", () => {
  const required = profile({ requirements: { processingRegion: 'us' } });
  const primary = candidate('anthropic', 'claude');
  const denied = candidate('openai', 'gpt', { region: { allowed: false, reason: 'Requested US processing but this connection is EU', basis: 'native_eu' } });
  const refused = chooseRoute(required, primary, [denied]);
  assert.equal(refused.chosen, null); assert.match(refused.reasons[0]!, /region has not been assessed/); assert.match(refused.reasons[1]!, /this connection is EU/);
  const eligible = candidate('openai', 'gpt', { region: { allowed: true, reason: 'Verified native US processing for this model and account', basis: 'native_us' } });
  const chosen = chooseRoute(required, primary, [eligible]);
  assert.equal(chosen.chosen, eligible); assert.equal(chosen.chosenIndex, 1); assert.match(chosen.reasons[1]!, /Verified native US processing/);
  assert.equal(chooseRoute(profile(), primary, []).chosen, primary, 'no requirement preserves connections without regional evidence');
});
