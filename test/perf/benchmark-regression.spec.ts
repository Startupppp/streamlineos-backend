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
    const p = makePolicy([2838], [5]);
    expect(p.deterministic.relTol).toBe(0);
    expect(p.deterministic.absTol).toBe(0);
  });

  it("arms timing when the replicate swing is below the 25% threshold", () => {
    const p = makePolicy([100], [5]);
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
