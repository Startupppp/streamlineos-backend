/**
 * Detects tenant-context errors (Postgres SQLSTATE 42501) in the structured log stream.
 *
 * A 42501 means a query reached the connection pool with no tenant GUC set
 * (app.current_org_id() raises 42501 when the GUC is absent). This class of error
 * has caused production incidents where after-commit hooks or background sweeps
 * silently failed because they wrote inside the request transaction rather than
 * opening their own tenant context.
 *
 * SOURCE: structured log lines written to stderr by the application. Two paths:
 *   a. Unhandled request errors → AllExceptionsFilter → logger.error("Unhandled exception", ...)
 *   b. After-commit hook failures → TenantContextInterceptor → reportError + logger.error
 * Both paths emit a JSON line with level="error" and "42501" somewhere in the payload.
 *
 * THRESHOLD: 0 — any 42501 is a code bug. One occurrence in production is already
 * a regression that needs a fix in the next deploy.
 *
 * PREDICATE: level === "error" AND the serialized log line contains the string "42501"
 * AND the log timestamp is within the lookback window.
 *
 * Usage: cat app-stderr.log | node alert-tenant-ctx-errors.mjs [--hours=N] [--threshold=N] [--self-test]
 *
 * Pipe the application's stderr (JSON log lines) into this script. In production:
 *   journalctl -u streamlineos-api --since "1 hour ago" -o cat | node alert-tenant-ctx-errors.mjs
 *
 * Exit codes:
 *   0 = count ≤ threshold (clear)
 *   1 = count > threshold (alert should fire)
 *   2 = configuration error
 */
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";

const args = process.argv.slice(2);
const hours = Math.max(1, parseInt(args.find((a) => a.startsWith("--hours="))?.slice(8) ?? "1", 10));
const threshold = Math.max(0, parseInt(args.find((a) => a.startsWith("--threshold="))?.slice(12) ?? "0", 10));
const logFile = args.find((a) => a.startsWith("--log="))?.slice(6);

function scanLines(lines, cutoffMs) {
  const now = Date.now();
  const matches = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.level !== "error") continue;
    if (!line.includes("42501")) continue;
    const ts = record.timestamp ? new Date(record.timestamp).getTime() : NaN;
    if (!Number.isNaN(ts) && ts < cutoffMs) continue;
    matches.push({
      timestamp: record.timestamp ?? null,
      correlationId: record.correlationId ?? null,
      orgId: record.orgId ?? null,
      route: record.route ?? null,
      message: typeof record.meta?.message === "string" ? record.meta.message.slice(0, 200) : null,
    });
  }
  return { count: matches.length, matches };
}

if (args.includes("--self-test")) {
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - (hours + 1) * 3_600_000).toISOString();
  const fixtureLines = [
    JSON.stringify({ timestamp: now, level: "error", message: "Unhandled exception", correlationId: "corr-1", orgId: "org_fixture", route: "/notifications", meta: { message: "42501 insufficient_privilege: permission denied for table outbox_events" } }),
    JSON.stringify({ timestamp: now, level: "warn", message: "[git-webhook] signature verification failed", correlationId: "corr-2" }),
    JSON.stringify({ timestamp: now, level: "error", message: "Something else", correlationId: "corr-3", meta: { message: "some other error" } }),
    JSON.stringify({ timestamp: stale, level: "error", message: "Unhandled exception", correlationId: "corr-4", meta: { message: "42501 outside window" } }),
  ];
  const cutoffMs = Date.now() - hours * 3_600_000;
  const { count, matches } = scanLines(fixtureLines, cutoffMs);
  const fired = count > threshold;
  const pass = count === 1 && fired === true;
  process.stdout.write(
    JSON.stringify({ selfTest: true, pass, count, expectedCount: 1, fired, matches }) + "\n",
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

const { count, matches } = scanLines(allLines, cutoffMs);
const fired = count > threshold;
process.stdout.write(
  JSON.stringify({
    fired,
    count,
    threshold: { maxOccurrences: threshold, windowHours: hours },
    destination: "CONFIGURE_ME — wire exit-code 1 to your oncall system",
    matches,
  }) + "\n",
);
process.exit(fired ? 1 : 0);
