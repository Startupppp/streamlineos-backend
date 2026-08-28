/**
 * Usage: cat app-stderr.log | node alert-employment-drift.mjs [--hours=N] [--threshold=N] [--kind=drift|fallback|any] [--log=FILE] [--self-test]
 * Exit codes: 0 = clear, 1 = alert should fire, 2 = configuration error.
 */
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";

const DRIFT_EVENT = "EMPLOYMENT_DRIFT";
const FALLBACK_EVENT = "EMPLOYMENT_LEGACY_FALLBACK";

const args = process.argv.slice(2);
const hours = Math.max(1, parseInt(args.find((a) => a.startsWith("--hours="))?.slice(8) ?? "1", 10));
const threshold = Math.max(0, parseInt(args.find((a) => a.startsWith("--threshold="))?.slice(12) ?? "0", 10));
const logFile = args.find((a) => a.startsWith("--log="))?.slice(6);
const kind = args.find((a) => a.startsWith("--kind="))?.slice(7) ?? "any";

if (!["drift", "fallback", "any"].includes(kind)) {
  process.stderr.write(`Unknown --kind=${kind}; expected drift, fallback or any\n`);
  process.exit(2);
}

const wantedEvents =
  kind === "drift" ? [DRIFT_EVENT] : kind === "fallback" ? [FALLBACK_EVENT] : [DRIFT_EVENT, FALLBACK_EVENT];

function eventOf(record) {
  const fromExtra = record?.extra?.event;
  if (typeof fromExtra === "string") return fromExtra;
  const fromError = record?.error?.message;
  if (typeof fromError !== "string") return null;
  if (fromError.startsWith(`${DRIFT_EVENT}:`)) return DRIFT_EVENT;
  if (fromError === FALLBACK_EVENT) return FALLBACK_EVENT;
  return null;
}

export function scanLines(lines, cutoffMs) {
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
    if (record.message !== "ERROR_REPORT") continue;
    const event = eventOf(record);
    if (event === null || !wantedEvents.includes(event)) continue;
    const ts = record.timestamp ? new Date(record.timestamp).getTime() : NaN;
    if (!Number.isNaN(ts) && ts < cutoffMs) continue;
    matches.push({
      timestamp: record.timestamp ?? null,
      event,
      orgId: record.extra?.orgId ?? record.orgId ?? null,
      userId: record.extra?.userId ?? null,
      field: record.extra?.field ?? null,
      canonicalValue: record.extra?.canonicalValue ?? null,
      legacyValue: record.extra?.legacyValue ?? null,
    });
  }
  return { count: matches.length, matches };
}

if (args.includes("--self-test")) {
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - (hours + 1) * 3_600_000).toISOString();
  const fixtureLines = [
    JSON.stringify({ timestamp: now, level: "error", message: "ERROR_REPORT", fingerprint: "f1", error: { name: "Error", message: "EMPLOYMENT_DRIFT: designation" }, extra: { event: DRIFT_EVENT, orgId: "org_fixture", userId: "usr_1", field: "designation", canonicalValue: "Engineer", legacyValue: "Developer" } }),
    JSON.stringify({ timestamp: now, level: "error", message: "ERROR_REPORT", fingerprint: "f2", error: { name: "Error", message: FALLBACK_EVENT }, extra: { event: FALLBACK_EVENT, orgId: "org_fixture", userId: "usr_2", field: "employeeNumber" } }),
    JSON.stringify({ timestamp: now, level: "error", message: "ERROR_REPORT", fingerprint: "f3", sqlstate: "42501", errorClass: "tenant-context", error: { name: "Error", message: "permission denied" } }),
    JSON.stringify({ timestamp: now, level: "warn", message: "ERROR_REPORT", error: { name: "Error", message: "EMPLOYMENT_DRIFT: designation" }, extra: { event: DRIFT_EVENT } }),
    JSON.stringify({ timestamp: now, level: "error", message: "Unhandled exception", meta: { message: "EMPLOYMENT_DRIFT mentioned in prose only" } }),
    JSON.stringify({ timestamp: stale, level: "error", message: "ERROR_REPORT", error: { name: "Error", message: "EMPLOYMENT_DRIFT: taxId" }, extra: { event: DRIFT_EVENT, orgId: "org_fixture", field: "taxId", canonicalValue: "<redacted>", legacyValue: "<redacted>" } }),
  ];
  const expectedCount = kind === "any" ? 2 : 1;
  const cutoffMs = Date.now() - hours * 3_600_000;
  const { count, matches } = scanLines(fixtureLines, cutoffMs);
  const fired = count > threshold;
  const pass = count === expectedCount && fired === true;
  process.stdout.write(
    JSON.stringify({ selfTest: true, kind, pass, count, expectedCount, fired, matches }) + "\n",
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
    kind,
    count,
    threshold: { maxOccurrences: threshold, windowHours: hours },
    destination: "CONFIGURE_ME — wire exit-code 1 to your oncall system",
    matches,
  }) + "\n",
);
process.exit(fired ? 1 : 0);
