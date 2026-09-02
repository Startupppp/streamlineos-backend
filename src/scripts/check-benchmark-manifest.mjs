#!/usr/bin/env node
/**
 * check-benchmark-manifest.mjs — the gate over contracts/benchmark-manifest.json.
 *
 * It answers three separate questions and never lets one stand in for another:
 *
 * 1. IS THE MANIFEST HONEST?
 *    Every module declares its tables, its dataset size, its concurrency runs and a release SHA.
 *    Every benchmark resolves to a real entry in one of the two catalogs, carries a statement class,
 *    and — if it claims the looser COMPLEX ceiling — carries an approval reason. A benchmark whose
 *    query returned zero rows is VACUOUS: it satisfies every ceiling trivially, so it is counted as
 *    unmeasured rather than as a pass.
 *
 * 2. ARE THE MEASURED STATEMENTS INSIDE THEIR PRD §12.1 CEILING?
 *    Ordinary statements 50 ms p95, approved complex statements 200 ms p95. Measured only.
 *
 * 3. HAS ANYTHING REGRESSED SINCE THE RECORDED BASELINE?  (--against=<fresh measurement json>)
 *    Decided by src/scripts/benchmark-regression.mjs, whose thresholds come from the manifest's own
 *    replicate study. On the seeded perf database that study measured buffers, rows and plan shape
 *    moving by EXACTLY ZERO across three replicates of all 70 read paths, and the same statements'
 *    wall clock moving by up to 200%. So buffers, rows, plan shape and statement counts are ratcheted
 *    exactly and timing is disarmed — printed, never failing the build. That is not a preference; it
 *    is what the measurement said, and a quieter harness re-arms it automatically.
 *
 * VERDICT
 *   OK           every declared benchmark measured, every measured statement inside its ceiling,
 *                nothing regressed.
 *   PARTIAL      nothing over ceiling and nothing regressed, but coverage is incomplete.
 *   FAIL         a measured statement is over its ceiling, or a ratcheted metric regressed, or the
 *                manifest is invalid.
 *   INCONCLUSIVE nothing measured at all.
 *
 * Usage:  node src/scripts/check-benchmark-manifest.mjs [--self-test] [--strict] [--against=<json>]
 *         pnpm check:benchmark-manifest
 *
 * Exit codes: 0 ok/partial (or self-test passed) · 1 violations or self-test failed ·
 *             2 manifest unreadable, or a non-OK verdict under --strict.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUDGETS as READ_COST_BUDGETS } from "./read-cost-budgets.mjs";
import { METRICS, decideBenchmark } from "./benchmark-regression.mjs";

const BACKEND_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const MANIFEST_OVERRIDE = (process.argv.find((a) => a.startsWith("--manifest=")) ?? "").slice("--manifest=".length);
const MANIFEST_PATH = MANIFEST_OVERRIDE
  ? resolve(process.cwd(), MANIFEST_OVERRIDE)
  : join(BACKEND_ROOT, "contracts", "benchmark-manifest.json");

const SELF_TEST = process.argv.includes("--self-test");
const STRICT = process.env.STREAMLINE_STRICT_BUDGETS === "1" || process.argv.includes("--strict");
const AGAINST = (process.argv.find((a) => a.startsWith("--against=")) ?? "").slice("--against=".length);

const REQUIRED_MODULE_FIELDS = ["id", "title", "surface", "tables", "dataset", "concurrency", "benchmarks"];
const REQUIRED_BENCHMARK_FIELDS = ["id", "source", "statementClass", "repetitions", "warmState", "measurements", "errorRate"];
const REQUIRED_PROVENANCE = [
  ["environment.releaseSha", (m) => m.environment?.releaseSha],
  ["environment.machine.cpuCount", (m) => m.environment?.machine?.cpuCount],
  ["environment.machine.totalMemoryMb", (m) => m.environment?.machine?.totalMemoryMb],
  ["environment.container", (m) => m.environment?.container],
  ["environment.database.name", (m) => m.environment?.database?.name],
  ["environment.role.bypassrls", (m) => m.environment?.role],
  ["method.command", (m) => m.method?.command],
  ["method.reproduce", (m) => m.method?.reproduce],
  ["method.samples", (m) => m.method?.samples],
  ["method.replicates", (m) => m.method?.replicates],
  ["method.concurrencyLevels", (m) => m.method?.concurrencyLevels],
  ["regressionPolicy", (m) => m.regressionPolicy],
];

/** Structural and honesty validation. Returns violations; empty means the manifest is well-formed. */
export function validateManifest(manifest, knownReadCostIds, warnings = []) {
  const v = [];
  for (const [label, get] of REQUIRED_PROVENANCE)
    if (get(manifest) === undefined || get(manifest) === null)
      v.push(`manifest is missing required provenance: ${label}`);

  if (manifest.environment?.role && manifest.environment.role.bypassrls !== false)
    v.push(
      `measured as a BYPASSRLS role (${manifest.environment.role.name}) — every plan omits the RLS ` +
        `predicate, so no number in this manifest describes a query the application runs`,
    );

  if (!Array.isArray(manifest.modules) || manifest.modules.length === 0) {
    v.push("manifest declares no modules");
    return v;
  }

  const seen = new Set();
  for (const m of manifest.modules) {
    for (const f of REQUIRED_MODULE_FIELDS)
      if (m[f] === undefined || m[f] === null) v.push(`${m.id ?? "<unnamed module>"}: missing ${f}`);
    if (seen.has(m.id)) v.push(`duplicate module "${m.id}"`);
    seen.add(m.id);
    if (m.dataset && Object.values(m.dataset).every((d) => (d?.tenantRows ?? 0) === 0))
      v.push(`${m.id}: dataset is zero rows on every tenant — the module's benchmarks measure nothing`);

    // A FAST NUMBER OVER AN EMPTY TABLE IS THE WORST KIND OF GREEN. It is stable, it looks
    // excellent, and it holds steady straight through a real regression. This release has already
    // had a seed silently produce zero chat rows for three of four tenants; a manifest that cannot
    // tell "cheap because it is well-indexed" from "cheap because there is nothing there" would have
    // certified that as a result. Two checks, deliberately separate:
    //   1. a module with rows on one tenant and NONE on another is a seeding defect, not a skew;
    //   2. a benchmark recorded as MEASURED on a tenant whose owning module holds no rows is a
    //      measurement of emptiness and is never allowed to stand as a pass.
    const populated = Object.entries(m.dataset ?? {}).filter(([, d]) => (d?.tenantRows ?? 0) > 0);
    const empty = Object.entries(m.dataset ?? {}).filter(([, d]) => (d?.tenantRows ?? 0) === 0);
    if (populated.length > 0 && empty.length > 0)
      warnings.push(
        `${m.id}: dataset holds rows on ${populated.map(([t]) => t).join("/")} but ZERO on ` +
          `${empty.map(([t]) => t).join("/")} — a seeding gap, not skew. Nothing can be measured for ` +
          `that tenant, so it shrinks coverage rather than producing a wrong number.`,
      );
    // The precise version of the same worry, and the one that is a hard failure: a benchmark whose
    // OWN subject table holds no rows for the tenant it was measured on. `tenantRows` is the
    // read-cost runner's own count over the budget's `rowCountSql`, so this is the benchmark's
    // actual subject, not a proxy.
    for (const b of m.benchmarks ?? [])
      for (const [tenant, obs] of Object.entries(b.measurements ?? {}))
        if (obs?.status === "measured" && obs.tenantRows === 0)
          v.push(
            `${m.id}/${b.id}@${tenant}: recorded as measured while its subject table holds 0 rows for ` +
              `that tenant — fast because the table is empty, not because the query is good`,
          );
    for (const [tenant, d] of Object.entries(m.dataset ?? {}))
      for (const e of d?.errors ?? [])
        v.push(`${m.id}: dataset could not be counted on ${tenant} (${e}) — an uncounted table cannot be a floor`);
    if (Array.isArray(m.concurrency?.runs) && m.concurrency.runs.length === 0)
      v.push(`${m.id}: no concurrency run recorded`);

    for (const b of m.benchmarks ?? []) {
      for (const f of REQUIRED_BENCHMARK_FIELDS)
        if (b[f] === undefined || b[f] === null) v.push(`${m.id}/${b.id ?? "<unnamed>"}: missing ${f}`);
      if (b.source === "read-cost-budgets.mjs" && knownReadCostIds && !knownReadCostIds.has(b.id))
        v.push(`${m.id}/${b.id}: no such read-cost budget — the benchmark measures nothing`);
      if (b.statementClass === "complex" && !b.approval)
        v.push(`${m.id}/${b.id}: claims the 200 ms complex ceiling with no approval reason`);
      if (b.statementClass === "ordinary" && b.approval)
        v.push(`${m.id}/${b.id}: an ordinary statement must not carry an approval`);
      if (typeof b.errorRate === "number" && b.errorRate > 0.5)
        v.push(`${m.id}/${b.id}: errored on ${Math.round(b.errorRate * 100)}% of tenants — not a measurement`);
    }
  }
  return v;
}

