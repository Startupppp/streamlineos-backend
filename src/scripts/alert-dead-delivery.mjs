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
 * Companion to alert-dead-outbox.mjs, which watches outbox_events, and to
 * alert-dead-notification-outbox.mjs, which watches notification_outbox. Neither
 * covers notification_deliveries, which is why a dead mandatory delivery
 * previously reached nobody.
 *
 * ANTI-VACUITY. `count = 0` over a table that holds no rows at all is not a pass;
 * it is a measurement that did not happen, and under this release's closure
 * definition that is INCONCLUSIVE (exit 2), never clear. This script used to exit
 * 0 against an empty notification_deliveries — the same green it emits when the
 * pipeline is healthy, which is exactly the case an operator needs told apart from
 * a pipeline that never wrote a delivery row. `--allow-empty` is the deliberate
 * override for a genuinely idle deployment, and the JSON says when it was used.
 */

const args = process.argv.slice(2);
const hours = Math.max(1, parseInt(args.find((a) => a.startsWith("--hours="))?.slice(8) ?? "24", 10));
const allowEmpty = args.includes("--allow-empty");
const THRESHOLD = 0;

function predicate(rows) {
  return rows.length > THRESHOLD;
}

function classifyEmpty(totalRows) {
  if (totalRows > 0 || allowEmpty) return 0;
  return 2;
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
  const case3 = classifyEmpty(0) === 2 && classifyEmpty(1) === 0;
  const pass = case1 === true && case2 === false && case3 === true;
  process.stdout.write(
    JSON.stringify({
      selfTest: true,
      pass,
      case1FiresOnDeadRow: case1,
      case2ClearsOnStaleRow: !case2,
      case3EmptyTableIsInconclusive: case3,
    }) + "\n",
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
  const present = await sql`SELECT to_regclass('public.notification_deliveries') AS oid`;
  if (present[0]?.oid === null) {
    process.stderr.write("notification_deliveries does not exist in this database — nothing measured\n");
    process.exit(2);
  }
  const [totals] = await sql`SELECT count(*)::int AS total FROM notification_deliveries`;
  const total = Number(totals?.total ?? 0);

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
  const emptyCode = classifyEmpty(total);
  process.stdout.write(
    JSON.stringify({
      fired,
      count: rows.length,
      tableRowCount: total,
      inconclusive: !fired && emptyCode === 2,
      allowEmpty,
      threshold: { maxDeadRowsInWindow: THRESHOLD, windowHours: hours },
      destination: "CONFIGURE_ME — wire exit-code 1 to your oncall system (PagerDuty, Slack webhook, etc.)",
      rows,
    }) + "\n",
  );
  if (fired) process.exit(1);
  process.exit(emptyCode);
} finally {
  await sql.end();
}
