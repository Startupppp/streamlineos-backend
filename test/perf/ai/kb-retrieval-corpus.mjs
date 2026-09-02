/**
 * The corpus the KB retrieval benchmark measures against.
 *
 * Two decisions here are the whole point of the exercise, and both are easy to
 * get wrong in a way that flatters the result:
 *
 * 1. **Organisations of very different sizes.** `kb_article_chunks` carries RLS
 *    (`org_id = app.current_org_id()`), and the HNSW index is on `embedding`
 *    alone — it has no `org_id` in it. The tenant qual is therefore a *post*
 *    filter on ANN output. A tenant holding most of the index gets its neighbours
 *    from the first candidates the graph returns; a tenant holding 1% of it has
 *    99 of every 100 candidates discarded and pgvector must keep walking. Measure
 *    only the big tenant and the index looks fast for everybody.
 *
 * 2. **One shared topic space, not one region per organisation.** If each org's
 *    vectors were generated in their own corner, a small tenant's query would
 *    land where only its own rows live and the post-filter would cost nothing —
 *    a measurement of the seeding, not of the index. Real knowledge bases overlap
 *    heavily (onboarding, security, expenses), so every chunk draws its topic from
 *    one shared pool and an org's share of any neighbourhood is its share of the
 *    corpus.
 *
 * Vectors are built inside Postgres as `topic + jitter` over two small pools of
 * real `vector(1536)` values. Shipping ~50k × 1536 floats over the wire as text
 * is hundreds of megabytes; pool addition gives 4096 × 512 distinct points for
 * the cost of generating 4608 vectors.
 */

export const CORPUS = [
  { orgId: "perf_kb_major", chunks: 40_000, label: "majority tenant (~81% of the index)" },
  { orgId: "perf_kb_mid", chunks: 8_000, label: "mid tenant (~16%)" },
  { orgId: "perf_kb_minor", chunks: 800, label: "MINORITY tenant (~1.6%)" },
  { orgId: "perf_kb_tiny", chunks: 200, label: "tiny tenant (~0.4%)" },
];

export const EMBEDDING_DIMENSIONS = 1536;
export const TOPIC_POOL = 4096;
export const JITTER_POOL = 512;

/** Matches `EmbeddingsService`'s model string so the seeded rows look real. */
export const EMBEDDING_MODEL = "text-embedding-3-small";

export const TOTAL_CHUNKS = CORPUS.reduce((sum, o) => sum + o.chunks, 0);

export function shareOf(orgId) {
  const org = CORPUS.find((o) => o.orgId === orgId);
  return org ? org.chunks / TOTAL_CHUNKS : 0;
}

/**
 * A vector with a single dominant coordinate per topic plus small noise on the
 * rest. Cheap to build in SQL and gives a genuine nearest-neighbour structure
 * rather than 1536 independent uniforms, which are all near-orthogonal and make
 * every ANN query degenerate into a scan.
 */
export const TOPIC_VECTOR_SQL = `
  SELECT (
    '[' || string_agg(
      CASE WHEN d = (t % ${EMBEDDING_DIMENSIONS}) THEN '1' ELSE '0.001' END,
      ',' ORDER BY d
    ) || ']'
  )::vector AS emb
  FROM generate_series(0, ${EMBEDDING_DIMENSIONS - 1}) d
`;

export const JITTER_VECTOR_SQL = `
  SELECT (
    '[' || string_agg(round((random() * 0.06)::numeric, 4)::text, ',' ORDER BY d) || ']'
  )::vector AS emb
  FROM generate_series(0, ${EMBEDDING_DIMENSIONS - 1}) d
`;
