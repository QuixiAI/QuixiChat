import { test as base, expect, chromium, webkit } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const test = base.extend({
  context: async ({ browserName }, use) => {
    const directory = await mkdtemp(join(tmpdir(), "quixi-web-host-")),
      engine = browserName === "webkit" ? webkit : chromium,
      context = await engine.launchPersistentContext(directory, {
        headless: true,
        baseURL: "http://127.0.0.1:4196",
        acceptDownloads: true,
      });
    try {
      await use(context);
    } finally {
      await context.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
});
import { readFile } from "node:fs/promises";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/host.html?files=" + crypto.randomUUID());
  await page.evaluate(async () => {
    const { createWebHost } = await import("../src/host/index.ts");
    const binding = {
      providerId: "fixture",
      accountId: "account-a",
      destinationId: "fixture-direct",
      transportId: "direct",
    };
    const destination = {
      binding,
      baseUrl: location.origin,
      allowInsecureLoopback: true,
      routes: ["echo", "error", "stream", "idle", "redirect", "slow"].map(
        (name) => ({
          path: `/fixture/${name}`,
          methods: ["GET", "POST"] as ("GET" | "POST")[],
          headers: ["content-type"],
          ...(name === "echo" ? { query: ["after_id", "limit"] } : {}),
        }),
      ),
      credential: { header: "Authorization", prefix: "Bearer " },
      transport: {
        kind: "browser_direct" as const,
        privacy: "local" as const,
        relayIdentity: null,
      },
    };
    const host = createWebHost({
      destinations: [destination],
      fileStagingNamespace: new URL(location.href).searchParams.get("files")!,
    });
    const read = async (id: string): Promise<string> => {
      const parts: Uint8Array[] = [];
      for (;;) {
        const chunk = await host.readChunk(id);
        parts.push(chunk.bytes);
        await host.acknowledgeChunk({
          transferId: id,
          sequence: chunk.sequence,
          committedOffset: chunk.offset + chunk.bytes.length,
        });
        if (chunk.final) break;
      }
      return new TextDecoder().decode(
        new Blob(parts.map((part) => part.slice().buffer)).size === 0
          ? new Uint8Array()
          : await new Blob(
              parts.map((part) => part.slice().buffer),
            ).arrayBuffer(),
      );
    };
    const request = (path: string, override = {}) => ({
      requestId: crypto.randomUUID(),
      binding,
      method: "GET" as const,
      path: `/fixture/${path}`,
      headers: {},
      credential: null,
      bodyTransferId: null,
      timeout: { connectMs: 5_000, idleMs: 5_000, totalMs: 15_000 },
      ...override,
    });
    Object.assign(window, {
      host,
      binding,
      destination,
      read,
      request,
      createWebHost,
    });
  });
});

test.afterEach(async ({ page }) => {
  await page.evaluate(async () => {
    const w = window as any;
    await w.host?.dispose();
    const namespace = new URL(location.href).searchParams.get("files");
    if (!namespace || !/^[a-f0-9-]{36}$/.test(namespace)) return;
    try {
      const directory = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle("quixi-host-downloads");
      await directory.removeEntry(namespace, { recursive: true });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NotFoundError"))
        throw error;
    }
  });
});

