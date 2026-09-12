import type { HostClient, ProviderBinding } from "@quixi/core/contracts";
import {
  adapterCatalog, initialProviderCatalogs,
  createAnthropicAdapter,
  createOpenAICompatibleAdapter,
  type Protocol,
} from "../src/index.ts";
import { input, model } from "./fixtures.ts";
import { audioFixture } from "./audio-fixtures.ts";
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
/** Same production provider code and host boundary in browser and native proofs. */
export async function exerciseProviderHost(
  host: HostClient,
  bindings: Record<Protocol, ProviderBinding>,
) {
  const checks: string[] = [];
  const results = [];
  for (const protocol of ["openai-compatible", "anthropic"] as const) {
    const binding = bindings[protocol];
    const credential = await host.storeSecret(
      crypto.randomUUID(),
      binding,
      new TextEncoder().encode("synthetic-secret"),
      null,
    );
    try {
      const adapter = (
        protocol === "anthropic"
          ? createAnthropicAdapter
          : createOpenAICompatibleAdapter
      )({
        host,
        binding,
        credential,
        catalog: [
          "synthetic-model",
          "malformed",
          "truncated",
          "slow",
          "rate",
        ].map((id) => model(protocol, id)),
        nextId: () => crypto.randomUUID(),
        now: () => Date.now(),
      });
      const models = await adapter.listModels();
      assert(
        models.models[0]?.id === "synthetic-model" &&
          models.models[1]?.capabilities.streaming === "unknown",
        "Model discovery invented capabilities.",
      );
      checks.push(
        `${protocol}: model discovery uses registered credential header and leaves unknown capability unknown`,
      );
      if (protocol === "openai-compatible") {
        const audioModel = adapterCatalog(initialProviderCatalogs()[0]!).find(value => value.id === "gpt-audio-1.5")!;
        const audioAdapter = createOpenAICompatibleAdapter({ host, binding, credential, catalog: [audioModel], nextId: () => crypto.randomUUID(), now: () => Date.now() });
        for (const format of ["wav", "mp3"] as const) {
          const original = input(audioModel.id), attachmentId = crypto.randomUUID();
          const request = { ...original, attachments: { [attachmentId]: { mediaType: format === "wav" ? "audio/wav" : "audio/mpeg", bytes: audioFixture(format) } },
            messages: [{ role: "user" as const, parts: [...original.messages[0]!.parts, { id: crypto.randomUUID(), messageId: original.messages[0]!.parts[0]!.messageId, order: 1, kind: "Audio" as const, data: { attachmentId, description: "Synthetic silence" } }] }] };
          let terminal, text = "";
          for await (const event of audioAdapter.stream(request).events) {
            if (event.type === "text") text += event.text;
            if (event.type === "terminal") terminal = event;
          }
          assert(terminal?.status === "complete" && text.startsWith("Hello 🧪 "), `Audio ${format} transport failed: ${JSON.stringify(terminal)}`);
          checks.push(`openai-compatible: ${format} original audio bytes reach the controlled endpoint with text-only output through the actual host transport`);
          results.push({ protocol, mode: `audio-${format}`, status: terminal.status, textChars: text.length });
        }
      }
      for (const mode of [
        "synthetic-model",
        "malformed",
        "truncated",
        "slow",
        "rate",
      ]) {
        const stream = adapter.stream(input(mode));
        let text = "",
          rawBytes = 0,
          terminal;
        let tool = false,
          citation = false,
          artifact = false;
        const reasoning = [];
        for await (const event of stream.events) {
          if (event.type === "raw") rawBytes += event.bytes.length;
          if (event.type === "text") {
            text += event.text;
            if (mode === "slow") await stream.cancel();
          }
          if (event.type === "part") {
            tool ||= event.part.kind === "ToolCall";
            citation ||= event.part.kind === "Citation";
          }
          if (event.type === "artifact") artifact = true;
          if (event.type === "reasoning_block") reasoning.push(event);
          if (event.type === "terminal") terminal = event;
        }
        assert(
          terminal?.status ===
            (mode === "synthetic-model"
              ? "complete"
              : mode === "slow"
                ? "cancelled"
                : mode === "rate"
                  ? "failed"
                  : "partial"),
          `${protocol}/${mode}: terminal classification failed: ${JSON.stringify(terminal)}`,
        );
        if (mode === "synthetic-model") {
          assert(
            tool && citation && artifact && terminal.usage.outputTokens === 7,
            "Tool/citation/raw-only output or usage lost.",
          );
          if (protocol === "anthropic") {
            assert(JSON.stringify(reasoning.map(event => [event.index, event.block])) === JSON.stringify([
              [1, { type: "thinking", thinking: "synthetic reasoning", signature: "synthetic-signature" }],
              [3, { type: "redacted_thinking", data: "synthetic-encrypted+/=" }],
            ]), "Signed or redacted thinking changed during actual host transport.");
            checks.push("anthropic: fragmented host transport retains complete signed and redacted thinking blocks in source order");
          }
        }
        if (mode !== "rate")
          assert(text.startsWith("Hello 🧪 "), "Received text was lost.");
        assert(rawBytes > 0, "Raw response was lost.");
        checks.push(
          `${protocol}: ${mode} preserves raw bytes and bounded output with ${terminal.status} outcome`,
        );
        results.push({
          protocol,
          mode,
          status: terminal.status,
          rawBytes,
          textChars: text.length,
        });
      }
    } finally {
      await host.deleteSecret(crypto.randomUUID(), credential);
    }
  }
  return { checks, results };
}
