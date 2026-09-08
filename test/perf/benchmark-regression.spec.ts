import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * PRD-C148 — automated performance-regression gates.
 *
 * These tests prove that every regression-detection mode BITES when a regression is planted.
 * They run without a database; the logic under test is pure computation in benchmark-regression.mjs.
 *
 * Three gate modes exist:
 *   EXACT      — result rows, DB call count, plan shape. No tolerance; any change fires.
 *   DETERMINISTIC — buffer blocks. Tolerates only the replicate swing measured on unchanged code.
 *   TIMING     — p50/p95/p99 ms. Requires corroboration from a deterministic metric (unless the
 *                move is an order-of-magnitude blow-up). DISARMED when the noise floor is too high.
 *
 * Run:
 *   node ./node_modules/jest/bin/jest.js --roots ./test/perf --runInBand \
 *     --testPathPattern benchmark-regression
 */

const BACKEND_ROOT = join(__dirname, "..", "..");

type DecisionResult = {
  fired: boolean;
  verdict: string;
  detail: string;
};

type BenchmarkResult = {
  fired: boolean;
  corroborated: boolean;
  findings: Array<{ metric: string; fired: boolean; verdict: string; detail: string }>;
};

type Policy = {
  deterministic: { relTol: number; absTol: number };
  timing: {
    k: number;
    minRelTol: number;
    absFloorMs: number;
    hardMultiple: number;
    corroborationRequired: boolean;
    armed: boolean;
    disarmedBecause: string | null;
  };
  exact: { planSignatureArmed: boolean; disarmedBecause: string | null };
};

function runRegression(code: string): unknown {
  const regressionUrl = pathToFileURL(
    join(BACKEND_ROOT, "src", "scripts", "benchmark-regression.mjs"),
  ).href;
  const program = `import { decideBenchmark, decideRegression, policyFromNoise, noiseEnvelope } from ${JSON.stringify(regressionUrl)};
${code}`;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", program], {
      cwd: BACKEND_ROOT,
      encoding: "utf8",
    }),
  );
}

function makePolicy(opts: {
  deterministicSamples?: number[];
  timingSamples?: number[];
  exactUnstable?: number;
}): Policy {
  const det = JSON.stringify(opts.deterministicSamples ?? [100, 100, 100]);
  const tim = JSON.stringify(opts.timingSamples ?? [5, 5, 5]);
  const unstable = opts.exactUnstable ?? 0;
  return runRegression(
    "const p = policyFromNoise({" +
    " deterministicEnvelopes: [noiseEnvelope(" + det + ")]," +
    " timingEnvelopes: [noiseEnvelope(" + tim + ")]," +
    " exactStability: { planSignature: { pairs: 100, unstable: " + String(unstable) + " } }," +
    " replicates: 3 });" +
    " process.stdout.write(JSON.stringify(p));",
  ) as Policy;
}

function decide(params: {
  metric: string;
  baseline: number | string;
  observed: number | string;
  cv?: number;
  policy: Policy;
  corroborated?: boolean;
}): DecisionResult {
  return runRegression(`
const policy = ${JSON.stringify(params.policy)};
const r = decideRegression({
  metric: ${JSON.stringify(params.metric)},
  baseline: ${JSON.stringify(params.baseline)},
  observed: ${JSON.stringify(params.observed)},
  cv: ${params.cv ?? 0},
  policy,
  corroborated: ${params.corroborated ?? false}
});
process.stdout.write(JSON.stringify(r));`) as DecisionResult;
}

function decideBench(params: {
  baseline: Record<string, number | string>;
  observed: Record<string, number | string>;
  cv?: Record<string, number>;
  policy: Policy;
}): BenchmarkResult {
  return runRegression(`
const policy = ${JSON.stringify(params.policy)};
const r = decideBenchmark({
  baseline: ${JSON.stringify(params.baseline)},
  observed: ${JSON.stringify(params.observed)},
  cv: ${JSON.stringify(params.cv ?? {})},
  policy
});
process.stdout.write(JSON.stringify(r));`) as BenchmarkResult;
}

const stablePolicy = makePolicy({ deterministicSamples: [100, 100, 100], timingSamples: [5, 5, 5] });
const noisyPolicy = makePolicy({ deterministicSamples: [100, 100, 100], timingSamples: [5, 8, 15] });

