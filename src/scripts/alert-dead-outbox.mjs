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
      event_type: "member.invited",
      dead_lettered_at: new Date(now - 60_000).toISOString(),
      last_error: "no consumer registered for event type",
      retry_count: 10,
    },
  ];
  const outsideWindow = [
    {
      org_id: "org_fixture_1",
      event_type: "member.invited",
      dead_lettered_at: new Date(now - (hours + 1) * 3_600_000).toISOString(),
      last_error: "no consumer registered for event type",
      retry_count: 10,
    },
  ];
  const windowMs = hours * 3_600_000;
  const case1Rows = withinWindow.filter((r) => now - new Date(r.dead_lettered_at).getTime() < windowMs);
  const case2Rows = outsideWindow.filter((r) => now - new Date(r.dead_lettered_at).getTime() < windowMs);
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
      organization_id  AS org_id,
      event_type,
      dead_lettered_at,
      last_error,
      retry_count
    FROM outbox_events
    WHERE delivery_state = 'DEAD'
      AND dead_lettered_at > NOW() - (${hours} * INTERVAL '1 hour')
    ORDER BY dead_lettered_at DESC
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
