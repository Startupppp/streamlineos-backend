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

const CHECKS = [
  {
    table: "payroll_runs",
    column: "approved_by",
    newColumn: "approved_by_membership_id",
    label: "payroll_runs.approved_by",
  },
  {
    table: "payroll_approvals",
    column: "acted_by",
    newColumn: "acted_by_membership_id",
    label: "payroll_approvals.acted_by",
  },
  {
    table: "timesheet_periods",
    column: "approved_by",
    newColumn: "approved_by_membership_id",
    label: "timesheet_periods.approved_by",
  },
  {
    table: "timesheets",
    column: "approved_by",
    newColumn: "approved_by_membership_id",
    label: "timesheets.approved_by",
  },
  {
    table: "expenses",
    column: "approver_id",
    newColumn: "approver_membership_id",
    label: "expenses.approver_id",
  },
  {
    table: "reimbursements",
    column: "approved_by",
    newColumn: "approved_by_membership_id",
    label: "reimbursements.approved_by",
  },
];

async function reportColumn({ table, column, newColumn, label }) {
  const rows = await sql`
    SELECT
      t.org_id,
      count(*) FILTER (
        WHERE t.${sql(column)} IS NOT NULL
          AND t.${sql(newColumn)} IS NULL
      )::int AS no_membership,
      count(*) FILTER (
        WHERE t.${sql(column)} IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM organization_members m
            WHERE m.org_id = t.org_id
              AND m.user_id = t.${sql(column)}
              AND m.status <> 'ACTIVE'
          )
      )::int AS inactive_membership
    FROM ${sql(table)} t
    WHERE t.${sql(column)} IS NOT NULL
    GROUP BY t.org_id
    HAVING
      count(*) FILTER (
        WHERE t.${sql(column)} IS NOT NULL
          AND t.${sql(newColumn)} IS NULL
      ) > 0
      OR count(*) FILTER (
        WHERE t.${sql(column)} IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM organization_members m
            WHERE m.org_id = t.org_id
              AND m.user_id = t.${sql(column)}
              AND m.status <> 'ACTIVE'
          )
      ) > 0
    ORDER BY t.org_id
  `;

  if (rows.length === 0) {
    process.stdout.write(`${label}: all rows mapped cleanly\n`);
    return;
  }

  process.stdout.write(`${label}:\n`);
  for (const row of rows) {
    process.stdout.write(
      `  org=${row.org_id}  no_membership=${row.no_membership}  inactive_membership=${row.inactive_membership}\n`,
    );
  }
}

async function main() {
  for (const check of CHECKS) {
    await reportColumn(check);
  }
  await sql.end();
}

main().catch((err) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
