import test from "node:test";
import assert from "node:assert/strict";
import { prepare } from "../src/request.ts";
import { CompatibilityError, LIMITS, type ProviderInput } from "../src/index.ts";
import { model, input } from "./fixtures.ts";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 255, 0, 128]);
const attachmentId = crypto.randomUUID();
const issue = (code: string) => (error: unknown) =>
  error instanceof CompatibilityError && error.issues.some((item) => item.code === code);
function withImage(role: "user" | "assistant" = "user", attachments?: ProviderInput["attachments"]): ProviderInput {
  const base = input();
  const messageId = crypto.randomUUID();
  return {
    ...base,
    messages: [
      {
        role,
        parts: [
          { id: crypto.randomUUID(), messageId, order: 0, kind: "Text", data: { text: "What is in this picture?" } },
          { id: crypto.randomUUID(), messageId, order: 1, kind: "Image", data: { attachmentId, description: null } },
        ],
      },
    ],
    ...(attachments === undefined ? { attachments: { [attachmentId]: { mediaType: "image/png", bytes: png } } } : { attachments }),
  };
}

for (const protocol of ["openai-compatible", "anthropic"] as const) {
  test(`${protocol}: an available PNG maps to a base64 image block that decodes to the exact bytes`, () => {
    const body = prepare(protocol, withImage(), model(protocol, "synthetic-model", { images: true })).body;
    // OpenAI prepends the system prompt as its own message; the user turn is last.
    const message = (body.messages as { role: string; content: unknown }[]).find((entry) => entry.role === "user")!;
    const blocks = message.content as { type: string; source?: { type: string; media_type: string; data: string }; image_url?: { url: string } }[];
    assert.ok(Array.isArray(blocks));
    assert.equal(blocks[0]!.type, "text");
    if (protocol === "anthropic") {
      assert.equal(blocks[1]!.type, "image");
      assert.equal(blocks[1]!.source!.type, "base64");
      assert.equal(blocks[1]!.source!.media_type, "image/png");
      assert.deepEqual(new Uint8Array(Buffer.from(blocks[1]!.source!.data, "base64")), png);
    } else {
      assert.equal(blocks[1]!.type, "image_url");
      const url = blocks[1]!.image_url!.url;
      assert.ok(url.startsWith("data:image/png;base64,"));
      assert.deepEqual(new Uint8Array(Buffer.from(url.slice("data:image/png;base64,".length), "base64")), png);
    }
  });
  test(`${protocol}: image issues are explicit for unsupported models, roles, missing bytes, media types, size and count`, () => {
    const capable = model(protocol, "synthetic-model", { images: true });
    assert.throws(() => prepare(protocol, withImage(), model(protocol)), issue("images_unsupported"));
    assert.throws(() => prepare(protocol, withImage("assistant"), capable), issue("image_role"));
    assert.throws(() => prepare(protocol, withImage("user", {}), capable), issue("image_unavailable"));
    assert.throws(
      () => prepare(protocol, withImage("user", { [attachmentId]: { mediaType: "image/tiff", bytes: png } }), capable),
      issue("image_media_unsupported"),
    );
    assert.throws(
      () => prepare(protocol, withImage("user", { [attachmentId]: { mediaType: "image/png", bytes: new Uint8Array(LIMITS.imageBytes + 1) } }), capable),
      issue("image_too_large"),
    );
    const many = withImage();
    const messageId = crypto.randomUUID();
    many.messages = [
      {
        role: "user",
        parts: Array.from({ length: LIMITS.imagesPerRequest + 1 }, (_, order) => ({
          id: crypto.randomUUID(), messageId, order, kind: "Image" as const, data: { attachmentId, description: null },
        })),
      },
    ];
    assert.throws(() => prepare(protocol, many, capable), issue("image_limit"));
  });
  test(`${protocol}: multiple images share the raw attachment bound before further base64 allocation`, () => {
    const capable = model(protocol, "synthetic-model", { images: true });
    const large = new Uint8Array(LIMITS.imageBytes);
    const messageId = crypto.randomUUID();
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const request: ProviderInput = {
      ...input(),
      messages: [
        {
          role: "user",
          parts: ids.map((id, order) => ({ id: crypto.randomUUID(), messageId, order, kind: "Image" as const, data: { attachmentId: id, description: null } })),
        },
      ],
      attachments: Object.fromEntries(ids.map((id) => [id, { mediaType: "image/png", bytes: large }])),
    };
    assert.throws(() => prepare(protocol, request, capable), issue("attachment_total_limit"));
  });
}

test("text-only messages keep the OpenAI string content form", () => {
  const body = prepare("openai-compatible", input(), model("openai-compatible", "synthetic-model", { images: true })).body;
  const message = (body.messages as { content: unknown }[]).at(-1)!;
  assert.equal(typeof message.content, "string");
});
