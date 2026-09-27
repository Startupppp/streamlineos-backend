import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import process from "node:process";

const SPAN_NAME = "kb.read.operation";
const OUTCOME_ATTRIBUTE_KEY = "kb.read.outcome";

const FAULT_OUTCOMES = ["denied", "error"];
const DENIED_OUTCOME = "denied";
const NOT_FOUND_OUTCOME = "not_found";

const DEFAULT_FAULT_RATIO = 0.05;
const MIN_FAULTS = 2;
const DEFAULT_DENIED_RATIO = 0.25;
const MIN_DENIALS = 5;
const DEFAULT_NOT_FOUND_RATIO = 0.4;
const MIN_NOT_FOUND = 10;

const args = process.argv.slice(2);
const hours = Math.max(1, parseInt(args.find((a) => a.startsWith("--hours="))?.slice(8) ?? "1", 10));
const logFile = args.find((a) => a.startsWith("--log="))?.slice(6);

function ratioArg(flag, fallback) {
  const raw = args.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

const faultRatioThreshold = ratioArg("--fault-ratio", DEFAULT_FAULT_RATIO);
const deniedRatioThreshold = ratioArg("--denied-ratio", DEFAULT_DENIED_RATIO);
const notFoundRatioThreshold = ratioArg("--not-found-ratio", DEFAULT_NOT_FOUND_RATIO);

function percentile(sortedAscending, fraction) {
  if (sortedAscending.length === 0) return null;
  const rank = Math.ceil(fraction * sortedAscending.length);
  return sortedAscending[Math.min(sortedAscending.length - 1, Math.max(0, rank - 1))];
}

export function summarise(
  lines,
  cutoffMs,
  ratioThreshold = DEFAULT_FAULT_RATIO,
  deniedThreshold = DEFAULT_DENIED_RATIO,
  notFoundThreshold = DEFAULT_NOT_FOUND_RATIO,
) {
  const byOutcome = new Map();
  const latencies = [];
  let operationLines = 0;
  let faults = 0;
  let deniedCount = 0;
  let notFoundCount = 0;

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
    if (outcome === DENIED_OUTCOME) deniedCount += 1;
    if (outcome === NOT_FOUND_OUTCOME) notFoundCount += 1;
    if (typeof record.latencyMs === "number" && Number.isFinite(record.latencyMs))
      latencies.push(record.latencyMs);
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const faultRatio = operationLines === 0 ? 0 : faults / operationLines;
  const deniedRatio = operationLines === 0 ? 0 : deniedCount / operationLines;
  const notFoundRatio = operationLines === 0 ? 0 : notFoundCount / operationLines;

  const faultBreached = faults >= MIN_FAULTS && faultRatio > ratioThreshold;
  const deniedBreached = deniedCount >= MIN_DENIALS && deniedRatio > deniedThreshold;
  const notFoundBreached = notFoundCount >= MIN_NOT_FOUND && notFoundRatio > notFoundThreshold;

  return {
    operationLines,
    operations: operationLines,
    faults,
    faultRatio,
    faultRatioThreshold: ratioThreshold,
    minFaults: MIN_FAULTS,
    faultBreached,
    deniedCount,
    deniedRatio,
    deniedRatioThreshold: deniedThreshold,
    minDenials: MIN_DENIALS,
    deniedBreached,
    notFoundCount,
    notFoundRatio,
    notFoundRatioThreshold: notFoundThreshold,
    minNotFound: MIN_NOT_FOUND,
    notFoundBreached,
    breached: faultBreached || deniedBreached || notFoundBreached,
    outcomes: Object.fromEntries([...byOutcome.entries()].sort((a, b) => b[1] - a[1])),
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1] ?? null,
  };
}

