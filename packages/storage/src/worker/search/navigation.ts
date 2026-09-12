import { SearchError, searchDigest } from "@quixi/search";
import { assertPublishedPageRef, jsonByteLength } from "@quixi/core/contracts";
import type {
  ChunkPosition,
  DocumentSearchResolution,
  ConversationSearchResolution,
  PublishedPageRef,
  SearchOperations,
} from "@quixi/core/contracts";
import type { CanonicalSqlite } from "../canonical/repository.ts";
import type { PublishedExtractionSources } from "../extraction/index.ts";
import { record, rows, loadSource } from "./sources.ts";

const stale = (): never => {
  throw new SearchError(
    "CONFLICT",
    "This search result is no longer current. Refresh search before opening it.",
  );
};
const corrupt = (): never => {
  throw new SearchError(
    "MIGRATION_FAILED",
    "Stored search navigation metadata is invalid. Rebuild the derived search index.",
  );
};
function position(value: unknown, partId: string | null = null): ChunkPosition {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return corrupt();
  const p = value as Record<string, unknown>;
  if (
    Object.keys(p).length !== 5 ||
    p.partId !== partId ||
    !Number.isSafeInteger(p.start) ||
    Number(p.start) < 0 ||
    !Number.isSafeInteger(p.end) ||
    Number(p.end) <= Number(p.start) ||
    (p.page !== null &&
      (!Number.isSafeInteger(p.page) || Number(p.page) < 1)) ||
    !Array.isArray(p.sectionPath) ||
    p.sectionPath.length > 32 ||
    p.sectionPath.some((s) => typeof s !== "string" || s.length > 1024)
  )
    return corrupt();
  try {
    jsonByteLength(value, 262144);
  } catch {
    return corrupt();
  }
  return value as ChunkPosition;
}

/** The caller supplies a verified optional-table predicate. Neither the query
 * nor its JS projection loads chunk text, full PDF text or source-map batches. */
