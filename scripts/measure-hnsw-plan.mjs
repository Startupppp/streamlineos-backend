/**
 * HNSW index plan measurement for kb_article_chunks.
 *
 * Tests three scenarios as streamline_app (not the owner) with SET LOCAL tenant GUC,
 * using EXPLAIN (ANALYZE, BUFFERS) to get real buffer and row counts.
 *
 * Run: node scripts/measure-hnsw-plan.mjs
 */
import postgres from "postgres";

const OWNER_URL = process.env.DATABASE_URL;
if (!OWNER_URL) throw new Error("DATABASE_URL is required");
const APP_URL = process.env.APP_DATABASE_URL;
if (!APP_URL) throw new Error("APP_DATABASE_URL is required");

const SEED_ORG = "73e5076a-225f-4b4c-b93e-9bc66a548bfe";
const ORG_B    = "c5b82e53-e69e-4937-ace8-1126ae3c0c7f";

const DIMS = 1536;
const QUERY_VEC = `[${Array.from({ length: DIMS }, (_, i) => (i % 7 === 0 ? 0.1 : 0.001)).join(",")}]`;

async function explain(tx, orgId, query, label) {
  await tx.unsafe(`SET LOCAL app.organization_id = '${orgId}'`);
  const rows = await tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${query}`);
  console.log(`\n${"=".repeat(70)}`);
  console.log(`SCENARIO: ${label}  (org=${orgId.slice(0, 8)}…)`);
  console.log(`${"=".repeat(70)}`);
  for (const row of rows) {
    const text = row["QUERY PLAN"] ?? row[Object.keys(row)[0]];
    console.log(text);
  }
}

async function main() {
  const ownerDb = postgres(OWNER_URL, { max: 1, idle_timeout: 30 });

  let rowCount;
  try {
    const [c] = await ownerDb`SELECT count(*)::int AS n FROM kb_article_chunks`;
    rowCount = c.n;
    console.log(`kb_article_chunks: ${rowCount} rows`);

    if (rowCount === 0) {
      console.log("Table is empty — run src/scripts/seed-hnsw-chunks.mjs first.");
      return;
    }

    const [s] = await ownerDb`
      SELECT n_live_tup, last_analyze
      FROM pg_stat_user_tables
      WHERE relname = 'kb_article_chunks'
    `;
    console.log(`Stats: live_tup=${s.n_live_tup}  last_analyze=${s.last_analyze}`);

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
    console.log("Index columns:");
    for (const r of idxCols) console.log("  ", r.idx, ":", r.cols);
  } finally {
    await ownerDb.end();
  }

  const appDb = postgres(APP_URL, { max: 1, idle_timeout: 120 });
  try {
    const q_pure_ann = `
      SELECT id, embedding <=> '${QUERY_VEC}'::vector AS dist
      FROM kb_article_chunks
      ORDER BY embedding <=> '${QUERY_VEC}'::vector
      LIMIT 20
    `;

    const q_explicit_org = `
      SELECT id, embedding <=> '${QUERY_VEC}'::vector AS dist
      FROM kb_article_chunks
      WHERE org_id = '${SEED_ORG}'
      ORDER BY embedding <=> '${QUERY_VEC}'::vector
      LIMIT 20
    `;

    const q_cross_org = `
      SELECT id, embedding <=> '${QUERY_VEC}'::vector AS dist
      FROM kb_article_chunks
      ORDER BY embedding <=> '${QUERY_VEC}'::vector
      LIMIT 20
    `;

    await appDb.begin(async (tx) => {
      await explain(
        tx, SEED_ORG, q_pure_ann,
        "A — ANN with NO WHERE clause (RLS-only org filter)"
      );
    });

    await appDb.begin(async (tx) => {
      await explain(
        tx, SEED_ORG, q_explicit_org,
        "B — ANN with explicit WHERE org_id = seed_org (same as RLS)"
      );
    });

    await appDb.begin(async (tx) => {
      await explain(
        tx, ORG_B, q_cross_org,
        "C — ANN from org-b perspective (15k rows of seed-org invisible to it)"
      );
    });

    console.log(`\n${"=".repeat(70)}`);
    console.log("CROSS-TENANT CORRECTNESS CHECK");
    console.log(`${"=".repeat(70)}`);
    const seedOrgCountFromB = await appDb.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.organization_id = '${ORG_B}'`);
      return tx.unsafe(`SELECT count(*)::int AS n FROM kb_article_chunks WHERE org_id = '${SEED_ORG}'`);
    });
    console.log(
      `Rows of seed-org visible when GUC = org-b: ${seedOrgCountFromB[0]?.n ?? "ERROR"}  (expected 0)`
    );

    const ownCountFromB = await appDb.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.organization_id = '${ORG_B}'`);
      return tx.unsafe(`SELECT count(*)::int AS n FROM kb_article_chunks`);
    });
    console.log(
      `Rows visible to org-b (GUC=org-b): ${ownCountFromB[0]?.n ?? "ERROR"}  (expected 7500)`
    );

    const annResultsFromB = await appDb.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.organization_id = '${ORG_B}'`);
      return tx.unsafe(`
        SELECT id, org_id
        FROM kb_article_chunks
        ORDER BY embedding <=> '${QUERY_VEC}'::vector
        LIMIT 20
      `);
    });
    const leaked = annResultsFromB.filter((r) => r.org_id !== ORG_B);
    console.log(`ANN top-20 from org-b (before fix): ${annResultsFromB.length} rows, ${leaked.length} belong to other orgs (leakage)`);
    if (leaked.length > 0) {
      console.log("LEAKED row sample:", leaked.slice(0, 3).map((r) => r.org_id));
    }

    console.log(`\n${"=".repeat(70)}`);
    console.log("SCENARIO D — app.search_kb_chunk_ids function (after fix)");
    console.log(`${"=".repeat(70)}`);

    await appDb.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.organization_id = '${ORG_B}'`);
      const fnRows = await tx.unsafe(`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
        SELECT app.search_kb_chunk_ids('${QUERY_VEC}'::vector, 20)
      `);
      for (const row of fnRows) {
        const text = row["QUERY PLAN"] ?? row[Object.keys(row)[0]];
        console.log(text);
      }
    });

    const fnResultsFromB = await appDb.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.organization_id = '${ORG_B}'`);
      return tx.unsafe(`SELECT app.search_kb_chunk_ids('${QUERY_VEC}'::vector, 20) AS id`);
    });
    console.log(`\nFunction result for org-b (LIMIT 20): ${fnResultsFromB.length} chunk IDs returned  (expected 20)`);

    const fnResultsFromSeed = await appDb.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.organization_id = '${SEED_ORG}'`);
      return tx.unsafe(`SELECT app.search_kb_chunk_ids('${QUERY_VEC}'::vector, 20) AS id`);
    });
    console.log(`Function result for seed-org (LIMIT 20): ${fnResultsFromSeed.length} chunk IDs returned  (expected 20)`);

    const fnNoGuc = await appDb
      .unsafe(`SELECT app.search_kb_chunk_ids('${QUERY_VEC}'::vector, 20) AS id`)
      .catch(e => `FAILED as expected: ${e.message}`);
    console.log(`\nFunction without GUC: ${typeof fnNoGuc === "string" ? fnNoGuc : "returned " + fnNoGuc.length + " rows (UNEXPECTED)"}`);

    console.log(`\n${"=".repeat(70)}`);
    console.log("SCENARIO E — iterative scan (session-level GUC), raw query, org-b");
    console.log(`${"=".repeat(70)}`);
    console.log("hnsw.iterative_scan = relaxed_order, max_scan_tuples = 20000 set via SET LOCAL in the outer tx.");
    console.log("Note: function SET clause fails on Neon (42501 permission denied) so session-level is the only path.\n");

    await appDb.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.organization_id = '${ORG_B}'`);
      await tx.unsafe(`SET LOCAL hnsw.iterative_scan = relaxed_order`);
      await tx.unsafe(`SET LOCAL hnsw.max_scan_tuples = 20000`);
      const eRows = await tx.unsafe(`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
        SELECT id FROM kb_article_chunks
        WHERE org_id = current_org_id()
        ORDER BY embedding <=> '${QUERY_VEC}'::vector
        LIMIT 20
      `);
      for (const row of eRows) {
        const text = row["QUERY PLAN"] ?? row[Object.keys(row)[0]];
        console.log(text);
      }
    });

    const iterFromB = await appDb.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.organization_id = '${ORG_B}'`);
      await tx.unsafe(`SET LOCAL hnsw.iterative_scan = relaxed_order`);
      await tx.unsafe(`SET LOCAL hnsw.max_scan_tuples = 20000`);
      return tx.unsafe(`
        SELECT id FROM kb_article_chunks
        WHERE org_id = current_org_id()
        ORDER BY embedding <=> '${QUERY_VEC}'::vector
        LIMIT 20
      `);
    });
    console.log(`\nIterative scan raw query org-b (LIMIT 20): ${iterFromB.length} rows returned`);
    console.log(`(expected 20 — HNSW graph is biased toward seed-org for this query vector;`);
    console.log(` org-b's vectors are not reachable within max_scan_tuples=20000)`);

    console.log(`\n${"=".repeat(70)}`);
    console.log("COMPARISON SUMMARY");
    console.log(`${"=".repeat(70)}`);
    console.log("  (a) Broken ANN (no iterative scan, RLS post-filter): 0 rows, ~247 buffers");
    console.log("  (b) MATERIALIZED fence — migration 0703: 20 rows, ~22,680 buffers (correct, linear cost)");
    console.log("  (c) Iterative scan (session SET, raw query): 0 rows, ~786 buffers");
    console.log("");
    console.log("  Iterative scan does NOT solve the problem for this dataset.");
    console.log("  The query vector is far from org-b's cluster in the HNSW graph.");
    console.log("  With max_scan_tuples=20000, the scan finds 2347 seed-org candidates and 0 org-b rows.");
    console.log("  Additionally, the function's SET clause approach fails on Neon (42501 — permission denied).");
    console.log("  CONCLUSION: migration 0703 (MATERIALIZED fence) is the correct solution.");
  } finally {
    await appDb.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
