/**
 * The fourth alert: p95 latency on the ten hottest endpoints.
 *
 * SOURCE: the structured log stream. `LogSpanExporter` writes one JSON line per
 * finished span with `message="SPAN"`, `name`, `latencyMs` and `status`; the
 * request span is opened in `common/http/correlation-id.middleware.ts` and closed
 * on the response's `finish`/`close`, so every served request produces exactly one.
 * No metrics database, no APM agent — the deferral recorded in the c20-05 ticket.
 *
 * WHY THE NAME IS NORMALISED: the span is named `${method} ${req.path}`, and
 * `req.path` is the concrete URL, not the route template. Left as-is, every record
 * id becomes its own endpoint — `GET /deals/<uuid>` appears once per deal — and a
 * "hottest endpoints" ranking degenerates into a list of single-request paths with
 * meaningless percentiles. Identifier-shaped segments are folded to `:id` so the
 * grouping is per endpoint.
 *
 * THRESHOLD: none by default — this reports. Pass `--threshold-ms=N` to make it an
 * alert: exit 1 when any endpoint in the top N exceeds that p95. Pick the number
 * from a measured baseline rather than a guess; a threshold nobody derived is the
 * noisy alert this candidate exists to avoid.
 *
 * Usage:
 *   journalctl -u streamlineos-api --since "1 hour ago" -o cat | node alert-p95.mjs
 *   node alert-p95.mjs --log=app.log --top=10 --threshold-ms=800
 *   node alert-p95.mjs --self-test
 *
 * Exit codes:
 *   0 = no endpoint over the threshold (or no threshold given)
 *   1 = at least one endpoint over the threshold, or the self-test failed
 *   2 = no span lines found, which means the exporter is unwired — see main.ts
 */
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import { resolveRouteAttribution, extractNamespaceFromSpanName } from "./route-attribution.mjs";

const args = process.argv.slice(2);
const top = Math.max(1, parseInt(args.find((a) => a.startsWith("--top="))?.slice(6) ?? "10", 10));
const thresholdMs = args.find((a) => a.startsWith("--threshold-ms="))?.slice(15);
const logFile = args.find((a) => a.startsWith("--log="))?.slice(6);
const hours = Math.max(1, parseInt(args.find((a) => a.startsWith("--hours="))?.slice(8) ?? "1", 10));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX = /^[0-9a-f]{16,}$/i;
const DIGITS = /^\d+$/;
/** ULID / nanoid / cuid: long, mixed case or digit-bearing, no vowel-driven word shape. */
const OPAQUE_ID = /^(?=.*\d)[A-Za-z0-9_-]{12,}$/;

function normaliseSegment(segment) {
  if (segment === "") return segment;
  if (UUID.test(segment)) return ":id";
  if (DIGITS.test(segment)) return ":id";
  if (LONG_HEX.test(segment)) return ":id";
  if (OPAQUE_ID.test(segment)) return ":id";
  return segment;
}

export function normaliseSpanName(name) {
  const firstSpace = name.indexOf(" ");
  if (firstSpace === -1) return name;
  const method = name.slice(0, firstSpace);
  const path = name.slice(firstSpace + 1).split("?")[0];
  return `${method} ${path.split("/").map(normaliseSegment).join("/")}`;
}

export function percentile(sortedAscending, fraction) {
  if (sortedAscending.length === 0) return null;
  // Nearest-rank: the smallest value at or above the requested fraction of the
  // sample. With a handful of requests an interpolated percentile invents a
  // latency nobody observed, which is worse than reporting a real one.
  const rank = Math.ceil(fraction * sortedAscending.length);
  return sortedAscending[Math.min(sortedAscending.length - 1, Math.max(0, rank - 1))];
}

export function summarise(lines, cutoffMs) {
  const byEndpoint = new Map();
  let spanLines = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.message !== "SPAN") continue;
    if (typeof record.name !== "string") continue;
    if (typeof record.latencyMs !== "number" || !Number.isFinite(record.latencyMs)) continue;

    const ts = record.timestamp ? new Date(record.timestamp).getTime() : NaN;
    if (!Number.isNaN(ts) && ts < cutoffMs) continue;

    spanLines += 1;
    const endpoint = normaliseSpanName(record.name);
    const bucket = byEndpoint.get(endpoint) ?? { latencies: [], errors: 0 };
    bucket.latencies.push(record.latencyMs);
    if (record.status === "error") bucket.errors += 1;
    byEndpoint.set(endpoint, bucket);
  }

  const endpoints = [...byEndpoint.entries()]
    .map(([endpoint, { latencies, errors }]) => {
      const sorted = [...latencies].sort((a, b) => a - b);
      const namespace = extractNamespaceFromSpanName(endpoint);
      const attribution = namespace !== null ? resolveRouteAttribution(namespace) : { unattributable: true, namespace: null };
      return {
        endpoint,
        requests: sorted.length,
        errors,
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        p99Ms: percentile(sorted, 0.99),
        maxMs: sorted[sorted.length - 1] ?? null,
        attribution,
      };
    })
    // Hottest by request count — p95 on a rarely-called endpoint is noise.
    .sort((a, b) => b.requests - a.requests);

  return { spanLines, endpoints };
}

