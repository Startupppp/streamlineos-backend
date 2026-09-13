import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";

const args = process.argv.slice(2);
const hours = Math.max(1, parseInt(args.find((a) => a.startsWith("--hours="))?.slice(8) ?? "1", 10));
const threshold = Math.max(0, parseInt(args.find((a) => a.startsWith("--threshold="))?.slice(12) ?? "0", 10));
const logFile = args.find((a) => a.startsWith("--log="))?.slice(6);

function scanLines(lines, cutoffMs) {
  const matches = [];
  let nonEmptyCount = 0;
  let parsedCount = 0;
  let errorLevelInWindowCount = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    nonEmptyCount++;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    parsedCount++;
    if (record.level !== "error") continue;
    const ts = record.timestamp ? new Date(record.timestamp).getTime() : NaN;
    if (!Number.isNaN(ts) && ts < cutoffMs) continue;
    errorLevelInWindowCount++;
    if (!line.includes("42501")) continue;
    matches.push({
      timestamp: record.timestamp ?? null,
      correlationId: record.correlationId ?? null,
      orgId: record.orgId ?? null,
      route: record.route ?? null,
      message: typeof record.meta?.message === "string" ? record.meta.message.slice(0, 200) : null,
    });
  }
  return { count: matches.length, matches, nonEmptyCount, parsedCount, errorLevelInWindowCount };
}

function determineOutcome(nonEmptyCount, parsedCount, errorLevelInWindowCount, count, threshold) {
  if (nonEmptyCount === 0) return "NO_DATA";
  if (parsedCount === 0) return "MALFORMED";
  if (errorLevelInWindowCount === 0) return "NO_RELEVANT_EVENTS";
  if (count > threshold) return "FIRED";
  return "HEALTHY";
}

if (args.includes("--self-test")) {
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - (hours + 1) * 3_600_000).toISOString();
  const fixtureLines = [
    JSON.stringify({ timestamp: now, level: "error", message: "Unhandled exception", correlationId: "corr-1", orgId: "org_fixture", route: "/notifications", meta: { message: "permission denied for table outbox_events", sqlstate: "42501", table: "outbox_events" } }),
    JSON.stringify({ timestamp: now, level: "error", message: "ERROR_REPORT", correlationId: "corr-2", orgId: "org_fixture", route: "/notifications", sqlstate: "42501", errorClass: "tenant-context", error: { name: "Error", message: "Failed query: insert into notifications", cause: { name: "PostgresError", message: "permission denied for table notifications" } }, extra: { phase: "after-commit" } }),
    JSON.stringify({ timestamp: now, level: "error", message: "Unhandled exception", correlationId: "corr-3", meta: { message: "permission denied", sqlstate: "42P01" } }),
    JSON.stringify({ timestamp: now, level: "warn", message: "[git-webhook] signature verification failed", correlationId: "corr-4" }),
    JSON.stringify({ timestamp: now, level: "error", message: "Something else", correlationId: "corr-5", meta: { message: "some other error" } }),
    JSON.stringify({ timestamp: stale, level: "error", message: "ERROR_REPORT", correlationId: "corr-6", sqlstate: "42501", errorClass: "tenant-context" }),
  ];
  const cutoffMs = Date.now() - hours * 3_600_000;

  const { count, matches, nonEmptyCount: ne1, parsedCount: pc1, errorLevelInWindowCount: el1 } = scanLines(fixtureLines, cutoffMs);
  const outcomeNormal = determineOutcome(ne1, pc1, el1, count, threshold);
  const caseNormal = count === 2 && outcomeNormal === "FIRED";

  const { count: c2, nonEmptyCount: ne2, parsedCount: pc2, errorLevelInWindowCount: el2 } = scanLines([], cutoffMs);
  const caseNoData = determineOutcome(ne2, pc2, el2, c2, threshold) === "NO_DATA";

  const malformedLines = ["not json", "also not json"];
  const { count: c3, nonEmptyCount: ne3, parsedCount: pc3, errorLevelInWindowCount: el3 } = scanLines(malformedLines, cutoffMs);
  const caseMalformed = determineOutcome(ne3, pc3, el3, c3, threshold) === "MALFORMED";

  const noErrorLines = [
    JSON.stringify({ timestamp: now, level: "info", message: "server started" }),
    JSON.stringify({ timestamp: now, level: "warn", message: "something slow" }),
  ];
  const { count: c4, nonEmptyCount: ne4, parsedCount: pc4, errorLevelInWindowCount: el4 } = scanLines(noErrorLines, cutoffMs);
  const caseNoRelevantEvents = determineOutcome(ne4, pc4, el4, c4, threshold) === "NO_RELEVANT_EVENTS";

  const nonAlertLines = [
    JSON.stringify({ timestamp: now, level: "error", message: "Something else entirely", correlationId: "corr-7" }),
  ];
  const { count: c5, nonEmptyCount: ne5, parsedCount: pc5, errorLevelInWindowCount: el5 } = scanLines(nonAlertLines, cutoffMs);
  const caseHealthy = determineOutcome(ne5, pc5, el5, c5, threshold) === "HEALTHY";

  const pass = caseNormal && caseNoData && caseMalformed && caseNoRelevantEvents && caseHealthy;
  process.stdout.write(
    JSON.stringify({ selfTest: true, pass, count, expectedCount: 2, outcome: outcomeNormal, caseNormal, caseNoData, caseMalformed, caseNoRelevantEvents, caseHealthy, matches }) + "\n",
  );
  process.exit(pass ? 0 : 1);
}

const input = logFile ? createReadStream(logFile) : process.stdin;
const rl = createInterface({ input, crlfDelay: Infinity });
const cutoffMs = Date.now() - hours * 3_600_000;
const allLines = [];
for await (const line of rl) {
  allLines.push(line);
}

const { count, matches, nonEmptyCount, parsedCount, errorLevelInWindowCount } = scanLines(allLines, cutoffMs);
const outcome = determineOutcome(nonEmptyCount, parsedCount, errorLevelInWindowCount, count, threshold);
const fired = outcome === "FIRED";

if (outcome === "NO_DATA" || outcome === "MALFORMED" || outcome === "NO_RELEVANT_EVENTS") {
  process.stderr.write(
    `alert-tenant-ctx-errors: ${outcome} — cannot determine health from this log stream\n`,
  );
  process.stdout.write(
    JSON.stringify({
      fired: false,
      outcome,
      count,
      threshold: { maxOccurrences: threshold, windowHours: hours },
      destination: "CONFIGURE_ME — wire exit-code 1 to your oncall system",
      matches,
    }) + "\n",
  );
  process.exit(2);
}

process.stdout.write(
  JSON.stringify({
    fired,
    outcome,
    count,
    threshold: { maxOccurrences: threshold, windowHours: hours },
    destination: "CONFIGURE_ME — wire exit-code 1 to your oncall system",
    matches,
  }) + "\n",
);
process.exit(fired ? 1 : 0);
