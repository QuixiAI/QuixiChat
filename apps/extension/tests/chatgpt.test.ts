import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classifyHttpFailure, conversationPage, conversationRecord, ExtractionError, EXPORT_ARRAY, selectNewer, serializeRecord, sessionAccessToken } from "../src/chatgpt.ts";

const fixture = JSON.parse(await readFile(new URL("../../../packages/importers/tests/fixtures/chatgpt-observed.synthetic.json", import.meta.url), "utf8")) as Record<string, unknown>[];

test("session, list and conversation shapes are checked before anything is trusted", () => {
  assert.equal(sessionAccessToken({ accessToken: "tok" }), "tok");
  assert.throws(() => sessionAccessToken({}), (error: ExtractionError) => error.code === "session_expired");
  assert.throws(() => sessionAccessToken("nope"), (error: ExtractionError) => error.code === "format_changed");
  const page = conversationPage({ items: [{ id: "a", title: "A", update_time: "2026-01-02T00:00:00Z", create_time: 1700000000 }], total: 1 });
  assert.deepEqual(page, { items: [{ id: "a", title: "A", updateTime: Date.parse("2026-01-02T00:00:00Z") / 1000, createTime: 1700000000 }], total: 1 });
  assert.throws(() => conversationPage({ items: [{ title: "no id" }] }), (error: ExtractionError) => error.code === "format_changed");
  assert.throws(() => conversationPage({ conversations: [] }), (error: ExtractionError) => error.code === "format_changed");
  const record = conversationRecord(fixture[0], "original-synthetic-conversation");
  assert.equal(record.record.conversation_id, "original-synthetic-conversation");
  assert.equal(record.attachments, 1);
  assert.equal(record.unavailableAttachments, 1, "web extraction never carries attachment bytes");
  assert.throws(() => conversationRecord(fixture[0], "other"), (error: ExtractionError) => error.code === "format_changed");
  assert.throws(() => conversationRecord({ ...fixture[0], mapping: [] }, "original-synthetic-conversation"), (error: ExtractionError) => error.code === "format_changed");
  assert.throws(() => conversationRecord({ ...fixture[0], mapping: { x: { message: null } } }, "original-synthetic-conversation"), /parent/);
  assert.equal(classifyHttpFailure(401).code, "session_expired");
  assert.equal(classifyHttpFailure(429).code, "unavailable");
  assert.equal(classifyHttpFailure(503).code, "unavailable");
  assert.equal(classifyHttpFailure(404).code, "format_changed");
});

test("serialized records form an export-compatible conversations array", () => {
  const first = conversationRecord(fixture[0], "original-synthetic-conversation").record;
  const text = EXPORT_ARRAY.open + serializeRecord(first) + EXPORT_ARRAY.separator + serializeRecord(first) + EXPORT_ARRAY.close;
  const parsed = JSON.parse(text) as Record<string, unknown>[];
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0]!.mapping, fixture[0]!.mapping, "records are verbatim");
});

test("only-new selection keeps conversations updated after the checkpoint and those without a timestamp", () => {
  const items = [{ id: "old", title: "", updateTime: 10, createTime: null }, { id: "new", title: "", updateTime: 20, createTime: null }, { id: "unknown", title: "", updateTime: null, createTime: null }];
  assert.deepEqual(selectNewer(items, 10).map((item) => item.id), ["new", "unknown"]);
  assert.equal(selectNewer(items, null).length, 3);
});
