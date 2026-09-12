import { exerciseHealthRefresh } from "./health-refresh.mjs";
import { exercisePendingRecovery } from "./pending-recovery.mjs";
import { exerciseAliasApplicationAccessibility } from "./alias-application-accessibility.mjs";
import { exerciseCompatibilityAnnouncements } from "./compatibility-announcements.mjs";
import { exerciseRegionalRouting, verifyRegionalRestart } from './regions.mjs';
import { exerciseComposerFiles, verifyComposerFilesRestart } from './composer-files.mjs';
import { exerciseAudioInput, verifyAudioInputRestart } from './audio-input.mjs';
import { defaultInteractions, exerciseInteractionPreferences, prepareInteractionPreferencesRestart, verifyInteractionPreferencesRestart } from './interaction-preferences.mjs';
import { exercisePreferenceFocus, keyboardActivate, observeProgress, verifyProgress } from './keyboard-focus.mjs';
import { exerciseAliasReflow, captureReviewLayout } from './review-accessibility.mjs';
import { exerciseAliasRemovalFocus } from './alias-removal-focus.mjs';
import { exerciseReasoningContinuation, verifyReasoningContinuationRestart } from './reasoning-continuation.mjs';
import { exerciseOutputParts } from './output-parts.mjs';
import { exerciseSemanticSearch } from './semantic.mjs';
import { exerciseOnboarding } from './onboarding.mjs';
import { browserEngines } from "../../../../tooling/browser-engines.mjs";
import { embeddingModelAssets } from "../../../../tooling/embedding-assets.ts";
const selectedEngines = browserEngines({ chromium, webkit });
import { build, preview } from "vite";
import { chromium, webkit, expect } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { platform, release, arch } from "node:os";
import { execFileSync } from "node:child_process";
const temporary = await mkdtemp(resolve(tmpdir(), "quixi-app-")),
  report = { selectedEngines: selectedEngines.map(([name]) => name),
    status: "running",
    startedAt: new Date().toISOString(),
    hosts: [],
    sourceSha256: {},
    environment: {
      platform: platform(),
      release: release(),
      arch: arch(),
      osVersion:
        platform() === "darwin"
          ? execFileSync("sw_vers", ["-productVersion"], {
              encoding: "utf8",
            }).trim()
          : release(),
      node: process.version,
    },
  };
let server,
  holdNext = false,
  releaseHeld = () => {},
  // One controlled provider failure for the next chat request: status,
  // headers and JSON body exactly as a provider would answer.
  nextResponse = null;
