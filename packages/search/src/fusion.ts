/** Reciprocal Rank Fusion (product §43): each ranked list contributes
 * 1 / (k + rank) per item; raw BM25 and cosine scores are never compared. */
export const RRF_K = 60;
export interface FusedItem<T> {
  id: string;
  item: T;
  score: number;
  lexicalRank: number | null;
  semanticRank: number | null;
  explanation: "Exact text match" | "Semantic match" | "Exact + semantic match";
}
/** Fuse two ranked lists (rank 1 first) by stable item id. Ties keep the
 * lexical order, then the semantic order, so the result is deterministic. */
export function fuseRanked<T>(
  lexical: readonly { id: string; item: T }[],
  semantic: readonly { id: string; item: T }[],
  k = RRF_K,
): FusedItem<T>[] {
  if (!Number.isFinite(k) || k <= 0) throw new RangeError("RRF k must be positive");
  const fused = new Map<string, FusedItem<T>>();
  const add = (list: readonly { id: string; item: T }[], key: "lexicalRank" | "semanticRank") => {
    const seen = new Set<string>();
    for (const [index, entry] of list.entries()) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      const rank = index + 1;
      const current = fused.get(entry.id) ?? { id: entry.id, item: entry.item, score: 0, lexicalRank: null, semanticRank: null, explanation: "Exact text match" as const };
      current[key] = rank;
      current.score += 1 / (k + rank);
      fused.set(entry.id, current);
    }
  };
  add(lexical, "lexicalRank");
  add(semantic, "semanticRank");
  const order = (value: FusedItem<T>) => [value.lexicalRank ?? Number.POSITIVE_INFINITY, value.semanticRank ?? Number.POSITIVE_INFINITY];
  return [...fused.values()]
    .map((value) => ({
      ...value,
      explanation: value.lexicalRank !== null && value.semanticRank !== null ? "Exact + semantic match" as const : value.semanticRank !== null ? "Semantic match" as const : "Exact text match" as const,
    }))
    .sort((a, b) => b.score - a.score || order(a)[0]! - order(b)[0]! || order(a)[1]! - order(b)[1]! || a.id.localeCompare(b.id));
}
