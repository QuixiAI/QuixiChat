import { browserEngines } from "../../../tooling/browser-engines.mjs";
const selectedEngines = browserEngines({ chromium, webkit });
import { build, preview } from "vite";
import { chromium, webkit } from "@playwright/test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { providerFixture, fixtureStats } from "./fixture-server.ts";
const temporary = await mkdtemp(resolve(tmpdir(), "quixi-provider-proof-"));
let server;
const report = { selectedEngines: selectedEngines.map(([name]) => name),
  status: "running",
  startedAt: new Date().toISOString(),
  hosts: [],
};
const reportFile = resolve(
  import.meta.dirname,
  "../../../test-results/providers-browser.json",
);
await mkdir(resolve(import.meta.dirname, "../../../test-results"), {
  recursive: true,
});
const save = () =>
  writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
const call = (page, operation, value) =>
  page.evaluate(
    ({ operation, value }) => window.providerProof(operation, value),
    { operation, value },
  );
const visit = async (context) => {
  const page = await context.newPage();
  page.on("pageerror", (error) => process.stderr.write(String(error) + "\n"));
  await page.goto("http://127.0.0.1:4198/browser.html");
  await page.waitForFunction(() => typeof window.providerProof === "function");
  return page;
};
try {
  const buildOptions = {
    outDir: resolve(temporary, "dist"),
    emptyOutDir: true,
    rollupOptions: { input: resolve(import.meta.dirname, "browser.html") },
  };
  await build({
    configFile: false,
    root: import.meta.dirname,
    build: buildOptions,
    logLevel: "warn",
  });
  server = await preview({
    configFile: false,
    root: import.meta.dirname,
    build: buildOptions,
    preview: { host: "127.0.0.1", port: 4198, strictPort: true },
    plugins: [
      {
        name: "synthetic-provider-fixture",
        configurePreviewServer(server) {
          server.middlewares.use(providerFixture);
        },
      },
    ],
    logLevel: "warn",
  });
  for (const [name, engine] of selectedEngines) {
    const host = { name, status: "running", checks: [] };
    report.hosts.push(host);
    await save();
    let context = await engine.launchPersistentContext(
      resolve(temporary, name),
      { headless: true },
    );
    try {
      const page = await visit(context);
      host.userAgent = await page.evaluate(() => navigator.userAgent);
      host.transport = await call(page, "host");
      host.checks.push(...host.transport.checks);
      let reasoningReplay;
      for (const protocol of ["openai-compatible", "anthropic"])
        for (const mode of ["synthetic-model", "malformed", "slow"]) {
          const result = await call(page, "persist", {
            protocol,
            mode,
            archiveId: `test-provider-${crypto.randomUUID()}`,
            lostReply: mode === "synthetic-model",
          });
          assert.equal(result.result.persisted, true, JSON.stringify(result));
          const data = await call(page, "verify", result);
          assert.equal(
            data.generation.status,
            mode === "synthetic-model"
              ? "complete"
              : mode === "slow"
                ? "cancelled"
                : "partial",
          );
          assert.equal(data.manifest.terminal.status, data.generation.status);
          assert(
            data.rawText.includes(
              protocol === "anthropic" ? "message_start" : "chatcmpl-synthetic",
            ),
          );
          assert(data.parts.some((part) => part.kind === "Text"));
          assert.equal(
            new Set(data.parts.map((part) => part.id)).size,
            data.parts.length,
          );
          assert.equal(
            data.parts.filter(
              (part) =>
                part.kind === "ProviderArtifact" &&
                part.data.providerKind === "quixi.provider.raw-stream-chunk",
            ).length,
            data.manifest.raw.segments,
          );
          assert.equal(data.diagnostics.integrity, "ok");
          if (protocol === "anthropic" && mode === "synthetic-model") {
            assert.deepEqual(data.reasoning.map(value => [value.index, value.block]), [
              [1, { type: "thinking", thinking: "synthetic reasoning", signature: "synthetic-signature" }],
              [3, { type: "redacted_thinking", data: "synthetic-encrypted+/=" }],
            ]);
            for (const receipt of data.reasoning) {
              assert.equal(receipt.generationId, result.generationId);
              assert.equal(receipt.outputMessageId, result.outputId);
              assert.equal(receipt.responseId, data.manifest.responseId);
              assert(receipt.source.startRecord < receipt.source.endRecord);
              assert(receipt.source.rawBytesThroughCheckpoint <= Buffer.byteLength(data.rawText));
            }
            reasoningReplay = { result, data };
          } else assert.deepEqual(data.reasoning, []);
          if (mode === "synthetic-model") assert.equal(result.dropped, true);
          host.checks.push(
            `${protocol}/${mode}: public SQLite/OPFS checkpoints, source bytes, terminal manifest and replay identity survive reopen`,
          );
        }
      for (const creationBarrier of ["reject", "cancel"]) {
        const before = fixtureStats.requests;
        const blocked = await call(page, "persist", {
          protocol: "openai-compatible",
          mode: "synthetic-model",
          archiveId: `test-provider-barrier-${crypto.randomUUID()}`,
          creationBarrier,
        });
        assert.equal(blocked.result.persisted, true, JSON.stringify(blocked));
        assert.equal(
          blocked.result.terminal.status,
          creationBarrier === "reject" ? "failed" : "cancelled",
        );
        assert.equal(
          fixtureStats.requests,
          before,
          "Producer barrier failure or cancellation dispatched HTTP",
        );
        const canonical = await call(page, "verify", blocked);
        assert.equal(
          canonical.generation.status,
          blocked.result.terminal.status,
        );
        assert.equal(canonical.manifest.raw.segments, 0);
        host.checks.push(
          `awaited durable-creation hook ${creationBarrier} prevents provider dispatch and commits its terminal outcome`,
        );
      }
      const failed = await call(page, "persist", {
        protocol: "openai-compatible",
        mode: "delayed",
        archiveId: `test-provider-quota-${crypto.randomUUID()}`,
        storageFailure: true,
      });
      assert.equal(failed.result.persisted, false);
      assert.equal(failed.result.error.code, "QUOTA_EXCEEDED");
      const retained = await call(page, "verify", failed);
      assert.equal(retained.generation.status, "partial");
      assert(retained.parts.some((part) => part.kind === "Text"));
      assert.equal(retained.manifest, null);
      host.checks.push(
        "storage quota failure cancels transport; after the producer releases its independent lease, recovery seals the committed prefix as partial",
      );
      // Plan 06 reasoning continuation: a persisted thinking response is
      // continued from its verified receipts through the same adapter path
      // inspection, counting and sending share, over actual HTTP.
      {
        const reasoned = await call(page, "persist", {
          protocol: "anthropic",
          mode: "reasoned",
          archiveId: `test-provider-reasoned-${crypto.randomUUID()}`,
        });
        assert.equal(reasoned.result.persisted, true, JSON.stringify(reasoned));
        assert.equal(reasoned.result.terminal.status, "complete");
        const stored = await call(page, "verify", reasoned);
        const expectedBlocks = [
          [0, { type: "thinking", thinking: "\ufeffreasoned 🧪 in two parts\r\n", signature: "reasoned-signature+/=" }],
          [1, { type: "redacted_thinking", data: "reasoned-redacted+/=" }],
        ];
        assert.deepEqual(stored.reasoning.map((value) => [value.index, value.block]), expectedBlocks);
        const requestsBefore = fixtureStats.requests, continuationsBefore = fixtureStats.continuations;
        const continued = await call(page, "continue", reasoned);
        assert.deepEqual(continued.receipts, stored.reasoning, "receipts read through the storage client differ from the verified ones");
        assert.deepEqual(continued.rebuilt, continued.receipts, "raw-stream reconstruction differs from the receipts the consumer wrote");
        assert.deepEqual(continued.bound.unbound, []);
        assert.deepEqual(continued.rebound.reasoning, continued.bound.reasoning);
        assert.equal(Object.keys(continued.bound.reasoning).length, 2);
        assert.equal(continued.report.sendable, true, JSON.stringify(continued.report));
        assert.equal(continued.report.preserved.byKind.ReasoningMetadata, 2);
        assert.equal(continued.unverified.sendable, false);
        assert.deepEqual(continued.unverified.blocked.map((item) => item.code), ["reasoning_evidence_missing", "reasoning_evidence_missing"]);
        assert.deepEqual(continued.prepared.thinking, { type: "enabled", budget_tokens: 1024 });
        assert.equal(continued.prepared.maxTokens, 2048);
        assert.equal(continued.prepared.topP, 0.95);
        assert.deepEqual(continued.prepared.assistant, [expectedBlocks[0][1], expectedBlocks[1][1], { type: "text", text: "Reasoned answer 🧪" }]);
        assert.equal(continued.count.source, "provider");
        assert.equal(continued.terminal.status, "complete");
        assert.deepEqual(continued.responseReceipts, expectedBlocks);
        assert.equal(fixtureStats.requests, requestsBefore + 2, "continuation sent other than one count and one generation");
        assert.equal(fixtureStats.continuations, continuationsBefore + 2);
        assert.deepEqual(fixtureStats.lastContinuation.thinking, { type: "enabled", budget_tokens: 1024 });
        assert.deepEqual(fixtureStats.lastContinuation.blocks, expectedBlocks.map(([, block]) => block));
        assert.equal(fixtureStats.lastContinuation.counted, false);
        host.checks.push(
          "a persisted signed/redacted thinking response is continued from receipts read through the storage client, bound to its generation and stream records, equal to a raw-stream reconstruction, mapped first and unchanged into a thinking-enabled follow-up whose count and generation bodies the loopback provider accepted, while the same branch without evidence is refused by name",
        );
      }
      const archiveId = `test-provider-handoff-${crypto.randomUUID()}`;
      const owner = await visit(context);
      const initial = await call(owner, "owner", archiveId);
      await page.evaluate(() => {
        window.providerCheckpoint = null;
      });
      const requestsBefore = fixtureStats.requests;
      const running = call(page, "persist", {
        protocol: "openai-compatible",
        mode: "delayed",
        archiveId,
      });
      await page.waitForFunction(
        () => window.providerCheckpoint?.partCount >= 1,
      );
      await owner.close();
      const result = await running;
      assert.equal(result.result.persisted, true, JSON.stringify(result));
      assert.equal(fixtureStats.requests, requestsBefore + 1);
      const data = await call(page, "verify", result);
      assert.equal(data.generation.status, "complete");
      assert.notEqual(data.diagnostics.ownerId, initial.ownerId);
      assert.equal(
        data.parts
          .filter((part) => part.kind === "Text")
          .map((part) => part.data.text)
          .join(""),
        "Hello 🧪 done",
      );
      host.checks.push(
        "terminating the storage owner tab preserves one live provider request and complete output through takeover",
      );
      await context.close();
      context = await engine.launchPersistentContext(resolve(temporary, name), {
        headless: true,
      });
      const restarted = await visit(context);
      const afterRestart = await call(restarted, "verify", result);
      assert.equal(afterRestart.generation.status, "complete");
      assert.equal(afterRestart.rawText, data.rawText);
      assert(reasoningReplay, "Missing signed-thinking persistence scenario");
      const reasoningAfterRestart = await call(restarted, "verify", reasoningReplay.result);
      assert.deepEqual(reasoningAfterRestart.reasoning, reasoningReplay.data.reasoning);
      assert.deepEqual(reasoningAfterRestart.parts, reasoningReplay.data.parts);
      assert.equal(reasoningAfterRestart.rawText, reasoningReplay.data.rawText);
      host.checks.push("signed and redacted thinking receipts survive a lost commit reply, verified blob reads, reopen and full browser restart without changed source bytes or duplicate receipts");
      host.reasoningArchive = await call(restarted, "reasoning-archive", { archiveId: reasoningReplay.result.archiveId, blobs: reasoningAfterRestart.reasoningBlobs });
      host.checks.push("portable export and isolated restore preserve signed/redacted receipt hashes and canonical inventories under independent query-only candidate inspection");
      host.checks.push(
        "provider generation, raw response and terminal manifest survive browser process restart",
      );
      host.status = "passed";
    } finally {
      await context.close();
      await save();
    }
  }
  assert(fixtureStats.disconnected >= 4);
  report.fixtureStats = fixtureStats;
  report.sourceSha256 = {};
  for (const file of ["../../tooling/browser-engines.mjs", 
    "src/types.ts",
    "tests/fixtures.ts",
    "tests/reasoning.test.ts",
    "tests/generation.test.ts",
    "tests/run-browser.mjs",
    "tests/reasoning-archive.ts",
    "../storage/tests/archives/browser-worker.ts",
    "../storage/tests/archives/candidate-reader.ts",
    "src/adapter.ts",
    "src/normalize.ts",
    "src/sse.ts",
    "src/request.ts",
    "src/reasoning.ts",
    "tests/continuation.test.ts",
    "src/generation.ts",
    "../app/src/workflows/generation.ts",
    "../storage/src/client/producer.ts",
    "../storage/src/worker/producers.ts",
    "../storage/src/worker/archive.ts",
    "../storage/src/worker/archive-database.ts",
    "tests/browser.ts",
    "tests/host-proof.ts",
    "tests/audio-fixtures.ts",
    "src/catalog.ts",
    "tests/fixture-server.ts",
  ])
    report.sourceSha256[file] = createHash("sha256")
      .update(await readFile(resolve(import.meta.dirname, "..", file)))
      .digest("hex");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await save();
  await server?.close();
  await rm(temporary, { recursive: true, force: true });
}
process.stdout.write(
  JSON.stringify(
    {
      status: report.status,
      hosts: report.hosts.map((host) => ({
        name: host.name,
        status: host.status,
        checks: host.checks.length,
      })),
      error: report.error,
      reportFile,
    },
    null,
    2,
  ) + "\n",
);
