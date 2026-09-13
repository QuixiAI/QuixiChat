import test from "node:test";
import assert from "node:assert/strict";
import type { HostClient, HostHttpResponse, ProviderHttpRequest } from "@quixi/core/contracts";
import { createAnthropicAdapter, createOpenAICompatibleAdapter, type Protocol } from "../src/index.ts";
import { fixture, input, model } from "./fixtures.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function harness(protocol: Protocol, foregroundStatus = 200) {
  const bodies = new Map<string, Uint8Array>();
  const released: string[] = [], cancelled: string[] = [];
  const probes: Array<{ request: ProviderHttpRequest; reply: ReturnType<typeof deferred<HostHttpResponse>> }> = [];
  let guard: (() => Promise<void>) | undefined;
  let readGate: ReturnType<typeof deferred<void>> | null = null;
  const readStarted = deferred<void>();
  const response = (requestId: string, status: number, body: string, stream = false): HostHttpResponse => {
    const bodyTransferId = crypto.randomUUID();
    bodies.set(bodyTransferId, new TextEncoder().encode(body));
    return { requestId, status, headers: { "content-type": stream ? "text/event-stream" : "application/json", ...(status === 429 ? { "retry-after": "20" } : {}) }, bodyTransferId };
  };
  const unused = async (): Promise<never> => { throw new Error("Unexpected host operation in health race test"); };
  const host = {
    capabilities: unused, openSecret: unused, storeSecret: unused, deleteSecret: unused,
    startOAuth: unused, chooseFiles: unused, adoptFiles: unused, openFileTransfer: unused,
    releaseFile: unused, saveFileTransfer: unused, notify: unused, writeClipboardText: unused,
    async startProviderHttp(request, beforeDispatch) {
      if (request.method === "GET") {
        guard = beforeDispatch;
        const reply = deferred<HostHttpResponse>();
        probes.push({ request, reply });
        return reply.promise;
      }
      await beforeDispatch?.();
      return response(request.requestId, foregroundStatus,
        foregroundStatus !== 200 ? JSON.stringify({ error: { message: "New foreground refusal" } }) :
          request.path.endsWith("count_tokens") ? JSON.stringify({ input_tokens: 17 }) : fixture(protocol),
        !request.path.endsWith("count_tokens") && foregroundStatus === 200);
    },
    async beginTransfer() { const transferId = crypto.randomUUID(); bodies.set(transferId, new Uint8Array()); return { transferId, maxChunkBytes: 65536, maxInFlight: 1 }; },
    async writeChunk(chunk) { return { transferId: chunk.transferId, sequence: chunk.sequence, committedOffset: chunk.offset + chunk.bytes.length }; },
    async finishTransfer(_requestId, transferId, expected) { return { transferId, ...expected, state: "verified_staged" as const }; },
    async releaseTransfer(_requestId, transferId) { released.push(transferId); bodies.delete(transferId); },
    async readChunk(transferId) {
      readStarted.resolve();
      if (readGate) await readGate.promise;
      const bytes = bodies.get(transferId);
      assert.ok(bytes, "response body remains owned until release");
      return { transferId, bytes, sequence: 0, offset: 0, final: true };
    },
    async acknowledgeChunk() {},
    async requestPersistentStorage() { return { persisted: false }; },
    async cancel(requestId) { cancelled.push(requestId); return { requestId, outcome: "cancelled" as const, externalEffect: "may_have_occurred" as const }; },
  } satisfies HostClient;
  const options = { host, binding: { providerId: protocol, accountId: "synthetic", destinationId: "synthetic", transportId: "synthetic" }, credential: null, catalog: [model(protocol)], nextId: () => crypto.randomUUID(), now: () => 1234 };
  const adapter = protocol === "anthropic" ? createAnthropicAdapter(options) : createOpenAICompatibleAdapter(options);
  return {
    adapter, probes, released, cancelled, bodies, readStarted,
    guard: () => guard!(),
    holdRead: () => { readGate = deferred<void>(); return () => readGate!.resolve(); },
    reply(index: number, status = 200) {
      const probe = probes[index]!;
      const result = response(probe.request.requestId, status, JSON.stringify(status === 200 ? { data: [{ id: "synthetic-model" }] } : { error: { message: "Old metadata refusal" } }));
      probe.reply.resolve(result);
      return result.bodyTransferId!;
    },
  };
}

