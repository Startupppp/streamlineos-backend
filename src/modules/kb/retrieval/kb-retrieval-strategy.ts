export type KbRetrievalStrategy = { kind: "exact" } | { kind: "ann"; efSearch: number };

/** Target only: exact meets it at 1.0000, ANN peaks at 0.8818 above the threshold — see KB-RETRIEVAL-LATENCY-HARNESS.md. */
export const KB_RETRIEVAL_MIN_RECALL = 0.95;

/** Largest size measured affordable at 1.0000 recall: 129,130 buffers / 67.86 ms. Above it exact costs 647,040 / 387 ms. */
export const KB_EXACT_SCAN_MAX_CHUNKS = 8_000;

/** pgvector needs ef_search >= LIMIT to return LIMIT good rows. */
export const KB_ANN_EF_SEARCH_MULTIPLIER = 8;

/** pgvector's ceiling for hnsw.ef_search. */
export const KB_ANN_EF_SEARCH_MAX = 1_000;

/** The count only decides which side of the threshold a tenant sits on, so staleness costs one mis-planned query. */
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
