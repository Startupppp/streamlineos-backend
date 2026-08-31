import { readFileSync, existsSync } from "node:fs";

const DB_SEAM = "db.query.execute";
const CACHE_SEAM = "cache.roundtrip";
const RELEVANT_SEAMS = new Set([DB_SEAM, CACHE_SEAM]);

export function readSpanLog(logFilePath) {
  if (!logFilePath) return { status: "skipped", reason: "APP_LOG_FILE not set — pipe app stdout to a file and set APP_LOG_FILE=<path>" };
  if (!existsSync(logFilePath)) return { status: "absent", path: logFilePath, reason: `Log file not found: ${logFilePath}` };

  let raw;
  try {
    raw = readFileSync(logFilePath, "utf8");
  } catch (e) {
    return { status: "read-error", reason: String(e?.message ?? e) };
  }

  const orgDbTimeMs = new Map();
  const orgCacheTimeMs = new Map();
  let totalSpans = 0;
  let parseErrors = 0;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      parseErrors++;
      continue;
    }

    if (obj?.message !== "SPAN") continue;
    if (!RELEVANT_SEAMS.has(obj.name)) continue;

    totalSpans++;
    const orgId = typeof obj["org.id"] === "string" && obj["org.id"] ? obj["org.id"] : null;
    const latency = typeof obj.latencyMs === "number" && Number.isFinite(obj.latencyMs) ? obj.latencyMs : 0;

    if (obj.name === DB_SEAM) {
      orgDbTimeMs.set(orgId, (orgDbTimeMs.get(orgId) ?? 0) + latency);
    } else {
      orgCacheTimeMs.set(orgId, (orgCacheTimeMs.get(orgId) ?? 0) + latency);
    }
  }

  const orgIds = new Set([...orgDbTimeMs.keys(), ...orgCacheTimeMs.keys()]);

  return {
    status: "ok",
    totalSpans,
    parseErrors,
    orgCount: orgIds.size,
    orgDbTimeMs,
    orgCacheTimeMs,
  };
}

export function topOrgsByDbTime(logResult, limit) {
  if (logResult.status !== "ok") return [];
  const entries = [];
  for (const [orgId, ms] of logResult.orgDbTimeMs) {
    if (orgId === null) continue;
    entries.push({ orgId, dbTimeMs: ms, cacheTimeMs: logResult.orgCacheTimeMs.get(orgId) ?? 0 });
  }
  entries.sort((a, b) => b.dbTimeMs - a.dbTimeMs);
  return entries.slice(0, limit ?? 50);
}

export const ATTRIBUTION_NOTES = {
  dbTime: "db.query.execute spans carry org.id from ObservabilityContext; aggregate from APP_LOG_FILE JSON lines.",
  cacheTime: "cache.roundtrip spans carry org.id from ObservabilityContext; aggregate from APP_LOG_FILE JSON lines.",
  pgStatStatements: "pg_stat_statements aggregates by (userid, dbid, queryid) — no org-level attribution; use span log instead.",
  pgStatDatabase: "pg_stat_database reports whole-database totals — no org-level attribution; use span log instead.",
  egress: "Network egress is measured at the CDN or load balancer, not in the application process. Source: Cloudflare analytics dashboard or host bandwidth billing. Runbook: EGRESS section in RUNBOOKS.md.",
  redisMemory: "Per-org Redis memory is estimable via SCAN + MEMORY USAGE on org-prefixed keys (e.g. 'org:<id>:*'). Requires UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN. Upstash REST API supports MEMORY USAGE per key but not bulk scanning — scan with SCAN 0 MATCH 'org:<id>:*' COUNT 100.",
};
