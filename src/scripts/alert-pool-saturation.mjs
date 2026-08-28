/**
 * Alert: database connection pool saturation.
 *
 * SOURCE: structured log stream (stdin or --log=file). Reads two signal types:
 *
 *   1. SPAN lines where seam="db.pool.wait" — emitted by pool-telemetry.ts once per
 *      connection acquisition. p95 over the window is compared to the db.pool.wait
 *      seam budget (3 ms). If p95 exceeds 3 ms, something is consistently waiting for
 *      a connection, which means the pool is undersized or a slow query holds connections.
 *
 *   2. Structured warning lines where message contains "pool saturated" — emitted by
 *      pool-telemetry.ts at most once per 30 s whenever a new acquire attempt finds
 *      inFlight >= max. Each occurrence means at least one request queued for a connection.
 *
 * WHY LOG LINES RATHER THAN GET /health/db:
 *   The /health/db endpoint returns a point-in-time snapshot. An alert cron that runs
 *   every minute will miss transient saturation spikes that resolved in between. Log-based
 *   detection covers the full window, not just the moment of the poll. It is also
 *   deterministically self-testable without a running API process.
 *
 * OPTIONAL HTTP MODE (--url=<base>):
 *   If --url= is supplied, the script additionally reads GET <base>/health/db using
 *   x-internal-secret from INTERNAL_API_SECRET. If the endpoint is unreachable, the
 *   script exits 2 ("endpoint unreachable") rather than 0 ("clear"), so a dead API
 *   never silently clears the alert.
 *
 * Usage:
 *   journalctl -u streamlineos-api --since "1 hour ago" -o cat | node alert-pool-saturation.mjs
 *   node alert-pool-saturation.mjs --log=app.log --hours=4
 *   node alert-pool-saturation.mjs --url=http://localhost:3000
 *   node alert-pool-saturation.mjs --self-test
 *
 * Exit codes:
 *   0 = clear
 *   1 = fired (p95 over budget or saturation events detected)
 *   2 = no signal lines found, or endpoint unreachable
 */
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import process from "node:process";

const POOL_WAIT_SEAM = "db.pool.wait";
const POOL_WAIT_BUDGET_MS = 3;
const SATURATION_MESSAGE_FRAGMENT = "pool saturated";

const args = process.argv.slice(2);
const hours = Math.max(1, parseInt(args.find((a) => a.startsWith("--hours="))?.slice(8) ?? "1", 10));
const logFile = args.find((a) => a.startsWith("--log="))?.slice(6);
const baseUrl = args.find((a) => a.startsWith("--url="))?.slice(6);

function percentile(sortedAscending, fraction) {
  if (sortedAscending.length === 0) return null;
  const rank = Math.ceil(fraction * sortedAscending.length);
  return sortedAscending[Math.min(sortedAscending.length - 1, Math.max(0, rank - 1))];
}

function analyseLines(lines, cutoffMs) {
  const waitTimes = [];
  let saturationEvents = 0;
  let signalLines = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = record.timestamp ? new Date(record.timestamp).getTime() : NaN;
    if (!Number.isNaN(ts) && ts < cutoffMs) continue;

    if (
      record.message === "SPAN" &&
      record["seam"] === POOL_WAIT_SEAM &&
      typeof record.latencyMs === "number" &&
      Number.isFinite(record.latencyMs)
    ) {
      signalLines += 1;
      waitTimes.push(record.latencyMs);
      continue;
    }

    if (
      typeof record.message === "string" &&
      record.message.toLowerCase().includes(SATURATION_MESSAGE_FRAGMENT) &&
      (record.level === "warn" || record.level === "error")
    ) {
      signalLines += 1;
      saturationEvents += 1;
    }
  }

  const sorted = [...waitTimes].sort((a, b) => a - b);
  const p95WaitMs = percentile(sorted, 0.95);
  const p95Breached = p95WaitMs !== null && p95WaitMs > POOL_WAIT_BUDGET_MS;
  const saturationBreached = saturationEvents > 0;

  return {
    signalLines,
    waitSamples: waitTimes.length,
    p95WaitMs,
    saturationEvents,
    p95Breached,
    saturationBreached,
    fired: p95Breached || saturationBreached,
  };
}

