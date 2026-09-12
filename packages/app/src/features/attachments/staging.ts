import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { AdoptableFile, HostClient, HostFile, StorageClient, StorageOperations } from "@quixi/core/contracts";
import { IMAGE_MEDIA_TYPES, FILE_MEDIA_TYPES, AUDIO_MEDIA_TYPES, normalizeAudioMediaType, LIMITS } from "@quixi/providers";
import type { ComposerAttachment } from "../../workflows/chat.ts";

export const COMPOSER_IMAGE_LIMITS = Object.freeze({ imageBytes: LIMITS.imageBytes, imagesPerMessage: LIMITS.imagesPerRequest, mediaTypes: IMAGE_MEDIA_TYPES });
export const COMPOSER_ATTACHMENT_LIMITS = Object.freeze({ attachmentBytes: LIMITS.attachmentBytes, attachmentsPerMessage: Math.min(LIMITS.imagesPerRequest, LIMITS.filesPerRequest, LIMITS.audioPerRequest), mediaTypes: Object.freeze([...IMAGE_MEDIA_TYPES, ...FILE_MEDIA_TYPES, ...AUDIO_MEDIA_TYPES]) });
export const IMAGE_REFUSAL = "Only PNG, JPEG, GIF or WebP images up to 2.5 MiB can be attached.";
export const ATTACHMENT_REFUSAL = "Attach a supported PNG, JPEG, GIF, WebP, PDF, WAV or MP3 file, up to 2.5 MiB in total per message.";

/** Original bytes verified by the storage worker. PDF/audio have metadata only;
 * bounded header checks do not validate complete document or codec syntax. */
export interface StagedAttachment extends ComposerAttachment {
  id: string;
  kind: "Image" | "File" | "Audio";
  previewUrl: string | null;
}
export interface StagedImage extends StagedAttachment { kind: "Image"; previewUrl: string }
const id = () => crypto.randomUUID();
export const attachmentMediaTypes = (requested: readonly string[] = IMAGE_MEDIA_TYPES): readonly string[] =>
  COMPOSER_ATTACHMENT_LIMITS.mediaTypes.filter(type => requested.includes(type));

/** Detect only the image signature, independent of the declared MIME type. */
export function imageMediaType(bytes: Uint8Array): string | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}
/** Host MIME aliases normalize to the provider contract; arbitrary MIME types
 * remain unsupported even when their bytes resemble a supported format. */
export function normalizeAttachmentMediaType(type: string | null): string | null {
  if (type === null) return null;
  return normalizeAudioMediaType(type) ?? type.trim().toLowerCase();
}
function mpegMinimumFrameLength(bytes: Uint8Array): number | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || (bytes[1]! & 0xe0) !== 0xe0) return null;
  const version = (bytes[1]! >> 3) & 3, layer = (bytes[1]! >> 1) & 3;
  const bitrateIndex = bytes[2]! >> 4, sampleIndex = (bytes[2]! >> 2) & 3;
  // MPEG Layer III only; free-format bitrate is valid but has no exact size
  // in this prefix. Require payload beyond its four-byte header.
  if (version === 1 || layer !== 1 || bitrateIndex === 15 || sampleIndex === 3 || (bytes[3]! & 3) === 2) return null;
  if (bitrateIndex === 0) return 5;
  const rates = version === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const sampleRate = [44100, 48000, 32000][sampleIndex]! / (version === 3 ? 1 : version === 2 ? 2 : 4);
  return Math.floor((version === 3 ? 144 : 72) * rates[bitrateIndex]! * 1000 / sampleRate) + ((bytes[2]! >> 1) & 1);
}
export function audioMediaType(bytes: Uint8Array): string | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "audio/wav";
  if (bytes.length >= 10 && ascii(0, 3) === "ID3" && [2, 3, 4].includes(bytes[3]!) && bytes[4] !== 0xff && bytes.subarray(6, 10).every(byte => byte < 128)) {
    const allowedFlags = bytes[3] === 2 ? 0xc0 : bytes[3] === 3 ? 0xe0 : 0xf0;
    if ((bytes[5]! & ~allowedFlags) === 0) return "audio/mpeg";
  }
  return mpegMinimumFrameLength(bytes) === null ? null : "audio/mpeg";
}
function audioHeaderFits(bytes: Uint8Array, byteLength: number, mediaType: string): boolean {
  if (mediaType === "audio/wav") {
    const riffBytes = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
    return riffBytes > 4 && riffBytes + 8 <= byteLength;
  }
  if (mediaType !== "audio/mpeg") return true;
  if (bytes[0] === 73 && bytes[1] === 68 && bytes[2] === 51) {
    const tagBytes = bytes.subarray(6, 10).reduce((size, byte) => size * 128 + byte, 0);
    const footerBytes = bytes[3] === 4 && (bytes[5]! & 0x10) !== 0 ? 10 : 0;
    return 10 + tagBytes + footerBytes < byteLength;
  }
  const frameBytes = mpegMinimumFrameLength(bytes);
  return frameBytes !== null && frameBytes <= byteLength;
}
export function attachmentMediaType(bytes: Uint8Array): string | null {
  if (bytes.length >= 5 && [37, 80, 68, 70, 45].every((byte, index) => bytes[index] === byte)) return "application/pdf";
  return imageMediaType(bytes) ?? audioMediaType(bytes);
}
export function adoptableFile(file: File): AdoptableFile {
  return { name: file.name || "attachment", mediaType: file.type || null, byteLength: file.size, read: async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer()) };
}
export class ImageRefusal extends Error {}
export { ImageRefusal as AttachmentRefusal };

