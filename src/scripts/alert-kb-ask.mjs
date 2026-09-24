/**
 * KB Ask/Retrieval fault rate, read from the structured log stream.
 *
 * SOURCE: `LogSpanExporter` writes one JSON line per finished span with
 * `message="SPAN"`, `name`, `latencyMs` and `status`. `KbAskMetrics` opens
 * exactly one span per Ask operation, named `kb.ask.operation`, and stamps
 * `kb.ask.outcome` on it at finish.
 *
 * WHY THE OUTCOME, NOT THE STATUS: `credits_exhausted` is a billing
 * conversation, `provider_unavailable` is a provider outage, and `error` is a
 * defect. A combined status bit cannot route these to different owners.
 *
 * WHY A RATIO AND A FLOOR: a single failed Ask is not an incident, and a ratio
 * alone pages on the first fault in a quiet window. Both must hold.
 *
 * Usage:
 *   journalctl -u streamlineos-api --since "1 hour ago" -o cat | node alert-kb-ask.mjs
 *   node alert-kb-ask.mjs --log=app.log --hours=24 --fault-ratio=0.1
 *   node alert-kb-ask.mjs --self-test
 *
 * Exit codes:
 *   0 = fault ratio within budget
 *   1 = fault ratio over budget, or the self-test failed
 *   2 = no kb.ask.operation span lines found in the input
 */
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import process from "node:process";

const SPAN_NAME = "kb.ask.operation";
const OUTCOME_ATTRIBUTE_KEY = "kb.ask.outcome";
const CITATIONS_ATTRIBUTE_KEY = "kb.ask.citations";
const CANDIDATES_ATTRIBUTE_KEY = "kb.ask.candidates";
const DEGRADED_ATTRIBUTE_KEY = "kb.ask.degraded";

/**
 * Must stay identical to the members `isKbAskFault` returns true for in
 * `src/modules/kb/core/telemetry/kb-ask-metrics.ts`.
 * `kb-ask-metric-alert-parity.spec.ts` compares the two lists and fails
 * when they drift.
 */
const FAULT_OUTCOMES = ["credits_exhausted", "provider_unavailable", "error"];

const DEFAULT_FAULT_RATIO = 0.05;
const MIN_FAULTS = 2;

const args = process.argv.slice(2);
const hours = Math.max(1, parseInt(args.find((a) => a.startsWith("--hours="))?.slice(8) ?? "1", 10));
const logFile = args.find((a) => a.startsWith("--log="))?.slice(6);
const faultRatioArg = args.find((a) => a.startsWith("--fault-ratio="))?.slice(14);
const faultRatioThreshold = (() => {
  if (faultRatioArg === undefined) return DEFAULT_FAULT_RATIO;
  const parsed = Number(faultRatioArg);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : DEFAULT_FAULT_RATIO;
})();

function percentile(sortedAscending, fraction) {
  if (sortedAscending.length === 0) return null;
  const rank = Math.ceil(fraction * sortedAscending.length);
  return sortedAscending[Math.min(sortedAscending.length - 1, Math.max(0, rank - 1))];
}

export function summarise(lines, cutoffMs, ratioThreshold = DEFAULT_FAULT_RATIO) {
  const byOutcome = new Map();
  const latencies = [];
  let operationLines = 0;
  let faults = 0;
  let noContextCount = 0;
  let totalCitations = 0;
  let totalCandidates = 0;
  let degradedCount = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.message !== "SPAN") continue;
    if (record.name !== SPAN_NAME) continue;
    const outcome = record[OUTCOME_ATTRIBUTE_KEY];
    if (typeof outcome !== "string") continue;

    const ts = record.timestamp ? new Date(record.timestamp).getTime() : NaN;
    if (!Number.isNaN(ts) && ts < cutoffMs) continue;

    operationLines += 1;
    byOutcome.set(outcome, (byOutcome.get(outcome) ?? 0) + 1);
    if (FAULT_OUTCOMES.includes(outcome)) faults += 1;
    if (outcome === "no_context") noContextCount += 1;
    if (typeof record.latencyMs === "number" && Number.isFinite(record.latencyMs))
      latencies.push(record.latencyMs);
    if (typeof record[CITATIONS_ATTRIBUTE_KEY] === "number") totalCitations += record[CITATIONS_ATTRIBUTE_KEY];
    if (typeof record[CANDIDATES_ATTRIBUTE_KEY] === "number") totalCandidates += record[CANDIDATES_ATTRIBUTE_KEY];
    if (record[DEGRADED_ATTRIBUTE_KEY] === true) degradedCount += 1;
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const faultRatio = operationLines === 0 ? 0 : faults / operationLines;
  const noContextRatio = operationLines === 0 ? 0 : noContextCount / operationLines;

  return {
    operationLines,
    operations: operationLines,
    faults,
    faultRatio,
    faultRatioThreshold: ratioThreshold,
    minFaults: MIN_FAULTS,
    breached: faults >= MIN_FAULTS && faultRatio > ratioThreshold,
    outcomes: Object.fromEntries([...byOutcome.entries()].sort((a, b) => b[1] - a[1])),
    noContextCount,
    noContextRatio,
    totalCitations,
    totalCandidates,
    degradedCount,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1] ?? null,
  };
}

