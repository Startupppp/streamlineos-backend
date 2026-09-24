/**
 * KB indexing/embedding health, read from the structured log stream.
 *
 * SOURCE: `LogSpanExporter` writes one JSON line per finished span with
 * `message="SPAN"`, `name`, `latencyMs` and `status`. `KbIndexingMetrics` opens
 * exactly one span per indexing operation, named `kb.indexing.operation`, and
 * stamps `kb.outcome` on it at finish. No metrics database, no APM agent — the
 * same deferral the other span-backed alerts record.
 *
 * WHY THE OUTCOME, NOT THE STATUS: `status` is the span's own ok/error flag,
 * which collapses three operationally different faults into one bucket. An
 * operator has to separate them: `credits_exhausted` is a billing conversation,
 * `embedding_unavailable` is a provider or configuration outage, and `error` is
 * a defect. The per-outcome counts below are the whole point of the alert.
 *
 * WHY A RATIO AND A FLOOR: a single failed reindex is not an incident, and a
 * ratio alone pages on the first fault in a quiet window. Both must hold.
 *
 * Usage:
 *   journalctl -u streamlineos-api --since "1 hour ago" -o cat | node alert-kb-indexing.mjs
 *   node alert-kb-indexing.mjs --log=app.log --hours=24 --fault-ratio=0.1
 *   node alert-kb-indexing.mjs --self-test
 *
 * Exit codes:
 *   0 = fault ratio within budget
 *   1 = fault ratio over budget, or the self-test failed
 *   2 = no kb.indexing.operation span lines found, which means the window is
 *       empty or the exporter is unwired — see main.ts
 */
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import process from "node:process";

const SPAN_NAME = "kb.indexing.operation";
const OUTCOME_ATTRIBUTE_KEY = "kb.outcome";
const CHUNKS_ATTRIBUTE_KEY = "kb.chunks";
const EMBEDDED_ATTRIBUTE_KEY = "kb.embedded";
const REUSED_ATTRIBUTE_KEY = "kb.reused";

/**
 * Must stay identical to the members `isKbIndexingFault` returns true for in
 * `src/modules/kb/core/telemetry/kb-indexing-metrics.ts`.
 * `kb-indexing-metric-alert-parity.spec.ts` compares the two lists and fails
 * when they drift, because a predicate naming an outcome the emitter never
 * writes is silently inert.
 */
const FAULT_OUTCOMES = ["embedding_unavailable", "credits_exhausted", "error"];

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
  let chunks = 0;
  let embedded = 0;
  let reused = 0;

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
    if (typeof record.latencyMs === "number" && Number.isFinite(record.latencyMs))
      latencies.push(record.latencyMs);
    if (typeof record[CHUNKS_ATTRIBUTE_KEY] === "number") chunks += record[CHUNKS_ATTRIBUTE_KEY];
    if (typeof record[EMBEDDED_ATTRIBUTE_KEY] === "number")
      embedded += record[EMBEDDED_ATTRIBUTE_KEY];
    if (record[REUSED_ATTRIBUTE_KEY] === true) reused += 1;
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const faultRatio = operationLines === 0 ? 0 : faults / operationLines;

  return {
    operationLines,
    operations: operationLines,
    faults,
    faultRatio,
    faultRatioThreshold: ratioThreshold,
    minFaults: MIN_FAULTS,
    breached: faults >= MIN_FAULTS && faultRatio > ratioThreshold,
    outcomes: Object.fromEntries([...byOutcome.entries()].sort((a, b) => b[1] - a[1])),
    chunks,
    embedded,
    reusedOperations: reused,
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
      "kb.content_type": "page",
      [OUTCOME_ATTRIBUTE_KEY]: outcome,
      [CHUNKS_ATTRIBUTE_KEY]: 0,
      [EMBEDDED_ATTRIBUTE_KEY]: 0,
      [REUSED_ATTRIBUTE_KEY]: false,
      ...extra,
    });

  const healthyLines = [
    ...Array.from({ length: 18 }, () =>
      operation("indexed", 400, { [CHUNKS_ATTRIBUTE_KEY]: 4, [EMBEDDED_ATTRIBUTE_KEY]: 4 }),
    ),
    ...Array.from({ length: 5 }, () => operation("reused", 12, { [REUSED_ATTRIBUTE_KEY]: true })),
    operation("acl_only", 20, { [REUSED_ATTRIBUTE_KEY]: true }),
    operation("skipped_no_content", 8),
    operation("error", 900),
    // Outside the window, and a line from another span that must not be counted.
    operation("error", 900, {}, stale),
    JSON.stringify({ timestamp: now, level: "info", message: "SPAN", name: "ai.gateway.call", latencyMs: 50, "ai.outcome": "ok" }),
    JSON.stringify({ timestamp: now, level: "error", message: "ERROR_REPORT", sqlstate: "42501" }),
  ];

  const outageLines = [
    ...Array.from({ length: 10 }, () => operation("indexed", 400)),
    ...Array.from({ length: 6 }, () => operation("embedding_unavailable", 1_200)),
    ...Array.from({ length: 2 }, () => operation("credits_exhausted", 300)),
  ];

  const cutoff = Date.now() - hours * 3_600_000;
  const healthy = summarise(healthyLines, cutoff);
  const outage = summarise(outageLines, cutoff);
  const oneBlip = summarise(
    [...Array.from({ length: 3 }, () => operation("indexed", 400)), operation("error", 900)],
    cutoff,
  );
  const empty = summarise([], cutoff);

  const checks = {
    staleAndForeignSpansExcluded: healthy.operationLines === 26,
    healthyWindowDoesNotFire: healthy.breached === false,
    outcomesBucketed: healthy.outcomes.indexed === 18 && healthy.outcomes.reused === 5,
    reusedCounted: healthy.reusedOperations === 6,
    embeddedCounted: healthy.embedded === 72 && healthy.chunks === 72,
    latencyPercentileComputed: typeof healthy.p95Ms === "number",
    outageFires: outage.breached === true,
    outageCountsEveryFaultOutcome: outage.faults === 8,
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
      error: `No "${SPAN_NAME}" span lines found in the input. Either the window is empty or the KB indexing instrumentation is unwired — check that KbIndexingService calls KbIndexingMetrics.begin and that main.ts calls setSpanExporter(new LogSpanExporter()).`,
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