// The page harness contains only synthetic values and is excluded from the production entry point.
test("session credentials bind account/destination, delete and disappear with the session", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const w = window as any;
    const secret = await w.host.storeSecret(
      crypto.randomUUID(),
      w.binding,
      new TextEncoder().encode("synthetic-secret"),
      null,
    );
    const response = await w.host.startProviderHttp(
      w.request("echo", { credential: secret }),
    );
    const body = JSON.parse(await w.read(response.bodyTransferId));
    const errors = [];
    for (const change of [
      { binding: { ...w.binding, accountId: "other" }, credential: secret },
      {
        credential: {
          ...secret,
          binding: { ...w.binding, accountId: "other" },
        },
      },
      { credential: secret, headers: { Authorization: "override" } },
      { path: "/fixture/../private", credential: secret },
    ]) {
      try {
        await w.host.startProviderHttp(w.request("echo", change));
      } catch (error) {
        errors.push((error as any).code);
      }
    }
    await w.host.deleteSecret(crypto.randomUUID(), secret);
    try {
      await w.host.startProviderHttp(w.request("echo", { credential: secret }));
    } catch (error) {
      errors.push((error as any).code);
    }
    const other = w.createWebHost({ destinations: [w.destination] });
    try {
      await other.startProviderHttp(w.request("echo", { credential: secret }));
    } catch (error) {
      errors.push((error as any).code);
    }
    return {
      body,
      errors,
      persisted: [localStorage.length, sessionStorage.length],
      capabilities: await w.host.capabilities(),
    };
  });
  expect(result.body.authorized).toBe(true);
  expect(result.errors).toEqual(Array(6).fill("INVALID_REQUEST"));
  expect(result.persisted).toEqual([0, 0]);
  expect(result.capabilities.secretPersistence).toBe("session");
  expect(result.capabilities.oauth.available).toBe(false);
  expect(result.capabilities.clipboard).toEqual({ available: true, permission: "prompt", reason: null });
});

test("clipboard writes come from a user action, stay bounded and are readable back where the engine permits", async ({
  page,
  context,
  browserName,
}) => {
  if (browserName === "chromium")
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => {
    const w = window as any;
    document.querySelector("#choose")!.addEventListener("click", () => {
      w.copied = w.host.writeClipboardText(crypto.randomUUID(), "clipboard fixture 🧪");
    });
  });
  await page.click("#choose");
  const result = await page.evaluate(async () => {
    const w = window as any;
    await w.copied;
    let bound;
    try {
      await w.host.writeClipboardText(crypto.randomUUID(), "x".repeat(262_145));
    } catch (e) {
      bound = (e as any).code;
    }
    return { bound };
  });
  expect(result.bound).toBe("INVALID_REQUEST");
  if (browserName === "chromium")
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("clipboard fixture 🧪");
});

test("verified request staging preserves bytes and rejects corrupted, oversized and released transfers", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const w = window as any;
    const bytes = new TextEncoder().encode("synthetic request body");
    const digest = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    ]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
    const staged = await w.host.beginTransfer(crypto.randomUUID(), {
      purpose: "provider_request",
      expectedBytes: bytes.length,
      expectedSha256: digest,
    });
    const errors = [];
    try {
      await w.host.writeChunk({
        transferId: staged.transferId,
        sequence: 1,
        offset: 0,
        bytes,
        final: true,
      });
    } catch (e) {
      errors.push((e as any).code);
    }
    await w.host.writeChunk({
      transferId: staged.transferId,
      sequence: 0,
      offset: 0,
      bytes,
      final: true,
    });
    try {
      await w.host.finishTransfer(crypto.randomUUID(), staged.transferId, {
        byteLength: bytes.length,
        sha256: "0".repeat(64),
      });
    } catch (e) {
      errors.push((e as any).code);
    }
    await w.host.finishTransfer(crypto.randomUUID(), staged.transferId, {
      byteLength: bytes.length,
      sha256: digest,
    });
    const response = await w.host.startProviderHttp(
      w.request("echo", {
        method: "POST",
        bodyTransferId: staged.transferId,
        headers: { "Content-Type": "text/plain" },
      }),
    );
    const body = JSON.parse(await w.read(response.bodyTransferId));
    await w.host.releaseTransfer(crypto.randomUUID(), staged.transferId);
    try {
      await w.host.writeChunk({
        transferId: staged.transferId,
        sequence: 1,
        offset: bytes.length,
        bytes,
        final: true,
      });
    } catch (e) {
      errors.push((e as any).code);
    }
    try {
      await w.host.beginTransfer(crypto.randomUUID(), {
        purpose: "provider_request",
        expectedBytes: 9_000_000,
        expectedSha256: null,
      });
    } catch (e) {
      errors.push((e as any).code);
    }
    return { body, errors };
  });
  expect(result.body.body).toBe("synthetic request body");
  expect(result.errors).toEqual([
    "INVALID_REQUEST",
    "INVALID_REQUEST",
    "NOT_FOUND",
    "UNSUPPORTED",
  ]);
});

