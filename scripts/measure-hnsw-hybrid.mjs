/**
 * HNSW4 measurement: service-level hybrid fast-path + fence fallback.
 *
 * The hybrid:
 *   1. Plain ANN under RLS (no explicit org_id predicate → HNSW index used)
 *   2. If results < cap: under-retrieval detected → call app.search_kb_chunk_ids (MATERIALIZED fence)
 *
 * Measures on both fixtures (random and clustered) for minority (org-b) and
 * dominant (seed-org) tenants.
 *
 * All measurements as streamline_app with SET LOCAL tenant GUC.
 * Run: node scripts/measure-hnsw-hybrid.mjs
 */
import postgres from "postgres";

const OWNER_URL = process.env.DATABASE_URL;
if (!OWNER_URL) throw new Error("DATABASE_URL is required");
const APP_URL = process.env.APP_DATABASE_URL;
if (!APP_URL) throw new Error("APP_DATABASE_URL is required");

const SEED_ORG = "73e5076a-225f-4b4c-b93e-9bc66a548bfe";
const ORG_B    = "c5b82e53-e69e-4937-ace8-1126ae3c0c7f";
const DIMS = 1536;
const CAP = 20;

function extractBuffers(planLines) {
  for (const row of planLines) {
    const text = row["QUERY PLAN"] ?? row[Object.keys(row)[0]];
    const m = text.match(/Buffers:\s+shared\s+(?:hit=(\d+))(?:\s+read=(\d+))?/);
    if (m) return parseInt(m[1], 10) + (m[2] ? parseInt(m[2], 10) : 0);
  }
  return null;
}

async function measureHybrid(appDb, orgId, vec, label) {
  const boost = CAP + 1;

  const annPlan = await appDb.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.organization_id = '${orgId}'`);
    return tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT id FROM kb_article_chunks ORDER BY embedding <=> '${vec}'::vector(${DIMS}) LIMIT ${boost}`);
  });
  const annRows = await appDb.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.organization_id = '${orgId}'`);
    return tx.unsafe(`SELECT id FROM kb_article_chunks ORDER BY embedding <=> '${vec}'::vector(${DIMS}) LIMIT ${boost}`);
  });
  const annBuf = extractBuffers(annPlan);

  let path, rows, fenceBuf = null;
  if (annRows.length >= CAP) {
    path = "fast (ANN under RLS)";
    rows = annRows.length <= CAP ? annRows.length : CAP;
  } else {
    path = "fence (MATERIALIZED)";
    const fencePlan = await appDb.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.organization_id = '${orgId}'`);
      return tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT app.search_kb_chunk_ids('${vec}'::vector(${DIMS}), ${CAP}) AS id`);
    });
    const fenceRows = await appDb.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.organization_id = '${orgId}'`);
      return tx.unsafe(`SELECT app.search_kb_chunk_ids('${vec}'::vector(${DIMS}), ${CAP}) AS id`);
    });
    fenceBuf = extractBuffers(fencePlan);
    rows = fenceRows.length;
  }

  const totalBuf = annBuf + (fenceBuf ?? 0);
  console.log(`\n  ${label}`);
  console.log(`    path: ${path}`);
  console.log(`    ANN rows returned: ${annRows.length}  buffers: ${annBuf}`);
  if (fenceBuf !== null) console.log(`    Fence buffers: ${fenceBuf}`);
  console.log(`    Final rows: ${rows}  total buffers: ${totalBuf}`);

  return { path, annBuf, fenceBuf, totalBuf, rows };
}

async function fixture(label, queryVec) {
  const ownerDb = postgres(OWNER_URL, { max: 1, idle_timeout: 30, prepare: false });
  let orgBCount, seedCount;
  try {
    const [b] = await ownerDb`SELECT count(*)::int AS n FROM kb_article_chunks WHERE org_id = ${ORG_B}`;
    const [s] = await ownerDb`SELECT count(*)::int AS n FROM kb_article_chunks WHERE org_id = ${SEED_ORG}`;
    orgBCount = b.n; seedCount = s.n;
    const [stat] = await ownerDb`SELECT n_live_tup, last_analyze FROM pg_stat_user_tables WHERE relname = 'kb_article_chunks'`;
    console.log(`\n${"=".repeat(70)}`);
    console.log(`FIXTURE: ${label}`);
    console.log(`  org-b rows: ${orgBCount}  seed-org rows: ${seedCount}  live_tup: ${stat.n_live_tup}  last_analyze: ${stat.last_analyze}`);
  } finally {
    await ownerDb.end();
  }
  if (orgBCount === 0) { console.log("  No rows — reseed first."); return null; }

  const appDb = postgres(APP_URL, { max: 1, idle_timeout: 300, prepare: false });
  try {
    const orgBResult = await measureHybrid(appDb, ORG_B, queryVec, `org-b (minority, ${orgBCount} rows)`);
    const seedResult = await measureHybrid(appDb, SEED_ORG, queryVec, `seed-org (dominant, ${seedCount} rows)`);
    return { orgB: orgBResult, seedOrg: seedResult };
  } finally {
    await appDb.end();
  }
}

async function main() {
  const RANDOM_VEC = `[${Array.from({ length: DIMS }, (_, i) => (i % 7 === 0 ? 0.1 : 0.001)).join(",")}]`;

  const clusteredResults = await fixture(
    "CLUSTERED vectors (seed-hnsw-clustered.mjs, query = org-b centroid from DB)",
    await (async () => {
      const db = postgres(OWNER_URL, { max: 1, idle_timeout: 30, prepare: false });
      try {
        const [r] = await db.unsafe(`SELECT avg(embedding)::text AS c FROM kb_article_chunks WHERE org_id = '${ORG_B}'`);
        return r.c;
      } finally { await db.end(); }
    })()
  );

  const randomResults = await fixture("RANDOM vectors (seed-hnsw-chunks.mjs fixture query vector)", RANDOM_VEC);

  console.log(`\n${"=".repeat(70)}`);
  console.log("SUMMARY (CAP=" + CAP + ")");
  console.log(`${"=".repeat(70)}`);

  const row = (label, r) => {
    if (!r) { console.log(`  ${label}: no data`); return; }
    console.log(`  ${label}: ${r.path}  rows=${r.rows}  ANN=${r.annBuf}buf  fence=${r.fenceBuf ?? "-"}buf  total=${r.totalBuf}buf`);
  };

  if (clusteredResults) {
    row("Clustered org-b  (minority)", clusteredResults.orgB);
    row("Clustered seed-org (dominant)", clusteredResults.seedOrg);
  }
  if (randomResults) {
    row("Random    org-b  (minority)", randomResults.orgB);
    row("Random    seed-org (dominant)", randomResults.seedOrg);
  }

  console.log("\nExpected:");
  console.log("  Clustered — org-b: fast path (ANN ~258 buf), 20 rows");
  console.log("  Clustered — seed-org: fast path (ANN ~258 buf), 20 rows");
  console.log("  Random    — org-b: detected → fence (~22,680 buf), 20 rows");
  console.log("  Random    — seed-org: fast path (ANN ~258 buf), 20 rows");
}

main().catch((e) => { console.error(e); process.exit(1); });
