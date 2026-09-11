import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env") });

/**
 * Alert: stranded and failed workflow executions.
 *
 * Fires when any execution entered 'timed_out' or 'failed' status and was
 * created within the lookback window. A timed_out execution was held by a
 * worker for more than RUNNING_TIMEOUT_MS (15 min) with no transition back —
 * the worker likely crashed. Neither status ever transitions back to pending or
 * waiting, so stranded executions accumulate permanently and silently without
 * this alert. failed executions are included because they also surface no
 * operator signal on their own.
 *
 * Rows are grouped by (org_id, status) so the output names the affected tenants
 * and distinguishes timeout-stranded executions from hard failures.
 *
 * Usage:
 *   node alert-workflow-stranded.mjs
 *   node alert-workflow-stranded.mjs --hours=48
 *   node alert-workflow-stranded.mjs --self-test
 *
 * Exit codes:
 *   0 = clear
 *   1 = fired (stranded or failed executions found within the window)
 *   2 = configuration error (DATABASE_URL not set)
 */

const args = process.argv.slice(2);
const hours = Math.max(1, parseInt(args.find((a) => a.startsWith("--hours="))?.slice(8) ?? "24", 10));
const THRESHOLD = 0;

function predicate(rows) {
  return rows.length > THRESHOLD;
}

if (args.includes("--self-test")) {
  const now = Date.now();
  const withinWindow = [
    {
      org_id: "org_fixture_1",
      status: "timed_out",
      count: "2",
      oldest_at: new Date(now - 60_000).toISOString(),
      newest_at: new Date(now - 30_000).toISOString(),
    },
  ];
  const outsideWindow = [
    {
      org_id: "org_fixture_1",
      status: "timed_out",
      count: "1",
      oldest_at: new Date(now - (hours + 1) * 3_600_000).toISOString(),
      newest_at: new Date(now - (hours + 1) * 3_600_000).toISOString(),
    },
  ];
  const windowMs = hours * 3_600_000;
  const case1Rows = withinWindow.filter((r) => now - new Date(r.oldest_at).getTime() < windowMs);
  const case2Rows = outsideWindow.filter((r) => now - new Date(r.oldest_at).getTime() < windowMs);
  const case1 = predicate(case1Rows);
  const case2 = predicate(case2Rows);
  const pass = case1 === true && case2 === false;
  process.stdout.write(
    JSON.stringify({ selfTest: true, pass, case1FiresOnStrandedRow: case1, case2ClearsOnStaleRow: !case2 }) + "\n",
  );
  process.exit(pass ? 0 : 1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write("DATABASE_URL is required (owner/migration role — BYPASSRLS, no tenant GUC needed)\n");
  process.exit(2);
}

const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
try {
  const rows = await sql`
    SELECT
      org_id,
      status,
      COUNT(*)          AS count,
      MIN(created_at)   AS oldest_at,
      MAX(created_at)   AS newest_at
    FROM workflow_executions
    WHERE status IN ('timed_out', 'failed')
      AND created_at > NOW() - (${hours} * INTERVAL '1 hour')
    GROUP BY org_id, status
    ORDER BY MIN(created_at) ASC
    LIMIT 50
  `;
  const fired = predicate(rows);
  process.stdout.write(
    JSON.stringify({
      fired,
      count: rows.length,
      threshold: { maxGroupsInWindow: THRESHOLD, windowHours: hours },
      destination: "CONFIGURE_ME — wire exit-code 1 to your oncall system (PagerDuty, Slack webhook, etc.)",
      rows,
    }) + "\n",
  );
  process.exit(fired ? 1 : 0);
} finally {
  await sql.end();
}