/** Read a bounded signature prefix across any number of host chunks before
 * allocating the file buffer or beginning its storage stage. The caller owns
 * and releases the selected host file handle. */
export async function stageAttachment(
  storage: StorageClient,
  host: HostClient,
  file: HostFile,
  cancelled: () => boolean,
  requestedMediaTypes: readonly string[] = IMAGE_MEDIA_TYPES,
  signal?: AbortSignal,
): Promise<StagedAttachment> {
  const mediaTypes = attachmentMediaTypes(requestedMediaTypes);
  const declaredMediaType = normalizeAttachmentMediaType(file.mediaType);
  const refusal = mediaTypes.some(type => FILE_MEDIA_TYPES.includes(type) || AUDIO_MEDIA_TYPES.includes(type)) ? ATTACHMENT_REFUSAL : IMAGE_REFUSAL;
  const current = () => { if (cancelled() || signal?.aborted) throw new Error("Attachment cancelled."); };
  const filename = () => { if (!file.name || file.name.length > 255 || /[\/\\\u0000-\u001f]/.test(file.name)) throw new ImageRefusal("PDF files require a filename of 1–255 characters without path separators or control characters."); };
  current();
  if (!mediaTypes.length || file.byteLength === null || !Number.isSafeInteger(file.byteLength) || file.byteLength <= 0 || file.byteLength > COMPOSER_ATTACHMENT_LIMITS.attachmentBytes || (declaredMediaType !== null && !mediaTypes.includes(declaredMediaType))) throw new ImageRefusal(refusal);
  if (file.mediaType === "application/pdf") filename();
  const byteLength = file.byteLength, sourceRequestId = id();
  let sourceId: string | null = null, transferId: string | null = null;
  let pendingStorage: { requestId: string; operationId: string } | null = null;
  const abort = () => {
    void host.cancel?.(sourceRequestId).catch(() => undefined);
    if (sourceId) void host.releaseTransfer(id(), sourceId).catch(() => undefined);
    if (pendingStorage) void storage.cancel?.(pendingStorage.requestId, pendingStorage.operationId).catch(() => undefined);
    // sendChunk has no public request ID. Queue idempotent stage disposal;
    // the bounded write settles before it, then the normal cleanup repeats it.
    if (transferId) void storage.request(id(), "discardBlobTransfer", { transferId }).catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  async function request<K extends "beginBlobTransfer" | "finishBlobTransfer">(operation: K, args: StorageOperations[K]["args"]): Promise<StorageOperations[K]["result"]> {
    const requestId = id(); pendingStorage = { requestId, operationId: args.operationId };
    try { return await storage.request(requestId, operation, args); }
    finally { pendingStorage = null; }
  }
  let previewUrl: string | null = null;
  let attachment: StagedAttachment | null = null;
  try {
    const source = await host.openFileTransfer(sourceRequestId, file.id);
    sourceId = source.transferId;
    current();
    if (!Number.isSafeInteger(source.maxChunkBytes) || source.maxChunkBytes < 1) throw new Error("The host returned invalid attachment transfer bounds.");
    const prefix = new Uint8Array(Math.min(12, byteLength));
    let prefixLength = 0, received = 0, written = 0, sourceSequence = 0, sequence = 0;
    let bytes: Uint8Array<ArrayBuffer> | null = null, mediaType: string | null = null, storageChunkBytes = 0;
    const hash = sha256.create();
    const write = async (value: Uint8Array) => {
      for (let cursor = 0; cursor < value.length; cursor += storageChunkBytes) {
        current();
        const slice = value.subarray(cursor, cursor + storageChunkBytes);
        hash.update(slice);
        const ack = await storage.sendChunk({ transferId: transferId!, sequence, offset: written, bytes: slice, final: false });
        current();
        if (ack.transferId !== transferId || ack.sequence !== sequence || ack.committedOffset !== written + slice.length) throw new Error("The attachment stage returned an invalid acknowledgement.");
        sequence++; written += slice.length;
      }
    };
    for (;;) {
      current();
      const chunk = await host.readChunk(source.transferId);
      current();
      if (chunk.transferId !== source.transferId || chunk.sequence !== sourceSequence++ || chunk.offset !== received || chunk.bytes.length > source.maxChunkBytes || received + chunk.bytes.length > byteLength || (!chunk.final && chunk.bytes.length === 0)) throw new Error("The selected file changed while it was being read.");
      const previous = received;
      received += chunk.bytes.length;
      if (!bytes) {
        const count = Math.min(chunk.bytes.length, prefix.length - prefixLength);
        prefix.set(chunk.bytes.subarray(0, count), prefixLength); prefixLength += count;
        if (prefixLength === prefix.length) {
          mediaType = attachmentMediaType(prefix);
          if (!mediaType || !mediaTypes.includes(mediaType) || (declaredMediaType !== null && declaredMediaType !== mediaType) || !audioHeaderFits(prefix, byteLength, mediaType)) throw new ImageRefusal(refusal);
          if (mediaType === "application/pdf") filename();
          bytes = new Uint8Array(byteLength); bytes.set(prefix);
          const stage = await request("beginBlobTransfer", { operationId: id(), purpose: "attachment", expectedBytes: byteLength, expectedSha256: null });
          transferId = stage.transferId;
          current();
          if (!Number.isSafeInteger(stage.maxChunkBytes) || stage.maxChunkBytes < 1) throw new Error("The storage worker returned invalid attachment transfer bounds.");
          storageChunkBytes = Math.min(stage.maxChunkBytes, 65536);
          await write(prefix.subarray(0, previous));
        }
      }
      if (bytes) { bytes.set(chunk.bytes, previous); await write(chunk.bytes); }
      await host.acknowledgeChunk({ transferId: source.transferId, sequence: chunk.sequence, committedOffset: received });
      current();
      if (chunk.final) break;
    }
    if (received !== byteLength || written !== byteLength || !mediaType || !bytes || !transferId) throw new Error("The selected file ended before its declared size.");
    const final = await storage.sendChunk({ transferId, sequence, offset: written, bytes: new Uint8Array(), final: true });
    current();
    if (final.transferId !== transferId || final.sequence !== sequence || final.committedOffset !== written) throw new Error("The attachment stage returned an invalid acknowledgement.");
    const digest = bytesToHex(hash.digest());
    const verified = await request("finishBlobTransfer", { operationId: id(), transferId, expectedBytes: byteLength, expectedSha256: digest });
    current();
    if (verified.state !== "verified_staged" || verified.transferId !== transferId || verified.sha256 !== digest || verified.byteLength !== byteLength || !mediaTypes.includes(mediaType)) throw new Error("The attachment stage did not verify the original bytes.");
    const kind = FILE_MEDIA_TYPES.includes(mediaType) ? "File" : AUDIO_MEDIA_TYPES.includes(mediaType) ? "Audio" : "Image";
    if (kind === "Image") previewUrl = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
    current();
    attachment = { id: id(), kind, transferId: verified.transferId, sha256: verified.sha256, byteLength: verified.byteLength, mediaType, filename: kind === "File" ? file.name : file.name.slice(0, 255), bytes, previewUrl };
    transferId = null;
  } catch (error) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    if (transferId) await storage.request(id(), "discardBlobTransfer", { transferId }).catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (sourceId) await host.releaseTransfer(id(), sourceId).catch(() => undefined);
  }
  try { current(); } catch (error) {
    if (attachment?.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    if (attachment) await storage.request(id(), "discardBlobTransfer", { transferId: attachment.transferId }).catch(() => undefined);
    throw error;
  }
  return attachment!;
}

/** Compatibility entry point with the original image-only profile. */
export async function stageImage(storage: StorageClient, host: HostClient, file: HostFile, cancelled: () => boolean): Promise<StagedImage> {
  const staged = await stageAttachment(storage, host, file, cancelled, IMAGE_MEDIA_TYPES);
  return staged as StagedImage;
}