describe("PRD-C148 — regression gate: exact metrics", () => {
  it("fires when resultRows increases (extra rows returned = scope widening or missing filter)", () => {
    const r = decide({ metric: "resultRows", baseline: 50, observed: 51, policy: stablePolicy });
    expect(r.fired).toBe(true);
    expect(r.verdict).toBe("regressed");
  });

  it("fires when resultRows decreases (fewer rows = data lost or filter broken)", () => {
    const r = decide({ metric: "resultRows", baseline: 50, observed: 49, policy: stablePolicy });
    expect(r.fired).toBe(true);
  });

  it("does not fire when resultRows is unchanged", () => {
    const r = decide({ metric: "resultRows", baseline: 50, observed: 50, policy: stablePolicy });
    expect(r.fired).toBe(false);
    expect(r.verdict).toBe("within");
  });

  it("fires on a DB-call addition — a new statement was added to the path", () => {
    const r = decide({ metric: "measuredDbCalls", baseline: 4, observed: 5, policy: stablePolicy });
    expect(r.fired).toBe(true);
    expect(r.verdict).toBe("regressed");
  });

  it("does not fire when DB calls decrease (fewer is not a regression)", () => {
    const r = decide({ metric: "measuredDbCalls", baseline: 5, observed: 4, policy: stablePolicy });
    expect(r.fired).toBe(false);
    expect(r.verdict).toBe("within");
  });

  it("fires on a plan flip — an index scan replaced by a sequential scan", () => {
    const r = decide({
      metric: "planSignature",
      baseline: "Index Scan on tickets via tickets_org_id_status_idx",
      observed: "Seq Scan on tickets",
      policy: stablePolicy,
    });
    expect(r.fired).toBe(true);
    expect(r.verdict).toBe("regressed");
  });

  it("does not fire when the plan is unchanged", () => {
    const r = decide({
      metric: "planSignature",
      baseline: "Index Scan on tickets via tickets_org_id_status_idx",
      observed: "Index Scan on tickets via tickets_org_id_status_idx",
      policy: stablePolicy,
    });
    expect(r.fired).toBe(false);
  });

  it("disarms planSignature when it moved on its own across replicates, and reports advisory instead", () => {
    const wobblyPolicy = makePolicy({ exactUnstable: 7 });
    const r = decide({
      metric: "planSignature",
      baseline: "Index Scan on x via idx",
      observed: "Seq Scan on x",
      policy: wobblyPolicy,
    });
    expect(r.fired).toBe(false);
    expect(r.verdict).toBe("advisory");
  });
});

describe("PRD-C148 — regression gate: deterministic metrics (buffer blocks)", () => {
  it("fires when buffer blocks explode beyond the measured noise band", () => {
    const r = decide({ metric: "bufferBlocks", baseline: 100, observed: 4000, policy: stablePolicy });
    expect(r.fired).toBe(true);
    expect(r.verdict).toBe("regressed");
  });

  it("does not fire for a small increase inside the noise band", () => {
    const noisyDetPolicy = makePolicy({ deterministicSamples: [100, 100, 110] });
    const r = decide({ metric: "bufferBlocks", baseline: 100, observed: 105, policy: noisyDetPolicy });
    expect(r.fired).toBe(false);
    expect(r.verdict).toBe("within");
  });

  it("keeps an exact-zero tolerance when unchanged code never moved buffers", () => {
    const r = decide({ metric: "bufferBlocks", baseline: 2838, observed: 2839, policy: stablePolicy });
    expect(r.fired).toBe(true);
  });

  it("does not fire on a decrease in buffers (cheaper is not a regression)", () => {
    const r = decide({ metric: "bufferBlocks", baseline: 500, observed: 10, policy: stablePolicy });
    expect(r.fired).toBe(false);
  });
});