test("real streamed response enforces acknowledgement window and cancellation releases upstream", async ({
  page,
  request,
}) => {
  const before = await (await request.get("/fixture/stats")).json();
  const result = await page.evaluate(async () => {
    const w = window as any;
    const operation = w.request("stream");
    const response = await w.host.startProviderHttp(operation);
    const chunks = [];
    for (let i = 0; i < 4; i++)
      chunks.push(await w.host.readChunk(response.bodyTransferId));
    let error;
    try {
      await w.host.readChunk(response.bodyTransferId);
    } catch (e) {
      error = (e as any).code;
    }
    const first = chunks[0];
    await w.host.acknowledgeChunk({
      transferId: first.transferId,
      sequence: first.sequence,
      committedOffset: first.bytes.length,
    });
    const next = await w.host.readChunk(response.bodyTransferId);
    const cancel = await w.host.cancel(operation.requestId);
    let released;
    try {
      await w.host.readChunk(response.bodyTransferId);
    } catch (e) {
      released = (e as any).code;
    }
    return {
      error,
      released,
      cancel,
      sequence: next.sequence,
      sizes: chunks.map((chunk) => chunk.bytes.length),
    };
  });
  expect(result.error).toBe("OVERLOADED");
  expect(result.sequence).toBe(4);
  expect(result.released).toBe("NOT_FOUND");
  expect(result.cancel.externalEffect).toBe("may_have_occurred");
  expect(result.sizes.every((size: number) => size > 0 && size <= 65536)).toBe(
    true,
  );
  await expect
    .poll(
      async () =>
        (await (await request.get("/fixture/stats")).json()).disconnected,
    )
    .toBeGreaterThan(before.disconnected);
});

test("HTTP errors, redirect rejection, pre-header cancellation and idle deadlines are typed", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const w = window as any;
    const response = await w.host.startProviderHttp(w.request("error"));
    await w.read(response.bodyTransferId);
    const errors = [];
    try {
      await w.host.startProviderHttp(w.request("redirect"));
    } catch (e) {
      errors.push((e as any).code);
    }
    const slow = w.request("slow");
    const pending = w.host.startProviderHttp(slow).catch((e: any) => e.code);
    await w.host.cancel(slow.requestId);
    errors.push(await pending);
    const idle = await w.host.startProviderHttp(
      w.request("idle", {
        timeout: { connectMs: 1000, idleMs: 60, totalMs: 2000 },
      }),
    );
    const first = await w.host.readChunk(idle.bodyTransferId);
    await w.host.acknowledgeChunk({
      transferId: first.transferId,
      sequence: first.sequence,
      committedOffset: first.bytes.length,
    });
    try {
      await w.host.readChunk(idle.bodyTransferId);
    } catch (e) {
      errors.push((e as any).code);
    }
    return { status: response.status, headers: response.headers, errors };
  });
  expect(result.status).toBe(429);
  expect(result.headers["retry-after"]).toBe("3");
  expect(result.headers["set-cookie"]).toBeUndefined();
  expect(result.errors).toEqual(["IO_ERROR", "CANCELLED", "IO_ERROR"]);
});

