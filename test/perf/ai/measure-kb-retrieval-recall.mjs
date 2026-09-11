/**
 * Measures **recall@k of the production KB ANN pre-pass against exact top-k**,
 * per tenant, per cap, across an `hnsw.ef_search` sweep — as `streamline_app`
 * with the tenant GUC set, never as the owner.
 *
 * It is a separate script from `measure-kb-retrieval-latency.mjs` rather than a
 * `--recall` flag on it because the two answer different questions with
 * different loop shapes: the latency harness runs `EXPLAIN (ANALYZE, BUFFERS)`
 * over four fixed scenarios and reports a distribution, while this one needs a
 * ground-truth id set per (tenant, vector), a set intersection per sample, and
 * a third nested sweep dimension. Folding it in would have taken that file from
 * 288 lines to roughly 550 — past the 500-line hard-review line in
 * `CLAUDE.md` §7 — for two unrelated questions in one file. The guards, the
 * rolled-back transaction and the plan helpers they genuinely do share now live
 * in `kb-retrieval-probe.mjs` and are imported by both.
 *
 * Four things here are load-bearing, and each is a way the measurement lies if
 * it is skipped:
 *
 * 1. **The ground truth must provably not use HNSW.** It is computed with
 *    `enable_indexscan`/`enable_indexonlyscan`/`enable_bitmapscan` off, and the
 *    plan is `EXPLAIN`ed and asserted to contain no `hnsw` node before a single
 *    number is derived from it. An "exact" set that quietly came from the same
 *    approximate index would report 100% recall for a broken retrieval path.
 * 2. **The ground truth is computed once per tenant for all probe vectors in a
 *    single pass.** A 1536-dimension `vector` column is TOASTed
 *    (`attstorage = 'e'`), so a per-vector exact scan pays the detoast for every
 *    row on every query: 100 separate exact scans of the majority tenant cost
 *    ~440 s, the single cross-joined pass costs ~62 s for the identical answer.
 * 3. **The measured query is the production shape.** `vectorChunkIds`
 *    (`kb-candidate.service.ts:26-36`) sets `hnsw.iterative_scan =
 *    relaxed_order` and issues `... WHERE org_id = $1 ORDER BY embedding <=> $2
 *    LIMIT $3` — an explicit tenant predicate **on top of** RLS, which changes
 *    the plan. Measuring the RLS-only form measures a query the product does
 *    not run.
 * 4. **The `ef_search` knob is read back, not trusted.** pgvector registers
 *    `hnsw.ef_search` only when its library loads into the backend; before that
 *    a `SET` lands on an unrecognised-prefix placeholder. Every cell `SHOW`s the
 *    value inside its own transaction and refuses to report a sweep point it
 *    could not prove was applied.
 *
 * Usage:
 *   PERF_DATABASE_URL=postgresql://neondb_owner:...@127.0.0.1:5432/scratch_ai_latency \
 *   PERF_APP_DATABASE_URL=postgresql://streamline_app:...@127.0.0.1:5432/scratch_ai_latency \
 *     node test/perf/ai/measure-kb-retrieval-recall.mjs [--vectors=100] [--json=out.json]
 */
import { writeFileSync } from "node:fs";
import { CORPUS } from "./kb-retrieval-corpus.mjs";
import {
  assertAppRoleIsNotPrivileged,
  assertRlsBites,
  describePlan,
  inRolledBackTx,
  loadVectorLibrary,
  openConnections,
  percentile,
  sumBuffers,
} from "./kb-retrieval-probe.mjs";

/** The two real call-site caps, verified in `kb-rag-retrieval.service.ts` and `kb-search.service.ts`. */
const CAPS = [24, 120];

/**
 * The sweep. `40` is the pgvector default and therefore the value production
 * runs at today; it is deliberately *below* the 120 cap, which is the first
 * thing a reader needs to see. The rest bracket the cap from both sides and end
 * at pgvector's hard maximum of 1000, so the table can answer "is any setting
 * enough" and not only "does raising it help".
 */
const EF_SEARCH_SWEEP = [40, 100, 200, 400, 1000];

