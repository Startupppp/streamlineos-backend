/**
 * Alert: outbox queue age and retry pressure.
 *
 * SOURCE: direct query to outbox_events (owner role — BYPASSRLS, no tenant GUC needed).
 *
 * Fires when EITHER:
 *   1. The oldest PENDING row in the outbox is older than --threshold-secs (default 300).
 *      A persistent old row means the relay is not processing it — either the relay crashed,
 *      the consumer rejected it repeatedly, or the event type has no registered consumer.
 *   2. Total retry pressure (sum of retry_count across all PENDING and IN_FLIGHT rows)
 *      exceeds --retry-pressure-threshold (default 500). Sustained retry accumulation
 *      means the relay is working but failing to deliver — a provider or consumer problem.
 *
 * Per-org results surface the worst offenders so the operator can narrow the investigation
 * to a specific tenant and event type.
 *
 * Usage:
 *   node alert-queue-age.mjs
 *   node alert-queue-age.mjs --threshold-secs=600 --retry-pressure-threshold=1000
 *   node alert-queue-age.mjs --self-test
 *
 * Exit codes:
 *   0 = clear (neither threshold exceeded)
 *   1 = fired (at least one threshold exceeded)
 *   2 = configuration error (DATABASE_URL not set)
 */
import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

/**
 * `quiet` because stdout is the alert payload. dotenv prints a banner there
 * by default, which makes `pnpm alert:… | jq` fail on the first character —
 * so the rows naming the affected organisations could not be read by the
 * oncall integration these scripts exist to feed.
 */
dotenv.config({ path: resolve(process.cwd(), ".env"), quiet: true });

const args = process.argv.slice(2);
const thresholdSecs = Math.max(
  1,
  parseInt(args.find((a) => a.startsWith("--threshold-secs="))?.slice(17) ?? "300", 10),
);
const retryPressureThreshold = Math.max(
  0,
  parseInt(args.find((a) => a.startsWith("--retry-pressure-threshold="))?.slice(27) ?? "500", 10),
);

function evaluateRows(rows) {
  const now = Date.now();
  const worstOrgs = [];
  let globalMaxAgeSecs = 0;
  let globalTotalRetries = 0;

  for (const row of rows) {
    const ageMs = row.oldest_queued_at ? now - new Date(row.oldest_queued_at).getTime() : 0;
    const ageSecs = Math.floor(ageMs / 1000);
    const retries = Number(row.total_retries ?? 0);
    if (ageSecs > globalMaxAgeSecs) globalMaxAgeSecs = ageSecs;
    globalTotalRetries += retries;
    worstOrgs.push({
      org_id: row.org_id,
      pending_count: Number(row.pending_count ?? 0),
      in_flight_count: Number(row.in_flight_count ?? 0),
      oldest_queued_at: row.oldest_queued_at ? new Date(row.oldest_queued_at).toISOString() : null,
      oldest_age_secs: ageSecs,
      total_retries: retries,
      high_retry_count: Number(row.high_retry_count ?? 0),
    });
  }

  worstOrgs.sort((a, b) => b.oldest_age_secs - a.oldest_age_secs);
  const ageBreached = globalMaxAgeSecs > thresholdSecs;
  const retryBreached = globalTotalRetries > retryPressureThreshold;

  return { ageBreached, retryBreached, globalMaxAgeSecs, globalTotalRetries, worstOrgs };
}

if (args.includes("--self-test")) {
  const now = Date.now();
  const freshRow = {
    org_id: "org_fresh",
    oldest_queued_at: new Date(now - 10_000).toISOString(),
    pending_count: "1",
    in_flight_count: "0",
    total_retries: "2",
    high_retry_count: "0",
  };
  const staleRow = {
    org_id: "org_stale",
    oldest_queued_at: new Date(now - (thresholdSecs + 60) * 1_000).toISOString(),
    pending_count: "5",
    in_flight_count: "2",
    total_retries: "8",
    high_retry_count: "3",
  };
  const highRetryRow = {
    org_id: "org_retries",
    oldest_queued_at: new Date(now - 30_000).toISOString(),
    pending_count: "200",
    in_flight_count: "50",
    total_retries: String(retryPressureThreshold + 100),
    high_retry_count: "50",
  };

  const case1 = evaluateRows([freshRow]);
  const case2 = evaluateRows([staleRow]);
  const case3 = evaluateRows([highRetryRow]);
  const case4 = evaluateRows([freshRow, staleRow]);

  const checks = {
    freshRowClear: !case1.ageBreached && !case1.retryBreached,
    staleRowAgeBreaches: case2.ageBreached,
    highRetryBreachesRetryPressure: case3.retryBreached,
    combinedPicksUpStale: case4.ageBreached,
    worstOrgsOrdered: case4.worstOrgs[0]?.org_id === "org_stale",
  };

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(
    JSON.stringify({
      selfTest: true,
      pass,
      checks,
      thresholdSecs,
      retryPressureThreshold,
    }) + "\n",
  );
  process.exit(pass ? 0 : 1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write(
    "DATABASE_URL is required (owner/migration role — BYPASSRLS, no tenant GUC needed)\n",
  );
  process.exit(2);
}

const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
try {
  const rows = await sql`
    SELECT
      organization_id                                            AS org_id,
      MIN(created_at)                                            AS oldest_queued_at,
      COUNT(*) FILTER (WHERE delivery_state = 'PENDING')        AS pending_count,
      COUNT(*) FILTER (WHERE delivery_state = 'IN_FLIGHT')      AS in_flight_count,
      SUM(retry_count)                                           AS total_retries,
      COUNT(*) FILTER (WHERE retry_count >= 3)                   AS high_retry_count
    FROM outbox_events
    WHERE delivery_state IN ('PENDING', 'IN_FLIGHT')
    GROUP BY organization_id
    ORDER BY MIN(created_at) ASC
    LIMIT 50
  `;

  const { ageBreached, retryBreached, globalMaxAgeSecs, globalTotalRetries, worstOrgs } =
    evaluateRows(rows);

  const fired = ageBreached || retryBreached;
  process.stdout.write(
    JSON.stringify({
      fired,
      ageBreached,
      retryBreached,
      threshold: { thresholdSecs, retryPressureThreshold },
      globalMaxAgeSecs,
      globalTotalRetries,
      destination:
        "CONFIGURE_ME — wire exit-code 1 to your oncall system (PagerDuty, Slack webhook, etc.)",
      worstOrgs: worstOrgs.slice(0, 10),
    }) + "\n",
  );
  process.exit(fired ? 1 : 0);
} finally {
  await sql.end();
}
