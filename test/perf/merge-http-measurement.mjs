#!/usr/bin/env node
/**
 * Folds an HTTP capture into the benchmark manifest's `requestLevel` block.
 *
 * WHY A SEPARATE BLOCK RATHER THAN THE EXISTING BENCHMARKS
 *
 * Every other number in this manifest is a STATEMENT measured with `EXPLAIN (ANALYZE, BUFFERS)`.
 * A request is not a statement: it also pays for authentication, permission resolution, module
 * entitlement, serialisation and the Nest pipeline. Writing a 5 ms statement into a 300 ms
 * end-to-end ceiling would report "within budget" for a route nobody has timed, which is exactly
 * the substitution two previous passes on this ticket refused to make. So the request-level
 * figures live beside the statement-level ones and are never mixed into them.
 *
 * WHY IT DOES NOT WRITE `contracts/route-budgets.json`
 *
 * That file declares the ceilings and owns the `measured*` fields, and it belongs to ticket 22.
 * This reads it for each route's `class` and declared ceilings, records a content hash of it, and
 * leaves the hand-off visible: the artifact this produces is what fills those nulls, and the
 * report names them.
 *
 * CEILING CLASSES
 *
 *   aggregate                 -> the PRD §12.1 complex request ceiling (800 ms)
 *   shell / list / write      -> the PRD §12.1 ordinary request ceiling (300 ms)
 *   worker                    -> EXCLUDED, with the reason recorded. A `/cron/*` sweep iterates
 *                                every organisation in the deployment; it is not an authenticated
 *                                user request and the PRD's request ceilings do not describe it.
 *                                Its numbers are still recorded — a sweep holding 44 MB of heap is
 *                                worth knowing — they simply do not decide a request verdict.
 *
 * Usage:
 *   node test/perf/merge-http-measurement.mjs --artifact=<capture.json> [--artifact=<second.json>]
 *   node test/perf/merge-http-measurement.mjs --artifact=<capture.json> --write
 *   node test/perf/merge-http-measurement.mjs --self-test
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BACKEND_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const MANIFEST_PATH = resolve(BACKEND_ROOT, "contracts/benchmark-manifest.json");
const ROUTE_BUDGETS_PATH = resolve(BACKEND_ROOT, "contracts/route-budgets.json");

export const ORDINARY_REQUEST_CEILING_MS = 300;
export const COMPLEX_REQUEST_CEILING_MS = 800;

export const EXCLUDED_CLASS_REASON =
  "an all-organisation background sweep, not an authenticated user request — the PRD §12.1 " +
  "request ceilings describe reads and mutations, so this is recorded and not scored";

/**
 * Which ceiling applies, and whether one applies at all.
 *
 * Returning the reason alongside the number is the point: an excluded route has to say WHY it is
 * excluded in the artifact, or the next reader cannot tell an exemption from an oversight.
 */
export function classifyRoute(routeClass) {
  if (routeClass === "stream") return {
    scored: false, ceilingMs: null,
    reason: "Stream completion includes provider generation; enforce the declared full-stream deadline and separately captured application pre-provider, first-visible-state and provider TTFT budgets.",
  };
  if (routeClass === "worker") return { scored: false, ceilingMs: null, reason: EXCLUDED_CLASS_REASON };
  if (routeClass === "aggregate")
    return {
      scored: true,
      ceilingMs: COMPLEX_REQUEST_CEILING_MS,
      reason: "an approved complex aggregate or search — PRD §12.1 complex request ceiling",
    };
  return {
    scored: true,
    ceilingMs: ORDINARY_REQUEST_CEILING_MS,
    reason: "an ordinary authenticated read or mutation — PRD §12.1 ordinary request ceiling",
  };
}