/** Per-benchmark ceiling outcome, per tenant. Vacuous never counts as measured. */
export function evaluateCeilings(manifest) {
  const measured = [];
  const unmeasured = [];
  const vacuous = [];
  const over = [];
  for (const m of manifest.modules) {
    for (const b of m.benchmarks) {
      if (b.statementClass === "reference") continue;
      for (const [tenant, obs] of Object.entries(b.measurements ?? {})) {
        const key = `${b.id}@${tenant}`;
        if (obs?.status === "vacuous") {
          vacuous.push(`${key}: query returned 0 rows — every ceiling is satisfied trivially`);
          continue;
        }
        if (obs?.status !== "measured" || typeof obs.p95Ms !== "number") {
          unmeasured.push(`${key}: ${obs?.reason ?? obs?.status ?? "absent"}`);
          continue;
        }
        measured.push(key);
        if (obs.p95Ms > b.ceilingMs)
          over.push(
            `${key}: ${b.statementClass} statement p95 ${obs.p95Ms} ms > ${b.ceilingMs} ms ceiling (${m.id})`,
          );
      }
    }
  }
  return { measured, unmeasured, vacuous, over };
}

/**
 * Database-statement counts carried over from ticket 22's route-budget manifest.
 *
 * Only a COUNTED figure is enforced. A ceiling whose basis is the manifest default is a placeholder,
 * and failing a build on a placeholder teaches everyone to ignore the gate; it is reported as
 * unarmed instead, with the route named, so the gap is visible rather than absent.
 */
