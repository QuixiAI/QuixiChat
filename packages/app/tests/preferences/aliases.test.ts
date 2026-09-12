import test from "node:test";
import assert from "node:assert/strict";
import type { StorageClient, RoutingAliases } from "@quixi/core/contracts";
import { createAliasController } from "../../src/features/preferences/aliases-controller.ts";
const alias = { id: crypto.randomUUID(), name: "Coding", primary: { provider: "a", model: "first" }, candidates: [], requirements: {}, allowPrivacyChange: false };

test("lost alias-save replies recover by reading durable state, without automatic replay", async () => {
  let value: RoutingAliases = { version: 1, revision: 0, aliases: [] }, writes = 0;
  const controller = createAliasController({ async request(_id: string, operation: string) {
    if (operation === "putRoutingAlias") { writes++; value = { version: 1, revision: 1, aliases: [alias] }; throw new Error("Reply lost"); }
    return value;
  } } as unknown as StorageClient);
  await controller.refresh(); assert.equal(await controller.put(alias, 0), false);
  assert.equal(controller.getSnapshot().ready, false);
  assert.match(controller.getSnapshot().error!, /Reload aliases/);
  await controller.put(alias, 0); assert.equal(writes, 1);
  await controller.refresh(); assert.deepEqual(controller.getSnapshot().value.aliases, [alias]);
});

test("alias I/O is bounded to one call and preserves a displayed editor's original revision", async () => {
  let calls = 0, lastArgs: unknown, release!: (value: RoutingAliases) => void;
  const controller = createAliasController({ request(_id: string, _operation: string, args: unknown) { calls++; lastArgs = args; return new Promise(resolve => { release = resolve; }); } } as unknown as StorageClient);
  const first = controller.refresh();
  await Promise.all([controller.refresh(), controller.put(alias, 0), controller.remove(alias.id, 0)]);
  assert.equal(calls, 1); release({ version: 1, revision: 7, aliases: [alias] }); await first;
  const pending = controller.put(alias, 2);
  assert.deepEqual(lastArgs, { alias, expectedRevision: 2 });
  assert.equal(controller.getSnapshot().busy, true); release({ version: 1, revision: 8, aliases: [alias] }); await pending;
});

test("unsupported alias registries stay unavailable without harming recovery", async () => {
  let value: unknown = { version: 99, revision: 0, aliases: [] };
  const controller = createAliasController({ async request() { return value; } } as unknown as StorageClient);
  await controller.refresh(); assert.equal(controller.getSnapshot().ready, false);
  value = { version: 1, revision: 4, aliases: [] };
  await controller.refresh(); assert.equal(controller.getSnapshot().ready, true);
});

test("saved aliases retain independent cost and processing region requirements through save and reload", async () => {
  let durable: RoutingAliases = { version: 1, revision: 4, aliases: [] };
  const controller = createAliasController({ async request(_id: string, operation: string, args: { alias: RoutingAliases["aliases"][number]; expectedRevision: number } | null) {
    if (operation === "putRoutingAlias") {
      assert.equal(args!.expectedRevision, durable.revision);
      durable = { version: 1, revision: durable.revision + 1, aliases: [structuredClone(args!.alias)] };
    }
    return structuredClone(durable);
  } } as unknown as StorageClient);
  const source = { ...alias, requirements: { maxRequestCost: "0.02", maxEstimatedRequestCost: "0.10", processingRegion: 'us' as 'us' | 'eu' } };
  await controller.refresh();
  assert.equal(await controller.put(source, 4), true);
  source.requirements.maxEstimatedRequestCost = "0.30";
  source.requirements.processingRegion = 'eu';
  await controller.refresh();
  assert.deepEqual(controller.getSnapshot().value, {
    version: 1, revision: 5, aliases: [{ ...alias, requirements: { maxRequestCost: "0.02", maxEstimatedRequestCost: "0.10", processingRegion: 'us' } }],
  });
});
