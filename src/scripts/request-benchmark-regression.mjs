import { decideRegression, policyFromNoise } from "./benchmark-regression.mjs";

const EXACT_COUNT_METRICS = ["downstreamCalls", "deferredDownstreamCalls"];
const NOISE_COUNT_METRICS = ["requestDbCalls"];
const SIZE_METRICS = ["responseBytes", "memoryMb"];
const LATENCY_METRICS = ["p50", "p95", "p99"];
const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * Combined noise range for one size or count metric.
 *
 * A noise study built from only the baseline's three replicates underestimates cross-capture noise:
 * the within-capture swing of replicate A covers [minA, maxA], while the cross-capture comparison
 * moves between replicate A's minimum and replicate B's maximum. The union of both studies,
 * max(maxA, maxB) - min(minA, minB), captures all observed movement of unchanged code.
 *
 * Both sides need an n ≥ 3 envelope for the metric. Returns null when either is absent.
 */
function combinedNoiseRange(baseEnv, freshEnv) {
  if (!(baseEnv?.n >= 3) || !finite(baseEnv?.max) || !finite(baseEnv?.min)) return null;
  if (!(freshEnv?.n >= 3) || !finite(freshEnv?.max) || !finite(freshEnv?.min)) return baseEnv.maxAbsSwing;
  return Math.max(baseEnv.max, freshEnv.max) - Math.min(baseEnv.min, freshEnv.min);
}

/** Compare identical HTTP route/profile slots, using noise derived from both captures' replicate studies.
 *
 * Dimensions:
 *   downstreamCalls / deferredDownstreamCalls — exact ratchet; these counts are deterministic.
 *   requestDbCalls — noise-envelope ratchet using the combined range of both captures' replicate studies.
 *     Cache state varies between runs: authentication, permission resolution and module entitlement
 *     calls are in this count but not in the handler's own measuredDbCalls. An exact ratchet on a
 *     cache-dependent count fires on every rerun; the noise envelope arms on what the replicates
 *     actually measured.
 *   responseBytes / memoryMb — same combined-range noise envelope as requestDbCalls; memoryMb is
 *     dominated by runtime GC timing, which shifts between independent capture sessions.
 *   latency — timing policy from the noise study; disarmed when unchanged code moves past the
 *     arming threshold (≥25% relative swing).
 *
 * Comparability:
 *   Two independent captures of the same code share the same fixture hash (the seed) and both have
 *   scorable control probes. They do NOT share subjectHashBefore: the harness writes to the DB and
 *   the "before" state of capture B is the "after" state of capture A. Checking subjectHashBefore
 *   across captures fires on every valid rerun; fixtureHash + scorable is what establishes identity.
 */
