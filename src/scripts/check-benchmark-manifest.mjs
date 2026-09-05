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
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUDGETS as READ_COST_BUDGETS } from "./read-cost-budgets.mjs";
import { METRICS, TIMING_ARM_THRESHOLD, decideBenchmark } from "./benchmark-regression.mjs";
import { evaluateRequestRegressions } from "./request-benchmark-regression.mjs";

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
 * The request-level half — the four ceilings a statement can never answer.
 *
 * `evaluateCeilings` above scores STATEMENTS: 50 ms ordinary, 200 ms complex, measured with
 * `EXPLAIN (ANALYZE, BUFFERS)` on a loopback connection. The PRD's other pair of ceilings —
 * 300 ms ordinary, 800 ms complex — are REQUEST-level, and a request additionally pays for
 * authentication, permission resolution, module entitlement, serialisation and the Nest pipeline.
 * Two earlier passes on this ticket refused to write a 5 ms statement into a 300 ms end-to-end
 * ceiling, and they were right to; this scores the thing the ceiling is about instead.
 *
 * It fails on three classes, and keeps them distinct because conflating them is how a gate becomes
 * an alarm:
 *
 *   violation      the capture cannot be trusted at all — a tenant whose control probe did not
 *                  hold, a route recorded as measured with no latency, a heap figure taken with
 *                  no forced collection, or a run recorded against a BYPASSRLS role.
 *   over ceiling   a scored route's p95 above its PRD class ceiling.
 *   breach         a measured figure above the ceiling `contracts/route-budgets.json` DECLARES for
 *                  it — latency, downstream calls, response bytes or resident heap. These are the
 *                  four dimensions box 2 names, and they are the reason this instrument exists.
 */