const requests = [];
const countRequests = [];
const modelRequests = [];
const nextModelResponses = new Map();
const heldModelResponses = new Map();
const longText = "abc" + "🙂".repeat(6000) + " tail ";
// The redistributable synthetic ChatGPT export used by the importer tests.
const chatgptFixture = resolve(
  import.meta.dirname,
  "../../../importers/tests/fixtures/chatgpt-observed.synthetic.json",
);
const save = async () => {
  await mkdir("test-results", { recursive: true });
  await writeFile(
    "test-results/app-browser.json",
    JSON.stringify(report, null, 2) + "\n",
  );
};
function fixture(req, res, next) {
  const pathname = new URL(req.url, "http://127.0.0.1").pathname;
  if (!["/v1/models", "/v1/messages", "/v1/chat/completions", "/v1/messages/count_tokens"].includes(pathname))
    return next();
  const anthropic =
    pathname === "/v1/messages" || !!req.headers["anthropic-version"];
  if (
    (anthropic ? req.headers["x-api-key"] : req.headers.authorization) !==
    (anthropic ? "synthetic-secret" : "Bearer synthetic-secret")
  ) {
    res.writeHead(401);
    res.end();
    return;
  }
  if (pathname === "/v1/models") {
    const provider = anthropic ? 'anthropic' : 'openai';
    const response = nextModelResponses.get(provider);
    nextModelResponses.delete(provider);
    modelRequests.push({ provider, method: req.method, path: pathname, bodyLength: Number(req.headers['content-length'] ?? 0) });
    const finish = () => { if (res.destroyed) return; res.writeHead(response?.status ?? 200, { 'content-type': 'application/json', ...(response?.headers ?? {}) }); res.end(JSON.stringify(response?.body ?? { data: [] })); };
    if (response?.hold) {
      heldModelResponses.set(provider, finish);
      res.on('close', () => { if (heldModelResponses.get(provider) === finish) heldModelResponses.delete(provider); });
    } else finish();
    return;
  }
  const chunks = [];
  let bytes = 0;
  req.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) req.destroy();
    else chunks.push(chunk);
  });
  req.on("end", () => {
    let canFinish = !holdNext;
    holdNext = false;
    releaseHeld = () => {
      canFinish = true;
    };
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (pathname === "/v1/messages/count_tokens") {
      // Anthropic's count endpoint answers with input_tokens only; the
      // fixture derives a deterministic count from the counted messages.
      countRequests.push({ body });
      res.writeHead("stream" in body || "max_tokens" in body ? 400 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: JSON.stringify(body.messages).length }));
      return;
    }
    requests.push({ anthropic, body });
    // The reviewed manual-thinking contract, enforced like a provider would:
    // a thinking budget of at least 1,024 below max_tokens without
    // temperature and with top-p in 0.95–1, and assistant thinking blocks
    // first, signed and unmodified.
    if (anthropic) {
      const thinking = body.thinking;
      const badParameter = thinking !== undefined && (thinking?.type !== "enabled" || !Number.isSafeInteger(thinking.budget_tokens) || thinking.budget_tokens < 1024 || thinking.budget_tokens >= body.max_tokens || "temperature" in body || ("top_p" in body && !(body.top_p >= 0.95 && body.top_p <= 1)));
      const badBlocks = body.messages.some((message) => {
        if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
        let reasoning = true;
        for (const block of message.content) {
          const isReasoning = block?.type === "thinking" || block?.type === "redacted_thinking";
          if (isReasoning && !reasoning) return true;
          if (!isReasoning) reasoning = false;
          if (block?.type === "thinking" && (typeof block.thinking !== "string" || !block.signature || Object.keys(block).length !== 3)) return true;
          if (block?.type === "redacted_thinking" && (!block.data || Object.keys(block).length !== 2)) return true;
        }
        return false;
      });
      if (badParameter || badBlocks) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: badParameter ? "Synthetic fixture: invalid thinking parameter" : "Synthetic fixture: thinking blocks cannot be modified or reordered" } }));
        return;
      }
    }
    if (nextResponse) {
      const failure = nextResponse;
      nextResponse = null;
      res.writeHead(failure.status, {
        "content-type": "application/json",
        ...(failure.headers ?? {}),
      });
      res.end(JSON.stringify(failure.body));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const slow = JSON.stringify(body.messages.at(-1)).includes("slow response");
    // A prompt asking the fixture to identify itself gets one extra delta
    // naming the protocol, so a search can find text that only this
    // connection streamed.
    const identify = JSON.stringify(body.messages.at(-1)).includes("identify yourself");
    // A prompt asking the Anthropic fixture for a mid-stream failure gets three
    // deltas, then the provider's own in-stream error event and a closed
    // stream; the OpenAI fixture answers the same prompt normally, so a
    // fallback to it can complete.
    const midStream = anthropic && JSON.stringify(body.messages.at(-1)).includes("fail mid-stream");
    // A prompt asking the Anthropic fixture to think first gets a signed
    // thinking block and a redacted block, closed before the text block opens,
    // as the documented thinking stream orders them.
    const thinkFirst = anthropic && JSON.stringify(body.messages.at(-1)).includes("think first");
    // A prompt asking for a citation gets one: Anthropic streams a citations
    // delta on the text block plus an unknown output block, OpenAI streams a
    // URL annotation plus a provider-specific delta field.
    const cite = JSON.stringify(body.messages.at(-1)).includes("cite this");
    const textIndex = thinkFirst ? 2 : 0;
    const sse = (data, event) =>
      `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
    if (anthropic) {
      res.write(
        sse(
          {
            type: "message_start",
            message: {
              id: randomUUID(),
              type: "message",
              role: "assistant",
              model: body.model,
              content: [],
              stop_reason: null,
              usage: {
                input_tokens: 12,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                output_tokens: 0,
              },
            },
          },
          "message_start",
        ),
      );
      if (thinkFirst) {
        res.write(sse({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }, "content_block_start"));
        res.write(sse({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "fixture reasoning about " } }, "content_block_delta"));
        res.write(sse({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "the comet 🧪\n" } }, "content_block_delta"));
        res.write(sse({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "fixture-signature-comet+/=" } }, "content_block_delta"));
        res.write(sse({ type: "content_block_stop", index: 0 }, "content_block_stop"));
        res.write(sse({ type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "fixture-redacted-comet+/=" } }, "content_block_start"));
        res.write(sse({ type: "content_block_stop", index: 1 }, "content_block_stop"));
      }
      res.write(
        sse(
          {
            type: "content_block_start",
            index: textIndex,
            content_block: { type: "text", text: "" },
          },
          "content_block_start",
        ),
      );
    }
    let index = 0;
    const timer = setInterval(() => {
      if (res.destroyed) {
        clearInterval(timer);
        return;
      }
      if (midStream && index === 3) {
        clearInterval(timer);
        res.end(
          anthropic
            ? sse({ type: "error", error: { type: "overloaded_error", message: "Synthetic mid-stream overload" } }, "error")
            : sse({ error: { message: "Synthetic mid-stream overload", type: "server_error" } }),
        );
        return;
      }
      if (index < 8 + (identify ? 1 : 0)) {
        const text =
          index === 0
            ? JSON.stringify(body.messages.at(-1)).includes("long response")
              ? longText
              : "Visible stream 🧪 "
            : index === 8
              ? `served by ${anthropic ? "messages api" : "chat completions"} `
              : `segment ${index} `;
        res.write(
          anthropic
            ? sse(
                {
                  type: "content_block_delta",
                  index: textIndex,
                  delta: { type: "text_delta", text },
                },
                "content_block_delta",
              )
            : sse({
                id: "fixture-response",
                model: body.model,
                choices: [
                  { index: 0, delta: { content: text }, finish_reason: null },
                ],
              }),
        );
        index++;
        return;
      }
      if (!canFinish) return;
      clearInterval(timer);
      if (slow) return;
      if (anthropic) {
        if (cite) {
          res.write(sse({ type: "content_block_delta", index: textIndex, delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: "https://example.invalid/comet-source", title: "Synthetic comet source", cited_text: "segment 1" } } }, "content_block_delta"));
        }
        res.write(
          sse({ type: "content_block_stop", index: textIndex }, "content_block_stop"),
        );
        if (cite) {
          res.write(sse({ type: "content_block_start", index: textIndex + 1, content_block: { type: "future_file_output", file_id: "file-synthetic" } }, "content_block_start"));
          res.write(sse({ type: "content_block_stop", index: textIndex + 1 }, "content_block_stop"));
        }
        res.write(
          sse(
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 20 },
            },
            "message_delta",
          ),
        );
        res.end(sse({ type: "message_stop" }, "message_stop"));
      } else {
        if (cite)
          res.write(sse({ id: "fixture-response", model: body.model, choices: [{ index: 0, delta: { reasoning_content: "synthetic private reasoning", annotations: [{ type: "url_citation", url_citation: { url: "https://example.invalid/comet-source", title: "Synthetic comet source", start_index: 0, end_index: 9 } }] }, finish_reason: null }] }));
        res.write(
          sse({
            id: "fixture-response",
            model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }),
        );
        res.write(
          sse({
            choices: [],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 20,
              total_tokens: 32,
              prompt_tokens_details: { cached_tokens: 0 },
            },
          }),
        );
        res.end("data: [DONE]\n\n");
      }
    }, 80);
    res.on("close", () => clearInterval(timer));
  });
}
const records = (page, collection) =>
  page.evaluate(
    (collection) => window.appAcceptance.records(collection),
    collection,
  );
const connect = async (page, label) => {
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  const card = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: label, exact: true }) });
  await card.getByLabel("API key", { exact: true }).fill("synthetic-secret");
  await keyboardActivate(card.getByRole("button", { name: "Connect credential", exact: true }));
  await expect(
    card.getByText("Credential connected · Connection not checked", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(card.getByRole("button", { name: "Replace credential", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Library", exact: true }).click();
};
// Minimal PNG encoder for synthetic composer attachments (RGBA, no filter).
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const pngChunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
};
const pngImage = (width, height, rgba) => {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      rgba(x, y).forEach((value, index) => {
        raw[y * stride + 1 + x * 4 + index] = value;
      });
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
};
const send = async (page, text) => {
  await page.getByLabel("Message", { exact: true }).fill(text);
  // A consequential provider switch needs an explicit review before sending.
  if (await page.locator(".switch-report").count()) {
    const review = page.getByRole("checkbox", { name: /I reviewed this switch/ });
    await review.check();
  }
  await page.getByRole("button", { name: "Send message", exact: true }).click();
};
try {
  for (const file of ["tooling/browser-engines.mjs",
    "packages/app/tests/browser/pending-recovery.mjs",
    "packages/app/tests/browser/reasoning-continuation.mjs",
    "packages/app/tests/browser/output-parts.mjs",
    "packages/app/src/runtime/output-parts.ts",
    "packages/app/src/runtime/reasoning.ts",
    "packages/providers/src/reasoning.ts",
    "packages/app/tests/browser/health-refresh.mjs",
    "packages/storage/src/worker/blobs.ts",
    "packages/storage/src/worker/blob-catalog.ts",
    "packages/storage/src/worker/search/index.ts",
    "packages/storage/tests/browser/search-verification.ts",
    "packages/storage/tests/browser/archive-search-verification.ts",
    "packages/storage/tests/incremental-blob-reads.test.ts",
    "packages/search/tests/repository.test.ts",
    "packages/app/src/features/providers/health-refresh.ts",
    "packages/app/src/features/providers/types.ts",
    "packages/app/tests/providers/health-refresh.test.ts",
    "packages/app/src/features/providers/tests/health-refresh.test.mjs",
    "packages/providers/tests/health-races.test.ts",
    "packages/app/tests/library-refresh.test.ts",
    "packages/app/src/features/accessibility/CompatibilityAnnouncement.tsx",
    "packages/app/tests/browser/compatibility-announcements.mjs",
    "packages/app/tests/browser/alias-application-accessibility.mjs",
    "packages/app/src/AppRoot.tsx",
    "packages/core/src/model/compaction.ts",
    "packages/core/src/model/summaries.ts",
    "packages/storage/src/worker/canonical/summary-source.ts",
    "packages/storage/migrations/summary-proposals.ts",
    "packages/app/src/features/compaction/summaries.ts",
    "packages/app/src/features/compaction/summary-source.ts",
    "packages/app/src/features/compaction/SummaryCompaction.tsx",
    "packages/app/src/features/compaction/FreshBranch.tsx",
    "packages/core/src/model/validation.ts",
    "packages/core/src/model/types.ts",
    "packages/app/src/features/compaction/controller.ts",
    "packages/app/src/features/compaction/AttachmentCompaction.tsx",
    "packages/storage/migrations/context-compaction.ts",
    "packages/storage/src/worker/archives/validation.ts",
    "packages/storage/src/worker/canonical/repository.ts",
    "packages/storage/src/archive-protocol.ts",

    "packages/app/src/features/preferences/controller.ts",
    "packages/app/src/features/preferences/PreferencesPanel.tsx",
    "packages/app/src/features/preferences/ModelSwitcher.tsx",
    "packages/app/src/features/preferences/MessageTimestamp.tsx",
    "packages/app/tests/browser/interaction-preferences.mjs",
    "packages/app/tests/browser/keyboard-focus.mjs",
    "packages/app/tests/browser/review-accessibility.mjs",
    "packages/app/tests/browser/alias-removal-focus.mjs",
    "packages/app/src/features/accessibility/useFocusRecovery.ts",
    "packages/app/src/features/imports/ImportPanel.tsx",
    "packages/app/src/features/archives/ExportPanel.tsx",
    "packages/app/src/features/archives/RestorePanel.tsx",
    "packages/app/src/features/archives/controller.ts",
    "packages/app/src/features/archives/tests/export-controller.test.mjs",
    "package.json",
    "packages/app/src/features/preferences/send-key.ts",
    "packages/app/src/features/preferences/aliases-controller.ts",
    "packages/app/src/features/preferences/RoutingAliases.tsx",
    "packages/core/src/contracts/routing-aliases.ts",
    "packages/core/src/contracts/index.ts",
    "packages/storage/src/worker/routing-aliases.ts",
    "packages/core/src/contracts/preferences.ts",
    "packages/core/src/contracts/storage.ts",
    "packages/storage/src/worker/preferences.ts",
    "packages/app/src/index.ts",
    "packages/app/src/styles.css",
    "packages/app/src/runtime/library.ts",
    "packages/app/src/workflows/chat.ts",
    "packages/app/src/features/attachments/staging.ts",
    "packages/app/src/features/attachments/composer-attachments.ts",
    "packages/app/src/features/attachments/ComposerAttachments.tsx",
    "packages/app/src/features/attachments/attachments.css",
    "packages/core/src/contracts/host.ts",
    "apps/web/src/host/index.ts",
    "apps/web/src/host/regional-relay.ts",
    "apps/web/src/host/provider-connections.ts",
    "packages/storage/src/worker/views.ts",
    "packages/core/src/contracts/views.ts",
    "packages/app/src/features/content/Markdown.tsx",
    "packages/app/src/features/content/ContentPartView.tsx",
    "packages/app/src/features/content/access.ts",
    "packages/app/src/features/providers/controller.ts",
    "packages/app/src/features/providers/health.ts",
    "packages/app/src/runtime/usage.ts",
    "packages/app/src/runtime/events.ts",
    "packages/app/src/runtime/switching.ts",
    "packages/app/src/runtime/portability.ts",
    "packages/app/src/runtime/fallback.ts",
    "packages/app/src/runtime/routing.ts",
    "packages/app/src/runtime/request-cost.ts",
    "packages/app/src/runtime/processing-region.ts",
    "packages/app/src/runtime/library.ts",
    "packages/app/src/features/providers/types.ts",
    "packages/app/src/features/providers/ProviderSettingsPanel.tsx",
    "packages/providers/src/regional.ts",
    "packages/storage/src/worker/archive-database.ts",
    "packages/storage/migrations/views.ts",
    "packages/storage/migrations/streaming-text.ts",
    "packages/providers/src/generation.ts",
    "packages/providers/src/normalize.ts",
    "packages/providers/tests/reasoning.test.ts",
    "packages/providers/tests/generation.test.ts",
    "packages/providers/tests/fixtures.ts",
    "packages/providers/src/request.ts",
    "packages/providers/src/adapter.ts",
    "packages/providers/src/catalog.ts",
    "packages/providers/src/types.ts",
    "packages/core/src/model/provenance.ts",
    "apps/web/src/configuration.ts",
    "packages/app/tests/browser/index.ts",
    "packages/app/tests/browser/regions.mjs",
    "packages/app/tests/browser/composer-files.mjs",
    "packages/app/tests/browser/composer-files-storage.ts",
    "packages/app/tests/browser/composer-files-restore.ts",
    "packages/app/tests/browser/audio-input.mjs",
    "packages/app/tests/switching/audio-context.test.ts",
    "packages/providers/tests/audio.test.ts",
    "packages/providers/tests/audio-fixtures.ts",
    "packages/providers/tests/host-proof.ts",
    "packages/providers/tests/fixture-server.ts",
    "packages/providers/src/request.ts",
    "packages/providers/src/types.ts",
    "packages/providers/src/catalog.ts",
    "packages/app/src/features/providers/ProviderSettingsPanel.tsx",
    "packages/app/src/features/providers/controller.ts",
    "packages/app/tests/attachments/controller.test.ts",
    "packages/app/src/features/providers/tests/controller.test.mjs",
    "packages/app/tests/browser/composer-files-restore.html",
    "packages/app/tests/browser/run.mjs",
    "packages/app/tests/browser/semantic.mjs",
    "packages/app/tests/browser/onboarding.mjs",
    "packages/app/src/features/onboarding/controller.ts",
    "packages/app/src/features/onboarding/OnboardingPanel.tsx",
    "packages/app/src/features/semantic/controller.ts",
    "packages/app/src/features/semantic/SemanticPanel.tsx",
    "packages/app/src/features/semantic/assets.ts",
    "packages/search/src/semantic/indexer.ts",
    "packages/storage/src/worker/search/semantic.ts",
    "packages/quixi-embed/src/service/worker.ts",
    "packages/quixi-embed/artifacts/model/lock.json",
    "package-lock.json",
  ])
    report.sourceSha256[file] = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  const outDir = resolve(temporary, "dist");
  await build({
    configFile: false,
    root: import.meta.dirname,
    build: { outDir, emptyOutDir: true, rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), composerRestore: resolve(import.meta.dirname, 'composer-files-restore.html') } } },
    logLevel: "warn",
  });
  server = await preview({
    configFile: false,
    root: import.meta.dirname,
    build: { outDir },
    preview: { host: "127.0.0.1", port: 4197, strictPort: true },
    plugins: [
      embeddingModelAssets(),
      {
        name: "synthetic-provider",
        configurePreviewServer(server) {
          server.middlewares.use(fixture);
        },
      },
    ],
    logLevel: "warn",
  });
  for (const [name, engine] of selectedEngines) {
    const evidence = { name, status: "running", checks: [] };
    report.hosts.push(evidence);
    await save();
    const profile = resolve(temporary, name),
      url = `http://127.0.0.1:4197/?archive=test-app-${randomUUID()}`;
    let context = await engine.launchPersistentContext(profile, {
      headless: true,
      viewport: { width: 1280, height: 900 },
    });
    try {
      const page = await context.newPage();
      page.on("pageerror", (error) => console.error(name, error));
      await page.goto(url);
      await expect(
        page.getByRole("heading", { name: "Pick up where you left off." }),
      ).toBeVisible();
      await exercisePreferenceFocus({ page, name });
      evidence.aliasReflow = await exerciseAliasReflow({ page, name, mode: process.env.QUIXI_TEST_REVIEW_REFLOW_BASELINE === '1' ? 'capture' : 'assert' });
      if (process.env.QUIXI_TEST_REVIEW_REFLOW_BASELINE === '1') throw new Error('Baseline layout capture complete; the remaining scenario was intentionally not run.');
      evidence.checks.push('routing alias editor fits 320px at normal and enlarged text, authored input boundaries meet measured contrast, and cancelling leaves the alias registry unchanged');
      evidence.aliasRemovalFocus = await exerciseAliasRemovalFocus({ page, name });
      evidence.checks.push('alias middle/first/last fallback removal, cancel, keep and confirmed deletion preserve a named focus destination, saved profiles and provider silence');
      evidence.checks.push("keyboard navigation to Preferences, focused native-option changes and Space-activated checkbox saves preserve focus; a held durable reply cannot steal focus after Tab leaves the panel, defaults are restored, and focus remains visible in a 390px layout with enlarged text");
      // A 1x1 PNG staged through the production blob path; plan 06 image
      // mapping is checked against the provider request body later.
      const seededPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
      const seededImage = await page.evaluate((png) => window.appAcceptance.seedImageThread(png), seededPng);
      // Seeded before the library first lists conversations, like the image thread.
      const portabilityThread = await page.evaluate(() => window.appAcceptance.seedPortabilityThread());
      const seededMessages = (await records(page, "messages")).items.length;
      await page
        .getByRole("button", { name: "New conversation", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "New conversation", exact: true }),
      ).toBeVisible();
      await page.getByText("Conversation settings", { exact: true }).click();
      await page.getByLabel("Title", { exact: true }).fill("Comet notebook");
      await page.getByRole("button", { name: "Rename", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Comet notebook", exact: true }),
      ).toBeVisible();
      await page.getByLabel("Tags, separated by commas").fill("space, ideas");
      await page.getByRole("button", { name: "Save tags" }).click();
      await expect
        .poll(async () =>
          JSON.stringify((await records(page, "threadStates")).items),
        )
        .toContain("space");
      await page
        .getByLabel("System prompt", { exact: true })
        .fill("Keep the synthetic comet facts concise.");
      await page
        .getByRole("button", { name: "Save system prompt", exact: true })
        .click();
      await expect
        .poll(async () =>
          JSON.stringify((await records(page, "contexts")).items),
        )
        .toContain("Keep the synthetic comet facts concise.");
      await expect(page.getByRole("alert")).toHaveCount(0);
      await connect(page, "OpenAI");
      const outputLimit = page.getByLabel("Maximum output tokens", {
        exact: true,
      });
      await expect(outputLimit).toHaveAttribute("max", "32768");
      await page
        .getByLabel("Message", { exact: true })
        .fill("Draft survives invalid settings");
      const requestCount = requests.length;
      for (const invalid of ["", "0", "1.5", "32769"]) {
        await outputLimit.fill(invalid);
        await expect(
          page.getByRole("button", { name: "Send message", exact: true }),
        ).toBeDisabled();
        await page
          .getByLabel("Message", { exact: true })
          .press("Control+Enter");
        expect((await records(page, "messages")).items).toHaveLength(seededMessages);
        expect(requests.length).toBe(requestCount);
      }
      await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
        "Draft survives invalid settings",
      );
      await outputLimit.fill("768");
      const temperature = page.getByLabel("Temperature", { exact: true }),
        topP = page.getByLabel("Top-p", { exact: true }),
        stopSequences = page.getByLabel("Stop sequences", { exact: true });
      await expect(temperature).toHaveAttribute("max", "2");
      for (const [field, invalid] of [
        [temperature, "2.5"],
        [temperature, "-0.5"],
        [topP, "1.01"],
        [stopSequences, "one\ntwo\nthree\nfour\nfive"],
        [stopSequences, "x".repeat(1025)],
      ]) {
        await field.fill(invalid);
        await expect(field).toHaveAttribute("aria-invalid", "true");
        await expect(
          page.getByRole("button", { name: "Send message", exact: true }),
        ).toBeDisabled();
        await page
          .getByLabel("Message", { exact: true })
          .press("Control+Enter");
        expect((await records(page, "messages")).items).toHaveLength(seededMessages);
        expect(requests.length).toBe(requestCount);
        await field.fill("");
      }
      await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
        "Draft survives invalid settings",
      );
      await temperature.fill("0.3");
      await topP.fill("0.9");
      await stopSequences.fill("END\n\nSTOP");
      holdNext = true;
      const composer = page.getByLabel("Message", { exact: true });
      await composer.fill("First comet question");
      await composer.press("Enter");
      await expect(composer).toHaveValue("First comet question\n");
      expect(requests.length).toBe(requestCount);
      await composer.fill("First comet question");
      await composer.press("Control+Enter");
      await expect(
        page.getByRole("button", { name: "Stop response", exact: true }),
      ).toBeVisible();
      await expect(page.locator(".message.assistant").first()).toContainText(
        "Visible stream",
      );
      await expect(
        page.getByRole("button", { name: "Stop response", exact: true }),
      ).toBeVisible();
      releaseHeld();
      await expect(
        page.getByRole("button", { name: "Send message", exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
      const messageArticles = page.getByRole("region", { name: "Conversation messages", exact: true }).locator("article.message");
      await expect(messageArticles).toHaveCount(2);
      const actionLabels = [];
      for (let index = 0; index < await messageArticles.count(); index++) {
        const article = messageArticles.nth(index);
        const contextName = `${index === 0 ? "You" : "Assistant"}, message ${index + 1} on this page`;
        await expect(article).toHaveAccessibleName(contextName);
        const buttons = article.locator(".message-actions button");
        for (let at = 0; at < await buttons.count(); at++) {
          const button = buttons.nth(at), visible = (await button.innerText()).trim();
          await expect(button).toHaveAccessibleName(`${visible} — ${contextName}`);
          actionLabels.push(await button.getAttribute("aria-label"));
        }
      }
      expect(new Set(actionLabels).size).toBe(actionLabels.length);
      evidence.actionLabels = actionLabels;
      evidence.checks.push("message articles and repeated actions have unique role/page-position context while retaining each visible action label; existing edit, quote, regenerate and branch scenarios use these accessible names");
      expect(requests.at(-1).body.max_completion_tokens).toBe(768);
      expect(
        (await records(page, "generations")).items[0].parameters
          .max_completion_tokens,
      ).toBe(768);
      expect(requests.at(-1).body.temperature).toBe(0.3);
      expect(requests.at(-1).body.top_p).toBe(0.9);
      expect(requests.at(-1).body.stop).toEqual(["END", "STOP"]);
      expect((await records(page, "generations")).items[0].parameters).toMatchObject({
        temperature: 0.3,
        top_p: 0.9,
        stop: ["END", "STOP"],
      });
      evidence.checks.push(
        "create, rename, tags and system prompt commit through the production worker",
        "actual provider HTTP stream is visible before terminal; generation completes durably",
      );
      await temperature.fill("");
      await topP.fill("");
      await stopSequences.fill("");
      // Persist a real interaction preference through the elected worker,
      // observe it from another client and reject that client's stale edit.
      await composer.fill("Draft stays while preferences change");
      const oldPreferences = await page.evaluate(() => window.appAcceptance.preferences());
      await page.getByRole("button", { name: "Preferences", exact: true }).click();
      await expect(page.getByLabel("Send key", { exact: true })).toHaveValue("mod-enter");
      await page.evaluate(() => window.appAcceptance.losePreferenceReply());
      await page.getByLabel("Send key", { exact: true }).selectOption("enter");
      await expect(page.getByRole("alert")).toContainText("Synthetic lost preference reply after durable write");
      await expect(page.getByLabel("Send key", { exact: true })).toBeDisabled();
      await page.getByRole("button", { name: "Reload preferences", exact: true }).click();
      await expect(page.getByLabel("Send key", { exact: true })).toHaveValue("enter");
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.getByText("Preferences are saved on this device.", { exact: true })).toBeVisible();
      const peer = await context.newPage();
      await peer.goto(url);
      await expect(peer.getByRole("heading", { name: "Pick up where you left off." })).toBeVisible();
      const sharedPreferences = await peer.evaluate(() => window.appAcceptance.preferences());
      expect(sharedPreferences).toEqual({ version: 3, revision: oldPreferences.revision + 1, sendKey: "enter", ...defaultInteractions, onboardingCompletedAt: sharedPreferences.onboardingCompletedAt });
      expect(typeof sharedPreferences.onboardingCompletedAt === "number" || sharedPreferences.onboardingCompletedAt === null).toBe(true);
      const stalePreferenceError = await peer.evaluate(async revision => {
        try { await window.appAcceptance.setSendKey(revision, "mod-enter"); return null; }
        catch (error) { return String(error); }
      }, oldPreferences.revision);
      expect(stalePreferenceError).toContain("changed in another view");
      expect(await peer.evaluate(() => window.appAcceptance.preferences())).toEqual(sharedPreferences);
      await peer.evaluate(() => window.appAcceptance.close());
      await peer.close();
      await page.getByRole("button", { name: "Library", exact: true }).click();
      await expect(composer).toHaveValue("Draft stays while preferences change");
      await expect(page.getByText("Enter to send · Shift + Enter for a new line", { exact: true })).toBeVisible();
      await composer.fill("Second comet question");
      const beforePreferenceSend = requests.length;
      await composer.press("Shift+Enter");
      await expect(composer).toHaveValue("Second comet question\n");
      await composer.evaluate(field => {
        field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
        field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
        field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true }));
      });
      expect(requests.length).toBe(beforePreferenceSend);
      await expect(composer).toHaveValue("Second comet question\n");
      await composer.fill("Second comet question");
      await composer.press("Enter");
      await expect.poll(() => requests.length).toBe(beforePreferenceSend + 1);
      evidence.checks.push("send-key preferences save through the production worker without changing the draft, a lost save reply is shown and recovered by reloading the durable value, another client reads the saved value and its stale edit is refused; Mod+Enter and Enter each submit through the provider path, newline input survives, and composition/repeated Enter events never submit; the preference survives a fresh browser process");
      await expect
        .poll(async () => (await records(page, "generations")).items.length)
        .toBe(2);
      await expect(
        page.getByRole("button", { name: "Send message", exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
      expect(
        requests
          .at(-1)
          .body.messages.filter((value) => value.role === "assistant"),
      ).toHaveLength(1);
      expect(JSON.stringify(requests.at(-1).body)).toContain(
        "Keep the synthetic comet facts concise.",
      );
      for (const key of ["temperature", "top_p", "stop", "stop_sequences"])
        expect(key in requests.at(-1).body).toBe(false);
      evidence.checks.push(
        "second turn sends the exact selected ancestor path and prompt while retaining internal provenance locally",
      );
      evidence.interactionPreferences = await exerciseInteractionPreferences({ page, records, requests, countRequests, url, name });
      evidence.checks.push("four interaction preferences save through the production worker while preserving the draft, canonical history and provider/count HTTP; timestamps, model badges, compact composer and native model radios render their selected modes, current radio supports keyboard activation, lost durable replies recover by reload and a second client's revision prevents a stale UI edit before defaults are restored");
      await outputLimit.fill("1536");
      await temperature.fill("1.2");
      await page
        .getByRole("button", { name: /^Generate another response — / })
        .first()
        .click();
      await expect
        .poll(async () => (await records(page, "generations")).items.length)
        .toBe(3);
      await expect(
        page.getByRole("button", { name: "Send message", exact: true }),
      ).toBeVisible();
      const generations = (await records(page, "generations")).items.sort(
        (a, b) => a.createdAt - b.createdAt,
      );
      expect(new Set(generations.map((value) => value.id)).size).toBe(3);
      expect(generations[0].parameters.max_completion_tokens).toBe(768);
      expect(generations[2].parameters.max_completion_tokens).toBe(1536);
      expect(requests.at(-1).body.max_completion_tokens).toBe(1536);
      expect(generations[2].parameters.temperature).toBe(1.2);
      expect(requests.at(-1).body.temperature).toBe(1.2);
      expect("temperature" in generations[1].parameters).toBe(false);
      const messages = (await records(page, "messages")).items;
      expect(messages).toHaveLength(seededMessages + 5);
      expect(
        generations.filter(
          (value) => value.parentMessageId === generations[0].parentMessageId,
        ),
      ).toHaveLength(2);
      evidence.checks.push(
        "regenerate creates a distinct attempt and preserves both response branches",
      );
      await page
        .getByRole("button", { name: /^Edit as new branch — / })
        .first()
        .click();
      await page
        .getByLabel("Edit message", { exact: true })
        .fill("Edited comet question");
      await page
        .getByRole("button", { name: "Save edited branch", exact: true })
        .click();
      await expect
        .poll(
          async () =>
            (await records(page, "messages")).items.filter(
              (value) => value.editedFromMessageId !== null,
            ).length,
        )
        .toBe(1);
      await expect(page.locator(".message.user")).toContainText(
        "Edited comet question",
      );
      expect((await records(page, "messages")).items).toHaveLength(seededMessages + 6);
      evidence.checks.push(
        "editing creates a new immutable sibling and keeps the original message and generated descendants",
      );
      await connect(page, "Anthropic");
      await page
        .getByLabel("Provider", { exact: true })
        .selectOption("anthropic");
      await expect(outputLimit).toHaveAttribute("max", "64000");
      await outputLimit.fill("2048");
      await expect(temperature).toHaveAttribute("max", "1");
      await expect(temperature).toHaveAttribute("aria-invalid", "true");
      await page
        .getByLabel("Message", { exact: true })
        .fill("Anthropic comet question");
      await expect(
        page.getByRole("button", { name: "Send message", exact: true }),
      ).toBeDisabled();
      const anthropicRequests = requests.length;
      await page.getByLabel("Message", { exact: true }).press("Control+Enter");
      expect(requests.length).toBe(anthropicRequests);
      await temperature.fill("0.5");
      await stopSequences.fill("Human:");
      await send(page, "Anthropic comet question");
      await expect
        .poll(async () => (await records(page, "generations")).items.length)
        .toBe(4);
      await expect(
        page.getByRole("button", { name: "Send message", exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
      expect(requests.at(-1).anthropic).toBe(true);
      expect(requests.at(-1).body.max_tokens).toBe(2048);
      expect(
        (await records(page, "generations")).items.find(
          (value) => value.provider === "anthropic",
        ).parameters.max_tokens,
      ).toBe(2048);
      expect(requests.at(-1).body.system).toBe(
        "Keep the synthetic comet facts concise.",
      );
      expect(requests.at(-1).body.temperature).toBe(0.5);
      expect(requests.at(-1).body.stop_sequences).toEqual(["Human:"]);
      expect("stop" in requests.at(-1).body).toBe(false);
      expect("top_p" in requests.at(-1).body).toBe(false);
      expect(
        (await records(page, "generations")).items.find(
          (value) => value.provider === "anthropic",
        ).parameters,
      ).toMatchObject({ temperature: 0.5, stop_sequences: ["Human:"] });
      evidence.checks.push(
        "the selected branch continues through the second real provider adapter",
        "model output limits gate invalid keyboard/button sends and persist exact settings independently for both providers and regenerated attempts",
        "catalog-declared temperature, top-p and stop sequences gate invalid sends without losing the draft, map to each protocol's fields, omit blank settings and are recorded per attempt",
      );
      await temperature.fill("");
      await stopSequences.fill("");
      await page
        .locator(".composer")
        .screenshot({ path: `test-results/app-${name}-composer.png` });
      await send(page, "slow response comet");
      await expect(
        page.getByRole("button", { name: "Stop response", exact: true }),
      ).toBeVisible();
      await expect
        .poll(async () => (await records(page, "generations")).items.length)
        .toBe(5);
      const currentGeneration = (await records(page, "generations")).items.sort(
        (a, b) => b.createdAt - a.createdAt,
      )[0];
      await expect(
        page.locator(
          `[data-message-id="${currentGeneration.outputMessageId}"]`,
        ),
      ).toContainText("Visible stream");
      await page
        .getByRole("button", { name: "Stop response", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Send message", exact: true }),
      ).toBeVisible();
      await expect
        .poll(
          async () =>
            (await records(page, "generations")).items.filter(
              (value) =>
                value.status === "stopped" ||
                value.status === "cancelled" ||
                value.status === "partial",
            ).length,
        )
        .toBe(1);
      evidence.checks.push(
        "stop terminates controlled HTTP and retains the committed response prefix",
      );
      // Streaming announcements are controlled: the polite status region
      // changes at the start and the end of a reply, never per chunk.
      await page.evaluate(() => {
        const node = document.querySelector(".generation-status");
        window.__quixiStatusTexts = [node.textContent];
        new MutationObserver(() => { const text = node.textContent; if (text !== window.__quixiStatusTexts.at(-1)) window.__quixiStatusTexts.push(text); }).observe(node, { childList: true, characterData: true, subtree: true });
      });
      await send(page, "long response");
      await expect
        .poll(async () => (await records(page, "generations")).items.length)
        .toBe(6);
      await expect(
        page.getByRole("button", { name: "Send message", exact: true }),
      ).toBeVisible({ timeout: 30000 });
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.locator(".generation-status")).toHaveText("Response complete.");
      const statusTexts = await page.evaluate(() => window.__quixiStatusTexts);
      expect(statusTexts.slice(1)).toEqual(["Response in progress. Committed text is saved as it arrives.", "Response complete."]);
      evidence.checks.push("a streamed two-part reply changes the polite generation status exactly twice (in progress, complete): committed chunks never re-announce");
      const longGeneration = (await records(page, "generations")).items.sort(
        (a, b) => b.createdAt - a.createdAt,
      )[0];
      const longParts = (
        await page.evaluate(
          (id) => window.appAcceptance.parts(id),
          longGeneration.outputMessageId,
        )
      ).items.filter((part) => part.kind === "Text");
      expect(longParts.length).toBe(2);
      expect(longParts.every((part) => part.data.text.length <= 8192)).toBe(
        true,
      );
      expect(longParts.map((part) => part.data.text).join("")).toBe(
        longText +
          Array.from({ length: 7 }, (_, i) => `segment ${i + 1} `).join(""),
      );
      expect(
        longParts.every((part) =>
          [...part.data.text].every(
            (char) =>
              char.codePointAt(0) < 0xd800 || char.codePointAt(0) > 0xdfff,
          ),
        ),
      ).toBe(true);
      evidence.checks.push(
        "long streamed text uses bounded mutable segments without splitting Unicode scalars or losing text",
      );
      const message = page.getByLabel("Message", { exact: true });
      await page.evaluate(() => {
        const walker = document.createTreeWalker(
          document.querySelector(".message.assistant"),
          NodeFilter.SHOW_TEXT,
        );
        let node;
        while ((node = walker.nextNode()))
          if (node.textContent.startsWith("Visible stream")) break;
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      });
      await page
        .locator(".message.assistant")
        .first()
        .getByRole("button", { name: /^Quote in reply — / })
        .click();
      await expect(message).toHaveValue(
        /^> Visible stream 🧪 segment 1 segment 2 .*segment 7\n\n$/s,
      );
      await page.evaluate(() => window.getSelection().removeAllRanges());
      const firstUser = page.locator(".message.user").first();
      await firstUser
        .getByRole("button", { name: /^Quote in reply — / })
        .click();
      await expect(message).toHaveValue(
        /^> Visible stream 🧪 segment 1 .*segment 7\n\n> Edited comet question\n\n$/s,
      );
      await message.fill("x".repeat(16380));
      await firstUser
        .getByRole("button", { name: /^Quote in reply — / })
        .click();
      await expect(page.getByRole("alert")).toContainText("16,384");
      await expect(message).toHaveValue("x".repeat(16380));
      await message.fill("");
      await expect(page.getByRole("alert")).toHaveCount(0);
      await firstUser
        .getByRole("button", { name: /^Quote in reply — / })
        .click();
      await expect(message).toHaveValue("> Edited comet question\n\n");
      await expect(message).toBeFocused();
      await page.keyboard.type("Why that?");
      await expect(message).toHaveValue("> Edited comet question\n\nWhy that?");
      await page
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      await expect
        .poll(async () => (await records(page, "generations")).items.length)
        .toBe(7);
      await expect(
        page.getByRole("button", { name: "Send message", exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
      expect(JSON.stringify(requests.at(-1).body.messages.at(-1))).toContain(
        JSON.stringify("> Edited comet question\n\nWhy that?").slice(1, -1),
      );
      await expect(message).toHaveValue("");
      evidence.checks.push(
        "quote in reply appends the selected passage or whole inline message as a blockquote with the caret at the end, refuses an over-limit quote without altering the draft, and sends the quoted text",
      );
      // Keyboard-only workflow: no pointer input until the check is recorded.
      // WebKit keeps links and buttons out of plain Tab order (Safari's
      // default); Option+Tab visits every control there, so use it throughout.
      const tab = (shift = false) =>
        page.keyboard.press(
          `${name === "webkit" ? "Alt+" : ""}${shift ? "Shift+" : ""}Tab`,
        );
      await page.getByRole("link", { name: "Quixi home", exact: true }).focus();
      await tab(true);
      await expect(
        page.getByRole("link", { name: "Skip to conversation", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.locator("main#workspace")).toBeFocused();
      await page
        .getByRole("button", { name: "New conversation", exact: true })
        .focus();
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("heading", { name: "New conversation", exact: true }),
      ).toBeVisible();
      await expect(message).toBeFocused();
      await page.keyboard.type("Keyboard comet question");
      holdNext = true;
      await page.keyboard.press("Control+Enter");
      await expect(
        page.getByRole("button", { name: "Stop response", exact: true }),
      ).toBeVisible();
      await expect(message).toBeFocused();
      await expect(page.locator("section.messages")).toHaveAttribute(
        "aria-busy",
        "true",
      );
      await expect(page.locator(".message.assistant").last()).toContainText(
        "Visible stream",
      );
      expect(
        await page
          .locator(
            ".messages [aria-live], .messages [role='status'], .messages [role='alert']",
          )
          .count(),
      ).toBe(0);
      await expect(page.locator(".generation-status")).toHaveText(
        "Response in progress. Committed text is saved as it arrives.",
      );
      await tab();
      await expect(
        page.getByRole("button", { name: "Stop response", exact: true }),
      ).toBeFocused();
      expect(
        await page.evaluate(
          () => getComputedStyle(document.activeElement).outlineStyle,
        ),
      ).toBe("solid");
      await page.keyboard.press("Enter");
      releaseHeld();
      await expect(
        page.getByRole("button", { name: "Send message", exact: true }),
      ).toBeVisible();
      await expect(message).toBeFocused();
      await expect(page.locator("section.messages")).toHaveAttribute(
        "aria-busy",
        "false",
      );
      await expect(page.locator(".generation-status")).toHaveText(
        /^Response (stopped|cancelled|partial)\.$/,
      );
      await page
        .getByRole("button", { name: /^Generate another response — / })
        .first()
        .focus();
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("button", { name: "Stop response", exact: true }),
      ).toBeVisible();
      await expect(message).toBeFocused();
      await expect(
        page.getByRole("button", { name: "Send message", exact: true }),
      ).toBeVisible();
      await expect(page.locator(".generation-status")).toHaveText(
        "Response complete.",
      );
      const editOpener = page
        .getByRole("button", { name: /^Edit as new branch — / })
        .first();
      await editOpener.focus();
      await page.keyboard.press("Enter");
      const editField = page.getByLabel("Edit message", { exact: true });
      await expect(editField).toBeFocused();
      await tab();
      await tab();
      await expect(
        page.getByRole("button", { name: "Cancel edit", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(editOpener).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(editField).toBeFocused();
      await page.keyboard.type(" edited by keyboard");
      await tab();
      await expect(
        page.getByRole("button", { name: "Save edited branch", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Enter");
      await expect
        .poll(
          async () =>
            (await records(page, "messages")).items.filter(
              (value) => value.editedFromMessageId !== null,
            ).length,
        )
        .toBe(2);
      await expect(message).toBeFocused();
      await expect(page.locator(".message.user").first()).toContainText(
        "Keyboard comet question edited by keyboard",
      );
      await page
        .locator("summary", { hasText: "Conversation settings" })
        .focus();
      await page.keyboard.press("Enter");
      const title = page.getByLabel("Title", { exact: true });
      await expect(title).toBeVisible();
      await title.focus();
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.type("Keyboard notebook");
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("heading", { name: "Keyboard notebook", exact: true }),
      ).toBeVisible();
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.appAcceptance.status()))
              .pendingSources,
        )
        .toBe(0);
      const searchField = page.getByLabel("Search your history", {
        exact: true,
      });
      await searchField.focus();
      await page.keyboard.type("Keyboard comet question");
      await page.keyboard.press("Enter");
      const results = page.getByRole("region", { name: "Search results" });
      await expect(results.getByText("Exact text match").first()).toBeVisible();
      await tab();
      await tab();
      await tab();
      await expect(results.getByRole("button").nth(1)).toBeFocused();
      await page.keyboard.press("Enter");
      const selected = page.getByRole("region", {
        name: "Selected search content",
        exact: true,
      });
      await expect(selected.getByRole("heading")).toBeFocused();
      await tab();
      await expect(
        selected.getByRole("button", { name: "Close selected content", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(selected).toHaveCount(0);
      await expect(searchField).toBeFocused();
      await tab();
      await tab();
      await expect(
        results.getByRole("button", { name: "Close results", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(results).toHaveCount(0);
      await expect(searchField).toBeFocused();
      const unnamed = await page.evaluate(() =>
        [...document.querySelectorAll("button, a[href], input, select, textarea, summary")]
          .filter((element) => !element.closest("[hidden]"))
          .map((element) => ({
            tag: element.tagName,
            name: (
              element.getAttribute("aria-label") ||
              (element.labels && element.labels[0]?.textContent) ||
              element.textContent ||
              element.getAttribute("title") ||
              ""
            ).trim(),
          }))
          .filter((item) => !item.name),
      );
      if (unnamed.length) console.error("DIAG-UNNAMED", unnamed.length, JSON.stringify(await page.evaluate(() => [...document.querySelectorAll("input")].filter((e) => !(e.getAttribute("aria-label") || (e.labels && e.labels[0]?.textContent) || e.textContent || e.getAttribute("title") || "").trim()).slice(0, 4).map((e) => e.outerHTML.slice(0, 160) + " | parent " + (e.parentElement?.outerHTML.slice(0, 120) ?? "")))));
      expect(unnamed).toEqual([]);
      evidence.checks.push(
        "keyboard-only workflow: skip link, new conversation, send, stop, regenerate, edit/cancel, rename and search-result navigation keep visible focus on a named control; streamed content is not a live region and status announces only at boundaries",
      );
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.appAcceptance.status()))
              .pendingSources,
        )
        .toBe(0);
      await page
        .getByLabel("Search your history", { exact: true })
        .fill("Visible stream segment 1");
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await expect(
        page
          .getByRole("region", { name: "Search results" })
          .getByText("Exact text match")
          .first(),
      ).toBeVisible();
      await page.getByRole("button", { name: "Close results" }).click();
      evidence.checks.push(
        "automatic derived indexing supplies lexical search across streamed deltas in the shared interface",
      );
      await page
        .getByRole("button", { name: "Export history", exact: true })
        .click();
      evidence.exports = [];
      for (const [format, button] of [
        ["portable", "Prepare Quixi archive"],
        ["open", "Prepare open export"],
      ]) {
        await observeProgress(page, 'archive-phase');
        const prepareButton = page.getByRole("button", { name: button, exact: true });
        await keyboardActivate(prepareButton);
        await expect(
          page.getByRole("button", {
            name: "Save prepared export",
            exact: true,
          }),
        ).toBeVisible({ timeout: 30000 });
        await expect(prepareButton).toBeFocused();
        await verifyProgress(page);
        if (format === 'open') {
          await keyboardActivate(page.getByRole('button', { name: 'Release prepared export', exact: true }));
          await expect(page.getByRole('button', { name: 'Save prepared export', exact: true })).toHaveCount(0);
          await expect(page.getByRole('heading', { name: 'Export your history', exact: true })).toBeFocused();
          await keyboardActivate(prepareButton);
          await expect(page.getByRole('button', { name: 'Save prepared export', exact: true })).toBeVisible({ timeout: 30000 });
          await expect(prepareButton).toBeFocused();
        }
        const downloading = page.waitForEvent("download");
        await keyboardActivate(page.getByRole("button", { name: "Save prepared export", exact: true }));
        const download = await downloading;
        const bytes = await readFile(await download.path());
        expect(bytes.length).toBeGreaterThan(1024);
        // The session credential never reaches an archive or open export.
        expect(bytes.includes("synthetic-secret")).toBe(false);
        const path = resolve(temporary, `${name}-${format}.tar`);
        await writeFile(path, bytes);
        const entries = execFileSync("tar", ["-tf", path], {
          encoding: "utf8",
        });
        expect(entries).toContain("manifest.json");
        expect(entries).toContain(
          format === "portable" ? "quixi.sqlite" : "history.md",
        );
        evidence.exports.push({
          format,
          byteLength: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
        await expect(
          page.getByRole("button", {
            name: "I checked the download — clear temporary copy",
            exact: true,
          }),
        ).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Export your history', exact: true })).toBeFocused();
        await keyboardActivate(page.getByRole("button", {
            name: "I checked the download — clear temporary copy",
            exact: true,
          }));
        await expect(
          page.getByRole("region", { name: "Temporary browser downloads" }),
        ).toHaveCount(0);
        await expect(page.getByRole('heading', { name: 'Export your history', exact: true })).toBeFocused();
        await expect(page.getByRole("alert")).toHaveCount(0);
      }
      evidence.checks.push(
        "portable and open exports download actual disk-backed TAR bytes; user-confirmed temporary cleanup preserves canonical history",
      );
      evidence.checks.push("keyboard export preparation restores the original control, save/release/temporary-copy removal park focus at the export heading, and live progress announces phase names without byte or record counters");
      await page.getByRole("button", { name: "Library", exact: true }).click();
      // Plan 08 composer attachments: images enter through the host file
      // picker or a drop, are refused outside the request profile, can be
      // removed before sending, and the survivor is published with the
      // message, sent as a provider image block and previews from the archive.
      await page.getByRole("button", { name: /Comet notebook/ }).click();
      await expect(
        page.getByRole("heading", { name: "Comet notebook" }),
      ).toBeVisible();
      const chosenPng = pngImage(2, 2, (x, y) => [x * 255, y * 255, 128, 255]);
      const droppedPng = pngImage(3, 1, (x) => [10 * x, 200, 30, 255]);
      const attachButton = page.getByRole("button", {
        name: "Attach files",
        exact: true,
      });
      const pickerChooser = page.waitForEvent("filechooser");
      await attachButton.click();
      await (await pickerChooser).setFiles([
        { name: "chosen.png", mimeType: "image/png", buffer: chosenPng },
      ]);
      await expect(page.getByRole("img", { name: "chosen.png" })).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
      for (const refused of [
        { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not an image") },
        {
          name: "big.png",
          mimeType: "image/png",
          buffer: Buffer.concat([chosenPng, Buffer.alloc(2_621_441 - chosenPng.length)]),
        },
        {
          name: "mislabeled.png",
          mimeType: "image/png",
          buffer: Buffer.from("GIF89a synthetic bytes declared as a PNG"),
        },
      ]) {
        const refusedChooser = page.waitForEvent("filechooser");
        await attachButton.click();
        await (await refusedChooser).setFiles([refused]);
        await expect(page.getByRole("alert")).toContainText(refused.name);
        await expect(page.getByRole("img", { name: refused.name })).toHaveCount(0);
      }
      const dataTransfer = await page.evaluateHandle((base64) => {
        const transfer = new DataTransfer();
        const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
        transfer.items.add(new File([bytes], "dropped.png", { type: "image/png" }));
        return transfer;
      }, droppedPng.toString("base64"));
      await page.locator("form.composer").dispatchEvent("drop", { dataTransfer });
      await expect(page.getByRole("img", { name: "dropped.png" })).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
      await page.getByRole("button", { name: "Remove chosen.png", exact: true }).click();
      await expect(page.getByRole("img", { name: "chosen.png" })).toHaveCount(0);
      const attachmentsBefore = (await records(page, "attachments")).items;
      const generationsBeforeDrop = (await records(page, "generations")).items.length;
      const activeProvider = await page.getByLabel("Provider", { exact: true }).inputValue();
      await send(page, "Describe the dropped image");
      await expect
        .poll(async () => (await records(page, "generations")).items.length)
        .toBe(generationsBeforeDrop + 1);
      await expect(
        page.getByRole("button", { name: "Send message", exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.getByRole("img", { name: "dropped.png" })).toHaveCount(0);
      const droppedDigest = createHash("sha256").update(droppedPng).digest("hex");
      const chosenDigest = createHash("sha256").update(chosenPng).digest("hex");
      const attachmentsAfter = (await records(page, "attachments")).items;
      expect(attachmentsAfter).toHaveLength(attachmentsBefore.length + 1);
      const published = attachmentsAfter.find((item) => item.blobSha256 === droppedDigest);
      expect(published).toMatchObject({
        availability: "available",
        filename: "dropped.png",
        mimeType: "image/png",
        sizeBytes: droppedPng.length,
      });
      expect(attachmentsAfter.some((item) => item.blobSha256 === chosenDigest)).toBe(false);
      const droppedMessage = (await records(page, "messages")).items
        .filter((item) => item.role === "user")
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      expect(droppedMessage.partCount).toBe(2);
      const droppedParts = (
        await page.evaluate((messageId) => window.appAcceptance.parts(messageId), droppedMessage.id)
      ).items;
      expect(droppedParts.map((part) => part.kind)).toEqual(["Text", "Image"]);
      expect(droppedParts[1].data).toEqual({ attachmentId: published.id, description: "dropped.png" });
      const droppedRequest = requests.at(-1).body;
      const droppedTurn = droppedRequest.messages.filter((message) => message.role === "user").at(-1);
      const droppedBase64 = droppedPng.toString("base64");
      expect(droppedTurn.content[0]).toEqual({ type: "text", text: "Describe the dropped image" });
      expect(droppedTurn.content[1]).toEqual(
        activeProvider === "anthropic"
          ? { type: "image", source: { type: "base64", media_type: "image/png", data: droppedBase64 } }
          : { type: "image_url", image_url: { url: `data:image/png;base64,${droppedBase64}` } },
      );
      expect(JSON.stringify(droppedRequest)).not.toContain(chosenPng.toString("base64"));
      await page.getByRole("button", { name: "Preview image", exact: true }).last().click();
      const archivedPreview = page.getByRole("img", { name: "dropped.png" });
      await expect(archivedPreview).toBeVisible();
      expect(await archivedPreview.evaluate((image) => [image.naturalWidth, image.naturalHeight])).toEqual([3, 1]);
      await page.getByRole("button", { name: "Close image preview", exact: true }).click();
      evidence.checks.push(
        "composer attaches images through the host file picker and drag-and-drop, refuses non-image, oversized and mislabeled files, removes a staged image before sending, and publishes the remaining image as a verified attachment, Image part and provider image block that previews from the archive",
      );
      // Plan 06 account health: provider answers drive the composer's
      // connection status and availability, the device's offline signal
      // overrides it, and Providers shows the same health and re-checks it.
      await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
      const connectionHealth = page.locator(".connection-health");
      const sendButton = page.getByRole("button", { name: "Send message", exact: true });
      const dismissFailure = async () => {
        const dismiss = page.getByRole("button", { name: "Dismiss", exact: true });
        if (await dismiss.count()) await dismiss.first().click();
      };
      await expect(connectionHealth).toContainText("Anthropic: Healthy");
      const generationsBeforeHealth = (await records(page, "generations")).items.length;
      nextResponse = {
        status: 429,
        headers: { "retry-after": "3" },
        body: { type: "error", error: { type: "rate_limit_error", message: "Synthetic rate limit" } },
      };
      await send(page, "Trigger a synthetic rate limit");
      await expect
        .poll(async () => (await records(page, "generations")).items.length)
        .toBe(generationsBeforeHealth + 1);
      await expect(connectionHealth).toContainText("Anthropic: Rate limited · retry in");
      await expect(connectionHealth).toContainText("Synthetic rate limit · from the last response");
      await page.getByLabel("Message", { exact: true }).fill("Waiting for the retry time");
      await expect(sendButton).toBeDisabled();
      await expect(sendButton).toBeEnabled({ timeout: 10_000 });
      await expect(connectionHealth).toContainText("the retry time has passed");
      await dismissFailure();
      nextResponse = {
        status: 401,
        body: { type: "error", error: { type: "authentication_error", message: "Synthetic expired key" } },
      };
      await send(page, "Trigger an expired credential");
      await expect
        .poll(async () => (await records(page, "generations")).items.length)
        .toBe(generationsBeforeHealth + 2);
      await expect(connectionHealth).toContainText("Anthropic: Authentication expired · the provider rejected the credential; reconnect it in Providers · Synthetic expired key");
      const afterFailure = requests.at(-1).body.messages;
      expect(afterFailure.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "Trigger an expired credential" }] });
      expect(afterFailure.at(-2)).toEqual({ role: "user", content: [{ type: "text", text: "Trigger a synthetic rate limit" }] });
      await page.getByLabel("Message", { exact: true }).fill("Blocked until the connection is checked");
      await expect(sendButton).toBeDisabled();
      await dismissFailure();
      const healthGenerations = (await records(page, "generations")).items.sort((a, b) => a.createdAt - b.createdAt);
      expect(healthGenerations.slice(-2).map((value) => value.status)).toEqual(["failed", "failed"]);
      await page.getByRole("button", { name: "Open Providers", exact: true }).click();
      const anthropicCard = page
        .getByRole("article")
        .filter({ has: page.getByRole("heading", { name: "Anthropic", exact: true }) });
      await expect(anthropicCard.getByText("Credential connected · authentication expired", { exact: true })).toBeVisible();
      await expect(anthropicCard.getByText("Synthetic expired key (from the last chat response)", { exact: true })).toBeVisible();
      await keyboardActivate(anthropicCard.getByRole("button", { name: "Check connection", exact: true }));
      await expect(anthropicCard.getByText("Credential connected · healthy", { exact: true })).toBeVisible();
      await expect(anthropicCard.getByRole("button", { name: "Check connection", exact: true })).toBeFocused();
      evidence.checks.push("provider connect and connection-check buttons work by keyboard and retain focus across asynchronous disabled states and the Connect-to-Replace label change");
      await page.getByRole("button", { name: "Library", exact: true }).click();
      await page.getByRole("button", { name: /Comet notebook/ }).click();
      await expect(page.getByRole("heading", { name: "Comet notebook" })).toBeVisible();
      await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
      await expect(connectionHealth).toContainText("Anthropic: Healthy · from a connection check");
      await page.getByLabel("Message", { exact: true }).fill("Healthy again");
      await expect(sendButton).toBeEnabled();
      await page.evaluate(() => {
        Object.defineProperty(navigator, "onLine", { get: () => false, configurable: true });
        window.dispatchEvent(new Event("offline"));
      });
      await expect(connectionHealth).toContainText("Anthropic: Offline · This device reports no network connection.");
      await expect(sendButton).toBeDisabled();
      await page.evaluate(() => {
        Object.defineProperty(navigator, "onLine", { get: () => true, configurable: true });
        window.dispatchEvent(new Event("online"));
      });
      await expect(connectionHealth).toContainText("Anthropic: Healthy");
      await expect(sendButton).toBeEnabled();
      await page.getByLabel("Message", { exact: true }).fill("");
      await expect(page.getByRole("alert")).toHaveCount(0);
      evidence.checks.push(
        "provider answers drive the composer's connection status and availability: a 429 with retry-after shows rate limited with the provider's reason and blocks sending until the retry time passes, a 401 shows authentication expired and blocks sending until Providers re-checks the connection, the device's offline signal blocks sending until it returns, both failed attempts are recorded, and the next request omits the failed attempt's empty assistant turn",
      );
      evidence.healthRefresh = await exerciseHealthRefresh({ page, name,
        modelRequests: () => structuredClone(modelRequests),
        respond: (provider, response) => nextModelResponses.set(provider, response),
        held: provider => heldModelResponses.has(provider),
        release: provider => { heldModelResponses.get(provider)?.(); heldModelResponses.delete(provider); },
      });
      evidence.checks.push('background account-health checks update visible status through bounded model metadata only; offline and hidden activity suppresses due work, authentication rejection pauses probing, explicit checks recover, and cancelling a held probe preserves prior health without canonical writes or content traffic');
      // Plan 08 token and cost displays: each attempt shows reported usage and
      // a reviewed-price estimate, and the conversation header sums every
      // recorded attempt through the storage worker.
      const cometThread = (await records(page, "threadStates")).items.find((value) => value.title === "Comet notebook");
      const cometGenerations = (await records(page, "generations")).items.filter((value) => value.threadId === cometThread.threadId);
      const priced = cometGenerations.filter((value) => value.estimatedCost);
      expect(priced.length).toBeGreaterThan(0);
      // Reviewed rates per million tokens: Haiku 4.5 at 1 in / 5 out, GPT-4.1
      // mini at 0.40 in / 1.60 out. A stopped attempt keeps the input-only
      // estimate the provider's usage already established.
      const expectedEstimate = (value) =>
        ((value.tokensIn * (value.provider === "anthropic" ? 1 : 0.4) + value.tokensOut * (value.provider === "anthropic" ? 5 : 1.6)) / 1_000_000).toFixed(9);
      expect(priced.some((value) => value.status === "complete")).toBe(true);
      for (const value of priced) {
        expect(value.tokensIn).toBe(12);
        expect(value.tokensOut).toBe(value.status === "cancelled" ? 0 : 20);
        expect(value.cachedTokens).toBe(0);
        expect(value.estimatedCost).toEqual({ amount: expectedEstimate(value), currency: "USD" });
      }
      expect(cometGenerations.filter((value) => value.status === "failed").every((value) => value.estimatedCost === null)).toBe(true);
      const sum = (values) => values.reduce((total, value) => total + value, 0);
      const expectedUsage = {
        attempts: cometGenerations.length,
        tokensIn: sum(cometGenerations.map((value) => value.tokensIn ?? 0)),
        tokensOut: sum(cometGenerations.map((value) => value.tokensOut ?? 0)),
        estimated: sum(priced.map((value) => Number(value.estimatedCost.amount))).toFixed(6),
        unpriced: cometGenerations.length - priced.length,
      };
      const usageLine = page.locator(".conversation-usage");
      await expect(usageLine).toContainText(`${expectedUsage.attempts} attempts · tokens in ${expectedUsage.tokensIn} · out ${expectedUsage.tokensOut}`);
      await expect(usageLine).toContainText(`estimated ≈ ${expectedUsage.estimated.replace(/0+$/, "").replace(/\.$/, ".00")} USD across ${priced.length} priced attempts, ${expectedUsage.unpriced} without a price`);
      await expect(page.locator(".attempt-usage", { hasText: "Cost: ≈ 0.000112 USD estimated from reviewed pricing" }).first()).toBeVisible();
      await expect(page.locator(".attempt-usage", { hasText: "Tokens in: unknown · out: unknown · Cost: unknown" }).first()).toBeVisible();
      evidence.checks.push(
        "every completed attempt records reported tokens and a cost estimated from the reviewed catalog price, failed attempts stay unpriced, each attempt line shows its usage and estimate provenance, and the conversation header sums attempts, tokens and priced estimates from the storage worker",
      );
      // Plan 06 token counting: the prompt a send would dispatch is counted
      // through Anthropic's count endpoint on request, without committing;
      // the OpenAI connection reports its unimplemented counting capability.
      await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
      const messagesBeforeCount = (await records(page, "messages")).items.length;
      await page.getByLabel("Message", { exact: true }).fill("Count these tokens before sending");
      const countButton = page.getByRole("button", { name: "Count prompt tokens", exact: true });
      await countButton.click();
      const countLine = page.locator(".prompt-count");
      await expect(countLine).toContainText("tokens counted by Anthropic for this draft and branch.");
      const countRequest = countRequests.at(-1).body;
      expect(countRequest.model).toBe("claude-haiku-4-5-20251001");
      expect("stream" in countRequest).toBe(false);
      expect("max_tokens" in countRequest).toBe(false);
      expect(countRequest.messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "Count these tokens before sending" }] });
      await expect(countLine).toContainText(`Prompt: ${JSON.stringify(countRequest.messages).length.toLocaleString("en-US")} tokens`);
      expect((await records(page, "messages")).items).toHaveLength(messagesBeforeCount);
      await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Count these tokens before sending");
      await page.getByLabel("Message", { exact: true }).fill("Count these tokens before sending, edited");
      await expect(countLine).toHaveCount(0);
      await page.getByLabel("Provider", { exact: true }).selectOption("openai");
      await countButton.click();
      await expect(countLine).toContainText("Token counting is unavailable for this connection: Token counting is not implemented for this Chat Completions connection.");
      await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
      await page.getByLabel("Message", { exact: true }).fill("");
      evidence.checks.push(
        "counting prompt tokens sends the exact draft and branch to Anthropic's count endpoint without generation fields, shows the provider's count for this draft, commits nothing, clears when the draft changes, and reports that counting is not implemented for the OpenAI Chat Completions connection",
      );
      // Plan 08 branch navigation: the sibling list shows every alternative
      // at a point, choosing one commits the active path and shows its own
      // descendants as continuations, and the other branch stays intact.
      const cometRoots = (await records(page, "messages")).items
        .filter((value) => value.threadId === cometThread.threadId && value.parentId === null)
        .sort((a, b) => a.createdAt - b.createdAt);
      expect(cometRoots.map((value) => value.role)).toEqual(["user", "user"]);
      const originalRoot = cometRoots.find((value) => value.editedFromMessageId === null);
      const editedRoot = cometRoots.find((value) => value.editedFromMessageId !== null);
      const leafBefore = (await records(page, "threadStates")).items.find((value) => value.threadId === cometThread.threadId).activeLeafMessageId;
      await page.getByRole("button", { name: "Show starting branches", exact: true }).click();
      const branchChoices = page.getByRole("region", { name: "Branch choices" });
      await expect(branchChoices.getByRole("heading", { name: "Starting branches" })).toBeVisible();
      await expect(branchChoices.getByRole("button", { name: new RegExp(originalRoot.id.slice(0, 8)) })).toBeVisible();
      await expect(branchChoices.getByRole("button", { name: new RegExp(editedRoot.id.slice(0, 8)) })).toBeVisible();
      await branchChoices.getByRole("button", { name: new RegExp(originalRoot.id.slice(0, 8)) }).click();
      await expect(page.locator(".message.user").first()).toContainText("First comet question");
      await expect(page.locator(".message.user", { hasText: "Edited comet question" })).toHaveCount(0);
      await expect(branchChoices.getByRole("heading", { name: "Branch continuations" })).toBeVisible();
      const originalResponses = (await records(page, "messages")).items
        .filter((value) => value.parentId === originalRoot.id)
        .sort((a, b) => a.createdAt - b.createdAt);
      expect(originalResponses.map((value) => value.role)).toEqual(["assistant", "assistant"]);
      await branchChoices.getByRole("button", { name: new RegExp(originalResponses[0].id.slice(0, 8)) }).click();
      await expect(page.locator(".message.assistant").first()).toContainText("Visible stream 🧪");
      await expect
        .poll(async () => (await records(page, "threadStates")).items.find((value) => value.threadId === cometThread.threadId).activeLeafMessageId)
        .toBe(originalResponses[0].id);
      const secondTurn = (await records(page, "messages")).items.find((value) => value.parentId === originalResponses[0].id && value.role === "user");
      expect(secondTurn).toBeTruthy();
      await branchChoices.getByRole("button", { name: new RegExp(secondTurn.id.slice(0, 8)) }).click();
      await expect(page.locator(".message.user").nth(1)).toContainText("Second comet question");
      await expect
        .poll(async () => (await records(page, "threadStates")).items.find((value) => value.threadId === cometThread.threadId).activeLeafMessageId)
        .toBe(secondTurn.id);
      expect((await records(page, "messages")).items.some((value) => value.id === leafBefore)).toBe(true);
      expect((await records(page, "messages")).items.some((value) => value.id === editedRoot.id)).toBe(true);
      evidence.checks.push(
        "the starting-branch list shows every root alternative, choosing one commits the active path and lists its own continuations step by step, and the edited branch and its descendants stay intact while another path is active",
      );
      // Plan 08 either-provider criterion: stop under the OpenAI connection,
      // and search across text streamed by the Anthropic connection, opening
      // the hit at the exact generated part. Create, reopen, edit and search
      // involve no provider themselves and are proven above.
      await page.getByLabel("Provider", { exact: true }).selectOption("openai");
      const generationsBeforeStop = (await records(page, "generations")).items.length;
      await send(page, "slow response comet");
      await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeVisible();
      await expect
        .poll(async () => (await records(page, "generations")).items.length)
        .toBe(generationsBeforeStop + 1);
      const openaiStopped = (await records(page, "generations")).items.sort((a, b) => b.createdAt - a.createdAt)[0];
      expect(openaiStopped.provider).toBe("openai");
      await expect(page.locator(`[data-message-id="${openaiStopped.outputMessageId}"]`)).toContainText("Visible stream");
      await page.getByRole("button", { name: "Stop response", exact: true }).click();
      await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
      await expect
        .poll(async () => (await records(page, "generations")).items.find((value) => value.id === openaiStopped.id).status)
        .toMatch(/^(stopped|cancelled|partial)$/);
      expect(requests.at(-1).anthropic).toBe(false);
      await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
      await send(page, "identify yourself");
      await expect
        .poll(async () => (await records(page, "generations")).items.length)
        .toBe(generationsBeforeStop + 2);
      await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
      const identified = (await records(page, "generations")).items.sort((a, b) => b.createdAt - a.createdAt)[0];
      expect(identified.provider).toBe("anthropic");
      expect(identified.status).toBe("complete");
      await expect(page.locator(`[data-message-id="${identified.outputMessageId}"]`)).toContainText("served by messages api");
      await expect
        .poll(async () => (await page.evaluate(() => window.appAcceptance.status())).pendingSources)
        .toBe(0);
      await page.getByLabel("Search your history", { exact: true }).fill("served by messages api");
      await page.getByRole("button", { name: "Search", exact: true }).click();
      const anthropicHits = page.getByRole("region", { name: "Search results" });
      await expect(anthropicHits.getByText("Exact text match").first()).toBeVisible();
      await anthropicHits.getByRole("button", { name: "Comet notebook", exact: true }).first().click();
      const anthropicSelected = page.getByRole("region", { name: "Selected search content", exact: true });
      await expect(anthropicSelected).toBeVisible();
      await expect(anthropicSelected).toContainText("served by messages api");
      const focusedPartId = await anthropicSelected.getAttribute("data-focused-part-id");
      const identifiedParts = (await page.evaluate((messageId) => window.appAcceptance.parts(messageId), identified.outputMessageId)).items;
      expect(identifiedParts.some((part) => part.id === focusedPartId)).toBe(true);
      await anthropicSelected.getByRole("button", { name: "Close selected content", exact: true }).click();
      await page.getByRole("button", { name: "Close results", exact: true }).click();
      evidence.checks.push(
        "stop terminates an OpenAI stream and records its interrupted attempt, and text streamed by the Anthropic connection is indexed and found by search, which opens the hit at the exact generated part; create, reopen, edit and search themselves involve no provider",
      );
      // Plan 05 credential boundary: the connected credential appears in no
      // canonical record, provider request body, or browser storage; only the
      // host injected it into request headers.
      for (const collection of ["messages", "generations", "parts", "threadStates", "contexts", "attachments"])
        expect(JSON.stringify((await records(page, collection)).items)).not.toContain("synthetic-secret");
      expect(JSON.stringify(requests.map((value) => value.body))).not.toContain("synthetic-secret");
      expect(JSON.stringify(countRequests.map((value) => value.body))).not.toContain("synthetic-secret");
      expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
      expect(await page.evaluate(() => document.documentElement.outerHTML.includes("synthetic-secret"))).toBe(false);
      evidence.checks.push(
        "the connected credential is absent from every canonical record, every provider request body, every exported archive, browser storage and the rendered document; only the host injects it into request headers",
      );
      // Plan 10 switch inspection: selecting another provider shows what the
      // active path would carry, transform, omit or refuse; a consequential
      // switch needs an explicit review scoped to that report; the send
      // records the switch as a ProviderSwitch event with the user turn.
      await page.getByLabel("Provider", { exact: true }).selectOption("openai");
      const switchReport = page.getByRole("region", { name: "Compatibility report" });
      await expect(switchReport.getByRole("heading", { name: "Switching to OpenAI · GPT-4.1 mini" })).toBeVisible();
      await expect(switchReport).toContainText("Blocked: 0");
      await expect(switchReport).toContainText("Your conversation will be sent to a different provider.");
      await expect(switchReport.getByRole("alert")).toHaveCount(0);
      // Context and cost: the room is the reviewed window minus the requested
      // output; the OpenAI connection does not implement counting, so only the reviewed
      // rates are quoted.
      const requestedOutput = Number(await page.getByLabel("Maximum output tokens", { exact: true }).inputValue());
      const openaiRoom = 1_047_576 - requestedOutput;
      await expect(switchReport).toContainText(`Context: target window 1,047,576 tokens · requested output ${requestedOutput.toLocaleString("en-US")} · room for input ${openaiRoom.toLocaleString("en-US")} tokens.`);
      await expect(switchReport).toContainText("Token counting is unavailable for OpenAI; the encoded request is");
      await expect(switchReport).toContainText("Cost: reviewed rates are 0.40 USD per million input tokens and 1.60 USD per million output tokens, reviewed 2026-09-09; count the prompt for an input estimate.");
      await page.getByLabel("Message", { exact: true }).fill("Continue with OpenAI after the switch");
      await expect(sendButton).toBeDisabled();
      await switchReport.getByRole("checkbox", { name: /I reviewed this switch/ }).check();
      await expect(sendButton).toBeEnabled();
      const reportText = await switchReport.textContent();
      const preservedCount = Number(/Preserved: (\d+) parts/.exec(reportText)[1]);
      expect(preservedCount).toBeGreaterThan(0);
      const generationsBeforeSwitch = (await records(page, "generations")).items.length;
      await sendButton.click();
      await expect
        .poll(async () => (await records(page, "generations")).items.length)
        .toBe(generationsBeforeSwitch + 1);
      await expect(sendButton).toBeVisible();
      const switchedAttempt = (await records(page, "generations")).items.sort((a, b) => b.createdAt - a.createdAt)[0];
      expect(switchedAttempt.provider).toBe("openai");
      const switchEvents = (await records(page, "events")).items
        .filter((value) => value.threadId === cometThread.threadId && value.type === "ProviderSwitch")
        .sort((a, b) => a.recordedAt - b.recordedAt);
      const latestSwitch = switchEvents.at(-1);
      expect(latestSwitch.details).toMatchObject({ from: { provider: "anthropic" }, to: { provider: "openai", model: "gpt-4.1-mini-2025-04-14" }, preserved: preservedCount, blocked: 0, promptTokens: null, inputRoom: openaiRoom });
      expect(latestSwitch.messageId).toBe(switchedAttempt.parentMessageId);
      await expect(page.getByRole("list", { name: "Conversation events" })).toContainText("Switched Anthropic claude-haiku-4-5-20251001 → OpenAI gpt-4.1-mini-2025-04-14");
      await expect(switchReport).toHaveCount(0);
      // Selecting the previous connection again is itself a switch to review.
      await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
      await expect(switchReport.getByRole("heading", { name: "Switching to Anthropic · Claude Haiku 4.5" })).toBeVisible();
      await expect(switchReport.getByRole("checkbox", { name: /I reviewed this switch/ })).not.toBeChecked();
      // Under the Anthropic target an on-request count compares the draft and
      // branch with the room and prices the input at the reviewed rate; the
      // count is never taken automatically.
      const anthropicRoom = 200_000 - requestedOutput;
      await expect(switchReport).toContainText(`room for input ${anthropicRoom.toLocaleString("en-US")} tokens.`);
      await expect(switchReport).toContainText("Count prompt tokens to compare this draft and branch with the room; counting sends them to Anthropic.");
      const countRequestsBeforeSwitch = countRequests.length;
      await page.getByLabel("Message", { exact: true }).fill("Count before switching back");
      await page.getByRole("button", { name: "Count prompt tokens", exact: true }).click();
      await expect(page.locator(".prompt-count")).toContainText("tokens counted by Anthropic for this draft and branch.");
      expect(countRequests.length).toBe(countRequestsBeforeSwitch + 1);
      const switchCount = JSON.stringify(countRequests.at(-1).body.messages).length;
      const usd = (units, perMillion) => {
        const digits = String(units * perMillion).padStart(7, "0");
        const fraction = digits.slice(-6).replace(/0+$/, "");
        return `${digits.slice(0, -6)}.${fraction.length < 2 ? fraction.padEnd(2, "0") : fraction}`;
      };
      await expect(switchReport).toContainText(`Current prompt: ${switchCount.toLocaleString("en-US")} tokens counted by Anthropic · fits with ${(anthropicRoom - switchCount).toLocaleString("en-US")} tokens to spare.`);
      await expect(switchReport).toContainText(`Cost: ≈ ${usd(switchCount, 1)} USD for the counted input plus up to ≈ ${usd(requestedOutput, 5)} USD for ${requestedOutput.toLocaleString("en-US")} output tokens, estimated from reviewed pricing`);
      await page.getByLabel("Message", { exact: true }).fill("");
      await expect(switchReport).toContainText("Count prompt tokens to compare this draft and branch with the room");
      evidence.checks.push(
        "switching the composer to another provider shows the compatibility report for the active path, refuses to send until the exact report is reviewed, records the switch as a ProviderSwitch event committed with the user turn, and lists it in the conversation",
      );
      // Plan 10 fallback: the conversation's stored fallback continues a
      // failed attempt with another connection as a separate attempt,
      // recorded with an AutomaticFallback event in the attempt's own commit;
      // a partial primary stays partial beside it; a stop never falls back.
      await page.getByLabel("Fallback candidate", { exact: true }).selectOption("openai:gpt-4.1-mini-2025-04-14");
      await page.getByRole("button", { name: "Add candidate", exact: true }).click();
      const candidateList = page.getByRole("list", { name: "Fallback candidates" });
      const candidateRemoval = candidateList.getByRole("button", { name: "Remove fallback 1: OpenAI · GPT-4.1 mini", exact: true });
      await expect(candidateRemoval).toBeEnabled();
      const beforeRemovalHttp = requests.length, beforeRemovalCounts = countRequests.length;
      await keyboardActivate(candidateRemoval);
      await expect(candidateList).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Conversation routing", exact: true })).toBeFocused();
      expect(requests.length).toBe(beforeRemovalHttp); expect(countRequests.length).toBe(beforeRemovalCounts);
      await page.getByLabel("Fallback candidate", { exact: true }).selectOption("openai:gpt-4.1-mini-2025-04-14");
      await keyboardActivate(page.getByRole("button", { name: "Add candidate", exact: true }));
      await expect(candidateRemoval).toBeEnabled();
      evidence.checks.push("conversation fallback removal names its numbered target, preserves keyboard focus at Conversation routing after durable removal, and performs no provider or count request");

      await expect(candidateList).toContainText("OpenAI · GPT-4.1 mini");
      const routeLine = page.locator(".route-plan");
      await expect(routeLine).toContainText("Route: Anthropic · Claude Haiku 4.5: chosen. If it fails, continue with OpenAI · GPT-4.1 mini. A stopped response never falls back.");
      await expect
        .poll(async () => (await records(page, "threadStates")).items.find((value) => value.threadId === cometThread.threadId).routingProfile)
        .toEqual({ version: 2, alias: null, candidates: [{ provider: "openai", model: "gpt-4.1-mini-2025-04-14" }], requirements: {}, allowPrivacyChange: false });
      const generationsBeforeFallback = (await records(page, "generations")).items.length;
      const fallbackEventsBefore = (await records(page, "events")).items.filter((value) => value.type === "AutomaticFallback").length;
      nextResponse = {
        status: 503,
        body: { type: "error", error: { type: "overloaded_error", message: "Synthetic overload" } },
      };
      await send(page, "Fallback after overload");
      await expect
        .poll(async () => (await records(page, "generations")).items.length)
        .toBe(generationsBeforeFallback + 2);
      await expect(sendButton).toBeVisible();
      await expect(page.locator(".generation-status")).toHaveText("Response complete.");
      const fallbackAttempts = (await records(page, "generations")).items.sort((a, b) => a.createdAt - b.createdAt).slice(-2);
      expect(fallbackAttempts.map((value) => [value.provider, value.status])).toEqual([["anthropic", "failed"], ["openai", "complete"]]);
      expect(fallbackAttempts[1].parentMessageId).toBe(fallbackAttempts[0].parentMessageId);
      expect(requests.at(-1).anthropic).toBe(false);
      const fallbackEvents = (await records(page, "events")).items.filter((value) => value.type === "AutomaticFallback");
      expect(fallbackEvents).toHaveLength(fallbackEventsBefore + 1);
      const fallbackEvent = fallbackEvents.sort((a, b) => a.recordedAt - b.recordedAt).at(-1);
      expect(fallbackEvent.generationId).toBe(fallbackAttempts[1].id);
      expect(fallbackEvent.messageId).toBe(fallbackAttempts[0].parentMessageId);
      expect(fallbackEvent.details).toMatchObject({
        from: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
        to: { provider: "openai", model: "gpt-4.1-mini-2025-04-14" },
        primaryGenerationId: fallbackAttempts[0].id,
        primaryStatus: "failed",
        failureCode: "provider_error",
      });
      expect(fallbackEvent.details.reason).toContain("Anthropic failed: Synthetic overload");
      expect((await records(page, "threadStates")).items.find((value) => value.threadId === cometThread.threadId).activeLeafMessageId).toBe(fallbackAttempts[1].outputMessageId);
      await expect(page.locator(`[data-message-id="${fallbackAttempts[1].outputMessageId}"]`)).toContainText("openai · gpt-4.1-mini-2025-04-14 · complete");
      await expect(page.locator(`[data-message-id="${fallbackAttempts[1].outputMessageId}"]`)).toContainText("segment 7");
      await expect(page.getByRole("list", { name: "Conversation events" })).toContainText("Fell back Anthropic claude-haiku-4-5-20251001 → OpenAI gpt-4.1-mini-2025-04-14 · Anthropic failed: Synthetic overload");
      // A primary that fails after streaming stays a partial attempt with its
      // committed text; the fallback's answer is the active path.
      await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
      await send(page, "fail mid-stream comet");
      await expect
        .poll(async () => (await records(page, "generations")).items.length)
        .toBe(generationsBeforeFallback + 4);
      await expect(sendButton).toBeVisible();
      const partialAttempts = (await records(page, "generations")).items.sort((a, b) => a.createdAt - b.createdAt).slice(-2);
      expect(partialAttempts.map((value) => [value.provider, value.status])).toEqual([["anthropic", "partial"], ["openai", "complete"]]);
      const partialParts = (await page.evaluate((messageId) => window.appAcceptance.parts(messageId), partialAttempts[0].outputMessageId)).items;
      expect(partialParts.length).toBeGreaterThan(0);
      expect(JSON.stringify(partialParts)).toContain("Visible stream");
      expect((await records(page, "events")).items.filter((value) => value.type === "AutomaticFallback")).toHaveLength(fallbackEventsBefore + 2);
      await expect(page.locator(".generation-status")).toHaveText("Response complete.");
      // A stop is the user's decision: the attempt is cancelled, nothing falls back.
      await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
      await send(page, "slow response comet");
      await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeVisible();
      await expect
        .poll(async () => (await records(page, "generations")).items.length)
        .toBe(generationsBeforeFallback + 5);
      // Stop after committed text exists, so the cancelled attempt keeps output.
      await expect(page.locator(".message.assistant").last()).toContainText("Visible stream");
      await page.getByRole("button", { name: "Stop response", exact: true }).click();
      await expect(sendButton).toBeVisible();
      await expect
        .poll(async () => (await records(page, "generations")).items.sort((a, b) => a.createdAt - b.createdAt).at(-1).status)
        .toBe("cancelled");
      expect((await records(page, "generations")).items).toHaveLength(generationsBeforeFallback + 5);
      expect((await records(page, "events")).items.filter((value) => value.type === "AutomaticFallback")).toHaveLength(fallbackEventsBefore + 2);
      evidence.checks.push(
        "a stored fallback continues a failed or partial primary attempt with the other connection as a separate attempt whose AutomaticFallback event is committed with it and names the failure, the partial attempt keeps its committed text off the active path, and a user stop never falls back",
      );
      // Plan 10 routing: the route is chosen before the first attempt from
      // the profile's requirements and the candidates' health; a selected
      // connection that fails a requirement or cannot send now is routed
      // around with the reason recorded on the attempt, and no qualifying
      // candidate refuses sending with every reason stated.
      const contextField = page.getByLabel("Minimum context window", { exact: true });
      await contextField.fill("500000");
      await contextField.press("Tab");
      await expect
        .poll(async () => (await records(page, "threadStates")).items.find((value) => value.threadId === cometThread.threadId).routingProfile.requirements)
        .toEqual({ contextAtLeast: 500000 });
      await expect(routeLine).toContainText("Route: Anthropic · Claude Haiku 4.5: skipped — context window 200,000 is below 500,000. OpenAI · GPT-4.1 mini: chosen.");
      const generationsBeforeRouting = (await records(page, "generations")).items.length;
      const routingEventsBefore = (await records(page, "events")).items.filter((value) => value.type === "AutomaticFallback").length;
      await send(page, "Routed by the context requirement");
      await expect
        .poll(async () => (await records(page, "generations")).items.length)
        .toBe(generationsBeforeRouting + 1);
      await expect(sendButton).toBeVisible();
      const routedAttempt = (await records(page, "generations")).items.sort((a, b) => a.createdAt - b.createdAt).at(-1);
      expect([routedAttempt.provider, routedAttempt.status]).toEqual(["openai", "complete"]);
      const routingEvents = (await records(page, "events")).items.filter((value) => value.type === "AutomaticFallback").sort((a, b) => a.recordedAt - b.recordedAt);
      expect(routingEvents).toHaveLength(routingEventsBefore + 1);
      expect(routingEvents.at(-1).generationId).toBe(routedAttempt.id);
      expect(routingEvents.at(-1).details).toMatchObject({
        from: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
        to: { provider: "openai", model: "gpt-4.1-mini-2025-04-14" },
        primaryGenerationId: null,
        primaryStatus: "not_attempted",
        failureCode: null,
      });
      expect(routingEvents.at(-1).details.reason).toContain("context window 200,000 is below 500,000");
      await contextField.fill("2000000");
      await contextField.press("Tab");
      await expect(routeLine).toContainText("OpenAI · GPT-4.1 mini: skipped — context window 1,047,576 is below 2,000,000.");
      await page.getByLabel("Message", { exact: true }).fill("No candidate qualifies");
      await expect(sendButton).toBeDisabled();
      await contextField.fill("");
      await contextField.press("Tab");
      await expect
        .poll(async () => (await records(page, "threadStates")).items.find((value) => value.threadId === cometThread.threadId).routingProfile.requirements)
        .toEqual({});
      await expect(routeLine).toContainText("Route: Anthropic · Claude Haiku 4.5: chosen.");
      // Returning from the routed OpenAI attempt to Anthropic is a new
      // consequential switch. Eligibility alone must not bypass its review.
      await expect(sendButton).toBeDisabled();
      await page.getByRole("checkbox", { name: /I reviewed this switch and want to continue with Anthropic/ }).check();
      await expect(sendButton).toBeEnabled();
      // A selected connection whose credential the provider rejected is
      // routed around before any attempt, from its recorded health.
      nextResponse = {
        status: 401,
        body: { type: "error", error: { type: "authentication_error", message: "Synthetic expired key for routing" } },
      };
      await send(page, "Expire the primary credential");
      await expect
        .poll(async () => (await records(page, "generations")).items.length)
        .toBe(generationsBeforeRouting + 3);
      await expect(sendButton).toBeVisible();
      await expect(routeLine).toContainText("Anthropic · Claude Haiku 4.5: skipped — cannot send now: Authentication expired");
      await expect(routeLine).toContainText("OpenAI · GPT-4.1 mini: chosen.");
      await page.getByLabel("Message", { exact: true }).fill("Routed around the blocked primary");
      await expect(sendButton).toBeEnabled();
      await sendButton.click();
      await expect
        .poll(async () => (await records(page, "generations")).items.length)
        .toBe(generationsBeforeRouting + 4);
      await expect(sendButton).toBeVisible();
      const routedAroundHealth = (await records(page, "generations")).items.sort((a, b) => a.createdAt - b.createdAt).at(-1);
      expect([routedAroundHealth.provider, routedAroundHealth.status]).toEqual(["openai", "complete"]);
      const healthRouting = (await records(page, "events")).items.filter((value) => value.type === "AutomaticFallback").sort((a, b) => a.recordedAt - b.recordedAt).at(-1);
      expect(healthRouting.generationId).toBe(routedAroundHealth.id);
      expect(healthRouting.details.primaryStatus).toBe("not_attempted");
      expect(healthRouting.details.reason).toContain("Authentication expired");
      // Restore the primary through a connection check, as the health check does.
      await page.getByRole("button", { name: "Providers", exact: true }).click();
      const routingAnthropicCard = page
        .getByRole("article")
        .filter({ has: page.getByRole("heading", { name: "Anthropic", exact: true }) });
      await routingAnthropicCard.getByRole("button", { name: "Check connection", exact: true }).click();
      await expect(routingAnthropicCard.getByText("Credential connected · healthy", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Library", exact: true }).click();
      await page.getByRole("button", { name: /Comet notebook/ }).click();
      await expect(page.getByRole("heading", { name: "Comet notebook" })).toBeVisible();
      await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
      await expect(routeLine).toContainText("Route: Anthropic · Claude Haiku 4.5: chosen.");
      evidence.checks.push(
        "the conversation's routing profile chooses the route before the first attempt: a selected connection that fails the minimum context requirement or whose credential the provider rejected is routed around with the reason recorded as an AutomaticFallback event on the attempt, no qualifying candidate refuses sending with every reason stated, and clearing the requirement restores the selected connection",
      );
      // Plan 10 portability: the open conversation states where it can
      // continue, with one reason per configured target, and follows the
      // active path; a seeded path carrying a reasoning marker without any
      // verified provider block is portable everywhere with the omission
      // named per target, as the thinking contract permits outside tool use
      // (ADR 0032); nothing invents a signed block for it.
      const portabilityView = page.getByRole("region", { name: "Portability" });
      await expect(portabilityView).toContainText("Portability: Fully portable. Every configured target can carry all");
      const portabilityReasons = portabilityView.getByRole("list", { name: "Portability reasons" });
      await expect(portabilityReasons).toContainText("Anthropic · Claude Haiku 4.5: carries all");
      await expect(portabilityReasons).toContainText("OpenAI · GPT-4.1 mini: carries all");
      await expect(portabilityReasons).toContainText("OpenAI · GPT-Audio-1.5: carries all");
      await expect(portabilityReasons).toContainText("are never sent to any provider.");
      await page.getByRole("button", { name: "Portability thread", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Portability thread", exact: true })).toBeVisible();
      await expect(portabilityView).toContainText("Portability: Portable with transformations. Every configured target can carry the active path; some targets omit reasoning blocks they cannot read or verify.");
      for (const target of ["Anthropic · Claude Haiku 4.5", "OpenAI · GPT-4.1 mini", "OpenAI · GPT-Audio-1.5"])
        await expect(portabilityReasons).toContainText(`${target}: carries all 2 parts; 1 reasoning marker without a verified provider block omitted, as the thinking contract permits outside tool use.`);
      expect((await records(page, "messages")).items.filter((value) => value.threadId === portabilityThread.threadId)).toHaveLength(2);
      evidence.checks.push(
        "the open conversation shows its portability status with one inspectable reason per configured target and what is never sent, and a path whose assistant turn carries a reasoning marker without a verified provider block is portable to every target with that omission named per target and no invented block",
      );
      // Plan 10 imported continuation: a ChatGPT export imported through the
      // production importer continues with the Anthropic connection. The
      // artifact-bearing branch is blocked, the text branch is chosen, the
      // switch is reviewed and recorded from the import origin, the request
      // carries the imported path, and every imported record is unchanged.
      await page.getByRole("button", { name: "Import history", exact: true }).first().click();
      await expect(page.getByRole("heading", { name: "Import your history" })).toBeVisible();
      await page.getByLabel("Source account label").fill("Personal fixture");
      const importChooser = page.waitForEvent("filechooser");
      await keyboardActivate(page.getByRole("button", { name: "Choose JSON or ZIP export" }));
      await (await importChooser).setFiles(chatgptFixture);
      const importSubmit = page.locator(".quixi-imports").getByRole("button", { name: "Import history", exact: true });
      await expect(importSubmit).toBeEnabled();
      await expect(page.getByRole("button", { name: "Choose JSON or ZIP export" })).toBeFocused();
      await observeProgress(page, 'import-phase');
      await keyboardActivate(importSubmit);
      await expect(page.getByRole("status").filter({ hasText: "Import complete." })).toBeVisible({ timeout: 60_000 });
      await expect(importSubmit).toBeDisabled();
      await expect(page.getByRole('heading', { name: 'Import your history', exact: true })).toBeFocused();
      await verifyProgress(page);
      await keyboardActivate(page.getByRole('button', { name: 'Prepare import report', exact: true }));
      await expect(page.getByRole('button', { name: /^Save report / })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Prepare import report', exact: true })).toBeFocused();
      const importedGroup = page.locator('.import-groups > li').filter({ has: page.locator('strong', { hasText: /^Comet design$/ }) });
      await keyboardActivate(importedGroup.getByRole('button', { name: 'Open conversation', exact: true }));
      await expect(page.getByRole("heading", { name: "Comet design" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Comet design", exact: true })).toBeFocused();
      evidence.checks.push("keyboard import picker, start and report preparation preserve focus through async work; opening the saved conversation focuses its heading, and import live progress announces phases without changing numeric counters");
      const importedThread = (await records(page, "threadStates")).items.find((value) => value.title === "Comet design");
      expect((await records(page, "threads")).items.find((value) => value.id === importedThread.threadId).importSourceId).not.toBeNull();
      const importedMessages = (await records(page, "messages")).items.filter((value) => value.threadId === importedThread.threadId);
      expect(importedMessages).toHaveLength(3);
      const snapshotMessages = async (messages) =>
        JSON.stringify(
          await Promise.all(
            [...messages]
              .sort((a, b) => a.id.localeCompare(b.id))
              .map(async (message) => [message, (await page.evaluate((id) => window.appAcceptance.parts(id), message.id)).items]),
          ),
        );
      const importedSnapshot = await snapshotMessages(importedMessages);
      const importedUser = importedMessages.find((value) => value.role === "user");
      const importedAnswers = importedMessages.filter((value) => value.parentId === importedUser.id);
      expect(importedAnswers.map((value) => value.partCount).sort()).toEqual([1, 2]);
      const textAnswer = importedAnswers.find((value) => value.partCount === 1);
      await expect(portabilityView).toContainText("Portability: Blocked. None of the 3 configured targets can carry the active path.");
      await expect(portabilityReasons).toContainText("1 ProviderArtifact part (provider_artifact_unsupported)");
      await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
      evidence.compatibilityAnnouncements = await exerciseCompatibilityAnnouncements({ page, name });
      evidence.checks.push("settled compatibility announcements retain one atomic status node through repeated valid settings edits; blocked reasons remain readable without remounted alerts, focus and draft remain, and inspection sends no HTTP or canonical writes");

      await page.locator(`[data-message-id="${importedUser.id}"]`).getByRole("button", { name: /^Continue from here — / }).click();
      const importedChoices = page.getByRole("region", { name: "Branch choices" });
      await expect(importedChoices.getByRole("heading", { name: "Branch continuations" })).toBeVisible();
      await importedChoices.getByRole("button", { name: new RegExp(textAnswer.id.slice(0, 8)) }).click();
      await expect(page.locator(".message.assistant").last()).toContainText("First candidate");
      // The export listed a sketch whose bytes it did not include: the image
      // is sent as a note naming the file, a transformation shown before use.
      await expect(portabilityView).toContainText("Portability: Portable with transformations. Every configured target can carry the active path; 1 image without local bytes sent as a note naming the missing file.");
      await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
      await expect(switchReport.getByRole("heading", { name: "Switching to Anthropic · Claude Haiku 4.5" })).toBeVisible();
      await expect(switchReport).toContainText("Transformed: 1 image without local bytes sent as a note naming the missing file.");
      await expect(switchReport).toContainText("Blocked: 0");
      await expect(switchReport).toContainText("This conversation was imported from openai. Its original history stays unchanged; only the active path is sent.");
      await expect(switchReport).toContainText("Privacy class changes from Unknown to");
      await expect(switchReport).toContainText("Your conversation will be sent to a different provider.");
      const compatibilityStatus = switchReport.locator(".compatibility-announcement");
      await expect(compatibilityStatus).toContainText("review required before sending");
      const consent = switchReport.getByRole("checkbox", { name: /I reviewed this switch/ });
      await consent.check();
      const oldOutputLimit = await page.getByLabel("Maximum output tokens", { exact: true }).inputValue();
      await page.getByLabel("Maximum output tokens", { exact: true }).fill(oldOutputLimit === "769" ? "770" : "769");
      await expect(switchReport).toContainText("Blocked: 0");
      await expect(consent).not.toBeChecked();
      await expect(sendButton).toBeDisabled();
      await expect(compatibilityStatus).toContainText("review required before sending");
      await page.getByLabel("Maximum output tokens", { exact: true }).fill(oldOutputLimit);
      const requestsBeforeImported = requests.length;
      await send(page, "Continue the imported design");
      await expect
        .poll(async () => (await records(page, "generations")).items.filter((value) => value.threadId === importedThread.threadId).length)
        .toBe(1);
      await expect(sendButton).toBeVisible();
      expect(requests.length).toBe(requestsBeforeImported + 1);
      const importedRequest = requests.at(-1);
      expect(importedRequest.anthropic).toBe(true);
      const importedRequestText = JSON.stringify(importedRequest.body.messages);
      expect(importedRequestText).toContain("Describe a fictional comet.");
      expect(importedRequestText).toContain("First candidate");
      expect(importedRequestText).toContain("Continue the imported design");
      expect(importedRequestText).toContain("[Image not available on this device: comet-sketch.png]");
      expect(importedRequestText).not.toContain('"type":"image"');
      expect(importedRequestText).not.toContain("Second candidate");
      const importedAfter = (await records(page, "messages")).items.filter((value) => value.threadId === importedThread.threadId);
      expect(importedAfter).toHaveLength(5);
      expect(await snapshotMessages(importedAfter.filter((value) => importedMessages.some((item) => item.id === value.id)))).toBe(importedSnapshot);
      const importedAttempt = (await records(page, "generations")).items.find((value) => value.threadId === importedThread.threadId);
      expect([importedAttempt.provider, importedAttempt.status]).toEqual(["anthropic", "complete"]);
      const importedSwitch = (await records(page, "events")).items.find((value) => value.threadId === importedThread.threadId && value.type === "ProviderSwitch");
      expect(importedSwitch.details).toMatchObject({ from: { provider: "openai", model: "imported", privacy: null }, to: { provider: "anthropic", model: "claude-haiku-4-5-20251001" }, transformed: 1, blocked: 0 });
      await expect(page.getByRole("list", { name: "Conversation events" })).toContainText("Switched OpenAI imported → Anthropic claude-haiku-4-5-20251001");
      evidence.checks.push(
        "a ChatGPT export imported through the production importer continues with the Anthropic connection: the artifact-bearing branch is blocked with the adapter's reason, the text branch is chosen, its sketch without exported bytes is shown as a transformation and sent as a note naming the file, the switch from the import origin is reviewed with an unknown privacy class and recorded, the request carries exactly the imported path plus the new turn, and every imported message and part is unchanged afterwards",
      );
      // Plan 06 image mapping: regenerating on the seeded user message sends
      // the verified PNG bytes as an Anthropic base64 image block.
      await page.getByRole("button", { name: "Image thread", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Image thread", exact: true })).toBeVisible();
      const generationsBeforeImage = (await records(page, "generations")).items.length;
      await page
        .getByRole("button", { name: /^Generate another response — / })
        .first()
        .click();
      await expect
        .poll(async () => (await records(page, "generations")).items.length)
        .toBe(generationsBeforeImage + 1);
      await expect(
        page.getByRole("button", { name: "Send message", exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
      const imageRequest = requests.at(-1).body;
      expect(imageRequest.max_tokens).toBeDefined();
      const imageMessage = imageRequest.messages.find((message) => message.role === "user");
      expect(Array.isArray(imageMessage.content)).toBe(true);
      expect(imageMessage.content[0]).toEqual({ type: "text", text: "What is in this picture?" });
      expect(imageMessage.content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: seededPng } });
      expect(JSON.stringify(imageRequest)).not.toContain(seededImage.attachmentId);
      const imageGeneration = (await records(page, "generations")).items.sort((a, b) => b.createdAt - a.createdAt)[0];
      expect(imageGeneration.status).toBe("complete");
      expect(JSON.stringify(imageGeneration.parameters)).not.toContain(seededPng.slice(0, 20));
      evidence.checks.push(
        "a verified PNG attachment on a user message is sent as a provider image block with its exact bytes, and the recorded attempt keeps parameters without image data",
      );
      evidence.aliasApplicationAccessibility = await exerciseAliasApplicationAccessibility({ page, name });
      evidence.checks.push("long saved alias names fit the application selector and reviewed profile at 320px normal/enlarged text, with an exact visible accessible label and keyboard cancellation preserving registry, canonical state and provider silence");
      // A reusable alias is local configuration; applying the exact reviewed
      // snapshot creates a canonical profile and atomic sync operation.
      const imageThread = (await records(page, "threadStates")).items.find(value => value.title === "Image thread");
      await page.getByLabel("Message", { exact: true }).fill("Alias review keeps this draft");
      const aliasRequestCount = requests.length;
      await page.getByRole("button", { name: "Preferences", exact: true }).click();
      await page.getByRole("button", { name: "New routing alias", exact: true }).click();
      const aliasEditor = page.getByRole("form", { name: "Routing alias editor" });
      const anthropicTarget = JSON.stringify(["anthropic", "claude-haiku-4-5-20251001"]);
      const openaiTarget = JSON.stringify(["openai", "gpt-4.1-mini-2025-04-14"]);
      await aliasEditor.getByLabel("Alias name", { exact: true }).fill("Coding");
      await aliasEditor.getByLabel("Alias primary", { exact: true }).selectOption(anthropicTarget);
      await aliasEditor.getByLabel("Alias fallback candidate", { exact: true }).selectOption(openaiTarget);
      await aliasEditor.getByRole("button", { name: "Add alias fallback", exact: true }).click();
      await aliasEditor.getByLabel("Alias minimum context", { exact: true }).fill("500000");
      await aliasEditor.getByRole("checkbox", { name: "Require alias image input", exact: true }).check();
      await page.evaluate(() => window.appAcceptance.loseAliasReply());
      await keyboardActivate(aliasEditor.getByRole("button", { name: "Save routing alias", exact: true }));
      await expect(page.getByRole("alert")).toContainText("Synthetic lost alias reply after durable write");
      await expect(page.getByRole("heading", { name: "Routing aliases", exact: true })).toBeFocused();
      await page.getByRole("button", { name: "Reload aliases", exact: true }).click();
      await expect(page.getByRole("article", { name: "Alias Coding", exact: true })).toBeVisible();
      await keyboardActivate(aliasEditor.getByRole("button", { name: "Cancel alias edit", exact: true }));
      await expect(page.getByRole("heading", { name: "Routing aliases", exact: true })).toBeFocused();
      const initialAliases = await page.evaluate(() => window.appAcceptance.aliases());
      expect(initialAliases.aliases).toHaveLength(1);
      const aliasId = initialAliases.aliases[0].id;
      // An existing target whose connection disappeared remains editable and
      // can be reordered. It is never silently resolved to another provider.
      const withMissing = { ...initialAliases.aliases[0], candidates: [...initialAliases.aliases[0].candidates, { provider: "unavailable-connection", model: "old-model" }] };
      await page.evaluate(({ revision, alias }) => window.appAcceptance.putAlias(revision, alias), { revision: initialAliases.revision, alias: withMissing });
      const staleAlias = await page.evaluate(async ({ revision, alias }) => {
        try { await window.appAcceptance.putAlias(revision, alias); return null; } catch (error) { return String(error); }
      }, { revision: initialAliases.revision, alias: initialAliases.aliases[0] });
      expect(staleAlias).toContain("changed in another view");
      await page.getByRole("button", { name: "Reload aliases", exact: true }).click();
      await page.getByRole("button", { name: "Edit Coding", exact: true }).click();
      await keyboardActivate(aliasEditor.getByRole("button", { name: "Move fallback 2 up", exact: true }));
      await expect(page.getByRole("heading", { name: "Routing aliases", exact: true })).toBeFocused();
      await captureReviewLayout({ page, regionName: "Routing alias editor", role: "form", name, caseName: "alias-populated", requireBorders: true });
      await expect(aliasEditor.getByRole("list", { name: "Edit alias fallback order" }).getByRole("listitem").first()).toContainText("unavailable-connection · old-model (not configured)");
      await keyboardActivate(aliasEditor.getByRole("button", { name: "Save routing alias", exact: true }));
      await expect(aliasEditor).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Routing aliases", exact: true })).toBeFocused();
      const savedAliasRegistry = await page.evaluate(() => window.appAcceptance.aliases());
      const savedAlias = savedAliasRegistry.aliases[0];
      await page.getByRole("region", { name: "Routing aliases", exact: true }).screenshot({ path: `test-results/aliases-${name}.png` });
      await page.getByRole("button", { name: "Library", exact: true }).click();
      await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Alias review keeps this draft");
      const application = page.getByRole("region", { name: "Apply routing alias", exact: true });
      await application.getByLabel("Routing alias", { exact: true }).selectOption(aliasId);
      await expect(application).toContainText("context at least 500,000 tokens");
      await expect(application).toContainText("Fallback must keep the primary’s privacy class");
      await expect(application.getByRole("button", { name: "Apply alias to conversation", exact: true })).toBeDisabled();
      const beforeAliasCancel = (await records(page, "threadStates")).items.find(value => value.threadId === imageThread.threadId);
      await keyboardActivate(application.getByRole("button", { name: "Cancel alias application", exact: true }));
      await expect(application.getByRole("heading", { name: "Apply routing alias", exact: true })).toBeFocused();
      expect((await records(page, "threadStates")).items.find(value => value.threadId === imageThread.threadId)).toEqual(beforeAliasCancel);
      await application.getByLabel("Routing alias", { exact: true }).selectOption(aliasId);
      const syncBeforeAlias = (await page.evaluate(() => window.appAcceptance.sync())).highWaterSequence;
      await application.getByRole("checkbox", { name: "I reviewed this alias profile", exact: true }).check();
      await keyboardActivate(application.getByRole("button", { name: "Apply alias to conversation", exact: true }));
      await expect(application.getByRole("heading", { name: "Apply routing alias", exact: true })).toBeFocused();
      const readAppliedProfile = async () => (await records(page, "threadStates")).items.find(value => value.threadId === imageThread.threadId).routingProfile;
      let aliasProfile = { version: 3, alias: savedAlias.name, primary: savedAlias.primary, candidates: savedAlias.candidates, requirements: savedAlias.requirements, allowPrivacyChange: savedAlias.allowPrivacyChange, aliasSource: { id: aliasId, revision: savedAliasRegistry.revision } };
      await expect.poll(readAppliedProfile).toEqual(aliasProfile);
      const aliasSync = await page.evaluate(after => window.appAcceptance.sync(after), syncBeforeAlias);
      expect(aliasSync.items).toHaveLength(1);
      expect(aliasSync.items[0]).toMatchObject({ kind: "SetRoutingProfile", payload: { threadId: imageThread.threadId, value: aliasProfile } });
      expect(requests.length).toBe(aliasRequestCount);
      await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Alias review keeps this draft");
      await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
      await expect(page.locator(".route-plan")).toContainText("unavailable-connection · old-model: skipped — not configured on this device.");
      await send(page, "Use the reviewed alias route");
      await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
      expect(requests.at(-1).anthropic).toBe(false);
      expect(requests.at(-1).body.messages.at(-1).content).toBe("Use the reviewed alias route");
      const disconnected = { ...savedAlias, id: randomUUID(), name: "Disconnected", primary: { provider: "missing-primary", model: "retired-model" }, candidates: [{ provider: "openai", model: "gpt-4.1-mini-2025-04-14" }], requirements: {} };
      const withDisconnected = await page.evaluate(({ revision, alias }) => window.appAcceptance.putAlias(revision, alias), { revision: savedAliasRegistry.revision, alias: disconnected });
      await page.getByRole("button", { name: "Preferences", exact: true }).click();
      await page.getByRole("button", { name: "Library", exact: true }).click();
      await application.getByLabel("Routing alias", { exact: true }).selectOption(disconnected.id);
      await application.getByRole("checkbox", { name: "I reviewed this alias profile", exact: true }).check();
      const beforeMissingPrimary = requests.length;
      await keyboardActivate(application.getByRole("button", { name: "Apply alias to conversation", exact: true }));
      await expect(application.getByRole("heading", { name: "Apply routing alias", exact: true })).toBeFocused();
      await expect(page.getByText(/Saved primary missing-primary · retired-model is not configured/)).toBeVisible();
      await expect(page.getByLabel("Provider", { exact: true })).toHaveValue("");
      await page.getByLabel("Message", { exact: true }).fill("Do not send through an implicit replacement");
      await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
      await page.getByLabel("Message", { exact: true }).press("Control+Enter");
      expect(requests.length).toBe(beforeMissingPrimary);
      await page.getByLabel("Provider", { exact: true }).selectOption("openai");
      await expect.poll(async () => (await readAppliedProfile()).primary).toEqual({ provider: "openai", model: "gpt-4.1-mini-2025-04-14" });
      expect((await readAppliedProfile()).aliasSource).toBeUndefined();
      // Deliberately reapply the original saved profile; this is a new
      // reviewed copy, attributed to the registry revision now displayed.
      await application.getByLabel("Routing alias", { exact: true }).selectOption(aliasId);
      await application.getByRole("checkbox", { name: "I reviewed this alias profile", exact: true }).check();
      await keyboardActivate(application.getByRole("button", { name: "Apply alias to conversation", exact: true }));
      await expect(application.getByRole("heading", { name: "Apply routing alias", exact: true })).toBeFocused();
      aliasProfile = { ...aliasProfile, aliasSource: { id: aliasId, revision: withDisconnected.revision } };
      await expect.poll(readAppliedProfile).toEqual(aliasProfile);
      await page.getByLabel("Message", { exact: true }).fill("");
      // Edits and deletion affect only the reusable registry.
      await page.getByRole("button", { name: "Preferences", exact: true }).click();
      await page.getByRole("button", { name: "Edit Coding", exact: true }).click();
      await aliasEditor.getByLabel("Alias name", { exact: true }).fill("Fast");
      await aliasEditor.getByRole("button", { name: "Remove fallback 2", exact: true }).click();
      await aliasEditor.getByLabel("Alias primary", { exact: true }).selectOption(openaiTarget);
      await keyboardActivate(aliasEditor.getByRole("button", { name: "Save routing alias", exact: true }));
      await expect(page.getByRole("article", { name: "Alias Fast", exact: true })).toBeVisible();
      expect(await readAppliedProfile()).toEqual(aliasProfile);
      await page.getByRole("button", { name: "Delete Fast", exact: true }).click();
      await page.getByRole("button", { name: "Confirm delete Fast", exact: true }).click();
      await expect(page.getByRole("article", { name: "Alias Fast", exact: true })).toHaveCount(0);
      expect(await readAppliedProfile()).toEqual(aliasProfile);
      await page.getByRole("button", { name: "Delete Disconnected", exact: true }).click();
      await page.getByRole("button", { name: "Confirm delete Disconnected", exact: true }).click();
      await expect(page.getByRole("article", { name: "Alias Disconnected", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "New routing alias", exact: true }).click();
      await aliasEditor.getByLabel("Alias name", { exact: true }).fill("Private");
      await aliasEditor.getByLabel("Alias primary", { exact: true }).selectOption(anthropicTarget);
      await keyboardActivate(aliasEditor.getByRole("button", { name: "Save routing alias", exact: true }));
      await expect(aliasEditor).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Routing aliases", exact: true })).toBeFocused();
      evidence.aliasProfile = aliasProfile;
      evidence.checks.push("routing aliases create/edit/delete in Preferences, preserve and reorder an unavailable target, recover a lost durable-save reply and refuse stale edits; applying an explicitly reviewed immutable snapshot preserves the draft, commits the primary/fallbacks/constraints with one atomic canonical sync operation, requires a fresh provider-switch review and sends through the chosen route; later alias edits/deletion never change the conversation, and registry/profile/missing-primary behavior survive a browser-process restart");
      await page.getByRole("button", { name: "Library", exact: true }).click();
      const originalImageParts = (await records(page, "parts")).items.filter(part => part.messageId === seededImage.messageId);
      const imagePart = (await records(page, "parts")).items.find(part => part.kind === "Image" && part.data.attachmentId === seededImage.attachmentId);
      const readImageState = async () => (await records(page, "threadStates")).items.find(value => value.threadId === imageThread.threadId);
      const originalContextId = (await readImageState()).contextSnapshotId;
      const contextReview = page.getByRole("region", { name: "Review attachment exclusions", exact: true });
      await page.getByRole("button", { name: "Review attachment exclusions", exact: true }).click();
      await expect(contextReview.getByRole("button", { name: "Apply attachment exclusions", exact: true })).toBeDisabled();
      await contextReview.getByRole("checkbox").first().check();
      await keyboardActivate(contextReview.getByRole("button", { name: "Cancel attachment review", exact: true }));
      await expect(page.getByRole("heading", { name: "Attachment exclusions", exact: true })).toBeFocused();
      expect((await readImageState()).contextSnapshotId).toBe(originalContextId);
      await page.getByRole("button", { name: "Review attachment exclusions", exact: true }).click();
      await contextReview.getByRole("checkbox").first().check();
      await contextReview.getByRole("checkbox", { name: "I reviewed these attachment exclusions", exact: true }).check();
      await captureReviewLayout({ page, regionName: "Review attachment exclusions", name, caseName: "attachment-review" });
      await contextReview.screenshot({ path: `test-results/compaction-${name}-review.png` });
      await keyboardActivate(contextReview.getByRole("button", { name: "Apply attachment exclusions", exact: true }));
      await expect(contextReview).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Attachment exclusions", exact: true })).toBeFocused();
      await expect(page.getByRole("region", { name: "Request context", exact: true })).toContainText("1 attachment occurrence(s) excluded");
      const exclusionContextId = (await readImageState()).contextSnapshotId;
      const exclusionContext = (await records(page, "contexts")).items.find(value => value.id === exclusionContextId);
      expect(exclusionContext).toMatchObject({ previousId: originalContextId, compaction: { version: 1, excludedPartIds: [imagePart.id] } });
      expect((await records(page, "events")).items.find(event => event.type === "ContextCompaction" && event.details.contextSnapshotId === exclusionContextId)).toMatchObject({ details: { action: "exclude_attachments", excludedPartIds: [imagePart.id] } });
      const marker = "[Attachment omitted by your context choice.]";
      await page.getByLabel("Message", { exact: true }).fill("Continue with the reviewed context");
      await page.getByRole("button", { name: "Count prompt tokens", exact: true }).click();
      await expect.poll(() => JSON.stringify(countRequests.at(-1).body)).toContain(marker);
      expect(JSON.stringify(countRequests.at(-1).body)).not.toContain(seededImage.attachmentId);
      expect(JSON.stringify(countRequests.at(-1).body)).not.toContain(seededPng);
      await send(page, "Continue with the reviewed context");
      await expect.poll(() => JSON.stringify(requests.at(-1).body)).toContain(marker);
      await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
      expect(JSON.stringify(requests.at(-1).body)).not.toContain('"type":"image_url"');
      expect(JSON.stringify(requests.at(-1).body)).not.toContain(seededPng);
      expect((await records(page, "parts")).items.filter(part => part.messageId === seededImage.messageId)).toEqual(originalImageParts);
      // Clearing creates a new snapshot, and reapplying preserves the first one.
      await page.getByRole("button", { name: "Review attachment exclusions", exact: true }).click();
      await contextReview.getByRole("checkbox").first().uncheck();
      await contextReview.getByRole("checkbox", { name: "I reviewed these attachment exclusions", exact: true }).check();
      await keyboardActivate(contextReview.getByRole("button", { name: "Apply attachment exclusions", exact: true }));
      await expect(contextReview).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Attachment exclusions", exact: true })).toBeFocused();
      await expect(page.getByRole("region", { name: "Request context", exact: true })).toContainText("0 attachment occurrence(s) excluded");
      expect((await records(page, "contexts")).items.find(value => value.id === exclusionContextId)).toEqual(exclusionContext);
      await page.getByRole("button", { name: "Review attachment exclusions", exact: true }).click();
      await contextReview.getByRole("checkbox").first().check();
      await contextReview.getByRole("checkbox", { name: "I reviewed these attachment exclusions", exact: true }).check();
      await keyboardActivate(contextReview.getByRole("button", { name: "Apply attachment exclusions", exact: true }));
      await expect(contextReview).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Attachment exclusions", exact: true })).toBeFocused();
      await expect(page.getByRole("region", { name: "Request context", exact: true })).toContainText("1 attachment occurrence(s) excluded");
      const beforeCompactionRegenerate = (await records(page, "generations")).items.length;
      await page.getByRole("button", { name: /^Generate another response — / }).first().click();
      await expect.poll(async () => (await records(page, "generations")).items.length).toBe(beforeCompactionRegenerate + 1);
      await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
      expect(JSON.stringify(requests.at(-1).body)).toContain(marker);
      expect(JSON.stringify(requests.at(-1).body)).not.toContain(seededPng);
      expect(JSON.stringify(requests.at(-1).body)).not.toContain("seeded PNG");
      expect((await records(page, "parts")).items.filter(part => part.messageId === seededImage.messageId)).toEqual(originalImageParts);
      evidence.exclusionPartId = imagePart.id;
      evidence.checks.push("reviewed attachment exclusions cancel without a write, commit immutable context and event, replace a verified PNG with the identical marker in token counting, sending and regeneration, retain original parts, clear and reapply without rewriting snapshots, and survive process restart");
      {
      // Use a separate conversation so the preceding alias qualification keeps
      // its intentionally restrictive 500,000-token routing snapshot unchanged.
      const seededImage = await page.evaluate(png => window.appAcceptance.seedImageThread(png, "Summary notebook"), seededPng);
      await page.getByRole("button", { name: "Refresh library", exact: true }).click();
      await page.getByRole("button", { name: "Summary notebook", exact: true }).click();
      const imageThread = (await records(page, "threadStates")).items.find(value => value.title === "Summary notebook");
      const readImageState = async () => (await records(page, "threadStates")).items.find(value => value.threadId === imageThread.threadId);
      const imagePart = (await records(page, "parts")).items.find(value => value.kind === "Image" && value.data.attachmentId === seededImage.attachmentId);
      await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
      await page.getByLabel("Fallback candidate", { exact: true }).selectOption("openai:gpt-4.1-mini-2025-04-14");
      await page.getByRole("button", { name: "Add candidate", exact: true }).click();
      await expect(page.getByRole("list", { name: "Fallback candidates", exact: true })).toContainText("OpenAI");
      await page.getByRole("button", { name: "Review attachment exclusions", exact: true }).click();
      await contextReview.getByRole("checkbox").first().check();
      await contextReview.getByRole("checkbox", { name: "I reviewed these attachment exclusions", exact: true }).check();
      await keyboardActivate(contextReview.getByRole("button", { name: "Apply attachment exclusions", exact: true }));
      await expect(contextReview).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Attachment exclusions", exact: true })).toBeFocused();
      await expect(page.getByRole("region", { name: "Request context", exact: true })).toContainText("1 attachment occurrence(s) excluded");
      // A summary is a separate saved attempt; its reviewed text alone becomes
      // effective prefix context. All requests below stay on the loopback fixture.
      const excludedFallbackBefore = requests.length;
      nextResponse = { status: 503, body: { error: { type: "overloaded_error", message: "Synthetic excluded-attachment fallback" } } };
      await send(page, "Retain this user turn after the summary boundary");
      await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
      await expect.poll(() => requests.length).toBe(excludedFallbackBefore + 2);
      for (const request of requests.slice(excludedFallbackBefore)) {
        expect(JSON.stringify(request.body)).toContain(marker);
        expect(JSON.stringify(request.body)).not.toContain(seededPng);
        expect(JSON.stringify(request.body)).not.toContain("seeded PNG");
      }
      const summaryPanel = page.getByRole("region", { name: "Conversation summary", exact: true });
      await keyboardActivate(summaryPanel.getByRole("button", { name: "Review conversation summaries", exact: true }));
      await expect(summaryPanel.getByRole("button", { name: "Prepare summary request", exact: true })).toBeEnabled();
      const sourceState = await readImageState();
      const sourceParts = (await records(page, "parts")).items;
      const sourceMessages = (await records(page, "messages")).items;
      const summaryCutoff = await summaryPanel.getByLabel("Summarize through message", { exact: true }).inputValue();
      await expect(summaryPanel.getByLabel("Summarize through message", { exact: true })).toHaveAccessibleName("Summarize through message");
      await captureReviewLayout({ page, regionName: "Conversation summary", name, caseName: "summary-review", requireBorders: true });
      await keyboardActivate(summaryPanel.getByRole("button", { name: "Prepare summary request", exact: true }));
      const requestReview = summaryPanel.getByRole("region", { name: "Review summary request", exact: true });
      await expect(requestReview.getByRole("button", { name: "Generate summary proposal", exact: true })).toBeDisabled();
      await requestReview.getByRole("checkbox", { name: "I reviewed this summary request and its destination", exact: true }).check();
      await keyboardActivate(requestReview.getByRole("button", { name: "Count summary input", exact: true }));
      await expect(requestReview.locator(".summary-count-status")).toContainText("input tokens;");
      await expect(requestReview.locator(".summary-count-status")).toHaveAttribute("role", "status");
      await expect(requestReview.locator(".summary-count-status")).toHaveAttribute("aria-atomic", "true");
      await expect(requestReview.getByRole("button", { name: "Count summary input", exact: true })).toBeFocused();
      const frozenPreparedBody = await requestReview.locator("pre").textContent();
      const generationCount = (await records(page, "generations")).items.length;
      await keyboardActivate(requestReview.getByRole("button", { name: "Generate summary proposal", exact: true }));
      const proposalReview = summaryPanel.getByRole("region", { name: "Review proposed summary", exact: true });
      await expect(proposalReview.getByLabel("Reviewed summary", { exact: true })).toBeEnabled({ timeout: 15000 });
      await expect(summaryPanel.getByText(/Proposal saved/)).toBeVisible();
      const proposal = (await records(page, "summaryProposals")).items.at(-1);
      const proposalGeneration = (await records(page, "generations")).items.find(value => value.id === proposal.generationId);
      expect(proposalGeneration).toMatchObject({ purpose: "context_summary", status: "complete", tokensIn: 12, tokensOut: 20 });
      expect((await records(page, "generations")).items.length).toBe(generationCount + 1);
      expect(await readImageState()).toEqual(sourceState);
      expect(proposal).toMatchObject({ sourceContextSnapshotId: sourceState.contextSnapshotId, throughMessageId: summaryCutoff, sourceLeafMessageId: sourceState.activeLeafMessageId, sourceThreadRevision: sourceState.revision });
      expect(JSON.stringify(requests.at(-1).body)).toBe(frozenPreparedBody);
      expect(proposal.inputSha256).toBe(createHash("sha256").update(frozenPreparedBody).digest("hex"));
      expect(frozenPreparedBody).toContain(marker);
      expect(frozenPreparedBody).not.toContain(seededPng);
      expect(frozenPreparedBody).not.toContain("seeded PNG");
      await proposalReview.getByRole("button", { name: "Inspect saved summary input", exact: true }).click();
      await expect(proposalReview.locator("pre")).toHaveText(frozenPreparedBody);
      await expect(proposalReview.getByRole("button", { name: "Apply reviewed summary", exact: true })).toBeDisabled();
      const reviewedSummary = `Reviewed synthetic summary: preserve the picture question and its unresolved details. Source ${seededImage.messageId}.`;
      await proposalReview.getByLabel("Reviewed summary", { exact: true }).fill(reviewedSummary);
      await proposalReview.getByRole("checkbox", { name: "I checked this summary against the source messages and want to use it", exact: true }).check();
      await proposalReview.screenshot({ path: `test-results/summary-${name}-review.png` });
      await page.evaluate(() => window.appAcceptance.loseSummaryReply());
      await proposalReview.getByRole("button", { name: "Apply reviewed summary", exact: true }).click();
      evidence.pendingRecovery = await exercisePendingRecovery({ page, name, originTitle: "Summary notebook", otherTitle: "Comet notebook" });
      evidence.checks.push("unknown-outcome recovery survives dismissed errors, conversation navigation and lexical search; a failed check stays recoverable, and a held exact replay preserves newer navigation without duplicate canonical writes or provider traffic");
      const workspaceRecovery = page.getByRole("heading", { name: "Workspace status", exact: true });
      await expect(summaryPanel).toContainText("A reviewed summary replaces conversation context");
      // A known refusal has no pending mutation and can be dismissed safely.
      const beforeRefusal = await page.evaluate(() => window.appAcceptance.sync());
      const titleForRefusal = page.getByLabel("Title", { exact: true });
      if (!await titleForRefusal.isVisible()) await page.getByText("Conversation settings", { exact: true }).click();
      await expect(titleForRefusal).toBeVisible();
      const titleBeforeRefusal = await titleForRefusal.inputValue();
      await titleForRefusal.fill("Refused accessibility rename");
      await page.evaluate(() => window.appAcceptance.rejectNextCommit());
      await keyboardActivate(page.getByRole("button", { name: "Rename", exact: true }));
      await expect(page.getByRole("region", { name: "Workspace status", exact: true })).toContainText("Synthetic storage quota refusal before commit");
      await expect(page.getByRole("button", { name: "Check pending change", exact: true })).toHaveCount(0);
      await keyboardActivate(page.getByRole("region", { name: "Workspace status", exact: true }).getByRole("button", { name: "Dismiss", exact: true }));
      await expect(workspaceRecovery).toBeFocused();
      await expect(workspaceRecovery).toBeVisible();
      evidence.workspaceRecovery = await workspaceRecovery.evaluate(node => ({ label: node.textContent, focused: document.activeElement === node, outlineStyle: getComputedStyle(node).outlineStyle, outlineWidth: getComputedStyle(node).outlineWidth, clipPath: getComputedStyle(node).clipPath }));
      expect(evidence.workspaceRecovery.outlineStyle).toBe("solid");
      expect(evidence.workspaceRecovery.outlineWidth).toBe("3px");
      expect(evidence.workspaceRecovery.clipPath).toBe("none");
      await page.screenshot({ path: `test-results/workspace-recovery-${name}.png` });

      await expect(page.getByRole("heading", { name: titleBeforeRefusal, exact: true })).toBeVisible();
      expect(await page.evaluate(() => window.appAcceptance.sync())).toEqual(beforeRefusal);
      await titleForRefusal.fill(titleBeforeRefusal);


      await expect(page.getByRole("button", { name: "Check pending change", exact: true })).toHaveCount(0);
      await expect(summaryPanel).toContainText("A reviewed summary replaces conversation context");
      const appliedSummaryState = await readImageState();
      const appliedSummaryContext = (await records(page, "contexts")).items.find(value => value.id === appliedSummaryState.contextSnapshotId);
      expect(appliedSummaryContext.compaction).toEqual({ version: 2, excludedPartIds: [imagePart.id], summary: { proposalId: proposal.id, throughMessageId: summaryCutoff, reviewedText: reviewedSummary, reviewedTextSha256: createHash("sha256").update(reviewedSummary).digest("hex") } });
      expect((await records(page, "events")).items.filter(value => value.details.action === "apply_summary" && value.details.contextSnapshotId === appliedSummaryContext.id)).toHaveLength(1);
      expect((await records(page, "parts")).items.filter(value => sourceParts.some(original => original.id === value.id))).toEqual(sourceParts);
      expect((await records(page, "messages")).items.filter(value => sourceMessages.some(original => original.id === value.id))).toEqual(sourceMessages);
      const summaryMarker = "[User-reviewed summary of older conversation; source history is retained.]";
      await page.getByLabel("Message", { exact: true }).fill("Continue after reviewed summary");
      await page.getByRole("button", { name: "Count prompt tokens", exact: true }).click();
      await expect.poll(() => JSON.stringify(countRequests.at(-1).body)).toContain(summaryMarker);
      expect(JSON.stringify(countRequests.at(-1).body)).toContain(reviewedSummary);
      expect(JSON.stringify(countRequests.at(-1).body)).not.toContain(marker);
      const summaryRequestsBefore = requests.length;
      nextResponse = { status: 503, body: { error: { type: "overloaded_error", message: "Synthetic summary continuation fallback" } } };
      await send(page, "Continue after reviewed summary");
      await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
      await expect.poll(() => requests.length).toBe(summaryRequestsBefore + 2);
      for (const request of requests.slice(summaryRequestsBefore)) {
        expect(JSON.stringify(request.body)).toContain(summaryMarker);
        expect(JSON.stringify(request.body)).toContain(reviewedSummary);
        expect(JSON.stringify(request.body)).not.toContain(marker);
        expect(JSON.stringify(request.body)).not.toContain(seededPng);
      }
      await expect(page.getByText(/^Prompt: .* counted by/)).toHaveCount(0);
      const summarySwitchReview = page.getByRole("checkbox", { name: /I reviewed this switch/ });
      if (await summarySwitchReview.count()) await summarySwitchReview.check();
      await page.getByRole("button", { name: /^Generate another response — / }).last().click();
      await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
      expect(JSON.stringify(requests.at(-1).body)).toContain(summaryMarker);
      expect(JSON.stringify(requests.at(-1).body)).not.toContain(marker);
      // Exclusion edits keep the applied summary policy.
      await page.getByRole("button", { name: "Review attachment exclusions", exact: true }).click();
      await contextReview.getByRole("checkbox", { name: "I reviewed these attachment exclusions", exact: true }).check();
      await keyboardActivate(contextReview.getByRole("button", { name: "Apply attachment exclusions", exact: true }));
      await expect(contextReview).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Attachment exclusions", exact: true })).toBeFocused();
      await expect(summaryPanel).toContainText("A reviewed summary replaces conversation context");
      // A second proposal includes the previous reviewed text and only new prefix evidence.
      await keyboardActivate(summaryPanel.getByRole("button", { name: "Review conversation summaries", exact: true }));
      await keyboardActivate(summaryPanel.getByRole("button", { name: "Prepare summary request", exact: true }));
      await expect(requestReview).toContainText("previous_reviewed_summary");
      expect(await requestReview.locator("pre").textContent()).toContain(reviewedSummary);
      expect(await requestReview.locator("pre").textContent()).not.toContain(marker);
      await requestReview.getByRole("checkbox", { name: "I reviewed this summary request and its destination", exact: true }).check();
      holdNext = true;
      await keyboardActivate(requestReview.getByRole("button", { name: "Generate summary proposal", exact: true }));
      await expect.poll(async () => (await records(page, "summaryProposals")).items.length).toBe(2);
      await summaryPanel.getByRole("button", { name: "Stop summary", exact: true }).click();
      await expect(summaryPanel.getByRole("button", { name: "Close summary review", exact: true })).toBeVisible();
      await keyboardActivate(summaryPanel.getByRole("button", { name: "Review conversation summaries", exact: true }));
      const stoppedProposal = (await records(page, "summaryProposals")).items.find(value => value.id !== proposal.id);
      await summaryPanel.getByRole("button", { name: new RegExp(`Inspect proposal ${stoppedProposal.id.slice(0, 8)}`) }).click();
      await expect(proposalReview).toContainText("cannot be applied");
      await expect(proposalReview.getByRole("button", { name: "Apply reviewed summary", exact: true })).toBeDisabled();
      const afterStoppedState = await readImageState();
      expect((await records(page, "contexts")).items.find(value => value.id === afterStoppedState.contextSnapshotId).compaction.summary).toEqual(appliedSummaryContext.compaction.summary);
      evidence.summary = { threadId: imageThread.threadId, exclusionPartId: imagePart.id, proposalId: proposal.id, stoppedProposalId: stoppedProposal.id, inputSha256: proposal.inputSha256, reviewedText: reviewedSummary, cutoff: summaryCutoff };
      evidence.checks.push("summary proposal request matches frozen verified body, excludes reviewed attachments, records separate generation usage without selecting its output, requires request/text review, saves edited text and audit atomically despite lost reply, leaves source history unchanged, and sends the same reviewed prefix through count/send/regenerate/fallback; attachment-exclusion markers also agree in a separate failed-primary/fallback pair before applying the summary; repeated proposal includes prior summary and cancellation retains an ineligible proposal");
      await keyboardActivate(summaryPanel.getByRole("button", { name: "Close summary review", exact: true }));
      await expect(summaryPanel.getByRole("heading", { name: "Conversation summary", exact: true })).toBeFocused();
      }
      {
        const seed = await page.evaluate(png => window.appAcceptance.seedImageThread(png, "Branch notebook"), seededPng);
        await page.getByRole("button", { name: "Refresh library", exact: true }).click();
        await page.getByRole("button", { name: "Branch notebook", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Branch notebook", exact: true })).toBeVisible();
        await page.getByText("Conversation settings", { exact: true }).click();
        const readState = async () => (await records(page, "threadStates")).items.find(value => value.threadId === seed.threadId);
        await page.getByLabel("System prompt", { exact: true }).fill("Retain exact branch instruction B-17.");
        await page.getByRole("button", { name: "Save system prompt", exact: true }).click();
        await expect.poll(async () => JSON.stringify((await records(page, "contexts")).items)).toContain("Retain exact branch instruction B-17.");
        await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
        await page.getByLabel("Fallback candidate", { exact: true }).selectOption("openai:gpt-4.1-mini-2025-04-14");
        await page.getByRole("button", { name: "Add candidate", exact: true }).click();
        await expect(page.getByRole("list", { name: "Fallback candidates", exact: true })).toContainText("OpenAI");
        await page.getByRole("button", { name: "Review attachment exclusions", exact: true }).click();
        await contextReview.getByRole("checkbox").first().check();
        await contextReview.getByRole("checkbox", { name: "I reviewed these attachment exclusions", exact: true }).check();
        await keyboardActivate(contextReview.getByRole("button", { name: "Apply attachment exclusions", exact: true }));
      await expect(contextReview).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Attachment exclusions", exact: true })).toBeFocused();
        await expect(page.getByRole("region", { name: "Request context", exact: true })).toContainText("1 attachment occurrence(s) excluded");
        await send(page, "Earlier branch-only question B-OLD.");
        await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
        const panel = page.getByRole("region", { name: "Conversation summary", exact: true });
        await panel.getByRole("button", { name: "Review conversation summaries", exact: true }).click();
        await panel.getByRole("button", { name: "Prepare summary request", exact: true }).click();
        await panel.getByRole("checkbox", { name: "I reviewed this summary request and its destination", exact: true }).check();
        await panel.getByRole("button", { name: "Generate summary proposal", exact: true }).click();
        await expect(panel.getByLabel("Reviewed summary", { exact: true })).toBeEnabled({ timeout: 15000 });
        await panel.getByLabel("Reviewed summary", { exact: true }).fill("Old applied summary B-SUMMARY.");
        await panel.getByRole("checkbox", { name: "I checked this summary against the source messages and want to use it", exact: true }).check();
        await panel.getByRole("button", { name: "Apply reviewed summary", exact: true }).click();
        await expect(panel).toContainText("A reviewed summary replaces conversation context");
        // A changed canonical scope must discard review consent without
        // remounting its focus boundary. The first rename is dispatched without
        // moving focus, like a view update arriving from another control/client.
        const staleReview = page.getByRole("region", { name: "Review fresh branch", exact: true });
        await keyboardActivate(page.getByRole("button", { name: "Review fresh branch", exact: true }));
        await page.getByLabel("Title", { exact: true }).fill("Branch notebook reviewed");
        await staleReview.getByRole("checkbox").focus();
        await staleReview.getByRole("checkbox").press("Space");
        await expect(staleReview.getByRole("checkbox")).toBeChecked();
        await page.getByRole("button", { name: "Rename", exact: true }).evaluate(button => button.click());
        await expect(page.getByRole("heading", { name: "Branch notebook reviewed", exact: true })).toBeVisible();
        await expect(staleReview).toHaveCount(0);
        await expect(page.getByRole("heading", { name: "Fresh context branch", exact: true })).toBeFocused();
        await keyboardActivate(page.getByRole("button", { name: "Review fresh branch", exact: true }));
        await expect(staleReview.getByRole("checkbox")).not.toBeChecked();
        // User movement wins when another changed scope arrives.
        await page.getByLabel("Title", { exact: true }).fill("Branch notebook");
        await page.getByRole("button", { name: "Rename", exact: true }).evaluate(button => button.click());
        await expect(page.getByRole("heading", { name: "Branch notebook", exact: true })).toBeVisible();
        await expect(staleReview).toHaveCount(0);
        await expect(page.getByLabel("Title", { exact: true })).toBeFocused();
        const sourceState = await readState();
        const sourceContext = (await records(page, "contexts")).items.find(value => value.id === sourceState.contextSnapshotId);
        const oldMessages = (await records(page, "messages")).items.filter(value => value.threadId === seed.threadId);
        const oldParts = (await records(page, "parts")).items.filter(value => oldMessages.some(message => message.id === value.messageId));
        const oldEvents = (await records(page, "events")).items.length;
        const oldContextCount = (await records(page, "contexts")).items.length;
        const beforeHttp = requests.length, beforeCounts = countRequests.length;
        await page.getByLabel("Message", { exact: true }).fill("New branch draft B-NEW.");
        const chooser = page.waitForEvent("filechooser");
        await page.getByRole("button", { name: "Attach files", exact: true }).click();
        await (await chooser).setFiles([{ name: "branch-draft.png", mimeType: "image/png", buffer: Buffer.from(seededPng, "base64") }]);
        await expect(page.getByRole("img", { name: "branch-draft.png", exact: true })).toBeVisible();
        const review = page.getByRole("region", { name: "Review fresh branch", exact: true });
        await page.getByRole("button", { name: "Review fresh branch", exact: true }).click();
        await expect(review.getByRole("button", { name: "Start fresh branch", exact: true })).toBeDisabled();
        await keyboardActivate(review.getByRole("button", { name: "Cancel branch review", exact: true }));
        await expect(page.getByRole("heading", { name: "Fresh context branch", exact: true })).toBeFocused();
        expect(await readState()).toEqual(sourceState);
        expect((await records(page, "events")).items.length).toBe(oldEvents);
        expect((await records(page, "contexts")).items.length).toBe(oldContextCount);
        await page.getByRole("button", { name: "Review fresh branch", exact: true }).click();
        await review.getByRole("checkbox").check();
        await captureReviewLayout({ page, regionName: "Review fresh branch", name, caseName: "fresh-branch-review" });
        await review.screenshot({ path: `test-results/branch-${name}-review.png` });
        await page.evaluate(() => window.appAcceptance.loseBranchReply());
        await keyboardActivate(review.getByRole("button", { name: "Start fresh branch", exact: true }));
        await expect(page.getByRole("heading", { name: "Fresh context branch", exact: true })).toBeFocused();
        await expect(page.getByRole("button", { name: "Count prompt tokens", exact: true })).toBeDisabled();
        await expect(page.getByRole("button", { name: "Check pending change", exact: true })).toBeVisible();
        await page.evaluate(() => window.appAcceptance.holdCommitReply());
        try {
          await keyboardActivate(page.getByRole("button", { name: "Check pending change", exact: true }));
          await expect.poll(() => page.evaluate(() => window.appAcceptance.commitReplyWaiting())).toBe(true);
          await page.getByLabel("Title", { exact: true }).focus();
        } finally { await page.evaluate(() => window.appAcceptance.releaseCommitReply()); }

        await expect(page.getByRole("button", { name: "Check pending change", exact: true })).toHaveCount(0);
        await expect(page.getByLabel("Title", { exact: true })).toBeFocused();
        evidence.checks.push("pending recovery stays reachable independently of ordinary error dismissal; known refusals dismiss without writes to a visible Workspace status heading, while a held fresh-branch reconciliation reply respects focus moved to Title and commits no duplicate history");
        await expect(page.getByRole("region", { name: "Fresh context branch", exact: true })).toContainText("An empty branch is selected");
        await expect(page.getByRole("region", { name: "Conversation messages", exact: true }).locator("article.message")).toHaveCount(0);
        await expect(page.getByLabel("Message", { exact: true })).toHaveValue("New branch draft B-NEW.");
        await expect(page.getByRole("img", { name: "branch-draft.png", exact: true })).toBeVisible();
        const freshState = await readState();
        const freshContext = (await records(page, "contexts")).items.find(value => value.id === freshState.contextSnapshotId);
        expect(freshState).toEqual({ ...sourceState, revision: sourceState.revision + 2, activeLeafMessageId: null, contextSnapshotId: freshContext.id });
        expect(freshContext).toEqual({ ...sourceContext, id: freshContext.id, previousId: sourceContext.id, version: sourceContext.version + 1, recordedAt: freshContext.recordedAt, compaction: { ...sourceContext.compaction, summary: null } });
        const branchEvents = (await records(page, "events")).items.filter(value => value.details.contextSnapshotId === freshContext.id);
        expect(branchEvents.map(value => value.details.action).sort()).toEqual(["clear_summary", "start_branch"]);
        expect((await records(page, "messages")).items.filter(value => value.threadId === seed.threadId)).toEqual(oldMessages);
        expect((await records(page, "parts")).items.filter(value => oldMessages.some(message => message.id === value.messageId))).toEqual(oldParts);
        expect(requests.length).toBe(beforeHttp); expect(countRequests.length).toBe(beforeCounts);
        await page.getByRole("button", { name: "Remove branch-draft.png", exact: true }).click();
        await page.getByRole("button", { name: "Count prompt tokens", exact: true }).click();
        await expect.poll(() => countRequests.length).toBe(beforeCounts + 1);
        expect(countRequests.at(-1).body.messages).toHaveLength(1);
        expect(JSON.stringify(countRequests.at(-1).body)).toContain("New branch draft B-NEW.");
        expect(JSON.stringify(countRequests.at(-1).body)).toContain("Retain exact branch instruction B-17.");
        nextResponse = { status: 503, body: { error: { type: "overloaded_error", message: "Synthetic fresh branch fallback" } } };
        await send(page, "New branch draft B-NEW.");
        await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
        await expect.poll(() => requests.length).toBe(beforeHttp + 2);
        for (const request of [countRequests.at(-1), ...requests.slice(beforeHttp)]) {
          const body = JSON.stringify(request.body);
          expect(body).toContain("New branch draft B-NEW."); expect(body).toContain("Retain exact branch instruction B-17.");
          for (const excluded of ["B-OLD", "B-SUMMARY", "What is in this picture?", "seeded PNG", seededPng, marker]) expect(body).not.toContain(excluded);
        }
        const newRoot = (await records(page, "messages")).items.find(value => value.threadId === seed.threadId && value.role === "user" && !oldMessages.some(old => old.id === value.id));
        expect(newRoot.parentId).toBe(null);
        await page.getByRole("button", { name: "Show starting branches", exact: true }).click();
        await page.getByRole("button", { name: new RegExp(seed.messageId.slice(0, 8)) }).click();
        await expect(page.getByRole("region", { name: "Conversation messages", exact: true })).toContainText("What is in this picture?");
        await page.getByRole("button", { name: "Review fresh branch", exact: true }).click();
        await review.getByRole("checkbox").check();
        await keyboardActivate(review.getByRole("button", { name: "Start fresh branch", exact: true }));
        await expect(page.getByRole("heading", { name: "Fresh context branch", exact: true })).toBeFocused();
        await expect(page.getByRole("region", { name: "Fresh context branch", exact: true })).toContainText("An empty branch is selected");
        evidence.branch = { threadId: seed.threadId, oldRootId: seed.messageId, newRootId: newRoot.id, freshContextId: freshContext.id, restartContextId: (await readState()).contextSnapshotId, sourceLeafId: sourceState.activeLeafMessageId };
        evidence.checks.push("explicit fresh branch review/cancel sends no HTTP or writes; lost durable reply reconciles one context and both audit events; draft and staged image survive; original messages and parts remain exact; count, failed primary and fallback carry system prompt plus new draft without old history or summary; next Send creates a root and old history remains selectable");
      }
      evidence.checks.push("alias and compaction review keyboard actions recover focus through save, cancel, remove and busy transitions; summary label/count status and populated alias/attachment/summary/fresh-branch layouts pass 320px normal/enlarged checks");
      {
        const seed = await page.evaluate(png => window.appAcceptance.seedImageThread(png, "Cost notebook"), seededPng);
        await page.getByRole("button", { name: "Refresh library", exact: true }).click();
        await page.getByRole("button", { name: "Cost notebook", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Cost notebook", exact: true })).toBeVisible();
        const readState = async () => (await records(page, "threadStates")).items.find(value => value.threadId === seed.threadId);
        await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
        await page.getByLabel("Maximum output tokens", { exact: true }).fill("1024");
        await page.getByLabel("Fallback candidate", { exact: true }).selectOption("openai:gpt-4.1-mini-2025-04-14");
        await page.getByRole("button", { name: "Add candidate", exact: true }).click();
        await expect(page.getByRole("list", { name: "Fallback candidates", exact: true })).toContainText("OpenAI");
        const cap = page.getByLabel("Maximum estimated request cost per attempt (USD)", { exact: true });
        const setCap = async value => { await cap.fill(value); await cap.press("Tab"); await expect.poll(async () => (await readState()).routingProfile.requirements.maxEstimatedRequestCost).toBe(value); };
        await setCap("0.01");
        expect((await readState()).routingProfile.version).toBe(4);
        await page.getByLabel("Message", { exact: true }).fill("First counted budget draft.");
        const beforeHttp = requests.length, beforeCount = countRequests.length;
        const beforeMessages = (await records(page, "messages")).items.length;
        await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
        await page.getByLabel("Message", { exact: true }).press("Control+Enter");
        expect(requests.length).toBe(beforeHttp); expect(countRequests.length).toBe(beforeCount);
        expect((await records(page, "messages")).items.length).toBe(beforeMessages);
        await page.getByRole("button", { name: "Count prompt tokens", exact: true }).click();
        await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
        await cap.fill("1e-2"); await cap.press("Tab");
        await expect(cap).toHaveAttribute("aria-invalid", "true");
        await expect(page.getByRole("alert")).toContainText("The saved limit is unchanged");

        await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
        expect((await readState()).routingProfile.requirements.maxEstimatedRequestCost).toBe("0.01");
        await setCap("0.01");
        await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
        await page.getByLabel("Message", { exact: true }).fill("Changed counted budget draft.");
        await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
        await page.getByRole("button", { name: "Count prompt tokens", exact: true }).click();
        await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
        await page.getByLabel("Maximum output tokens", { exact: true }).fill("1025");
        await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
        await page.getByLabel("Maximum output tokens", { exact: true }).fill("1024");
        await page.getByRole("button", { name: "Count prompt tokens", exact: true }).click();
        await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
        const countedBody = countRequests.at(-1).body, countedCalls = countRequests.length;
        const beforeGenerations = (await records(page, "generations")).items.length;
        nextResponse = { status: 503, body: { error: { type: "overloaded_error", message: "Synthetic budget primary failure" } } };
        await send(page, "Changed counted budget draft.");
        await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
        await expect(page.getByRole("alert")).toContainText("Fallback was not used");
        await expect(page.getByRole("alert")).toContainText("per-attempt limit");
        expect(requests.length).toBe(beforeHttp + 1); expect(countRequests.length).toBe(countedCalls);
        expect(requests.at(-1).body.messages).toEqual(countedBody.messages);
        expect(requests.at(-1).body.max_tokens).toBe(1024);
        expect((await records(page, "generations")).items.length).toBe(beforeGenerations + 1);
        const summary = page.getByRole("region", { name: "Conversation summary", exact: true });
        await summary.getByRole("button", { name: "Review conversation summaries", exact: true }).click();
        await summary.getByRole("button", { name: "Prepare summary request", exact: true }).click();
        const summaryReview = summary.getByRole("region", { name: "Review summary request", exact: true });
        await summaryReview.getByRole("checkbox", { name: "I reviewed this summary request and its destination", exact: true }).check();
        await expect(summaryReview).toContainText("Conservative context bound");
        await expect(summaryReview.getByRole("button", { name: "Generate summary proposal", exact: true })).toBeDisabled();
        expect(requests.length).toBe(beforeHttp + 1);
        await summaryReview.getByRole("button", { name: "Count summary input", exact: true }).click();
        await expect(summaryReview.getByRole("button", { name: "Generate summary proposal", exact: true })).toBeEnabled();
        await expect(summaryReview).toContainText("Output at the selected cap: up to ≈ 0.00512 USD");
        await expect(summaryReview).toContainText("Counted input: ≈");
        await summaryReview.screenshot({ path: `test-results/cost-${name}-summary.png` });
        await summaryReview.getByRole("button", { name: "Generate summary proposal", exact: true }).click();
        await expect(summary.getByLabel("Reviewed summary", { exact: true })).toBeEnabled({ timeout: 15000 });
        expect(requests.length).toBe(beforeHttp + 2);
        await summary.getByRole("button", { name: "Close summary review", exact: true }).click();
        await setCap("0.5");
        const beforeAllowed = requests.length, beforeAllowedCount = countRequests.length;
        nextResponse = { status: 503, body: { error: { type: "overloaded_error", message: "Synthetic budget permits fallback" } } };
        await send(page, "Allow separately budgeted attempts.");
        await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
        await expect.poll(() => requests.length).toBe(beforeAllowed + 2);
        expect(countRequests.length).toBe(beforeAllowedCount);
        expect(requests.at(-2).body.max_tokens).toBe(1024);
        expect(requests.at(-1).body.max_completion_tokens).toBe(1024);
        const fallback = (await records(page, "events")).items.find(value => value.threadId === seed.threadId && value.type === "AutomaticFallback");
        expect(fallback.details.reason).toContain("Cost check: Conservative context bound");
        if (await page.locator(".switch-report").count()) await page.getByRole("checkbox", { name: /I reviewed this switch/ }).check();
        await page.getByRole("button", { name: /^Generate another response — / }).first().click();
        await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
        await expect.poll(() => requests.length).toBe(beforeAllowed + 3);
        expect(countRequests.length).toBe(beforeAllowedCount);
        const beforeAliasHttp = requests.length;
        await page.getByRole("button", { name: "Preferences", exact: true }).click();
        await page.getByRole("button", { name: "New routing alias", exact: true }).click();
        const editor = page.getByRole("form", { name: "Routing alias editor" });
        await editor.getByLabel("Alias name", { exact: true }).fill("Budget");
        await editor.getByLabel("Alias primary", { exact: true }).selectOption(JSON.stringify(["anthropic", "claude-haiku-4-5-20251001"]));
        await editor.getByLabel("Alias fallback candidate", { exact: true }).selectOption(JSON.stringify(["openai", "gpt-4.1-mini-2025-04-14"]));
        await editor.getByRole("button", { name: "Add alias fallback", exact: true }).click();
        await editor.getByLabel("Alias maximum estimated request cost per attempt (USD)", { exact: true }).fill("0.5");
        await editor.getByRole("button", { name: "Save routing alias", exact: true }).click();
        await expect(editor).toHaveCount(0);
        const alias = (await page.evaluate(() => window.appAcceptance.aliases())).aliases.find(value => value.name === "Budget");
        await page.getByRole("button", { name: "Library", exact: true }).click();
        await page.getByRole("button", { name: "Cost notebook", exact: true }).click();
        await page.getByLabel("Routing alias", { exact: true }).selectOption(alias.id);
        const aliasReview = page.getByRole("region", { name: "Apply routing alias", exact: true });
        await expect(aliasReview).toContainText("0.5 USD");
        await aliasReview.getByRole("checkbox", { name: "I reviewed this alias profile", exact: true }).check();
        await aliasReview.getByRole("button", { name: "Apply alias to conversation", exact: true }).click();
        await expect.poll(async () => (await readState()).routingProfile.alias).toBe("Budget");
        expect((await readState()).routingProfile.version).toBe(4);
        expect(requests.length).toBe(beforeAliasHttp);
        await cap.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `test-results/cost-${name}-route.png`, fullPage: true });
        evidence.cost = { threadId: seed.threadId, profile: (await readState()).routingProfile, aliasId: alias.id, blockedFallbackPrimaryRequests: 1, allowedFallbackRequests: 2 };
        evidence.checks.push("per-attempt total cost limit blocks uncounted keyboard/button sends without writes or HTTP; explicit exact-input count unlocks, draft/output edits expire it, and an over-budget fallback receives neither generation nor hidden count HTTP; summary generation independently waits for reviewed count; sufficient conservative budgets allow primary/fallback/regeneration and record cost basis; alias editor/review persists a v4 total-cap snapshot");
      }
      evidence.regions = await exerciseRegionalRouting({ page, records, send, requests, countRequests, failNext: response => { nextResponse = response; }, seededPng, name });
      evidence.checks.push("required processing region refuses unknown/different-region send and count without writes or HTTP, routes an unknown primary to eligible US before the initial attempt with exact native fixture binding/model and recorded review basis, permits US regeneration, and refuses unknown/EU fallbacks after a US failure without extra HTTP");
      evidence.checks.push("summary region review refuses count/generation to an unknown selected primary, accepts the eligible US target with unchanged output settings and durable review basis, and a v5 region alias snapshots independently of later alias edits while fresh branching preserves the conversation policy");
      evidence.composerFiles = await exerciseComposerFiles({ page, records, send, requests, countRequests, connect, temporary, name, seededPng });
      evidence.checks.push("PDF picker/drop preserves original verified bytes as Attachment and File, shows metadata without preview execution, removes drafts and refuses unsupported/oversized/mislabeled files; both provider protocols send and regenerate exact originals, Anthropic counts the same file, and a portable TAR is restored through reviewed managed activation before regenerating the restored PDF");
      evidence.checks.push("keyboard restore picker and replacement review retain focus, releasing candidate work and completing activation park focus at the restore heading, and live restore phases exclude numeric progress counters");
      evidence.audioInput = await exerciseAudioInput({ page, records, send, requests, countRequests, name, connect, temporary });
      evidence.checks.push("WAV/MP3 picker and drop retain exact Audio parts and verified bytes, refuse unsupported/mislabeled/oversized drafts, send and regenerate input_audio with text-only output, block unsupported models without dispatch, and preserve originals through portable restore and restored regeneration");
      evidence.outputParts = await exerciseOutputParts({ page, records, send, requests, countRequests });
      evidence.checks.push("an Anthropic response with a citation and an unknown output block, and an OpenAI response with a URL annotation and a provider-specific delta, are retained as Citation and stream-located ProviderArtifact parts; the next send, count, regeneration and cross-provider switch carry the answer text plus a plain source note and none of the provider-specific records, with the switch report naming each transformation, while import-derived artifacts remain refused by name");
      evidence.reasoningContinuation = await exerciseReasoningContinuation({ page, records, send, requests, countRequests });
      evidence.checks.push("manual thinking for the reviewed Haiku 4.5 profile refuses budgets below 1,024, at or above the output limit, with temperature or an out-of-range top-p without writes or HTTP; a thinking-enabled send carries the enabled budget and records signed and redacted receipts beside their markers; count, a later send, and regeneration carry those blocks first and unchanged from verified receipts on the producing model; the OpenAI switch report and portability name the omitted blocks and the OpenAI request carries none; returning to Anthropic restores them with the response's records unchanged");
      await page.screenshot({
        path: `test-results/app-${name}.png`,
        fullPage: true,
      });
      evidence.userAgent = await page.evaluate(() => navigator.userAgent);
      evidence.unclaimedExport = await page.evaluate(() =>
        window.appAcceptance.prepareUnclaimedExport(),
      );
      evidence.savedMessages = (await records(page, "messages")).items.length;
      evidence.interactionPreferences.persisted = await prepareInteractionPreferencesRestart(page);
      await page.evaluate(() => window.appAcceptance.close());
    } catch (error) {
      const page = context.pages().at(-1);
      if (page) {
        await page.screenshot({
          path: `test-results/app-${name}-failure.png`,
          fullPage: true,
        });
        console.error(await page.locator("body").innerText());
        console.error("SUMMARY DOM", JSON.stringify(await page.locator("section[aria-label]").evaluateAll(nodes => nodes.map(node => ({label:node.getAttribute("aria-label"),hidden:node.hidden,inner:node.querySelector("textarea")?.outerHTML})))));
        console.error("SUMMARY LOCATORS", await page.getByRole("region", { name: "Conversation summary", exact: true }).count(), await page.getByRole("region", { name: "Review proposed summary", exact: true }).count(), await page.getByLabel("Reviewed summary", { exact: true }).count());
        console.error(JSON.stringify(await records(page, "generations")));
      }
      throw error;
    } finally {
      await context.close();
    }
    context = await engine.launchPersistentContext(profile, {
      headless: true,
      viewport: { width: 390, height: 844 },
    });
    try {
      const page = await context.newPage();
      await page.goto(url);
      await page.getByRole("button", { name: /Comet notebook/ }).click();
      await expect(
        page.getByRole("heading", { name: "Comet notebook" }),
      ).toBeVisible();
      expect((await records(page, "messages")).items).toHaveLength(
        evidence.savedMessages,
      );
      await expect(
        page.getByText("Connect a provider to send messages", { exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
      // Core flows reflow at 320px at normal and 200% root text size: the
      // library and an open conversation with saved messages.
      await captureReviewLayout({ page, regionName: "Conversation library", role: "complementary", name, caseName: "library-narrow" });
      await captureReviewLayout({ page, regionName: "Conversation messages", name, caseName: "conversation-narrow" });
      evidence.checks.push("the conversation library and an open conversation with saved messages fit 320px at normal and 200% root text size without horizontal overflow");
      // The stopped attempt is still shown as partial after the restart.
      await verifyInteractionPreferencesRestart({ page, requests, countRequests, expected: evidence.interactionPreferences.persisted, name });
      evidence.checks.push("all four interaction preferences survive a fresh browser process with exact revision and send-key preserved; saved timestamps, hidden badges, compact composer and model list render without credentials or HTTP at 390px, then defaults are restored for subsequent checks");
      expect((await page.evaluate(() => window.appAcceptance.preferences())).sendKey).toBe("enter");
      await expect(page.getByText("Enter to send · Shift + Enter for a new line", { exact: true })).toBeVisible();
      await page.getByLabel("Message", { exact: true }).fill("");
      const restartedThreadId = (await records(page, "threadStates")).items.find((value) => value.title === "Comet notebook").threadId;
      const restartedRoot = (await records(page, "messages")).items
        .filter((value) => value.threadId === restartedThreadId && value.parentId === null)
        .sort((a, b) => a.createdAt - b.createdAt)
        .find((value) => value.editedFromMessageId !== null);
      await page.getByRole("button", { name: "Show starting branches", exact: true }).click();
      await page
        .getByRole("region", { name: "Branch choices" })
        .getByRole("button", { name: new RegExp(restartedRoot.id.slice(0, 8)) })
        .click();
      await expect(page.locator(".message.user").first()).toContainText("Edited comet question");
      // The stored routing profile survives the restart; its candidate is
      // shown by id as not configured on this device.
      await expect(page.getByRole("list", { name: "Fallback candidates" })).toContainText("openai · gpt-4.1-mini-2025-04-14 (not configured)");
      // Without a configured connection the status is explicitly unknown.
      await expect(page.getByRole("region", { name: "Portability" })).toContainText("Portability: Unknown. No connection is configured, so no target was analysed.");
      // Recorded switches survive the restart and stay inspectable from their
      // recorded ids alone: no connection is configured after the restart.
      await expect(page.getByRole("list", { name: "Conversation events" })).toContainText("Switched anthropic claude-haiku-4-5-20251001 → openai gpt-4.1-mini-2025-04-14");
      // The user-stopped attempt keeps its recorded interrupted status and
      // sealed output after the restart.
      const interruptedAttempt = (await records(page, "generations")).items.find(
        (value) => value.threadId === restartedThreadId && ["stopped", "cancelled", "partial"].includes(value.status),
      );
      expect(interruptedAttempt).toBeTruthy();
      const restartedMessages = (await records(page, "messages")).items;
      const interruptedOutput = restartedMessages.find((value) => value.generationId === interruptedAttempt.id);
      expect(interruptedOutput.sealed).toBe(true);
      // Walk from its root through the continuations down to the stopped
      // attempt (whichever branch holds it) and read its status.
      const pathToInterrupted = [];
      for (let step = interruptedOutput; step; step = restartedMessages.find((value) => value.id === step.parentId)) pathToInterrupted.unshift(step);
      await page.getByRole("button", { name: "Show starting branches", exact: true }).click();
      for (const step of pathToInterrupted)
        await page
          .getByRole("region", { name: "Branch choices" })
          .getByRole("button", { name: new RegExp(step.id.slice(0, 8)) })
          .click();
      await expect(page.locator(".message.assistant").last()).toContainText(`· ${interruptedAttempt.status}`);
      await expect(page.locator(".message.assistant").last()).toContainText("Visible stream 🧪");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/app-${name}-mobile.png`,
        fullPage: true,
      });
      await page
        .locator(".composer")
        .screenshot({ path: `test-results/app-${name}-mobile-composer.png` });
      evidence.checks.push(
        "a fresh browser process retains canonical branches and messages, keeps the stopped attempt with its recorded interrupted status and sealed output, can switch branches without a provider, loses session credentials, and fits a narrow viewport",
      );
      await page.getByRole("button", { name: "Image thread", exact: true }).click();
      const restartedAliasProfile = (await records(page, "threadStates")).items.find(value => value.title === "Image thread").routingProfile;
      expect(restartedAliasProfile).toEqual(evidence.aliasProfile);
      await expect(page.getByText("Applied routing alias: Coding", { exact: true })).toBeVisible();
      await expect(page.getByText(/Saved primary anthropic .* is not configured on this device/)).toBeVisible();
      await expect(page.getByRole("region", { name: "Request context", exact: true })).toContainText("1 attachment occurrence(s) excluded");
      await page.getByRole("button", { name: "Review attachment exclusions", exact: true }).click();
      await expect(page.getByRole("region", { name: "Review attachment exclusions", exact: true }).getByRole("checkbox").first()).toBeChecked();
      await page.getByRole("button", { name: "Cancel attachment review", exact: true }).click();
      await page.getByRole("button", { name: "Summary notebook", exact: true }).click();
      await expect(page.getByRole("list", { name: "Conversation events", exact: true })).toContainText("Reviewed summary applied");
      await expect(page.getByRole("list", { name: "Conversation events", exact: true })).toContainText("Fell back");
      const restoredSummaryPanel = page.getByRole("region", { name: "Conversation summary", exact: true });
      await expect(restoredSummaryPanel).toContainText("A reviewed summary replaces conversation context");
      await restoredSummaryPanel.getByText("Current reviewed summary", { exact: true }).click();
      await expect(restoredSummaryPanel).toContainText(evidence.summary.reviewedText);
      await restoredSummaryPanel.getByRole("button", { name: "Review conversation summaries", exact: true }).click();
      await restoredSummaryPanel.getByRole("button", { name: new RegExp(`Inspect proposal ${evidence.summary.proposalId.slice(0, 8)}`) }).click();
      await expect(restoredSummaryPanel.getByRole("region", { name: "Review proposed summary", exact: true })).toContainText("complete");
      await restoredSummaryPanel.getByRole("button", { name: "Inspect saved summary input", exact: true }).click();
      const restartedInput = await restoredSummaryPanel.getByRole("region", { name: "Review proposed summary", exact: true }).locator("pre").textContent();
      expect(createHash("sha256").update(restartedInput).digest("hex")).toBe(evidence.summary.inputSha256);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await restoredSummaryPanel.screenshot({ path: `test-results/summary-${name}-mobile.png` });
      await restoredSummaryPanel.getByRole("button", { name: "Close summary review", exact: true }).click();
      await restoredSummaryPanel.getByRole("button", { name: "Clear summary and use full history", exact: true }).click();
      await expect(restoredSummaryPanel.getByText(/A reviewed summary replaces/)).toHaveCount(0);
      const clearedState = (await records(page, "threadStates")).items.find(value => value.threadId === evidence.summary.threadId);
      const clearedSummaryContext = (await records(page, "contexts")).items.find(value => value.id === clearedState.contextSnapshotId);
      expect(clearedSummaryContext.compaction).toEqual({ version: 2, excludedPartIds: [evidence.summary.exclusionPartId], summary: null });
      expect((await records(page, "events")).items.filter(value => value.details.action === "clear_summary" && value.details.contextSnapshotId === clearedSummaryContext.id)).toHaveLength(1);
      evidence.checks.push("reviewed summary, generated proposal and exact saved input survive browser-process restart; saved proposals remain inspectable without a configured provider, and clear creates an audited snapshot preserving attachment exclusions");
      const restartHttp = requests.length;
      await page.getByRole("button", { name: "Branch notebook", exact: true }).click();
      await expect(page.getByRole("list", { name: "Conversation events", exact: true })).toContainText("Fresh branch started");
      await expect(page.getByRole("list", { name: "Conversation events", exact: true })).toContainText("Summary cleared for fresh branch");
      await expect(page.getByRole("region", { name: "Fresh context branch", exact: true })).toContainText("An empty branch is selected");
      await expect(page.getByRole("region", { name: "Conversation messages", exact: true }).locator("article.message")).toHaveCount(0);
      expect((await records(page, "threadStates")).items.find(value => value.threadId === evidence.branch.threadId)).toMatchObject({ activeLeafMessageId: null, contextSnapshotId: evidence.branch.restartContextId });
      await page.getByRole("button", { name: "Review fresh branch", exact: true }).scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/branch-${name}-mobile.png`, fullPage: true });
      await page.getByRole("button", { name: "Show starting branches", exact: true }).click();
      await page.getByRole("button", { name: new RegExp(evidence.branch.oldRootId.slice(0, 8)) }).click();
      await expect(page.getByRole("region", { name: "Conversation messages", exact: true })).toContainText("What is in this picture?");
      expect(requests.length).toBe(restartHttp);
      evidence.checks.push("fresh branch null selection and context survive browser-process restart without provider credentials; mobile layout fits and original root remains navigable without provider HTTP");
      await page.getByRole("button", { name: "Cost notebook", exact: true }).click();
      await expect(page.getByText("Applied routing alias: Budget", { exact: true })).toBeVisible();
      expect((await records(page, "threadStates")).items.find(value => value.threadId === evidence.cost.threadId).routingProfile).toEqual(evidence.cost.profile);
      await expect(page.getByLabel("Maximum estimated request cost per attempt (USD)", { exact: true })).toHaveValue("0.5");
      await expect(page.getByRole("list", { name: "Conversation events", exact: true })).toContainText("Cost check: Conservative context bound");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByLabel("Maximum estimated request cost per attempt (USD)", { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `test-results/cost-${name}-mobile.png`, fullPage: true });
      evidence.checks.push("v4 cost profile and recorded fallback cost basis survive process restart without provider credentials; per-attempt limit remains inspectable in the narrow layout");
      await verifyRegionalRestart({ page, records, requests, countRequests, evidence: evidence.regions, name });
      evidence.checks.push("v5 regional conversation snapshot, independent edited alias, generation/summary review basis and fresh-branch selection survive process restart without provider credentials or HTTP and fit the narrow layout");
      await verifyComposerFilesRestart({ page, records, requests, evidence: evidence.composerFiles, name });
      evidence.checks.push("PDF File parts, attachment metadata and original byte hash survive a browser-process restart without credentials, remain visible in narrow history, and trigger no provider HTTP");
      await verifyAudioInputRestart({ page, records, requests, countRequests, evidence: evidence.audioInput, name });
      evidence.checks.push("Audio canonical parts, metadata and original byte hashes survive browser-process restart without credentials or provider traffic and fit narrow history");
      const restoredAliases = await page.evaluate(() => window.appAcceptance.aliases());
      expect(restoredAliases.aliases.map(value => value.name)).toEqual(["Private", "Budget", "Regional"]);
      await page.getByRole("button", { name: "Preferences", exact: true }).click();
      await expect(page.getByRole("article", { name: "Alias Private", exact: true })).toContainText("anthropic · claude-haiku-4-5-20251001 (not configured)");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/aliases-${name}-mobile.png`, fullPage: true });
      await page
        .getByRole("button", { name: "Export history", exact: true })
        .click();
      await page
        .getByRole("button", {
          name: "Prepare saved export download",
          exact: true,
        })
        .click();
      await expect(
        page.getByRole("button", { name: "Save prepared export", exact: true }),
      ).toBeVisible({ timeout: 30000 });
      const resuming = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "Save prepared export", exact: true })
        .click();
      const resumedDownload = await resuming;
      const resumedBytes = await readFile(await resumedDownload.path());
      expect(createHash("sha256").update(resumedBytes).digest("hex")).toBe(
        evidence.unclaimedExport.output.sha256,
      );
      await page
        .getByRole("button", {
          name: "I checked the download — clear temporary copy",
          exact: true,
        })
        .click();
      await expect(
        page.getByRole("region", { name: "Temporary browser downloads" }),
      ).toHaveCount(0);
      evidence.checks.push(
        "saved ready export is discovered after process loss, downloaded without re-exporting and matches its original checksum",
      );
      await verifyReasoningContinuationRestart({ page, records, send, requests, connect }, evidence.reasoningContinuation);
      evidence.checks.push("after a fresh browser process the thinking receipts still verify and a follow-up on the producing model carries the same signed and redacted blocks first and unchanged");
      // The follow-up above added a user turn and a response.
      evidence.savedMessages = (await records(page, "messages")).items.length;
      await page.evaluate(() => window.appAcceptance.close());
      const requestsBeforeInvalidConfiguration = requests.length;
      await page.goto(`${url}&invalid-relay=1`);
      await expect(
        page.getByText(
          /Live provider connections are unavailable because this site’s relay configuration is invalid/,
        ),
      ).toBeVisible();
      await page.getByRole("button", { name: /Comet notebook/ }).click();
      expect((await records(page, "messages")).items).toHaveLength(
        evidence.savedMessages,
      );
      await page
        .getByLabel("Search your history", { exact: true })
        .fill("Visible stream segment 1");
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await expect(
        page
          .getByRole("region", { name: "Search results" })
          .getByText("Exact text match")
          .first(),
      ).toBeVisible();
      await page.getByRole("button", { name: "Close results" }).click();
      await page
        .getByRole("button", { name: "New conversation", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "New conversation", exact: true }),
      ).toBeVisible();
      // Seeded and created conversations, including the reasoning notebook.
      expect((await records(page, "threadStates")).items).toHaveLength(14);
      await page
        .getByRole("button", { name: "Providers", exact: true })
        .click();
      for (const button of await page
        .getByRole("button", { name: "Connect credential", exact: true })
        .all())
        await expect(button).toBeDisabled();
      expect(requests.length).toBe(requestsBeforeInvalidConfiguration);
      await expect(page.getByRole("alert")).toHaveCount(0);
      evidence.checks.push(
        "invalid operator relay configuration leaves local history, search and creation available while provider connections remain disabled",
      );
      await page.evaluate(() => window.appAcceptance.close());
    } finally {
      await context.close();
    }
    // Semantic indexing and hybrid search in a fresh archive with the real
    // pinned model (plan 21); the model directory is served by the preview.
    evidence.semantic = await exerciseSemanticSearch({ engine, profile: resolve(temporary, `${name}-semantic`), name, origin: "http://127.0.0.1:4197" });
    evidence.checks.push(...evidence.semantic.checks);
    // First-run onboarding and storage status in a fresh archive (plans 13/21).
    evidence.onboarding = await exerciseOnboarding({ engine, profile: resolve(temporary, `${name}-onboarding`), name, origin: "http://127.0.0.1:4197" });
    evidence.checks.push(...evidence.onboarding.checks);
    evidence.status = "passed";
    await save();
    console.log(`${name}: ${evidence.checks.length} application checks passed`);
  }
  report.sourceStable = (await Promise.all(Object.entries(report.sourceSha256).map(async ([file, sha256]) => createHash('sha256').update(await readFile(file)).digest('hex') === sha256))).every(Boolean);
  if (!report.sourceStable) throw new Error('Application proof source changed during qualification');
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error?.stack ?? error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await save();
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
