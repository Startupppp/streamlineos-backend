/**
 * Diagnostic: HNSW index and RLS policy inspection for kb_article_chunks.
 * Run: node scripts/measure-hnsw-plan.mjs
 */
import postgres from "postgres";

const OWNER_URL = "postgresql://neondb_owner:npg_uHztXRn51MdW@ep-orange-mode-azxn5hbr.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";
const APP_URL   = "postgresql://streamline_app:npg_eKlEfHtbMg93@ep-orange-mode-azxn5hbr.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";

async function main() {
  const ownerDb = postgres(OWNER_URL, { max: 1, idle_timeout: 30 });
  try {
    const countRow = await ownerDb`SELECT count(*) AS n FROM kb_article_chunks`;
    const rowCount = Number(countRow[0]?.n ?? 0);
    console.log(`kb_article_chunks: ${rowCount} rows`);

    const idxRow = await ownerDb`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'kb_article_chunks'
        AND indexname = 'idx_kb_chunks_embedding_hnsw'
    `;
    console.log("HNSW index def:", idxRow[0]?.indexdef ?? "NOT FOUND");

    const rlsRow = await ownerDb`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class WHERE relname = 'kb_article_chunks'
    `;
    console.log("RLS on:", rlsRow[0]?.relrowsecurity, "force:", rlsRow[0]?.relforcerowsecurity);

    // Full policy details
    const policies = await ownerDb`
      SELECT policyname, cmd, permissive, roles, qual, with_check
      FROM pg_policies
      WHERE tablename = 'kb_article_chunks'
    `;
    console.log("Policies:", JSON.stringify(policies, null, 2));

    // Index columns (for covering-index check)
    const idxCols = await ownerDb`
      SELECT a.attname, ix.indisunique
      FROM pg_index ix
      JOIN pg_class c ON c.oid = ix.indrelid
      JOIN pg_class ic ON ic.oid = ix.indexrelid
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(ix.indkey)
      WHERE c.relname = 'kb_article_chunks'
        AND ic.relname = 'idx_kb_chunks_embedding_hnsw'
    `;
    console.log("HNSW index columns:", idxCols.map(r => r.attname));

    if (rowCount === 0) {
      console.log("\n--- CANNOT MEASURE: table is empty ---");
      console.log("The dev DB has no kb_article_chunks rows.");
      console.log("To measure: ingest at least one KB article or page with embeddings enabled.");
      console.log("Then run: VACUUM ANALYZE kb_article_chunks; followed by EXPLAIN (ANALYZE, BUFFERS) as streamline_app inside BEGIN ... COMMIT with SET LOCAL app.organization_id = '<orgId>'.");
      return;
    }

    // VACUUM + measure (only reached when table has rows)
    await ownerDb`VACUUM ANALYZE kb_article_chunks`;
    const statAfter = await ownerDb`
      SELECT n_live_tup, n_dead_tup, last_analyze
      FROM pg_stat_user_tables WHERE relname = 'kb_article_chunks'
    `;
    console.log("After VACUUM ANALYZE:", statAfter[0]);

    const orgRow = await ownerDb`SELECT org_id FROM kb_article_chunks LIMIT 1`;
    const orgId = orgRow[0]?.org_id;
    if (!orgId) return;

    const appDb = postgres(APP_URL, { max: 1, idle_timeout: 60 });
    const dims = 1536;
    const dummyVec = `[${Array(dims).fill("0.001").join(",")}]`;
    try {
      const planRows = await appDb.begin(async (tx) => {
        await tx`SET LOCAL app.organization_id = ${orgId}`;
        return tx`
          EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
          SELECT c.article_id, c.embedding <=> ${dummyVec}::vector AS distance
          FROM kb_article_chunks c
          WHERE c.org_id = ${orgId}
            AND c.article_id IS NOT NULL
          ORDER BY c.embedding <=> ${dummyVec}::vector
          LIMIT 20
        `;
      });
      console.log("\n=== EXPLAIN (ANALYZE, BUFFERS) as streamline_app ===");
      for (const row of planRows) {
        const text = row["QUERY PLAN"] ?? row[Object.keys(row)[0]];
        console.log(text);
      }
    } finally {
      await appDb.end();
    }
  } finally {
    await ownerDb.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