describe("PRD-C148 — regression gate: timing metrics", () => {
  it("does NOT fire on a 40% wall-clock jump when buffers and rows are unchanged (uncorroborated)", () => {
    const r = decide({
      metric: "p95Ms",
      baseline: 5,
      observed: 7,
      cv: 0.02,
      policy: stablePolicy,
      corroborated: false,
    });
    expect(r.fired).toBe(false);
    expect(r.verdict).toBe("uncorroborated");
  });

  it("fires on the same 40% jump WHEN a deterministic metric also moved (corroborated)", () => {
    const r = decide({
      metric: "p95Ms",
      baseline: 5,
      observed: 7,
      cv: 0.02,
      policy: stablePolicy,
      corroborated: true,
    });
    expect(r.fired).toBe(true);
    expect(r.verdict).toBe("regressed");
  });

  it("fires on an order-of-magnitude blow-up even without corroboration", () => {
    const r = decide({
      metric: "p95Ms",
      baseline: 5,
      observed: 16,
      cv: 0.02,
      policy: stablePolicy,
      corroborated: false,
    });
    expect(r.fired).toBe(true);
  });

  it("never fires when timing is DISARMED, regardless of how large the move is", () => {
    const r = decide({
      metric: "p95Ms",
      baseline: 5,
      observed: 5000,
      cv: 0,
      policy: noisyPolicy,
      corroborated: true,
    });
    expect(r.fired).toBe(false);
    expect(r.verdict).toBe("advisory");
  });

  it("still reports an advisory when timing is disarmed, so the regression is visible", () => {
    const r = decide({
      metric: "p95Ms",
      baseline: 5,
      observed: 100,
      cv: 0,
      policy: noisyPolicy,
    });
    expect(r.verdict).toBe("advisory");
  });

  it("sub-millisecond movement never fires even with corroboration (below the abs floor)", () => {
    const r = decide({
      metric: "p95Ms",
      baseline: 0.19,
      observed: 0.9,
      cv: 0,
      policy: stablePolicy,
      corroborated: true,
    });
    expect(r.fired).toBe(false);
  });
});

describe("PRD-C148 — regression gate: full benchmark decisions", () => {
  it("a buffer explosion corroborates a timing move — both fire together", () => {
    const r = decideBench({
      baseline: { bufferBlocks: 100, resultRows: 50, p95Ms: 5 },
      observed: { bufferBlocks: 4000, resultRows: 50, p95Ms: 40 },
      policy: stablePolicy,
    });
    expect(r.fired).toBe(true);
    expect(r.corroborated).toBe(true);
    const fired = r.findings.filter((f) => f.fired).map((f) => f.metric);
    expect(fired).toContain("bufferBlocks");
    expect(fired).toContain("p95Ms");
  });

  it("a rerun of unchanged code does not fire on any metric", () => {
    const r = decideBench({
      baseline: { bufferBlocks: 2838, resultRows: 50, p95Ms: 7.249 },
      observed: { bufferBlocks: 2838, resultRows: 50, p95Ms: 8.9 },
      cv: { p95Ms: 0.03 },
      policy: stablePolicy,
    });
    expect(r.fired).toBe(false);
  });

  it("adding a DB call fires without any other metric moving (direction: up, no tolerance)", () => {
    const r = decideBench({
      baseline: { measuredDbCalls: 3, bufferBlocks: 100, resultRows: 50, p95Ms: 5 },
      observed: { measuredDbCalls: 4, bufferBlocks: 100, resultRows: 50, p95Ms: 5 },
      policy: stablePolicy,
    });
    expect(r.fired).toBe(true);
    const firedMetrics = r.findings.filter((f) => f.fired).map((f) => f.metric);
    expect(firedMetrics).toContain("measuredDbCalls");
  });

  it("a plan flip fires even when buffers and rows are unchanged", () => {
    const r = decideBench({
      baseline: {
        planSignature: "Index Scan on notifications via notifications_org_id_membership_id_id_idx",
        bufferBlocks: 121,
        resultRows: 50,
      },
      observed: {
        planSignature: "Seq Scan on notifications",
        bufferBlocks: 121,
        resultRows: 50,
      },
      policy: stablePolicy,
    });
    expect(r.fired).toBe(true);
    expect(r.findings.find((f) => f.metric === "planSignature")?.verdict).toBe("regressed");
  });

  it("a metric with no baseline does not fire (no-baseline verdict)", () => {
    const r = decideBench({
      baseline: { resultRows: 50 },
      observed: { bufferBlocks: 9999, resultRows: 50 },
      policy: stablePolicy,
    });
    const blocksFinding = r.findings.find((f) => f.metric === "bufferBlocks");
    expect(blocksFinding).toBeUndefined();
    expect(r.fired).toBe(false);
  });
});

