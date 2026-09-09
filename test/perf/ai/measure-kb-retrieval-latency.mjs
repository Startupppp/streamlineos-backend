/**
 * Measures the KB retrieval legs against a realistic corpus, as the application
 * role, with the tenant GUC set, for tenants of very different sizes.
 *
 * Three rules this obeys, each of which is easy to break in a way that produces
 * a number nobody should trust:
 *
 * - **Never as the owner.** `neondb_owner` has BYPASSRLS, so its plan omits the
 *   `org_id = app.current_org_id()` qual entirely — which is the cost being
 *   measured. Everything below runs on a `streamline_app` connection inside a
 *   transaction that sets `app.organization_id` and is then rolled back.
 * - **Buffers, not just milliseconds.** Wall clock on a warm cache flatters
 *   everything; shared block counts do not move with the page cache.
 * - **No per-call CPU percentile.** The CPU clock ticks far too coarsely to
 *   measure one query, so a p95 of per-call CPU is noise wearing a statistic's
 *   clothes. Where CPU matters it is aggregated over the whole run, once.
 *
 * Usage:
 *   PERF_DATABASE_URL=postgresql://neondb_owner:...@127.0.0.1:5432/scratch_ai_latency \
 *   PERF_APP_DATABASE_URL=postgresql://streamline_app:...@127.0.0.1:5432/scratch_ai_latency \
 *     node test/perf/ai/measure-kb-retrieval-latency.mjs [--runs=25] [--json=out.json]
 */
import { writeFileSync } from "node:fs";
import { CORPUS, TOTAL_CHUNKS } from "./kb-retrieval-corpus.mjs";
import {
  assertAppRoleIsNotPrivileged,
  assertRlsBites,
  describePlan,
  inRolledBackTx,
  openConnections,
  percentile,
  sumBuffers,
} from "./kb-retrieval-probe.mjs";

const args = process.argv.slice(2);
/**
 * A p99 needs at least 100 samples to name a real observation; below that
 * `ceil(0.99 n) - 1` lands on the maximum and the "p99" is just the slowest run
 * wearing a percentile's name. The floor is therefore 100, not a suggestion.
 */
const MIN_RUNS_FOR_P99 = 100;
const runs = Math.max(
  MIN_RUNS_FOR_P99,
  Number.parseInt(args.find((a) => a.startsWith("--runs="))?.slice(7) ?? "100", 10),
);
const jsonOut = args.find((a) => a.startsWith("--json="))?.slice(7);

const { owner, app } = openConnections();

/**
 * The RLS-only form of `KbCandidateService.vectorChunkIds`, and the fence it
 * falls back to. Caps come from the real call sites: `articleVectorCandidates`
 * uses `pool * 4` where `pool = max(limit * 3, limit)`, and
 * `KbRagRetrievalService` uses `DEFAULT_TOP_K * 4` = 24.
 *
 * **This is not the production query shape**, and the header used to claim it
 * was. `kb-candidate.service.ts:30-33` carries an explicit `WHERE org_id = $1`
 * on top of RLS, which changes the plan. The production shape is measured by
 * `measure-kb-retrieval-recall.mjs`, which is where recall and plan choice are
 * decided; this file keeps the RLS-only form so its numbers stay comparable
 * with the run already recorded in `45-scale/`.
 */
const SCENARIOS = [
  {
    key: "ann.cap24",
    label: "ANN, cap 24 (kb-rag public ask pool)",
    iterativeScan: "relaxed_order",
    sql: "SELECT id FROM public.kb_article_chunks ORDER BY embedding <=> $1::vector LIMIT 24",
  },
  {
    key: "ann.cap120",
    label: "ANN, cap 120 (kb search, limit 10)",
    iterativeScan: "relaxed_order",
    sql: "SELECT id FROM public.kb_article_chunks ORDER BY embedding <=> $1::vector LIMIT 120",
  },
  {
    key: "ann.cap120.noiter",
    label: "ANN, cap 120, iterative scan OFF",
    iterativeScan: "off",
    sql: "SELECT id FROM public.kb_article_chunks ORDER BY embedding <=> $1::vector LIMIT 120",
  },
  {
    key: "fence.cap120",
    label: "app.search_kb_chunk_ids fence, cap 120",
    iterativeScan: "relaxed_order",
    sql: "SELECT app.search_kb_chunk_ids($1::vector, 120) AS id",
  },
];

async function queryVectors(count) {
  const rows = await owner`
    SELECT emb::text AS emb FROM perf_topic_pool ORDER BY id LIMIT ${count}`;
  if (rows.length === 0) throw new Error("perf_topic_pool is empty — run the seeder first");
  return rows.map((r) => r.emb);
}

