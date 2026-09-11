import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env") });

/**
 * Alert: a notification intent dead-lettered.
 *
 * `notification_outbox` is the durable record of "somebody is owed a notification".
 * `NotificationOutboxRelayService` drains it, and a row that exhausts its retry
 * ceiling lands in `state = 'DEAD'` — lost intent, not a retryable blip.
 *
 * WHY THIS FILE EXISTS. Nothing watched that table. `alert-dead-outbox.mjs` reads
 * `outbox_events`, `alert-dead-delivery.mjs` reads `notification_deliveries`, and
 * the SLO registry compounded it by declaring the notification relay as draining
 * `outbox_events` — so the DEAD-letter objective for this queue was satisfied by a
 * query against a table the relay never touches. It could not fail, however many
 * intents dead-lettered. `check-alert-system.mjs` reported a clean pass throughout,
 * because a self-test can only check the predicate of a script that exists.
 *
 * ANTI-VACUITY. `count = 0` over a table that holds no rows at all is not a pass;
 * it is a measurement that did not happen. An empty `notification_outbox` therefore
 * exits 2 (INCONCLUSIVE) rather than 0, so a database with nothing in it cannot be
 * mistaken for a queue with nothing wrong. `--allow-empty` is available for a
 * genuinely idle deployment, and says so in the output.
 *
 * Usage:
 *   node alert-dead-notification-outbox.mjs
 *   node alert-dead-notification-outbox.mjs --hours=48
 *   node alert-dead-notification-outbox.mjs --self-test
 *
 * Exit codes:
 *   0 = clear — the table holds rows and none reached DEAD inside the window
 *   1 = fired — at least one DEAD row inside the window
 *   2 = INCONCLUSIVE — DATABASE_URL unset, the table absent, or nothing to measure
 */

const args = process.argv.slice(2);
const hours = Math.max(1, parseInt(args.find((a) => a.startsWith("--hours="))?.slice(8) ?? "24", 10));
const allowEmpty = args.includes("--allow-empty");
const THRESHOLD = 0;

function predicate(rows) {
  return rows.length > THRESHOLD;
}

if (args.includes("--self-test")) {
  const now = Date.now();
  const row = (ageMs) => ({
    org_id: "org_fixture_1",
    event_key: "billing.payment.failed",
    dedupe_key: "billing.payment.failed:inv_1",
    processed_at: new Date(now - ageMs).toISOString(),
    last_error: "no recipient resolved after 10 attempts",
    attempt_count: 10,
  });
  const windowMs = hours * 3_600_000;
  const inWindow = [row(60_000)].filter((r) => now - new Date(r.processed_at).getTime() < windowMs);
  const outOfWindow = [row((hours + 1) * 3_600_000)].filter(
    (r) => now - new Date(r.processed_at).getTime() < windowMs,
  );
  const case1 = predicate(inWindow);
  const case2 = predicate(outOfWindow);
  // The third case is the one alert-dead-outbox.mjs and alert-dead-delivery.mjs
  // do not have: an empty corpus must not read as clear.
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

function classifyEmpty(totalRows) {
  if (totalRows > 0 || allowEmpty) return 0;
  return 2;
}

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write("DATABASE_URL is required (owner/migration role — BYPASSRLS, no tenant GUC needed)\n");
  process.exit(2);
}

const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
try {
  const present = await sql`SELECT to_regclass('public.notification_outbox') AS oid`;
  if (present[0]?.oid === null) {
    process.stderr.write("notification_outbox does not exist in this database — nothing measured\n");
    process.exit(2);
  }

  const [totals] = await sql`SELECT count(*)::int AS total FROM notification_outbox`;
  const total = Number(totals?.total ?? 0);

  const rows = await sql`
    SELECT
      org_id,
      event_key,
      dedupe_key,
      processed_at,
      last_error,
      attempt_count
    FROM notification_outbox
    WHERE state = 'DEAD'
      AND coalesce(processed_at, created_at) > NOW() - (${hours} * INTERVAL '1 hour')
    ORDER BY coalesce(processed_at, created_at) DESC
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
