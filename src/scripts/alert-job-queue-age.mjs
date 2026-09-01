/**
 * Alert: durable job-queue age.
 *
 * SOURCE: direct query to each registered job table (owner role — BYPASSRLS, no tenant GUC needed).
 *
 * The outbox alerts (alert-queue-age, alert-dead-outbox) watch `outbox_events` only, and
 * alert-dead-delivery watches `notification_deliveries` only. Every other durable queue in this
 * platform — AI jobs, payroll jobs, and the six export-job tables — is drained by its own worker
 * against its own table, so a worker that stops leaves rows queued forever and pages nobody.
 * This closes that gap.
 *
 * Fires when the oldest row still in a queued or running state on ANY registered queue is older
 * than --threshold-secs (default 900). Fifteen minutes rather than the outbox's five: these are
 * batch jobs whose normal runtime is minutes, not milliseconds.
 *
 * Usage:
 *   node alert-job-queue-age.mjs
 *   node alert-job-queue-age.mjs --threshold-secs=1800
 *   node alert-job-queue-age.mjs --self-test
 *
 * Exit codes:
 *   0 = clear
 *   1 = fired (at least one queue exceeded the threshold)
 *   2 = configuration error (DATABASE_URL not set)
 */
import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env") });

export const JOB_QUEUES = [
  { table: "ai_jobs", statusColumn: "status", unfinished: ["QUEUED", "RUNNING"], owner: "platform-reliability" },
  { table: "payroll_jobs", statusColumn: "status", unfinished: ["PENDING", "RUNNING"], owner: "people-team" },
  { table: "payroll_run_export_jobs", statusColumn: "status", unfinished: ["pending", "processing"], owner: "people-team" },
  { table: "expense_export_jobs", statusColumn: "status", unfinished: ["pending", "processing"], owner: "finance-team" },
  { table: "finance_report_export_jobs", statusColumn: "status", unfinished: ["pending", "processing"], owner: "finance-team" },
  { table: "hr_export_jobs", statusColumn: "status", unfinished: ["pending", "processing"], owner: "people-team" },
  { table: "gdpr_export_jobs", statusColumn: "status", unfinished: ["pending", "processing"], owner: "platform-reliability" },
  { table: "kb_export_jobs", statusColumn: "status", unfinished: ["pending", "processing"], owner: "knowledge-team" },
];

const args = process.argv.slice(2);
const thresholdSecs = Math.max(
  1,
  parseInt(args.find((a) => a.startsWith("--threshold-secs="))?.slice(17) ?? "900", 10),
);

export function evaluateQueues(rows, nowMs) {
  const breached = [];
  const clear = [];

  for (const row of rows) {
    const ageSecs = row.oldest_queued_at
      ? Math.floor((nowMs - new Date(row.oldest_queued_at).getTime()) / 1000)
      : 0;
    const entry = {
      queue: row.table,
      owner: row.owner,
      unfinished_count: Number(row.unfinished_count ?? 0),
      oldest_queued_at: row.oldest_queued_at
        ? new Date(row.oldest_queued_at).toISOString()
        : null,
      oldest_age_secs: ageSecs,
    };
    if (ageSecs > thresholdSecs) breached.push(entry);
    else clear.push(entry);
  }

  breached.sort((a, b) => b.oldest_age_secs - a.oldest_age_secs);
  return { fired: breached.length > 0, breached, clear };
}

if (args.includes("--self-test")) {
  const now = Date.now();
  const fresh = {
    table: "ai_jobs",
    owner: "platform-reliability",
    unfinished_count: "3",
    oldest_queued_at: new Date(now - 30_000).toISOString(),
  };
  const stale = {
    table: "payroll_jobs",
    owner: "people-team",
    unfinished_count: "7",
    oldest_queued_at: new Date(now - (thresholdSecs + 120) * 1_000).toISOString(),
  };
  const empty = {
    table: "kb_export_jobs",
    owner: "knowledge-team",
    unfinished_count: "0",
    oldest_queued_at: null,
  };

  const registryTables = new Set(JOB_QUEUES.map((q) => q.table));
  const checks = {
    freshQueueClear: evaluateQueues([fresh], now).fired === false,
    staleQueueFires: evaluateQueues([stale], now).fired === true,
    emptyQueueClear: evaluateQueues([empty], now).fired === false,
    mixedFiresOnStale: evaluateQueues([fresh, stale, empty], now).breached[0]?.queue === "payroll_jobs",
    breachCarriesOwner:
      evaluateQueues([stale], now).breached[0]?.owner === "people-team",
    registryCoversEveryDeclaredQueue:
      registryTables.has("ai_jobs") &&
      registryTables.has("payroll_jobs") &&
      registryTables.has("gdpr_export_jobs") &&
      JOB_QUEUES.length === 8,
    everyQueueDeclaresUnfinishedStates: JOB_QUEUES.every(
      (q) => Array.isArray(q.unfinished) && q.unfinished.length > 0,
    ),
    everyQueueDeclaresOwner: JOB_QUEUES.every((q) => typeof q.owner === "string" && q.owner.length > 0),
  };

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(
    JSON.stringify({ selfTest: true, pass, checks, thresholdSecs }) + "\n",
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
  const rows = [];
  for (const queue of JOB_QUEUES) {
    const exists = await sql`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${queue.table}
      LIMIT 1
    `;
    if (exists.length === 0) {
      process.stderr.write(
        `Registered job queue "${queue.table}" does not exist in the database — the registry is stale.\n`,
      );
      process.exit(2);
    }

    const [row] = await sql`
      SELECT
        COUNT(*)          AS unfinished_count,
        MIN(created_at)   AS oldest_queued_at
      FROM ${sql(queue.table)}
      WHERE ${sql(queue.statusColumn)}::text = ANY(${queue.unfinished})
    `;
    rows.push({
      table: queue.table,
      owner: queue.owner,
      unfinished_count: row?.unfinished_count ?? 0,
      oldest_queued_at: row?.oldest_queued_at ?? null,
    });
  }

  const { fired, breached, clear } = evaluateQueues(rows, Date.now());
  process.stdout.write(
    JSON.stringify({
      fired,
      threshold: { thresholdSecs },
      destination:
        "CONFIGURE_ME — wire exit-code 1 to your oncall system (PagerDuty, Slack webhook, etc.)",
      breached,
      clear,
    }) + "\n",
  );
  process.exit(fired ? 1 : 0);
} finally {
  await sql.end();
}