describe("PRD-C148 — regression gate: noise policy derivation", () => {
  it("derives an exact ratchet when unchanged code's buffers never moved", () => {
    const p = makePolicy({ deterministicSamples: [2838], timingSamples: [5] });
    expect(p.deterministic.relTol).toBe(0);
    expect(p.deterministic.absTol).toBe(0);
  });

  it("arms timing when the replicate swing is below the 25% threshold", () => {
    const p = makePolicy({ deterministicSamples: [100], timingSamples: [5] });
    expect(p.timing.armed).toBe(true);
  });

  it("disarms timing and explains why when the swing exceeds the threshold", () => {
    const p = makePolicy({ timingSamples: [5, 8, 15] });
    expect(p.timing.armed).toBe(false);
    expect(typeof p.timing.disarmedBecause).toBe("string");
    expect(p.timing.disarmedBecause!.length).toBeGreaterThan(0);
  });

  it("disarming timing does not disarm the deterministic ratchet", () => {
    const r = decide({ metric: "bufferBlocks", baseline: 100, observed: 4000, policy: noisyPolicy });
    expect(r.fired).toBe(true);
  });
});

describe("PRD-C148 — regression gate: per-benchmark timing arming", () => {
  it("arms a quiet benchmark even when the global (harness-wide) policy is disarmed", () => {
    expect(noisyPolicy.timing.armed).toBe(false);
    const r = runRegression(`
const policy = ${JSON.stringify(noisyPolicy)};
const r = decideRegression({ metric: "p95Ms", baseline: 5, observed: 20, cv: 0.02, policy, corroborated: true,
  stability: { timingArmed: true, timingDisarmedBecause: null } });
process.stdout.write(JSON.stringify(r));`) as DecisionResult;
    expect(r.fired).toBe(true);
  });

  it("disarms a benchmark whose own envelope is noisy, even when the global policy is armed", () => {
    expect(stablePolicy.timing.armed).toBe(true);
    const r = runRegression(`
const policy = ${JSON.stringify(stablePolicy)};
const r = decideRegression({ metric: "p95Ms", baseline: 5, observed: 20, cv: 0.02, policy, corroborated: true,
  stability: { timingArmed: false, timingDisarmedBecause: "own p95 moved 140% across 3 replicates" } });
process.stdout.write(JSON.stringify(r));`) as DecisionResult;
    expect(r.fired).toBe(false);
    expect(r.verdict).toBe("advisory");
  });

  it("a per-benchmark disarmed metric is still an advisory so it remains visible", () => {
    const r = runRegression(`
const policy = ${JSON.stringify(stablePolicy)};
const r = decideRegression({ metric: "p95Ms", baseline: 5, observed: 100, cv: 0, policy,
  stability: { timingArmed: false, timingDisarmedBecause: "noise" } });
process.stdout.write(JSON.stringify(r));`) as DecisionResult;
    expect(r.verdict).toBe("advisory");
    expect(r.detail).toContain("DISARMED");
    expect(r.fired).toBe(false);
  });
});