test("actual browser file selection streams fixture bytes and releases file handles", async ({
  page,
}) => {
  await page.evaluate(() => {
    const w = window as any;
    document.querySelector("#choose")!.addEventListener("click", () => {
      w.selection = w.host.chooseFiles(crypto.randomUUID(), {
        multiple: false,
        mediaTypes: ["text/plain"],
      });
    });
  });
  const chooser = page.waitForEvent("filechooser");
  await page.click("#choose");
  await (
    await chooser
  ).setFiles({
    name: "synthetic.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("fixture-file-".repeat(20_000)),
  });
  const result = await page.evaluate(async () => {
    const w = window as any;
    const [file] = await w.selection;
    const transfer = await w.host.openFileTransfer(
      crypto.randomUUID(),
      file.id,
    );
    const text = await w.read(transfer.transferId);
    await w.host.releaseFile(crypto.randomUUID(), file.id);
    let error;
    try {
      await w.host.openFileTransfer(crypto.randomUUID(), file.id);
    } catch (e) {
      error = (e as any).code;
    }
    return { name: file.name, size: text.length, error };
  });
  expect(result).toEqual({
    name: "synthetic.txt",
    size: 260_000,
    error: "NOT_FOUND",
  });
});

test("registered query names are encoded onto the path and other names are refused before dispatch", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const w = window as any;
    const before = (await (await fetch("/fixture/stats")).json()).dispatched;
    const response = await w.host.startProviderHttp(
      w.request("echo", { query: { after_id: "model a&b", limit: "1000" } }),
    );
    const echoed = JSON.parse(await w.read(response.bodyTransferId));
    const refused: string[] = [];
    for (const query of [
      { unexpected: "1" },
      { after_id: "x".repeat(257) },
      { after_id: "line\nbreak" },
      { AFTER_ID: "1" },
    ]) {
      try {
        await w.host.startProviderHttp(w.request("echo", { query }));
        refused.push("dispatched");
      } catch (e) {
        refused.push((e as any).code);
      }
    }
    try {
      await w.host.startProviderHttp(w.request("error", { query: { after_id: "1" } }));
      refused.push("dispatched");
    } catch (e) {
      refused.push((e as any).code);
    }
    const after = (await (await fetch("/fixture/stats")).json()).dispatched;
    return { url: echoed.url, status: response.status, refused, dispatched: after - before };
  });
  expect(result.status).toBe(200);
  expect(result.url).toBe("/fixture/echo?after_id=model+a%26b&limit=1000");
  expect(result.refused).toEqual(["INVALID_REQUEST", "INVALID_REQUEST", "INVALID_REQUEST", "INVALID_REQUEST", "INVALID_REQUEST"]);
  expect(result.dispatched).toBe(1);
});

test("adopted dropped files stream through the selected-file handle path and release", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const w = window as any;
    const blob = new Blob([new TextEncoder().encode("dropped-file-".repeat(20_000))], { type: "text/plain" });
    const [file] = await w.host.adoptFiles(crypto.randomUUID(), [
      {
        name: "dropped.txt",
        mediaType: "text/plain",
        byteLength: blob.size,
        read: async (start: number, end: number) =>
          new Uint8Array(await blob.slice(start, end).arrayBuffer()),
      },
    ]);
    const transfer = await w.host.openFileTransfer(crypto.randomUUID(), file.id);
    const text = await w.read(transfer.transferId);
    await w.host.releaseFile(crypto.randomUUID(), file.id);
    let error;
    try {
      await w.host.openFileTransfer(crypto.randomUUID(), file.id);
    } catch (e) {
      error = (e as any).code;
    }
    let invalid;
    try {
      await w.host.adoptFiles(crypto.randomUUID(), [
        { name: "", mediaType: null, byteLength: 1, read: async () => new Uint8Array() },
      ]);
    } catch (e) {
      invalid = (e as any).code;
    }
    return { name: file.name, mediaType: file.mediaType, byteLength: file.byteLength, size: text.length, error, invalid };
  });
  expect(result).toEqual({
    name: "dropped.txt",
    mediaType: "text/plain",
    byteLength: 260_000,
    size: 260_000,
    error: "NOT_FOUND",
    invalid: "INVALID_REQUEST",
  });
});