export function resolveDocumentHitSource(
  db: CanonicalSqlite,
  args: SearchOperations["resolveDocumentSearchHit"]["args"],
  visibleHead: string,
  published?: PublishedExtractionSources,
): DocumentSearchResolution {
  const candidates = rows(
    db,
    `SELECT c.epoch,c.source_key,c.run_id,c.source_type AS chunk_type,h.source_id,h.source_type,h.part_id,
CASE WHEN length(CAST(c.position AS BLOB))<=262144 THEN c.position ELSE NULL END AS position,
CASE WHEN json_valid(c.payload) AND length(CAST(c.payload AS BLOB))<=1048576 THEN CASE WHEN json_type(c.payload,'$.sourceDigest')='text' AND length(json_extract(c.payload,'$.sourceDigest'))=64 AND json_type(c.payload,'$.chunkerVersion')='text' AND length(json_extract(c.payload,'$.chunkerVersion')) BETWEEN 1 AND 256 AND json_type(c.payload,'$.contextPrefix')='text' AND length(json_extract(c.payload,'$.contextPrefix'))<=4096 THEN
 json_object('digest',json_extract(c.payload,'$.sourceDigest'),'version',json_extract(c.payload,'$.chunkerVersion'),'context',json_extract(c.payload,'$.contextPrefix')) ELSE NULL END ELSE NULL END AS material
FROM quixi_search_chunks c INDEXED BY quixi_search_chunk_lookup
JOIN quixi_search_heads h ON h.epoch=c.epoch AND h.source_key=c.source_key AND h.run_id=c.run_id
WHERE c.epoch=(SELECT active_epoch FROM quixi_search_meta) AND c.chunk_id=? AND h.document_id=? AND h.source_id=? AND h.source_type='document' AND ${visibleHead} LIMIT 2`,
    [args.chunkId, args.documentId, args.documentId],
  );
  if (candidates.length !== 1) return stale();
  const row = candidates[0]!,
    key = String(row.source_key);
  if (!key.startsWith("e:") && !key.startsWith("d:")) return stale();
  let location: ChunkPosition,
    material: { digest: string; version: string; context: string };
  try {
    location = position(JSON.parse(String(row.position)));
    material = JSON.parse(String(row.material));
    if (
      !material ||
      typeof material.digest !== "string" ||
      !/^[0-9a-f]{64}$/.test(material.digest) ||
      typeof material.version !== "string" ||
      material.version.length < 1 ||
      material.version.length > 256 ||
      typeof material.context !== "string" ||
      material.context.length > 4096
    )
      return corrupt();
  } catch (error) {
    if (error instanceof SearchError) throw error;
    return corrupt();
  }
  // Reconstruct the deterministic chunk identity from bounded metadata. A
  // changed position/digest/context cannot retain an old chunk's navigation ID.
  const structuralId = searchDigest([
    row.source_type,
    row.source_id,
    row.part_id,
    material.digest,
    material.version,
    location.start,
    location.end,
    location.page,
    location.sectionPath,
    material.context,
  ]);
  const expectedId =
    row.chunk_type === "code"
      ? searchDigest(["code-classification-v1", structuralId])
      : structuralId;
  if (
    row.part_id !== null ||
    !["document", "code"].includes(String(row.chunk_type)) ||
    expectedId !== args.chunkId
  )
    return corrupt();
  const document = record(db, "documents", args.documentId);
  if (!document || document.id !== args.documentId) return stale();
  const attachment = record(db, "attachments", document.attachmentId);
  if (
    !attachment ||
    attachment.id !== document.attachmentId ||
    !Number.isSafeInteger(attachment.sizeBytes) ||
    Number(attachment.sizeBytes) < 1 ||
    attachment.availability !== "available" ||
    !attachment.blobSha256 ||
    attachment.sizeBytes === null
  )
    return stale();
  let pageRef: PublishedPageRef | null = null;
  if (key.startsWith("e:")) {
    if (!published?.ready()) return stale();
    const ref = rows(
      db,
      `SELECT page_id,extraction_run_id,page,document_id,attachment_id,attachment_sha256,attachment_bytes,source_digest,publication_revision,
CASE WHEN length(CAST(identity AS BLOB))<=8192 THEN identity ELSE NULL END AS identity
FROM quixi_search_page_refs WHERE epoch=? AND source_key=? AND run_id=? LIMIT 1`,
      [Number(row.epoch), key, String(row.run_id)],
    )[0];
    if (!ref) return stale();
    try {
      pageRef = {
        pageAttemptId: String(ref.page_id),
        runId: String(ref.extraction_run_id),
        page: Number(ref.page),
        identity: JSON.parse(String(ref.identity)),
        sourceDigest: String(ref.source_digest),
        publicationRevision: Number(ref.publication_revision),
      };
      assertPublishedPageRef(pageRef);
      if (
        key !== `e:${pageRef.pageAttemptId}` ||
        pageRef.identity.documentId !== args.documentId ||
        pageRef.identity.attachmentId !== attachment.id ||
        pageRef.identity.attachmentSha256 !== attachment.blobSha256 ||
        pageRef.identity.attachmentByteLength !== attachment.sizeBytes ||
        pageRef.sourceDigest !== material.digest ||
        location.page !== pageRef.page ||
        !published.current(pageRef)
      )
        return stale();
    } catch (error) {
      if (error instanceof SearchError) throw error;
      return stale();
    }
  } else if (
    key !== `d:${document.id}` ||
    location.page !== null ||
    material.digest !== attachment.blobSha256
  )
    return stale();
  return {
    documentId: document.id,
    attachmentId: attachment.id,
    pageRef,
    position: location,
  };
}

/** Locate one exact conversation chunk, then verify its bounded canonical source
 * independently of dirty-trigger metadata. No optional extraction joins or blob
 * reads participate in filename/description navigation. */
