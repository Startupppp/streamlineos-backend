/**
 * HNSW clustered-vector measurement: compare ANN, MATERIALIZED fence, and iterative scan.
 *
 * Uses the clustered dataset seeded by src/scripts/seed-hnsw-clustered.mjs.
 * The query vector is derived as the centroid (mean) of org-b's own vectors, so it
 * geometrically lands in org-b's region of the HNSW graph — simulating real semantic
 * embeddings where a user's query is semantically close to their own content.
 *
 * All measurements as streamline_app with SET LOCAL tenant GUC inside a transaction.
 *
 * Run: node scripts/measure-hnsw-clustered.mjs
 */
import postgres from "postgres";

const OWNER_URL = "postgresql://neondb_owner:npg_uHztXRn51MdW@ep-orange-mode-azxn5hbr.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";
const APP_URL   = "postgresql://streamline_app:npg_eKlEfHtbMg93@ep-orange-mode-azxn5hbr.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";

const SEED_ORG = "73e5076a-225f-4b4c-b93e-9bc66a548bfe";
const ORG_B    = "c5b82e53-e69e-4937-ace8-1126ae3c0c7f";

const DIMS = 1536;
const LIMIT = 20;

function printPlan(label, rows) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`SCENARIO: ${label}`);
  console.log(`${"=".repeat(70)}`);
  for (const row of rows) {
    const text = row["QUERY PLAN"] ?? row[Object.keys(row)[0]];
    console.log(text);
  }
}

async function main() {
  const ownerDb = postgres(OWNER_URL, { max: 1, idle_timeout: 120, prepare: false });
  let queryVec;

  try {
    const [cnt] = await ownerDb`SELECT count(*)::int AS n FROM kb_article_chunks WHERE org_id = ${ORG_B}`;
    console.log(`org-b rows: ${cnt.n}`);
    if (cnt.n === 0) { console.log("No org-b rows — run seed-hnsw-clustered.mjs first."); return; }

    const [stat] = await ownerDb`
      SELECT n_live_tup, last_analyze FROM pg_stat_user_tables WHERE relname = 'kb_article_chunks'
    `;
    console.log(`Stats: live_tup=${stat.n_live_tup}  last_analyze=${stat.last_analyze}`);

    const policies = await ownerDb`
      SELECT policyname, qual FROM pg_policies WHERE tablename = 'kb_article_chunks'
    `;
    console.log("RLS policies:", JSON.stringify(policies));

    const idxCols = await ownerDb`
      SELECT ic.relname AS idx, array_agg(a.attname ORDER BY x.ord) AS cols
      FROM pg_index ix
      JOIN pg_class c  ON c.oid  = ix.indrelid
      JOIN pg_class ic ON ic.oid = ix.indexrelid
      JOIN unnest(ix.indkey) WITH ORDINALITY AS x(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = x.attnum
      WHERE c.relname = 'kb_article_chunks'
      GROUP BY ic.relname
    `;
    console.log("Indexes:");
    for (const r of idxCols) console.log(" ", r.idx, ":", r.cols);

    console.log("\nDeriving query vector as mean of org-b's embeddings …");
    const [avgRow] = await ownerDb.unsafe(`
      SELECT avg(embedding)::text AS centroid_text
      FROM kb_article_chunks
      WHERE org_id = '${ORG_B}'
    `);
    queryVec = avgRow.centroid_text;
    const dims = queryVec.split(",").length;
    console.log(`Query vector derived: ${dims} dimensions, first values: ${queryVec.slice(0, 60)}…`);
  } finally {
    await ownerDb.end();
  }

  const appDb = postgres(APP_URL, { max: 1, idle_timeout: 300, prepare: false });
  try {
    const q_plain_ann = `
      SELECT id
      FROM kb_article_chunks
      ORDER BY embedding <=> '${queryVec}'::vector(${DIMS})
      LIMIT ${LIMIT}
    `;

    const q_iterative = `
      SELECT id
      FROM kb_article_chunks
      WHERE org_id = current_org_id()
      ORDER BY embedding <=> '${queryVec}'::vector(${DIMS})
      LIMIT ${LIMIT}
    `;

    const q_fn = `SELECT app.search_kb_chunk_ids('${queryVec}'::vector(${DIMS}), ${LIMIT}) AS id`;

    console.log("\n--- SCENARIO A: Plain ANN (RLS post-filter, no iterative scan) ---");
    await appDb.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.organization_id = '${ORG_B}'`);
      const plan = await tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${q_plain_ann}`);
      printPlan("A — Plain ANN, org-b GUC, LIMIT 20", plan);
    });

    const plainRows = await appDb.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.organization_id = '${ORG_B}'`);
      return tx.unsafe(`${q_plain_ann}`);
    });
    console.log(`\nA result: ${plainRows.length} rows returned (expected 20)`);

    console.log("\n--- SCENARIO B: MATERIALIZED fence via app.search_kb_chunk_ids ---");
    await appDb.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.organization_id = '${ORG_B}'`);
      const plan = await tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${q_fn}`);
      printPlan("B — MATERIALIZED fence (app.search_kb_chunk_ids), org-b", plan);
    });

    const fnRows = await appDb.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.organization_id = '${ORG_B}'`);
      return tx.unsafe(`${q_fn}`);
    });
    console.log(`\nB result: ${fnRows.length} rows returned (expected 20)`);

    console.log("\n--- SCENARIO C: Iterative scan (hnsw.iterative_scan = relaxed_order) ---");
    await appDb.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.organization_id = '${ORG_B}'`);
      await tx.unsafe(`SET LOCAL hnsw.iterative_scan = relaxed_order`);
      await tx.unsafe(`SET LOCAL hnsw.max_scan_tuples = 30000`);
      const plan = await tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${q_iterative}`);
      printPlan("C — Iterative scan, org-b, max_scan_tuples=30000", plan);
    });

    const iterRows = await appDb.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.organization_id = '${ORG_B}'`);
      await tx.unsafe(`SET LOCAL hnsw.iterative_scan = relaxed_order`);
      await tx.unsafe(`SET LOCAL hnsw.max_scan_tuples = 30000`);
      return tx.unsafe(`${q_iterative}`);
    });
    console.log(`\nC result: ${iterRows.length} rows returned`);

    console.log("\n--- ALSO: Plain ANN for seed-org (should always work) ---");
    const seedRows = await appDb.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.organization_id = '${SEED_ORG}'`);
      return tx.unsafe(`SELECT id FROM kb_article_chunks ORDER BY embedding <=> '${queryVec}'::vector(${DIMS}) LIMIT ${LIMIT}`);
    });
    console.log(`Seed-org plain ANN (query near org-b centroid): ${seedRows.length} rows returned`);

    console.log(`\n${"=".repeat(70)}`);
    console.log("COMPARISON SUMMARY — clustered vectors (query near org-b centroid)");
    console.log(`${"=".repeat(70)}`);
    console.log(`  (a) Plain ANN (RLS post-filter):       ${plainRows.length} rows`);
    console.log(`  (b) MATERIALIZED fence (migration 0703): ${fnRows.length} rows`);
    console.log(`  (c) Iterative scan (session SET LOCAL): ${iterRows.length} rows`);
    console.log("");
    console.log("  See EXPLAIN output above for buffer counts.");
  } finally {
    await appDb.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
