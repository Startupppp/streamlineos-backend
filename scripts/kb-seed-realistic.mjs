/**
 * kb-seed-realistic.mjs
 * Replaces degenerate seed embeddings with structurally realistic vectors.
 *
 * Strategy:
 *   - Each org gets its own set of centroids clustered in a distinct
 *     region of the unit hypersphere (org meta-centroid + spread).
 *   - Each chunk embedding = normalize(centroid + small noise).
 *   - In 1536D, random unit vectors are nearly orthogonal, so org regions
 *     are naturally separated without any explicit orthogonalization.
 *   - Majority org: 100 centroids / 15000 rows
 *   - Minority orgs B and C: 50 centroids each / 7500 rows each
 *
 * Phases:
 *   1. Generate centroid sets per org
 *   2. UPDATE embeddings in batches of 200 rows (as owner)
 *   3. REINDEX idx_kb_chunks_embedding_hnsw
 *   4. VACUUM ANALYZE kb_article_chunks
 *   5. Measurements as streamline_app (majority plain ANN, minority plain ANN,
 *      minority fence, recall@20)
 *   6. Repeat measurements with SET LOCAL random_page_cost = 1
 *
 * Run: node scripts/kb-seed-realistic.mjs 2>&1 | tee kb-seed-output.txt
 */

import postgres from "../node_modules/postgres/cjs/src/index.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
const APP_DATABASE_URL = process.env.APP_DATABASE_URL;
if (!APP_DATABASE_URL) throw new Error("APP_DATABASE_URL is required");

const DIMS = 1536;
const MAJORITY_ORG = "73e5076a-225f-4b4c-b93e-9bc66a548bfe";
const MINORITY_B = "c5b82e53-e69e-4937-ace8-1126ae3c0c7f";
const MINORITY_C = "ed6e823a-2543-4696-9d75-6876741f6fd4";
const BATCH_SIZE = 200;

const sqlOwner = postgres(DATABASE_URL, { prepare: false, ssl: { rejectUnauthorized: false }, max: 1 });
const sqlApp = postgres(APP_DATABASE_URL, { prepare: false, ssl: { rejectUnauthorized: false }, max: 1 });

// ─── Vector utilities ───────────────────────────────────────────────────────

