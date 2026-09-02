#!/usr/bin/env node
/**
 * The noise study: how far a metric moves when NOTHING has changed.
 *
 * This is the part that decides whether the regression gate is usable. A threshold that was chosen
 * rather than measured is a guess, and a guess that is too tight produces alarms nobody acts on
 * after the second week. So every threshold the gate uses comes from here: run the same measurement
 * R times against unchanged code, record the envelope of every metric, and derive the tolerances —
 * including whether the timing metrics get to decide anything at all.
 *
 * The second half is the proof rather than the calibration: replay every replicate against the
 * first one through the REAL decision function and count how many would have failed the build. On
 * unchanged code that number must be zero. It is the only evidence that separates "the gate is
 * calibrated" from "the gate has been described as calibrated".
 */

import { noiseEnvelope, policyFromNoise, FALLBACK_POLICY } from "../../src/scripts/benchmark-regression.mjs";
import { decideBenchmark } from "../../src/scripts/benchmark-regression.mjs";
import { readCostObservation } from "./benchmark-instruments.mjs";

/** The metrics carried from an observation into a comparison. A null is dropped, never zeroed. */
export function pickMetrics(obs) {
  const out = {};
  for (const key of ["bufferBlocks", "resultRows", "scanRows", "planSignature", "p50Ms", "p95Ms", "p99Ms"])
    if (obs[key] !== undefined && obs[key] !== null) out[key] = obs[key];
  return out;
}

