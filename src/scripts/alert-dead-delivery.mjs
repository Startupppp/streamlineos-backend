import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env") });

/**
 * c21-07: a failed mandatory delivery must alert an operator.
 *
 * This fires on EVERY delivery that reaches DEAD, not only mandatory ones,
 * because mandatory-ness lives in the TypeScript event catalog and never lands
 * on the delivery row — an .mjs alert script cannot read it without duplicating
 * the list, and a duplicated list drifts silently. A superset alerts correctly
 * and over-reports; a stale subset would miss the exact failure this exists for.
 * The smallest closing change is to persist the catalog's `mandatory` flag onto
 * notification_deliveries at dispatch time, after which this can filter on it.
 *
 * Companion to alert-dead-outbox.mjs, which watches outbox_events. That one does
 * not cover notification_deliveries, which is why a dead mandatory delivery
 * previously reached nobody.
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
      event_key: "billing.payment.failed",
      channel: "EMAIL",
      failed_at: new Date(now - 60_000).toISOString(),
      failure_message: "provider rejected recipient",
      attempt_count: 5,
    },
  ];
  const outsideWindow = [
    {
      org_id: "org_fixture_1",
      event_key: "billing.payment.failed",
      channel: "EMAIL",
      failed_at: new Date(now - (hours + 1) * 3_600_000).toISOString(),
      failure_message: "provider rejected recipient",
      attempt_count: 5,
    },
  ];
  const windowMs = hours * 3_600_000;
  const case1Rows = withinWindow.filter((r) => now - new Date(r.failed_at).getTime() < windowMs);
  const case2Rows = outsideWindow.filter((r) => now - new Date(r.failed_at).getTime() < windowMs);
  const case1 = predicate(case1Rows);
  const case2 = predicate(case2Rows);
  const pass = case1 === true && case2 === false;
  process.stdout.write(
    JSON.stringify({ selfTest: true, pass, case1FiresOnDeadRow: case1, case2ClearsOnStaleRow: !case2 }) + "\n",
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
      event_key,
      channel,
      failed_at,
      failure_message,
      attempt_count
    FROM notification_deliveries
    WHERE status = 'DEAD'
      AND failed_at > NOW() - (${hours} * INTERVAL '1 hour')
    ORDER BY failed_at DESC
    LIMIT 50
  `;
  const fired = predicate(rows);
  process.stdout.write(
    JSON.stringify({
      fired,
      count: rows.length,
      threshold: { maxDeadRowsInWindow: THRESHOLD, windowHours: hours },
      destination: "CONFIGURE_ME — wire exit-code 1 to your oncall system (PagerDuty, Slack webhook, etc.)",
      rows,
    }) + "\n",
  );
  process.exit(fired ? 1 : 0);
} finally {
  await sql.end();
}