test("configured relay separates authorization credentials and fixes the forwarding route", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const w = window as any;
    const destination = structuredClone(w.destination);
    destination.transport = {
      kind: "relay",
      privacy: "self_hosted_remote",
      relayIdentity: "synthetic operator",
    };
    destination.relayDestinationId = "fixture-server-registration";
    const host = w.createWebHost({
      destinations: [destination],
      fileStagingNamespace: new URL(location.href).searchParams.get("files")!,
    });
    const before = await host.capabilities();
    await host.setRelayAuthorization(
      destination.binding.destinationId,
      new TextEncoder().encode("synthetic-relay"),
    );
    const credential = await host.storeSecret(
      crypto.randomUUID(),
      destination.binding,
      new TextEncoder().encode("synthetic-secret"),
      null,
    );
    const response = await host.startProviderHttp(
      w.request("echo", { credential }),
    );
    let text = "";
    for (;;) {
      const chunk = await host.readChunk(response.bodyTransferId);
      text += new TextDecoder().decode(chunk.bytes);
      await host.acknowledgeChunk({
        transferId: chunk.transferId,
        sequence: chunk.sequence,
        committedOffset: chunk.offset + chunk.bytes.length,
      });
      if (chunk.final) break;
    }
    await host.dispose();
    return { before, body: JSON.parse(text) };
  });
  expect(result.before.providerTransports[0].capability.available).toBe(false);
  expect(result.body).toMatchObject({
    relayAuthorized: true,
    providerAuthorized: true,
    destination: "fixture-server-registration",
    method: "GET",
    path: "/fixture/echo",
  });
});

test("bounded fallback export downloads verified bytes in the actual browser", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const w = window as any;
    const bytes = new TextEncoder().encode("synthetic-export-".repeat(10_000));
    const digest = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    ]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
    const transfer = await w.host.beginTransfer(crypto.randomUUID(), {
      purpose: "file_save",
      expectedBytes: bytes.length,
      expectedSha256: digest,
    });
    let sequence = 0;
    for (let offset = 0; offset < bytes.length; offset += 65536) {
      const chunk = bytes.slice(offset, offset + 65536);
      await w.host.writeChunk({
        transferId: transfer.transferId,
        sequence: sequence++,
        offset,
        bytes: chunk,
        final: offset + chunk.length === bytes.length,
      });
    }
    await w.host.finishTransfer(crypto.randomUUID(), transfer.transferId, {
      byteLength: bytes.length,
      sha256: digest,
    });
    // Exercise the documented fallback even when Chromium offers a native save picker.
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: undefined,
    });
    document.querySelector("#save")!.addEventListener("click", () => {
      w.saved = w.host.saveFileTransfer(crypto.randomUUID(), {
        name: "synthetic-export.txt",
        mediaType: "text/plain",
        transferId: transfer.transferId,
      });
    });
  });
  const downloaded = page.waitForEvent("download");
  await page.click("#save");
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("synthetic-export.txt");
  expect(await readFile((await download.path())!, "utf8")).toBe(
    "synthetic-export-".repeat(10_000),
  );
  await page.evaluate(async () => {
    await (window as any).saved;
    await (window as any).host.dispose();
  });
});

test("concurrency limits and disposal close active streams without leaking credentials", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const w = window as any;
    const streams = [];
    for (let i = 0; i < 4; i++)
      streams.push(await w.host.startProviderHttp(w.request("stream")));
    let overloaded;
    try {
      await w.host.startProviderHttp(w.request("stream"));
    } catch (e) {
      overloaded = (e as any).code;
    }
    await w.host.dispose();
    let closed;
    try {
      await w.host.readChunk(streams[0].bodyTransferId);
    } catch (e) {
      closed = (e as any).code;
    }
    return { overloaded, closed };
  });
  expect(result).toEqual({ overloaded: "OVERLOADED", closed: "CLOSED" });
});