export function evaluateDbCalls(manifest) {
  const armed = [];
  const unarmed = [];
  const breaches = [];
  for (const m of manifest.modules) {
    for (const b of m.benchmarks) {
      const r = b.dbCallRatchet;
      if (!r) continue;
      if (!r.armed) {
        unarmed.push(`${b.id}: ${r.reason}`);
        continue;
      }
      armed.push(`${b.id}`);
      if (r.breach)
        breaches.push(
          `${b.id} (${r.route}): ${r.measuredDbCalls} database statements > declared maxDbCalls ${r.ceiling}` +
            ` — counted through QueryTelemetryTracker, basis "${r.basis}"`,
        );
    }
  }
  return { armed, unarmed, breaches };
}

/**
 * The set of (benchmark, tenant) pairs the replicate study actually covered.
 *
 * A gate may only ratchet what its noise study measured. This is not pedantry — it is the rule that
 * caught a real false positive here: the three vector-ANN benchmarks issue a RANDOM query vector on
 * every run, so their k-nearest-neighbour result count legitimately differs between two runs of
 * identical code (10 rows then 11). They are driven by `measure-heavy-query-plans.mjs`, which runs
 * once rather than R times, so no replicate study ever saw them move — and an exact row-count
 * ratchet fired on all three. Their numbers are still recorded; they are simply not gated.
 */
export function ratchetedPairs(manifest) {
  const covered = new Map();
  const unstablePlans = new Set(
    (manifest.noiseStudy?.planShapeStability?.unstableIds ?? []).map((line) => line.split(":")[0].trim()),
  );
  const replicates = manifest.method?.replicates ?? null;
  for (const row of manifest.noiseStudy?.benchmarks ?? []) {
    const key = `${row.id}@${row.tenant}`;
    const stability = {};
    for (const metric of ["bufferBlocks", "resultRows", "scanRows", "planningBufferBlocks"])
      if (row[metric] && typeof row[metric].maxAbsSwing === "number")
        stability[metric] = { maxAbsSwing: row[metric].maxAbsSwing, replicates };
    stability.planSignature = { maxAbsSwing: unstablePlans.has(key) ? 1 : 0, replicates };
    covered.set(key, stability);
  }
  return covered;
}

/** Regression pass against a fresh measurement of the same shape. */
export function evaluateRegressions(manifest, fresh) {
  const policy = manifest.regressionPolicy;
  const covered = ratchetedPairs(manifest);
  const findings = [];
  const advisories = [];
  const unratcheted = [];
  let compared = 0;
  const freshIndex = new Map();
  for (const m of fresh.modules ?? []) for (const b of m.benchmarks ?? []) freshIndex.set(b.id, b);

  for (const m of manifest.modules) {
    for (const b of m.benchmarks) {
      const now = freshIndex.get(b.id);
      if (!now) {
        findings.push({ id: b.id, fired: true, detail: `benchmark "${b.id}" is missing from the fresh measurement` });
        continue;
      }
      for (const [tenant, base] of Object.entries(b.measurements ?? {})) {
        const obs = now.measurements?.[tenant];
        if (base?.status !== "measured" || obs?.status !== "measured") continue;
        const stability = covered.get(`${b.id}@${tenant}`);
        if (!stability) {
          unratcheted.push(`${b.id}@${tenant}`);
          continue;
        }
        compared++;
        const d = decideBenchmark({
          baseline: pickMetrics(base),
          observed: pickMetrics(obs),
          cv: b.cv ?? {},
          policy,
          stability,
        });
        for (const f of d.findings) {
          if (f.fired) findings.push({ id: `${b.id}@${tenant}`, module: m.id, metric: f.metric, fired: true, detail: f.detail });
          else if (f.verdict === "advisory" || f.verdict === "uncorroborated")
            advisories.push({ id: `${b.id}@${tenant}`, metric: f.metric, detail: f.detail });
        }
      }
    }
  }
  return { compared, findings, advisories, unratcheted };
}