if (args.includes("--self-test")) {
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - (hours + 1) * 3_600_000).toISOString();

  const operation = (outcome, latencyMs, timestamp = now) =>
    JSON.stringify({
      timestamp,
      level: "info",
      message: "SPAN",
      name: SPAN_NAME,
      status: FAULT_OUTCOMES.includes(outcome) ? "error" : "ok",
      latencyMs,
      [OUTCOME_ATTRIBUTE_KEY]: outcome,
    });

  const healthyLines = [
    ...Array.from({ length: 50 }, () => operation("found", 40)),
    ...Array.from({ length: 4 }, () => operation("not_found", 30)),
    ...Array.from({ length: 1 }, () => operation("denied", 20)),
    operation("error", 90, stale),
    JSON.stringify({
      timestamp: now,
      level: "info",
      message: "SPAN",
      name: "kb.write.operation",
      latencyMs: 200,
      "kb.write.outcome": "created",
    }),
  ];

  const errorOutageLines = [
    ...Array.from({ length: 10 }, () => operation("found", 40)),
    ...Array.from({ length: 4 }, () => operation("error", 500)),
  ];

  const denialSpikeLines = [
    ...Array.from({ length: 10 }, () => operation("found", 40)),
    ...Array.from({ length: 8 }, () => operation("denied", 20)),
  ];

  const notFoundSpikeLines = [
    ...Array.from({ length: 5 }, () => operation("found", 40)),
    ...Array.from({ length: 15 }, () => operation("not_found", 25)),
  ];

  const cutoff = Date.now() - hours * 3_600_000;
  const healthy = summarise(healthyLines, cutoff);
  const errorOutage = summarise(errorOutageLines, cutoff);
  const denialSpike = summarise(denialSpikeLines, cutoff);
  const notFoundSpike = summarise(notFoundSpikeLines, cutoff);
  const oneBlip = summarise(
    [...Array.from({ length: 3 }, () => operation("found", 40)), operation("error", 90)],
    cutoff,
  );
  const empty = summarise([], cutoff);

  const checks = {
    staleAndForeignSpansExcluded: healthy.operationLines === 55,
    healthyWindowDoesNotFire: healthy.breached === false,
    outcomesBucketed: healthy.outcomes.found === 50 && healthy.outcomes.not_found === 4,
    latencyPercentileComputed: typeof healthy.p95Ms === "number",
    errorOutageFires: errorOutage.breached === true && errorOutage.faultBreached === true,
    denialSpikeFiresAsAFault: denialSpike.breached === true && denialSpike.deniedBreached === true,
    notFoundSpikeFires: notFoundSpike.breached === true && notFoundSpike.notFoundBreached === true,
    singleFaultDoesNotPage: oneBlip.breached === false && oneBlip.faultRatio > DEFAULT_FAULT_RATIO,
    noOperationsResultsInZero: empty.operationLines === 0 && empty.breached === false,
  };

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(
    JSON.stringify({
      selfTest: true,
      pass,
      checks,
    }) + "\n",
  );
  process.exit(pass ? 0 : 1);
}

const input = logFile ? createReadStream(logFile) : process.stdin;
const rl = createInterface({ input, crlfDelay: Infinity });
const allLines = [];
for await (const line of rl) allLines.push(line);

if (allLines.length === 0 || allLines.every((l) => !l.trim())) {
  process.stdout.write(
    JSON.stringify({
      fired: false,
      error:
        "No input lines. Either the window is empty or no KB read spans reached the stream. Pipe a populated log window before trusting the result.",
      linesRead: allLines.length,
    }) + "\n",
  );
  process.exit(2);
}

const summary = summarise(
  allLines,
  Date.now() - hours * 3_600_000,
  faultRatioThreshold,
  deniedRatioThreshold,
  notFoundRatioThreshold,
);

if (summary.operationLines === 0) {
  process.stdout.write(
    JSON.stringify({
      fired: false,
      error:
        "No KB read SPAN lines found in the window. Either the emitter is unwired or no read requests arrived in this window. This is not a clear.",
      linesRead: allLines.length,
    }) + "\n",
  );
  process.exit(2);
}

process.stdout.write(
  JSON.stringify({
    fired: summary.breached,
    windowHours: hours,
    destination: "CONFIGURE_ME — wire exit-code 1 to your oncall system",
    ...summary,
  }) + "\n",
);
process.exit(summary.breached ? 1 : 0);