test("aggregate staging limit recovers after release and verification overload", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const w = window as any;
    const bytes = new Uint8Array(8_388_608);
    const digest = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    ]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
    const ids = [];
    for (let i = 0; i < 2; i++) {
      const transfer = await w.host.beginTransfer(crypto.randomUUID(), {
        purpose: "provider_request",
        expectedBytes: bytes.length,
        expectedSha256: digest,
      });
      ids.push(transfer.transferId);
      for (let offset = 0; offset < bytes.length; offset += 65536)
        await w.host.writeChunk({
          transferId: transfer.transferId,
          sequence: offset / 65536,
          offset,
          bytes: bytes.subarray(offset, offset + 65536),
          final: offset + 65536 === bytes.length,
        });
    }
    let overloaded;
    try {
      await w.host.finishTransfer(crypto.randomUUID(), ids[0], {
        byteLength: bytes.length,
        sha256: digest,
      });
    } catch (e) {
      overloaded = (e as any).code;
    }
    await w.host.releaseTransfer(crypto.randomUUID(), ids[1]);
    const finished = await w.host.finishTransfer(crypto.randomUUID(), ids[0], {
      byteLength: bytes.length,
      sha256: digest,
    });
    await w.host.dispose();
    return { overloaded, state: finished.state };
  });
  expect(result).toEqual({
    overloaded: "OVERLOADED",
    state: "verified_staged",
  });
});

test("32 MiB disk-backed download survives immediate transfer release and reload until explicit cleanup", async ({
  page,
}) => {
  const expected = await page.evaluate(async () => {
    const w = window as any,
      { sha256, bytesToHex } = await import("./hashes.ts");
    const length = 32 * 1048576 + 17,
      hash = sha256.create();
    const transfer = await w.host.beginTransfer(crypto.randomUUID(), {
      purpose: "file_save",
      expectedBytes: length,
      expectedSha256: null,
    });
    for (
      let offset = 0, sequence = 0;
      offset < length;
      offset += 65536, sequence++
    ) {
      const bytes = new Uint8Array(Math.min(65536, length - offset));
      for (let i = 0; i < bytes.length; i++) bytes[i] = (offset + i) % 251;
      hash.update(bytes);
      await w.host.writeChunk({
        transferId: transfer.transferId,
        sequence,
        offset,
        bytes,
        final: offset + bytes.length === length,
      });
    }
    const digest = bytesToHex(hash.digest());
    await w.host.finishTransfer(crypto.randomUUID(), transfer.transferId, {
      byteLength: length,
      sha256: digest,
    });
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: undefined,
    });
    document.querySelector("#save")!.addEventListener("click", () => {
      w.saved = (async () => {
        await w.host.saveFileTransfer(crypto.randomUUID(), {
          name: "large-synthetic.tar",
          mediaType: "application/x-tar",
          transferId: transfer.transferId,
        });
        await w.host.releaseTransfer(crypto.randomUUID(), transfer.transferId);
      })();
    });
    return { digest, length, id: transfer.transferId };
  });
  const pending = page.waitForEvent("download");
  await page.click("#save");
  const download = await pending;
  await page.evaluate(() => (window as any).saved);
  const { createHash } = await import("node:crypto"),
    { createReadStream } = await import("node:fs"),
    hash = createHash("sha256");
  let length = 0;
  for await (const bytes of createReadStream((await download.path())!)) {
    length += bytes.length;
    hash.update(bytes);
  }
  expect(length).toBe(expected.length);
  expect(hash.digest("hex")).toBe(expected.digest);
  expect(
    await page.evaluate(() => (window as any).host.listTemporaryDownloads()),
  ).toMatchObject([
    {
      id: expected.id,
      name: "large-synthetic.tar",
      byteLength: expected.length,
    },
  ]);
  await page.reload();
  const retained = await page.evaluate(async (id) => {
    const { createWebHost } = await import("../src/host/index.ts");
    const host = createWebHost({
        destinations: [],
        fileStagingNamespace: new URL(location.href).searchParams.get("files")!,
      }),
      before = await host.listTemporaryDownloads();
    await host.clearTemporaryDownload(crypto.randomUUID(), id);
    const after = await host.listTemporaryDownloads();
    await host.dispose();
    return { before, after };
  }, expected.id);
  expect(retained.before).toHaveLength(1);
  expect(retained.after).toEqual([]);
});

