import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import process from "node:process";
import {
  STATEMENT_CEILING_MS,
  ORDINARY_REQUEST_CEILING_MS,
  COMPLEX_REQUEST_CEILING_MS,
  CACHE_HIT_CEILING_MS,
} from "./timing-slo-thresholds.mjs";

export const SLO_CLASSES = {
  "ordinary-sql": STATEMENT_CEILING_MS.ordinary,
  "complex-sql": STATEMENT_CEILING_MS.complex,
  "ordinary-request": ORDINARY_REQUEST_CEILING_MS,
  "complex-request": COMPLEX_REQUEST_CEILING_MS,
  "cache-hit": CACHE_HIT_CEILING_MS,
};

const NOISE_CV_THRESHOLD = 0.25;
const MIN_SAMPLES = 3;

function r4(n) {
  return typeof n === "number" ? Math.round(n * 10000) / 10000 : n;
}

function nearestRankPct(sorted, q) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

function computeSpread(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  const variance =
    n < 2 ? 0 : sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  return {
    n,
    min: r4(sorted[0]),
    p50: r4(nearestRankPct(sorted, 0.5)),
    p95: r4(nearestRankPct(sorted, 0.95)),
    max: r4(sorted[n - 1]),
    mean: r4(mean),
    cv: mean === 0 ? 0 : r4(sd / mean),
  };
}

export function checkSamples(rawSamples, ceilingMs, opts = {}) {
  const {
    warmup = 0,
    noiseMargin = 0.1,
    noiseCvThreshold = NOISE_CV_THRESHOLD,
    minSamples = MIN_SAMPLES,
  } = opts;

  const samples = rawSamples.slice(warmup);
  const threshold = r4(ceilingMs * (1 + noiseMargin));

  if (samples.length < minSamples)
    return { verdict: "INCONCLUSIVE", reason: "insufficient-samples", ceilingMs, threshold, spread: null, batchA: null, batchB: null };

  const spread = computeSpread(samples);

  if (spread.cv > noiseCvThreshold)
    return { verdict: "INCONCLUSIVE", reason: "host-too-noisy", ceilingMs, threshold, spread, batchA: null, batchB: null };

  const mid = Math.floor(samples.length / 2);
  const batchA = computeSpread(samples.slice(0, mid));
  const batchB = computeSpread(samples.slice(mid));

  if (spread.p95 > threshold && batchA.p95 > threshold && batchB.p95 > threshold)
    return { verdict: "FAIL", reason: "over-ceiling", ceilingMs, threshold, spread, batchA, batchB };

  if (spread.p95 > threshold)
    return { verdict: "INCONCLUSIVE", reason: "not-reproducible", ceilingMs, threshold, spread, batchA, batchB };

  return { verdict: "PASS", reason: "within-budget", ceilingMs, threshold, spread, batchA, batchB };
}

function resolveCeiling(sloClass, ceilingOverride) {
  if (ceilingOverride !== null) {
    const n = Number(ceilingOverride);
    if (!Number.isFinite(n) || n <= 0)
      return { ok: false, msg: `--ceiling-ms must be a positive number, got "${ceilingOverride}"` };
    return { ok: true, ms: n };
  }
  if (sloClass !== null) {
    const ms = SLO_CLASSES[sloClass];
    if (ms === undefined)
      return { ok: false, msg: `unknown --slo class "${sloClass}"; known: ${Object.keys(SLO_CLASSES).join(", ")}` };
    return { ok: true, ms };
  }
  return { ok: false, msg: "one of --slo=<class> or --ceiling-ms=N is required" };
}

const args = process.argv.slice(2);
const argVal = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit !== undefined ? hit.slice(name.length + 3) : fallback;
};

if (args.includes("--self-test")) {
  const cases = [
    {
      label: "clean samples within budget pass",
      samples: [10, 9, 11, 10, 12, 9, 10, 11],
      ceilingMs: 50,
      expected: "PASS",
    },
    {
      label: "consistently over-ceiling samples fail",
      samples: [60, 62, 58, 63, 61, 59, 64, 61],
      ceilingMs: 50,
      expected: "FAIL",
    },
    {
      label: "wildly noisy host returns INCONCLUSIVE not PASS",
      samples: [9, 10, 11, 10, 9, 11, 10, 500],
      ceilingMs: 50,
      expected: "INCONCLUSIVE",
    },
    {
      label: "insufficient sample count returns INCONCLUSIVE",
      samples: [10, 11],
      ceilingMs: 50,
      expected: "INCONCLUSIVE",
    },
    {
      label: "regression present in one batch only returns INCONCLUSIVE",
      samples: [48, 49, 51, 52, 53, 54, 54, 55, 55, 56],
      ceilingMs: 50,
      expected: "INCONCLUSIVE",
    },
  ];

  let failed = 0;
  for (const { label, samples, ceilingMs, expected } of cases) {
    const result = checkSamples(samples, ceilingMs);
    const ok = result.verdict === expected;
    process.stdout.write(`  [${ok ? "pass" : "FAIL"}] ${label} — expected ${expected}, got ${result.verdict} (${result.reason})\n`);
    if (!ok) failed++;
  }
  const total = cases.length;
  process.stdout.write(`${total - failed}/${total} self-test cases passed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

async function main() {
  const sloClass = argVal("slo", null);
  const ceilingOverride = argVal("ceiling-ms", null);
  const warmupCount = Math.max(0, Number(argVal("warmup", "0")) || 0);
  const noiseMarginVal = Number(argVal("noise-margin", "0.1")) || 0.1;
  const inputFile = argVal("input", null);

  const ceilingResult = resolveCeiling(sloClass, ceilingOverride);
  if (!ceilingResult.ok) {
    process.stderr.write(`check-timing-slo: ${ceilingResult.msg}\n`);
    process.exit(2);
  }
  const ceilingMs = ceilingResult.ms;

  const input = inputFile !== null ? createReadStream(inputFile) : process.stdin;
  const rl = createInterface({ input, crlfDelay: Infinity });
  const lines = [];
  for await (const line of rl) lines.push(line);
  const raw = lines.join("\n").trim();

  let samples;
  try {
    const parsed = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      !parsed.every((v) => typeof v === "number" && Number.isFinite(v))
    )
      throw new Error("expected a JSON array of finite numbers");
    samples = parsed;
  } catch (e) {
    process.stderr.write(
      `check-timing-slo: invalid input — ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exit(2);
  }

  const result = checkSamples(samples, ceilingMs, {
    warmup: warmupCount,
    noiseMargin: noiseMarginVal,
  });

  process.stdout.write(
    JSON.stringify(
      {
        verdict: result.verdict,
        reason: result.reason,
        sloClass: sloClass ?? "custom",
        ceilingMs: result.ceilingMs,
        threshold: result.threshold,
        spread: result.spread,
        batchA: result.batchA,
        batchB: result.batchB,
      },
      null,
      2,
    ) + "\n",
  );

  if (result.verdict === "PASS") process.exit(0);
  if (result.verdict === "FAIL") process.exit(1);
  process.exit(2);
}

main().catch((e) => {
  process.stderr.write(
    `check-timing-slo: ${e instanceof Error ? e.message : String(e)}\n`,
  );
  process.exit(2);
});
