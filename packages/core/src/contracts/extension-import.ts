import type { QuixiId } from "../model/types.ts";
import { isQuixiId } from "../model/validation.ts";
import { jsonByteLength } from "./serialization.ts";

/** Product §24/§25: the extension extracts provider-native records and hands
 * them to the importer as one export-compatible byte stream plus this
 * envelope. The extension never normalizes, deduplicates or writes SQL. */
export const EXTENSION_IMPORT_PROTOCOL_VERSION = 1;
export const EXTENSION_IMPORT_CHANNEL = "quixi-extension-import";
export const EXTENSION_IMPORT_LIMITS = Object.freeze({
  /** One chunk over the page boundary; extension messaging serializes JSON, so
   * the sender base64-encodes at most this many bytes per chunk. */
  maxChunkBytes: 262_144,
  maxInFlight: 4,
  maxBundleBytes: 4_294_967_296,
  maxNameChars: 255,
  pairingCodeLength: 6,
  /** An accepted offer whose sender goes quiet is abandoned after this. */
  idleTimeoutMs: 120_000,
});
export type ExtensionProvider = "openai" | "anthropic";
export interface ProviderImportBundle {
  version: 1;
  bundleId: QuixiId;
  provider: ExtensionProvider;
  method: "extension";
  /** Which extractor produced the stream and how it obtained the records. */
  extractor: { name: string; version: string; source: "official_export" | "page_extraction" };
  /** Format profile of the byte stream; the importer refuses unknown profiles. */
  sourceFormatVersion: string;
  capturedAt: number;
  /** The exact bytes the importer will preserve as the raw source. */
  file: { name: string; mediaType: "application/json" | "application/zip"; byteLength: number; sha256: string };
  /** Provider-native discovery counts for the import report (product §28). */
  discovered: { conversations: number; attachments: number; unavailableAttachments: number };
  sourceUrl: string | null;
  /** Stable extraction checkpoint the extension retains for "Import new conversations". */
  checkpoint: { cursor: string | null; sinceUpdateTime: number | null } | null;
}
export interface ExtensionOffer { offerId: QuixiId; bundle: ProviderImportBundle; receivedAt: number }
export type ExtensionTransferState = "offered" | "receiving" | "verifying" | "staged" | "rejected" | "failed" | "cancelled";
export interface ExtensionTransferProgress {
  offerId: QuixiId; state: ExtensionTransferState; receivedBytes: number; totalBytes: number; reason: string | null;
}
/** Extension → page and page → extension messages over `window.postMessage`
 * on the Quixi origin. Every message carries the channel tag and version;
 * anything else is ignored. Chunk bytes travel as ArrayBuffers (transferred). */
export type ExtensionToPageMessage =
  | { channel: typeof EXTENSION_IMPORT_CHANNEL; version: 1; kind: "offer"; offerId: QuixiId; pairingCode: string; bundle: ProviderImportBundle }
  | { channel: typeof EXTENSION_IMPORT_CHANNEL; version: 1; kind: "chunk"; offerId: QuixiId; sequence: number; offset: number; bytes: ArrayBuffer; final: boolean }
  | { channel: typeof EXTENSION_IMPORT_CHANNEL; version: 1; kind: "resume"; offerId: QuixiId; pairingCode: string }
  | { channel: typeof EXTENSION_IMPORT_CHANNEL; version: 1; kind: "cancel"; offerId: QuixiId; reason: string };
export type PageToExtensionMessage =
  | { channel: typeof EXTENSION_IMPORT_CHANNEL; version: 1; kind: "accepted"; offerId: QuixiId; maxChunkBytes: number; maxInFlight: number; committedOffset: number }
  | { channel: typeof EXTENSION_IMPORT_CHANNEL; version: 1; kind: "rejected"; offerId: QuixiId; reason: string }
  | { channel: typeof EXTENSION_IMPORT_CHANNEL; version: 1; kind: "ack"; offerId: QuixiId; sequence: number; committedOffset: number }
  | { channel: typeof EXTENSION_IMPORT_CHANNEL; version: 1; kind: "staged"; offerId: QuixiId }
  | { channel: typeof EXTENSION_IMPORT_CHANNEL; version: 1; kind: "failed"; offerId: QuixiId; reason: string }
  | { channel: typeof EXTENSION_IMPORT_CHANNEL; version: 1; kind: "imported"; offerId: QuixiId; runId: QuixiId | null; outcome: "complete" | "failed" | "paused"; reason: string | null };