/** Production sets this at `kb-candidate.service.ts:28`. */
const ITERATIVE_SCAN = "relaxed_order";

/**
 * Two modes, because the question "what does the ANN path cost and recall at
 * this tenant size" cannot be answered by watching the planner alone.
 *
 * Below roughly 8,000 chunks the planner abandons HNSW for an exact
 * `(org_id, source_id)` index scan plus a top-N sort, so a planner-only table
 * has an empty cell exactly where the crossover decision needs a number. The
 * second mode turns `enable_sort` off, which removes the top-N sort from
 * consideration and leaves the HNSW ordered scan as the only path — **it does
 * not change the ANN algorithm**, it just prices the index scan production
 * would run if it chose it. Every forced cell asserts the plan really did use
 * the HNSW index, so a cell that silently fell back is reported as such rather
 * than counted.
 */
const MODES = [
  { key: "planner", label: "planner's choice — the production path", setup: [] },
  {
    key: "forced-ann",
    label: "HNSW forced (enable_sort = off) — prices ANN where the planner refuses it",
    setup: ["SET LOCAL enable_sort = off"],
  },
];

/**
 * A mean over fewer than 100 probes cannot carry a p5 that names a real
 * observation, for the same reason the latency harness floors its runs at 100.
 */
const MIN_VECTORS = 100;

/** `EXPLAIN (ANALYZE, BUFFERS)` doubles a sample's cost, so buffers come from a subset. */
const EXPLAIN_SAMPLES = 10;

const args = process.argv.slice(2);
const vectorCount = Math.max(
  MIN_VECTORS,
  Number.parseInt(args.find((a) => a.startsWith("--vectors="))?.slice(10) ?? "100", 10),
);
const jsonOut = args.find((a) => a.startsWith("--json="))?.slice(7);

const { owner, app } = openConnections();

/** `kb-candidate.service.ts:30-33` — the ANN pre-pass, explicit tenant predicate and all. */
const PRODUCTION_ANN_SQL = `SELECT id FROM public.kb_article_chunks
   WHERE org_id = $1
   ORDER BY embedding <=> $2::vector
   LIMIT $3`;

/** `kb-candidate.service.ts:39-46` — the exact re-scan the short-pool guard falls back to. */
const PRODUCTION_EXACT_SQL = `SELECT id FROM (
     SELECT id, embedding <=> $2::vector AS distance
     FROM public.kb_article_chunks
     WHERE org_id = $1
     OFFSET 0
   ) scoped
   ORDER BY scoped.distance
   LIMIT $3`;

const GROUND_TRUTH_SQL = `SELECT qid, id FROM (
     SELECT q.qid, c.id,
            row_number() OVER (PARTITION BY q.qid ORDER BY c.embedding <=> q.emb) AS rn
     FROM public.kb_article_chunks c
     CROSS JOIN perf_probe_vectors q
     WHERE c.org_id = $1
   ) ranked
   WHERE rn <= $2
   ORDER BY qid, rn`;

const EXACT_PLAN_SETUP = [
  "SET LOCAL work_mem = '512MB'",
  "SET LOCAL enable_indexscan = off",
  "SET LOCAL enable_indexonlyscan = off",
  "SET LOCAL enable_bitmapscan = off",
];

/**
 * Probe vectors are the first `n` topic vectors by id, which makes the set a
 * strict superset of the 12 used by the one-off probes recorded in
 * `KB-RETRIEVAL-LATENCY-HARNESS.md` §7c, so the two are directly comparable.
 * The topics are symmetric by construction — each is a distinct dominant
 * coordinate — so taking the low ids biases nothing.
 */
async function buildProbeVectors(count) {
  await owner.unsafe(`DROP TABLE IF EXISTS perf_probe_vectors`);
  await owner.unsafe(`
    CREATE TABLE perf_probe_vectors AS
    SELECT (row_number() OVER (ORDER BY id))::int - 1 AS qid, emb
    FROM perf_topic_pool ORDER BY id LIMIT ${count}`);
  await owner.unsafe(`CREATE INDEX ON perf_probe_vectors (qid)`);
  await owner.unsafe(`GRANT SELECT ON perf_probe_vectors TO PUBLIC`);
  const rows = await owner`SELECT qid, emb::text AS emb FROM perf_probe_vectors ORDER BY qid`;
  if (rows.length < count)
    throw new Error(`perf_topic_pool holds ${rows.length} vectors, need ${count}`);
  return rows.map((r) => r.emb);
}

