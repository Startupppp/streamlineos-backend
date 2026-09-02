#!/usr/bin/env node
/**
 * Produces contracts/benchmark-manifest.json — the per-module benchmark record and the baseline the
 * regression gate ratchets against.
 *
 * IT MEASURES ALMOST NOTHING ITSELF. Two instruments already exist and are trusted, so this runner
 * drives them as child processes and consumes their JSON:
 *
 *   src/scripts/run-read-cost-budgets.mjs   70 route read paths — EXPLAIN (ANALYZE, BUFFERS) under
 *                                           RLS, percentiles over N samples, vacuity detection.
 *   test/perf/measure-heavy-query-plans.mjs 36 named heavy paths — cold/warm buffers and the full
 *                                           plan text, which is what "plans are retained" means.
 *
 * What it adds is the provenance a percentile is worthless without, and the two dimensions neither
 * instrument covers: the dataset the number was taken over, and the behaviour under concurrency
 * (see benchmark-environment.mjs). Plus the part that decides whether the gate is usable at all:
 *
 * THE NOISE STUDY. `--replicates=N` runs the whole read-cost measurement N times against unchanged
 * code and records, per metric, how far it moved. The regression thresholds are then DERIVED from
 * that envelope rather than chosen. A gate whose thresholds are guessed fires on ordinary variance
 * and is muted within a week; a gate whose thresholds come from the measured envelope of the very
 * machine it runs on cannot fire on a rerun, and the manifest carries the replicate data so the
 * claim is checkable rather than asserted.
 *
 * Usage:
 *   APP_DATABASE_URL=postgres://streamline_app@127.0.0.1:5432/scratch_perf_seed PGSSLMODE=disable \
 *     node test/perf/measure-benchmark-manifest.mjs \
 *       [--samples=50] [--replicates=3] [--concurrency=8] [--iterations=48] [--plans] [--write]
 *
 *   node test/perf/measure-benchmark-manifest.mjs --self-test
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { MODULES, STATEMENT_CEILING_MS, TENANTS, validateModules } from "./benchmark-modules.mjs";
import { assertScratchTarget } from "./heavy-query-fixtures.mjs";
import {
  capturePlan,
  captureEnvironment,
  measureConcurrency,
  measureDatasetSize,
  resolveBudgetFixtures,
  selfTest as environmentSelfTest,
} from "./benchmark-environment.mjs";
import { METRICS, noiseEnvelope, summarise } from "../../src/scripts/benchmark-regression.mjs";
import { pickMetrics, runNoiseStudy } from "./benchmark-noise-study.mjs";

import {
  BACKEND_ROOT,
  PLAN_DIR,
  ceilingFor,
  heavyObservation,
  readCostObservation,
  routeBudgetsByReadCostId,
  runHeavyQueries,
  runReadCost,
  statementVerdict,
} from "./benchmark-instruments.mjs";

const MANIFEST_PATH = join(BACKEND_ROOT, "contracts", "benchmark-manifest.json");

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
async function main() {
  const url = process.env.APP_DATABASE_URL;
  if (!url) {
    console.error("APP_DATABASE_URL is required — it must be the non-BYPASSRLS application role.");
    process.exit(1);
  }
  const target = assertScratchTarget(url, [process.env.DATABASE_URL]);
  if (!target.ok) {
    console.error(`measure-benchmark-manifest: ${target.reason}`);
    process.exit(1);
  }

  const samples = Math.max(2, Number(arg("samples", "50")) || 50);
  const replicates = Math.max(1, Number(arg("replicates", "1")) || 1);
  const concurrency = Math.max(2, Number(arg("concurrency", "8")) || 8);
  const iterations = Math.max(concurrency, Number(arg("iterations", "48")) || 48);
  const withPlans = process.argv.includes("--plans");
  const write = process.argv.includes("--write");

  const ssl = process.env.PGSSLMODE === "disable" ? false : "require";
  const sql = postgres(url, { max: 1, prepare: false, ssl, onnotice: () => {} });

  const [role] = await sql`
    SELECT current_user AS name, r.rolbypassrls, r.rolsuper FROM pg_roles r WHERE r.rolname = current_user`;
  if (role.rolbypassrls || role.rolsuper) {
    await sql.end();
    console.error(
      `REFUSING TO MEASURE: connected as "${role.name}" (bypassrls=${role.rolbypassrls} superuser=${role.rolsuper}).` +
        " Every plan taken this way omits the RLS qual, so every number would describe a query the application never runs.",
    );
    process.exit(1);
  }

  const { BUDGETS } = await import(join(BACKEND_ROOT, "src", "scripts", "read-cost-budgets.mjs"));
  const { QUERIES } = await import("./heavy-query-catalog.mjs");
  const moduleErrors = validateModules(MODULES, new Set(BUDGETS.map((b) => b.id)), new Set(QUERIES.map((q) => q.id)));
  if (moduleErrors.length > 0) {
    await sql.end();
    for (const e of moduleErrors) console.error("INVALID MODULE DECLARATION:", e);
    process.exit(1);
  }

  const environment = await captureEnvironment(sql, BACKEND_ROOT);
  console.log(
    `${environment.database.name} ${environment.database.sizeMb} MB · role ${environment.role.name}` +
      ` (bypassrls=${environment.role.bypassrls}) · ${environment.machine.cpuCount} cpu ·` +
      ` load ${environment.machine.loadAverage1m} · sha ${String(environment.releaseSha).slice(0, 8)}`,
  );

  const scratch = mkdtempSync(join(tmpdir(), "benchmark-manifest-"));
  const childEnv = { ...process.env };
  const routeBudgets = routeBudgetsByReadCostId();

  // ── read-cost, every tenant, `replicates` times.
  //
  // The replicate loop is OUTSIDE the tenant loop on purpose. Three consecutive runs of the same
  // tenant measure a cache that never gets a chance to move, which understates run-to-run variance
  // and would calibrate the gate too tight — the failure mode that produces false alarms. Ordering
  // the passes large → mid → small → tiny → large again puts three other tenants' worth of work
  // between one tenant's replicates.
  const budgetFixtures = {};
  for (const tenant of TENANTS) budgetFixtures[tenant.label] = await resolveBudgetFixtures(sql, tenant.id);
  const complexIds = new Set(
    MODULES.flatMap((m) =>
      Object.entries(m.readCostBudgets).filter(([, spec]) => spec.class === "complex").map(([id]) => id),
    ),
  );

  const readCostRuns = {};
  const planSigRuns = {};
  const planningRuns = {};
  const retainedPlans = {};
  for (const tenant of TENANTS) {
    readCostRuns[tenant.label] = [];
    planSigRuns[tenant.label] = [];
    planningRuns[tenant.label] = {};
    retainedPlans[tenant.label] = [];
  }
  for (let r = 0; r < replicates; r++) {
    for (const tenant of TENANTS) {
      const out = join(scratch, `read-cost-${tenant.label}-${r}.json`);
      const doc = runReadCost({ tenant, samples, outFile: out, env: childEnv });
      readCostRuns[tenant.label].push(doc);

      // The plan signature is captured on EVERY replicate, not once, because it is used as an exact
      // ratchet and an exact ratchet on a metric that moves by itself is a false alarm generator.
      // Capturing it per pass is what lets the noise study arm or disarm it from evidence.
      const sigs = {};
      for (const budget of BUDGETS) {
        const params = budget.params(budgetFixtures[tenant.label]);
        if (params === null) continue;
        const wantText = r === 0 && complexIds.has(budget.id);
        const plan = await capturePlan(sql, tenant.id, budget.sql, params, { verbose: wantText });
        if (plan.signature) sigs[budget.id] = plan.signature;
        if (plan.planningBufferBlocks !== null && plan.planningBufferBlocks !== undefined)
          (planningRuns[tenant.label][r] ??= {})[budget.id] = plan.planningBufferBlocks;
        if (wantText && plan.text)
          retainedPlans[tenant.label].push(`### ${budget.id}  (approved complex, tenant ${tenant.label})\n${plan.text}\n`);
      }
      planSigRuns[tenant.label].push(sigs);

      console.log(
        `pass ${r + 1}/${replicates} ${tenant.label.padEnd(5)}: ${doc.measured}/${doc.declared} measured,` +
          ` ${doc.passed} pass, ${doc.breaches} breach · ${Object.keys(sigs).length}/${BUDGETS.length} plan signatures`,
      );
    }
  }
  const readCostByTenant = Object.fromEntries(
    Object.entries(readCostRuns).map(([label, runs]) => [label, runs[0]]),
  );
  const planSignatures = Object.fromEntries(
    Object.entries(planSigRuns).map(([label, runs]) => [label, runs[0]]),
  );

  const { policy, perBenchmarkCv, noiseRows, stabilitySeries, falsePositives, planStability } = runNoiseStudy({
    readCostRuns,
    planSigRuns,
    planningRuns,
    budgets: BUDGETS,
    tenants: TENANTS,
    replicates,
    log: (line) => console.log(line),
  });

  mkdirSync(PLAN_DIR, { recursive: true });
  for (const tenant of TENANTS)
    writeFileSync(
      join(PLAN_DIR, `approved-complex-${tenant.label}.txt`),
      `# Retained plans for every statement that claims the 200 ms COMPLEX ceiling.\n` +
        `# Tenant ${tenant.label} (${tenant.id}, ${tenant.share} of rows), role streamline_app under RLS.\n` +
        `# Release ${environment.releaseSha}\n\n${retainedPlans[tenant.label].join("\n")}`,
    );
  console.log(
    `plans retained: ${TENANTS.map((t) => `${t.label} ${retainedPlans[t.label].length}`).join(" · ")}` +
      ` of ${complexIds.size} approved-complex statements`,
  );

  // ── heavy queries (plans retained on disk)
  const heavyByOrg = {};
  if (withPlans) {
    // measure-heavy-query-plans.mjs decides TLS from the URL string alone, not from PGSSLMODE, so a
    // loopback URL without the parameter is dialled over TLS and dies before it measures anything.
    const heavyUrl = ssl === false && !url.includes("sslmode=") ? `${url}${url.includes("?") ? "&" : "?"}sslmode=disable` : url;
    for (const orgLabel of ["large", "mid", "small"]) {
      const doc = runHeavyQueries({ orgLabel, env: { ...childEnv, PERF_APP_DATABASE_URL: heavyUrl } });
      heavyByOrg[orgLabel] = doc;
      console.log(`heavy-query plans ${orgLabel}: ${doc.results.filter((r) => r.status === "measured").length}/${doc.results.length} measured`);
    }
  }

  // ── per-module dataset size and the concurrency probe
  const modules = [];
  for (const m of MODULES) {
    const dataset = {};
    for (const tenant of TENANTS) dataset[tenant.label] = await measureDatasetSize(sql, m.tables, tenant.id);

    const probeBudget = BUDGETS.find((b) => b.id === m.concurrencyProbe);
    const params = probeBudget.params(budgetFixtures.large);
    const concurrencyRuns = [];
    if (params === null) {
      concurrencyRuns.push({ status: "unmeasured", reason: `no fixture resolves ${m.concurrencyProbe} on this seed` });
    } else {
      for (const level of [1, concurrency]) {
        const r = await measureConcurrency({
          url, ssl, orgId: TENANTS[0].id, sql: probeBudget.sql, params, concurrency: level, iterations,
        });
        concurrencyRuns.push({ status: "measured", ...r });
      }
    }

    const benchmarks = [];
    for (const [id, spec] of Object.entries(m.readCostBudgets)) {
      const measurements = {};
      for (const tenant of TENANTS) {
        measurements[tenant.label] = readCostObservation(
          readCostByTenant[tenant.label].budgets.find((b) => b.id === id),
        );
        const sig = planSignatures[tenant.label][id];
        if (sig && measurements[tenant.label].status === "measured") measurements[tenant.label].planSignature = sig;
        const planBlocks = planningRuns[tenant.label][0]?.[id];
        if (planBlocks !== undefined && measurements[tenant.label].status === "measured")
          measurements[tenant.label].planningBufferBlocks = planBlocks;
      }
      // Ticket 22 counted statements for two routes. A counted figure becomes an EXACT ratchet on
      // the reference tenant; a default ceiling is recorded beside it and never treated as one.
      const routes = routeBudgets[id] ?? [];
      const counted = routes.filter((r) => r.measuredDbCalls !== null && r.dbCallBasis !== "manifest-default");
      if (counted.length === 1 && measurements.large.status === "measured")
        measurements.large.measuredDbCalls = counted[0].measuredDbCalls;
      const errorRuns = TENANTS.filter((t) => measurements[t.label].status === "error").length;
      benchmarks.push({
        id,
        routeBudgets: routes.length > 0 ? routes : null,
        dbCallRatchet:
          counted.length === 1
            ? {
                armed: true,
                measuredDbCalls: counted[0].measuredDbCalls,
                ceiling: counted[0].maxDbCalls,
                breach: counted[0].measuredDbCalls > counted[0].maxDbCalls,
                route: counted[0].route,
                basis: counted[0].dbCallBasis,
              }
            : {
                armed: false,
                reason:
                  routes.length === 0
                    ? "no route budget links to this read path"
                    : `route budget(s) ${routes.map((r) => r.route).join(", ")} declare maxDbCalls but nothing has counted them (dbCallBasis: ${routes.map((r) => r.dbCallBasis).join("/")})`,
              },
        source: "read-cost-budgets.mjs",
        instrument:
          "EXPLAIN (ANALYZE, BUFFERS) as streamline_app with the tenant GUC set; dominant plan node " +
          "captured separately, and the VERBOSE plan text retained in test/perf/benchmark-plans/ for " +
          "every statement claiming the COMPLEX ceiling",
        statementClass: spec.class,
        approval: spec.approval,
        ceilingMs: ceilingFor(spec),
        repetitions: samples,
        warmState: "warm — percentiles are over samples 1..N with the first (cold) sample recorded separately as coldMs",
        measurements,
        errorRate: Math.round((errorRuns / TENANTS.length) * 10000) / 10000,
        cv: perBenchmarkCv[id] ?? null,
        ...statementVerdict(spec, measurements.large),
      });
    }
    for (const id of m.heavyQueries) {
      const measurements = {};
      for (const orgLabel of ["large", "mid", "small"])
        measurements[orgLabel] = heavyByOrg[orgLabel]
          ? heavyObservation(heavyByOrg[orgLabel].results.find((r) => r.id === id))
          : { status: "unmeasured", reason: "heavy-query plans not captured in this run (--plans)" };
      benchmarks.push({
        id,
        source: "heavy-query-catalog.mjs",
        instrument: "EXPLAIN (ANALYZE, BUFFERS, VERBOSE) as streamline_app; full plan text retained in test/perf/benchmark-plans/",
        statementClass: "reference",
        approval: null,
        ceilingMs: null,
        repetitions: 2,
        warmState: "cold and warm both recorded — run 1 and run 2 of the same statement in one transaction",
        measurements,
        errorRate: 0,
        cv: null,
        verdict: measurements.large?.status === "measured" ? "recorded" : "unmeasured",
      });
    }

    modules.push({
      id: m.id,
      title: m.title,
      surface: m.surface,
      tables: m.tables,
      dataset,
      concurrency: {
        probe: m.concurrencyProbe,
        note:
          "The real statement, not EXPLAIN, against a pool sized to exactly the concurrency. " +
          "Wall clock therefore includes result transfer and pool acquisition, which the EXPLAIN percentiles exclude.",
        runs: concurrencyRuns,
      },
      benchmarks,
    });
    const datasetErrors = TENANTS.flatMap((t) => dataset[t.label].errors.map((e) => `${t.label}/${e}`));
    if (datasetErrors.length > 0)
      for (const e of datasetErrors) console.error(`  DATASET ERROR ${m.id}: ${e}`);
    const probeSummary = concurrencyRuns
      .filter((r) => r.status === "measured")
      .map((r) => `c${r.concurrency} p95=${r.latency?.p95 ?? "?"}ms err=${r.errorRate}`)
      .join(" · ");
    console.log(
      `module ${m.id.padEnd(20)} ${String(benchmarks.length).padStart(2)} benchmarks · ` +
        `${dataset.large.tenantRows} reference-tenant rows · ${probeSummary || "probe unmeasured"}`,
    );
  }

  await sql.end();

  const allBenchmarks = modules.flatMap((m) => m.benchmarks);
  const measuredOn = (t) => allBenchmarks.filter((b) => b.measurements[t]?.status === "measured").length;
  const manifest = {
    version: 1,
    schemaVersion: "benchmark-manifest/1",
    description:
      "Per-module benchmark record for the declared critical read paths, and the baseline the " +
      "regression gate ratchets against. Produced by test/perf/measure-benchmark-manifest.mjs.",
    honesty:
      "Every millisecond figure here is a LOWER BOUND. They are taken over loopback Postgres on a " +
      "shared developer laptop, so they exclude pool wait, network round trip, serialization and " +
      "every layer of the Nest request path. Buffer blocks and row counts are the numbers that " +
      "ratchet; the milliseconds are recorded because the ceiling is stated in milliseconds, not " +
      "because they estimate production.",
    prd: {
      section: "§12.1",
      statementCeilingsMs: STATEMENT_CEILING_MS,
      requestCeilingsMs: {
        ordinaryRequest: 300,
        complexAggregateOrSearch: 800,
        cacheHitPath: 100,
        note: "Request-level ceilings are NOT measured by this manifest — see coverage.notMeasured.",
      },
    },
    environment,
    method: {
      instruments: [
        "src/scripts/run-read-cost-budgets.mjs — EXPLAIN (ANALYZE, BUFFERS), percentiles over N samples",
        "test/perf/measure-heavy-query-plans.mjs — cold/warm buffers plus retained plan text",
        "test/perf/benchmark-environment.mjs — dataset size, machine limits, concurrency and error rate",
      ],
      command: `node ${process.argv.slice(1).map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`,
      reproduce:
        `APP_DATABASE_URL=postgres://streamline_app@127.0.0.1:5432/${environment.database.name} PGSSLMODE=disable \\\n` +
        `  node test/perf/measure-benchmark-manifest.mjs --samples=${samples} --replicates=${replicates} ` +
        `--concurrency=${concurrency} --iterations=${iterations} --plans --write\n` +
        `node src/scripts/check-benchmark-manifest.mjs`,
      workingDirectory: BACKEND_ROOT,
      samples,
      replicates,
      concurrencyLevels: [1, concurrency],
      concurrencyIterations: iterations,
      tenants: TENANTS,
      tenantSkew:
        "The same statement picks different plans per tenant on this seed, so every benchmark is " +
        "recorded against all four rather than the majority tenant alone.",
      datasetAttribution:
        "A module's dataset counts the tables the MODULE owns. A read that joins another module's " +
        "table is still measured in full, but those rows are counted under the module that owns " +
        "them — dashboard-home owns only `announcements`, and its section reads are measured over " +
        "the notifications, calendar, build and attendance datasets recorded under those modules.",
      replicateOrdering:
        "Replicates are ordered large -> mid -> small -> tiny -> large again, so a tenant's own " +
        "replicates are separated by three other tenants' work. Consecutive reruns of one tenant " +
        "would measure a cache that never moves, understate variance, and calibrate the gate too " +
        "tight — which is the direction that produces false alarms.",
    },
    noiseStudy:
      replicates > 1
        ? {
            replicates,
            what: "The same measurement repeated against unchanged code. The regression thresholds below are derived from this, not chosen.",
            timingStability: Object.fromEntries(
              Object.entries(stabilitySeries).map(([metric, series]) => {
                const sorted = [...series].sort((a, b) => a - b);
                return [
                  metric,
                  {
                    samples: sorted.length,
                    medianRelSwing: sorted[Math.floor(sorted.length / 2)],
                    p90RelSwing: sorted[Math.floor(sorted.length * 0.9)],
                    worstRelSwing: sorted[sorted.length - 1],
                  },
                ];
              }),
            ),
            stabilityNote:
              "Relative replicate-to-replicate swing of each metric on UNCHANGED code, across every " +
              "benchmark and tenant. This table is the whole argument for what the gate ratchets on: " +
              "a metric whose worst swing is 0 can be ratcheted exactly, and one whose worst swing is " +
              "larger than any regression worth catching cannot be ratcheted at all.",
            planShapeStability: planStability,
            benchmarks: noiseRows,
            falsePositives,
          }
        : { replicates, what: "not run — rerun with --replicates=3 or more", benchmarks: [], falsePositives: null },
    regressionPolicy: policy,
    metrics: METRICS,
    coverage: {
      modules: modules.length,
      benchmarks: allBenchmarks.length,
      readCostBenchmarks: allBenchmarks.filter((b) => b.source === "read-cost-budgets.mjs").length,
      heavyQueryBenchmarks: allBenchmarks.filter((b) => b.source === "heavy-query-catalog.mjs").length,
      measuredOnReferenceTenant: measuredOn("large"),
      planSignaturesCaptured: Object.fromEntries(
        TENANTS.map((t) => [t.label, Object.keys(planSignatures[t.label]).length]),
      ),
      approvedComplexPlansRetained: Object.fromEntries(
        TENANTS.map((t) => [t.label, retainedPlans[t.label].length]),
      ),
      approvedComplexStatements: complexIds.size,
      dbCallRatchetsArmed: allBenchmarks.filter((b) => b.dbCallRatchet?.armed).length,
      dbCallRatchetsUnarmed: allBenchmarks.filter((b) => b.dbCallRatchet && !b.dbCallRatchet.armed).length,
      measuredPerTenant: Object.fromEntries(TENANTS.map((t) => [t.label, measuredOn(t.label)])),
      notMeasured: [
        "End-to-end request latency, response bytes, resident memory and downstream-provider calls. " +
          "These need an HTTP harness; test/helpers/seeded-e2e-app.ts is the right vehicle but requires " +
          "AUTH_SIGNING_KEYS, which is absent from .env on this machine. Reported as NOT MEASURED rather " +
          "than substituting a database-side proxy for a request-level ceiling.",
        "Cache-hit latency. No Redis is running against this seed, so every number here is the cache-MISS path.",
      ],
    },
    modules,
  };

  const outPath = arg("out", MANIFEST_PATH);
  if (write) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`\nWrote ${outPath}`);
  } else {
    console.log(`\n(dry run — pass --write to update ${outPath})`);
  }
  console.log(
    `${modules.length} modules · ${allBenchmarks.length} benchmarks · ` +
      `${measuredOn("large")} measured on the reference tenant`,
  );
}

function selfTest() {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push(ok);
    console.log(`  ${ok ? "[pass]" : "[FAIL]"} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  check(
    "a read-cost breach is a MEASUREMENT, not an error — it must still populate the ratchet",
    readCostObservation({ id: "x", outcome: "fail", blocks: 10234, warmBlocks: 10234, resultRows: 1, ceiling: 3000, latency: { p95Ms: 9 } }).status === "measured",
  );
  check(
    "an errored budget is never recorded as measured",
    readCostObservation({ id: "x", outcome: "error", reason: "boom" }).status === "error",
  );
  check(
    "a vacuous budget is flagged rather than counted as a passing measurement",
    readCostObservation({ id: "x", outcome: "fail", blocks: 5, warmBlocks: 5, resultRows: 0, vacuous: true, latency: {} }).status === "vacuous",
  );
  check(
    "a below-floor minority record is unmeasured, not a breach",
    readCostObservation({ id: "x", outcome: "unmeasured", reason: "seed-too-small" }).status === "unmeasured",
  );
  check(
    "the warm buffer count is what ratchets, not the cold one",
    readCostObservation({ id: "x", outcome: "pass", blocks: 90, warmBlocks: 78, resultRows: 5, latency: {} }).bufferBlocks === 78,
  );
  check(
    "pickMetrics drops nulls so an unmeasured field can never be compared as zero",
    !("p95Ms" in pickMetrics({ bufferBlocks: 10, p95Ms: null })),
  );
  check(
    "an ordinary statement is held to 50 ms and a complex one to 200 ms",
    ceilingFor({ class: "ordinary" }) === 50 && ceilingFor({ class: "complex" }) === 200,
  );
  check(
    "a statement over its class ceiling reports over, not unmeasured",
    statementVerdict({ class: "ordinary" }, { status: "measured", p95Ms: 60 }).verdict === "over",
  );
  check(
    "an unmeasured statement never reports within",
    statementVerdict({ class: "ordinary" }, { status: "unmeasured" }).verdict === "unmeasured",
  );

  const rc = BUDGET_IDS_FOR_SELF_TEST();
  check(
    "every declared read-cost benchmark exists in the catalog",
    rc.errors.length === 0,
    rc.errors.join("; ") || `${rc.declared} declared`,
  );
  check(
    "summarise and noiseEnvelope agree on a constant series",
    noiseEnvelope([5, 5, 5]).maxRelSwing === 0 && summarise([5, 5, 5]).cv === 0,
  );

  console.log("\n  ── environment instrument");
  const envOk = environmentSelfTest();

  const ok = results.every(Boolean) && envOk;
  console.log(ok ? "\nSELF-TEST PASSED" : "\nSELF-TEST FAILED");
  return ok;
}

function BUDGET_IDS_FOR_SELF_TEST() {
  const declared = MODULES.reduce((n, m) => n + Object.keys(m.readCostBudgets).length, 0);
  return { declared, errors: validateModules(MODULES, null, null) };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv.includes("--self-test")) {
    console.log("measure-benchmark-manifest self-test\n");
    process.exit(selfTest() ? 0 : 1);
  }
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
