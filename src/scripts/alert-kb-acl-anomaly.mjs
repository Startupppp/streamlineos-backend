import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import process from "node:process";

const SPAN_MESSAGE = "SPAN";
const STATUS_CODE_KEY = "http.status_code";

const DEFAULT_DENIAL_RATIO = 0.15;
const DEFAULT_NOT_FOUND_RATIO = 0.4;
const MIN_DENIALS = 10;
const MIN_NOT_FOUND = 10;
const MIN_TOTAL_REQUESTS = 20;

const args = process.argv.slice(2);
const hours = Math.max(1, parseInt(args.find((a) => a.startsWith("--hours="))?.slice(8) ?? "1", 10));
const logFile = args.find((a) => a.startsWith("--log="))?.slice(6);

function ratioArg(flag, fallback) {
  const raw = args.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

const denialRatioThreshold = ratioArg("--denial-ratio", DEFAULT_DENIAL_RATIO);
const notFoundRatioThreshold = ratioArg("--not-found-ratio", DEFAULT_NOT_FOUND_RATIO);

function isKbRoute(spanName) {
  if (typeof spanName !== "string") return false;
  const spaceIndex = spanName.indexOf(" ");
  if (spaceIndex === -1) return false;
  const path = spanName.slice(spaceIndex + 1);
  return path.startsWith("/kb/") || path.startsWith("/kb?") || path === "/kb";
}

export function summarise(lines, cutoffMs, denialThreshold, notFoundThreshold) {
  let totalKbRequests = 0;
  let denials403 = 0;
  let notFound404 = 0;
  const affectedRoutes = new Map();

  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.message !== SPAN_MESSAGE) continue;
    if (!isKbRoute(record.name)) continue;

    const ts = record.timestamp ? new Date(record.timestamp).getTime() : NaN;
    if (!Number.isNaN(ts) && ts < cutoffMs) continue;

    const statusCode = record[STATUS_CODE_KEY];
    if (typeof statusCode !== "number") continue;

    totalKbRequests += 1;

    if (statusCode === 403) {
      denials403 += 1;
      const route = record.name;
      affectedRoutes.set(route, (affectedRoutes.get(route) ?? 0) + 1);
    }

    if (statusCode === 404) {
      notFound404 += 1;
      const route = record.name;
      affectedRoutes.set(route, (affectedRoutes.get(route) ?? 0) + 1);
    }
  }

  const denialRatio = totalKbRequests === 0 ? 0 : denials403 / totalKbRequests;
  const notFoundRatio = totalKbRequests === 0 ? 0 : notFound404 / totalKbRequests;

  const denialBreached =
    totalKbRequests >= MIN_TOTAL_REQUESTS &&
    denials403 >= MIN_DENIALS &&
    denialRatio > denialThreshold;

  const notFoundBreached =
    totalKbRequests >= MIN_TOTAL_REQUESTS &&
    notFound404 >= MIN_NOT_FOUND &&
    notFoundRatio > notFoundThreshold;

  const topRoutes = [...affectedRoutes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([route, count]) => ({ route, count }));

  return {
    totalKbRequests,
    denials403,
    notFound404,
    denialRatio,
    notFoundRatio,
    denialRatioThreshold: denialThreshold,
    notFoundRatioThreshold: notFoundThreshold,
    minDenials: MIN_DENIALS,
    minNotFound: MIN_NOT_FOUND,
    minTotalRequests: MIN_TOTAL_REQUESTS,
    denialBreached,
    notFoundBreached,
    breached: denialBreached || notFoundBreached,
    topAffectedRoutes: topRoutes,
  };
}