if (args.includes("--self-test")) {
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - (hours + 1) * 3_600_000).toISOString();
  const span = (name, latencyMs, status = "ok", timestamp = now) =>
    JSON.stringify({ timestamp, level: "info", message: "SPAN", name, latencyMs, status });

  const fixtureLines = [
    // Twenty calls to one endpoint, each with a different record id: they must
    // collapse to a single row, or the ranking is meaningless.
    ...Array.from({ length: 19 }, (_, i) =>
      span(`GET /deals/8f14e45f-ceea-467a-9a3f-${String(i).padStart(12, "0")}`, 100),
    ),
    span("GET /deals/8f14e45f-ceea-467a-9a3f-ffffffffffff", 900, "error"),
    // A quieter endpoint, numeric id.
    span("GET /invoices/12345", 50),
    span("GET /invoices/67890", 70),
    // HR endpoint — attributed to people-team.
    span("GET /hr/employees/8f14e45f-ceea-467a-9a3f-000000000001", 60),
    span("GET /hr/employees/8f14e45f-ceea-467a-9a3f-000000000002", 80),
    // Platform surface — attributed to platform-reliability.
    span("GET /health/ready", 5),
    // Not a span line.
    JSON.stringify({ timestamp: now, level: "error", message: "ERROR_REPORT", sqlstate: "42501" }),
    // Span outside the window.
    span("GET /deals/8f14e45f-ceea-467a-9a3f-aaaaaaaaaaaa", 5_000, "ok", stale),
  ];

  const { spanLines, endpoints } = summarise(fixtureLines, Date.now() - hours * 3_600_000);
  const deals = endpoints.find((e) => e.endpoint === "GET /deals/:id");
  const invoices = endpoints.find((e) => e.endpoint === "GET /invoices/:id");
  const hrEmployees = endpoints.find((e) => e.endpoint === "GET /hr/employees/:id");
  const health = endpoints.find((e) => e.endpoint === "GET /health/ready");

  const checks = {
    staleSpanExcluded: spanLines === 25,
    idsCollapsedAndFourEndpoints: endpoints.length === 4,
    hottestFirst: endpoints[0]?.endpoint === "GET /deals/:id",
    dealsRequestCount: deals?.requests === 20,
    // 19×100ms + 1×900ms: nearest-rank p95 of 20 samples is the 19th, still 100.
    p95IgnoresTheSingleOutlier: deals?.p95Ms === 100,
    p99CatchesTheOutlier: deals?.p99Ms === 900,
    errorsCounted: deals?.errors === 1,
    quieterEndpointSummarised: invoices?.requests === 2 && invoices?.p95Ms === 70,
    hrAttributesToPeopleTeam:
      hrEmployees?.attribution?.module === "hr" &&
      hrEmployees?.attribution?.owner === "people-team",
    healthAttributesToPlatform:
      health?.attribution?.platform === true &&
      health?.attribution?.owner === "platform-reliability",
    unattributableEndpointReported: deals?.attribution?.unattributable === true,
    ownersDifferBetweenHrAndHealth:
      hrEmployees?.attribution?.owner !== health?.attribution?.owner,
  };
  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, checks, endpoints }) + "\n");
  process.exit(pass ? 0 : 1);
}

const input = logFile ? createReadStream(logFile) : process.stdin;
const rl = createInterface({ input, crlfDelay: Infinity });
const allLines = [];
for await (const line of rl) allLines.push(line);

const { spanLines, endpoints } = summarise(allLines, Date.now() - hours * 3_600_000);

if (spanLines === 0) {
  process.stdout.write(
    JSON.stringify({
      fired: false,
      error:
        'No lines with message="SPAN" in the input. Either the window is empty or the span exporter is unwired — check that main.ts calls setSpanExporter(new LogSpanExporter()).',
      linesRead: allLines.length,
    }) + "\n",
  );
  process.exit(2);
}

const hottest = endpoints.slice(0, top);
const limit = thresholdMs === undefined ? null : Number(thresholdMs);
const breached = limit === null ? [] : hottest.filter((e) => e.p95Ms !== null && e.p95Ms > limit);

process.stdout.write(
  JSON.stringify({
    fired: breached.length > 0,
    windowHours: hours,
    spanLines,
    threshold: limit === null ? "none — reporting only" : { p95Ms: limit, appliesToTop: top },
    destination: "CONFIGURE_ME — wire exit-code 1 to your oncall system",
    breached,
    hottest,
  }) + "\n",
);
process.exit(breached.length > 0 ? 1 : 0);
