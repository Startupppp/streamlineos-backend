#!/usr/bin/env node
/**
 * Fills `contracts/route-budgets.json`'s request-level `measured*` fields from the HTTP capture
 * already folded into `contracts/benchmark-manifest.json` under `requestLevel`.
 *
 * WHY THIS EXISTS
 *
 * A budget whose ceiling has never been compared against a measurement is vacuous. Four of the
 * five request-level `measured*` fields on all 82 budgets were `null`, so `check:route-budgets`
 * could report "no budgets exceeded" over a surface where nothing had ever been timed. The
 * capture that fills them exists (`test/perf/route-budget-http.seeded-e2e-spec.ts`, merged by
 * `merge-http-measurement.mjs`); this is the one-way hand-off from that block into the contract.
 *
 * WHAT IT REFUSES TO DO
 *
 *  - It NEVER writes `measuredDbCalls`. The capture's `requestDbCalls` is a strict SUPERSET of the
 *    handler's statement count — authentication, permission resolution and module entitlement are
 *    in it. `GET /notifications` issues 3 statements at the service level and 12 at the request
 *    level. Writing 12 into a field the gate compares against `maxDbCalls: 3` would either fail a
 *    route that is correct or, once someone "fixed" it by raising the ceiling, silently widen
 *    every service-level ratchet in the file. The request count is recorded under its own name.
 *  - It refuses any capture whose control probe did not hold on every tenant, whose role had
 *    BYPASSRLS, that was not at journal head, or that reported no `--expose-gc` while carrying
 *    heap numbers.
 *  - It refuses per route when the ceiling the capture read is not the ceiling the file declares
 *    today. The capture records `declared*` beside every measurement precisely so a ceiling edited
 *    after the run cannot be silently re-associated with an older number.
 *  - It writes nothing for a route the capture declined, beyond the stated reason. A refusal stays
 *    a refusal.
 *
 * WHICH TENANT'S NUMBER IS RECORDED
 *
 * The WORST measured profile, per field, with the profile named. A ceiling is a ceiling: recording
 * only the reference tenant would let a minority-tenant breach report as a pass. Both profiles are
 * kept in full under `httpMeasurement.profiles`.
 *
 * Usage:
 *   node test/perf/merge-http-route-budgets.mjs                 # dry run, prints what would change
 *   node test/perf/merge-http-route-budgets.mjs --write
 *   node test/perf/merge-http-route-budgets.mjs --check         # exit 1 if the file is out of date
 *   node test/perf/merge-http-route-budgets.mjs --self-test
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BACKEND_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const MANIFEST_PATH = resolve(BACKEND_ROOT, "contracts/benchmark-manifest.json");
const ROUTE_BUDGETS_PATH = resolve(BACKEND_ROOT, "contracts/route-budgets.json");

/** measured field on the budget -> [capture field, ceiling field, how to read it off the slot] */
export const HTTP_FIELDS = [
  { measured: "measuredLatencyP95Ms", declared: "declaredLatencyP95Ms", ceiling: "maxLatencyP95Ms", read: (m) => m.latencyMs?.p95 ?? null },
  { measured: "measuredDownstreamCalls", declared: "declaredDownstreamCalls", ceiling: "maxDownstreamCalls", read: (m) => m.downstreamAccounting === "request-and-after-commit-v1" ? m.downstreamCalls ?? null : null },
  { measured: "measuredResponseBytes", declared: "declaredResponseBytes", ceiling: "maxResponseBytes", read: (m) => m.responseBytes ?? null },
  { measured: "measuredMemoryMb", declared: "declaredMemoryMb", ceiling: "maxMemoryMb", read: (m) => m.memoryMb ?? null },
  {
    measured: "measuredRequestDbCalls",
    declared: "declaredRequestDbCalls",
    ceiling: "maxRequestDbCalls",
    read: (m) => m.requestDbCalls ?? null,
  },
  { measured: "measuredLatencyP50Ms", declared: null, ceiling: null, read: (m) => m.latencyMs?.p50 ?? null },
  { measured: "measuredLatencyP99Ms", declared: null, ceiling: null, read: (m) => m.latencyMs?.p99 ?? null },
  { measured: "measuredMemoryMbP50", declared: null, ceiling: null, read: (m) => m.memoryMbPercentiles?.p50 ?? null },
  { measured: "measuredMemoryMbP95", declared: null, ceiling: null, read: (m) => m.memoryMbPercentiles?.p95 ?? null },
  { measured: "measuredMemoryMbP99", declared: null, ceiling: null, read: (m) => m.memoryMbPercentiles?.p99 ?? null },
  { measured: "measuredResponseBytesP50", declared: null, ceiling: null, read: (m) => m.responseBytesPercentiles?.p50 ?? null },
  { measured: "measuredResponseBytesP95", declared: null, ceiling: null, read: (m) => m.responseBytesPercentiles?.p95 ?? null },
  { measured: "measuredResponseBytesP99", declared: null, ceiling: null, read: (m) => m.responseBytesPercentiles?.p99 ?? null },
];

