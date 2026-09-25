export type KbRetrievalStrategy = { kind: "exact" } | { kind: "ann"; efSearch: number };

export const KB_RETRIEVAL_MIN_RECALL = 0.95;

export const KB_EXACT_SCAN_MAX_CHUNKS = 8_000;

export const KB_ANN_EF_SEARCH_MULTIPLIER = 8;

export const KB_ANN_EF_SEARCH_MAX = 1_000;

export const KB_CHUNK_COUNT_CACHE_TTL_SECONDS = 300;

export function kbAnnEfSearch(cap: number): number {
  const scaled = Math.ceil(cap * KB_ANN_EF_SEARCH_MULTIPLIER);
  return Math.trunc(Math.min(Math.max(scaled, cap), KB_ANN_EF_SEARCH_MAX));
}

export function decideKbRetrievalStrategy(
  indexedChunkCount: number,
  cap: number,
): KbRetrievalStrategy {
  if (indexedChunkCount <= KB_EXACT_SCAN_MAX_CHUNKS) return { kind: "exact" };
  if (cap > KB_ANN_EF_SEARCH_MAX) return { kind: "exact" };
  return { kind: "ann", efSearch: kbAnnEfSearch(cap) };
}