export function evaluateRequestLevel(manifest) {
  const rl = manifest.requestLevel;
  if (!rl)
    return {
      present: false,
      violations: [],
      over: [],
      breaches: [],
      measured: 0,
      refused: 0,
      failed: 0,
      excluded: 0,
      total: 0,
      warnings: [],
    };

  const violations = [];
  const warnings = [];
  const over = [];
  const breaches = [];

  for (const t of rl.tenants ?? [])
    if (t.scorable !== true)
      violations.push(
        `request-level capture on tenant ${t.tenant} (${t.profile}) is not scorable: ${t.notScorableBecause ?? "unstated"}` +
          " — refusing to score a run whose control requests did not succeed",
      );
  if ((rl.tenants ?? []).length === 0) violations.push("requestLevel records no tenant at all");
  if (typeof rl.role !== "string" || rl.role.length === 0)
    violations.push("requestLevel records no database role — a request measured as the owner hides the RLS predicate");
  else if (/bypassrls\s*=\s*true/i.test(rl.role))
    violations.push(`requestLevel was captured as a BYPASSRLS role (${rl.role}) — its plans omit the RLS predicate`);
  if (typeof rl.command !== "string" || rl.command.length === 0)
    violations.push("requestLevel records no command — a percentile with no reproduction is not evidence");

  const rows = Object.entries(rl.routes ?? {});
  let measured = 0;
  let refused = 0;
  let failed = 0;
  let excluded = 0;

  for (const [key, r] of rows) {
    if (r.status !== "measured") {
      if (r.status === "failed") failed += 1;
      else refused += 1;
      continue;
    }
    measured += 1;
    if (r.scored !== true) excluded += 1;
    const p95 = r.latencyMs?.p95;
    if (typeof p95 !== "number") {
      violations.push(`${key}: recorded as measured with no p95 — an absent number is not a measurement`);
      continue;
    }
    if (r.memoryMb !== null && r.memoryMb !== undefined && rl.gcAvailable !== true)
      violations.push(
        `${key}: carries a heap figure while the capture ran without --expose-gc — a heap read with no ` +
          "forced collection is the previous request's residue, not this route's cost",
      );
    if (r.scored === true && p95 > r.prdCeilingMs)
      over.push(`${key}: request p95 ${p95} ms > ${r.prdCeilingMs} ms PRD §12.1 ceiling (${r.routeClass})`);

    const dims = [
      ["request p95", p95, r.declaredLatencyP95Ms, "ms"],
      ["downstream calls", r.downstreamCalls, r.declaredDownstreamCalls, ""],
      ["response bytes", r.responseBytes, r.declaredResponseBytes, " bytes"],
      ["resident heap", r.memoryMb, r.declaredMemoryMb, " MB"],
    ];
    for (const [label, actual, ceiling, unit] of dims) {
      if (typeof actual !== "number" || typeof ceiling !== "number") continue;
      if (actual > ceiling)
        breaches.push(`${key}: ${label} ${actual}${unit} > declared ${ceiling}${unit} in contracts/route-budgets.json`);
    }
  }

  if (rl.atHead !== true)
    warnings.push(
      `the request-level capture ran on ${String(rl.database)} at ${String(rl.appliedMigrations)} of ` +
        `${String(rl.journalEntries)} journal entries — NOT at head, so these numbers describe the plans ` +
        "available without the missing migration(s)",
    );
  if (rl.readOnly === true)
    warnings.push(
      "the request-level capture was READ-ONLY: the plan's write entries were declined rather than " +
        "measured, so no mutation has a request-level number",
    );
  if (rl.workingTreeDirty === true)
    warnings.push(`the request-level capture ran on a DIRTY working tree at ${String(rl.commit).slice(0, 8)}`);

  return { present: true, violations, warnings, over, breaches, measured, refused, failed, excluded, total: rows.length };
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
    if (typeof row.p95Ms?.maxRelSwing === "number") {
      const swing = row.p95Ms.maxRelSwing;
      stability.timingArmed = swing <= TIMING_ARM_THRESHOLD;
      if (!stability.timingArmed)
        stability.timingDisarmedBecause =
          `unchanged-code p95 moved ${(swing * 100).toFixed(0)}% on this benchmark across ` +
          `${replicates ?? "the"} replicates (>${(TIMING_ARM_THRESHOLD * 100).toFixed(0)}% arming threshold)`;
    }
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

/**
 * Staleness by COMMIT is not enough, because the SQL this manifest measures lives in another
 * ticket's catalog and is routinely edited without a commit. Measured on this machine: the release
 * SHA read "2 commits behind" while eight read-cost entries had already changed shape in the working
 * tree — so the SHA said "nearly current" about numbers that described statements the file no longer
 * held.
 *
 * The manifest therefore records a content digest of each catalog it measured, and this re-hashes
 * the same files on disk. A digest mismatch means the subject moved under the measurement; it is a
 * warning rather than a violation, because the honest response is to re-capture, and failing the
 * build on another ticket's in-flight edit would teach people to ignore the gate.
 */
export function subjectDrift(manifest, cwd) {
  const recorded = manifest.environment?.subject;
  if (!recorded?.digests)
    return {
      known: false,
      reason:
        "this manifest predates subject-content stamping, so it cannot say whether the SQL it " +
        "measured is still the SQL on disk — re-capture to gain the check",
    };
  const drifted = [];
  for (const [file, digest] of Object.entries(recorded.digests)) {
    let now = null;
    try {
      now = createHash("sha256").update(readFileSync(join(cwd, file))).digest("hex").slice(0, 16);
    } catch {
      now = null;
    }
    if (now !== digest) drifted.push({ file, recorded: digest, onDisk: now });
  }
  return {
    known: true,
    drifted,
    uncommittedAtCapture: recorded.uncommittedAtCapture ?? null,
  };
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
  const requestLevel = evaluateRequestLevel(manifest);
  violations.push(...requestLevel.violations);
  warnings.push(...requestLevel.warnings);
  const regressions = fresh ? evaluateRegressions(manifest, fresh) : null;
  const freshRl = fresh ? evaluateRequestLevel(fresh) : null;
  if (fresh) {
    const requests = evaluateRequestRegressions(manifest, fresh);
    regressions.findings.push(...requests.findings);
    regressions.advisories.push(...requests.advisories);
    console.log(`Request regression pass: ${requests.compared} route/profile comparisons`);
    violations.push(...freshRl.violations);
    warnings.push(...freshRl.warnings);
  } else if (STRICT) {
    violations.push("Strict release verification requires --against=<fresh manifest> for request and SQL regression comparisons");
  }

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
  const drift = subjectDrift(manifest, BACKEND_ROOT);
  if (!drift.known) console.log(`  subject: UNKNOWN — ${drift.reason}`);
  else if (drift.drifted.length === 0) {
    console.log(`  subject: the measured SQL catalogs are byte-identical to the ones on disk`);
    if (drift.uncommittedAtCapture?.length)
      warnings.push(
        `measured against an UNCOMMITTED catalog (${drift.uncommittedAtCapture.join(", ")}) — the ` +
          `numbers describe the working tree, not release ${String(manifest.environment.releaseSha).slice(0, 8)}`,
      );
  } else {
    console.log(
      `  subject: DRIFTED — ${drift.drifted.length} measured SQL catalog(s) changed on disk since capture. ` +
        `Every number below may describe a statement the file no longer holds.`,
    );
    for (const d of drift.drifted) console.log(`    changed: ${d.file} (${d.recorded} -> ${d.onDisk ?? "missing"})`);
    warnings.push(
      `the measured SQL catalog(s) ${drift.drifted.map((d) => d.file).join(", ")} changed on disk ` +
        `since capture — re-capture before trusting any number here`,
    );
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
    const dimMap = [
      ["latency", ["p50Ms", "p95Ms", "p99Ms", "p50", "p95", "p99"]],
      ["db-calls", ["measuredDbCalls", "requestDbCalls"]],
      ["downstream-calls", ["downstreamCalls", "deferredDownstreamCalls"]],
      ["buffers", ["bufferBlocks", "planningBufferBlocks"]],
      ["rows", ["resultRows", "scanRows"]],
      ["payload-size", ["responseBytes"]],
      ["memory", ["memoryMb"]],
    ];
    console.log(`  Dimension summary (${regressions.compared} benchmark×tenant pairs compared):`);
    for (const [dim, metrics] of dimMap) {
      const regs = regressions.findings.filter((f) => metrics.includes(f.metric)).length;
      const adv = regressions.advisories.filter((a) => metrics.includes(a.metric));
      const disarmed = adv.filter((a) => a.detail.includes("DISARMED"));
      const regLabel = regs > 0 ? `${regs} REGRESSION(S)` : "0 regressions";
      const advLabel = adv.length > 0 ? ` · ${adv.length} advisory (${disarmed.length} disarmed)` : "";
      console.log(`    ${dim.padEnd(18)} ${regLabel}${advLabel}`);
      if (disarmed.length > 0) {
        const reasons = [...new Set(disarmed.slice(0, 2).map((a) => a.detail.split(": ").slice(1).join(": ")))];
        for (const r of reasons) console.log(`      disarmed: ${r.slice(0, 120)}`);
      }
    }
  } else {
    console.log("\nRegression pass: NOT RUN — pass --against=<fresh measurement json> to ratchet.");
  }

  if (!requestLevel.present)
    console.log(
      "\nRequest level: NOT MEASURED — no `requestLevel` block. The 300 ms / 800 ms PRD ceilings are " +
        "request-level and nothing here has timed a route over HTTP.",
    );
  else {
    console.log(
      `\nRequest level (${manifest.requestLevel.method}, ${String(manifest.requestLevel.database)}` +
        `${manifest.requestLevel.atHead === true ? ", at head" : ", NOT at head"}): ` +
        `${fraction(requestLevel.measured, requestLevel.total)} of route×tenant slots measured · ` +
        `${requestLevel.refused} refused · ${requestLevel.failed} failed · ` +
        `${requestLevel.excluded} recorded but excluded from the request ceiling.`,
    );
    console.log(`  ${manifest.requestLevel.cache}`);
    console.log(`  ${manifest.requestLevel.memoryNote}`);
    for (const t of manifest.requestLevel.tenants ?? [])
      console.log(
        `  tenant ${t.profile}: control probe ${t.controlBeforeOk && t.controlAfterOk ? "HELD" : "FAILED"}` +
          ` (anonymous ${String(t.anonymousControlStatus)}) · subject ${t.subjectStable ? "STABLE" : "DRIFTED"}` +
          ` ${String(t.subjectHashBefore)} -> ${String(t.subjectHashAfter)}` +
          `${t.subjectStable && t.subjectHashBefore !== t.subjectHashAfter ? " (the hash moved only on tables the harness itself declares it writes)" : ""}`,
      );
    const reasons = Object.entries(manifest.requestLevel.tally?.refusalsByReason ?? {}).sort((a, b) => b[1] - a[1]);
    if (reasons.length > 0) {
      console.log(`  refusals, by reason:`);
      for (const [reason, n] of reasons.slice(0, 8)) console.log(`    ${String(n).padStart(3)}  ${reason}`);
      if (reasons.length > 8) console.log(`    … and ${reasons.length - 8} more reasons`);
    }
    if (requestLevel.over.length > 0) {
      console.error(`  ${requestLevel.over.length} route(s) OVER the PRD request ceiling:`);
      for (const x of requestLevel.over) console.error(`    ${x}`);
    } else console.log("  no scored route is over its PRD request ceiling.");
    if (requestLevel.breaches.length > 0) {
      console.error(`  ${requestLevel.breaches.length} DECLARED BUDGET BREACH(ES):`);
      for (const x of requestLevel.breaches) console.error(`    ${x}`);
      console.error(
        "    These are measured figures above a ceiling the contract already declares. Raising the " +
          "ceiling to turn one green is itself a defect.",
      );
    } else console.log("  no measured figure is above its declared route budget.");
  }

  const notMeasured = manifest.coverage?.notMeasured ?? [];
  if (notMeasured.length > 0) {
    console.log("\nNOT MEASURED (declared as such, never inferred from a proxy):");
    for (const x of notMeasured) console.log(`  - ${x}`);
  }

  const status = verdict({
    violations: violations.length,
    over: ceilings.over.length + dbCalls.breaches.length + requestLevel.over.length + requestLevel.breaches.length + (freshRl?.over.length ?? 0) + (freshRl?.breaches.length ?? 0),
    regressions: regressions?.findings.length ?? 0,
    measured: ceilings.measured.length,
    declared: slots,
  });
  console.log(
    `\nSTATUS: ${status} — ${fraction(ceilings.measured.length, slots)} of statement ceilings measured, ` +
      `${fraction(requestLevel.measured, requestLevel.total)} of request-level slots measured.`,
  );
  return { status, violations, ceilings, dbCalls, requestLevel, regressions };
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

  // Subject drift: the SQL this manifest measures lives in another ticket's catalog, which is edited
  // in the working tree without a commit. A release SHA cannot see that; a content digest can.
  {
    const noSubject = base();
    check(
      "a manifest with no subject digests says UNKNOWN rather than claiming its SQL is current",
      subjectDrift(noSubject, BACKEND_ROOT).known === false,
    );
    const realFile = "src/scripts/read-cost-budgets.mjs";
    const realDigest = createHash("sha256")
      .update(readFileSync(join(BACKEND_ROOT, realFile)))
      .digest("hex")
      .slice(0, 16);
    const matched = base();
    matched.environment.subject = { digests: { [realFile]: realDigest }, uncommittedAtCapture: [] };
    check(
      "a manifest whose recorded digest matches the file on disk reports no drift",
      subjectDrift(matched, BACKEND_ROOT).drifted.length === 0,
    );
    const moved = base();
    moved.environment.subject = { digests: { [realFile]: "0000000000000000" }, uncommittedAtCapture: [] };
    const d = subjectDrift(moved, BACKEND_ROOT);
    check(
      "a measured SQL catalog edited since capture is reported as DRIFTED, named, with both digests",
      d.drifted.length === 1 && d.drifted[0].file === realFile && d.drifted[0].onDisk === realDigest,
    );
    const missing = base();
    missing.environment.subject = { digests: { "src/scripts/no-such-catalog.mjs": "abc" }, uncommittedAtCapture: [] };
    check(
      "a measured catalog that has been DELETED is drift, not a silent pass",
      subjectDrift(missing, BACKEND_ROOT).drifted[0]?.onDisk === null,
    );
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

  const perBenchmarkTiming = base();
  perBenchmarkTiming.noiseStudy = {
    benchmarks: [{
      id: "org-members-list", tenant: "large",
      bufferBlocks: { maxAbsSwing: 0 }, resultRows: { maxAbsSwing: 0 },
      p95Ms: { maxRelSwing: 0.08 },
    }],
  };
  perBenchmarkTiming.regressionPolicy.timing.armed = false;
  const ptFresh = JSON.parse(JSON.stringify(perBenchmarkTiming));
  ptFresh.modules[0].benchmarks[0].measurements.large.bufferBlocks = 101;
  ptFresh.modules[0].benchmarks[0].measurements.large.p95Ms = 50;
  const ptResult = evaluateRegressions(perBenchmarkTiming, ptFresh);
  check(
    "per-benchmark timing: a quiet per-benchmark envelope (8%) arms timing even when global policy is disarmed",
    ptResult.findings.some((f) => f.metric === "p95Ms"),
    "buffers fire (exact zero swing) and p95 fires (own envelope quiet, corroborated)",
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

  // --- the request-level half -------------------------------------------------------------
  const rlBase = () => ({
    requestLevel: {
      method: "http-harness",
      command: "node … jest --testPathPattern=route-budget-http",
      role: "streamline_app (rolbypassrls = false, RLS live)",
      database: "scratch_x",
      atHead: true,
      readOnly: false,
      workingTreeDirty: false,
      gcAvailable: true,
      tenants: [{ tenant: "org", profile: "reference", scorable: true, controlBeforeOk: true, controlAfterOk: true, subjectStable: true }],
      routes: {
        "GET /a@reference": {
          route: "GET /a", profile: "reference", routeClass: "list", status: "measured", scored: true,
          prdCeilingMs: 300, declaredLatencyP95Ms: 400, declaredDownstreamCalls: 0,
          declaredResponseBytes: 1000, declaredMemoryMb: 8,
          latencyMs: { p50: 1, p95: 10, p99: 12, min: 1, max: 20 },
          requestDbCalls: 6, downstreamCalls: 0, responseBytes: 100, memoryMb: 1, overPrdCeiling: false,
        },
      },
    },
  });

  check("a manifest with no requestLevel reports it as not measured, not as a pass", evaluateRequestLevel({}).present === false);
  check("a clean request-level capture raises nothing", (() => {
    const r = evaluateRequestLevel(rlBase());
    return r.violations.length === 0 && r.over.length === 0 && r.breaches.length === 0 && r.measured === 1;
  })());

  const unscorable = rlBase();
  unscorable.requestLevel.tenants[0].scorable = false;
  unscorable.requestLevel.tenants[0].notScorableBecause = "the opening control probe did not hold";
  check(
    "a tenant whose control probe did not hold is a VIOLATION — refusing to score the run",
    evaluateRequestLevel(unscorable).violations.length === 1,
  );

  const bypass = rlBase();
  bypass.requestLevel.role = "postgres (rolbypassrls = true)";
  check("a request-level capture as a BYPASSRLS role is rejected", evaluateRequestLevel(bypass).violations.length === 1);

  const rlNoCommand = rlBase();
  delete rlNoCommand.requestLevel.command;
  check("a request-level capture with no command is rejected", evaluateRequestLevel(rlNoCommand).violations.length === 1);

  const noP95 = rlBase();
  noP95.requestLevel.routes["GET /a@reference"].latencyMs = null;
  check("a route recorded as measured with no p95 is a violation", evaluateRequestLevel(noP95).violations.length === 1);

  const noGc = rlBase();
  noGc.requestLevel.gcAvailable = false;
  check(
    "a heap figure taken without a forced collection is a violation, not a measurement",
    evaluateRequestLevel(noGc).violations.some((v) => v.includes("forced collection")),
  );

  const slow = rlBase();
  slow.requestLevel.routes["GET /a@reference"].latencyMs.p95 = 301;
  check("an ordinary route over 300 ms fails the PRD request ceiling", evaluateRequestLevel(slow).over.length === 1);

  const complex = rlBase();
  complex.requestLevel.routes["GET /a@reference"].scored = true;
  complex.requestLevel.routes["GET /a@reference"].prdCeilingMs = 800;
  complex.requestLevel.routes["GET /a@reference"].latencyMs.p95 = 301;
  check("an approved complex aggregate at 301 ms does NOT fail — it has the looser ceiling", evaluateRequestLevel(complex).over.length === 0);

  const sweep = rlBase();
  sweep.requestLevel.routes["GET /a@reference"].scored = false;
  sweep.requestLevel.routes["GET /a@reference"].latencyMs.p95 = 5000;
  const sweepResult = evaluateRequestLevel(sweep);
  check(
    "an excluded sweep at 5 s is recorded and NOT scored, and counted as excluded",
    sweepResult.over.length === 0 && sweepResult.excluded === 1,
  );

  for (const [field, value, label] of [
    ["responseBytes", 2000, "response bytes"],
    ["downstreamCalls", 1, "downstream calls"],
    ["memoryMb", 99, "resident heap"],
  ]) {
    const breached = rlBase();
    breached.requestLevel.routes["GET /a@reference"][field] = value;
    check(`a ${label} figure above its declared route budget is a breach`, evaluateRequestLevel(breached).breaches.length === 1);
  }

  const notHead = rlBase();
  notHead.requestLevel.atHead = false;
  check("a capture that is not at journal head warns rather than passing silently", evaluateRequestLevel(notHead).warnings.length === 1);

  const readOnly = rlBase();
  readOnly.requestLevel.readOnly = true;
  check(
    "a read-only capture says out loud that no mutation has a request-level number",
    evaluateRequestLevel(readOnly).warnings.some((w) => w.includes("READ-ONLY")),
  );

  const refusedRoute = rlBase();
  refusedRoute.requestLevel.routes["GET /b@reference"] = { route: "GET /b", profile: "reference", status: "unmeasured", reason: "declined" };
  const refusedResult = evaluateRequestLevel(refusedRoute);
  check("a refused route is counted as refused, never as measured", refusedResult.refused === 1 && refusedResult.measured === 1);

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

  const { status, violations, ceilings, dbCalls, requestLevel, regressions } = report(manifest, fresh);
  if (STRICT && status !== "OK") process.exit(2);
  const failed =
    violations.length > 0 ||
    ceilings.over.length > 0 ||
    dbCalls.breaches.length > 0 ||
    requestLevel.over.length > 0 ||
    requestLevel.breaches.length > 0 ||
    (regressions?.findings.length ?? 0) > 0;
  process.exit(failed ? 1 : 0);
}

// Guarded, so the exported decision functions can be imported — by a future spec, or to reproduce a
// verdict — without the import itself running the CLI and exiting the process.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
