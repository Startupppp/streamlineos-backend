/**
 * Cache invalidation drop detector, read from the structured log stream.
 *
 * SOURCE: `CacheService.invalidateWithRetry` logs one ERROR line per dropped
 * invalidation with the marker `cache.invalidation.dropped`. A drop means a
 * Redis write failed after all retries, leaving a stale entry serving until
 * it expires naturally. Zero drops is the expected steady state; any non-zero
 * count in a window is worth operator attention.
 *
 * WHY A COUNT, NOT A RATIO: there is no denominator that makes a single drop
 * acceptable. One drop in a quiet window is the same severity as ten in a busy
 * one — a cache entry is either coherent or it is not.
 *
 * EXIT CODES (operator contract, tested in alert-delivery.spec.ts):
 *   0 = no drops detected in the window
 *   1 = at least MIN_DROPS drops found (alert fires, dispatch to oncall)
 *   2 = no log lines found (window empty or stream not connected)
 *
 * Usage:
 *   journalctl -u streamlineos-api --since "1 hour ago" -o cat | node alert-cache-invalidation-dropped.mjs
 *   node alert-cache-invalidation-dropped.mjs --log=app.log --hours=24
 *   node alert-cache-invalidation-dropped.mjs --self-test
 */
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import process from "node:process";

const DROPPED_MARKER = "cache.invalidation.dropped";
const DEFAULT_MIN_DROPS = 1;

const args = process.argv.slice(2);
const hours = Math.max(1, parseInt(args.find((a) => a.startsWith("--hours="))?.slice(8) ?? "1", 10));
const logFile = args.find((a) => a.startsWith("--log="))?.slice(6);
const minDropsArg = args.find((a) => a.startsWith("--min-drops="))?.slice(12);
const minDrops = (() => {
  if (minDropsArg === undefined) return DEFAULT_MIN_DROPS;
  const parsed = parseInt(minDropsArg, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_MIN_DROPS;
})();

export function summarise(lines, cutoffMs, threshold = DEFAULT_MIN_DROPS) {
  let totalLines = 0;
  let drops = 0;
  const samples = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    totalLines += 1;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = record.timestamp ? new Date(record.timestamp).getTime() : NaN;
    if (!Number.isNaN(ts) && ts < cutoffMs) continue;

    if (typeof record.message !== "string") continue;
    if (!record.message.includes(DROPPED_MARKER)) continue;

    drops += 1;
    if (samples.length < 10) {
      samples.push({
        timestamp: record.timestamp ?? null,
        label: typeof record.label === "string" ? record.label : null,
        target: typeof record.target === "string" ? record.target : null,
      });
    }
  }

  return {
    totalLines,
    drops,
    minDrops: threshold,
    fired: drops >= threshold,
    samples,
  };
}

if (args.includes("--self-test")) {
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - (hours + 1) * 3_600_000).toISOString();

  const dropLine = (timestamp = now) =>
    JSON.stringify({
      timestamp,
      level: "error",
      message: `${DROPPED_MARKER} kb:org:v1:key1 target=kb:org:v1:key1 attempts=3`,
      label: "CacheService",
    });

  const healthyLines = [
    JSON.stringify({ timestamp: now, level: "info", message: "Cache hit" }),
    JSON.stringify({ timestamp: now, level: "info", message: "SPAN", name: "kb.ask.operation" }),
    dropLine(stale),
  ];

  const droppingLines = [
    ...Array.from({ length: 3 }, () => dropLine()),
    JSON.stringify({ timestamp: now, level: "info", message: "Cache hit" }),
  ];

  const cutoff = Date.now() - hours * 3_600_000;
  const healthy = summarise(healthyLines, cutoff);
  const dropping = summarise(droppingLines, cutoff);
  const empty = summarise([], cutoff);

  const checks = {
    staleLineExcluded: healthy.drops === 0 && healthy.fired === false,
    healthyDoesNotFire: healthy.fired === false,
    droppingFires: dropping.fired === true && dropping.drops === 3,
    samplesCollected: dropping.samples.length === 3,
    emptyDoesNotFire: empty.fired === false && empty.drops === 0,
  };

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, checks, healthy, dropping }) + "\n");
  process.exit(pass ? 0 : 1);
}

const input = logFile ? createReadStream(logFile) : process.stdin;
const rl = createInterface({ input, crlfDelay: Infinity });
const allLines = [];
for await (const line of rl) allLines.push(line);

const summary = summarise(allLines, Date.now() - hours * 3_600_000, minDrops);

if (summary.totalLines === 0) {
  process.stdout.write(
    JSON.stringify({
      fired: false,
      error:
        `No log lines found in the input. Either the window is empty or the log stream is not connected.`,
      linesRead: 0,
    }) + "\n",
  );
  process.exit(2);
}

process.stdout.write(
  JSON.stringify({
    fired: summary.fired,
    windowHours: hours,
    droppedMarker: DROPPED_MARKER,
    minDrops,
    ...summary,
  }) + "\n",
);
process.exit(summary.fired ? 1 : 0);
