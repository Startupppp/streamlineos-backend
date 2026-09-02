#!/usr/bin/env node
/**
 * The instrument drivers behind the benchmark manifest: the two existing measurement tools, run as
 * child processes, and the extraction of their JSON into the ratchet inputs the gate compares.
 *
 * Extraction is where a manifest quietly stops being honest, so each rule is here and nowhere else:
 *   - a budget the runner marked FAIL is still a MEASUREMENT and still populates the ratchet;
 *   - a budget that ERRORED never becomes a measurement, at any confidence;
 *   - a budget that returned zero rows is VACUOUS — every ceiling it declares is satisfied
 *     trivially, so it is reported as measuring nothing rather than as passing;
 *   - the WARM buffer count is what ratchets, because the cold one is a statement about the page
 *     cache and not about the query.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STATEMENT_CEILING_MS } from "./benchmark-modules.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const BACKEND_ROOT = resolve(HERE, "..", "..");
export const PLAN_DIR = join(BACKEND_ROOT, "test", "perf", "benchmark-plans");
const ROUTE_BUDGETS_PATH = join(BACKEND_ROOT, "contracts", "route-budgets.json");

/**
 * Ticket 22's counted database-statement figures, indexed by the read-cost budget they hang off.
 * Read-only: route-budgets.json is ticket 22's artefact and is never written here. A COUNTED figure
 * is carried into this manifest as a ratchet input; a DEFAULT ceiling is carried as a label and
 * explicitly not as a measurement, because a placeholder wearing a number's clothes is the exact
 * shape of a gate that guards nothing.
 */
export function routeBudgetsByReadCostId() {
  if (!existsSync(ROUTE_BUDGETS_PATH)) return {};
  const doc = JSON.parse(readFileSync(ROUTE_BUDGETS_PATH, "utf8"));
  const out = {};
  for (const [key, b] of Object.entries(doc.budgets ?? {})) {
    if (!b.readCostBudgetId) continue;
    (out[b.readCostBudgetId] ??= []).push({
      route: key,
      maxDbCalls: b.maxDbCalls,
      dbCallBasis: b.dbCallBasis ?? null,
      measuredDbCalls: b.measuredDbCalls ?? null,
      dbCallMeasurement: b.dbCallMeasurement ?? null,
      maxLatencyP95Ms: b.maxLatencyP95Ms ?? null,
      measuredLatencyP95Ms: b.measuredLatencyP95Ms ?? null,
    });
  }
  return out;
}

/** One read-cost run for one tenant, via the existing runner. Exit 1 means breaches, not failure. */
export function runReadCost({ tenant, samples, outFile, env }) {
  const profile = tenant.label === "large" ? "reference" : "minority";
  try {
    execFileSync(
      process.execPath,
      [
        join(BACKEND_ROOT, "src", "scripts", "run-read-cost-budgets.mjs"),
        `--samples=${samples}`,
        `--profile=${profile}`,
        `--json=${outFile}`,
      ],
      { cwd: BACKEND_ROOT, env: { ...env, SEED_ORG_ID: tenant.id }, stdio: "pipe" },
    );
  } catch (e) {
    if (!existsSync(outFile)) throw new Error(`read-cost runner produced no JSON for ${tenant.label}: ${e.message}`);
  }
  return JSON.parse(readFileSync(outFile, "utf8"));
}

/** Heavy-query plans for one org label. Retains the plan text on disk; returns the JSON summary. */
export function runHeavyQueries({ orgLabel, env }) {
  mkdirSync(PLAN_DIR, { recursive: true });
  try {
    execFileSync(
      process.execPath,
      [join(BACKEND_ROOT, "test", "perf", "measure-heavy-query-plans.mjs"), `--org=${orgLabel}`, `--out=${PLAN_DIR}`],
      { cwd: BACKEND_ROOT, env, stdio: "pipe" },
    );
  } catch (e) {
    if (!existsSync(join(PLAN_DIR, `plans-${orgLabel}.json`)))
      throw new Error(`heavy-query runner produced no JSON for ${orgLabel}: ${e.message}`);
  }
  return JSON.parse(readFileSync(join(PLAN_DIR, `plans-${orgLabel}.json`), "utf8"));
}

/** The ratchet inputs, extracted from a read-cost record. `null` where the instrument cannot say. */
export function readCostObservation(rec) {
  if (!rec) return { status: "absent" };
  if (rec.outcome === "skip") return { status: "unmeasured", reason: rec.reason ?? "skipped" };
  if (rec.outcome === "error") return { status: "error", reason: rec.reason };
  if (rec.outcome === "unmeasured")
    return { status: "unmeasured", reason: rec.reason ?? (rec.vacuous ? "vacuous" : "below seed floor") };
  if (rec.blocks === undefined) return { status: "unmeasured", reason: rec.reason ?? "no plan captured" };
  return {
    status: rec.vacuous ? "vacuous" : "measured",
    bufferBlocks: rec.warmBlocks ?? rec.blocks,
    coldBufferBlocks: rec.blocks,
    resultRows: rec.resultRows,
    tenantRows: rec.tenantRows,
    p50Ms: rec.latency?.p50Ms ?? null,
    p95Ms: rec.latency?.p95Ms ?? null,
    p99Ms: rec.latency?.p99Ms ?? null,
    coldMs: rec.coldMs ?? null,
    readCostCeilingBlocks: rec.ceiling ?? null,
    readCostOutcome: rec.outcome,
    planAssertionFailures: rec.assertionFailures ?? [],
    scanRowViolations: rec.scanRowViolations ?? [],
  };
}

export function heavyObservation(rec) {
  if (!rec) return { status: "absent" };
  if (rec.status !== "measured") return { status: "unmeasured", reason: rec.reason ?? rec.status };
  const d = rec.cold.dominant ?? {};
  return {
    status: "measured",
    bufferBlocks: rec.warm.buffers,
    coldBufferBlocks: rec.cold.buffers,
    resultRows: rec.cold.rowsReturned,
    scanRows: rec.cold.rowsRead,
    p50Ms: rec.warm.executionMs,
    p95Ms: null,
    p99Ms: null,
    coldMs: rec.cold.executionMs,
    planSignature: `${d.type ?? "?"}${d.relation ? ` on ${d.relation}` : ""}${d.index ? ` via ${d.index}` : ""}`,
  };
}

export function ceilingFor(spec) {
  return STATEMENT_CEILING_MS[spec.class];
}

export function statementVerdict(spec, obs) {
  if (!obs || obs.status !== "measured" || obs.p95Ms === null || obs.p95Ms === undefined)
    return { verdict: "unmeasured" };
  const ceiling = ceilingFor(spec);
  return { verdict: obs.p95Ms <= ceiling ? "within" : "over", ceilingMs: ceiling, p95Ms: obs.p95Ms };
}