export function pickMetrics(obs) {
  const out = {};
  for (const key of Object.keys(METRICS)) if (obs[key] !== undefined && obs[key] !== null) out[key] = obs[key];
  return out;
}

export function verdict({ violations, over, regressions, measured, declared }) {
  if (violations > 0 || over > 0 || regressions > 0) return "FAIL";
  if (measured === 0) return "INCONCLUSIVE";
  if (measured < declared) return "PARTIAL";
  return "OK";
}

/**
 * Is the recorded baseline still describing the code that is checked out?
 *
 * A benchmark manifest is a claim about a commit. Once HEAD moves past it, every number in it is a
 * statement about code nobody is running, and there is no way to tell from inside the file. This
 * answers it from git rather than from trust, and names the commits in between so the reader can see
 * whether any of them plausibly touched a measured path.
 */
export function stalenessAgainstHead(manifest, cwd) {
  const recorded = manifest.environment?.releaseSha;
  if (!recorded) return { known: false, reason: "the manifest records no release SHA" };
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    if (head === recorded) return { known: true, stale: false, head, recorded, commitsBehind: 0 };
    const behind = execFileSync("git", ["rev-list", "--count", `${recorded}..HEAD`], {
      cwd,
      encoding: "utf8",
    }).trim();
    const subjects = execFileSync("git", ["log", "--oneline", `${recorded}..HEAD`], {
      cwd,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);
    return { known: true, stale: true, head, recorded, commitsBehind: Number(behind), subjects };
  } catch (e) {
    return { known: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

function fraction(n, d) {
  return d === 0 ? "0/0 (0%)" : `${n}/${d} (${((n / d) * 100).toFixed(1)}%)`;
}

function report(manifest, fresh) {
  const knownReadCostIds = new Set(READ_COST_BUDGETS.map((b) => b.id));
  const warnings = [];
  const violations = validateManifest(manifest, knownReadCostIds, warnings);
  const ceilings = evaluateCeilings(manifest);
  const dbCalls = evaluateDbCalls(manifest);
  const regressions = fresh ? evaluateRegressions(manifest, fresh) : null;

  const modules = manifest.modules.length;
  const benchmarks = manifest.modules.reduce((n, m) => n + m.benchmarks.length, 0);
  const slots = ceilings.measured.length + ceilings.unmeasured.length + ceilings.vacuous.length;

  console.log(`Benchmark manifest — ${modules} modules, ${benchmarks} benchmarks`);
  console.log(
    `  release ${String(manifest.environment.releaseSha).slice(0, 8)} · ${manifest.environment.database.name}` +
      ` ${manifest.environment.database.sizeMb} MB · role ${manifest.environment.role.name}` +
      ` (bypassrls=${manifest.environment.role.bypassrls}) · ${manifest.environment.machine.cpuCount} cpu /` +
      ` ${manifest.environment.machine.totalMemoryMb} MB · container ${manifest.environment.container.containerised}`,
  );
  console.log(`  command: ${manifest.method.command}`);
  const staleness = stalenessAgainstHead(manifest, BACKEND_ROOT);
  if (!staleness.known) console.log(`  staleness: UNKNOWN — ${staleness.reason}`);
  else if (!staleness.stale) console.log(`  staleness: current — the manifest was measured at HEAD`);
  else {
    console.log(
      `  staleness: measured ${staleness.commitsBehind} commit(s) BEHIND HEAD` +
        ` (${staleness.recorded.slice(0, 8)} -> ${staleness.head.slice(0, 8)}).` +
        ` Every number below describes the older commit.`,
    );
    for (const line of staleness.subjects.slice(0, 8)) console.log(`    since: ${line}`);
    if (staleness.subjects.length > 8) console.log(`    … and ${staleness.subjects.length - 8} more`);
  }
  console.log(
    `  ${manifest.method.samples} samples · ${manifest.method.replicates} replicates ·` +
      ` concurrency ${manifest.method.concurrencyLevels.join(" and ")} ·` +
      ` tenants ${manifest.method.tenants.map((t) => t.label).join("/")}`,
  );
  console.log(
    `  statement ceilings measured: ${fraction(ceilings.measured.length, slots)} of benchmark×tenant slots` +
      ` · ${ceilings.vacuous.length} vacuous · ${ceilings.unmeasured.length} unmeasured`,
  );

  const policy = manifest.regressionPolicy;
  const planArmed = policy.exact?.planSignatureArmed !== false;
  const pairs = ratchetedPairs(manifest);
  const exactBuffers = [...pairs.values()].filter((st) => st.bufferBlocks?.maxAbsSwing === 0).length;
  const exactRows = [...pairs.values()].filter((st) => st.resultRows?.maxAbsSwing === 0).length;
  console.log(
    `  ratchets, per benchmark from its OWN replicate envelope:` +
      ` buffers exact on ${exactBuffers}/${pairs.size} pairs` +
      ` · rows exact on ${exactRows}/${pairs.size}` +
      ` · statement counts EXACT` +
      ` · plan shape ${planArmed ? "EXACT" : "DISARMED"}` +
      ` · timing ${policy.timing.armed ? `armed at +${(policy.timing.minRelTol * 100).toFixed(0)}%` : "DISARMED"}`,
  );
  console.log(
    `  a pair whose own metric moved during the study is NOT ratcheted on it, and never widens another` +
      ` pair's band. The global fallback (±max(${policy.deterministic.absTol},` +
      ` ${(policy.deterministic.relTol * 100).toFixed(0)}%)) applies only where no per-pair record exists,` +
      ` and such pairs are not ratcheted at all.`,
  );
  const planStability = manifest.noiseStudy?.planShapeStability;
  if (planStability)
    console.log(
      `  plan-shape stability: ${planStability.unstable} of ${planStability.pairs} benchmark×tenant pairs` +
        ` changed shape across replicates with no code change`,
    );
  if (!planArmed && policy.exact?.disarmedBecause)
    console.log(`  plan shape disarmed: ${policy.exact.disarmedBecause}`);
  console.log(`  policy provenance: ${policy.provenance}`);
  if (!policy.timing.armed && policy.timing.disarmedBecause)
    console.log(`  timing disarmed: ${policy.timing.disarmedBecause}`);
  const fp = manifest.noiseStudy?.falsePositives;
  if (fp)
    console.log(
      `  false-positive proof: ${fp.fired} of ${fp.comparisons} unchanged-code comparisons would have failed the gate` +
        ` (${((fp.rate ?? 0) * 100).toFixed(2)}%)`,
    );
  else console.log("  false-positive proof: NOT RUN — rerun the measurement with --replicates=3 or more");

  for (const m of manifest.modules) {
    const c = (m.concurrency.runs ?? []).filter((r) => r.status === "measured");
    const worstError = c.length === 0 ? null : Math.max(...c.map((r) => r.errorRate ?? 0));
    console.log(
      `  ${m.id.padEnd(20)} ${String(m.benchmarks.length).padStart(2)} benchmarks ·` +
        ` ${String(m.dataset.large.tenantRows).padStart(7)} rows (reference tenant) ·` +
        ` ${c.map((r) => `c${r.concurrency} p95 ${r.latency?.p95 ?? "?"}ms`).join(" / ") || "concurrency unmeasured"}` +
        ` · error rate ${worstError === null ? "n/a" : worstError}`,
    );
  }

  if (violations.length > 0) {
    console.error(`\n${violations.length} manifest violation(s):`);
    for (const x of violations) console.error(`  ${x}`);
  }
  if (warnings.length > 0) {
    console.log(`\n${warnings.length} seeding gap(s) — coverage lost, no wrong number produced:`);
    for (const x of warnings) console.log(`  ${x}`);
  }
  console.log(
    `  database-statement ratchet: ${fraction(dbCalls.armed.length, dbCalls.armed.length + dbCalls.unarmed.length)}` +
      ` of linked read paths have a COUNTED statement figure; the rest declare a ceiling nothing has counted`,
  );

  if (dbCalls.breaches.length > 0) {
    console.error(`\n${dbCalls.breaches.length} measured database-statement breach(es):`);
    for (const x of dbCalls.breaches) console.error(`  ${x}`);
  }
  if (ceilings.over.length > 0) {
    console.error(`\n${ceilings.over.length} statement(s) over their PRD §12.1 ceiling:`);
    for (const x of ceilings.over) console.error(`  ${x}`);
    console.error(
      "  Raising a ceiling to turn one of these green is itself a defect. Fix the statement, or move " +
        "the ceiling deliberately with a reason recorded beside it.",
    );
  }
  if (ceilings.vacuous.length > 0) {
    console.log(`\n${ceilings.vacuous.length} vacuous benchmark(s) — measured nothing, counted as unmeasured:`);
    for (const x of ceilings.vacuous.slice(0, 12)) console.log(`  ${x}`);
    if (ceilings.vacuous.length > 12) console.log(`  … and ${ceilings.vacuous.length - 12} more`);
  }
  if (regressions) {
    console.log(
      `\nRegression pass: ${regressions.compared} benchmark×tenant comparisons against the recorded baseline` +
        ` · ${regressions.unratcheted.length} pair(s) recorded but NOT ratcheted, because the replicate study` +
        ` never covered them and a gate may only ratchet what its noise study measured.`,
    );
    if (regressions.findings.length > 0) {
      console.error(`${regressions.findings.length} REGRESSION(S):`);
      for (const f of regressions.findings) console.error(`  ${f.id} [${f.metric ?? "structure"}] ${f.detail}`);
    } else console.log("  no ratcheted metric moved.");
    if (regressions.advisories.length > 0) {
      console.log(`  ${regressions.advisories.length} advisory timing movement(s), not failing the build:`);
      for (const a of regressions.advisories.slice(0, 8)) console.log(`    ${a.id} ${a.detail}`);
      if (regressions.advisories.length > 8) console.log(`    … and ${regressions.advisories.length - 8} more`);
    }
  } else {
    console.log("\nRegression pass: NOT RUN — pass --against=<fresh measurement json> to ratchet.");
  }

  const notMeasured = manifest.coverage?.notMeasured ?? [];
  if (notMeasured.length > 0) {
    console.log("\nNOT MEASURED (declared as such, never inferred from a proxy):");
    for (const x of notMeasured) console.log(`  - ${x}`);
  }

  const status = verdict({
    violations: violations.length,
    over: ceilings.over.length + dbCalls.breaches.length,
    regressions: regressions?.findings.length ?? 0,
    measured: ceilings.measured.length,
    declared: slots,
  });
  console.log(`\nSTATUS: ${status} — ${fraction(ceilings.measured.length, slots)} of statement ceilings measured.`);
  return { status, violations, ceilings, dbCalls, regressions };
}

function selfTest() {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push(ok);
    console.log(`  ${ok ? "[pass]" : "[FAIL]"} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  const base = () => ({
    environment: {
      releaseSha: "abc",
      machine: { cpuCount: 8, totalMemoryMb: 1024 },
      container: { containerised: false },
      database: { name: "scratch_x", sizeMb: 1 },
      role: { name: "streamline_app", bypassrls: false },
    },
    method: { command: "node x", reproduce: "…", samples: 200, replicates: 3, concurrencyLevels: [1, 8], tenants: [{ label: "large" }] },
    regressionPolicy: {
      deterministic: { relTol: 0, absTol: 0 },
      timing: { k: 3, minRelTol: 2.33, absFloorMs: 1, hardMultiple: 2, corroborationRequired: true, armed: false, disarmedBecause: "noise" },
      provenance: "test",
    },
    coverage: { notMeasured: [] },
    noiseStudy: {
      benchmarks: [
        {
          id: "org-members-list",
          tenant: "large",
          bufferBlocks: { maxAbsSwing: 0 },
          resultRows: { maxAbsSwing: 0 },
        },
      ],
    },
    modules: [
      {
        id: "m",
        title: "M",
        surface: "s",
        tables: ["t"],
        dataset: { large: { tenantRows: 10 } },
        concurrency: { runs: [{ status: "measured", concurrency: 1, errorRate: 0, latency: { p95: 1 } }] },
        benchmarks: [
          {
            id: "org-members-list",
            source: "read-cost-budgets.mjs",
            statementClass: "ordinary",
            approval: null,
            ceilingMs: 50,
            repetitions: 200,
            warmState: "warm",
            errorRate: 0,
            measurements: { large: { status: "measured", bufferBlocks: 100, resultRows: 50, p95Ms: 5 } },
          },
        ],
      },
    ],
  });
  const ids = new Set(READ_COST_BUDGETS.map((b) => b.id));

  check("a well-formed manifest has no violations", validateManifest(base(), ids).length === 0);

  const noCommand = base();
  noCommand.method.command = null;
  check(
    "a manifest that does not record the command that produced it is a violation",
    validateManifest(noCommand, ids).some((x) => x.includes("method.command")),
  );

  const noSha = base();
  noSha.environment.releaseSha = null;
  check("a manifest with no release SHA is a violation", validateManifest(noSha, ids).some((x) => x.includes("releaseSha")));

  const asOwner = base();
  asOwner.environment.role = { name: "neondb_owner", bypassrls: true };
  check(
    "a manifest measured as a BYPASSRLS role is rejected outright",
    validateManifest(asOwner, ids).some((x) => x.includes("BYPASSRLS")),
  );

  const ghost = base();
  ghost.modules[0].benchmarks[0].id = "not-a-real-budget";
  check(
    "a benchmark that resolves to no catalog entry is a violation",
    validateManifest(ghost, ids).some((x) => x.includes("no such read-cost budget")),
  );

  const unapproved = base();
  unapproved.modules[0].benchmarks[0].statementClass = "complex";
  check(
    "a complex statement with no approval cannot claim the looser ceiling",
    validateManifest(unapproved, ids).some((x) => x.includes("no approval reason")),
  );

  const emptyDataset = base();
  emptyDataset.modules[0].dataset = { large: { tenantRows: 0 } };
  check(
    "a module whose dataset is empty on every tenant is a violation",
    validateManifest(emptyDataset, ids).some((x) => x.includes("zero rows")),
  );

  const skewedEmpty = base();
  skewedEmpty.modules[0].dataset = { large: { tenantRows: 10 }, small: { tenantRows: 0 } };
  const skewWarnings = [];
  check(
    "a module with rows on one tenant and none on another is reported as a seeding gap",
    validateManifest(skewedEmpty, ids, skewWarnings).length === 0 &&
      skewWarnings.some((x) => x.includes("seeding gap")),
    "it loses coverage; it does not produce a wrong number, so it is a warning not a failure",
  );

  const measuredOverEmpty = base();
  measuredOverEmpty.modules[0].benchmarks[0].measurements.large.tenantRows = 0;
  check(
    "a benchmark measured over its own EMPTY subject table is a hard failure",
    validateManifest(measuredOverEmpty, ids).some((x) => x.includes("fast because the table is empty")),
  );

  const uncountable = base();
  uncountable.modules[0].dataset = { large: { tenantRows: 10, errors: ["chat_messages: permission denied"] } };
  check(
    "a table the harness could not count is a violation, not a silent zero",
    validateManifest(uncountable, ids).some((x) => x.includes("uncounted table cannot be a floor")),
  );

  const noShaManifest = base();
  noShaManifest.environment.releaseSha = null;
  check(
    "staleness is UNKNOWN rather than assumed current when there is no SHA",
    stalenessAgainstHead(noShaManifest, BACKEND_ROOT).known === false,
  );
  const headSha = (() => {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], { cwd: BACKEND_ROOT, encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  })();
  if (headSha) {
    const atHead = base();
    atHead.environment.releaseSha = headSha;
    check("a manifest measured at HEAD reports current", stalenessAgainstHead(atHead, BACKEND_ROOT).stale === false);
  }

  const over = base();
  over.modules[0].benchmarks[0].measurements.large.p95Ms = 80;
  check("a statement over its class ceiling is reported over", evaluateCeilings(over).over.length === 1);

  const vac = base();
  vac.modules[0].benchmarks[0].measurements.large = { status: "vacuous", resultRows: 0 };
  const vacResult = evaluateCeilings(vac);
  check(
    "a vacuous benchmark is counted as unmeasured, never as a pass",
    vacResult.vacuous.length === 1 && vacResult.measured.length === 0,
  );

  const m = base();
  const clone = JSON.parse(JSON.stringify(m));
  check(
    "an identical rerun produces no regression",
    evaluateRegressions(m, clone).findings.length === 0,
  );

  const perBenchmark = base();
  perBenchmark.noiseStudy = {
    benchmarks: [{ id: "org-members-list", tenant: "large", bufferBlocks: { maxAbsSwing: 0 }, resultRows: { maxAbsSwing: 3 } }],
  };
  perBenchmark.regressionPolicy.deterministic = { relTol: 191, absTol: 2314 };
  const perFresh = JSON.parse(JSON.stringify(perBenchmark));
  perFresh.modules[0].benchmarks[0].measurements.large.bufferBlocks = 101;
  perFresh.modules[0].benchmarks[0].measurements.large.resultRows = 900;
  const perResult = evaluateRegressions(perBenchmark, perFresh);
  check(
    "one wobbly benchmark's instability does not widen a stable benchmark's band",
    perResult.findings.length === 1 && perResult.findings[0].metric === "bufferBlocks",
    "buffers fire at +1 despite a 2,314-block global fallback; rows do not, because rows moved on their own",
  );

  const outsideStudy = base();
  outsideStudy.noiseStudy = { benchmarks: [] };
  const outsideFresh = JSON.parse(JSON.stringify(outsideStudy));
  outsideFresh.modules[0].benchmarks[0].measurements.large.bufferBlocks = 99999;
  const outsideResult = evaluateRegressions(outsideStudy, outsideFresh);
  check(
    "a benchmark the replicate study never covered is recorded but never ratcheted",
    outsideResult.findings.length === 0 && outsideResult.unratcheted.length === 1,
    "the vector-ANN benchmarks re-randomise their query vector every run",
  );

  const worseBuffers = JSON.parse(JSON.stringify(m));
  worseBuffers.modules[0].benchmarks[0].measurements.large.bufferBlocks = 101;
  const bufferFindings = evaluateRegressions(m, worseBuffers).findings;
  check(
    "one extra buffer block fires — the ratchet is exact because the replicate study measured zero swing",
    bufferFindings.length === 1 && bufferFindings[0].metric === "bufferBlocks",
  );

  const slower = JSON.parse(JSON.stringify(m));
  slower.modules[0].benchmarks[0].measurements.large.p95Ms = 500;
  const slowResult = evaluateRegressions(m, slower);
  check(
    "a 100× wall-clock movement does NOT fail the build while timing is disarmed",
    slowResult.findings.length === 0 && slowResult.advisories.length === 1,
    "and it is still printed",
  );

  const missing = JSON.parse(JSON.stringify(m));
  missing.modules[0].benchmarks = [];
  check(
    "a benchmark deleted from the fresh run is a regression, not silent coverage loss",
    evaluateRegressions(m, missing).findings.length === 1,
  );

  const counted = base();
  counted.modules[0].benchmarks[0].dbCallRatchet = { armed: true, measuredDbCalls: 5, ceiling: 3, breach: true, route: "GET /x", basis: "declared-estimate" };
  check(
    "a counted database-statement count above its ceiling is a breach and fails the gate",
    evaluateDbCalls(counted).breaches.length === 1,
  );
  const placeholder = base();
  placeholder.modules[0].benchmarks[0].dbCallRatchet = { armed: false, reason: "nothing has counted it" };
  const ph = evaluateDbCalls(placeholder);
  check(
    "a DEFAULT ceiling nobody counted is reported unarmed, never failed on",
    ph.breaches.length === 0 && ph.unarmed.length === 1,
  );

  check("verdict cannot be OK with an unmeasured slot", verdict({ violations: 0, over: 0, regressions: 0, measured: 3, declared: 5 }) === "PARTIAL");
  check("verdict is FAIL on a ceiling breach", verdict({ violations: 0, over: 1, regressions: 0, measured: 5, declared: 5 }) === "FAIL");
  check("verdict is FAIL on a regression", verdict({ violations: 0, over: 0, regressions: 1, measured: 5, declared: 5 }) === "FAIL");
  check("verdict is INCONCLUSIVE when nothing was measured", verdict({ violations: 0, over: 0, regressions: 0, measured: 0, declared: 5 }) === "INCONCLUSIVE");
  check("verdict is OK only when everything is measured and clean", verdict({ violations: 0, over: 0, regressions: 0, measured: 5, declared: 5 }) === "OK");

  const ok = results.every(Boolean);
  console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
  return ok;
}

function main() {
  if (SELF_TEST) {
    console.log("check-benchmark-manifest self-test\n");
    process.exit(selfTest() ? 0 : 1);
  }
  if (!existsSync(MANIFEST_PATH)) {
    console.error(`No benchmark manifest at ${MANIFEST_PATH}.`);
    console.error("Produce one: APP_DATABASE_URL=<app role on a scratch seed> node test/perf/measure-benchmark-manifest.mjs --write");
    process.exit(2);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  } catch (e) {
    console.error(`Benchmark manifest is unreadable: ${e.message}`);
    process.exit(2);
  }
  let fresh = null;
  if (AGAINST) {
    if (!existsSync(AGAINST)) {
      console.error(`--against=${AGAINST} does not exist`);
      process.exit(2);
    }
    fresh = JSON.parse(readFileSync(AGAINST, "utf8"));
  }

  const { status, violations, ceilings, dbCalls, regressions } = report(manifest, fresh);
  if (STRICT && status !== "OK") process.exit(2);
  const failed =
    violations.length > 0 ||
    ceilings.over.length > 0 ||
    dbCalls.breaches.length > 0 ||
    (regressions?.findings.length ?? 0) > 0;
  process.exit(failed ? 1 : 0);
}

// Guarded, so the exported decision functions can be imported — by a future spec, or to reproduce a
// verdict — without the import itself running the CLI and exiting the process.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
