import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env") });

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write("DATABASE_URL is required\n");
  process.exit(2);
}

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

const COLUMNS = [
  { table: "leave_requests", actor: "approver_id", membership: "approver_membership_id" },
  { table: "wfh_requests", actor: "approver_id", membership: "approver_membership_id" },
  { table: "performance_reviews", actor: "reviewer_id", membership: "reviewer_membership_id" },
  { table: "helpdesk_tickets", actor: "assignee_id", membership: "assignee_membership_id" },
];

async function reportColumn(table, actor, membership) {
  const rows = await sql.unsafe(`
    SELECT
      t.org_id,
      count(*) FILTER (WHERE NOT EXISTS (
        SELECT 1 FROM organization_members m
        WHERE m.org_id = t.org_id AND m.user_id = t.${actor}
      ))::int AS no_membership,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM organization_members m
        WHERE m.org_id = t.org_id AND m.user_id = t.${actor} AND m.status <> 'ACTIVE'
      ) AND NOT EXISTS (
        SELECT 1 FROM organization_members m
        WHERE m.org_id = t.org_id AND m.user_id = t.${actor} AND m.status = 'ACTIVE'
      ))::int AS inactive_membership,
      count(*)::int AS total_unmappable
    FROM ${table} t
    WHERE t.${actor} IS NOT NULL
      AND t.${membership} IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM organization_members m
        WHERE m.org_id = t.org_id AND m.user_id = t.${actor} AND m.status = 'ACTIVE'
      )
    GROUP BY t.org_id
    ORDER BY total_unmappable DESC
  `);
  return rows;
}

async function report() {
  for (const col of COLUMNS) {
    process.stdout.write(`\n${col.table}.${col.actor} -> ${col.membership}\n`);
    const rows = await reportColumn(col.table, col.actor, col.membership);
    if (rows.length === 0) {
      process.stdout.write("  ok: all rows with a legacy actor have been backfilled\n");
      continue;
    }
    for (const row of rows) {
      process.stdout.write(
        `  org_id=${row.org_id}  no_membership=${row.no_membership}  inactive=${row.inactive_membership}  total=${row.total_unmappable}\n`,
      );
    }
  }
}

report()
  .catch((e) => {
    process.stderr.write(`FAILED: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