export function evaluateRequestRegressions(baseline, current) {
  const findings = [];
  const advisories = [];
  let compared = 0;
  const fail = (id, metric, detail) => findings.push({ id, metric, detail, fired: true });
  const before = baseline.requestLevel;
  const after = current.requestLevel;
  if (!before || !after) {
    fail("requestLevel", "structure", "Both captures require requestLevel measurements");
    return { compared, findings, advisories };
  }
  for (const field of ["database", "role", "cache", "compression", "samples", "warmup", "gcAvailable"]) {
    if (before[field] !== after[field]) fail("requestLevel", "comparability", `${field} changed between captures`);
  }
  const profiles = new Map((after.tenants ?? []).map((tenant) => [tenant.profile, tenant]));
  const basisProfiles = new Map((before.tenants ?? []).map((tenant) => [tenant.profile, tenant]));
  for (const profile of new Set([...basisProfiles.keys(), ...profiles.keys()])) {
    const tenant = basisProfiles.get(profile);
    const now = profiles.get(profile);
    if (!tenant?.fixtureHash || tenant.fixtureHash !== now?.fixtureHash || !tenant.scorable || !now?.scorable)
      fail(profile, "comparability", "Fixture identity or successful control evidence is missing or changed");
  }
  const keys = new Set([...Object.keys(before.routes ?? {}), ...Object.keys(after.routes ?? {})]);
  if (keys.size === 0) fail("requestLevel", "structure", "No request routes were captured");
  for (const key of keys) {
    const base = before.routes?.[key];
    const now = after.routes?.[key];
    if (base?.status !== "measured" || now?.status !== "measured") {
      if (base?.status !== "measured" && now?.status !== "measured") continue;
      fail(key, "structure", "Route was measured in one capture but not the other; this indicates a capture environment change");
      continue;
    }
    compared++;
    if (base.route !== now.route || base.profile !== now.profile || base.scored !== now.scored ||
        base.downstreamAccounting !== now.downstreamAccounting)
      fail(key, "comparability", "Route identity, classification or downstream accounting changed");

    let corroborated = false;
    for (const metric of EXACT_COUNT_METRICS) {
      if (!finite(base[metric]) || !finite(now[metric])) fail(key, metric, "Missing finite baseline/current count");
      else if (now[metric] > base[metric]) {
        fail(key, metric, `${base[metric]} -> ${now[metric]} (exact count ratchet)`);
        corroborated = true;
      }
    }

    const baseNoise = before.noiseStudy?.routes?.[key];
    const freshNoise = after.noiseStudy?.routes?.[key];

    for (const metric of NOISE_COUNT_METRICS) {
      if (!finite(base[metric]) || !finite(now[metric])) {
        fail(key, metric, "Missing finite baseline/current count");
        continue;
      }
      const baseEnv = baseNoise?.[metric];
      const freshEnv = freshNoise?.[metric];
      const range = combinedNoiseRange(baseEnv, freshEnv);
      if (range === null) {
        if (now[metric] > base[metric])
          advisories.push({ id: key, metric, detail: `${metric} ${base[metric]} -> ${now[metric]}. DISARMED: no replicate-study noise envelope exists for this metric; it varies with cache state and cannot be gated without a measured noise band` });
        continue;
      }
      if (now[metric] > base[metric] + range) {
        fail(key, metric, `${now[metric]} exceeds baseline ${base[metric]} + combined noise ${range} (base swing ${baseEnv.maxAbsSwing}, fresh swing ${freshEnv?.maxAbsSwing ?? "n/a"})`);
        corroborated = true;
      }
    }

    for (const metric of SIZE_METRICS) {
      const baseEnv = baseNoise?.[metric];
      const freshEnv = freshNoise?.[metric];
      if (!finite(base[metric]) || !finite(now[metric])) {
        fail(key, metric, "Missing finite baseline/current measurement");
        continue;
      }
      const range = combinedNoiseRange(baseEnv, freshEnv);
      if (range === null) {
        if (now[metric] > base[metric])
          advisories.push({ id: key, metric, detail: `${metric} ${base[metric]} -> ${now[metric]}. DISARMED: at least three baseline replicates are required to set the noise band for this dimension` });
        continue;
      }
      if (now[metric] > base[metric] + range) {
        fail(key, metric, `${now[metric]} exceeds baseline ${base[metric]} + combined noise ${range.toFixed(4)} (base swing ${baseEnv.maxAbsSwing}, fresh swing ${freshEnv?.maxAbsSwing ?? "n/a"})`);
        corroborated = true;
      }
    }

    for (const metric of LATENCY_METRICS) {
      const envelope = baseNoise?.latencyMs?.[metric];
      if (!finite(base.latencyMs?.[metric]) || !finite(now.latencyMs?.[metric])) {
        fail(key, metric, "Missing finite baseline/current latency measurement");
        continue;
      }
      if (!validEnvelope(envelope)) {
        if (now.latencyMs[metric] > base.latencyMs[metric])
          advisories.push({ id: key, metric, detail: `${metric} ${base.latencyMs[metric]} -> ${now.latencyMs[metric]} ms. DISARMED: at least three baseline replicates are required to set the noise band for HTTP latency` });
        continue;
      }
      const policy = policyFromNoise({ deterministicEnvelopes: [], timingEnvelopes: [envelope], replicates: envelope.n });
      const result = decideRegression({ metric: `${metric}Ms`, baseline: base.latencyMs[metric],
        observed: now.latencyMs[metric], cv: envelope.cv, policy, corroborated });
      if (result.fired) fail(key, metric, result.detail);
      else if (result.verdict === "uncorroborated" || result.verdict === "advisory")
        advisories.push({ id: key, metric, detail: result.detail });
    }
  }
  return { compared, findings, advisories };
}

function validEnvelope(value) {
  return value?.n >= 3 && finite(value.maxAbsSwing) && finite(value.maxRelSwing) && finite(value.cv);
}
