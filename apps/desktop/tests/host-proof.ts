import { exerciseRegionalHost } from './regional-host-proof.ts';
import { exerciseProviderHost } from '../../../packages/providers/tests/host-proof.ts';
import { createDesktopHost } from "../src/host/index.ts";
import { invoke } from "@tauri-apps/api/core";
import type { ByteChunk, HostClient, ProviderHttpRequest, SecretHandle } from "@quixi/core/contracts";

declare global { interface Window { __QUIXI_HOST_PROOF__: { phase: "write" | "retarget" | "restart" | "dialogs" | "providers" | "regions"; credential: SecretHandle | null; fileFixture?: { sha256: string; bytes: number } | null } } }
const id = () => crypto.randomUUID();
const encoder = new TextEncoder();
const binding = { providerId: "synthetic", accountId: "synthetic-account", destinationId: "synthetic-local", transportId: "native-proof" };
const request = (path: string, overrides: Partial<ProviderHttpRequest> = {}): ProviderHttpRequest => ({ requestId: id(), binding, method: "GET", path, headers: {}, credential: null, bodyTransferId: null, timeout: { connectMs: 3_000, idleMs: 3_000, totalMs: 10_000 }, ...overrides });
async function read(host: HostClient, transferId: string): Promise<string> {
  const chunks: Uint8Array[] = []; let length = 0;
  for (;;) {
    const chunk = await host.readChunk(transferId); length += chunk.bytes.length;
    if (length > 1_048_576) throw new Error("Synthetic result exceeds proof bound");
    chunks.push(chunk.bytes); await host.acknowledgeChunk({ transferId, sequence: chunk.sequence, committedOffset: chunk.offset + chunk.bytes.length });
    if (chunk.final) break;
  }
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return new TextDecoder().decode(bytes);
}
async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join(""); }
async function run(): Promise<void> {
  const config = window.__QUIXI_HOST_PROOF__;
  const checks: string[] = [];
  let retained: SecretHandle | null = null;
  const check = (condition: unknown, name: string): void => { if (!condition) throw new Error(`Check failed: ${name}`); checks.push(name); };
  const rejects = async (operation: () => Promise<unknown>, code: string, name: string): Promise<void> => { try { await operation(); } catch (value) { check((value as { code?: unknown }).code === code, name); return; } throw new Error(`Expected rejection: ${name}`); };
  let host: Awaited<ReturnType<typeof createDesktopHost>> | undefined;
  let other: Awaited<ReturnType<typeof createDesktopHost>> | undefined;
  let report: Record<string, unknown>;
  let fileEvidence: unknown = null;
  let providerEvidence: unknown = null;
  try {
    host = await createDesktopHost(); const capabilities = await host.capabilities();
    check(host.secretStore.available, "actual macOS keychain backend initialized");
    check(capabilities.providerTransports[0]?.kind === "native_direct" && capabilities.providerTransports[0]?.privacy === "local", "native registry reports local transport");
    check(!capabilities.oauth.available && capabilities.nativeFiles.available && !capabilities.notifications.available, "native files available while OAuth and notifications remain unavailable");
    const unknown = await host.cancel(id());
    check(unknown.outcome === "unknown_outcome" && unknown.externalEffect === "may_have_occurred", "untracked or OS-keychain cancellation never claims prevention of an external commit");
    if (config.phase === "regions") {
      const evidence = await exerciseRegionalHost(host);
      checks.push(...evidence.checks); providerEvidence = evidence;
    } else if (config.phase === "providers") {
      const evidence = await exerciseProviderHost(host, {
        'openai-compatible': {providerId:'openai-compatible',accountId:'synthetic-account',destinationId:'openai-compatible',transportId:'native-provider-proof'},
        anthropic: {providerId:'anthropic',accountId:'synthetic-account',destinationId:'anthropic',transportId:'native-provider-proof'},
      });
      checks.push(...evidence.checks); providerEvidence = evidence.results;
    } else if (config.phase === "dialogs") {
      const files = await host.chooseFiles(id(), { multiple: false, mediaTypes: ["application/octet-stream"] });
      check(files.length === 0, "actual native open panel presentation and programmatic cancel return no file grant");
      const bytes = new Uint8Array([1,2,3]); const sha256 = await digest(bytes);
      const staged = await host.beginTransfer(id(), { purpose: "file_save", expectedBytes: bytes.length, expectedSha256: sha256 });
      await host.writeChunk({ transferId: staged.transferId, sequence:0,offset:0,bytes,final:true });
      await host.finishTransfer(id(),staged.transferId,{byteLength:bytes.length,sha256});
      await rejects(() => host!.saveFileTransfer(id(), { name:"synthetic-dialog-only.bin",mediaType:"application/octet-stream",transferId:staged.transferId }), "CANCELLED", "actual native save panel presentation and programmatic cancel produce no destination write");
      await host.releaseTransfer(id(),staged.transferId);
      fileEvidence = await invoke<Record<string,number>>("native_host_proof_stats");
      check((fileEvidence as Record<string,number>).nativePanelsCancelled === 2, "actual AppKit file panels were observed and dismissed through their sheet callback");
    } else if (config.phase === "retarget") {
      await rejects(() => host!.openSecret(id(), binding), "INVALID_REQUEST", "opaque reopen rejects a retargeted credential authority");
      if (!config.credential) throw new Error("Retarget proof requires an existing synthetic handle");
      retained = config.credential;
      await rejects(() => host!.startProviderHttp(request("/echo", { credential: retained })), "INVALID_REQUEST", "native keychain prevents retargeting an existing binding to another origin");
    } else if (config.phase === "restart") {
      if (!config.credential) throw new Error("Restart requires the synthetic credential handle");
      const reopened = await host.openSecret(id(), binding);
      check(reopened?.id === config.credential.id, "binding-only opaque handle reopen survives complete native process restart");
      const response = await host.startProviderHttp(request("/echo", { credential: reopened }));
      check(JSON.parse(await read(host, response.bodyTransferId!)).authorized === true, "OS keychain credential survives complete native process restart");
      await host.deleteSecret(id(), config.credential);
      check(await host.openSecret(id(), binding) === null, "binding-only reopen observes confirmed credential deletion");
      await rejects(() => host!.startProviderHttp(request("/echo", { credential: config.credential })), "NOT_FOUND", "persistent synthetic credential removed from OS keychain");
    } else {
      await rejects(() => host!.storeSecret(id(), binding, new Uint8Array(16_385), null), "INVALID_REQUEST", "bridge rejects oversized credentials before IPC allocation");
      const original = await host.storeSecret(id(), binding, encoder.encode("synthetic-original"), null);
      check((await host.openSecret(id(), binding))?.id === original.id, "keychain binding reopens the newly stored opaque handle");
      await rejects(() => host!.storeSecret(id(), binding, encoder.encode("conflicting"), null), "CONFLICT", "native duplicate allocation requires the current replacement handle");
      retained = await host.storeSecret(id(), binding, encoder.encode("synthetic-secret"), original);
      check((await host.openSecret(id(), binding))?.id === retained.id, "keychain association rotates to the replacement handle");
      await host.deleteSecret(id(), original);
      check((await host.openSecret(id(), binding))?.id === retained.id, "deleting an old handle cannot remove its replacement");
      check(retained.id !== original.id && retained.persistence === "native", "native keychain replacement produces a new opaque handle");
      await rejects(() => host!.startProviderHttp(request("/echo", { credential: original })), "NOT_FOUND", "old keychain credential deleted by replacement");
      const response = await host.startProviderHttp(request("/echo", { credential: retained }));
      check(JSON.parse(await read(host, response.bodyTransferId!)).authorized === true, "native HTTP injects the bound OS keychain credential");
      await rejects(() => host!.startProviderHttp(request("/echo", { binding: { ...binding, accountId: "other" }, credential: retained })), "INVALID_REQUEST", "native registry rejects another account");
      await rejects(() => host!.startProviderHttp(request("/echo", { credential: { ...retained!, binding: { ...binding, accountId: "other" } } })), "INVALID_REQUEST", "native keychain validates handle binding independently");
      await rejects(() => host!.startProviderHttp(request("/echo", { headers: { Authorization: "override" } })), "INVALID_REQUEST", "caller cannot override native authentication headers");
      await rejects(() => host!.startProviderHttp(request("http://unregistered.invalid/")), "INVALID_REQUEST", "native registry rejects an arbitrary destination URL");
      await rejects(() => host!.startProviderHttp(request("/redirect")), "IO_ERROR", "native redirects are rejected");
      const bytes = encoder.encode("synthetic-native-body-".repeat(8_000)); const hash = await digest(bytes);
      const staged = await host.beginTransfer(id(), { purpose: "provider_request", expectedBytes: bytes.length, expectedSha256: hash });
      for (let offset = 0, sequence = 0; offset < bytes.length; offset += 65_536, sequence++) { const part = bytes.slice(offset, offset + 65_536); await host.writeChunk({ transferId: staged.transferId, sequence, offset, bytes: part, final: offset + part.length === bytes.length }); }
      await rejects(() => host!.finishTransfer(id(), staged.transferId, { byteLength: bytes.length, sha256: "0".repeat(64) }), "INVALID_REQUEST", "native staged digest mismatch rejected");
      await host.finishTransfer(id(), staged.transferId, { byteLength: bytes.length, sha256: hash });
      const posted = await host.startProviderHttp(request("/echo", { method: "POST", bodyTransferId: staged.transferId, headers: { "Content-Type": "text/plain" } }));
      check(JSON.parse(await read(host, posted.bodyTransferId!)).sha256 === hash, "binary IPC request staging preserves the complete body");
      other = await createDesktopHost();
      await rejects(() => other!.startProviderHttp(request("/echo", { method: "POST", bodyTransferId: staged.transferId })), "INVALID_REQUEST", "native transfer IDs are isolated between sessions");
      await host.releaseTransfer(id(), staged.transferId);
      await rejects(() => host!.beginTransfer(id(), { purpose: "provider_request", expectedBytes: 9_000_000, expectedSha256: null }), "UNSUPPORTED", "large provider request staging remains explicitly unavailable");
      const streamRequest = request("/stream"); const stream = await host.startProviderHttp(streamRequest); const chunks: ByteChunk[] = [];
      for (let count = 0; count < 4; count++) chunks.push(await host.readChunk(stream.bodyTransferId!));
      check(chunks.every(chunk => chunk.bytes.length > 0 && chunk.bytes.length <= 65_536), "native binary response frames preserve bounded chunks");
      await rejects(() => host!.readChunk(stream.bodyTransferId!), "OVERLOADED", "native reader enforces four unacknowledged chunks");
      await rejects(() => host!.acknowledgeChunk({ transferId: stream.bodyTransferId!, sequence: chunks[0]!.sequence, committedOffset: 1 }), "INVALID_REQUEST", "native acknowledgement offsets are checked");
      const first = chunks[0]!; await host.acknowledgeChunk({ transferId: first.transferId, sequence: first.sequence, committedOffset: first.offset + first.bytes.length });
      check((await host.readChunk(stream.bodyTransferId!)).sequence === 4, "native acknowledgement restores one read credit");
      const cancelled = await host.cancel(streamRequest.requestId);
      check(cancelled.outcome === "cancelled" && cancelled.externalEffect === "may_have_occurred", "native cancellation reports possible upstream effects");
      await rejects(() => host!.readChunk(stream.bodyTransferId!), "NOT_FOUND", "cancelled native transfer is released");
      const slow = request("/slow"); const pending = host.startProviderHttp(slow).catch(error => error);
      await new Promise(resolve => setTimeout(resolve, 30)); await host.cancel(slow.requestId);
      check((await pending).code === "CANCELLED", "native cancellation interrupts an in-flight header wait");
      const idle = await host.startProviderHttp(request("/idle", { timeout: { connectMs: 3_000, idleMs: 100, totalMs: 3_000 } }));
      await rejects(async () => { for (let count = 0; count < 16; count++) { const chunk = await host!.readChunk(idle.bodyTransferId!); await host!.acknowledgeChunk({ transferId: chunk.transferId, sequence: chunk.sequence, committedOffset: chunk.offset + chunk.bytes.length }); } }, "IO_ERROR", "native body idle timeout releases its reader");
      const status = await host.startProviderHttp(request("/error")); await read(host, status.bodyTransferId!);
      check(status.status === 429 && status.headers["retry-after"] === "3" && !status.headers["set-cookie"], "native status and safe response metadata survive forwarding");
      const active = [];
      for (let count = 0; count < 4; count++) active.push(await host.startProviderHttp(request("/stream")));
      await rejects(() => other!.startProviderHttp(request("/stream")), "OVERLOADED", "native HTTP concurrency is bounded across all sessions");
      for (const response of active) await host.cancel(response.requestId);
      const waiting = await host.startProviderHttp(request("/idle", { timeout: { connectMs: 3_000, idleMs: 3_000, totalMs: 3_000 } }));
      await host.releaseTransfer(id(), waiting.bodyTransferId!);
      await rejects(() => host!.readChunk(waiting.bodyTransferId!), "NOT_FOUND", "explicit release closes a native response without waiting for its deadline");
      if (config.fileFixture) {
        const before = await invoke<Record<string,number>>("native_host_proof_stats");
        const files = await host.chooseFiles(id(), { multiple: false, mediaTypes: ["application/octet-stream"] }); const file = files[0]!;
        check(files.length === 1 && file.name === "input.bin" && file.byteLength === config.fileFixture.bytes && !JSON.stringify(file).includes("/"), "synthetic selected file exposes only opaque ID and bounded metadata");
        await rejects(() => other!.openFileTransfer(id(), file.id), "NOT_FOUND", "native file handles are isolated between sessions");
        const source = await host.openFileTransfer(id(), file.id); const credits = [];
        for (let i=0;i<4;i++) credits.push(await host.readChunk(source.transferId));
        await rejects(() => host!.readChunk(source.transferId), "OVERLOADED", "native file reader enforces four chunk credits");
        // Credit exhaustion must preserve the reader for acknowledgement and retry.
        for (const chunk of credits) await host.acknowledgeChunk({ transferId: source.transferId, sequence: chunk.sequence, committedOffset: chunk.offset + chunk.bytes.length });
        await host.releaseTransfer(id(), source.transferId);
        const input = await host.openFileTransfer(id(), file.id);
        const stageRequest = id(); const disk = await host.beginTransfer(stageRequest, { purpose: "file_save", expectedBytes: file.byteLength, expectedSha256: config.fileFixture.sha256 });
        const started = performance.now(); let bytes = 0, maximumChunk = 0;
        for (;;) { const chunk = await host.readChunk(input.transferId); maximumChunk = Math.max(maximumChunk, chunk.bytes.length); await host.writeChunk({ ...chunk, transferId: disk.transferId }); bytes += chunk.bytes.length; await host.acknowledgeChunk({ transferId: input.transferId, sequence: chunk.sequence, committedOffset: chunk.offset + chunk.bytes.length }); if (chunk.final) break; }
        check(bytes === config.fileFixture.bytes && maximumChunk <= 65536, "256 MiB import crosses actual binary bridge with bounded chunks");
        await rejects(() => host!.finishTransfer(id(), disk.transferId, { byteLength: bytes, sha256: "0".repeat(64) }), "INVALID_REQUEST", "disk staging rejects a corrupted archive digest");
        await host.finishTransfer(id(), disk.transferId, { byteLength: bytes, sha256: config.fileFixture.sha256 });
        const staged = await invoke<Record<string,number>>("native_host_proof_stats");
        check(staged.diskBytes === bytes && staged.diskStages === 1 && staged.fileSources === 0, "large export remains disk backed after final input acknowledgement");
        await host.saveFileTransfer(id(), { name: "export.bin", mediaType: "application/octet-stream", transferId: disk.transferId });
        await rejects(() => host!.saveFileTransfer(id(), { name: "cancel.bin", mediaType: "application/octet-stream", transferId: disk.transferId }), "CANCELLED", "cancelled save selection does not write a destination");
        const saveRequest = id(); const saving = host.saveFileTransfer(saveRequest, { name: "preserved.bin", mediaType: "application/octet-stream", transferId: disk.transferId }).catch(value => value);
        await new Promise(resolve => setTimeout(resolve, 10));
        await rejects(() => host!.saveFileTransfer(id(), { name: "cancel.bin", mediaType: "application/octet-stream", transferId: disk.transferId }), "CONFLICT", "concurrent export of a busy transfer fails without blocking the host");
        const cancellation = await host.cancel(saveRequest); const cancelledSave = await saving;
        check(cancelledSave?.code === "CANCELLED" && cancellation.externalEffect === "not_dispatched", "cancelling a large copy before commit preserves the existing target");
        await host.releaseTransfer(id(), disk.transferId); await host.releaseFile(id(), file.id);
        await rejects(() => host!.openFileTransfer(id(), file.id), "NOT_FOUND", "released native file grant cannot be reopened");
        const abandoned = await host.beginTransfer(id(), { purpose: "file_save", expectedBytes: null, expectedSha256: null });
        await host.writeChunk({ transferId: abandoned.transferId, sequence:0,offset:0,bytes:new Uint8Array(65536),final:false }); await host.releaseTransfer(id(), abandoned.transferId);
        const after = await invoke<Record<string,number>>("native_host_proof_stats");
        check(after.diskBytes === 0 && after.diskStages === 0 && after.fileHandles === 0 && after.fileSources === 0, "release clears anonymous disk staging, sources and opened-file handles");
        fileEvidence = { before, staged, after, bytes, maximumChunk, elapsedMs: Math.round(performance.now()-started), cancellation, selection: "feature-only programmatic fixture paths; no dialog interaction claimed" };
      }
      await other.dispose(); other = undefined;
    }
    report = { success: true, phase: config.phase, checks, credential: retained, userAgent: navigator.userAgent, origin: location.origin, protocol: location.protocol, capabilities, fileEvidence, providerEvidence };
  } catch (value) {
    const error = value as { code?: string; message?: string };
    report = { success: false, phase: config.phase, checks, error: { code: error.code ?? null, message: error.message ?? "Native host proof failed" }, credential: retained, userAgent: navigator.userAgent, origin: location.origin };
  } finally { await other?.dispose().catch(() => {}); await host?.dispose().catch(() => {}); }
  await invoke("native_host_proof_report", { report: JSON.stringify(report), success: report.success === true });
}
void run();
