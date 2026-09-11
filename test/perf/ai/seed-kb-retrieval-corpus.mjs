/**
 * Seeds the KB retrieval corpus described in `kb-retrieval-corpus.mjs`.
 *
 * Owner-role only: it creates tenants and bulk-loads them. The measurement that
 * follows runs as `streamline_app` with the tenant GUC, never as the owner —
 * the owner has BYPASSRLS, so its plans omit the post-filter that is the entire
 * subject of the benchmark.
 *
 * Usage (never against the configured DATABASE_URL — a scratch database only):
 *   PERF_DATABASE_URL="postgresql://neondb_owner:...@127.0.0.1:5432/scratch_ai_latency" \
 *     node test/perf/ai/seed-kb-retrieval-corpus.mjs
 */
import postgres from "postgres";
import {
  CORPUS,
  EMBEDDING_MODEL,
  JITTER_POOL,
  JITTER_VECTOR_SQL,
  TOPIC_POOL,
  TOPIC_VECTOR_SQL,
  TOTAL_CHUNKS,
  jitterIndexSql,
  topicIndexSql,
} from "./kb-retrieval-corpus.mjs";

const url = process.env.PERF_DATABASE_URL;
if (!url) {
  console.error("PERF_DATABASE_URL is required and must point at a scratch database.");
  process.exit(2);
}
if (!/\/scratch_/.test(url)) {
  console.error("Refusing to run: PERF_DATABASE_URL must name a scratch_* database.");
  process.exit(2);
}

const sql = postgres(url, { max: 1, onnotice: () => {}, idle_timeout: 0, connect_timeout: 30 });

