#!/usr/bin/env node
/**
 * measure-route-budgets.mjs — populate the measured fields of contracts/route-budgets.json
 * from a real measurement, and refuse to populate them from anything else.
 *
 * INPUT
 *   --from=<file>          a JSON artifact written by
 *                          `run-read-cost-budgets.mjs --json=<file>` (one tenant, one profile).
 *   --minority=<file>      an optional second artifact taken on a minority tenant. Its numbers are
 *                          recorded under `minorityMeasurement`, never merged into the primary
 *                          fields — a majority and a minority tenant do not share a plan.
 *   --write                persist. Without it the script prints the diff and changes nothing.
 *
 * WHAT IT WRITES, AND WHAT IT REFUSES TO WRITE
 *   Writes  measuredBufferBlocks / measuredReadPathP50Ms / P95 / P99 for every route budget whose
 *           `readCostBudgetId` resolved to a NON-EMPTY measurement.
 *   Refuses a record that is vacuous (0 rows), below its seed floor, skipped, excluded or errored —
 *           those leave the fields null, so the gate reports them as unmeasured rather than green.
 *   Never   writes measuredLatencyP95Ms (the end-to-end application ceiling), measuredDbCalls,
 *           measuredDownstreamCalls, measuredResponseBytes or measuredMemoryMb. The read-path
 *           artifact measures one statement on loopback Postgres; it is not evidence about the
 *           route's total call count, its response size, or its latency behind the HTTP stack.
 *           Writing a 5 ms database read into a 300 ms end-to-end ceiling is exactly the false pass
 *           this ticket exists to remove.
 *
 * SELF-TEST (--self-test) proves each of those refusals against a synthetic artifact.
 *
 * Exit codes: 0 ok / 1 refused or self-test failed / 2 an input was unreadable.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMeasurementRole } from "./benchmark-role-guard.mjs";

const BACKEND_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const BUDGETS_PATH = join(BACKEND_ROOT, "contracts", "route-budgets.json");

const MEASURABLE_OUTCOMES = new Set(["pass", "fail"]);

export function isUsableRecord(record) {
  if (!record || typeof record !== "object") return { ok: false, why: "no record for this read-cost budget id" };
  if (!MEASURABLE_OUTCOMES.has(record.outcome))
    return { ok: false, why: `read-cost budget outcome "${String(record.outcome)}" — not a measurement` };
  if (record.vacuous === true)
    return { ok: false, why: "read-cost budget returned 0 rows (vacuous) — measures an empty result set" };
  if (typeof record.blocks !== "number" || !record.latency)
    return { ok: false, why: "record carries no blocks/latency" };
  return { ok: true };
}

export function applyMeasurement(manifest, artifact, { minority = null } = {}) {
  const byId = new Map((artifact.budgets ?? []).map((b) => [b.id, b]));
  const minorityById = new Map((minority?.budgets ?? []).map((b) => [b.id, b]));
  const written = [];
  const refused = [];
  const unlinked = [];

  for (const [key, entry] of Object.entries(manifest.budgets ?? {})) {
    const rcId = entry.readCostBudgetId;
    if (!rcId) {
      unlinked.push(key);
      continue;
    }
    const record = byId.get(rcId);
    const usable = isUsableRecord(record);
    if (!usable.ok) {
      refused.push({ key, rcId, why: usable.why });
      entry.measuredBufferBlocks = null;
      entry.measuredReadPathP50Ms = null;
      entry.measuredReadPathP95Ms = null;
      entry.measuredReadPathP99Ms = null;
      entry.measurement = { status: "unmeasured", readCostBudgetId: rcId, reason: usable.why };
      continue;
    }
    entry.measuredBufferBlocks = record.blocks;
    entry.measuredReadPathP50Ms = record.latency.p50Ms;
    entry.measuredReadPathP95Ms = record.latency.p95Ms;
    entry.measuredReadPathP99Ms = record.latency.p99Ms;
    entry.measurement = {
      status: "measured",
      method: "read-path-explain",
      readCostBudgetId: rcId,
      tenant: artifact.tenant,
      profile: artifact.profile,
      samples: artifact.samples,
      resultRows: record.resultRows,
      tenantRows: record.tenantRows,
      coldMs: record.coldMs,
      warmBufferBlocks: record.warmBlocks,
      readCostCeilingBlocks: record.ceiling,
      readCostOutcome: record.outcome,
    };
    const m = minorityById.get(rcId);
    const mUsable = isUsableRecord(m);
    entry.minorityMeasurement = mUsable.ok
      ? {
          status: "measured",
          tenant: minority.tenant,
          bufferBlocks: m.blocks,
          readPathP50Ms: m.latency.p50Ms,
          readPathP95Ms: m.latency.p95Ms,
          readPathP99Ms: m.latency.p99Ms,
          resultRows: m.resultRows,
          tenantRows: m.tenantRows,
        }
      : minority
        ? { status: "unmeasured", tenant: minority.tenant, reason: mUsable.why }
        : null;
    written.push(key);
  }
  return { written, refused, unlinked };
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: BACKEND_ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function readJson(path) {
  if (!existsSync(path)) {
    process.stderr.write(`measure-route-budgets: ${path} not found\n`);
    process.exit(2);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    process.stderr.write(`measure-route-budgets: failed to parse ${path}: ${err.message}\n`);
    process.exit(2);
  }
}

function selfTest() {
  process.stdout.write("Running self-test...\n");
  let failed = false;
  const pass = (l) => process.stdout.write(`  [pass] ${l}\n`);
  const fail = (l, d) => {
    process.stderr.write(`  [FAIL] ${l}: ${d}\n`);
    failed = true;
  };

  const artifact = {
    tenant: "org-1",
    profile: "reference",
    samples: 200,
    budgets: [
      { id: "good", outcome: "pass", ceiling: 5000, blocks: 218, resultRows: 50, tenantRows: 8000,
        coldMs: 1.2, warmBlocks: 218, latency: { p50Ms: 1.2, p95Ms: 1.5, p99Ms: 1.9 } },
      { id: "empty", outcome: "fail", ceiling: 5000, blocks: 4, resultRows: 0, tenantRows: 18500,
        vacuous: true, coldMs: 0.1, warmBlocks: 4, latency: { p50Ms: 0.1, p95Ms: 0.2, p99Ms: 0.3 } },
      { id: "floored", outcome: "unmeasured", reason: "seed-too-small", tenantRows: 3, minRows: 50 },
      { id: "over", outcome: "fail", ceiling: 3000, blocks: 10234, resultRows: 1, tenantRows: 240000,
        coldMs: 12, warmBlocks: 10234, latency: { p50Ms: 7, p95Ms: 9, p99Ms: 20 } },
    ],
  };
  const manifest = {
    budgets: {
      "GET /a": { readCostBudgetId: "good", maxLatencyP95Ms: 300, measuredLatencyP95Ms: null, measuredDbCalls: null },
      "GET /b": { readCostBudgetId: "empty", maxLatencyP95Ms: 300, measuredLatencyP95Ms: null, measuredDbCalls: null },
      "GET /c": { readCostBudgetId: "floored", maxLatencyP95Ms: 300, measuredLatencyP95Ms: null, measuredDbCalls: null },
      "GET /d": { readCostBudgetId: "missing", maxLatencyP95Ms: 300, measuredLatencyP95Ms: null, measuredDbCalls: null },
      "GET /e": { maxLatencyP95Ms: 300, measuredLatencyP95Ms: null, measuredDbCalls: null },
      "GET /f": { readCostBudgetId: "over", maxLatencyP95Ms: 300, measuredLatencyP95Ms: null, measuredDbCalls: null },
    },
  };

  const { written, refused, unlinked } = applyMeasurement(manifest, artifact);

  if (manifest.budgets["GET /a"].measuredBufferBlocks !== 218)
    fail("measured-is-written", `expected 218 blocks, got ${String(manifest.budgets["GET /a"].measuredBufferBlocks)}`);
  else pass("measured-is-written — a non-empty read-cost measurement populates measuredBufferBlocks");

  if (manifest.budgets["GET /b"].measuredBufferBlocks !== null)
    fail("vacuous-is-refused", "a 0-row read-cost budget was written into the manifest");
  else pass("vacuous-is-refused — a 0-row (vacuous) measurement leaves the fields null");

  if (manifest.budgets["GET /c"].measuredBufferBlocks !== null)
    fail("below-floor-is-refused", "a below-seed-floor record was written");
  else pass("below-floor-is-refused — a record under its seed floor leaves the fields null");

  if (manifest.budgets["GET /d"].measurement?.status !== "unmeasured")
    fail("missing-record-is-refused", "a budget id with no record was not marked unmeasured");
  else pass("missing-record-is-refused — an unresolvable readCostBudgetId is marked unmeasured");

  if (!unlinked.includes("GET /e"))
    fail("unlinked-is-reported", "a budget with no readCostBudgetId was not reported as unlinked");
  else pass("unlinked-is-reported — a route with no read-cost budget is reported, not silently green");

  if (manifest.budgets["GET /a"].measuredLatencyP95Ms !== null || manifest.budgets["GET /a"].measuredDbCalls !== null)
    fail("end-to-end-fields-untouched", "the read-path artifact wrote an end-to-end field");
  else pass("end-to-end-fields-untouched — measuredLatencyP95Ms and measuredDbCalls are never filled from a read-path artifact");

  if (manifest.budgets["GET /f"].measuredBufferBlocks !== 10234)
    fail("breach-is-recorded", "a measurement over its read-cost ceiling was not recorded");
  else pass("breach-is-recorded — a breaching measurement is recorded, not dropped to hide the breach");

  if (written.length !== 2 || refused.length !== 3)
    fail("tally", `expected 2 written / 3 refused, got ${written.length}/${refused.length}`);
  else pass("tally — 2 written, 3 refused, 1 unlinked");

  // PRD-C079: the manifest may only record the role its input artifact observed.
  if (resolveMeasurementRole({ tenant: "org-1" }).ok)
    fail("role-absent-is-refused", "an artifact with no observed role was accepted");
  else pass("role-absent-is-refused — an artifact carrying no `role` cannot populate measurement.role");

  if (resolveMeasurementRole({ role: "neondb_owner (rolbypassrls = true)" }).ok)
    fail("owner-role-is-refused", "a BYPASSRLS role string was accepted as provenance");
  else pass("owner-role-is-refused — a role not proven non-BYPASSRLS is refused");

  const proven = resolveMeasurementRole({ role: "streamline_app (rolbypassrls = false, tenant GUC set)" });
  if (!proven.ok || proven.role !== "streamline_app (rolbypassrls = false, tenant GUC set)")
    fail("proven-role-is-carried", `an observed non-BYPASSRLS role was not carried through: ${String(proven.why)}`);
  else pass("proven-role-is-carried — an observed non-BYPASSRLS role reaches measurement.role verbatim");

  if (failed) {
    process.stderr.write("\nSELF-TEST FAILED\n");
    process.exit(1);
  }
  process.stdout.write("\nSELF-TEST PASSED\n");
  process.exit(0);
}

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};

if (process.argv.includes("--self-test")) selfTest();

const fromPath = arg("from");
if (!fromPath) {
  process.stderr.write(
    "measure-route-budgets: --from=<artifact.json> is required.\n" +
      "  Produce one with: APP_DATABASE_URL=<app role> SEED_ORG_ID=<org> \\\n" +
      "    node src/scripts/run-read-cost-budgets.mjs --samples=200 --json=<artifact.json>\n",
  );
  process.exit(2);
}

const artifact = readJson(fromPath);
const minorityPath = arg("minority");
const minority = minorityPath ? readJson(minorityPath) : null;
const manifest = readJson(BUDGETS_PATH);

const { written, refused, unlinked } = applyMeasurement(manifest, artifact, { minority });

// Database-call counts come from a different instrument and are merged separately: they are
// produced by test/perf/route-db-call-budget.e2e-spec.ts counting real statements through
// QueryTelemetryTracker, not by the read-path EXPLAIN artifact.
const dbCallsPath = arg("db-calls");
let dbCallsWritten = 0;
if (dbCallsPath) {
  const dbArtifact = readJson(dbCallsPath);
  for (const [key, value] of Object.entries(dbArtifact.dbCalls ?? {})) {
    const entry = manifest.budgets?.[key];
    if (!entry) {
      process.stderr.write(`measure-route-budgets: db-call artifact names "${key}", which the manifest does not declare\n`);
      process.exit(1);
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      process.stderr.write(`measure-route-budgets: db-call artifact value for "${key}" is not a non-negative integer\n`);
      process.exit(1);
    }
    entry.measuredDbCalls = value;
    entry.dbCallMeasurement = {
      status: "measured",
      method: "db-call-count",
      instrument: "QueryTelemetryTracker over instrumentPostgresClient (src/db/query-telemetry.ts)",
      tenant: dbArtifact.tenant ?? null,
      cache: "miss (CacheService with null Redis) — every maxDbCalls is the cache-miss ceiling",
    };
    dbCallsWritten++;
  }
}

// PRD-C079: the role provenance is READ off the artifact that was actually measured. It used to
// be a string literal here, which survives being pointed at the owner and turns the manifest's own
// RLS claim into an assertion nobody took. run-read-cost-budgets.mjs records what pg_roles said.
const measuredRoleResolution = resolveMeasurementRole(artifact);
if (!measuredRoleResolution.ok) {
  process.stderr.write(`measure-route-budgets: REFUSING TO WRITE — ${measuredRoleResolution.why}\n`);
  process.exit(1);
}
const measuredRole = measuredRoleResolution.role;

manifest.measurement = {
  method: "read-path-explain",
  commit: gitCommit(),
  commitNote:
    "HEAD at the moment the numbers were taken. The commit that RECORDS them is its child, since " +
    "writing the manifest is itself a change — re-run this script after any commit that alters a " +
    "measured route so the recorded commit stays the one the numbers describe.",
  takenAt: artifact.generatedAt ?? new Date().toISOString(),
  database: arg("database") ?? "scratch_perf_seed",
  role: measuredRole,
  referenceTenant: artifact.tenant,
  referenceProfile: artifact.profile,
  minorityTenant: minority?.tenant ?? null,
  samples: artifact.samples,
  readCostBudgetsDeclared: artifact.declared,
  readCostBudgetsMeasured: artifact.measured,
  routeBudgetsMeasured: written.length,
  routeBudgetsUnmeasured: refused.length + unlinked.length,
  routeBudgetsWithCountedDbCalls: dbCallsWritten,
};

process.stdout.write(
  `measure-route-budgets: ${written.length} read-path written, ${dbCallsWritten} db-call counts written, ` +
    `${refused.length} refused, ${unlinked.length} with no read-cost link\n`,
);
for (const r of refused) process.stdout.write(`  REFUSED ${r.key} (${r.rcId}) — ${r.why}\n`);

if (!process.argv.includes("--write")) {
  process.stdout.write("  dry run — pass --write to persist\n");
  process.exit(0);
}

writeFileSync(BUDGETS_PATH, JSON.stringify(manifest, null, 2) + "\n");
process.stdout.write(`  wrote ${BUDGETS_PATH}\n`);