async function exactGroundTruth(orgId, depth) {
  const setup = [`SET LOCAL app.organization_id = '${orgId}'`, ...EXACT_PLAN_SETUP];
  const { plan, rows } = await inRolledBackTx(app, setup, async (tx) => {
    const explained = await tx.unsafe(`EXPLAIN (FORMAT JSON) ${GROUND_TRUTH_SQL}`, [orgId, depth]);
    return {
      plan: describePlan(explained[0]["QUERY PLAN"][0].Plan),
      rows: await tx.unsafe(GROUND_TRUTH_SQL, [orgId, depth]),
    };
  });
  if (/hnsw/i.test(plan))
    throw new Error(`Ground truth for ${orgId} used the ANN index — not exact: ${plan}`);
  const byQuery = new Map();
  for (const row of rows) {
    const qid = Number(row.qid);
    if (!byQuery.has(qid)) byQuery.set(qid, []);
    byQuery.get(qid).push(Number(row.id));
  }
  return { plan, byQuery };
}

async function measureExactCost(orgId, vectors, cap) {
  const buffers = [];
  const durations = [];
  let plan = "";
  for (let i = 0; i < Math.min(EXPLAIN_SAMPLES, vectors.length); i += 1) {
    const sample = await inRolledBackTx(
      app,
      [`SET LOCAL app.organization_id = '${orgId}'`],
      async (tx) =>
        (
          await tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${PRODUCTION_EXACT_SQL}`, [
            orgId,
            vectors[i],
            cap,
          ])
        )[0]["QUERY PLAN"][0],
    );
    const b = sumBuffers(sample.Plan);
    buffers.push(b.hit + b.read);
    durations.push(sample["Execution Time"]);
    plan = describePlan(sample.Plan);
  }
  buffers.sort((a, b) => a - b);
  durations.sort((a, b) => a - b);
  return {
    orgId,
    cap,
    plan,
    medianBuffers: percentile(buffers, 0.5),
    p50Ms: Number(percentile(durations, 0.5).toFixed(2)),
    samples: buffers.length,
  };
}

async function measureCell(mode, orgId, cap, efSearch, vectors, groundTruth) {
  const setup = [
    `SET LOCAL app.organization_id = '${orgId}'`,
    `SET LOCAL hnsw.iterative_scan = ${ITERATIVE_SCAN}`,
    `SET LOCAL hnsw.ef_search = ${efSearch}`,
    ...mode.setup,
  ];
  const recalls = [];
  const plans = new Map();
  const buffers = [];
  const durations = [];
  let shortPool = 0;
  let annSamples = 0;
  let appliedEf = null;

  for (let i = 0; i < vectors.length; i += 1) {
    const wantBuffers = i < EXPLAIN_SAMPLES;
    const sample = await inRolledBackTx(app, setup, async (tx) => {
      const applied = appliedEf === null ? await tx.unsafe(`SHOW hnsw.ef_search`) : null;
      const ids = await tx.unsafe(PRODUCTION_ANN_SQL, [orgId, vectors[i], cap]);
      const explained = await tx.unsafe(`EXPLAIN (FORMAT JSON) ${PRODUCTION_ANN_SQL}`, [
        orgId,
        vectors[i],
        cap,
      ]);
      const analyzed = wantBuffers
        ? await tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${PRODUCTION_ANN_SQL}`, [
            orgId,
            vectors[i],
            cap,
          ])
        : null;
      return {
        applied: applied?.[0]?.["hnsw.ef_search"] ?? null,
        ids: ids.map((r) => Number(r.id)),
        plan: describePlan(explained[0]["QUERY PLAN"][0].Plan),
        analyzed: analyzed?.[0]["QUERY PLAN"][0] ?? null,
      };
    });

    if (appliedEf === null) {
      appliedEf = Number(sample.applied);
      if (appliedEf !== efSearch)
        throw new Error(
          `hnsw.ef_search reported ${sample.applied} after SET ${efSearch} — the knob did not apply.`,
        );
    }

    const exact = new Set(groundTruth.get(i).slice(0, cap));
    const hits = sample.ids.filter((id) => exact.has(id)).length;
    recalls.push(hits / exact.size);
    if (sample.ids.length < cap) shortPool += 1;
    if (/hnsw/i.test(sample.plan)) annSamples += 1;
    plans.set(sample.plan, (plans.get(sample.plan) ?? 0) + 1);
    if (sample.analyzed) {
      const b = sumBuffers(sample.analyzed.Plan);
      buffers.push(b.hit + b.read);
      durations.push(sample.analyzed["Execution Time"]);
    }
  }

  recalls.sort((a, b) => a - b);
  buffers.sort((a, b) => a - b);
  durations.sort((a, b) => a - b);
  return {
    mode: mode.key,
    orgId,
    cap,
    efSearch,
    samples: recalls.length,
    annPlanSamples: annSamples,
    meanRecall: recalls.reduce((s, r) => s + r, 0) / recalls.length,
    minRecall: recalls[0],
    p5Recall: percentile(recalls, 0.05),
    perfectProbes: recalls.filter((r) => r === 1).length,
    shortPool,
    medianBuffers: percentile(buffers, 0.5),
    p50Ms: Number(percentile(durations, 0.5).toFixed(2)),
    plans: [...plans.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([plan, count]) => ({ plan, count })),
  };
}

