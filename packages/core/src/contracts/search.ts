import type { SearchChunk, QuixiId } from "../model/types.ts";
import { isQuixiId } from "../model/validation.ts";
import { jsonByteLength } from "./serialization.ts";
import type { PageBudget } from "./storage.ts";
import type { PublishedPageRef } from "./extraction.ts";
export interface ChunkPosition {
  partId: QuixiId | null;
  /** Half-open UTF-16 offsets in authoritative part/page text before normalization. */
  start: number;
  end: number;
  page: number | null;
  sectionPath: string[];
}
export interface LocatedSearchChunk extends SearchChunk {
  position: ChunkPosition;
}
export interface SearchFilters {
  sourceTypes?: SearchChunk["sourceType"][];
  providers?: string[];
  models?: string[];
  after?: number;
  before?: number;
  tags?: string[];
  threadIds?: QuixiId[];
  documentIds?: QuixiId[];
  mediaTypes?: string[];
  hasCode?: boolean;
  origin?: "native" | "imported";
  portability?:
    | "fully_portable"
    | "transformed"
    | "provider_dependent"
    | "blocked";
}
export interface SearchHit {
  chunkId: string;
  sourceType: SearchChunk["sourceType"];
  sourceId: string;
  position: ChunkPosition;
  threadId: QuixiId | null;
  messageId: QuixiId | null;
  documentId: QuixiId | null;
  title: string;
  role: string | null;
  provider: string | null;
  model: string | null;
  date: number | null;
  score: number;
  explanation: "Exact text match" | "Semantic match" | "Exact + semantic match";
  excerpt: { text: string; highlights: { start: number; end: number }[] };
}
export interface SearchIndexStatus {
  state: "ready" | "indexing" | "rebuilding" | "failed";
  version: string;
  indexedChunks: number;
  pendingSources: number;
  failedSources: number;
  activeEpoch: number;
  rebuildingEpoch: number | null;
  revision: number;
  semantic: { state: "unavailable" | "ready"; reason: string | null };
  activeSource: {
    sourceId: string;
    phase: "verifying" | "chunking";
    readBytes: number;
    sourceBytes: number;
  } | null;
  lastFailure: { sourceId: string; code: string; reason: string } | null;
}
export interface SearchPage {
  items: SearchHit[];
  nextCursor: string | null;
  bytes: number;
  modeUsed: "exact" | "best_lexical" | "hybrid" | "semantic";
  index: SearchIndexStatus;
}
/** Product §71: every vector references the exact model, tokenizer,
 * preprocessing, chunking and representation that produced it. Vectors of a
 * different identity are never mixed with the active index. */
export interface EmbeddingModelIdentity {
  modelName: string;
  modelVersion: string;
  /** SHA-256 of the compiled model artifact. */
  sourceHash: string;
  dimensions: number;
  tokenizerVersion: string;
  preprocessingVersion: string;
  chunkingVersion: string;
  storageRepresentation: "float32";
}
export const SEMANTIC_DIMENSIONS = 384;
export interface SemanticIndexStatus {
  /** disabled: no model enrolled; enrolled: indexing may proceed; paused:
   * enrolled but claims are refused until resumed. */
  state: "disabled" | "enrolled" | "paused";
  model: EmbeddingModelIdentity | null;
  /** Every enrollment, rebuild and deletion starts a new generation; vectors
   * published for an older generation are rejected. */
  generation: number;
  /** Visible active-epoch chunks with a vector for the enrolled model. */
  indexedChunks: number;
  /** Visible active-epoch chunks still lacking one. */
  pendingChunks: number;
  /** Distinct stored vectors and their float32 payload bytes. */
  vectors: number;
  vectorBytes: number;
}
export interface SemanticClaim {
  generation: number;
  model: EmbeddingModelIdentity | null;
  /** Chunks needing a vector, with the exact embedding input and its SHA-256. */
  items: { chunkId: string; textDigest: string; text: string }[];
  /** Chunks linked to an already stored vector for the same input during this claim. */
  reused: number;
}
export interface SemanticPublication {
  accepted: number;
  rejected: { chunkId: string; reason: "stale_generation" | "model_mismatch" | "chunk_changed" | "invalid_vector" | "duplicate" }[];
  status: SemanticIndexStatus;
}
/** Navigation follows the exact current chunk, never a document/page-number guess. */
export interface DocumentSearchResolution {
  documentId: QuixiId;
  attachmentId: QuixiId;
  pageRef: PublishedPageRef | null;
  position: ChunkPosition;
}
/** Position paths may address canonical attachment fields; offsets never imply
 * that filename text was prefixed to a part description. */
