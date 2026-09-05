import { decideRegression, policyFromNoise } from "./benchmark-regression.mjs";

const COUNT_METRICS = ["requestDbCalls", "downstreamCalls", "deferredDownstreamCalls"];
const SIZE_METRICS = ["responseBytes", "memoryMb"];
const LATENCY_METRICS = ["p50", "p95", "p99"];
const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Compare identical HTTP route/profile slots, using only baseline replicate noise.
 * Counts are exact; size tolerances come from that route's own replicate envelope.
 * SQL timing noise must never be used to disarm an HTTP regression.
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
    if (!tenant?.fixtureHash || tenant.fixtureHash !== now?.fixtureHash ||
        tenant.subjectHashBefore !== now?.subjectHashBefore || !tenant.scorable || !now?.scorable) {
      fail(profile, "comparability", "Fixture, subject or successful control evidence is missing or changed");
    }
  }
  const keys = new Set([...Object.keys(before.routes ?? {}), ...Object.keys(after.routes ?? {})]);
  if (keys.size === 0) fail("requestLevel", "structure", "No request routes were captured");
  for (const key of keys) {
    const base = before.routes?.[key];
    const now = after.routes?.[key];
    if (base?.status !== "measured" || now?.status !== "measured") {
      fail(key, "structure", "Route must be measured in both captures; missing, failed and skipped routes cannot pass");
      continue;
    }
    compared++;
    if (base.route !== now.route || base.profile !== now.profile || base.scored !== now.scored ||
        base.downstreamAccounting !== now.downstreamAccounting) {
      fail(key, "comparability", "Route identity, classification or downstream accounting changed");
    }
    let corroborated = false;
    for (const metric of COUNT_METRICS) {
      if (!finite(base[metric]) || !finite(now[metric])) fail(key, metric, "Missing finite baseline/current count");
      else if (now[metric] > base[metric]) {
        fail(key, metric, `${base[metric]} -> ${now[metric]} (exact count ratchet)`);
        corroborated = true;
      }
    }
    const noise = before.noiseStudy?.routes?.[key];
    for (const metric of SIZE_METRICS) {
      const envelope = noise?.[metric];
      if (!finite(base[metric]) || !finite(now[metric])) {
        fail(key, metric, "Missing finite baseline/current measurement");
        continue;
      }
      if (!(envelope?.n >= 3) || !finite(envelope?.maxAbsSwing)) {
        if (now[metric] > base[metric])
          advisories.push({ id: key, metric, detail: `${metric} ${base[metric]} -> ${now[metric]}. DISARMED: at least three baseline replicates are required to set the noise band for this dimension` });
        continue;
      }
      const band = base[metric] + envelope.maxAbsSwing;
      if (now[metric] > band) {
        fail(key, metric, `${now[metric]} exceeds baseline ${base[metric]} + measured noise ${envelope.maxAbsSwing}`);
        corroborated = true;
      }
    }
    for (const metric of LATENCY_METRICS) {
      const envelope = noise?.latencyMs?.[metric];
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
