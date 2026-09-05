#!/usr/bin/env node
/**
 * The regression decision for the benchmark manifest — the part that decides whether a movement is
 * a REGRESSION or is NOISE.
 *
 * A gate that fires on ordinary variance is muted within a week, which is worse than no gate. So the
 * decision is split by what the metric actually is, and nothing here is a guessed threshold:
 *
 *   EXACT metrics        — result rows, database-call counts, the dominant plan node. A change means
 *                          the query changed shape. Any movement fires. No tolerance.
 *   DETERMINISTIC metrics— shared buffer blocks. The same statement over the same rows touches the
 *                          same pages; run-to-run drift comes only from what the cache already holds.
 *                          Tolerance is taken from a measured replicate envelope, not asserted.
 *   TIMING metrics       — execution milliseconds. On loopback Postgres these are dominated by
 *                          scheduler and cache noise. A timing move alone is not evidence.
 *
 * The timing rule, stated once:
 *
 *   band  = baseline * (1 + max(minRelTol, k * cv))
 *   fires = observed > band
 *           AND observed - baseline > absFloorMs
 *           AND (a deterministic metric on the same benchmark also moved  OR  observed > baseline * hardMultiple)
 *
 * `cv` is the coefficient of variation measured across replicates of UNCHANGED code, so the band is
 * the workload's own dispersion rather than a number someone liked. The corroboration clause is the
 * important half: a wall-clock move with unchanged buffers, unchanged rows and an unchanged plan has
 * no mechanism behind it, and on this harness it is the overwhelmingly common case. `hardMultiple`
 * keeps a genuine order-of-magnitude blow-up from hiding behind that clause.
 *
 * AND THE RULE ABOVE MAY NOT APPLY AT ALL. If the replicate study says unchanged code moves further
 * than `TIMING_ARM_THRESHOLD`, the timing metrics are DISARMED: still measured, still printed, but
 * they do not decide the exit code. Measured on the seeded perf database, buffers and row counts
 * moved by exactly zero across three replicates of all 70 read paths, while the wall-clock p95 of the
 * same statements moved by up to 200% and p99 by up to 396% — so on that harness the arming decision
 * is made for us. Count things; do not time them.
 *
 * Usage: imported by test/perf/measure-benchmark-manifest.mjs and
 *        src/scripts/check-benchmark-manifest.mjs. `node src/scripts/benchmark-regression.mjs
 *        --self-test` runs the proofs.
 */

export const METRICS = {
  resultRows: { kind: "exact", label: "rows returned", direction: "any" },
  measuredDbCalls: { kind: "exact", label: "database statements", direction: "up" },
  planSignature: { kind: "exact", label: "dominant plan node", direction: "any" },
  bufferBlocks: { kind: "deterministic", label: "shared buffer blocks", direction: "up" },
  planningBufferBlocks: { kind: "deterministic", label: "planning buffer blocks", direction: "up" },
  scanRows: { kind: "deterministic", label: "rows scanned", direction: "up" },
  p50Ms: { kind: "timing", label: "statement p50", direction: "up" },
  p95Ms: { kind: "timing", label: "statement p95", direction: "up" },
  p99Ms: { kind: "timing", label: "statement p99", direction: "up" },
};

/**
 * Thresholds. Every number here is overwritten from the replicate study by
 * `policyFromNoise()`; these are only the fallbacks used before a study exists, and the manifest
 * records which of the two it used.
 */
export const FALLBACK_POLICY = {
  deterministic: { relTol: 0.05, absTol: 4 },
  timing: { k: 3, minRelTol: 0.25, absFloorMs: 1, hardMultiple: 2, corroborationRequired: true, armed: false },
  provenance: "fallback — no replicate study on record",
};

/**
 * A timing metric is ARMED only if the measured run-to-run swing of unchanged code is below this.
 * Above it, the noise floor is wider than any regression worth catching, so an armed timing gate
 * would be a coin flip; the metric is still recorded and still reported, it simply does not decide
 * the exit code. Nothing here is a judgement call at review time — `policyFromNoise` arms or
 * disarms from the replicate data, so a quieter machine arms it automatically.
 */
export const TIMING_ARM_THRESHOLD = 0.25;

