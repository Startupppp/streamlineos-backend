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
  {
    label: "project_members.user_id",
    query: sql`
      SELECT pm.org_id, count(*)::int AS unmappable
      FROM build.project_members pm
      LEFT JOIN organization_members m
        ON m.org_id = pm.org_id AND m.user_id = pm.user_id
      WHERE pm.user_id IS NOT NULL
        AND (m.id IS NULL OR m.status <> 'ACTIVE')
      GROUP BY pm.org_id
      HAVING count(*) > 0
      ORDER BY pm.org_id
    `,
  },
  {
    label: "tickets.assignee_id",
    query: sql`
      SELECT t.org_id, count(*)::int AS unmappable
      FROM build.tickets t
      LEFT JOIN organization_members m
        ON m.org_id = t.org_id AND m.user_id = t.assignee_id
      WHERE t.assignee_id IS NOT NULL
        AND (m.id IS NULL OR m.status <> 'ACTIVE')
      GROUP BY t.org_id
      HAVING count(*) > 0
      ORDER BY t.org_id
    `,
  },
  {
    label: "tickets.reporter_id",
    query: sql`
      SELECT t.org_id, count(*)::int AS unmappable
      FROM build.tickets t
      LEFT JOIN organization_members m
        ON m.org_id = t.org_id AND m.user_id = t.reporter_id
      WHERE t.reporter_id IS NOT NULL
        AND (m.id IS NULL OR m.status <> 'ACTIVE')
      GROUP BY t.org_id
      HAVING count(*) > 0
      ORDER BY t.org_id
    `,
  },
  {
    label: "ticket_assignees.user_id",
    query: sql`
      SELECT ta.org_id, count(*)::int AS unmappable
      FROM build.ticket_assignees ta
      LEFT JOIN organization_members m
        ON m.org_id = ta.org_id AND m.user_id = ta.user_id
      WHERE ta.user_id IS NOT NULL
        AND (m.id IS NULL OR m.status <> 'ACTIVE')
      GROUP BY ta.org_id
      HAVING count(*) > 0
      ORDER BY ta.org_id
    `,
  },
  {
    label: "project_approvals.approver_id",
    query: sql`
      SELECT pa.org_id, count(*)::int AS unmappable
      FROM build.project_approvals pa
      LEFT JOIN organization_members m
        ON m.org_id = pa.org_id AND m.user_id = pa.approver_id
      WHERE pa.approver_id IS NOT NULL
        AND pa.deleted_at IS NULL
        AND (m.id IS NULL OR m.status <> 'ACTIVE')
      GROUP BY pa.org_id
      HAVING count(*) > 0
      ORDER BY pa.org_id
    `,
  },
];

async function report() {
  let anyFound = false;
  for (const col of COLUMNS) {
    const rows = await col.query;
    if (rows.length === 0) {
      process.stdout.write(`${col.label}: all rows map cleanly\n`);
      continue;
    }
    anyFound = true;
    process.stdout.write(`${col.label}: ${rows.length} org(s) with unmappable rows\n`);
    for (const row of rows) {
      process.stdout.write(`  org_id=${row.org_id}  unmappable=${row.unmappable}\n`);
    }
  }
  if (!anyFound) {
    process.stdout.write("\nAll build actor columns are fully backfillable.\n");
  } else {
    process.stdout.write("\nRows listed above have a user_id with no active membership in that org.\n");
    process.stdout.write("They will not receive a membership_id from the backfill UPDATE.\n");
    process.stdout.write("Investigate each org before running VALIDATE CONSTRAINT.\n");
  }
}

report()
  .catch((e) => {
    process.stderr.write(`FAILED: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