describe("PRD-C148 — regression gate: HTTP route regressions (evaluateRequestRegressions)", () => {
  const rrUrl = pathToFileURL(
    join(BACKEND_ROOT, "src", "scripts", "request-benchmark-regression.mjs"),
  ).href;

  function evalRequests(baseline: unknown, current: unknown): unknown {
    const program = `import { evaluateRequestRegressions } from ${JSON.stringify(rrUrl)};
const r = evaluateRequestRegressions(${JSON.stringify(baseline)}, ${JSON.stringify(current)});
process.stdout.write(JSON.stringify(r));`;
    return JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "-e", program], {
        cwd: BACKEND_ROOT,
        encoding: "utf8",
      }),
    );
  }

  const baseRoute = (overrides: Record<string, unknown> = {}) => ({
    route: "GET /x", profile: "reference", status: "measured", scored: true,
    routeClass: "list", downstreamAccounting: "request-and-after-commit-v1",
    requestDbCalls: 3, downstreamCalls: 0, deferredDownstreamCalls: 0,
    responseBytes: 100, memoryMb: 2,
    latencyMs: { p50: 5, p95: 10, p99: 12 },
    ...overrides,
  });

  const baseManifest = (routeOverrides: Record<string, unknown> = {}, noiseStudyRoutes: Record<string, unknown> | null = null) => ({
    requestLevel: {
      database: "scratch", role: "app", cache: "warm", compression: "none",
      samples: 40, warmup: 5, gcAvailable: true,
      tenants: [{
        profile: "reference", scorable: true, fixtureHash: "abc",
        subjectHashBefore: "x1", subjectHashAfter: "x1", subjectStable: true,
      }],
      routes: { "GET /x@reference": baseRoute(routeOverrides) },
      ...(noiseStudyRoutes ? { noiseStudy: { routes: noiseStudyRoutes } } : {}),
    },
  });

  it("downstream calls regression fires (exact count ratchet, no tolerance)", () => {
    const base = baseManifest();
    const fresh = baseManifest({ downstreamCalls: 1 });
    const r = evalRequests(base, fresh) as { findings: Array<{ metric: string; fired: boolean }> };
    expect(r.findings.some((f) => f.metric === "downstreamCalls" && f.fired)).toBe(true);
  });

  it("downstream calls decrease does not fire (fewer is not a regression)", () => {
    const base = baseManifest({ downstreamCalls: 2 });
    const fresh = baseManifest({ downstreamCalls: 0 });
    const r = evalRequests(base, fresh) as { findings: Array<{ metric: string; fired: boolean }> };
    expect(r.findings.filter((f) => f.metric === "downstreamCalls" && f.fired).length).toBe(0);
  });

  /**
   * A quiet replicate study for the DB-call count: three replicates that never moved.
   *
   * `requestDbCalls` is a NOISE_COUNT_METRIC, not an exact ratchet — the count includes
   * authentication, permission resolution and module entitlement reads whose cache state
   * varies between captures, so an exact ratchet fired on every rerun. Arming it therefore
   * takes a measured envelope; with a zero swing the band is zero and any increase fires,
   * which is the same bite the exact ratchet had, now earned rather than assumed.
   */
  const quietDbCallEnvelope = {
    n: 3, min: 3, max: 3, mean: 3, p50: 3, p95: 3, p99: 3,
    sd: 0, cv: 0, maxAbsSwing: 0, maxRelSwing: 0,
  };

  it("requestDbCalls regression fires against a measured noise band", () => {
    const noise = { "GET /x@reference": { requestDbCalls: quietDbCallEnvelope } };
    const base = baseManifest({}, noise);
    const fresh = baseManifest({ requestDbCalls: 5 }, noise);
    const r = evalRequests(base, fresh) as { findings: Array<{ metric: string; fired: boolean }> };
    expect(r.findings.some((f) => f.metric === "requestDbCalls" && f.fired)).toBe(true);
  });

  it("requestDbCalls increase WITHOUT a replicate envelope is advisory (DISARMED), not a failure", () => {
    const base = baseManifest();
    const fresh = baseManifest({ requestDbCalls: 5 });
    const r = evalRequests(base, fresh) as {
      findings: Array<{ fired: boolean }>;
      advisories: Array<{ metric: string; detail: string }>;
    };
    expect(r.findings.filter((f) => f.fired).length).toBe(0);
    const adv = r.advisories.find((a) => a.metric === "requestDbCalls");
    expect(adv).toBeDefined();
    expect(adv?.detail).toContain("DISARMED");
  });

  it("requestDbCalls stays silent while the increase is inside the measured band", () => {
    const band = { ...quietDbCallEnvelope, min: 2, max: 5, maxAbsSwing: 3, maxRelSwing: 1 };
    const noise = { "GET /x@reference": { requestDbCalls: band } };
    const base = baseManifest({}, noise);
    const fresh = baseManifest({ requestDbCalls: 5 }, noise);
    const r = evalRequests(base, fresh) as { findings: Array<{ metric: string; fired: boolean }> };
    expect(r.findings.filter((f) => f.metric === "requestDbCalls" && f.fired).length).toBe(0);
  });

  it("responseBytes increase with a replicate envelope fires when over the noise band", () => {
    const envelope = { n: 3, min: 98, max: 102, mean: 100, p50: 100, p95: 102, p99: 102, sd: 2, cv: 0.02, maxAbsSwing: 4, maxRelSwing: 0.04 };
    const base = baseManifest({}, { "GET /x@reference": { responseBytes: envelope } });
    const fresh = baseManifest({ responseBytes: 200 });
    const r = evalRequests(base, fresh) as { findings: Array<{ metric: string; fired: boolean }> };
    expect(r.findings.some((f) => f.metric === "responseBytes" && f.fired)).toBe(true);
  });

  it("responseBytes increase WITHOUT a replicate envelope is advisory (DISARMED), not a failure", () => {
    const base = baseManifest();
    const fresh = baseManifest({ responseBytes: 50000 });
    const r = evalRequests(base, fresh) as { findings: Array<{ fired: boolean }>; advisories: Array<{ metric: string; detail: string }> };
    expect(r.findings.filter((f) => f.fired).length).toBe(0);
    const adv = r.advisories.find((a) => a.metric === "responseBytes");
    expect(adv).toBeDefined();
    expect(adv!.detail).toContain("DISARMED");
  });

  it("memoryMb increase WITHOUT a replicate envelope is advisory (DISARMED), not a failure", () => {
    const base = baseManifest();
    const fresh = baseManifest({ memoryMb: 999 });
    const r = evalRequests(base, fresh) as { findings: Array<{ fired: boolean }>; advisories: Array<{ metric: string; detail: string }> };
    expect(r.findings.filter((f) => f.fired).length).toBe(0);
    const adv = r.advisories.find((a) => a.metric === "memoryMb");
    expect(adv).toBeDefined();
    expect(adv!.detail).toContain("DISARMED");
  });

  it("HTTP latency WITH a quiet envelope fires when corroborated by DB calls", () => {
    const envelope = { n: 3, min: 9, max: 11, mean: 10, p50: 10, p95: 11, p99: 11, sd: 1, cv: 0.1, maxAbsSwing: 2, maxRelSwing: 0.22 };
    const noise = {
      "GET /x@reference": {
        latencyMs: { p95: envelope },
        // Corroboration now has to be earned: `requestDbCalls` only fires against a
        // measured band, so without this envelope it degrades to an advisory and the
        // latency finding it is meant to corroborate never arms.
        requestDbCalls: quietDbCallEnvelope,
      },
    };
    const base = baseManifest({}, noise);
    const fresh = baseManifest({ requestDbCalls: 5, latencyMs: { p50: 5, p95: 50, p99: 60 } }, noise);
    const r = evalRequests(base, fresh) as { findings: Array<{ metric: string; fired: boolean }> };
    expect(r.findings.some((f) => f.metric === "requestDbCalls" && f.fired)).toBe(true);
    expect(r.findings.some((f) => f.metric === "p95" && f.fired)).toBe(true);
  });

  it("HTTP latency increase WITHOUT a replicate envelope is advisory (DISARMED), not a failure", () => {
    const base = baseManifest();
    const fresh = baseManifest({ latencyMs: { p50: 5, p95: 9999, p99: 9999 } });
    const r = evalRequests(base, fresh) as { findings: Array<{ fired: boolean }>; advisories: Array<{ metric: string; detail: string }> };
    expect(r.findings.filter((f) => f.fired).length).toBe(0);
    const adv = r.advisories.find((a) => a.metric === "p95");
    expect(adv).toBeDefined();
    expect(adv!.detail).toContain("DISARMED");
  });

  it("an identical fresh capture passes all HTTP metrics without regressions", () => {
    const base = baseManifest();
    const r = evalRequests(base, JSON.parse(JSON.stringify(base))) as { findings: Array<{ fired: boolean }> };
    expect(r.findings.filter((f) => f.fired).length).toBe(0);
  });
});