for (const protocol of ["openai-compatible", "anthropic"] as const) {
  for (const foregroundStatus of [200, 429]) {
    for (const probeStatus of [200, 401]) {
      test(`${protocol}: late ${probeStatus} model probe preserves newer ${foregroundStatus} generation health`, async () => {
        const h = harness(protocol, foregroundStatus);
        const probe = h.adapter.listModels();
        const settled = probe.catch(() => null);
        for await (const _event of h.adapter.stream(input()).events) { /* Consume to terminal. */ }
        const current = h.adapter.accountHealth();
        assert.equal(current.evidence, "generation");
        assert.equal(current.status, foregroundStatus === 200 ? "healthy" : "rate_limited");
        h.reply(0, probeStatus);
        await settled;
        assert.deepEqual(h.adapter.accountHealth(), current);
        assert.equal(h.bodies.size, 0);
      });
    }
  }
}
for (const foregroundStatus of [200, 429]) {
  for (const probeStatus of [200, 401]) {
    test(`late ${probeStatus} model probe preserves newer ${foregroundStatus} token-count health`, async () => {
      const h = harness("anthropic", foregroundStatus);
      const probe = h.adapter.authenticate();
      await h.adapter.countTokens(input());
      const current = h.adapter.accountHealth();
      assert.equal(current.evidence, "transport");
      assert.equal(current.status, foregroundStatus === 200 ? "healthy" : "rate_limited");
      h.reply(0, probeStatus);
      assert.deepEqual(await probe, current);
      assert.deepEqual(h.adapter.accountHealth(), current);
      assert.equal(h.bodies.size, 0);
    });
  }
}
test("an overlapping old model probe cannot clear an already observed probe refusal", async () => {
  const h = harness("anthropic");
  const old = h.adapter.listModels();
  const newer = h.adapter.authenticate();
  h.reply(1, 401);
  const current = await newer;
  assert.equal(current.status, "authentication_expired");
  h.reply(0);
  await old;
  assert.deepEqual(h.adapter.accountHealth(), current);
});
test("a pre-aborted probe dispatches nothing and preserves health", async () => {
  const h = harness("anthropic"), cancellation = new AbortController();
  const current = h.adapter.accountHealth();
  cancellation.abort();
  await assert.rejects(h.adapter.authenticate(cancellation.signal), { name: "AbortError" });
  assert.equal(h.probes.length, 0);
  assert.deepEqual(h.cancelled, []);
  assert.deepEqual(h.adapter.accountHealth(), current);
});
for (const probeStatus of [200, 401]) {
  test(`an aborted held ${probeStatus} response cancels its request, rejects pre-dispatch and releases its late body`, async () => {
    const h = harness("anthropic"), cancellation = new AbortController();
    const current = h.adapter.accountHealth();
    const probe = h.adapter.authenticate(cancellation.signal);
    const rejected = assert.rejects(probe, { name: "AbortError" });
    cancellation.abort();
    await assert.rejects(h.guard(), { name: "AbortError" });
    assert.deepEqual(h.cancelled, [h.probes[0]!.request.requestId]);
    const bodyId = h.reply(0, probeStatus);
    await rejected;
    assert.deepEqual(h.adapter.accountHealth(), current);
    assert.deepEqual(h.released, [bodyId]);
    assert.equal(h.bodies.size, 0);
  });
}
test("cancellation during collection ignores bytes returned after cancellation and removes its listener", async () => {
  const h = harness("anthropic"), cancellation = new AbortController();
  const unblock = h.holdRead(), current = h.adapter.accountHealth();
  const probe = h.adapter.listModels(null, cancellation.signal);
  const rejected = assert.rejects(probe, { name: "AbortError" });
  const bodyId = h.reply(0);
  await h.readStarted.promise;
  cancellation.abort();
  unblock();
  await rejected;
  assert.deepEqual(h.adapter.accountHealth(), current);
  assert.deepEqual(h.released, [bodyId]);
  assert.equal(h.bodies.size, 0);

  const completedSignal = new AbortController();
  const completed = h.adapter.listModels(null, completedSignal.signal);
  h.reply(1);
  await completed;
  completedSignal.abort();
  assert.deepEqual(h.cancelled, [h.probes[0]!.request.requestId]);
  assert.equal(h.adapter.accountHealth().status, "healthy");
});
