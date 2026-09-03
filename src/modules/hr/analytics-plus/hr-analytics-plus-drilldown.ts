import { sql } from "drizzle-orm";
import { type Db } from "../../../db/drizzle.module";
import { boundHrReadLimit } from "../hr-read-limits";

export async function fetchDrilldownPage(
  db: Db,
  orgId: string,
  metric: string,
  page: number,
  requestedLimit: number,
) {
  const limit = boundHrReadLimit(requestedLimit);
  const offset = (page - 1) * limit;
  let rows: unknown[] = [];
  let total = 0;

  if (metric === "attrition") {
    const result = await db.execute(sql`
      SELECT e.id, e.employee_number, p.first_name, p.last_name, e.exit_date, e.exit_reason, d.name as department
      FROM hr_employments e
      JOIN hr_people p ON p.id = e.person_id
      LEFT JOIN org_units d ON d.id = e.department_id
      WHERE e.org_id = ${orgId} AND e.exit_date IS NOT NULL AND e.deleted_at IS NULL
      ORDER BY e.exit_date DESC
      LIMIT ${limit} OFFSET ${offset}
    `);
    const cnt = await db.execute(sql`
      SELECT COUNT(*) as total FROM hr_employments
      WHERE org_id = ${orgId} AND exit_date IS NOT NULL AND deleted_at IS NULL
    `);
    rows = result;
    total = Number(cnt[0]?.total ?? 0);
  } else if (metric === "leave") {
    const result = await db.execute(sql`
      SELECT lr.id, lr.user_id, lt.name as leave_type, lr.start_date, lr.end_date, lr.status
      FROM leave_requests lr
      JOIN leave_types lt ON lt.id = lr.leave_type_id
      WHERE lr.org_id = ${orgId}
      ORDER BY lr.start_date DESC
      LIMIT ${limit} OFFSET ${offset}
    `);
    const cnt = await db.execute(sql`SELECT COUNT(*) as total FROM leave_requests WHERE org_id = ${orgId}`);
    rows = result;
    total = Number(cnt[0]?.total ?? 0);
  } else if (metric === "attendance") {
    const result = await db.execute(sql`
      SELECT id, user_id, date, status, work_hours
      FROM attendance
      WHERE org_id = ${orgId}
      ORDER BY date DESC
      LIMIT ${limit} OFFSET ${offset}
    `);
    const cnt = await db.execute(sql`SELECT COUNT(*) as total FROM attendance WHERE org_id = ${orgId}`);
    rows = result;
    total = Number(cnt[0]?.total ?? 0);
  } else if (metric === "cases") {
    const result = await db.execute(sql`
      SELECT id, case_number, category, severity, status, created_at
      FROM hr_cases
      WHERE org_id = ${orgId} AND status IN ('open','under_investigation') AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);
    const cnt = await db.execute(sql`
      SELECT COUNT(*) as total FROM hr_cases
      WHERE org_id = ${orgId} AND status IN ('open','under_investigation') AND deleted_at IS NULL
    `);
    rows = result;
    total = Number(cnt[0]?.total ?? 0);
  }

  return { rows, total, page, limit };
}
