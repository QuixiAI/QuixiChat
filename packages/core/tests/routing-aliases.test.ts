import test from "node:test";
import assert from "node:assert/strict";
import { assertRoutingAlias, assertRoutingAliases, assertRoutingAliasArgs, assertRoutingRequirements, routingAliasSnapshot } from "../src/contracts/routing-aliases.ts";
const alias = () => ({ id: crypto.randomUUID(), name: "Coding", primary: { provider: "a", model: "first" }, candidates: [{ provider: "b", model: "next" }], requirements: { tools: true, contextAtLeast: 100000, maxRequestCost: "0.50" }, allowPrivacyChange: false });

test("alias validation refuses unknown fields, missing targets, duplicate targets and invalid constraints", () => {
  assert.doesNotThrow(() => assertRoutingAlias(alias()));
  for (const change of [{ name: " " }, { name: "a".repeat(65) }, { id: "x" }, { primary: { provider: "", model: "a" } }, { primary: { provider: "a", model: "x".repeat(257) } }, { requirements: { region: "unknown" } }, { requirements: { contextAtLeast: -1 } }, { requirements: { maxRequestCost: "NaN" } }, { requirements: { maxRequestCost: "1e6" } }, { requirements: { tools: "true" } }, { candidates: [{ provider: "a", model: "first" }] }, { candidates: Array.from({ length: 9 }, (_, i) => ({ provider: "b", model: String(i) })) }, { secret: "refused" }])
    assert.throws(() => assertRoutingAlias({ ...alias(), ...change }));
});

test("registry bounds enforce unique names, ids, version, count and actual serialized bytes", () => {
  const a = alias();
  for (const value of [{ version: 2, revision: 0, aliases: [] }, { version: 1, revision: -1, aliases: [] }, { version: 1, revision: 0, aliases: [a, a] }, { version: 1, revision: 0, aliases: [a, { ...alias(), name: "coding" }] }, { version: 1, revision: 0, aliases: Array.from({ length: 33 }, (_, i) => ({ ...alias(), name: String(i) })) }]) assert.throws(() => assertRoutingAliases(value));
  const oversized = Array.from({ length: 8 }, (_, i) => ({ ...alias(), name: String(i), candidates: Array.from({ length: 8 }, (_, j) => ({ provider: "p".repeat(128), model: String(j) + "m".repeat(255) })) }));
  assert.throws(() => assertRoutingAliases({ version: 1, revision: 0, aliases: oversized }), /16 KiB/);
});

test("operation arguments refuse arbitrary keys, missing ids and unsafe revisions", () => {
  assert.throws(() => assertRoutingAliasArgs("readRoutingAliases", {}));
  assert.throws(() => assertRoutingAliasArgs("putRoutingAlias", { expectedRevision: 0, alias: alias(), extra: true }));
  assert.throws(() => assertRoutingAliasArgs("removeRoutingAlias", { expectedRevision: 0, aliasId: "no" }));
  assert.throws(() => assertRoutingAliasArgs("putRoutingAlias", { expectedRevision: Number.MAX_SAFE_INTEGER, alias: alias() }));
});

test("canonical alias snapshot deep-copies every route field and source attribution", () => {
  const source = alias(), value = routingAliasSnapshot(source, 7);
  assert.deepEqual(value, { version: 3, alias: "Coding", primary: source.primary, candidates: source.candidates, requirements: source.requirements, allowPrivacyChange: false, aliasSource: { id: source.id, revision: 7 } });
  source.primary.model = "changed"; source.candidates[0]!.model = "changed"; source.requirements.tools = false;
  assert.equal((value.primary as { model: string }).model, "first");
  assert.equal((value.candidates as { model: string }[])[0]!.model, "next");
  assert.equal((value.requirements as { tools: boolean }).tools, true);
});

test("input and per-attempt request cost constraints accept only bounded USD decimals independently", () => {
  for (const field of ["maxRequestCost", "maxEstimatedRequestCost"] as const) {
    for (const value of ["0", "0.000000001", "1", "1.20", "999999999", "999999999.999999999"])
      assert.doesNotThrow(() => assertRoutingRequirements({ [field]: value }));
    for (const value of ["", "NaN", "Infinity", "1e6", "-1", "+1", ".1", "1.", " 1", "1 ", "1000000000", "0.0000000001", 1, null, undefined])
      assert.throws(() => assertRoutingRequirements({ [field]: value }), /USD decimal/);
  }
  assert.doesNotThrow(() => assertRoutingRequirements({ maxRequestCost: "0.02", maxEstimatedRequestCost: "0.10" }));
  assert.throws(() => assertRoutingRequirements({ maxEstimatedRequestCost: "0.10", unsupportedCost: "1" }), /Unsupported/);
});

test("only aliases with a total request cost constraint produce version 4 immutable snapshots", () => {
  const source = { ...alias(), requirements: { ...alias().requirements, maxEstimatedRequestCost: "0.10" } };
  assert.doesNotThrow(() => assertRoutingAliases({ version: 1, revision: 8, aliases: [source] }));
  const value = routingAliasSnapshot(source, 8);
  assert.deepEqual(value, { version: 4, alias: "Coding", primary: source.primary, candidates: source.candidates, requirements: source.requirements, allowPrivacyChange: false, aliasSource: { id: source.id, revision: 8 } });
  source.requirements.maxRequestCost = "0.60";
  source.requirements.maxEstimatedRequestCost = "0.20";
  source.primary.model = "different";
  source.candidates[0]!.model = "different";
  assert.deepEqual(value.requirements, { tools: true, contextAtLeast: 100000, maxRequestCost: "0.50", maxEstimatedRequestCost: "0.10" });
  assert.equal((value.primary as { model: string }).model, "first");
  assert.equal((value.candidates as { model: string }[])[0]!.model, "next");
  assert.equal(routingAliasSnapshot(alias(), 8).version, 3);
  assert.equal(routingAliasSnapshot({ ...alias(), requirements: { maxEstimatedRequestCost: "0" } }, 8).version, 4);
  assert.equal(routingAliasSnapshot({ ...alias(), requirements: {} }, 8).version, 3);
});

test("processing regions are closed US/EU constraints and produce immutable version 5 snapshots", () => {
  for (const processingRegion of ['us', 'eu'] as const) {
    const source = { ...alias(), requirements: { processingRegion, maxRequestCost: '0.25', maxEstimatedRequestCost: '0.5' } };
    assert.doesNotThrow(() => assertRoutingAliases({ version: 1, revision: 9, aliases: [source] }));
    const snapshot = routingAliasSnapshot(source, 9);
    assert.equal(snapshot.version, 5);
    assert.deepEqual(snapshot.requirements, source.requirements);
    source.requirements.processingRegion = processingRegion === 'us' ? 'eu' : 'us';
    source.requirements.maxEstimatedRequestCost = '1';
    assert.deepEqual(snapshot.requirements, { processingRegion, maxRequestCost: '0.25', maxEstimatedRequestCost: '0.5' });
    assert.equal(routingAliasSnapshot({ ...alias(), requirements: { processingRegion } }, 9).version, 5);
  }
  for (const processingRegion of ['', 'US', 'uk', 'global', null, undefined, 1, ['us'], { region: 'us' }])
    assert.throws(() => assertRoutingRequirements({ processingRegion }), /processing region/);
});
