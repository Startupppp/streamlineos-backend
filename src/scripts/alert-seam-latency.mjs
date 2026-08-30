import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import process from "node:process";

const SEAM_ATTRIBUTE_KEY = "seam";

const SEAM_BUDGETS = {
  "db.pool.wait": 3,
  "db.guc.setup": 2,
  "db.query.execute": 9,
  "db.roundtrip.simple": 15,
  "db.roundtrip.complex": 37,
  "cache.roundtrip": 1.5,
  "route.cached.read": 112,
  "route.write": 375,
  "runtime.eventloop.delay": 37,
};

const args = process.argv.slice(2);
const hours = Math.max(1, parseInt(args.find((a) => a.startsWith("--hours="))?.slice(8) ?? "1", 10));
const logFile = args.find((a) => a.startsWith("--log="))?.slice(6);

function percentile(sortedAscending, fraction) {
  if (sortedAscending.length === 0) return null;
  const rank = Math.ceil(fraction * sortedAscending.length);
  return sortedAscending[Math.min(sortedAscending.length - 1, Math.max(0, rank - 1))];
}

function summarise(lines, cutoffMs) {
  const bySeam = new Map();
  let seamSpanLines = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.message !== "SPAN") continue;
    const seamName = record[SEAM_ATTRIBUTE_KEY];
    if (typeof seamName !== "string") continue;
    if (!(seamName in SEAM_BUDGETS)) continue;
    if (typeof record.latencyMs !== "number" || !Number.isFinite(record.latencyMs)) continue;

    const ts = record.timestamp ? new Date(record.timestamp).getTime() : NaN;
    if (!Number.isNaN(ts) && ts < cutoffMs) continue;

    seamSpanLines += 1;
    const bucket = bySeam.get(seamName) ?? { latencies: [], errors: 0 };
    bucket.latencies.push(record.latencyMs);
    if (record.status === "error") bucket.errors += 1;
    bySeam.set(seamName, bucket);
  }

  const seams = [...bySeam.entries()].map(([seam, { latencies, errors }]) => {
    const sorted = [...latencies].sort((a, b) => a - b);
    const thresholdMs = SEAM_BUDGETS[seam];
    const p95Ms = percentile(sorted, 0.95);
    return {
      seam,
      requests: sorted.length,
      errors,
      p50Ms: percentile(sorted, 0.5),
      p95Ms,
      maxMs: sorted[sorted.length - 1] ?? null,
      thresholdMs,
      breached: p95Ms !== null && p95Ms > thresholdMs,
    };
  });

  const breached = seams.filter((s) => s.breached);
  return { seamSpanLines, seams, breached };
}

if (args.includes("--self-test")) {
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - (hours + 1) * 3_600_000).toISOString();

  const seam = (seamName, latencyMs, status = "ok", timestamp = now) =>
    JSON.stringify({
      timestamp,
      level: "info",
      message: "SPAN",
      name: `seam:${seamName}`,
      latencyMs,
      status,
      [SEAM_ATTRIBUTE_KEY]: seamName,
    });

  const fixtureLines = [
    ...Array.from({ length: 10 }, () => seam("db.query.execute", 12)),
    seam("db.query.execute", 5),
    seam("cache.roundtrip", 1.0),
    seam("cache.roundtrip", 0.5),
    JSON.stringify({
      timestamp: now,
      level: "info",
      message: "SPAN",
      name: "GET /deals/:id",
      latencyMs: 200,
      status: "ok",
    }),
    seam("db.query.execute", 500, "ok", stale),
  ];

  const cutoff = Date.now() - hours * 3_600_000;
  const { seamSpanLines, seams, breached } = summarise(fixtureLines, cutoff);
  const { seamSpanLines: emptyCount } = summarise([], cutoff);

  const checks = {
    staleAndNonSeamExcluded: seamSpanLines === 13,
    dbQueryExecuteBreached: breached.some((b) => b.seam === "db.query.execute"),
    cacheRoundtripNotBreached: !breached.some((b) => b.seam === "cache.roundtrip"),
    noSeamSpansWouldExitTwo: emptyCount === 0,
  };

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, checks, seams, breached }) + "\n");
  process.exit(pass ? 0 : 1);
}

const input = logFile ? createReadStream(logFile) : process.stdin;
const rl = createInterface({ input, crlfDelay: Infinity });
const allLines = [];
for await (const line of rl) allLines.push(line);

const { seamSpanLines, seams, breached } = summarise(allLines, Date.now() - hours * 3_600_000);

if (seamSpanLines === 0) {
  process.stdout.write(
    JSON.stringify({
      fired: false,
      error: `No seam span lines found in the input. Either the window is empty or the seam instrumentation is unwired — check that spans carry the "${SEAM_ATTRIBUTE_KEY}" attribute and that main.ts calls setSpanExporter(new LogSpanExporter()).`,
      linesRead: allLines.length,
    }) + "\n",
  );
  process.exit(2);
}

process.stdout.write(
  JSON.stringify({
    fired: breached.length > 0,
    windowHours: hours,
    seamSpanLines,
    seamAttributeKey: SEAM_ATTRIBUTE_KEY,
    destination: "CONFIGURE_ME — wire exit-code 1 to your oncall system",
    breached,
    seams,
  }) + "\n",
);
process.exit(breached.length > 0 ? 1 : 0);