describe("PRD-C148 — absolute-floor timing arming", () => {
  const subMsPolicy = makePolicy({ timingSamples: [0.3, 0.48, 0.35] });
  const bigNoisyPolicy = makePolicy({ timingSamples: [9, 10, 15] });

  it("arms a harness when the worst p95 absolute swing ≤ 1 ms, even if relative swing is 60%", () => {
    expect(subMsPolicy.timing.armed).toBe(true);
  });

  it("passes a +0.03 ms move on an abs-floor-armed benchmark (within-band or below-floor, does not fire)", () => {
    const r = runRegression(`
const policy = ${JSON.stringify(subMsPolicy)};
const r = decideRegression({
  metric: "p95Ms", baseline: 0.3, observed: 0.33, cv: 0.3,
  policy, corroborated: false,
  stability: { timingArmed: true, timingDisarmedBecause: null }
});
process.stdout.write(JSON.stringify(r));`) as DecisionResult;
    expect(r.fired).toBe(false);
    expect(["within", "below-floor"]).toContain(r.verdict);
  });

  it("fires a +2 ms move on an abs-floor-armed benchmark (above the 1 ms absolute floor)", () => {
    const r = runRegression(`
const policy = ${JSON.stringify(subMsPolicy)};
const r = decideRegression({
  metric: "p95Ms", baseline: 0.3, observed: 2.3, cv: 0.3,
  policy, corroborated: false,
  stability: { timingArmed: true, timingDisarmedBecause: null }
});
process.stdout.write(JSON.stringify(r));`) as DecisionResult;
    expect(r.fired).toBe(true);
    expect(r.verdict).toBe("regressed");
  });

  it("keeps a 10 ms benchmark with 60% relative and 6 ms absolute swing DISARMED (both thresholds exceeded)", () => {
    expect(bigNoisyPolicy.timing.armed).toBe(false);
    const r = decide({ metric: "p95Ms", baseline: 10, observed: 25, policy: bigNoisyPolicy });
    expect(r.fired).toBe(false);
    expect(r.verdict).toBe("advisory");
  });
});

