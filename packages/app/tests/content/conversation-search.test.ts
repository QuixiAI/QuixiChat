import { test } from "node:test";
import assert from "node:assert/strict";
import type { SearchHit, StorageClient } from "@quixi/core/contracts";
import { createConversationSearchController } from "../../src/features/content/conversation-search.ts";
const id = () => crypto.randomUUID();
function fixture(filename = true) {
  const attachment = {
    id: id(),
    filename: "harbor-chart.png",
    availability: "missing",
    mimeType: "image/png",
    sizeBytes: null,
    blobSha256: null,
    rawObjectId: null,
  };
  const message = {
    id: id(),
    threadId: id(),
    parentId: null,
    role: "assistant",
    createdAt: 1,
    recordedAt: 1,
    generationId: null,
    editedFromMessageId: null,
    partCount: 96,
    sealed: true,
  };
  const part: any = filename
    ? {
        id: id(),
        messageId: message.id,
        order: 95,
        kind: "Image",
        data: {
          attachmentId: attachment.id,
          description: "A different image description",
        },
      }
    : {
        id: id(),
        messageId: message.id,
        order: 95,
        kind: "Text",
        data: { text: "a distant message part" },
      };
  const position = {
    partId: part.id,
    start: 0,
    end: filename ? attachment.filename.length : 22,
    page: null,
    sectionPath: filename ? ["attachment", attachment.id, "filename"] : [],
  };
  const hit: SearchHit = {
    chunkId: "a".repeat(64),
    threadId: message.threadId,
    messageId: message.id,
    documentId: null,
    sourceId: message.id,
    sourceType: "message",
    position,
    title: "Conversation",
    role: "assistant",
    provider: null,
    model: null,
    date: null,
    score: 1,
    explanation: "Exact text match",
    excerpt: { text: attachment.filename, highlights: [{ start: 0, end: 6 }] },
  };
  const calls: { operation: string; args: any }[] = [];
  let resolveResponse: any = {
    threadId: message.threadId,
    messageId: message.id,
    partId: part.id,
    position: structuredClone(position),
  };
  let blocked: Promise<void> | null = null;
  let closed = 0;
  let selection: () => void = () => {};
  const storage = {
    async request(_requestId: string, operation: string, args: any) {
      calls.push({ operation, args: structuredClone(args) });
      if (blocked) {
        const wait = blocked;
        blocked = null;
        await wait;
      }
      if (operation === "readEntity")
        return structuredClone(
          args.collection === "parts"
            ? part
            : args.collection === "messages"
              ? message
              : attachment,
        );
      if (operation === "resolveConversationSearchHit") {
        if (resolveResponse instanceof Error) throw resolveResponse;
        return structuredClone(resolveResponse);
      }
      throw Error("Unexpected operation " + operation);
    },
    async close() {
      closed++;
    },
  } as unknown as StorageClient;
  const controller = createConversationSearchController({
    storage,
    archiveSession: {
      onSelectionChange(listener) {
        selection = listener;
        return () => {
          selection = () => {};
        };
      },
    },
  });
  return {
    controller,
    hit,
    part,
    message,
    attachment,
    calls,
    setResolve: (value: any) => {
      resolveResponse = value;
    },
    delay: (promise: Promise<void>) => {
      blocked = promise;
    },
    selection: () => selection(),
    closed: () => closed,
  };
}
test("focuses part96 using three bounded metadata reads and exact resolver; missing image bytes still expose filename", async () => {
  const f = fixture();
  const result = await f.controller.resolve(f.hit);
  assert.equal(result?.part.order, 95);
  assert.equal(result?.filename?.text, "harbor-chart.png");
  assert.equal(result?.part.kind, "Image");
  assert.deepEqual(
    f.calls.map((c) => c.operation),
    ["readEntity", "readEntity", "readEntity", "resolveConversationSearchHit"],
  );
  assert.deepEqual(f.calls.at(-1)?.args, {
    chunkId: f.hit.chunkId,
    threadId: f.message.threadId,
    messageId: f.message.id,
    partId: f.part.id,
  });
  assert.equal(Object.isFrozen(result?.part.data), true);
  assert.equal(result?.filename?.text.includes("description"), false);
  await f.controller.dispose();
  assert.equal(f.closed(), 0);
});
test("description and ordinary/code hits keep canonical part identity and never reuse filename offsets", async () => {
  const f = fixture(false);
  f.hit.sourceType = "code";
  const result = await f.controller.resolve(f.hit);
  assert.equal(result?.part.id, f.part.id);
  assert.equal(result?.filename, null);
  assert.deepEqual(
    f.calls.map((c) => c.operation),
    ["readEntity", "readEntity", "resolveConversationSearchHit"],
  );
  const image = fixture();
  image.hit.position.sectionPath = ["data", "description"];
  image.hit.position.end = 4;
  image.setResolve({
    threadId: image.message.threadId,
    messageId: image.message.id,
    partId: image.part.id,
    position: image.hit.position,
  });
  assert.equal((await image.controller.resolve(image.hit))?.filename, null);
});
test("refuses wrong part/message/thread ownership and foreign attachment paths before displaying content", async () => {
  for (const alter of [
    (f: ReturnType<typeof fixture>) => {
      f.part.messageId = id();
    },
    (f: ReturnType<typeof fixture>) => {
      f.message.threadId = id();
    },
    (f: ReturnType<typeof fixture>) => {
      f.hit.position.sectionPath[1] = id();
    },
  ]) {
    const f = fixture();
    alter(f);
    assert.equal(await f.controller.resolve(f.hit), null);
    assert.match(f.controller.getSnapshot().error!, /original location/);
    assert.equal(f.controller.getSnapshot().focus, null);
  }
});
test("strict worker refusal after equal-length rename or tombstone never displays a current field at stale offsets", async () => {
  for (const reason of ["same-length filename changed", "message tombstoned"]) {
    const f = fixture();
    f.attachment.filename = "winter-chart.png";
    f.setResolve(Object.assign(Error(reason), { code: "CONFLICT" }));
    assert.equal(await f.controller.resolve(f.hit), null);
    assert.match(f.controller.getSnapshot().error!, /Search again/);
    assert.equal(f.controller.getSnapshot().focus, null);
  }
});
test("refuses a resolver response with changed position, path, or target binding", async () => {
  for (const field of ["position", "messageId", "partId"]) {
    const f = fixture();
    const reply: any = {
      threadId: f.message.threadId,
      messageId: f.message.id,
      partId: f.part.id,
      position: structuredClone(f.hit.position),
    };
    if (field === "position") reply.position.start = 1;
    else reply[field] = id();
    f.setResolve(reply);
    assert.equal(await f.controller.resolve(f.hit), null);
    assert.equal(f.controller.getSnapshot().focus, null);
  }
});
test("snapshots locator input before await, retains one admitted lookup, and invalidates stale navigation completion", async () => {
  const f = fixture();
  let release!: () => void;
  f.delay(
    new Promise<void>((r) => {
      release = r;
    }),
  );
  const original = structuredClone(f.hit);
  const pending = f.controller.resolve(f.hit);
  f.hit.position.sectionPath[1] = id();
  f.hit.messageId = id();
  assert.equal(await f.controller.resolve(original), null);
  release();
  const resolved = await pending;
  assert.equal(resolved?.messageId, original.messageId);
  assert.deepEqual(resolved?.position, original.position);
  const g = fixture();
  g.delay(
    new Promise<void>((r) => {
      release = r;
    }),
  );
  const late = g.controller.resolve(g.hit);
  g.controller.clear();
  release();
  assert.equal(await late, null);
  assert.equal(g.controller.getSnapshot().focus, null);
  assert.equal(g.calls.length, 1);
});
test("archive selection change and disposal drain the current read without closing shared storage or opening another target", async () => {
  const f = fixture();
  let release!: () => void;
  f.delay(
    new Promise<void>((r) => {
      release = r;
    }),
  );
  const pending = f.controller.resolve(f.hit);
  f.selection();
  release();
  assert.equal(await pending, null);
  assert.equal(await f.controller.resolve(f.hit), null);
  assert.match(f.controller.getSnapshot().error!, /selected archive changed/);
  await f.controller.dispose();
  assert.equal(f.closed(), 0);
  const g = fixture();
  g.delay(
    new Promise<void>((r) => {
      release = r;
    }),
  );
  const work = g.controller.resolve(g.hit);
  let disposed = false;
  const close = g.controller.dispose().then(() => {
    disposed = true;
  });
  await Promise.resolve();
  assert.equal(disposed, false);
  release();
  await Promise.all([work, close]);
  assert.equal(g.closed(), 0);
});
test("bounds filename display and refuses UTF16 scalar splits or out-of-range field offsets", async () => {
  const f = fixture();
  f.attachment.filename = "x".repeat(6000);
  f.hit.position.end = 6000;
  f.setResolve({
    threadId: f.message.threadId,
    messageId: f.message.id,
    partId: f.part.id,
    position: structuredClone(f.hit.position),
  });
  const value = await f.controller.resolve(f.hit);
  assert.equal(value?.filename?.text.length, 4096);
  assert.equal(value?.filename?.totalUTF16, 6000);
  for (const position of [
    { start: 1, end: 2 },
    { start: 0, end: 99 },
  ]) {
    const g = fixture();
    g.attachment.filename = "😀.png";
    Object.assign(g.hit.position, position);
    assert.equal(await g.controller.resolve(g.hit), null);
  }
});