function randn() {
  const u1 = Math.max(Math.random(), 1e-12);
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function randomGaussianVector(dims) {
  return Array.from({ length: dims }, () => randn());
}

function l2normalize(v) {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

function addNoise(centroid, sigma) {
  return l2normalize(centroid.map((x) => x + sigma * randn()));
}

function vecToString(v) {
  return "[" + v.map((x) => x.toFixed(4)).join(",") + "]";
}

function dotProduct(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function cosineDist(a, b) {
  return 1 - dotProduct(a, b);
}

// Generate org centroids: meta-centroid defines the org's region,
// individual centroids spread around it with σ = 0.4 (substantial spread
// within the org, but still clustered relative to other orgs).
function generateOrgCentroids(count) {
  const meta = l2normalize(randomGaussianVector(DIMS));
  return Array.from({ length: count }, () => addNoise(meta, 0.4));
}

// ─── Phase 1: Generate centroids ─────────────────────────────────────────────

console.log("=== Phase 1: Generating centroids ===");
const centroids = {
  [MAJORITY_ORG]: generateOrgCentroids(100),
  [MINORITY_B]: generateOrgCentroids(50),
  [MINORITY_C]: generateOrgCentroids(50),
};
for (const [org, cs] of Object.entries(centroids)) {
  console.log(`  org ${org.slice(0, 8)}: ${cs.length} centroids`);
}

// Sanity check: inter-org centroid distances should be larger than intra-org
const interDist = cosineDist(centroids[MAJORITY_ORG][0], centroids[MINORITY_B][0]);
const intraDist = cosineDist(centroids[MAJORITY_ORG][0], centroids[MAJORITY_ORG][1]);
console.log(`  inter-org centroid cosine dist (sample): ${interDist.toFixed(4)}`);
console.log(`  intra-org centroid cosine dist (sample): ${intraDist.toFixed(4)}`);

// ─── Phase 2: Fetch row IDs per org and UPDATE embeddings ───────────────────

async function seedOrg(orgId, cs) {
  console.log(`\n=== Phase 2: Seeding org ${orgId.slice(0, 8)} ===`);
  const rows = await sqlOwner`SELECT id FROM kb_article_chunks WHERE org_id = ${orgId} ORDER BY id`;
  console.log(`  ${rows.length} rows to update`);

  let updated = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const parts = batch.map((r, j) => {
      const centroidIdx = (i + j) % cs.length;
      const vec = addNoise(cs[centroidIdx], 0.05);
      return `(${r.id}, '${vecToString(vec)}'::vector)`;
    });
    const valuesSQL = parts.join(",");
    await sqlOwner.unsafe(`
      UPDATE public.kb_article_chunks AS t
      SET embedding = v.embedding
      FROM (VALUES ${valuesSQL}) AS v(id, embedding)
      WHERE t.id = v.id::int
    `);
    updated += batch.length;
    if (updated % 2000 === 0 || updated === rows.length)
      console.log(`  updated ${updated}/${rows.length}`);
  }
}

await seedOrg(MAJORITY_ORG, centroids[MAJORITY_ORG]);
await seedOrg(MINORITY_B, centroids[MINORITY_B]);
await seedOrg(MINORITY_C, centroids[MINORITY_C]);

// Verify distinct vector count after seeding
const dist = await sqlOwner`
  SELECT org_id, COUNT(*)::int AS rows, COUNT(DISTINCT embedding::text)::int AS distinct_vecs
  FROM kb_article_chunks GROUP BY org_id ORDER BY rows DESC
`;
console.log("\nPost-seed distinct vector counts:");
dist.forEach((r) =>
  console.log(`  org ${r.org_id.slice(0, 8)}: rows=${r.rows} distinct_vecs=${r.distinct_vecs}`)
);

// ─── Phase 3: REINDEX ────────────────────────────────────────────────────────

console.log("\n=== Phase 3: REINDEX idx_kb_chunks_embedding_hnsw ===");
try {
  await sqlOwner.unsafe(`REINDEX INDEX CONCURRENTLY idx_kb_chunks_embedding_hnsw`);
  console.log("  REINDEX CONCURRENTLY complete");
} catch (e) {
  console.log(`  REINDEX CONCURRENTLY failed (${e.message}), trying non-concurrent`);
  await sqlOwner.unsafe(`REINDEX INDEX idx_kb_chunks_embedding_hnsw`);
  console.log("  REINDEX complete");
}

// ─── Phase 4: VACUUM ANALYZE ─────────────────────────────────────────────────

console.log("\n=== Phase 4: VACUUM ANALYZE ===");
await sqlOwner`VACUUM ANALYZE public.kb_article_chunks`;
console.log("  done");

// ─── Phase 5: Select query vector from minority org ──────────────────────────

console.log("\n=== Phase 5: Query vector selection ===");
// Take the first minority-C chunk's embedding as the query vector — its own
// row is a known nearest neighbor (distance = 0) and gives a recall baseline.
const queryRow = await sqlOwner`
  SELECT id, embedding::text AS vec_text
  FROM kb_article_chunks
  WHERE org_id = ${MINORITY_C}
  ORDER BY id
  LIMIT 1
`;
const queryId = queryRow[0].id;
const queryVec = queryRow[0].vec_text;
console.log(`  query source: id=${queryId}, org=${MINORITY_C.slice(0, 8)}`);
console.log(`  embedding prefix: ${queryVec.slice(0, 60)}...`);

// Brute-force top-20 for minority-C (as owner, no RLS)
const bruteForce = await sqlOwner.unsafe(`
  SELECT id FROM public.kb_article_chunks
  WHERE org_id = '${MINORITY_C}'
  ORDER BY embedding <=> '${queryVec}'::vector
  LIMIT 20
`);
const bfIds = new Set(bruteForce.map((r) => r.id));
console.log(`  brute-force top-20 ids: ${[...bfIds].sort((a, b) => a - b).join(",")}`);

// ─── Measurement helper ──────────────────────────────────────────────────────

async function measure(label, orgId, extra_settings, queryVecStr) {
  console.log(`\n--- ${label} ---`);
  const plan = await sqlApp.begin(async (tx) => {
    await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;
    for (const s of extra_settings) await tx.unsafe(s);
    return tx.unsafe(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
      SELECT id FROM public.kb_article_chunks
      ORDER BY embedding <=> '${queryVecStr}'::vector
      LIMIT 20
    `);
  });
  for (const r of plan) {
    const line = Object.values(r)[0];
    if (/Limit |Index Scan|Seq Scan|Bitmap|Sort |  Buffers:|Execution Time|Filter:|Order By:/.test(line))
      console.log(line);
  }
  const rows = await sqlApp.begin(async (tx) => {
    await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;
    for (const s of extra_settings) await tx.unsafe(s);
    return tx.unsafe(`
      SELECT id FROM public.kb_article_chunks
      ORDER BY embedding <=> '${queryVecStr}'::vector
      LIMIT 20
    `);
  });
  const annIds = new Set(rows.map((r) => r.id));
  return { rowCount: rows.length, annIds };
}

async function measureFence(label, orgId, extra_settings, queryVecStr) {
  console.log(`\n--- ${label} (fence) ---`);
  const plan = await sqlApp.begin(async (tx) => {
    await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;
    for (const s of extra_settings) await tx.unsafe(s);
    return tx.unsafe(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
      SELECT app.search_kb_chunk_ids('${queryVecStr}'::vector, 20) AS id
    `);
  });
  for (const r of plan) {
    const line = Object.values(r)[0];
    if (/ProjectSet|Index Scan|Seq Scan|Bitmap|Sort |  Buffers:|Execution Time|Filter:/.test(line))
      console.log(line);
  }
  const rows = await sqlApp.begin(async (tx) => {
    await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;
    for (const s of extra_settings) await tx.unsafe(s);
    return tx.unsafe(`
      SELECT app.search_kb_chunk_ids('${queryVecStr}'::vector, 20) AS id
    `);
  });
  return { rowCount: rows.length };
}

// ─── Phase 6: Measurements ───────────────────────────────────────────────────

console.log("\n=== Phase 6: Measurements (all as streamline_app with GUC) ===");
console.log("Query org: minority-C (ed6e823a), query id:", queryId);

// 6a. Majority org, plain ANN, default settings
const majResult = await measure(
  "6a. Majority org, plain ANN, default",
  MAJORITY_ORG, [], queryVec
);
console.log(`  Rows returned: ${majResult.rowCount}`);

// 6b. Minority org, plain ANN, default settings
const minDefault = await measure(
  "6b. Minority org, plain ANN, default",
  MINORITY_C, [], queryVec
);
const recallDefault = [...minDefault.annIds].filter((id) => bfIds.has(id)).length;
console.log(`  Rows returned: ${minDefault.rowCount}, Recall@20: ${recallDefault}/20`);

// 6c. Minority org via fence (current — MATERIALIZED CTE)
const fenceDefault = await measureFence(
  "6c. Minority org, fence (MATERIALIZED), default",
  MINORITY_C, [], queryVec
);
console.log(`  Rows returned: ${fenceDefault.rowCount}`);

// 6d. Majority org, relaxed_order
const majRelaxed = await measure(
  "6d. Majority org, relaxed_order",
  MAJORITY_ORG, [`SET LOCAL hnsw.iterative_scan = relaxed_order`], queryVec
);
console.log(`  Rows returned: ${majRelaxed.rowCount}`);

// 6e. Minority org, relaxed_order
const minRelaxed = await measure(
  "6e. Minority org, relaxed_order",
  MINORITY_C, [`SET LOCAL hnsw.iterative_scan = relaxed_order`], queryVec
);
const recallRelaxed = [...minRelaxed.annIds].filter((id) => bfIds.has(id)).length;
console.log(`  Rows returned: ${minRelaxed.rowCount}, Recall@20: ${recallRelaxed}/20`);

// 6f. Minority org, relaxed_order + random_page_cost=1
const minRpc1 = await measure(
  "6f. Minority org, relaxed_order + random_page_cost=1",
  MINORITY_C,
  [`SET LOCAL hnsw.iterative_scan = relaxed_order`, `SET LOCAL random_page_cost = 1`],
  queryVec
);
const recallRpc1 = [...minRpc1.annIds].filter((id) => bfIds.has(id)).length;
console.log(`  Rows returned: ${minRpc1.rowCount}, Recall@20: ${recallRpc1}/20`);

// 6g. Majority org, random_page_cost=1 only
const majRpc1 = await measure(
  "6g. Majority org, random_page_cost=1",
  MAJORITY_ORG, [`SET LOCAL random_page_cost = 1`], queryVec
);
console.log(`  Rows returned: ${majRpc1.rowCount}`);

// 6h. Minority org, strict_order + random_page_cost=1
const minStrict = await measure(
  "6h. Minority org, strict_order + random_page_cost=1",
  MINORITY_C,
  [`SET LOCAL hnsw.iterative_scan = strict_order`, `SET LOCAL random_page_cost = 1`],
  queryVec
);
const recallStrict = [...minStrict.annIds].filter((id) => bfIds.has(id)).length;
console.log(`  Rows returned: ${minStrict.rowCount}, Recall@20: ${recallStrict}/20`);

// 6i. Minority org, default settings (minority org B, different centroids)
// Use a query vector from org B to measure its own recall
const queryRowB = await sqlOwner`
  SELECT id, embedding::text AS vec_text
  FROM kb_article_chunks WHERE org_id = ${MINORITY_B} ORDER BY id LIMIT 1
`;
const queryVecB = queryRowB[0].vec_text;
const bfB = await sqlOwner.unsafe(`
  SELECT id FROM public.kb_article_chunks
  WHERE org_id = '${MINORITY_B}'
  ORDER BY embedding <=> '${queryVecB}'::vector LIMIT 20
`);
const bfBIds = new Set(bfB.map((r) => r.id));

const minBDefault = await measure(
  "6i. Minority org B, plain ANN, default",
  MINORITY_B, [], queryVecB
);
const recallBDefault = [...minBDefault.annIds].filter((id) => bfBIds.has(id)).length;
console.log(`  Rows returned: ${minBDefault.rowCount}, Recall@20: ${recallBDefault}/20`);

const minBRpc1 = await measure(
  "6j. Minority org B, relaxed_order + rpc=1",
  MINORITY_B,
  [`SET LOCAL hnsw.iterative_scan = relaxed_order`, `SET LOCAL random_page_cost = 1`],
  queryVecB
);
const recallBRpc1 = [...minBRpc1.annIds].filter((id) => bfBIds.has(id)).length;
console.log(`  Rows returned: ${minBRpc1.rowCount}, Recall@20: ${recallBRpc1}/20`);

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log("\n=== Summary ===");
console.log("Corpus: 30,000 rows; majority org 50%, minority orgs 25% each");
console.log("Query vector: taken from minority-C chunk id=" + queryId);
console.log("Brute-force top-20 baseline: org-filtered exact sort as owner");
console.log("\nKey results:");
console.log("  6b. Minority default  — rows=" + minDefault.rowCount + "  recall=" + recallDefault + "/20");
console.log("  6e. Minority relaxed  — rows=" + minRelaxed.rowCount + "  recall=" + recallRelaxed + "/20");
console.log("  6f. Minority rpc=1    — rows=" + minRpc1.rowCount + "  recall=" + recallRpc1 + "/20");
console.log("  6h. Minority strict+rpc=1 — rows=" + minStrict.rowCount + " recall=" + recallStrict + "/20");

await sqlOwner.end();
await sqlApp.end();
console.log("\nDone.");