if (args.includes("--self-test")) {
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - (hours + 1) * 3_600_000).toISOString();

  const kbSpan = (method, path, statusCode, timestamp = now) =>
    JSON.stringify({
      timestamp,
      level: "info",
      message: SPAN_MESSAGE,
      name: `${method} ${path}`,
      status: statusCode >= 500 ? "error" : "ok",
      latencyMs: 45,
      [STATUS_CODE_KEY]: statusCode,
    });

  const nonKbSpan = (statusCode, timestamp = now) =>
    JSON.stringify({
      timestamp,
      level: "info",
      message: SPAN_MESSAGE,
      name: `GET /tickets/123`,
      status: "ok",
      latencyMs: 30,
      [STATUS_CODE_KEY]: statusCode,
    });

  const healthyLines = [
    ...Array.from({ length: 30 }, () => kbSpan("GET", "/kb/pages", 200)),
    ...Array.from({ length: 3 }, () => kbSpan("GET", "/kb/pages/999", 404)),
    ...Array.from({ length: 2 }, () => kbSpan("GET", "/kb/spaces/999", 403)),
    ...Array.from({ length: 5 }, () => nonKbSpan(404)),
  ];

  const denialSpikeLines = [
    ...Array.from({ length: 20 }, () => kbSpan("GET", "/kb/pages", 200)),
    ...Array.from({ length: 15 }, () => kbSpan("GET", "/kb/pages/secret", 403)),
    ...Array.from({ length: 5 }, () => kbSpan("GET", "/kb/spaces/restricted", 403)),
  ];

  const notFoundSpikeLines = [
    ...Array.from({ length: 25 }, () => kbSpan("GET", "/kb/pages", 200)),
    ...Array.from({ length: 20 }, () => kbSpan("GET", "/kb/pages/stale", 404)),
    kbSpan("GET", "/kb/pages/old", 404, stale),
    ...Array.from({ length: 5 }, () => nonKbSpan(404)),
  ];

  const tooFewRequestsLines = [
    ...Array.from({ length: 5 }, () => kbSpan("GET", "/kb/pages", 200)),
    ...Array.from({ length: 10 }, () => kbSpan("GET", "/kb/pages/secret", 403)),
  ];

  const cutoff = Date.now() - hours * 3_600_000;
  const healthy = summarise(healthyLines, cutoff, denialRatioThreshold, notFoundRatioThreshold);
  const denialSpike = summarise(denialSpikeLines, cutoff, denialRatioThreshold, notFoundRatioThreshold);
  const notFoundSpike = summarise(notFoundSpikeLines, cutoff, denialRatioThreshold, notFoundRatioThreshold);
  const tooFew = summarise(tooFewRequestsLines, cutoff, denialRatioThreshold, notFoundRatioThreshold);
  const empty = summarise([], cutoff, denialRatioThreshold, notFoundRatioThreshold);

  const checks = {
    healthyClear: !healthy.breached,
    nonKbSpansExcluded: healthy.totalKbRequests === 35,
    staleSpansExcluded: notFoundSpike.totalKbRequests === 45,
    denialSpikeFires: denialSpike.breached && denialSpike.denialBreached,
    notFoundSpikeFires: notFoundSpike.breached && notFoundSpike.notFoundBreached,
    tooFewRequestsDoesNotFire: !tooFew.breached,
    emptyInputDoesNotFire: !empty.breached && empty.totalKbRequests === 0,
  };

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(
    JSON.stringify({ selfTest: true, pass, checks, healthy, denialSpike }) + "\n",
  );
  process.exit(pass ? 0 : 1);
}

const input = logFile ? createReadStream(logFile) : process.stdin;
const rl = createInterface({ input, crlfDelay: Infinity });
const allLines = [];
for await (const line of rl) allLines.push(line);

const summary = summarise(
  allLines,
  Date.now() - hours * 3_600_000,
  denialRatioThreshold,
  notFoundRatioThreshold,
);

if (summary.totalKbRequests === 0) {
  process.stdout.write(
    JSON.stringify({
      fired: false,
      error:
        'No KB route SPAN lines found. Either the window is empty, the log exporter is unwired, or no requests hit /kb/ routes in this window. This is not a clear — pipe a populated log window before trusting the result.',
      linesRead: allLines.length,
    }) + "\n",
  );
  process.exit(2);
}

process.stdout.write(
  JSON.stringify({
    fired: summary.breached,
    windowHours: hours,
    destination: "CONFIGURE_ME — wire exit-code 1 to your oncall system (PagerDuty, Slack webhook, etc.)",
    ...summary,
  }) + "\n",
);
process.exit(summary.breached ? 1 : 0);