function step(label) {
  const started = Date.now();
  return () => console.log(`  ${label} — ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

async function ensureTenants() {
  const done = step("tenants");
  for (const { orgId } of CORPUS) {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET CONSTRAINTS ALL DEFERRED");
      await tx`
        INSERT INTO users (id, email, name)
        VALUES (${`${orgId}_owner`}, ${`${orgId}@perf.invalid`}, ${"Perf Owner"})
        ON CONFLICT (id) DO NOTHING`;
      await tx`
        INSERT INTO organizations (id, name, slug, owner_membership_id)
        VALUES (${orgId}, ${orgId}, ${orgId.replace(/_/g, "-")}, 1)
        ON CONFLICT (id) DO NOTHING`;
      const [member] = await tx`
        INSERT INTO organization_members (user_id, org_id, role, is_owner)
        VALUES (${`${orgId}_owner`}, ${orgId}, 'OWNER', true)
        ON CONFLICT DO NOTHING
        RETURNING id`;
      if (member)
        await tx`UPDATE organizations SET owner_membership_id = ${member.id} WHERE id = ${orgId}`;
    });
  }
  done();
}

async function buildPools() {
  const done = step(`vector pools (${TOPIC_POOL} topics × ${JITTER_POOL} jitters)`);
  await sql.unsafe(`DROP TABLE IF EXISTS perf_topic_pool, perf_jitter_pool`);
  await sql.unsafe(`
    CREATE TABLE perf_topic_pool AS
    SELECT t AS id, (${TOPIC_VECTOR_SQL}) AS emb
    FROM generate_series(0, ${TOPIC_POOL - 1}) t`);
  await sql.unsafe(`
    CREATE TABLE perf_jitter_pool AS
    SELECT j AS id, (${JITTER_VECTOR_SQL}) AS emb
    FROM generate_series(0, ${JITTER_POOL - 1}) j`);
  await sql.unsafe(`CREATE INDEX ON perf_topic_pool (id)`);
  await sql.unsafe(`CREATE INDEX ON perf_jitter_pool (id)`);
  done();
}

/**
 * The HNSW index is dropped for the load and rebuilt once. Maintaining a graph
 * index row by row across 49k inserts is both far slower and a worse graph than
 * one bulk build, and the benchmark measures the index a real deployment would
 * have after a reindex.
 */
async function dropAnnIndex() {
  await sql.unsafe(`DROP INDEX IF EXISTS idx_kb_chunks_embedding_hnsw`);
}

async function rebuildAnnIndex() {
  const done = step("HNSW rebuild");
  await sql.unsafe(`SET maintenance_work_mem = '1GB'`);
  await sql.unsafe(
    `CREATE INDEX idx_kb_chunks_embedding_hnsw ON public.kb_article_chunks
       USING hnsw (embedding vector_cosine_ops)`,
  );
  done();
}

async function loadChunks() {
  await sql`DELETE FROM kb_article_chunks WHERE org_id LIKE 'perf_kb_%'`;
  for (const { orgId, chunks, seed } of CORPUS) {
    const done = step(`${orgId}: ${chunks.toLocaleString()} chunks`);
    const batch = 4_000;
    for (let offset = 0; offset < chunks; offset += batch) {
      const size = Math.min(batch, chunks - offset);
      await sql.unsafe(
        `INSERT INTO kb_article_chunks
           (org_id, source, chunk_index, content, content_hash, tokens,
            embedding, embedding_model, acl_revision)
         SELECT
           $1,
           'article_body',
           g,
           'chunk ' || g || ' of the ' || $1 || ' knowledge base',
           md5($1 || g::text),
           96,
           tp.emb + jp.emb,
           $2,
           1
         FROM generate_series($3::int, $3::int + $4::int - 1) g
         JOIN perf_topic_pool tp ON tp.id = ${topicIndexSql(seed)}
         JOIN perf_jitter_pool jp ON jp.id = ${jitterIndexSql(seed)}`,
        [orgId, EMBEDDING_MODEL, offset, size],
      );
    }
    done();
  }
}

/**
 * A corpus of `n` rows drawn from `k` distinct points is a duplicate table, not
 * an ANN workload: HNSW over exact copies answers from the first neighbourhood
 * it enters and the post-filter cost this benchmark exists to measure never
 * materialises. The previous pool arithmetic produced 1,536 distinct embeddings
 * for 20,000 rows, so the ratio is asserted rather than assumed.
 */
async function assertCorpusIsNotDegenerate() {
  const rows = await sql`
    SELECT org_id,
           count(*)::int AS chunks,
           count(DISTINCT embedding)::int AS distinct_embeddings
    FROM kb_article_chunks
    WHERE org_id LIKE 'perf_kb_%'
    GROUP BY org_id`;
  for (const row of rows)
    if (row.distinct_embeddings < row.chunks)
      throw new Error(
        `${row.org_id} holds ${row.chunks} rows but only ${row.distinct_embeddings} distinct ` +
          `embeddings — the pool arithmetic is cycling and the corpus is not realistic.`,
      );
  const [{ distinct_embeddings: distinctOverall, chunks: totalChunks }] = await sql`
    SELECT count(*)::int AS chunks, count(DISTINCT embedding)::int AS distinct_embeddings
    FROM kb_article_chunks WHERE org_id LIKE 'perf_kb_%'`;
  console.log(
    `\nDistinct embeddings: ${distinctOverall.toLocaleString()} of ` +
      `${totalChunks.toLocaleString()} rows`,
  );
  if (distinctOverall < totalChunks)
    throw new Error("Two organisations share a point — the per-org seed offsets collide.");
}

async function main() {
  const [{ current_database: db }] = await sql`SELECT current_database()`;
  console.log(`Seeding ${TOTAL_CHUNKS.toLocaleString()} chunks into ${db}`);

  await ensureTenants();
  await buildPools();
  await dropAnnIndex();
  await loadChunks();
  await assertCorpusIsNotDegenerate();
  await rebuildAnnIndex();

  const done = step("VACUUM ANALYZE");
  await sql.unsafe(`VACUUM ANALYZE public.kb_article_chunks`);
  done();

  const rows = await sql`
    SELECT org_id, count(*)::int AS chunks
    FROM kb_article_chunks
    WHERE org_id LIKE 'perf_kb_%'
    GROUP BY org_id ORDER BY 2 DESC`;
  console.log("\nCorpus:");
  const total = rows.reduce((sum, r) => sum + r.chunks, 0);
  for (const r of rows)
    console.log(
      `  ${r.org_id.padEnd(16)} ${String(r.chunks).padStart(7)}  ${((r.chunks / total) * 100).toFixed(1)}%`,
    );
  console.log(`  ${"TOTAL".padEnd(16)} ${String(total).padStart(7)}`);

  await sql.end();
}

main().catch(async (error) => {
  console.error(error);
  await sql.end();
  process.exit(1);
});