if (args.includes("--self-test")) {
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - (hours + 1) * 3_600_000).toISOString();

  const operation = (outcome, latencyMs, extra = {}, timestamp = now) =>
    JSON.stringify({
      timestamp,
      level: "info",
      message: "SPAN",
      name: SPAN_NAME,
      status: FAULT_OUTCOMES.includes(outcome) ? "error" : "ok",
      latencyMs,
      [OUTCOME_ATTRIBUTE_KEY]: outcome,
      [CITATIONS_ATTRIBUTE_KEY]: 0,
      [CANDIDATES_ATTRIBUTE_KEY]: 0,
      [DEGRADED_ATTRIBUTE_KEY]: false,
      ...extra,
    });

  const healthyLines = [
    ...Array.from({ length: 18 }, () =>
      operation("answered", 800, { [CITATIONS_ATTRIBUTE_KEY]: 3, [CANDIDATES_ATTRIBUTE_KEY]: 5 }),
    ),
    ...Array.from({ length: 5 }, () => operation("no_context", 200)),
    operation("provider_unavailable", 1_200),
    operation("error", 900),
    operation("error", 900, {}, stale),
    JSON.stringify({ timestamp: now, level: "info", message: "SPAN", name: "kb.indexing.operation", latencyMs: 50, "kb.outcome": "indexed" }),
  ];

  const outageLines = [
    ...Array.from({ length: 10 }, () => operation("answered", 800)),
    ...Array.from({ length: 4 }, () => operation("provider_unavailable", 2_000)),
    ...Array.from({ length: 3 }, () => operation("credits_exhausted", 300)),
  ];

  const cutoff = Date.now() - hours * 3_600_000;
  const healthy = summarise(healthyLines, cutoff);
  const outage = summarise(outageLines, cutoff);
  const oneBlip = summarise(
    [...Array.from({ length: 3 }, () => operation("answered", 800)), operation("error", 900)],
    cutoff,
  );
  const empty = summarise([], cutoff);

  const checks = {
    staleAndForeignSpansExcluded: healthy.operationLines === 26,
    healthyWindowDoesNotFire: healthy.breached === false,
    outcomesBucketed: healthy.outcomes.answered === 18 && healthy.outcomes.no_context === 5,
    noContextCounted: healthy.noContextCount === 5,
    citationsCounted: healthy.totalCitations === 54,
    latencyPercentileComputed: typeof healthy.p95Ms === "number",
    outageFires: outage.breached === true,
    outageCountsEveryFaultOutcome: outage.faults === 7,
    singleFaultDoesNotPage: oneBlip.breached === false && oneBlip.faultRatio > DEFAULT_FAULT_RATIO,
    noOperationsWouldExitTwo: empty.operationLines === 0,
  };

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, checks, healthy, outage }) + "\n");
  process.exit(pass ? 0 : 1);
}

const input = logFile ? createReadStream(logFile) : process.stdin;
const rl = createInterface({ input, crlfDelay: Infinity });
const allLines = [];
for await (const line of rl) allLines.push(line);

const summary = summarise(allLines, Date.now() - hours * 3_600_000, faultRatioThreshold);

if (summary.operationLines === 0) {
  process.stdout.write(
    JSON.stringify({
      fired: false,
      error: `No "${SPAN_NAME}" span lines found in the input. Either the window is empty or the KB Ask instrumentation is unwired — check that KbAskService calls KbAskMetrics.begin and that main.ts calls setSpanExporter(new LogSpanExporter()).`,
      linesRead: allLines.length,
    }) + "\n",
  );
  process.exit(2);
}

process.stdout.write(
  JSON.stringify({
    fired: summary.breached,
    windowHours: hours,
    spanName: SPAN_NAME,
    outcomeAttributeKey: OUTCOME_ATTRIBUTE_KEY,
    faultOutcomes: FAULT_OUTCOMES,
    destination: "CONFIGURE_ME — wire exit-code 1 to your oncall system",
    ...summary,
  }) + "\n",
);
process.exit(summary.breached ? 1 : 0);
