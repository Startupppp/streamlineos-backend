/**
 * Seed kb_article_chunks with semantically clustered vectors for HNSW measurement.
 *
 * Each org's vectors are drawn near a per-org random centroid with small Gaussian
 * noise (σ ≈ 0.05 per dimension). A query vector near org-b's centroid will land
 * in org-b's region of the HNSW graph, simulating real semantic embeddings where
 * a user's query is semantically close to that user's org's content.
 *
 * This is distinct from seed-hnsw-chunks.mjs which uses uniform random vectors.
 *
 * Run:
 *   node src/scripts/seed-hnsw-clustered.mjs
 *
 * Uses the owner role to bypass RLS. Vectors are generated server-side via
 * pgvector vector-addition (centroid + per-row noise). Centroids are generated
 * in JS and stored in a temp table so they remain consistent within the session.
 */

import postgres from "postgres";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to run against NODE_ENV=production.");
  process.exit(1);
}

const OWNER_URL = process.env.DATABASE_URL;
if (!OWNER_URL) throw new Error("DATABASE_URL is required");

const db = postgres(OWNER_URL, { max: 1, prepare: false, onnotice: () => {} });

const started = Date.now();
const log = (msg) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}`);

const SEED_ORG = "73e5076a-225f-4b4c-b93e-9bc66a548bfe";
const ORG_B    = "c5b82e53-e69e-4937-ace8-1126ae3c0c7f";
const ORG_C    = "ed6e823a-2543-4696-9d75-6876741f6fd4";

const DIMS = 1536;
const NOISE_SIGMA = 0.05;
const BATCH = 1000;

const PLANS = [
  { orgId: SEED_ORG, count: 15000, label: "seed-org" },
  { orgId: ORG_B,    count: 7500,  label: "org-b" },
  { orgId: ORG_C,    count: 7500,  label: "org-c" },
];

function randomUnitVector(dim) {
  const v = Array.from({ length: dim }, () => Math.random() * 2 - 1);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

async function main() {
  await db`SET statement_timeout = 0`;

  log("Generating per-org centroids in JS …");
  const centroids = {
    [SEED_ORG]: randomUnitVector(DIMS),
    [ORG_B]:    randomUnitVector(DIMS),
    [ORG_C]:    randomUnitVector(DIMS),
  };

  log("Creating temp table for centroids …");
  await db.unsafe(`
    CREATE TEMP TABLE clustered_centroids (
      org_id uuid PRIMARY KEY,
      centroid vector(${DIMS})
    ) ON COMMIT PRESERVE ROWS
  `);

  for (const [orgId, centroid] of Object.entries(centroids)) {
    await db.unsafe(`
      INSERT INTO clustered_centroids VALUES ('${orgId}', '[${centroid.join(",")}]'::vector(${DIMS}))
    `);
    log(`Centroid inserted for ${orgId.slice(0, 8)}…`);
  }

  log("Deleting existing HNSW-seeded rows for measurement orgs …");
  await db.unsafe(`
    DELETE FROM kb_article_chunks
    WHERE org_id IN (
      '${SEED_ORG}', '${ORG_B}', '${ORG_C}'
    )
    AND embedding_model = 'text-embedding-3-small'
  `);
  const [afterDel] = await db`SELECT count(*)::int AS n FROM kb_article_chunks`;
  log(`Rows remaining after delete: ${afterDel.n}`);

  for (const { orgId, count, label } of PLANS) {
    const batches = Math.ceil(count / BATCH);
    let inserted = 0;

    log(`${label}: inserting ${count} clustered vectors in ${batches} batches …`);

    for (let b = 0; b < batches; b++) {
      const batchCount = Math.min(BATCH, count - inserted);
      const offset = inserted;

      await db.unsafe(`
        INSERT INTO kb_article_chunks
          (org_id, source, chunk_index, content, embedding, embedding_model, acl_revision)
        SELECT
          '${orgId}',
          'article_body',
          ${offset} + g,
          'Clustered content chunk ' || (${offset} + g),
          (
            SELECT centroid FROM clustered_centroids WHERE org_id = '${orgId}'
          ) + (array(SELECT (random() - 0.5) * ${NOISE_SIGMA} FROM generate_series(1, ${DIMS})))::vector(${DIMS}),
          'text-embedding-3-small',
          1
        FROM generate_series(1, ${batchCount}) g
      `);

      inserted += batchCount;
      if (b % 5 === 0 || inserted === count)
        log(`${label}: ${inserted} / ${count} inserted`);
    }

    const [after] = await db`
      SELECT count(*)::int AS n FROM kb_article_chunks WHERE org_id = ${orgId}
    `;
    log(`${label}: total rows = ${after.n}`);
  }

  const [total] = await db`SELECT count(*)::int AS n FROM kb_article_chunks`;
  log(`Total kb_article_chunks: ${total.n}`);

  log("Running VACUUM ANALYZE kb_article_chunks …");
  await db.unsafe("VACUUM ANALYZE kb_article_chunks");
  log("VACUUM ANALYZE done");

  const [stat] = await db`
    SELECT n_live_tup, n_dead_tup, last_analyze
    FROM pg_stat_user_tables
    WHERE relname = 'kb_article_chunks'
  `;
  log(`Stats: live=${stat.n_live_tup} dead=${stat.n_dead_tup} last_analyze=${stat.last_analyze}`);

  log("Centroids (first 5 dims) for query generation:");
  for (const [orgId, centroid] of Object.entries(centroids)) {
    log(`  ${orgId.slice(0, 8)}: [${centroid.slice(0, 5).map((x) => x.toFixed(4)).join(", ")}, …]`);
  }

  const centroidB = centroids[ORG_B];
  const centroidSeed = centroids[SEED_ORG];
  log("\nPaste these into measure-hnsw-clustered.mjs:");
  log(`const CENTROID_B = [${centroidB.join(",")}];`);
  log(`const CENTROID_SEED = [${centroidSeed.join(",")}];`);
}

main()
  .catch((e) => {
    console.error("SEED FAILED:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.end());