async function measure(scenario, orgId, vectors) {
  const durations = [];
  const buffers = [];
  let plan = "";
  let rowsReturned = 0;

  for (let i = 0; i < runs + 3; i += 1) {
    const vector = vectors[i % vectors.length];
    const sample = await inRolledBackTx(
      app,
      [
        `SET LOCAL app.organization_id = '${orgId}'`,
        `SET LOCAL hnsw.iterative_scan = ${scenario.iterativeScan}`,
      ],
      async (tx) => {
        const explained = await tx.unsafe(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${scenario.sql}`,
          [vector],
        );
        return explained[0]["QUERY PLAN"][0];
      },
    );

    // The first three are warm-up: a cold page cache and a cold HNSW entry point
    // would otherwise dominate the first sample and skew the median.
    if (i < 3 || sample === null) continue;
    durations.push(sample["Execution Time"]);
    const b = sumBuffers(sample.Plan);
    buffers.push(b.hit + b.read);
    plan = describePlan(sample.Plan);
    rowsReturned = sample.Plan["Actual Rows"];
  }

  durations.sort((a, b) => a - b);
  buffers.sort((a, b) => a - b);
  return {
    scenario: scenario.key,
    orgId,
    runs: durations.length,
    p50Ms: Number(percentile(durations, 0.5).toFixed(2)),
    p95Ms: Number(percentile(durations, 0.95).toFixed(2)),
    p99Ms: Number(percentile(durations, 0.99).toFixed(2)),
    medianBuffers: percentile(buffers, 0.5),
    p95Buffers: percentile(buffers, 0.95),
    rowsReturned,
    plan,
  };
}

async function main() {
  const [{ current_database: db }] = await owner`SELECT current_database()`;
  const roleName = await assertAppRoleIsNotPrivileged(app);
  await assertRlsBites(app);

  const counts = await owner`
    SELECT org_id, count(*)::int AS chunks
    FROM kb_article_chunks WHERE org_id LIKE 'perf_kb_%'
    GROUP BY org_id`;
  const byOrg = new Map(counts.map((r) => [r.org_id, r.chunks]));
  const total = counts.reduce((s, r) => s + r.chunks, 0);

  console.log(`Target ${db} · measured as ${roleName} (no BYPASSRLS, tenant GUC set)`);
  console.log(`${runs} timed samples per cell after 3 discarded warm-ups`);
  console.log(`Corpus ${total.toLocaleString()} chunks (declared ${TOTAL_CHUNKS.toLocaleString()})`);
  for (const { orgId, label } of CORPUS)
    console.log(
      `  ${orgId.padEnd(16)} ${String(byOrg.get(orgId) ?? 0).padStart(7)}  ${(((byOrg.get(orgId) ?? 0) / total) * 100).toFixed(1)}%  ${label}`,
    );

  const vectors = await queryVectors(12);
  const results = [];
  const cpuStart = process.cpuUsage();
  const wallStart = Date.now();

  for (const scenario of SCENARIOS) {
    console.log(`\n${scenario.label}`);
    console.log(
      `  ${"org".padEnd(16)} ${"share".padStart(7)} ${"p50 ms".padStart(9)} ${"p95 ms".padStart(9)} ` +
        `${"p99 ms".padStart(9)} ${"buffers".padStart(9)} ${"rows".padStart(6)}  plan`,
    );
    for (const { orgId } of CORPUS) {
      const row = await measure(scenario, orgId, vectors);
      results.push({ ...row, chunks: byOrg.get(orgId) ?? 0 });
      const share = (((byOrg.get(orgId) ?? 0) / total) * 100).toFixed(1) + "%";
      console.log(
        `  ${orgId.padEnd(16)} ${share.padStart(7)} ${String(row.p50Ms).padStart(9)} ` +
          `${String(row.p95Ms).padStart(9)} ${String(row.p99Ms).padStart(9)} ` +
          `${String(row.medianBuffers).padStart(9)} ${String(row.rowsReturned).padStart(6)}  ${row.plan}`,
      );
    }
  }

  // Aggregated once over the entire run. A per-call CPU percentile would be a
  // fabrication: the process clock's granularity is coarser than a single query.
  const cpu = process.cpuUsage(cpuStart);
  const wallMs = Date.now() - wallStart;
  const totalQueries = results.length * (runs + 3);
  console.log(
    `\nAggregate over the whole run (never per call): ${totalQueries} queries, ` +
      `${(wallMs / 1000).toFixed(1)}s wall, ` +
      `${((cpu.user + cpu.system) / 1000).toFixed(0)}ms client CPU`,
  );

  if (jsonOut) {
    writeFileSync(
      jsonOut,
      JSON.stringify(
        {
          db,
          role: roleName,
          runs,
          corpus: CORPUS.map((o) => ({
            ...o,
            seeded: byOrg.get(o.orgId) ?? 0,
            share: Number((((byOrg.get(o.orgId) ?? 0) / total) * 100).toFixed(2)),
          })),
          totalChunks: total,
          results,
        },
        null,
        2,
      ),
    );
    console.log(`\nWrote ${jsonOut}`);
  }

  await owner.end();
  await app.end();
}

main().catch(async (error) => {
  console.error(error);
  await owner.end().catch(() => undefined);
  await app.end().catch(() => undefined);
  process.exit(1);
});