function pct(value) {
  return `${(value * 100).toFixed(2)}%`;
}

async function main() {
  const [{ current_database: db }] = await owner`SELECT current_database()`;
  const roleName = await assertAppRoleIsNotPrivileged(app);
  await assertRlsBites(app);
  await loadVectorLibrary(app);

  const [{ extversion: pgvector }] = await owner`
    SELECT extversion FROM pg_extension WHERE extname = 'vector'`;
  const settings = await owner`
    SELECT name, setting FROM pg_settings
    WHERE name IN ('shared_buffers', 'work_mem', 'maintenance_work_mem')`;
  const [{ indexdef }] = await owner`
    SELECT pg_get_indexdef(indexrelid) AS indexdef
    FROM pg_index WHERE indexrelid = 'idx_kb_chunks_embedding_hnsw'::regclass`;
  const hnswSettings = await app`
    SELECT name, setting FROM pg_settings WHERE name LIKE 'hnsw.%' ORDER BY name`;

  const counts = await owner`
    SELECT org_id, count(*)::int AS chunks
    FROM kb_article_chunks GROUP BY org_id ORDER BY 2 DESC`;
  const foreign = counts.filter((r) => !r.org_id.startsWith("perf_kb_"));
  if (foreign.length > 0)
    throw new Error(
      `${foreign.reduce((s, r) => s + r.chunks, 0)} chunks outside perf_kb_% dilute the index ` +
        `(${foreign.map((r) => r.org_id).join(", ")}). Delete them or the shares are fiction.`,
    );
  const byOrg = new Map(counts.map((r) => [r.org_id, r.chunks]));
  const total = counts.reduce((s, r) => s + r.chunks, 0);

  console.log(`Target ${db} · measured as ${roleName} (no BYPASSRLS, tenant GUC set)`);
  console.log(`pgvector ${pgvector} · ${indexdef}`);
  console.log(`${hnswSettings.map((s) => `${s.name}=${s.setting}`).join(" · ")}`);
  console.log(`${settings.map((s) => `${s.name}=${s.setting}`).join(" · ")}`);
  console.log(`Corpus ${total.toLocaleString()} chunks, no rows outside perf_kb_%`);

  const vectors = await buildProbeVectors(vectorCount);
  const maxCap = Math.max(...CAPS);
  console.log(`${vectors.length} probe vectors · caps ${CAPS.join(", ")} · ef_search ${EF_SEARCH_SWEEP.join(", ")}`);

  const groundTruth = new Map();
  const groundTruthPlans = [];
  for (const { orgId } of CORPUS) {
    const started = Date.now();
    const { plan, byQuery } = await exactGroundTruth(orgId, maxCap);
    for (const [qid, ids] of byQuery)
      if (ids.length < maxCap)
        throw new Error(`${orgId} q${qid} returned ${ids.length} exact rows, need ${maxCap}`);
    groundTruth.set(orgId, byQuery);
    groundTruthPlans.push({ orgId, plan });
    console.log(
      `  exact top-${maxCap} for ${orgId} — ${((Date.now() - started) / 1000).toFixed(1)}s · ${plan}`,
    );
  }

  const exactCosts = [];
  console.log(`\nExact re-scan cost (kb-candidate.service.ts:39-46), ${EXPLAIN_SAMPLES} samples`);
  console.log(`  ${"org".padEnd(16)} ${"chunks".padStart(7)} ${"cap".padStart(4)} ${"buffers".padStart(9)} ${"p50 ms".padStart(9)}  plan`);
  for (const { orgId } of CORPUS)
    for (const cap of CAPS) {
      const row = await measureExactCost(orgId, vectors, cap);
      exactCosts.push({ ...row, chunks: byOrg.get(orgId) ?? 0 });
      console.log(
        `  ${orgId.padEnd(16)} ${String(byOrg.get(orgId) ?? 0).padStart(7)} ${String(cap).padStart(4)} ` +
          `${String(row.medianBuffers).padStart(9)} ${String(row.p50Ms).padStart(9)}  ${row.plan}`,
      );
    }

  const results = [];
  for (const mode of MODES)
    for (const cap of CAPS) {
      console.log(
        `\nrecall@${cap} · ${mode.label} · hnsw.iterative_scan = ${ITERATIVE_SCAN}`,
      );
      console.log(
        `  ${"org".padEnd(16)} ${"chunks".padStart(7)} ${"ef".padStart(5)} ${"mean".padStart(8)} ` +
          `${"min".padStart(8)} ${"p5".padStart(8)} ${"100%".padStart(6)} ${"short".padStart(6)} ` +
          `${"buffers".padStart(9)} ${"p50 ms".padStart(9)}  plan`,
      );
      for (const { orgId } of CORPUS)
        for (const efSearch of EF_SEARCH_SWEEP) {
          const row = await measureCell(
            mode,
            orgId,
            cap,
            efSearch,
            vectors,
            groundTruth.get(orgId),
          );
          results.push({ ...row, chunks: byOrg.get(orgId) ?? 0 });
          const planColumn = row.plans
            .map((p) => (row.plans.length === 1 ? p.plan : `${p.plan} x${p.count}`))
            .join(" | ");
          console.log(
            `  ${orgId.padEnd(16)} ${String(byOrg.get(orgId) ?? 0).padStart(7)} ${String(efSearch).padStart(5)} ` +
              `${pct(row.meanRecall).padStart(8)} ${pct(row.minRecall).padStart(8)} ${pct(row.p5Recall).padStart(8)} ` +
              `${String(row.perfectProbes).padStart(6)} ${String(row.shortPool).padStart(6)} ` +
              `${String(row.medianBuffers).padStart(9)} ${String(row.p50Ms).padStart(9)}  ${planColumn}`,
          );
        }
    }

  if (jsonOut) {
    writeFileSync(
      jsonOut,
      JSON.stringify(
        {
          db,
          role: roleName,
          pgvector,
          hnswIndex: indexdef,
          hnswSettings: Object.fromEntries(hnswSettings.map((s) => [s.name, s.setting])),
          serverSettings: Object.fromEntries(settings.map((s) => [s.name, s.setting])),
          iterativeScan: ITERATIVE_SCAN,
          modes: MODES.map((m) => ({ key: m.key, label: m.label, setup: m.setup })),
          probeVectors: vectors.length,
          caps: CAPS,
          efSearchSweep: EF_SEARCH_SWEEP,
          corpus: CORPUS.map((o) => ({
            ...o,
            seeded: byOrg.get(o.orgId) ?? 0,
            share: Number((((byOrg.get(o.orgId) ?? 0) / total) * 100).toFixed(2)),
          })),
          totalChunks: total,
          groundTruthPlans,
          exactCosts,
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