async function fetchHttpSnapshot(base) {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    process.stderr.write(
      "INTERNAL_API_SECRET is required for --url= mode. Set the environment variable.\n",
    );
    process.exit(2);
  }

  const target = new URL("/health/db", base).toString();
  const parsed = new URL(target);
  const client = parsed.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: { "x-internal-secret": secret },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          if (res.statusCode === 401) {
            reject(new Error("INTERNAL_API_SECRET was rejected (401)"));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`Could not parse /health/db response: ${body.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(5_000, () => {
      req.destroy(new Error("Request to /health/db timed out after 5 s"));
    });
    req.end();
  });
}

if (args.includes("--self-test")) {
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - (hours + 1) * 3_600_000).toISOString();

  const poolSpan = (latencyMs, timestamp = now) =>
    JSON.stringify({
      timestamp,
      level: "info",
      message: "SPAN",
      name: "seam:db.pool.wait",
      latencyMs,
      status: "ok",
      seam: POOL_WAIT_SEAM,
    });

  const saturationWarn = (timestamp = now) =>
    JSON.stringify({
      timestamp,
      level: "warn",
      message: "Database pool saturated — tenant transactions are queueing for a connection",
      meta: { max: 10, inFlight: 10, waiting: 3, saturationEvents: 1 },
    });

  const case1Lines = [
    ...Array.from({ length: 9 }, () => poolSpan(1.0)),
    poolSpan(10.0),
  ];
  const case2Lines = [
    ...Array.from({ length: 20 }, () => poolSpan(1.0)),
  ];
  const case3Lines = [saturationWarn()];
  const case4Lines = [poolSpan(5_000, stale)];

  const cutoff = Date.now() - hours * 3_600_000;
  const result1 = analyseLines(case1Lines, cutoff);
  const result2 = analyseLines(case2Lines, cutoff);
  const result3 = analyseLines(case3Lines, cutoff);
  const result4 = analyseLines(case4Lines, cutoff);

  const checks = {
    case1P95BreachFiresWhenSingleOutlierPushesP95Over3ms: result1.p95Breached,
    case2AllUnder3msClear: !result2.p95Breached && !result2.saturationBreached,
    case3SaturationWarnFires: result3.saturationBreached && result3.fired,
    case4StaleSpanExcluded: result4.signalLines === 0 && !result4.fired,
  };

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(
    JSON.stringify({
      selfTest: true,
      pass,
      checks,
      budget: { seam: POOL_WAIT_SEAM, thresholdMs: POOL_WAIT_BUDGET_MS },
    }) + "\n",
  );
  process.exit(pass ? 0 : 1);
}

let httpResult = null;
if (baseUrl) {
  try {
    httpResult = await fetchHttpSnapshot(baseUrl);
  } catch (err) {
    process.stderr.write(`Endpoint unreachable: ${err.message}\n`);
    process.stdout.write(
      JSON.stringify({
        fired: false,
        error: "endpoint-unreachable",
        message: err.message,
        url: baseUrl,
      }) + "\n",
    );
    process.exit(2);
  }
}

const input = logFile ? createReadStream(logFile) : process.stdin;
const rl = createInterface({ input, crlfDelay: Infinity });
const allLines = [];
for await (const line of rl) allLines.push(line);

const logResult = analyseLines(allLines, Date.now() - hours * 3_600_000);

if (logResult.signalLines === 0 && !httpResult) {
  process.stdout.write(
    JSON.stringify({
      fired: false,
      error:
        'No db.pool.wait span lines or pool-saturation warn lines found. Either the window is empty, or the pool telemetry is unwired — check that pool-telemetry.ts is active and main.ts calls setSpanExporter(new LogSpanExporter()).',
      linesRead: allLines.length,
    }) + "\n",
  );
  process.exit(2);
}

let httpFired = false;
let httpSummary = null;
if (httpResult) {
  const pool = httpResult.pool ?? {};
  const httpP95Breached = typeof pool.p95WaitMs === "number" && pool.p95WaitMs > POOL_WAIT_BUDGET_MS;
  const httpWaitingBreached = typeof pool.waiting === "number" && pool.waiting > 0;
  httpFired = httpP95Breached || httpWaitingBreached;
  httpSummary = {
    status: httpResult.status,
    pool: {
      waiting: pool.waiting,
      inFlight: pool.inFlight,
      saturationEvents: pool.saturationEvents,
      p95WaitMs: pool.p95WaitMs,
      peakWaiting: pool.peakWaiting,
    },
    p95Breached: httpP95Breached,
    waitingBreached: httpWaitingBreached,
  };
}

const fired = logResult.fired || httpFired;
process.stdout.write(
  JSON.stringify({
    fired,
    windowHours: hours,
    budget: { seam: POOL_WAIT_SEAM, thresholdMs: POOL_WAIT_BUDGET_MS },
    destination: "CONFIGURE_ME — wire exit-code 1 to your oncall system",
    logSignal: {
      signalLines: logResult.signalLines,
      waitSamples: logResult.waitSamples,
      p95WaitMs: logResult.p95WaitMs,
      saturationEvents: logResult.saturationEvents,
      p95Breached: logResult.p95Breached,
      saturationBreached: logResult.saturationBreached,
    },
    ...(httpSummary ? { httpSignal: httpSummary } : {}),
  }) + "\n",
);
process.exit(fired ? 1 : 0);