export const NEVER_WRITTEN = {
  field: "measuredDbCalls",
  why:
    "the capture's requestDbCalls is a strict superset of the handler statement count that " +
    "maxDbCalls describes (authentication, permission resolution and module entitlement are in " +
    "it), so it is recorded as requestDbCalls and never as measuredDbCalls",
};

export function contentHash(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * A digest over the DECLARED ceilings only.
 *
 * A whole-file hash cannot survive this script: writing the measurements changes the file it
 * hashed. Hashing only the `max*` keys keeps the useful half — "were these the ceilings the
 * capture was scored against" — and stays stable when a measurement is refreshed.
 */
export function ceilingDigest(budgets) {
  const shape = Object.keys(budgets)
    .sort()
    .map((key) => {
      const entry = budgets[key];
      const ceilings = Object.keys(entry)
        .filter((k) => k.startsWith("max"))
        .sort()
        .map((k) => `${k}=${JSON.stringify(entry[k])}`)
        .join(",");
      return `${key}{${ceilings}}`;
    })
    .join("|");
  return contentHash(shape);
}

/**
 * Everything that makes the whole capture unusable, not just one route.
 *
 * Each of these has already produced a false clean table somewhere in this release, which is why
 * they are refusals rather than warnings.
 */
export function captureViolations(requestLevel) {
  const violations = [];
  if (!requestLevel) return ["contracts/benchmark-manifest.json has no requestLevel block — nothing has been captured"];
  if (requestLevel.method !== "http-harness")
    violations.push(`requestLevel.method is ${JSON.stringify(requestLevel.method)}, not "http-harness"`);
  if (!Array.isArray(requestLevel.tenants) || requestLevel.tenants.length === 0)
    violations.push("the capture names no tenants");
  for (const t of requestLevel.tenants ?? []) {
    if (t.scorable !== true) violations.push(`tenant ${String(t.profile)} is not scorable: ${String(t.notScorableBecause)}`);
    if (t.controlBeforeOk !== true || t.controlAfterOk !== true)
      violations.push(`tenant ${String(t.profile)} did not hold both control probes`);
    if (t.subjectStable !== true) violations.push(`tenant ${String(t.profile)} changed subject shape mid-capture`);
  }
  if (typeof requestLevel.role !== "string" || !/rolbypassrls\s*=\s*false/i.test(requestLevel.role))
    violations.push(`the capture role is not proven non-BYPASSRLS: ${JSON.stringify(requestLevel.role)}`);
  if (requestLevel.atHead !== true) violations.push("the capture database was not at journal head");
  const carriesHeap = Object.values(requestLevel.routes ?? {}).some((r) => typeof r.memoryMb === "number");
  if (carriesHeap && requestLevel.gcAvailable !== true)
    violations.push("heap figures are recorded but the capture ran without --expose-gc");
  for (const [route, measurement] of Object.entries(requestLevel.routes ?? {}))
    if (typeof measurement.deferredFailures === "number" && measurement.deferredFailures > 0)
      violations.push(`${route} recorded ${measurement.deferredFailures} failed after-commit hooks`);
  return violations;
}

function worst(values) {
  let best = null;
  for (const v of values) {
    if (v.value === null || v.value === undefined) continue;
    if (best === null || v.value > best.value) best = v;
  }
  return best;
}

/**
 * The per-route decision, as data, so the self-test can assert it without touching a file.
 *
 * Returns `{ fields, http }` where `fields` are the measured values to write and `http` is the
 * provenance block. A route the capture declined returns `fields: {}` and an unmeasured block.
 */
export function planRoute(key, budget, slots) {
  const measuredSlots = slots.filter((s) => s.status === "measured");
  const profiles = {};
  for (const s of slots) {
    profiles[s.profile] =
      s.status === "measured"
        ? {
            status: "measured",
            tenant: s.tenant,
            samples: s.samples ?? null,
            latencyP50Ms: s.latencyMs?.p50 ?? null,
            latencyP95Ms: s.latencyMs?.p95 ?? null,
            latencyP99Ms: s.latencyMs?.p99 ?? null,
            downstreamCalls: s.downstreamCalls ?? null,
            downstreamAccounting: s.downstreamAccounting ?? null,
            deferredDownstreamCalls: s.deferredDownstreamCalls ?? null,
            deferredFailures: s.deferredFailures ?? null,
            deferredDownstreamTargets: s.deferredDownstreamTargets ?? null,
            responseBytes: s.responseBytes ?? null,
            memoryMb: s.memoryMb ?? null,
            memoryMbPercentiles: s.memoryMbPercentiles ?? null,
            responseBytesPercentiles: s.responseBytesPercentiles ?? null,
            requestDbCalls: s.requestDbCalls ?? null,
            gucCalls: s.gucCalls ?? null,
            prdCeilingMs: s.prdCeilingMs ?? null,
            overPrdCeiling: s.overPrdCeiling ?? null,
          }
        : { status: "unmeasured", tenant: s.tenant, reason: s.reason ?? "no reason recorded", httpStatus: s.httpStatus ?? null };
  }

  if (measuredSlots.length === 0 && slots.length === 0) {
    const existing = budget.httpMeasurement;
    if (
      existing?.status === "measured" &&
      existing.method === "production-http-probe" &&
      typeof existing.recordedFrom === "string" &&
      existing.recordedFrom.length > 0 &&
      existing.profiles !== null &&
      typeof existing.profiles === "object" &&
      Object.keys(existing.profiles).length > 0
    ) {
      const declared = existing.declaredCeilings;
      const fields = {};
      const drift = [];
      for (const field of HTTP_FIELDS) {
        const value = budget[field.measured];
        if (typeof value === "number") fields[field.measured] = value;
        if (
          typeof value === "number" &&
          field.ceiling !== null &&
          (declared === null || typeof declared !== "object" || declared[field.ceiling] !== budget[field.ceiling])
        )
          drift.push(field.ceiling);
      }
      if (drift.length === 0 && Object.keys(fields).length > 0) return { fields, http: existing };
      return {
        fields: {},
        http: {
          ...existing,
          status: "refused",
          reason: `the production probe's declared ceilings do not match: ${[...new Set(drift)].join(", ") || "no measured fields"}`,
        },
      };
    }
  }

  if (measuredSlots.length === 0) {
    const reasons = [...new Set(slots.map((s) => s.reason).filter(Boolean))];
    return {
      fields: {},
      http: {
        status: "unmeasured",
        method: "http-harness",
        reason: reasons.join(" · ") || "the capture holds no slot for this route",
        profiles,
      },
    };
  }

  // A ceiling edited after the capture invalidates the association, not just the comparison.
  const drift = [];
  for (const f of HTTP_FIELDS) {
    for (const s of measuredSlots) {
      if (s[f.declared] !== undefined && s[f.declared] !== budget[f.ceiling])
        drift.push(`${f.ceiling}: capture read ${JSON.stringify(s[f.declared])}, the file now declares ${JSON.stringify(budget[f.ceiling])}`);
    }
  }
  if (drift.length > 0)
    return {
      fields: {},
      http: {
        status: "refused",
        method: "http-harness",
        reason: `the declared ceiling moved after the capture — re-run the harness · ${[...new Set(drift)].join(" · ")}`,
        profiles,
      },
    };

  const fields = {};
  const worstProfile = {};
  for (const f of HTTP_FIELDS) {
    const w = worst(measuredSlots.map((s) => ({ profile: s.profile, value: f.read(s) })));
    if (w === null) continue;
    fields[f.measured] = w.value;
    worstProfile[f.measured] = w.profile;
  }
  const dbCalls = worst(measuredSlots.map((s) => ({ profile: s.profile, value: s.requestDbCalls ?? null })));
  const guc = worst(measuredSlots.map((s) => ({ profile: s.profile, value: s.gucCalls ?? null })));

  return {
    fields,
    http: {
      status: "measured",
      method: "http-harness",
      routeClass: measuredSlots[0].routeClass ?? null,
      scoredAgainstPrdCeiling: measuredSlots[0].scored === true,
      prdCeilingMs: measuredSlots[0].prdCeilingMs ?? null,
      recordedFrom: "the worst measured profile per field — a ceiling is a ceiling",
      worstProfile,
      requestDbCalls: dbCalls?.value ?? null,
      gucCalls: guc?.value ?? null,
      requestDbCallsNote: NEVER_WRITTEN.why,
      downstreamAccountingNote: "Request downstream counts exclude explicitly scoped after-commit work. Deferred calls, failures and destination maxima are recorded separately after a bounded completion drain. Older counting-window captures cannot populate measuredDownstreamCalls.",
      profiles,
    },
  };
}

export function planAll(requestLevel, budgets) {
  const slotsByRoute = new Map();
  for (const slot of Object.values(requestLevel.routes ?? {})) {
    const list = slotsByRoute.get(slot.route) ?? [];
    list.push(slot);
    slotsByRoute.set(slot.route, list);
  }
  const plans = {};
  for (const [key, budget] of Object.entries(budgets)) {
    const slots = slotsByRoute.get(key) ?? [];
    plans[key] = planRoute(key, budget, slots);
  }
  const orphans = [...slotsByRoute.keys()].filter((r) => budgets[r] === undefined);
  return { plans, orphans };
}

export function applyPlans(budgets, plans) {
  let filled = 0;
  let cleared = 0;
  for (const [key, plan] of Object.entries(plans)) {
    const entry = budgets[key];
    if (!entry) continue;
    for (const f of HTTP_FIELDS) {
      const next = plan.fields[f.measured];
      if (next === undefined) {
        if (entry[f.measured] !== null && entry[f.measured] !== undefined) cleared += 1;
        entry[f.measured] = null;
      } else {
        if (entry[f.measured] !== next) filled += 1;
        entry[f.measured] = next;
      }
    }
    entry.httpMeasurement = plan.http;
  }
  return { filled, cleared };
}

export function breachesFrom(budgets) {
  const out = [];
  for (const [key, entry] of Object.entries(budgets)) {
    for (const f of HTTP_FIELDS) {
      const measured = entry[f.measured];
      const ceiling = entry[f.ceiling];
      if (typeof measured !== "number" || typeof ceiling !== "number") continue;
      if (measured > ceiling)
        out.push({ key, field: f.measured, measured, ceiling, profile: entry.httpMeasurement?.worstProfile?.[f.measured] ?? null });
    }
  }
  return out;
}

function coverage(budgets) {
  const keys = Object.keys(budgets);
  const per = {};
  for (const f of HTTP_FIELDS) per[f.measured] = keys.filter((k) => typeof budgets[k][f.measured] === "number").length;
  return { total: keys.length, per };
}

function main() {
  const write = process.argv.includes("--write");
  const check = process.argv.includes("--check");

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const requestLevel = manifest.requestLevel;
  const budgetsText = readFileSync(ROUTE_BUDGETS_PATH, "utf8");
  const contract = JSON.parse(budgetsText);
  const budgets = contract.budgets ?? {};

  const violations = captureViolations(requestLevel);
  if (violations.length > 0) {
    for (const v of violations) process.stderr.write(`[merge-http-route-budgets] REFUSED: ${v}\n`);
    process.exit(2);
  }

  const { plans, orphans } = planAll(requestLevel, budgets);
  for (const o of orphans)
    process.stdout.write(`[merge-http-route-budgets] capture slot with no declared budget: ${o}\n`);

  const before = JSON.stringify(budgets);
  const { filled, cleared } = applyPlans(budgets, plans);
  const changed = JSON.stringify(budgets) !== before;
  const cov = coverage(budgets);
  const breaches = breachesFrom(budgets);

  const measuredRoutes = Object.values(plans).filter((p) => p.http.status === "measured").length;
  const productionProbes = Object.values(plans).filter(
    (p) => p.http.status === "measured" && p.http.method === "production-http-probe",
  ).length;
  process.stdout.write(
    `[merge-http-route-budgets] ${String(measuredRoutes)}/${String(cov.total)} budgets carry an HTTP measurement ` +
      `(${String(filled)} values written, ${String(cleared)} stale values cleared)\n`,
  );
  for (const f of HTTP_FIELDS)
    process.stdout.write(`  ${f.measured}: ${String(cov.per[f.measured])}/${String(cov.total)}\n`);
  process.stdout.write(`  ${NEVER_WRITTEN.field}: NOT written by this instrument — ${NEVER_WRITTEN.why}\n`);
  for (const b of breaches)
    process.stdout.write(
      `  BREACH  ${b.key} ${b.field}=${String(b.measured)} > ${b.field.replace("measured", "max")}=${String(b.ceiling)} (${String(b.profile)})\n`,
    );

  if (check) {
    if (changed) {
      process.stderr.write("[merge-http-route-budgets] contracts/route-budgets.json is out of date with the capture\n");
      process.exit(1);
    }
    process.stdout.write("[merge-http-route-budgets] contracts/route-budgets.json agrees with the capture\n");
    return;
  }

  if (!write) {
    process.stdout.write("[merge-http-route-budgets] dry run — pass --write to fold this into contracts/route-budgets.json\n");
    return;
  }

  contract.measurementMethods = contract.measurementMethods ?? {};
  contract.measurementMethods["http-harness"] = {
    what:
      "Real HTTP requests against a live Nest app on the seeded database as the non-owner app role " +
      "with RLS live and Redis off, timed end to end. " +
      `${String(requestLevel.samples)} samples per read, ${String(requestLevel.writeSamples)} per write, ` +
      `${String(requestLevel.heapSamples)} post-forced-GC heap samples in a separate pass.`,
    populates: HTTP_FIELDS.map((f) => f.measured),
    doesNotPopulate: [NEVER_WRITTEN.field, "measuredBufferBlocks", "measuredReadPathP50Ms", "measuredReadPathP95Ms", "measuredReadPathP99Ms"],
    caveat:
      `${NEVER_WRITTEN.field} is deliberately left to the db-call-count instrument: ${NEVER_WRITTEN.why}. ` +
      "Latency is loopback, single-process, uncompressed and cache-cold, so it excludes pool wait, " +
      "network and gzip — it is a lower bound on production latency and an upper bound on the " +
      "cache-hit path.",
  };
  contract.httpMeasurement = {
    method: "http-harness",
    instrument: requestLevel.instrument,
    command: requestLevel.command,
    takenAt: requestLevel.generatedAt,
    commit: requestLevel.commit,
    workingTreeDirty: requestLevel.workingTreeDirty,
    database: requestLevel.database,
    journalEntries: requestLevel.journalEntries,
    atHead: requestLevel.atHead,
    role: requestLevel.role,
    cache: requestLevel.cache,
    compression: requestLevel.compression ?? null,
    samples: requestLevel.samples,
    writeSamples: requestLevel.writeSamples,
    heapSamples: requestLevel.heapSamples,
    gcAvailable: requestLevel.gcAvailable,
    tenants: (requestLevel.tenants ?? []).map((t) => ({ profile: t.profile, tenant: t.tenant, measured: t.measured, refused: t.refused })),
    ceilingDigest: ceilingDigest(budgets),
    budgetsWithHttpMeasurement: measuredRoutes,
    budgetsDeclared: cov.total,
    fieldCoverage: cov.per,
    mergedBy: "test/perf/merge-http-route-budgets.mjs",
    honesty:
      "Standard measurements came from the capture recorded in contracts/benchmark-manifest.json under `requestLevel`. " +
      `${String(productionProbes)} explicitly tagged production HTTP probe(s) were preserved because no seeded capture slot exists and their recorded ceilings still match. ` +
      "A route the seeded capture declined keeps a null and an httpMeasurement block naming the reason; no field is estimated or filled from a database-side proxy.",
  };
  writeFileSync(ROUTE_BUDGETS_PATH, `${JSON.stringify(contract, null, 2)}\n`);
  process.stdout.write("[merge-http-route-budgets] wrote contracts/route-budgets.json\n");
}

function selfTest() {
  const failures = [];
  const check = (name, cond) => {
    if (!cond) failures.push(name);
  };

  const slot = (over) => ({
    route: "GET /x",
    tenant: "t1",
    profile: "reference",
    routeClass: "list",
    status: "measured",
    scored: true,
    prdCeilingMs: 300,
    declaredLatencyP95Ms: 500,
    declaredDownstreamCalls: 0,
    declaredResponseBytes: 1000,
    declaredMemoryMb: 64,
    samples: 40,
    latencyMs: { p50: 5, p95: 10, p99: 12 },
    requestDbCalls: 12,
    gucCalls: 3,
    downstreamCalls: 0,
    downstreamAccounting: "request-and-after-commit-v1",
    deferredDownstreamCalls: 3,
    deferredFailures: 0,
    responseBytes: 900,
    memoryMb: 3,
    memoryMbPercentiles: { p50: 2, p95: 3, p99: 3, min: 1, max: 3 },
    responseBytesPercentiles: { p50: 800, p95: 900, p99: 900, min: 700, max: 900 },
    overPrdCeiling: false,
    ...over,
  });
  const budget = { maxLatencyP95Ms: 500, maxDownstreamCalls: 0, maxResponseBytes: 1000, maxMemoryMb: 64, maxRequestDbCalls: 20, maxDbCalls: 3, measuredDbCalls: 3 };

  // --- the capture-wide refusals -------------------------------------------------------------
  const goodCapture = {
    method: "http-harness",
    tenants: [{ profile: "reference", scorable: true, controlBeforeOk: true, controlAfterOk: true, subjectStable: true }],
    role: "streamline_app (rolbypassrls = false, RLS live)",
    atHead: true,
    gcAvailable: true,
    routes: { a: slot({}) },
  };
  check("a sound capture has no violations", captureViolations(goodCapture).length === 0);
  check("no requestLevel at all is a refusal", captureViolations(undefined).length === 1);
  check(
    "a tenant whose control probe failed refuses the whole capture",
    captureViolations({ ...goodCapture, tenants: [{ profile: "reference", scorable: false, notScorableBecause: "probe", controlBeforeOk: false, controlAfterOk: true, subjectStable: true }] }).length > 0,
  );
  check(
    "a BYPASSRLS role refuses the capture",
    captureViolations({ ...goodCapture, role: "postgres (rolbypassrls = true)" }).some((v) => v.includes("BYPASSRLS")),
  );
  check("a database off journal head refuses the capture", captureViolations({ ...goodCapture, atHead: false }).some((v) => v.includes("head")));
  check(
    "heap numbers without --expose-gc refuse the capture",
    captureViolations({ ...goodCapture, gcAvailable: false }).some((v) => v.includes("expose-gc")),
  );
  check(
    "a subject that changed shape mid-capture refuses it",
    captureViolations({ ...goodCapture, tenants: [{ profile: "reference", scorable: true, controlBeforeOk: true, controlAfterOk: true, subjectStable: false }] }).length > 0,
  );

  // --- the per-route decision ----------------------------------------------------------------
  const measured = planRoute("GET /x", budget, [slot({})]);
  check("a measured slot fills all thirteen HTTP fields including measuredRequestDbCalls", HTTP_FIELDS.every((f) => typeof measured.fields[f.measured] === "number"));
  check("measuredDbCalls is never among the written fields", measured.fields.measuredDbCalls === undefined);
  check("deferred calls are retained outside the request ceiling", measured.http.profiles.reference.deferredDownstreamCalls === 3 && measured.fields.measuredDownstreamCalls === 0);
  const legacyWindow = planRoute("GET /x", budget, [slot({ downstreamAccounting: undefined, downstreamCalls: 3 })]);
  check("legacy counting-window captures do not populate request downstream measurements", legacyWindow.fields.measuredDownstreamCalls === undefined);
  check("failed after-commit work prevents capture acceptance", captureViolations({ ...goodCapture, routes: { a: slot({ deferredFailures: 1 }) } }).some((issue) => issue.includes("failed after-commit")));
  check("the request statement count is recorded under its own name", measured.http.requestDbCalls === 12);
  check("the tenant-GUC statements stay separate", measured.http.gucCalls === 3);
  check("the note explaining why measuredDbCalls is untouched travels with the entry", measured.http.requestDbCallsNote === NEVER_WRITTEN.why);
  check("measuredRequestDbCalls is written from requestDbCalls so the full request count is compared to maxRequestDbCalls", measured.fields.measuredRequestDbCalls === 12);

  const twoTenants = planRoute("GET /x", budget, [slot({}), slot({ profile: "minority", tenant: "t2", responseBytes: 5000, latencyMs: { p50: 1, p95: 2, p99: 3 } })]);
  check("the WORST profile wins per field, not the reference one", twoTenants.fields.measuredResponseBytes === 5000);
  check("the worst profile is named", twoTenants.http.worstProfile.measuredResponseBytes === "minority");
  check("a field where reference is worst still records reference", twoTenants.http.worstProfile.measuredLatencyP95Ms === "reference");
  check("both profiles are kept in full", Object.keys(twoTenants.http.profiles).length === 2);

  const declined = planRoute("GET /x", budget, [slot({ status: "unmeasured", reason: "route answered HTTP 500", httpStatus: 500 })]);
  check("a declined route writes no measurement", Object.keys(declined.fields).length === 0);
  check("a declined route keeps its stated reason", declined.http.reason.includes("500"));
  check("a declined route is not silently absent", declined.http.status === "unmeasured");

  const noSlot = planRoute("GET /x", budget, []);
  check("a budget the capture never reached is unmeasured, not measured-at-zero", noSlot.http.status === "unmeasured" && Object.keys(noSlot.fields).length === 0);

  const productionProbe = {
    ...budget,
    measuredLatencyP95Ms: 20,
    measuredResponseBytes: 900,
    httpMeasurement: {
      status: "measured",
      method: "production-http-probe",
      recordedFrom: "ten sequential production requests",
      declaredCeilings: { maxLatencyP95Ms: 500, maxResponseBytes: 1000 },
      profiles: { production: { status: "measured", samples: 10 } },
    },
  };
  const preservedProbe = planRoute("GET /x", productionProbe, []);
  check("an explicit production probe survives an older capture with no route slot", preservedProbe.fields.measuredLatencyP95Ms === 20 && preservedProbe.http.method === "production-http-probe");
  const movedProbe = planRoute("GET /x", { ...productionProbe, maxResponseBytes: 999 }, []);
  check("a production probe is refused when its recorded ceiling moves", movedProbe.http.status === "refused" && Object.keys(movedProbe.fields).length === 0);
  const failedProbe = planRoute("GET /x", productionProbe, [slot({ status: "unmeasured", reason: "route answered HTTP 500" })]);
  check("a failed seeded capture supersedes an older production probe", failedProbe.http.status === "unmeasured" && Object.keys(failedProbe.fields).length === 0);

  const moved = planRoute("GET /x", { ...budget, maxResponseBytes: 999999 }, [slot({})]);
  check("a ceiling edited after the capture refuses the association", moved.http.status === "refused");
  check("the refusal names the field whose ceiling moved", moved.http.reason.includes("maxResponseBytes"));
  check("a refused route writes no measurement", Object.keys(moved.fields).length === 0);

  // --- application and reporting -------------------------------------------------------------
  const budgets = { "GET /x": { ...budget, measuredResponseBytes: 123456 } };
  const { plans, orphans } = planAll({ routes: { a: slot({}) } }, budgets);
  applyPlans(budgets, plans);
  check("applying overwrites a stale value rather than keeping the better one", budgets["GET /x"].measuredResponseBytes === 900);
  check("applying leaves measuredDbCalls exactly as it found it", budgets["GET /x"].measuredDbCalls === 3);
  check("orphan capture slots are reported", orphans.length === 0);

  const withOrphan = planAll({ routes: { a: slot({ route: "GET /ghost" }) } }, { "GET /x": { ...budget } });
  check("a capture slot with no declared budget is named", withOrphan.orphans.includes("GET /ghost"));
  check("a budget with no capture slot becomes unmeasured", withOrphan.plans["GET /x"].http.status === "unmeasured");

  const stale = { "GET /x": { ...budget, measuredResponseBytes: 900 } };
  applyPlans(stale, planAll({ routes: { a: slot({ status: "unmeasured", reason: "500" }) } }, stale).plans);
  check("a route that stopped being measurable has its stale number CLEARED, not carried forward", stale["GET /x"].measuredResponseBytes === null);

  const breached = { "GET /x": { ...budget, measuredResponseBytes: 4000, httpMeasurement: { worstProfile: { measuredResponseBytes: "reference" } } } };
  const b = breachesFrom(breached);
  check("a measurement above its declared ceiling is reported as a breach", b.length === 1 && b[0].field === "measuredResponseBytes");
  check("the breach names the profile it came from", b[0].profile === "reference");
  check("a measurement at the ceiling is not a breach", breachesFrom({ "GET /x": { ...budget, measuredResponseBytes: 1000 } }).length === 0);
  check("a null measurement is not a breach", breachesFrom({ "GET /x": { ...budget, measuredResponseBytes: null } }).length === 0);

  check("the ceiling digest ignores measured values", ceilingDigest({ a: { maxDbCalls: 1, measuredDbCalls: 5 } }) === ceilingDigest({ a: { maxDbCalls: 1, measuredDbCalls: 9 } }));
  check("the ceiling digest moves when a ceiling moves", ceilingDigest({ a: { maxDbCalls: 1 } }) !== ceilingDigest({ a: { maxDbCalls: 2 } }));
  check("the ceiling digest is stable across key order", ceilingDigest({ a: { maxDbCalls: 1, maxMemoryMb: 2 } }) === ceilingDigest({ a: { maxMemoryMb: 2, maxDbCalls: 1 } }));

  check("measuredLatencyP50Ms is populated from latencyMs.p50", measured.fields.measuredLatencyP50Ms === 5);
  check("measuredLatencyP99Ms is populated from latencyMs.p99", measured.fields.measuredLatencyP99Ms === 12);
  check("measuredMemoryMbP95 is populated from memoryMbPercentiles.p95", measured.fields.measuredMemoryMbP95 === 3);
  check("measuredResponseBytesP50 is populated from responseBytesPercentiles.p50", measured.fields.measuredResponseBytesP50 === 800);

  const total = 35;
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`  FAIL  ${f}\n`);
    process.stderr.write(`[merge-http-route-budgets] self-test ${String(total - failures.length)}/${String(total)}\n`);
    process.exit(1);
  }
  process.stdout.write(`[merge-http-route-budgets] self-test ${String(total)}/${String(total)}\n`);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
