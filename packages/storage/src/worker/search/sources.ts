import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { SearchError } from "@quixi/search";
import type { ChunkSource } from "@quixi/search";
import type { CanonicalHistory, ContentPart } from "@quixi/core/model";
import { canonicalJson } from "@quixi/core/contracts";
import type { CanonicalSqlite, SqlValue } from "../canonical/repository.ts";
import type { PublishedExtractionSources } from "../extraction/index.ts";
import type { PublishedPageRef } from "@quixi/core/contracts";
export interface Source {
  extractionRef?: PublishedPageRef;
  key: string;
  chunk: ChunkSource;
  text: string | null;
  blob: { sha256: string; byteLength: number } | null;
  threadId: string | null;
  messageId: string | null;
  documentId: string | null;
  title: string;
  role: string | null;
  provider: string | null;
  model: string | null;
  date: number | null;
  tags: string[];
  mediaType: string;
  origin: "native" | "imported";
}
export interface Extraction {
  id: string;
  documentId: string;
  attachmentSha256: string;
  extractorVersion: string;
  text: string;
  page: number | null;
  sectionPath: string[];
  offsetBase: number;
}
export const rows = (db: CanonicalSqlite, sql: string, bind: SqlValue[] = []) =>
  db.exec({
    sql,
    ...(bind.length ? { bind } : {}),
    rowMode: "object",
    returnValue: "resultRows",
  }) as Record<string, SqlValue>[];
export function record<K extends Exclude<keyof CanonicalHistory, "version">>(
  db: CanonicalSqlite,
  collection: K,
  id: string | null,
): NonNullable<CanonicalHistory[K]>[number] | null {
  if (!id) return null;
  const row = rows(
    db,
    "SELECT payload FROM quixi_records WHERE collection=? AND id=?",
    [collection, id],
  )[0];
  return row ? JSON.parse(String(row.payload)) : null;
}
const textHash = (text: string) =>
  bytesToHex(sha256(new TextEncoder().encode(text)));
