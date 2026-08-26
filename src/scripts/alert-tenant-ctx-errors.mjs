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
 *      which carries `meta.sqlstate`, and → reportError → LogErrorReporter.
 *   b. After-commit hook failures → TenantContextInterceptor → reportError → LogErrorReporter,
 *      which emits `message="ERROR_REPORT"` with `sqlstate` and `errorClass="tenant-context"`.
 * Both paths emit a JSON line with level="error" and "42501" somewhere in the payload.
 *
 * WHY THE SQLSTATE HAS TO BE LIFTED OUT: postgres-js builds its error message from
 * the server's message text alone ("permission denied for table X") and puts the
 * SQLSTATE on `.code`, which Drizzle then buries one or two `.cause` links down.
 * Until `sqlstateOf` lifted it into the log record, no emitted line contained the
 * string "42501" and this predicate could never match a real incident — only the
 * hand-written fixture it was tested against. The self-test below therefore uses
 * the shape the application actually emits.
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
  // Every fixture is the shape the application actually writes. The two positive
  // lines are the two real paths (a) and (b); note that neither carries "42501"
  // in its human message — only in the lifted `sqlstate` field, which is the
  // whole point of the predicate.
  const fixtureLines = [
    // (a) AllExceptionsFilter → logger.error, SQLSTATE under meta.
    JSON.stringify({ timestamp: now, level: "error", message: "Unhandled exception", correlationId: "corr-1", orgId: "org_fixture", route: "/notifications", meta: { message: "permission denied for table outbox_events", sqlstate: "42501", table: "outbox_events" } }),
    // (b) TenantContextInterceptor → reportError → LogErrorReporter.
    JSON.stringify({ timestamp: now, level: "error", message: "ERROR_REPORT", correlationId: "corr-2", orgId: "org_fixture", route: "/notifications", sqlstate: "42501", errorClass: "tenant-context", error: { name: "Error", message: "Failed query: insert into notifications", cause: { name: "PostgresError", message: "permission denied for table notifications" } }, extra: { phase: "after-commit" } }),
    // Right prose, no SQLSTATE — a permission error that is not a missing GUC.
    JSON.stringify({ timestamp: now, level: "error", message: "Unhandled exception", correlationId: "corr-3", meta: { message: "permission denied", sqlstate: "42P01" } }),
    // Wrong level.
    JSON.stringify({ timestamp: now, level: "warn", message: "[git-webhook] signature verification failed", correlationId: "corr-4" }),
    // Unrelated error.
    JSON.stringify({ timestamp: now, level: "error", message: "Something else", correlationId: "corr-5", meta: { message: "some other error" } }),
    // Right shape, outside the lookback window.
    JSON.stringify({ timestamp: stale, level: "error", message: "ERROR_REPORT", correlationId: "corr-6", sqlstate: "42501", errorClass: "tenant-context" }),
  ];
  const cutoffMs = Date.now() - hours * 3_600_000;
  const { count, matches } = scanLines(fixtureLines, cutoffMs);
  const fired = count > threshold;
  const pass = count === 2 && fired === true;
  process.stdout.write(
    JSON.stringify({ selfTest: true, pass, count, expectedCount: 2, fired, matches }) + "\n",
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