describe("PRD-C148 — all 7 dimensions have coverage", () => {
  it("latency (p95Ms) regression is caught: a timing blow-up corroborated by buffers fires", () => {
    const r = decideBench({
      baseline: { bufferBlocks: 100, p95Ms: 5 },
      observed: { bufferBlocks: 5000, p95Ms: 80 },
      policy: stablePolicy,
    });
    expect(r.fired).toBe(true);
    expect(r.findings.some((f) => f.metric === "p95Ms" && f.fired)).toBe(true);
  });

  it("db-calls (measuredDbCalls) regression is caught: an added statement fires with zero tolerance", () => {
    const r = decide({ metric: "measuredDbCalls", baseline: 3, observed: 4, policy: stablePolicy });
    expect(r.fired).toBe(true);
    expect(r.verdict).toBe("regressed");
  });

  it("buffers regression is caught: a buffer explosion fires beyond the noise band", () => {
    const r = decide({ metric: "bufferBlocks", baseline: 100, observed: 9000, policy: stablePolicy });
    expect(r.fired).toBe(true);
  });

  it("rows (resultRows) regression is caught: any row count change fires (exact ratchet)", () => {
    const r = decide({ metric: "resultRows", baseline: 50, observed: 51, policy: stablePolicy });
    expect(r.fired).toBe(true);
  });

  it("rows (scanRows) regression is caught: deterministic ratchet on scanned rows fires", () => {
    const r = decide({ metric: "scanRows", baseline: 500, observed: 50000, policy: stablePolicy });
    expect(r.fired).toBe(true);
  });

  it("an unchanged synthetic capture passes all SQL-level dimensions", () => {
    const baseline = { measuredDbCalls: 3, bufferBlocks: 100, resultRows: 50, scanRows: 500, p95Ms: 5, planSignature: "Index Scan on x" };
    const r = decideBench({ baseline, observed: { ...baseline }, policy: stablePolicy });
    expect(r.fired).toBe(false);
  });

  it("all METRICS keys resolve to a known kind (no unknown-metric verdicts)", () => {
    const metricsUrl = pathToFileURL(join(BACKEND_ROOT, "src", "scripts", "benchmark-regression.mjs")).href;
    const keys = runRegression(`
import { METRICS } from ${JSON.stringify(metricsUrl)};
process.stdout.write(JSON.stringify(Object.keys(METRICS)));`) as string[];
    for (const key of keys) {
      const r = decide({ metric: key, baseline: 1, observed: 2, policy: stablePolicy });
      expect(r.verdict).not.toBe("unknown-metric");
    }
  });
});
