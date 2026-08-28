import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";
dotenv.config({ path: resolve(process.cwd(), ".env") });
const sql = postgres(process.env.APP_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
const ORG = "5ca1e000-0000-4000-8000-000000000001";
const q = `
  SELECT m.user_id, e.employee_number, e.designation, e.joining_date,
         e.department_id, e.location_id
  FROM organization_members m
  LEFT JOIN hr_people p
    ON p.org_id = $1 AND p.user_id = m.user_id AND p.deleted_at IS NULL
  LEFT JOIN hr_employments e
    ON e.org_id = $1 AND e.person_id = p.id AND e.is_primary = true AND e.deleted_at IS NULL
  WHERE m.org_id = $1 AND m.status = 'ACTIVE'
  ORDER BY m.joined_at DESC
  LIMIT 100`;
await sql.begin(async (tx) => {
  await tx`SELECT set_config('app.organization_id', ${ORG}, true)`;
  const rows = await tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${q}`, [ORG]);
  for (const r of rows) process.stdout.write(r["QUERY PLAN"] + "\n");
});
await sql.end({ timeout: 5 });