export interface ConversationSearchResolution {
  threadId: QuixiId;
  messageId: QuixiId;
  partId: QuixiId | null;
  position: ChunkPosition;
}
export interface SearchOperations {
  resolveConversationSearchHit: {
    args: { chunkId: string; threadId: QuixiId; messageId: QuixiId; partId: QuixiId | null };
    result: ConversationSearchResolution;
  };
  resolveDocumentSearchHit: {
    args: { chunkId: string; documentId: QuixiId };
    result: DocumentSearchResolution;
  };
  searchArchive: {
    args: {
      query: string;
      mode: "exact" | "best" | "semantic";
      filters: SearchFilters;
      page: PageBudget;
      /** The query embedded with query semantics by the caller's embedding
       * worker; required for semantic mode and for hybrid Best. Without it
       * Best stays lexical. */
      queryVector?: number[];
    };
    result: SearchPage;
  };
  semanticStatus: { args: null; result: SemanticIndexStatus };
  /** Enrol or replace the embedding model. A different identity drops every
   * stored vector; canonical history and the lexical index are untouched. */
  enrollSemantic: { args: { operationId: QuixiId; model: EmbeddingModelIdentity }; result: SemanticIndexStatus };
  setSemanticState: { args: { state: "enrolled" | "paused" }; result: SemanticIndexStatus };
  /** Bounded work for the embedding worker: visible chunks without a vector. */
  claimSemanticChunks: { args: { maxChunks: number; maxBytes: number }; result: SemanticClaim };
  /** Vectors go through this boundary only; stale generations, changed
   * chunks and malformed vectors are rejected individually. */
  publishSemanticVectors: {
    args: { generation: number; items: { chunkId: string; textDigest: string; vector: number[] }[] };
    result: SemanticPublication;
  };
  /** Drops vectors and the enrolment; nothing canonical or lexical changes. */
  deleteSemanticIndex: { args: { operationId: QuixiId }; result: SemanticIndexStatus };
  searchStatus: { args: null; result: SearchIndexStatus };
  /** Rebuilds only derived data; ordinary canonical history and sync are untouched. */
  rebuildSearch: { args: { operationId: QuixiId }; result: SearchIndexStatus };
  /** One explicit bounded maintenance slice; repeats may advance more derived work. */
  advanceSearchIndex: {
    args: { maxChunks: number };
    result: SearchIndexStatus;
  };
}
const names = [
  "sourceTypes",
  "providers",
  "models",
  "after",
  "before",
  "tags",
  "threadIds",
  "documentIds",
  "mediaTypes",
  "hasCode",
  "origin",
  "portability",
];
export function assertSearchArgs(
  operation: keyof SearchOperations,
  value: unknown,
): void {
  jsonByteLength(value);
  if (operation === "searchStatus" || operation === "semanticStatus") {
    if (value !== null) throw new Error("Search status takes null arguments");
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid search arguments");
  const args = value as Record<string, unknown>;
  if (operation === "resolveConversationSearchHit") {
    if (Object.keys(args).length !== 4 || !isQuixiId(args.threadId) ||
        !isQuixiId(args.messageId) || (args.partId !== null && !isQuixiId(args.partId)) ||
        typeof args.chunkId !== "string" || !/^[0-9a-f]{64}$/.test(args.chunkId))
      throw new Error("Invalid exact conversation search identity");
    return;
  }
  if (operation === "resolveDocumentSearchHit") {
    if (
      Object.keys(args).length !== 2 ||
      !isQuixiId(args.documentId) ||
      typeof args.chunkId !== "string" ||
      !/^[0-9a-f]{64}$/.test(args.chunkId)
    )
      throw new Error("Invalid exact document search identity");
    return;
  }
  if (operation === "rebuildSearch" || operation === "deleteSemanticIndex") {
    if (Object.keys(args).length !== 1 || !isQuixiId(args.operationId))
      throw new Error("Invalid derived-index operation identity");
    return;
  }
  if (operation === "enrollSemantic") {
    if (Object.keys(args).length !== 2 || !isQuixiId(args.operationId)) throw new Error("Invalid enrolment identity");
    assertEmbeddingModelIdentity(args.model);
    return;
  }
  if (operation === "setSemanticState") {
    if (Object.keys(args).length !== 1 || !["enrolled", "paused"].includes(String(args.state))) throw new Error("Invalid semantic state");
    return;
  }
  if (operation === "claimSemanticChunks") {
    if (Object.keys(args).length !== 2 || !Number.isSafeInteger(args.maxChunks) || Number(args.maxChunks) < 1 || Number(args.maxChunks) > 64 ||
        !Number.isSafeInteger(args.maxBytes) || Number(args.maxBytes) < 1024 || Number(args.maxBytes) > 1_048_576)
      throw new Error("Invalid bounded semantic claim");
    return;
  }
  if (operation === "publishSemanticVectors") {
    if (Object.keys(args).length !== 2 || !Number.isSafeInteger(args.generation) || Number(args.generation) < 1 || !Array.isArray(args.items) || args.items.length > 64)
      throw new Error("Invalid semantic publication");
    for (const item of args.items as unknown[]) {
      const value = item as Record<string, unknown>;
      if (!value || typeof value !== "object" || Object.keys(value).length !== 3 || typeof value.chunkId !== "string" || !/^[0-9a-f]{64}$/.test(value.chunkId) ||
          typeof value.textDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.textDigest) || !isVector(value.vector))
        throw new Error("Invalid semantic vector item");
    }
    return;
  }
  if (operation === "advanceSearchIndex") {
    if (
      !Number.isSafeInteger(args.maxChunks) ||
      Number(args.maxChunks) < 1 ||
      Number(args.maxChunks) > 128
    )
      throw new Error("Invalid bounded indexing slice");
    return;
  }
  if (
    typeof args.query !== "string" ||
    args.query.length > 4096 ||
    !["exact", "best", "semantic"].includes(String(args.mode)) ||
    (args.queryVector !== undefined && !isVector(args.queryVector))
  )
    throw new Error("Invalid search query, mode or query vector");
  if (
    !args.filters ||
    typeof args.filters !== "object" ||
    Array.isArray(args.filters)
  )
    throw new Error("Invalid search filters");
  const filters = args.filters as Record<string, unknown>;
  if (Object.keys(filters).some((key) => !names.includes(key)))
    throw new Error("Unknown search filter");
  for (const name of [
    "sourceTypes",
    "providers",
    "models",
    "tags",
    "threadIds",
    "documentIds",
    "mediaTypes",
  ]) {
    const field = filters[name];
    if (field === undefined) continue;
    if (
      !Array.isArray(field) ||
      field.length < 1 ||
      field.length > 32 ||
      field.some(
        (item) => typeof item !== "string" || !item.length || item.length > 256,
      ) ||
      new Set(field).size !== field.length
    )
      throw new Error("Invalid bounded search filter values");
    if (
      (name === "threadIds" || name === "documentIds") &&
      !field.every(isQuixiId)
    )
      throw new Error("Invalid search source identity");
    if (
      name === "sourceTypes" &&
      field.some(
        (item) =>
          !["message", "document", "ocr", "code", "tool_output"].includes(item),
      )
    )
      throw new Error("Invalid search source type");
  }
  for (const name of ["after", "before"])
    if (
      filters[name] !== undefined &&
      (!Number.isSafeInteger(filters[name]) || Number(filters[name]) < 0)
    )
      throw new Error("Invalid search date");
  if (
    filters.after !== undefined &&
    filters.before !== undefined &&
    Number(filters.after) > Number(filters.before)
  )
    throw new Error("Search date range is reversed");
  if (filters.hasCode !== undefined && typeof filters.hasCode !== "boolean")
    throw new Error("Invalid code filter");
  if (
    filters.origin !== undefined &&
    !["native", "imported"].includes(String(filters.origin))
  )
    throw new Error("Invalid search origin");
  if (
    filters.portability !== undefined &&
    ![
      "fully_portable",
      "transformed",
      "provider_dependent",
      "blocked",
    ].includes(String(filters.portability))
  )
    throw new Error("Invalid portability filter");
}

/** Exactly SEMANTIC_DIMENSIONS finite numbers. */
export function isVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === SEMANTIC_DIMENSIONS && value.every((item) => typeof item === "number" && Number.isFinite(item));
}
export function assertEmbeddingModelIdentity(value: unknown): asserts value is EmbeddingModelIdentity {
  const model = value as Record<string, unknown> | null;
  const text = (key: string, max: number) => typeof model?.[key] === "string" && (model[key] as string).length >= 1 && (model[key] as string).length <= max;
  if (
    !model || typeof model !== "object" || Array.isArray(model) || Object.keys(model).length !== 8 ||
    !text("modelName", 128) || !text("modelVersion", 128) || !/^[0-9a-f]{64}$/.test(String(model.sourceHash)) ||
    model.dimensions !== SEMANTIC_DIMENSIONS || !text("tokenizerVersion", 128) || !text("preprocessingVersion", 128) ||
    !text("chunkingVersion", 128) || model.storageRepresentation !== "float32"
  )
    throw new Error("Invalid embedding model identity");
}