export function resolveConversationHitSource(
  db: CanonicalSqlite,
  args: SearchOperations['resolveConversationSearchHit']['args'],
  visibleHead: string,
): ConversationSearchResolution {
  // This index has no message-only metadata source. Do not retarget a null-part
  // hit to an arbitrary first part or infer a missing source representation.
  if (args.partId === null) return stale();
  const candidates = rows(db,
    `SELECT c.source_key,c.source_type AS chunk_type,h.source_id,h.source_type,h.part_id,
CASE WHEN length(CAST(c.position AS BLOB))<=262144 THEN c.position ELSE NULL END AS position,
CASE WHEN json_valid(c.payload) AND length(CAST(c.payload AS BLOB))<=1048576 THEN CASE WHEN json_type(c.payload,'$.sourceDigest')='text' AND length(json_extract(c.payload,'$.sourceDigest'))=64 AND json_type(c.payload,'$.chunkerVersion')='text' AND length(json_extract(c.payload,'$.chunkerVersion')) BETWEEN 1 AND 256 AND json_type(c.payload,'$.contextPrefix')='text' AND length(json_extract(c.payload,'$.contextPrefix'))<=4096 THEN
 json_object('digest',json_extract(c.payload,'$.sourceDigest'),'version',json_extract(c.payload,'$.chunkerVersion'),'context',json_extract(c.payload,'$.contextPrefix')) ELSE NULL END ELSE NULL END AS material
FROM quixi_search_chunks c INDEXED BY quixi_search_chunk_lookup
JOIN quixi_search_heads h ON h.epoch=c.epoch AND h.source_key=c.source_key AND h.run_id=c.run_id
WHERE c.epoch=(SELECT active_epoch FROM quixi_search_meta) AND c.chunk_id=? AND h.thread_id=? AND h.message_id=? AND h.source_id=? AND h.part_id=? AND h.document_id IS NULL AND h.source_type IN('message','tool_output') AND ${visibleHead} LIMIT 2`,
    [args.chunkId, args.threadId, args.messageId, args.messageId, args.partId]);
  if (candidates.length !== 1) return stale();
  const row = candidates[0]!, key = String(row.source_key);
  if (key !== `p:${args.partId}` && key !== `f:${args.partId}`) return stale();
  let location: ChunkPosition, material: { digest: string; version: string; context: string };
  try {
    location = position(JSON.parse(String(row.position)), args.partId);
    material = JSON.parse(String(row.material));
    if (!material || typeof material.digest !== 'string' || !/^[0-9a-f]{64}$/.test(material.digest) ||
      typeof material.version !== 'string' || material.version.length < 1 || material.version.length > 256 ||
      typeof material.context !== 'string' || material.context.length > 4096 || location.page !== null) return corrupt();
  } catch (error) { if (error instanceof SearchError) throw error; return corrupt(); }
  const structuralId = searchDigest([row.source_type, row.source_id, row.part_id, material.digest, material.version,
    location.start, location.end, location.page, location.sectionPath, material.context]);
  const expectedId = row.chunk_type === 'code' ? searchDigest(['code-classification-v1', structuralId]) : structuralId;
  if (![row.source_type, 'code'].includes(row.chunk_type) || expectedId !== args.chunkId) return corrupt();
  // loadSource reads at most this canonical part and its bounded metadata;
  // blob-backed text supplies only its verified digest reference, never bytes.
  // It independently resolves ownership and root/branch tombstone visibility.
  const source = loadSource(db, key);
  if (!source || source.threadId !== args.threadId || source.messageId !== args.messageId ||
      source.chunk.partId !== args.partId || source.chunk.sourceId !== args.messageId ||
      source.chunk.sourceType !== row.source_type || source.chunk.sourceDigest !== material.digest ||
      source.chunk.contextPrefix !== material.context ||
      JSON.stringify(source.chunk.sectionPath ?? []) !== JSON.stringify(location.sectionPath) ||
      (source.text !== null && location.end > source.text.length)) return stale();
  return { threadId: args.threadId, messageId: args.messageId, partId: args.partId, position: location };
}