export function runNoiseStudy({ readCostRuns, planSigRuns = {}, planningRuns = {}, budgets, tenants, replicates, log = () => {} }) {
  // ── how far did each metric move across replicates of unchanged code?
  const perBenchmarkCv = {};
  const detEnvelopes = [];
  const timingEnvelopes = [];
  const noiseRows = [];
  const stabilitySeries = {};
  const trackStability = (metric, envelope) => {
    if (!envelope || !Number.isFinite(envelope.maxRelSwing)) return;
    (stabilitySeries[metric] ??= []).push(envelope.maxRelSwing);
  };
  if (replicates > 1) {
    for (const tenant of tenants) {
      for (const budget of budgets) {
        const obs = readCostRuns[tenant.label]
          .map((doc) => readCostObservation(doc.budgets.find((b) => b.id === budget.id)))
          .filter((o) => o.status === "measured");
        if (obs.length < replicates) continue;
        const buf = noiseEnvelope(obs.map((o) => o.bufferBlocks));
        const rows = noiseEnvelope(obs.map((o) => o.resultRows));
        const p95 = noiseEnvelope(obs.map((o) => o.p95Ms));
        const p50 = noiseEnvelope(obs.map((o) => o.p50Ms));
        const p99 = noiseEnvelope(obs.map((o) => o.p99Ms));
        const cold = noiseEnvelope(obs.map((o) => o.coldMs));
        detEnvelopes.push(buf, rows);
        timingEnvelopes.push(p95, p50);
        trackStability("bufferBlocks", buf);
        trackStability("resultRows", rows);
        trackStability("p50Ms", p50);
        trackStability("p95Ms", p95);
        trackStability("p99Ms", p99);
        trackStability("coldMs", cold);
        const planBlocks = Array.from({ length: replicates }, (_, i) => planningRuns[tenant.label]?.[i]?.[budget.id]);
        let planningEnvelope = null;
        if (planBlocks.every((v) => typeof v === "number")) {
          planningEnvelope = noiseEnvelope(planBlocks);
          detEnvelopes.push(planningEnvelope);
          trackStability("planningBufferBlocks", planningEnvelope);
        }
        const key = `${budget.id}@${tenant.label}`;
        perBenchmarkCv[key] = { p50Ms: p50.cv, p95Ms: p95.cv, p99Ms: p95.cv };
        if (tenant.label === "large") perBenchmarkCv[budget.id] = perBenchmarkCv[key];
        noiseRows.push({
          id: budget.id,
          tenant: tenant.label,
          bufferBlocks: { values: obs.map((o) => o.bufferBlocks), maxAbsSwing: buf.maxAbsSwing, maxRelSwing: buf.maxRelSwing },
          resultRows: { values: obs.map((o) => o.resultRows), maxAbsSwing: rows.maxAbsSwing },
          p95Ms: { values: obs.map((o) => o.p95Ms), cv: p95.cv, maxRelSwing: p95.maxRelSwing },
          ...(planningEnvelope
            ? { planningBufferBlocks: { values: planBlocks, maxAbsSwing: planningEnvelope.maxAbsSwing } }
            : {}),
        });
      }
    }
  }
  // Plan-shape stability: did the dominant plan node stay the same across replicates of unchanged
  // code? An exact ratchet on a metric that moves by itself is a false-alarm generator, so this
  // decides whether the plan ratchet is armed at all.
  let planStability = null;
  if (replicates > 1) {
    let pairs = 0;
    let unstable = 0;
    const unstableIds = [];
    for (const tenant of tenants) {
      const runs = planSigRuns[tenant.label] ?? [];
      if (runs.length < replicates) continue;
      for (const budget of budgets) {
        const seen = runs.map((r) => r[budget.id]);
        if (seen.some((x) => x === undefined)) continue;
        pairs++;
        if (new Set(seen).size > 1) {
          unstable++;
          if (unstableIds.length < 12) unstableIds.push(`${budget.id}@${tenant.label}: ${[...new Set(seen)].join(" | ")}`);
        }
      }
    }
    planStability = { pairs, unstable, unstableIds };
    log(`plan-shape stability: ${unstable} of ${pairs} benchmark×tenant pairs changed shape with no code change`);
  }

  const policy =
    replicates > 1
      ? policyFromNoise({
          deterministicEnvelopes: detEnvelopes,
          timingEnvelopes,
          exactStability: planStability ? { planSignature: planStability } : null,
          replicates,
        })
      : { ...FALLBACK_POLICY };

  // ── the false-positive proof: replay every replicate against the first one through the real gate
  let falsePositives = null;
  if (replicates > 1) {
    let comparisons = 0;
    let fired = 0;
    const firedIds = [];
    for (const tenant of tenants) {
      const runs = readCostRuns[tenant.label];
      for (let r = 1; r < runs.length; r++) {
        for (const budget of budgets) {
          const base = readCostObservation(runs[0].budgets.find((b) => b.id === budget.id));
          const obs = readCostObservation(runs[r].budgets.find((b) => b.id === budget.id));
          if (base.status !== "measured" || obs.status !== "measured") continue;
          comparisons++;
          const row = noiseRows.find((r) => r.id === budget.id && r.tenant === tenant.label);
          const stability = row
            ? {
                bufferBlocks: { maxAbsSwing: row.bufferBlocks.maxAbsSwing, replicates },
                resultRows: { maxAbsSwing: row.resultRows.maxAbsSwing, replicates },
                planSignature: {
                  maxAbsSwing: (planStability?.unstableIds ?? []).some((l) => l.startsWith(`${budget.id}@${tenant.label}:`)) ? 1 : 0,
                  replicates,
                },
              }
            : null;
          if (!stability) continue;
          const d = decideBenchmark({
            baseline: pickMetrics(base),
            observed: pickMetrics(obs),
            cv: perBenchmarkCv[`${budget.id}@${tenant.label}`] ?? {},
            policy,
            stability,
          });
          if (d.fired) {
            fired++;
            firedIds.push(
              `${budget.id}@${tenant.label}: ${d.findings.filter((f) => f.fired).map((f) => f.detail).join("; ")}`,
            );
          }
        }
      }
    }
    falsePositives = {
      comparisons,
      fired,
      rate: comparisons === 0 ? null : Math.round((fired / comparisons) * 10000) / 10000,
      detail: firedIds,
      what:
        "Every replicate of UNCHANGED code, on every tenant, replayed against replicate 1 through " +
        "the real gate. Anything above zero is a gate that will be muted within a week.",
    };
    log(`noise study: ${comparisons} unchanged-code comparisons, ${fired} would have failed the gate`);
  }


  return { policy, perBenchmarkCv, noiseRows, stabilitySeries, falsePositives, planStability };
}