export function percentile(sortedAsc, q) {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(q * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

export function summarise(values) {
  const clean = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (clean.length === 0) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  const variance =
    clean.length < 2 ? 0 : clean.reduce((a, b) => a + (b - mean) ** 2, 0) / (clean.length - 1);
  const sd = Math.sqrt(variance);
  return {
    n: clean.length,
    min: round4(sorted[0]),
    p50: round4(percentile(sorted, 0.5)),
    p95: round4(percentile(sorted, 0.95)),
    p99: round4(percentile(sorted, 0.99)),
    max: round4(sorted[sorted.length - 1]),
    mean: round4(mean),
    sd: round4(sd),
    cv: mean === 0 ? 0 : round4(sd / mean),
  };
}

function round4(n) {
  return typeof n === "number" ? Math.round(n * 10000) / 10000 : n;
}

/**
 * The noise envelope of one metric across R independent replicates of unchanged code.
 * `maxRelSwing` is the largest replicate-to-replicate gap as a fraction of the smallest value —
 * the number a tolerance has to clear if the gate is not to fire on a rerun.
 */
export function noiseEnvelope(replicateValues) {
  const s = summarise(replicateValues);
  if (!s) return null;
  const maxRelSwing = s.min === 0 ? (s.max === 0 ? 0 : Infinity) : round4((s.max - s.min) / s.min);
  return { ...s, maxAbsSwing: round4(s.max - s.min), maxRelSwing };
}

/**
 * Turn a set of measured envelopes into the gate's thresholds.
 *
 * Deterministic: the tolerance is the WORST replicate swing observed, plus one, so a rerun of
 * unchanged code cannot fire. If nothing ever moved, the tolerance collapses to zero and the metric
 * becomes an exact ratchet — the strongest form, and one that has to be earned by measurement.
 *
 * Timing: `minRelTol` is the worst relative swing observed across replicates, floored at 0.10 so a
 * quiet machine cannot mint a hair-trigger. `k` multiplies each benchmark's own cv on top.
 */
export function policyFromNoise({ deterministicEnvelopes, timingEnvelopes, exactStability, replicates }) {
  const detAbs = deterministicEnvelopes.map((e) => e.maxAbsSwing).filter((n) => Number.isFinite(n));
  const detRel = deterministicEnvelopes.map((e) => e.maxRelSwing).filter((n) => Number.isFinite(n));
  const timeRel = timingEnvelopes.map((e) => e.maxRelSwing).filter((n) => Number.isFinite(n));
  const worstDetAbs = detAbs.length ? Math.max(...detAbs) : 0;
  const worstDetRel = detRel.length ? Math.max(...detRel) : 0;
  const worstTimeRel = timeRel.length ? Math.max(...timeRel) : 0;
  return {
    deterministic: {
      relTol: round4(worstDetRel),
      absTol: worstDetAbs === 0 ? 0 : Math.ceil(worstDetAbs) + 1,
    },
    timing: {
      k: 3,
      minRelTol: round4(Math.max(0.1, worstTimeRel)),
      absFloorMs: 1,
      hardMultiple: 2,
      corroborationRequired: true,
      armed: worstTimeRel <= TIMING_ARM_THRESHOLD,
      disarmedBecause:
        worstTimeRel <= TIMING_ARM_THRESHOLD
          ? null
          : `unchanged code moved by up to ${(worstTimeRel * 100).toFixed(0)}% between replicates on this ` +
            `harness, against a ${(TIMING_ARM_THRESHOLD * 100).toFixed(0)}% arming threshold. A gate with a ` +
            `noise floor that wide cannot distinguish a regression from a rerun, so timing is recorded and ` +
            `reported but does not decide the exit code. Buffers, rows, plan shape and statement counts do.`,
    },
    exact: {
      planSignatureArmed: !exactStability || exactStability.planSignature?.unstable === 0,
      planSignatureStability: exactStability?.planSignature ?? null,
      disarmedBecause:
        exactStability && exactStability.planSignature?.unstable > 0
          ? `the dominant plan node changed on its own across replicates for ` +
            `${exactStability.planSignature.unstable} of ${exactStability.planSignature.pairs} benchmark×tenant ` +
            `pairs with no code change, so an exact ratchet on it would fire on a rerun. Recorded and ` +
            `reported, but it does not decide the exit code until the instability is understood.`
          : null,
    },
    deterministicIsGlobalFallback:
      "policy.deterministic is derived from the WORST swing across every benchmark and is only used " +
      "where a per-benchmark stability record is missing. The gate prefers each benchmark's own " +
      "envelope, because one unstable benchmark must not widen the band for the rest.",
    provenance:
      `derived from ${replicates} replicates of unchanged code: worst deterministic swing ` +
      `${worstDetAbs} absolute / ${(worstDetRel * 100).toFixed(1)}%, worst timing swing ` +
      `${(worstTimeRel * 100).toFixed(1)}%`,
  };
}

/**
 * Decide one metric on one benchmark.
 *
 * `cv` is that benchmark's own measured coefficient of variation for the metric, when the manifest
 * carries one; without it the policy's floor alone applies. `corroborated` says whether a
 * deterministic or exact metric on the SAME benchmark already fired.
 */
export function decideRegression({
  metric,
  baseline,
  observed,
  cv = 0,
  policy,
  corroborated = false,
  stability = null,
}) {
  const spec = METRICS[metric];
  if (!spec) return { fired: false, verdict: "unknown-metric", detail: `no metric named "${metric}"` };
  if (baseline === null || baseline === undefined)
    return { fired: false, verdict: "no-baseline", detail: "nothing recorded to compare against" };
  if (observed === null || observed === undefined)
    return { fired: false, verdict: "unmeasured", detail: "no observation" };

  // PER-BENCHMARK stability, not a global tolerance.
  //
  // The first version derived one tolerance from the WORST swing across every benchmark, which is
  // how a single wobbly benchmark destroys the ratchet for all the others: measured here, two
  // date-relative reads moved their row counts between replicates and the global buffer tolerance
  // went from 0 blocks to 2,314. A 2,314-block allowance is not a ratchet. So the tolerance is that
  // benchmark's OWN measured envelope, and a benchmark whose exact metric moved on its own is
  // excluded from that metric rather than allowed to widen everyone else's.
  const own = stability?.[metric];
  if (spec.kind !== "timing" && own && own.maxAbsSwing > 0)
    return {
      fired: false,
      verdict: observed === baseline ? "within" : "advisory",
      detail:
        `${spec.label} ${String(baseline)} -> ${String(observed)}. NOT RATCHETED on this benchmark: ` +
        `it moved by ${own.maxAbsSwing} on its own across ${own.replicates ?? "the"} replicates of ` +
        `unchanged code, so a ratchet here would fire on a rerun. Recorded and reported.`,
    };
  if (spec.kind !== "timing" && stability && !own)
    return {
      fired: false,
      verdict: observed === baseline ? "within" : "advisory",
      detail:
        `${spec.label} ${String(baseline)} -> ${String(observed)}. NOT RATCHETED: the replicate study ` +
        `never measured this metric on this benchmark, and a gate may only ratchet what its noise ` +
        `study covered.`,
    };

  if (spec.kind === "exact") {
    if (metric === "planSignature" && policy.exact?.planSignatureArmed === false)
      return {
        fired: false,
        verdict: observed === baseline ? "within" : "advisory",
        detail:
          `${spec.label} ${String(baseline)} -> ${String(observed)}. The plan-shape ratchet is ` +
          `DISARMED: ${policy.exact.disarmedBecause}`,
      };
    if (spec.direction === "up" && typeof observed === "number" && observed <= baseline)
      return { fired: false, verdict: "within", detail: `${observed} <= ${baseline}` };
    const same = observed === baseline;
    return same
      ? { fired: false, verdict: "within", detail: `unchanged (${String(baseline)})` }
      : {
          fired: true,
          verdict: "regressed",
          detail: `${spec.label} changed ${String(baseline)} -> ${String(observed)} (exact ratchet, no tolerance)`,
        };
  }

  if (spec.kind === "deterministic") {
    // A per-benchmark record wins over the global fallback. Reaching here with one means it moved by
    // zero, so the allowance is zero: this benchmark earned an exact ratchet and does not inherit
    // another benchmark's instability.
    const { relTol, absTol } = own ? { relTol: 0, absTol: 0 } : policy.deterministic;
    const source = own ? "this benchmark's own zero-movement envelope" : "the global fallback envelope";
    const allowance = Math.max(absTol, baseline * relTol);
    const band = baseline + allowance;
    if (observed <= band)
      return {
        fired: false,
        verdict: "within",
        detail: `${observed} <= ${round4(band)} (baseline ${baseline} + max(${absTol}, ${relTol * 100}%) from ${source})`,
      };
    return {
      fired: true,
      verdict: "regressed",
      detail:
        `${spec.label} ${baseline} -> ${observed}, above the ${round4(band)} band from ${source}`,
    };
  }

  const { k, minRelTol, absFloorMs, hardMultiple, corroborationRequired } = policy.timing;
  // Per-benchmark timing arming: stability.timingArmed overrides the global policy when set.
  // A benchmark whose own replicate envelope is quiet arms itself; a noisy one self-disarms.
  // This lets a single wobbly benchmark disarm only itself, not the whole gate.
  const armed = stability?.timingArmed !== undefined ? stability.timingArmed : policy.timing.armed;
  const disarmedBecause =
    stability?.timingArmed !== undefined ? stability.timingDisarmedBecause : policy.timing.disarmedBecause;
  if (armed === false)
    return {
      fired: false,
      verdict: observed > baseline ? "advisory" : "within",
      detail:
        `${spec.label} ${baseline} -> ${observed} ms. Timing is DISARMED${stability?.timingArmed !== undefined ? " on this benchmark" : " on this harness"}: ` +
        `${disarmedBecause ?? "no replicate study has armed it"}`,
    };
  const rel = Math.max(minRelTol, k * cv);
  const band = baseline * (1 + rel);
  if (observed <= band)
    return {
      fired: false,
      verdict: "within",
      detail: `${observed} <= ${round4(band)} ms (baseline ${baseline} + max(${(minRelTol * 100).toFixed(0)}%, ${k}·cv ${(cv * 100).toFixed(1)}%))`,
    };
  if (observed - baseline <= absFloorMs)
    return {
      fired: false,
      verdict: "below-floor",
      detail: `+${round4(observed - baseline)} ms is under the ${absFloorMs} ms floor — not actionable on loopback Postgres`,
    };
  if (corroborationRequired && !corroborated && observed < baseline * hardMultiple)
    return {
      fired: false,
      verdict: "uncorroborated",
      detail:
        `${spec.label} ${baseline} -> ${observed} ms clears the band, but buffers, rows and plan are ` +
        `unchanged, so there is no mechanism behind it. Reported, not failed.`,
    };
  return {
    fired: true,
    verdict: "regressed",
    detail:
      `${spec.label} ${baseline} -> ${observed} ms, above the ${round4(band)} ms band` +
      (corroborated ? " and corroborated by a deterministic metric" : ` and over ${hardMultiple}× baseline`),
  };
}

/**
 * Decide a whole benchmark. Deterministic and exact metrics are decided first so their outcome can
 * corroborate a timing move — the ordering is the rule, not an implementation detail.
 */
export function decideBenchmark({ baseline, observed, cv = {}, policy, stability = null }) {
  const findings = [];
  let corroborated = false;
  const order = Object.keys(METRICS).sort((a, b) => rank(a) - rank(b));
  for (const metric of order) {
    if (!(metric in baseline)) continue;
    const d = decideRegression({
      metric,
      baseline: baseline[metric],
      observed: observed[metric],
      cv: cv[metric] ?? 0,
      policy,
      corroborated,
      stability,
    });
    if (d.verdict === "unknown-metric" || d.verdict === "no-baseline") continue;
    findings.push({ metric, ...d });
    if (d.fired && METRICS[metric].kind !== "timing") corroborated = true;
  }
  return { fired: findings.some((f) => f.fired), corroborated, findings };
}

function rank(metric) {
  const kind = METRICS[metric].kind;
  return kind === "exact" ? 0 : kind === "deterministic" ? 1 : 2;
}

export function selfTest() {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? "[pass]" : "[FAIL]"} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  const policy = policyFromNoise({
    deterministicEnvelopes: [noiseEnvelope([100, 100, 101]), noiseEnvelope([2838, 2838, 2838])],
    timingEnvelopes: [noiseEnvelope([5.0, 5.4, 6.2])],
    replicates: 3,
  });
  check(
    "policy is derived from the replicate envelope, not hardcoded",
    policy.deterministic.absTol === 2 && policy.timing.minRelTol === 0.24,
    `absTol=${policy.deterministic.absTol} minRelTol=${policy.timing.minRelTol}`,
  );

  const zeroSwing = policyFromNoise({
    deterministicEnvelopes: [noiseEnvelope([2838, 2838, 2838])],
    timingEnvelopes: [noiseEnvelope([5, 5, 5])],
    replicates: 3,
  });
  check(
    "a metric that never moved across replicates becomes an EXACT ratchet",
    zeroSwing.deterministic.absTol === 0 && zeroSwing.deterministic.relTol === 0,
    `absTol=${zeroSwing.deterministic.absTol}`,
  );

  check(
    "an added database statement fires with no tolerance",
    decideRegression({ metric: "measuredDbCalls", baseline: 4, observed: 5, policy }).fired,
  );
  check(
    "a removed database statement does not fire",
    !decideRegression({ metric: "measuredDbCalls", baseline: 5, observed: 4, policy }).fired,
  );
  check(
    "a plan flip fires with no tolerance",
    decideRegression({
      metric: "planSignature",
      baseline: "Index Scan on notifications via idx_a",
      observed: "Seq Scan on notifications",
      policy,
    }).fired,
  );
  check(
    "a buffer increase inside the measured band does not fire",
    !decideRegression({ metric: "bufferBlocks", baseline: 2838, observed: 2840, policy }).fired,
  );
  check(
    "a buffer increase outside the measured band fires",
    decideRegression({ metric: "bufferBlocks", baseline: 2838, observed: 3400, policy }).fired,
  );

  check(
    "a 40% wall-clock jump with nothing else moving is reported, NOT failed",
    decideRegression({ metric: "p95Ms", baseline: 5, observed: 7, cv: 0.02, policy }).verdict ===
      "uncorroborated",
  );
  check(
    "the same jump WITH a deterministic metric moved does fire",
    decideRegression({ metric: "p95Ms", baseline: 5, observed: 7, cv: 0.02, policy, corroborated: true })
      .fired,
  );
  check(
    "a 3× wall-clock blow-up fires even uncorroborated",
    decideRegression({ metric: "p95Ms", baseline: 5, observed: 16, cv: 0.02, policy }).fired,
  );
  check(
    "sub-millisecond movement never fires",
    !decideRegression({ metric: "p95Ms", baseline: 0.19, observed: 0.9, cv: 0, policy, corroborated: true })
      .fired,
  );
  check(
    "a benchmark's own high cv widens its band",
    !decideRegression({ metric: "p95Ms", baseline: 5, observed: 9, cv: 0.3, policy, corroborated: true })
      .fired,
    "k·cv = 90% > the 24% floor",
  );
  check("a study inside the arming threshold arms the timing gate", policy.timing.armed === true);
  check(
    "plan shape is armed when it never moved across replicates",
    policyFromNoise({
      deterministicEnvelopes: [noiseEnvelope([1, 1, 1])],
      timingEnvelopes: [noiseEnvelope([1, 1, 1])],
      exactStability: { planSignature: { pairs: 154, unstable: 0 } },
      replicates: 3,
    }).exact.planSignatureArmed === true,
  );
  const wobblyPlan = policyFromNoise({
    deterministicEnvelopes: [noiseEnvelope([1, 1, 1])],
    timingEnvelopes: [noiseEnvelope([1, 1, 1])],
    exactStability: { planSignature: { pairs: 154, unstable: 7 } },
    replicates: 3,
  });
  check(
    "plan shape is DISARMED when it moved on its own, rather than shipped as an exact ratchet",
    wobblyPlan.exact.planSignatureArmed === false &&
      decideRegression({
        metric: "planSignature",
        baseline: "Index Scan on x via i",
        observed: "Seq Scan on x",
        policy: wobblyPlan,
      }).verdict === "advisory",
  );

  const noisy = policyFromNoise({
    deterministicEnvelopes: [noiseEnvelope([2838, 2838, 2838])],
    timingEnvelopes: [noiseEnvelope([3, 5, 10])],
    replicates: 3,
  });
  check(
    "a study outside the arming threshold DISARMS the timing gate automatically",
    noisy.timing.armed === false && typeof noisy.timing.disarmedBecause === "string",
    `worst swing 233% > ${TIMING_ARM_THRESHOLD * 100}%`,
  );
  check(
    "a disarmed timing metric never fires, however large the movement",
    !decideRegression({ metric: "p95Ms", baseline: 5, observed: 500, cv: 0, policy: noisy, corroborated: true })
      .fired,
  );
  check(
    "a disarmed timing metric is still REPORTED as advisory rather than silently dropped",
    decideRegression({ metric: "p95Ms", baseline: 5, observed: 500, cv: 0, policy: noisy }).verdict ===
      "advisory",
  );
  check(
    "per-benchmark timing: quiet own envelope arms timing even when the global policy is disarmed",
    decideRegression({
      metric: "p95Ms", baseline: 5, observed: 20, cv: 0.02, policy: noisy, corroborated: true,
      stability: { timingArmed: true, timingDisarmedBecause: null },
    }).fired,
    "own envelope was quiet — fires despite globally noisy harness",
  );
  check(
    "per-benchmark timing: noisy own envelope disarms the benchmark even when the global policy is armed",
    !decideRegression({
      metric: "p95Ms", baseline: 5, observed: 20, cv: 0.02, policy, corroborated: true,
      stability: { timingArmed: false, timingDisarmedBecause: "own p95 moved 140% across 3 replicates" },
    }).fired,
  );
  check(
    "per-benchmark disarmed timing is always an advisory, never silently dropped",
    decideRegression({
      metric: "p95Ms", baseline: 5, observed: 20, cv: 0, policy,
      stability: { timingArmed: false, timingDisarmedBecause: "noise" },
    }).verdict === "advisory",
  );
  check(
    "disarming timing does not disarm the deterministic ratchet",
    decideRegression({ metric: "bufferBlocks", baseline: 2838, observed: 2839, policy: noisy }).fired,
    "zero measured swing means zero tolerance",
  );

  const seq = decideBenchmark({
    baseline: { bufferBlocks: 100, resultRows: 50, p95Ms: 5 },
    observed: { bufferBlocks: 4000, resultRows: 50, p95Ms: 40 },
    policy,
  });
  check(
    "deterministic metrics are decided before timing, so they can corroborate",
    seq.corroborated && seq.findings.filter((f) => f.fired).length === 2,
    `${seq.findings.filter((f) => f.fired).map((f) => f.metric).join(", ")}`,
  );

  const unchanged = decideBenchmark({
    baseline: { bufferBlocks: 2838, resultRows: 50, p95Ms: 7.249 },
    observed: { bufferBlocks: 2838, resultRows: 50, p95Ms: 8.9 },
    cv: { p95Ms: 0.03 },
    policy,
  });
  check("a rerun of unchanged code does not fire", !unchanged.fired);

  check(
    "a benchmark whose OWN buffers moved during the study is not ratcheted on buffers",
    decideRegression({
      metric: "bufferBlocks",
      baseline: 100,
      observed: 100000,
      policy,
      stability: { bufferBlocks: { maxAbsSwing: 12, replicates: 3 } },
    }).verdict === "advisory",
  );
  check(
    "a benchmark whose own buffers never moved keeps a ZERO tolerance, whatever other benchmarks did",
    decideRegression({
      metric: "bufferBlocks",
      baseline: 100,
      observed: 101,
      policy: { ...policy, deterministic: { relTol: 191, absTol: 2314 } },
      stability: { bufferBlocks: { maxAbsSwing: 0, replicates: 3 } },
    }).fired,
    "one wobbly benchmark must not widen everyone else's band",
  );
  check(
    "a metric the study never measured on this benchmark is not ratcheted",
    decideRegression({
      metric: "resultRows",
      baseline: 5,
      observed: 900,
      policy,
      stability: { bufferBlocks: { maxAbsSwing: 0 } },
    }).verdict === "advisory",
  );
  check(
    "with no stability record at all, the global policy still applies (fallback preserved)",
    decideRegression({ metric: "resultRows", baseline: 5, observed: 900, policy }).fired,
  );

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  return failed.length === 0;
}

if (process.argv[1] && process.argv[1].endsWith("benchmark-regression.mjs")) {
  if (process.argv.includes("--self-test")) {
    console.log("benchmark-regression self-test\n");
    process.exit(selfTest() ? 0 : 1);
  }
  console.log("Nothing to do. Run with --self-test.");
}
