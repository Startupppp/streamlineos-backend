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
 * Vectors are built inside Postgres as `topic + jitter` over two pools of real
 * `vector(1536)` values. Pool addition gives 1536 × 4093 ≈ 6.3M distinct points
 * for the cost of generating 5629 vectors.
 *
 * **The pool sizes are load-bearing, not arbitrary.** A chunk's point is
 * `(topic[(g+seed)·A mod T], jitter[(g+seed)·B mod J])`, so the pair repeats with
 * period `lcm(T, J)`. An earlier revision used `T = 4096, J = 512`; `512` divides
 * `4096`, so the pair cycled every 4096 rows — and because the topic body keyed
 * on `t % 1536` the pool itself held only 1536 distinct vectors. 20,000 seeded
 * rows carried **1,536 distinct embeddings**, ~13 exact copies each, which is a
 * duplicate table wearing a corpus's clothes rather than an ANN workload. `T` is
 * now exactly the dimension count so every topic is a genuinely distinct
 * dominant coordinate, and `J` is prime, so `lcm(1536, 4093) = 6,286,848` and no
 * corpus this benchmark would ever seed repeats a point.
 */

export const EMBEDDING_DIMENSIONS = 1536;

/** One distinct dominant coordinate per topic — hence exactly the dimension count. */
export const TOPIC_POOL = EMBEDDING_DIMENSIONS;

/** Prime, and coprime with `TOPIC_POOL`, so the (topic, jitter) pair does not cycle. */
export const JITTER_POOL = 4093;

/**
 * Coprime with their respective pool sizes, so each index walks its whole pool.
 * `TOPIC_STRIDE` is odd (`1536 = 2^9 · 3`, and 761 is prime), `JITTER_STRIDE` is
 * prime and less than `JITTER_POOL`.
 */
export const TOPIC_STRIDE = 761;
export const JITTER_STRIDE = 3571;

/**
 * `seed` shifts an org's walk through the *shared* pools. Without it every org's
 * row `g` is the same point as every other org's row `g`, so the minority tenant
 * would be an exact duplicate subset of the majority — a corpus in which the
 * post-filter can never discard anything the tenant did not also own.
 */
export const CORPUS = [
  {
    orgId: "perf_kb_major",
    chunks: 40_000,
    seed: 0,
    label: "majority tenant (~81% of the index)",
  },
  { orgId: "perf_kb_mid", chunks: 8_000, seed: 1_000_003, label: "mid tenant (~16%)" },
  {
    orgId: "perf_kb_minor",
    chunks: 800,
    seed: 2_000_003,
    label: "MINORITY tenant (~1.6%)",
  },
  { orgId: "perf_kb_tiny", chunks: 200, seed: 3_000_003, label: "tiny tenant (~0.4%)" },
];

/** Matches `EmbeddingsService`'s model string so the seeded rows look real. */
export const EMBEDDING_MODEL = "text-embedding-3-small";

export const TOTAL_CHUNKS = CORPUS.reduce((sum, o) => sum + o.chunks, 0);

export function shareOf(orgId) {
  const org = CORPUS.find((o) => o.orgId === orgId);
  return org ? org.chunks / TOTAL_CHUNKS : 0;
}

/**
 * The pool index expressions, as SQL over a `generate_series` column `g`.
 *
 * **The `::bigint` is not cosmetic.** `g * 3571` exceeds `int4` at g ≈ 601k and
 * `g * 104729` (the previous multiplier) exceeded it at g = 20,506 — which is
 * why the seeder used to die with `22003 integer out of range` partway through
 * the majority tenant and leave a 20,000-row corpus behind, well short of the
 * 49,000 it reports seeding.
 */
export function topicIndexSql(seed) {
  return `((g + ${seed})::bigint * ${TOPIC_STRIDE} % ${TOPIC_POOL})::int`;
}

export function jitterIndexSql(seed) {
  return `((g + ${seed})::bigint * ${JITTER_STRIDE} % ${JITTER_POOL})::int`;
}

/**
 * A vector with a single dominant coordinate per topic plus a small constant on
 * the rest. Cheap to build in SQL and gives a genuine nearest-neighbour
 * structure rather than 1536 independent uniforms, which are all near-orthogonal
 * and make every ANN query degenerate into a scan.
 *
 * `t` indexes the pool directly — it is never reduced modulo the dimension
 * count, so `TOPIC_POOL` distinct vectors really are `TOPIC_POOL` distinct
 * vectors.
 */
export const TOPIC_VECTOR_SQL = `
  SELECT (
    '[' || string_agg(
      CASE WHEN d = t THEN '1' ELSE '0.001' END,
      ',' ORDER BY d
    ) || ']'
  )::vector AS emb
  FROM generate_series(0, ${EMBEDDING_DIMENSIONS - 1}) d
`;

/**
 * Per-jitter noise in `[0, 0.06]`, derived from a hash of `(j, d)`.
 *
 * **It must reference `j`, and it must not use `random()`.** The previous
 * revision was `round((random() * 0.06)::numeric, 4)` over `generate_series(d)`
 * with no reference to the outer `j`. An uncorrelated scalar subquery is an
 * InitPlan: Postgres evaluated it **once** and reused the same 1536 floats for
 * every row, so `perf_jitter_pool` held 4093 rows and exactly **one** distinct
 * vector, and the whole corpus collapsed to `TOPIC_POOL` distinct points no
 * matter how many rows were seeded. Correlating on `j` forces per-row
 * evaluation; using a hash instead of `random()` makes the corpus reproducible,
 * so two runs of the benchmark measure the same index.
 */
export const JITTER_VECTOR_SQL = `
  SELECT (
    '[' || string_agg(
      ((((hashint8((j::bigint << 21) + d)::bigint & 2147483647) % 601))::numeric / 10000)::text,
      ',' ORDER BY d
    ) || ']'
  )::vector AS emb
  FROM generate_series(0, ${EMBEDDING_DIMENSIONS - 1}) d
`;