export function contentHash(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * A run that could not prove its own credential produces nothing.
 *
 * Two harnesses in this release published clean tables while every request was failing. The
 * control probe is the answer to that, and this is where its verdict becomes a REFUSAL rather than
 * a footnote: a tenant whose probe did not hold contributes no routes at all.
 */
export function tenantIsScorable(tenant) {
  if (tenant?.controlBefore?.ok !== true) return { ok: false, reason: "the opening control probe did not hold" };
  if (tenant?.controlAfter?.ok !== true) return { ok: false, reason: "the closing control probe did not hold" };
  if (tenant?.subjectStable !== true)
    return { ok: false, reason: `the subject changed shape mid-capture: ${(tenant.subjectDrift ?? []).join(", ")}` };
  return { ok: true, reason: null };
}

/**
 * Folds a requestLevel block into a manifest object, together with the two prose fields that
 * describe it.
 *
 * Exported because this script is not the only writer of the manifest.
 * `measure-benchmark-manifest.mjs` rebuilds the statement half from scratch, and the object it
 * builds has no `requestLevel` key at all — so before this existed, a `--write` there silently
 * DELETED every measured route×tenant slot along with both sentences saying they were measured, and
 * the next reader saw a manifest that had simply never had an HTTP capture. Carrying the block
 * forward through the same function keeps the block and its description from disagreeing about
 * which capture is being described.
 */
export function applyRequestLevel(manifest, requestLevel) {
  manifest.requestLevel = requestLevel;
  manifest.prd.requestCeilingsMs.note =
    `Request-level ceilings ARE measured, by ${requestLevel.instrument}, and recorded under ` +
    `\`requestLevel\`. The cache-hit ceiling remains unmeasured — no Redis runs against this seed.`;
  // Drop the lines this script itself wrote last time, as well as the original "no HTTP harness
  // exists" line. Without this a second capture stacks a stale coverage claim on top of a fresh
  // one, and the reader cannot tell which database either sentence is about.
  manifest.coverage.notMeasured = (manifest.coverage.notMeasured ?? []).filter(
    (line) =>
      !line.startsWith("End-to-end request latency") &&
      !line.startsWith("Request-level figures cover") &&
      !line.startsWith("Request-level MUTATION latency"),
  );
  manifest.coverage.notMeasured.unshift(
    `Request-level figures cover ${String(requestLevel.tally.measured)} of ` +
      `${String(requestLevel.tally.total)} route×tenant slots on ${String(requestLevel.database)}; ` +
      `${String(requestLevel.tally.refused)} were declined and ${String(requestLevel.tally.failed)} failed. ` +
      `See requestLevel.tally.refusalsByReason for why each was not measured.`,
  );
  if (requestLevel.readOnly === true)
    manifest.coverage.notMeasured.push(
      "Request-level MUTATION latency: the capture was read-only, so the plan's POST entries were " +
        "declined rather than measured against a database other reports quote.",
    );
  return manifest;
}

export function buildRequestLevel(artifacts, budgets, budgetsHash) {
  const routes = {};
  const tenants = [];
  let measured = 0;
  let refused = 0;
  let failed = 0;
  let excluded = 0;
  const refusalsByReason = {};

  for (const artifact of artifacts) {
    for (const run of artifact.tenants ?? []) {
      const scorable = tenantIsScorable(run);
      tenants.push({
        tenant: run.tenant,
        profile: run.profile,
        scorable: scorable.ok,
        notScorableBecause: scorable.reason,
        controlBeforeOk: run.controlBefore?.ok === true,
        controlAfterOk: run.controlAfter?.ok === true,
        anonymousControlStatus: run.controlBefore?.anonymous?.status ?? null,
        subjectStable: run.subjectStable === true,
        subjectHashBefore: run.subjectBefore?.hash ?? null,
        subjectHashAfter: run.subjectAfter?.hash ?? null,
        fixtureHash: run.fixtureHash ?? null,
        measured: run.tally?.measured ?? 0,
        refused: run.tally?.refused ?? 0,
        failed: run.tally?.failed ?? 0,
      });
      if (!scorable.ok) continue;

      for (const [route, m] of Object.entries(run.routes ?? {})) {
        const key = `${route}@${run.profile}`;
        const budget = budgets[route] ?? null;
        const classification = classifyRoute(budget?.class ?? null);
        if (m.status !== "measured") {
          const reason = m.reason ?? m.status;
          refusalsByReason[reason] = (refusalsByReason[reason] ?? 0) + 1;
          if (m.status === "failed") failed += 1;
          else refused += 1;
          routes[key] = {
            route,
            tenant: run.tenant,
            profile: run.profile,
            routeClass: budget?.class ?? null,
            status: m.status,
            reason,
            httpStatus: m.httpStatus ?? null,
          };
          continue;
        }

        measured += 1;
        if (!classification.scored) excluded += 1;
        const p95 = m.latencyMs?.p95 ?? null;
        routes[key] = {
          route,
          tenant: run.tenant,
          profile: run.profile,
          routeClass: budget?.class ?? null,
          status: "measured",
          scored: classification.scored,
          ceilingReason: classification.reason,
          prdCeilingMs: classification.ceilingMs,
          declaredLatencyP95Ms: budget?.maxLatencyP95Ms ?? null,
          declaredDownstreamCalls: budget?.maxDownstreamCalls ?? null,
          declaredResponseBytes: budget?.maxResponseBytes ?? null,
          declaredMemoryMb: budget?.maxMemoryMb ?? null,
          samples: m.samples,
          latencyMs: m.latencyMs,
          requestDbCalls: m.dbCalls,
          requestDbCallsVaried: m.dbCallsVaried ?? null,
          gucCalls: m.gucCalls,
          downstreamCalls: m.downstreamCalls,
          downstreamAccounting: m.downstreamAccounting ?? null,
          deferredDownstreamCalls: m.deferredDownstreamCalls ?? null,
          deferredFailures: m.deferredFailures ?? null,
          deferredDownstreamTargets: m.deferredDownstreamTargets ?? null,
          responseBytes: m.responseBytes,
          memoryMb: m.memoryMb,
          overPrdCeiling: classification.scored && p95 !== null ? p95 > classification.ceilingMs : false,
        };
      }
    }
  }

  const first = artifacts[0] ?? {};
  return {
    method: "http-harness",
    instrument: "test/perf/route-budget-http.seeded-e2e-spec.ts",
    command:
      "DATABASE_URL=<owner@scratch> APP_DATABASE_URL=<streamline_app@scratch> AUTH_SIGNING_KEYS=<local placeholder> " +
      "node --expose-gc ./node_modules/jest/bin/jest.js --config ./jest-e2e-seeded.json --runInBand " +
      "--testPathPattern=route-budget-http",
    generatedAt: first.generatedAt ?? null,
    commit: first.commit ?? null,
    workingTreeDirty: first.workingTreeDirty ?? null,
    codeProvenance: first.codeProvenance ?? null,
    database: first.database ?? null,
    appliedMigrations: first.appliedMigrations ?? null,
    journalEntries: first.journalEntries ?? null,
    atHead: first.atHead ?? null,
    role: first.role ?? null,
    cache: first.cache ?? null,
    compression: first.compression ?? null,
    readOnly: first.readOnly ?? null,
    samples: first.samples ?? null,
    writeSamples: first.writeSamples ?? null,
    heapSamples: first.heapSamples ?? null,
    warmup: first.warmup ?? null,
    deadlineMs: first.deadlineMs ?? null,
    gcAvailable: first.gcAvailable ?? null,
    memoryNote: first.memoryNote ?? null,
    routeBudgetsDigest: budgetsHash,
    prdCeilingsMs: { ordinary: ORDINARY_REQUEST_CEILING_MS, complex: COMPLEX_REQUEST_CEILING_MS },
    excludedClassReason: EXCLUDED_CLASS_REASON,
    tally: {
      total: Object.keys(routes).length,
      measured,
      refused,
      failed,
      excludedFromCeiling: excluded,
      refusalsByReason,
    },
    tenants,
    routes,
  };
}

function selfTest() {
  const checks = [];
  const check = (name, condition) => checks.push({ name, ok: condition === true });

  check("a worker route is excluded from the request ceiling", classifyRoute("worker").scored === false);
  check("an excluded route states why", (classifyRoute("worker").reason ?? "").length > 20);
  check("an aggregate gets the complex ceiling", classifyRoute("aggregate").ceilingMs === COMPLEX_REQUEST_CEILING_MS);
  check("a list gets the ordinary ceiling", classifyRoute("list").ceilingMs === ORDINARY_REQUEST_CEILING_MS);
  check("a write gets the ordinary ceiling", classifyRoute("write").ceilingMs === ORDINARY_REQUEST_CEILING_MS);
  check("an unknown class falls back to ordinary rather than to no ceiling", classifyRoute(null).scored === true);

  const ok = { controlBefore: { ok: true }, controlAfter: { ok: true }, subjectStable: true };
  check("a clean tenant is scorable", tenantIsScorable(ok).ok === true);
  check("a failed opening probe is not scorable", tenantIsScorable({ ...ok, controlBefore: { ok: false } }).ok === false);
  check("a failed closing probe is not scorable", tenantIsScorable({ ...ok, controlAfter: { ok: false } }).ok === false);
  check(
    "a drifted subject is not scorable",
    tenantIsScorable({ ...ok, subjectStable: false, subjectDrift: ["leads"] }).ok === false,
  );

  const budgets = {
    "GET /a": { class: "list", maxLatencyP95Ms: 400, maxDownstreamCalls: 0, maxResponseBytes: 100, maxMemoryMb: 8 },
    "GET /cron/x": { class: "worker", maxLatencyP95Ms: 60000 },
  };
  const artifact = {
    generatedAt: "t",
    tenants: [
      {
        tenant: "org", profile: "reference", ...ok, tally: { measured: 2, refused: 1, failed: 0 },
        routes: {
          "GET /a": { status: "measured", samples: 40, latencyMs: { p50: 1, p95: 999, p99: 1, min: 1, max: 1 }, dbCalls: 3, gucCalls: 1, downstreamCalls: 0, downstreamAccounting: "request-and-after-commit-v1", deferredDownstreamCalls: 2, deferredFailures: 0, responseBytes: 10, memoryMb: 1 },
          "GET /cron/x": { status: "measured", samples: 40, latencyMs: { p50: 1, p95: 5000, p99: 1, min: 1, max: 1 }, dbCalls: 100, gucCalls: 1, downstreamCalls: 8, responseBytes: 10, memoryMb: 40 },
          "GET /gone": { status: "unmeasured", reason: "declined" },
        },
      },
    ],
  };
  const built = buildRequestLevel([artifact], budgets, "hash");
  check("an over-ceiling ordinary route is flagged", built.routes["GET /a@reference"].overPrdCeiling === true);
  check("a worker route over 800 ms is NOT flagged", built.routes["GET /cron/x@reference"].overPrdCeiling === false);
  check("the worker route's numbers are still recorded", built.routes["GET /cron/x@reference"].memoryMb === 40);
  check("refusals are counted", built.tally.refused === 1);
  check("refusals carry their reason", built.tally.refusalsByReason.declined === 1);
  check("excluded routes are counted", built.tally.excludedFromCeiling === 1);
  check("the declared ceiling is carried through", built.routes["GET /a@reference"].declaredLatencyP95Ms === 400);
  check(
    "deferred downstream calls are propagated from the artifact route to the manifest slot",
    built.routes["GET /a@reference"].deferredDownstreamCalls === 2,
  );
  check(
    "downstream accounting scheme is propagated so the budget gate knows which captures to trust",
    built.routes["GET /a@reference"].downstreamAccounting === "request-and-after-commit-v1",
  );
  check(
    "a route without the accounting scheme has null for both deferred fields, not a stale number",
    built.routes["GET /cron/x@reference"].deferredDownstreamCalls === null &&
      built.routes["GET /cron/x@reference"].downstreamAccounting === null,
  );

  const unscorable = buildRequestLevel(
    [{ tenants: [{ tenant: "org", profile: "reference", controlBefore: { ok: false }, controlAfter: { ok: true }, subjectStable: true, routes: { "GET /a": { status: "measured", latencyMs: { p95: 1 } } } }] }],
    budgets,
    "hash",
  );
  check("a tenant whose control probe failed contributes NO routes", Object.keys(unscorable.routes).length === 0);
  check("but it is still listed, with the reason", unscorable.tenants[0].scorable === false);

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) process.stdout.write(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}\n`);
  process.stdout.write(`[merge-http-measurement] self-test ${String(checks.length - failed.length)}/${String(checks.length)}\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

function main() {
  const artifactPaths = process.argv
    .filter((a) => a.startsWith("--artifact="))
    .map((a) => a.slice("--artifact=".length));
  if (artifactPaths.length === 0) {
    process.stderr.write("[merge-http-measurement] pass at least one --artifact=<capture.json>\n");
    process.exit(1);
  }
  const write = process.argv.includes("--write");

  const budgetsText = readFileSync(ROUTE_BUDGETS_PATH, "utf8");
  const budgets = JSON.parse(budgetsText).budgets ?? {};
  const artifacts = artifactPaths.map((p) => JSON.parse(readFileSync(p, "utf8")));
  const requestLevel = buildRequestLevel(artifacts, budgets, contentHash(budgetsText));

  const over = Object.values(requestLevel.routes).filter((r) => r.overPrdCeiling === true);
  process.stdout.write(
    `[merge-http-measurement] ${String(requestLevel.tally.measured)} measured / ` +
      `${String(requestLevel.tally.refused)} refused / ${String(requestLevel.tally.failed)} failed ` +
      `of ${String(requestLevel.tally.total)} route×tenant slots · ` +
      `${String(requestLevel.tally.excludedFromCeiling)} excluded from the request ceiling · ` +
      `${String(over.length)} over ceiling\n`,
  );
  for (const r of over)
    process.stdout.write(
      `  OVER  ${r.route}@${r.profile}: p95 ${String(r.latencyMs.p95)} ms > ${String(r.prdCeilingMs)} ms (${String(r.routeClass)})\n`,
    );

  if (!write) {
    process.stdout.write("[merge-http-measurement] dry run — pass --write to fold this into the manifest\n");
    return;
  }

  const manifest = applyRequestLevel(JSON.parse(readFileSync(MANIFEST_PATH, "utf8")), requestLevel);
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`[merge-http-measurement] wrote requestLevel into contracts/benchmark-manifest.json\n`);
}

// Guarded, so importing `applyRequestLevel` from another writer of the manifest does not run this
// script's CLI. Unguarded, a bare import executed `main()`, which exits 1 on the missing
// `--artifact=` argument — the import alone would have killed its caller.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv.includes("--self-test")) selfTest();
  else main();
}