export function hidden(
  db: CanonicalSqlite,
  threadId: string,
  messageId: string,
): boolean {
  return (
    Number(
      db.selectValue(
        `WITH RECURSIVE ancestors(id,parent_id) AS (
SELECT id,parent_id FROM quixi_records WHERE collection='messages' AND id=? UNION ALL
SELECT m.id,m.parent_id FROM quixi_records m JOIN ancestors a ON m.id=a.parent_id WHERE m.collection='messages')
SELECT EXISTS(SELECT 1 FROM quixi_records WHERE collection='tombstones' AND thread_id=? AND (json_extract(payload,'$.rootMessageId') IS NULL OR json_extract(payload,'$.rootMessageId') IN(SELECT id FROM ancestors)))`,
        [messageId, threadId],
      ),
    ) === 1
  );
}
function partText(part: ContentPart): {
  text: string | null;
  blob: Source["blob"];
  type: ChunkSource["sourceType"];
  path: string[];
} | null {
  if (part.kind === "Text" || part.kind === "Note")
    return {
      text: part.data.text ?? null,
      blob: part.data.textBlob ?? null,
      type: "message",
      path: [],
    };
  if (part.kind === "ToolResult")
    return {
      text:
        typeof part.data.content === "string"
          ? part.data.content
          : canonicalJson(part.data.content),
      blob: null,
      type: "tool_output",
      path:
        typeof part.data.content === "string"
          ? ["data", "content"]
          : ["canonical-json", "data", "content"],
    };
  if (part.kind === "ToolCall")
    return {
      text: canonicalJson(part.data),
      blob: null,
      type: "tool_output",
      path: ["canonical-json", "data"],
    };
  if (part.kind === "ReasoningMetadata" && part.data.summary !== null)
    return {
      text: part.data.summary,
      blob: null,
      type: "message",
      path: ["data", "summary"],
    };
  if (part.kind === "StructuredData")
    return {
      text: canonicalJson(part.data.value),
      blob: null,
      type: "message",
      path: ["canonical-json", "data", "value"],
    };
  if (part.kind === "Citation")
    return {
      text: canonicalJson(part.data),
      blob: null,
      type: "message",
      path: ["canonical-json", "data"],
    };
  if (
    (part.kind === "File" || part.kind === "Image" || part.kind === "Audio") &&
    part.data.description !== null
  )
    return {
      text: part.data.description,
      blob: null,
      type: "message",
      path: ["data", "description"],
    };
  return null;
}
export function loadSource(
  db: CanonicalSqlite,
  key: string,
  published?: PublishedExtractionSources,
): Source | null {
  const type = key.slice(0, 2),
    id = key.slice(2);
  if (type === "p:" || type === "f:") {
    const part = record(db, "parts", id);
    if (!part) return null;
    const attachment =
      part.kind === "File" || part.kind === "Image" || part.kind === "Audio"
        ? record(db, "attachments", part.data.attachmentId)
        : null;
    // Filename offsets address the attachment field, never a prefixed caption.
    // Retained metadata stays searchable even when original bytes are missing.
    const material = type === "f:"
      ? part.kind === "Image" && attachment?.filename
        ? { text: attachment.filename, blob: null, type: "message" as const,
            path: ["attachment", attachment.id, "filename"] }
        : null
      : partText(part);
    if (!material) return null;
    const message = record(db, "messages", part.messageId);
    if (!message || hidden(db, message.threadId, message.id)) return null;
    const thread = record(db, "threads", message.threadId),
      state = record(db, "threadStates", message.threadId);
    if (!thread || !state) return null;
    const generation = record(db, "generations", message.generationId);
    const provenance = rows(
      db,
      "SELECT payload FROM quixi_records WHERE collection='provenance' AND json_extract(payload,'$.entityId') IN(?,?) ORDER BY id LIMIT 1",
      [message.id, part.id],
    )[0];
    const importId = provenance
      ? JSON.parse(String(provenance.payload)).importSourceId
      : thread.importSourceId;
    const imported = record(db, "importSources", importId);
    const title = (generation?.purpose === "context_summary" ? `Summary proposal: ${state.title}` : state.title).slice(0, 1024);
    return {
      key,
      chunk: {
        sourceType: material.type,
        sourceId: message.id,
        partId: part.id,
        sourceDigest: material.blob?.sha256 ?? textHash(material.text ?? ""),
        contextPrefix: `${title} > ${message.role}`,
        sectionPath: material.path,
      },
      text: material.text,
      blob: material.blob,
      threadId: thread.id,
      messageId: message.id,
      documentId: null,
      title,
      role: message.role,
      provider: generation?.provider ?? imported?.provider ?? null,
      model: generation?.model ?? null,
      date: message.createdAt,
      tags: state.tags,
      mediaType: (
        attachment?.mimeType ??
        (material.path[0] === "canonical-json"
          ? "application/json"
          : "text/plain")
      )
        .split(";")[0]!
        .trim()
        .toLowerCase(),
      origin: imported ? "imported" : "native",
    };
  }
  const publishedPage = type === "e:" ? published?.loadPage(id) : null;
  if (type === "e:" && !publishedPage) return null;
  const extraction =
    type === "x:"
      ? rows(db, "SELECT * FROM quixi_search_extractions WHERE id=?", [id])[0]
      : null;
  const document = record(
    db,
    "documents",
    publishedPage?.ref.identity.documentId ??
      (extraction ? String(extraction.document_id) : id),
  );
  if (!document) return null;
  const attachment = record(db, "attachments", document.attachmentId);
  if (!attachment) return null;
  if (
    attachment.availability !== "available" ||
    !attachment.blobSha256 ||
    attachment.sizeBytes === null
  )
    throw new SearchError(
      "IO_ERROR",
      "Document attachment bytes are unavailable; resolve or restore the source before indexing.",
    );
  const mediaType = (attachment.mimeType ?? "application/octet-stream")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  let text: string | null = null,
    blob: Source["blob"] = null,
    page: number | null = null,
    sectionPath: string[] = [],
    offsetBase = 0;
  if (publishedPage) {
    const identity = publishedPage.ref.identity;
    if (
      identity.attachmentId !== attachment.id ||
      identity.attachmentSha256 !== attachment.blobSha256 ||
      identity.attachmentByteLength !== attachment.sizeBytes ||
      mediaType !== "application/pdf"
    )
      return null;
    text = publishedPage.text;
    page = publishedPage.ref.page;
  } else if (extraction) {
    if (extraction.attachment_sha256 !== attachment.blobSha256) return null;
    text = JSON.parse(
      String(
        db.selectValue(
          "SELECT json_quote(text) FROM quixi_search_extractions WHERE id=?",
          [id],
        ),
      ),
    );
    page = extraction.page === null ? null : Number(extraction.page);
    sectionPath = JSON.parse(String(extraction.section_path));
    offsetBase = Number(extraction.offset_base);
  } else if (type === "d:") {
    // PDF publication is represented only by bounded e: page sources, including
    // while its first page is staged. Legacy registrations retain their own path.
    if (published && mediaType === "application/pdf") return null;
    if (
      Number(
        db.selectValue(
          "SELECT EXISTS(SELECT 1 FROM quixi_search_extractions WHERE document_id=? AND attachment_sha256=?)",
          [document.id, attachment.blobSha256],
        ),
      )
    )
      return null;
    if (
      !mediaType.startsWith("text/") &&
      !["application/json", "application/xml"].includes(mediaType)
    )
      throw new SearchError(
        "UNSUPPORTED",
        "This document needs plan14 text extraction before lexical indexing; OCR requires plan15.",
      );
    blob = { sha256: attachment.blobSha256, byteLength: attachment.sizeBytes };
  } else return null;
  const title = document.title.slice(0, 1024);
  return {
    key,
    chunk: {
      sourceType: "document",
      sourceId: document.id,
      partId: null,
      sourceDigest:
        publishedPage?.ref.sourceDigest ?? blob?.sha256 ?? textHash(text ?? ""),
      contextPrefix: [title, ...sectionPath].join(" > ").slice(0, 4096),
      page,
      sectionPath,
      offsetBase,
    },
    text,
    blob,
    threadId: null,
    messageId: null,
    documentId: document.id,
    ...(publishedPage ? { extractionRef: publishedPage.ref } : {}),
    title,
    role: null,
    provider:
      record(db, "importSources", document.importSourceId)?.provider ?? null,
    model: null,
    date: document.createdAt,
    tags: [],
    mediaType,
    origin: document.importSourceId ? "imported" : "native",
  };
}