test("disk save streams to an injected picker destination with 64 KiB writes and cancellation leaves original intact", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const w = window as any,
      bytes = new TextEncoder().encode("safe original"),
      directory = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle("synthetic-save-target", { create: true }),
      handle = await directory.getFileHandle("fixture.bin", { create: true });
    let initial = await handle.createWritable();
    await initial.write(bytes);
    await initial.close();
    const body = new Uint8Array(2 * 1048576 + 13),
      hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))]
        .map((n) => n.toString(16).padStart(2, "0"))
        .join(""),
      transfer = await w.host.beginTransfer(crypto.randomUUID(), {
        purpose: "file_save",
        expectedBytes: body.length,
        expectedSha256: hash,
      });
    for (
      let offset = 0, sequence = 0;
      offset < body.length;
      offset += 65536, sequence++
    )
      await w.host.writeChunk({
        transferId: transfer.transferId,
        sequence,
        offset,
        bytes: body.slice(offset, offset + 65536),
        final: offset + 65536 >= body.length,
      });
    await w.host.finishTransfer(crypto.randomUUID(), transfer.transferId, {
      byteLength: body.length,
      sha256: hash,
    });
    const requestId = crypto.randomUUID();
    let peak = 0,
      calls = 0;
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: async () => ({
        createWritable: async () => {
          const writable = await handle.createWritable();
          return {
            async write(chunk: Uint8Array<ArrayBuffer>) {
              peak = Math.max(peak, chunk.length);
              await writable.write(chunk);
              if (++calls === 2) await w.host.cancel(requestId);
            },
            close: () => writable.close(),
            abort: () => writable.abort(),
          };
        },
      }),
    });
    let cancelled;
    try {
      await w.host.saveFileTransfer(requestId, {
        name: "fixture.bin",
        mediaType: "application/octet-stream",
        transferId: transfer.transferId,
      });
    } catch (error) {
      cancelled = (error as any).code;
    }
    const original = await (await handle.getFile()).text();
    await w.host.releaseTransfer(crypto.randomUUID(), transfer.transferId);
    return { peak, calls, cancelled, original };
  });
  expect(result).toEqual({
    peak: 65536,
    calls: 2,
    cancelled: "CANCELLED",
    original: "safe original",
  });
});

test("retained download admission stays capped across host disposal and explicit cleanup frees a slot", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { DiskStages } = await import("../src/host/disk-stages.ts"),
      namespace = crypto.randomUUID(),
      hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    let disk = new DiskStages(namespace);
    const stage = async () => {
      const transfer = await disk.begin(crypto.randomUUID(), {
        expectedBytes: 0,
        expectedSha256: hash,
      });
      await disk.write({
        transferId: transfer.transferId,
        sequence: 0,
        offset: 0,
        bytes: new Uint8Array(),
        final: true,
      });
      await disk.finish(crypto.randomUUID(), transfer.transferId, {
        byteLength: 0,
        sha256: hash,
      });
      return transfer.transferId;
    };
    for (let count = 0; count < 4; count++) {
      const id = await stage();
      await disk.handoff(id, "synthetic-" + count + ".tar");
      await disk.release(id);
    }
    await disk.dispose();
    disk = new DiskStages(namespace);
    const list = await disk.listRetained(),
      next = await stage();
    let overloaded;
    try {
      await disk.handoff(next, "fifth.tar");
    } catch (error) {
      overloaded = (error as any).code;
    }
    await disk.clearRetained(list[0]!.id);
    await disk.handoff(next, "replacement.tar");
    await disk.release(next);
    const remaining = await disk.listRetained();
    for (const item of remaining) await disk.clearRetained(item.id);
    await disk.dispose();
    return { overloaded, before: list.length, after: remaining.length };
  });
  expect(result).toEqual({ overloaded: "OVERLOADED", before: 4, after: 4 });
});