const digest = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const text = (value: unknown, max: number) => typeof value === "string" && value.length >= 1 && value.length <= max;
export function validateProviderImportBundle(value: unknown): value is ProviderImportBundle {
  const bundle = value as Record<string, unknown> | null;
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return false;
  if (bundle.version !== 1 || !isQuixiId(bundle.bundleId) || !["openai", "anthropic"].includes(String(bundle.provider)) || bundle.method !== "extension") return false;
  const extractor = bundle.extractor as Record<string, unknown> | null;
  if (!extractor || typeof extractor !== "object" || !text(extractor.name, 64) || !text(extractor.version, 32) || !["official_export", "page_extraction"].includes(String(extractor.source))) return false;
  if (!text(bundle.sourceFormatVersion, 128) || !Number.isSafeInteger(bundle.capturedAt) || Number(bundle.capturedAt) < 0) return false;
  const file = bundle.file as Record<string, unknown> | null;
  if (!file || typeof file !== "object" || !text(file.name, EXTENSION_IMPORT_LIMITS.maxNameChars) || /[\/\\\x00-\x1f]/.test(String(file.name)) ||
      !["application/json", "application/zip"].includes(String(file.mediaType)) || !Number.isSafeInteger(file.byteLength) || Number(file.byteLength) < 1 ||
      Number(file.byteLength) > EXTENSION_IMPORT_LIMITS.maxBundleBytes || !digest(file.sha256)) return false;
  const discovered = bundle.discovered as Record<string, unknown> | null;
  if (!discovered || typeof discovered !== "object" || ["conversations", "attachments", "unavailableAttachments"].some((key) => !Number.isSafeInteger(discovered[key]) || Number(discovered[key]) < 0)) return false;
  if (!(bundle.sourceUrl === null || text(bundle.sourceUrl, 2048))) return false;
  const checkpoint = bundle.checkpoint as Record<string, unknown> | null;
  if (checkpoint !== null && (!checkpoint || typeof checkpoint !== "object" || !(checkpoint.cursor === null || text(checkpoint.cursor, 1024)) ||
      !(checkpoint.sinceUpdateTime === null || (typeof checkpoint.sinceUpdateTime === "number" && Number.isFinite(checkpoint.sinceUpdateTime))))) return false;
  try { jsonByteLength(bundle, 65_536); } catch { return false; }
  return true;
}
const tagged = (value: unknown): value is { channel: string; version: number; kind: string; offerId: unknown } =>
  !!value && typeof value === "object" && (value as Record<string, unknown>).channel === EXTENSION_IMPORT_CHANNEL && (value as Record<string, unknown>).version === EXTENSION_IMPORT_PROTOCOL_VERSION && typeof (value as Record<string, unknown>).kind === "string";
/** Structural check of an inbound message; unknown kinds and bad shapes are dropped, never thrown. */
export function parseExtensionToPageMessage(value: unknown): ExtensionToPageMessage | null {
  if (!tagged(value) || !isQuixiId(value.offerId)) return null;
  const message = value as Record<string, unknown>;
  switch (message.kind) {
    case "offer":
      return typeof message.pairingCode === "string" && message.pairingCode.length <= 16 && validateProviderImportBundle(message.bundle) ? (message as unknown as ExtensionToPageMessage) : null;
    case "resume":
      return typeof message.pairingCode === "string" && message.pairingCode.length <= 16 ? (message as unknown as ExtensionToPageMessage) : null;
    case "chunk":
      return Number.isSafeInteger(message.sequence) && Number(message.sequence) >= 0 && Number.isSafeInteger(message.offset) && Number(message.offset) >= 0 &&
        message.bytes instanceof ArrayBuffer && message.bytes.byteLength <= EXTENSION_IMPORT_LIMITS.maxChunkBytes && typeof message.final === "boolean" ? (message as unknown as ExtensionToPageMessage) : null;
    case "cancel":
      return typeof message.reason === "string" && message.reason.length <= 1024 ? (message as unknown as ExtensionToPageMessage) : null;
    default:
      return null;
  }
}
export function parsePageToExtensionMessage(value: unknown): PageToExtensionMessage | null {
  if (!tagged(value) || !isQuixiId(value.offerId)) return null;
  const message = value as Record<string, unknown>;
  switch (message.kind) {
    case "accepted": return Number.isSafeInteger(message.maxChunkBytes) && Number.isSafeInteger(message.maxInFlight) && Number.isSafeInteger(message.committedOffset) ? (message as unknown as PageToExtensionMessage) : null;
    case "ack": return Number.isSafeInteger(message.sequence) && Number.isSafeInteger(message.committedOffset) ? (message as unknown as PageToExtensionMessage) : null;
    case "rejected": case "failed": return typeof message.reason === "string" ? (message as unknown as PageToExtensionMessage) : null;
    case "staged": return message as unknown as PageToExtensionMessage;
    case "imported": return ["complete", "failed", "paused"].includes(String(message.outcome)) && (message.runId === null || isQuixiId(message.runId)) && (message.reason === null || typeof message.reason === "string") ? (message as unknown as PageToExtensionMessage) : null;
    default: return null;
  }
}
/** Digits only, so a user can read it from the Quixi page into the extension. */
const webCrypto = () => (globalThis as { crypto?: { getRandomValues(bytes: Uint8Array<ArrayBuffer>): unknown } }).crypto;
export function generatePairingCode(random: (bytes: Uint8Array<ArrayBuffer>) => void = (bytes) => { const source = webCrypto(); if (!source) throw new Error("Web Crypto is unavailable"); source.getRandomValues(bytes); }): string {
  const bytes = new Uint8Array(new ArrayBuffer(EXTENSION_IMPORT_LIMITS.pairingCodeLength));
  random(bytes);
  return Array.from(bytes, (byte) => String(byte % 10)).join("");
}
export const samePairingCode = (a: string, b: string) => a.length === b.length && a.length === EXTENSION_IMPORT_LIMITS.pairingCodeLength && Array.from(a).every((character, index) => character === b[index]);
