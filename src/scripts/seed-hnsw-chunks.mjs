/**
 * Seed kb_article_chunks for HNSW index / RLS plan measurement.
 *
 * Seeds 3 orgs with realistic row counts so EXPLAIN on the table is
 * non-trivial and the planner's index-or-seqscan choice is observable.
 *
 * Run:
 *   node src/scripts/seed-hnsw-chunks.mjs
 *
 * Uses the owner role (DATABASE_URL or hardcoded direct URL) to bypass RLS.
 * Vectors are generated server-side with random(); no data leaves Neon.
 */

import postgres from "postgres";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to run against NODE_ENV=production.");
  process.exit(1);
}

const OWNER_URL =
  process.env.DATABASE_URL ??
  "postgresql://neondb_owner:npg_uHztXRn51MdW@ep-orange-mode-azxn5hbr.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";

const db = postgres(OWNER_URL, { max: 1, prepare: false, onnotice: () => {} });

const started = Date.now();
const log = (msg) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}`);

const SEED_ORG = "73e5076a-225f-4b4c-b93e-9bc66a548bfe";
const ORG_B    = "c5b82e53-e69e-4937-ace8-1126ae3c0c7f";
const ORG_C    = "ed6e823a-2543-4696-9d75-6876741f6fd4";

const PLANS = [
  { orgId: SEED_ORG, count: 15000, label: "seed-org" },
  { orgId: ORG_B,    count: 7500,  label: "org-b" },
  { orgId: ORG_C,    count: 7500,  label: "org-c" },
];

const BATCH = 2500;

async function main() {
  await db`SET statement_timeout = 0`;

  for (const { orgId, count, label } of PLANS) {
    const [existing] = await db`
      SELECT count(*)::int AS n FROM kb_article_chunks WHERE org_id = ${orgId}
    `;
    const have = existing.n;
    log(`${label}: ${have} rows already present`);
    if (have >= count) {
      log(`${label}: skipping (already at target)`);
      continue;
    }

    const needed = count - have;
    const batches = Math.ceil(needed / BATCH);
    let inserted = 0;

    for (let b = 0; b < batches; b++) {
      const batchCount = Math.min(BATCH, needed - inserted);
      const offset = have + inserted;

      await db.unsafe(`
        INSERT INTO kb_article_chunks
          (org_id, source, chunk_index, content, embedding, embedding_model, acl_revision)
        SELECT
          '${orgId}',
          'article_body',
          ${offset} + g,
          'Seeded content chunk ' || (${offset} + g),
          (array(SELECT random() - 0.5 FROM generate_series(1, 1536)))::vector,
          'text-embedding-3-small',
          1
        FROM generate_series(1, ${batchCount}) g
      `);

      inserted += batchCount;
      log(`${label}: inserted ${inserted} / ${needed}`);
    }

    const [after] = await db`
      SELECT count(*)::int AS n FROM kb_article_chunks WHERE org_id = ${orgId}
    `;
    log(`${label}: total rows now = ${after.n}`);
  }

  const [total] = await db`SELECT count(*)::int AS n FROM kb_article_chunks`;
  log(`Total kb_article_chunks: ${total.n}`);

  log("Running VACUUM ANALYZE kb_article_chunks …");
  await db.unsafe("VACUUM ANALYZE kb_article_chunks");
  log("VACUUM ANALYZE: done");

  const [stat] = await db`
    SELECT n_live_tup, n_dead_tup, last_analyze
    FROM pg_stat_user_tables
    WHERE relname = 'kb_article_chunks'
  `;
  log(`Stats after VACUUM: live=${stat.n_live_tup} dead=${stat.n_dead_tup} last_analyze=${stat.last_analyze}`);
}

main()
  .catch((e) => {
    console.error("SEED FAILED:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.end());
