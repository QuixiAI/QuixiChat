import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  encodeTarEntry,
  tarEnd,
  TarDecoder,
} from "../../src/worker/archives/tar.ts";
const encoder = new TextEncoder();
async function* source(bytes: Uint8Array) {
  for (let i = 0; i < bytes.length; i += 65536)
    yield bytes.subarray(i, i + 65536);
}
async function fixture() {
  const chunks: Uint8Array[] = [];
  for (const [path, text] of [
    ["format.json", '{"format":"quixi","version":1}'],
    ["history.md", "# User\n\nHello 🧪\0tail\n"],
    ["blobs/" + "a".repeat(64), "source bytes"],
  ] as const)
    for await (const chunk of encodeTarEntry(
      { path, byteLength: encoder.encode(text).length },
      source(encoder.encode(text)),
    ))
      chunks.push(chunk);
  chunks.push(tarEnd());
  return Buffer.concat(chunks);
}
test("ordinary system tar extracts the streamed container; fragmented decode preserves bytes", async () => {
  const bytes = await fixture(),
    directory = await mkdtemp(resolve(tmpdir(), "quixi-tar-"));
  try {
    await writeFile(resolve(directory, "archive.tar"), bytes);
    execFileSync("tar", ["-xf", "archive.tar"], { cwd: directory });
    assert.equal(
      await readFile(resolve(directory, "history.md"), "utf8"),
      "# User\n\nHello 🧪\0tail\n",
    );
    for (const width of [1, 511, 512, 65536]) {
      const files = new Map<string, Uint8Array[]>();
      let path = "";
      const parser = new TarDecoder({
        async start(entry) {
          assert(!files.has(entry.path));
          path = entry.path;
          files.set(path, []);
        },
        async write(bytes) {
          files.get(path)!.push(bytes.slice());
        },
        async end() {},
      });
      for (let i = 0; i < bytes.length; i += width)
        await parser.push(bytes.subarray(i, i + width));
      parser.finish();
      assert.equal(
        Buffer.concat(files.get("history.md")!).toString(),
        "# User\n\nHello 🧪\0tail\n",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("truncation, checksum damage, links, traversal, duplicate sink rejection and trailing data fail", async () => {
  const original = await fixture();
  const sink = () => {
    const seen = new Set<string>();
    return {
      async start(entry: { path: string }) {
        if (seen.has(entry.path)) throw new Error("duplicate");
        seen.add(entry.path);
      },
      async write() {},
      async end() {},
    };
  };
  for (const input of [
    original.subarray(0, -512),
    Buffer.from(original),
    Buffer.concat([original, Buffer.from([1])]),
  ]) {
    if (input.length === original.length) input[0] = input[0]! ^ 1;
    const parser = new TarDecoder(sink());
    await assert.rejects(async () => {
      for (let i = 0; i < input.length; i += 65536)
        await parser.push(input.subarray(i, i + 65536));
      parser.finish();
    });
  }
  await assert.rejects(async () => {
    for await (const chunk of encodeTarEntry(
      { path: "../escape", byteLength: 0 },
      source(new Uint8Array()),
    ))
      void chunk;
  }, /path/);
  const entry: Uint8Array[] = [];
  for await (const chunk of encodeTarEntry(
    { path: "format.json", byteLength: 0 },
    source(new Uint8Array()),
  ))
    entry.push(chunk);
  const parser = new TarDecoder(sink());
  await parser.push(entry[0]!);
  await assert.rejects(parser.push(entry[0]!), /duplicate/);
  const link = Buffer.from(entry[0]!);
  link[156] = 50;
  link.fill(32, 148, 156);
  link.write(
    link
      .reduce((a, b) => a + b, 0)
      .toString(8)
      .padStart(6, "0") + "\0 ",
    148,
  );
  await assert.rejects(new TarDecoder(sink()).push(link), /entry type/);
});
test("large PAX entry headers are emitted without allocating the declared body", async () => {
  const size = 8 ** 11,
    iterator = encodeTarEntry(
      { path: "quixi.sqlite", byteLength: size },
      source(new Uint8Array()),
    );
  const first = await iterator.next();
  assert.equal(first.value![156], 120);
  const pax = await iterator.next();
  assert.match(new TextDecoder().decode(pax.value!), /size=8589934592/);
  await iterator.return(undefined);
});
