import { sql } from "drizzle-orm";
import { type Db } from "../../../db/drizzle.module";
import { boundHrReadLimit } from "../hr-read-limits";
import { departmentMemberFilter } from "./hr-analytics-plus-department-filter";

export async function fetchDrilldownPage(
  db: Db,
  orgId: string,
  metric: string,
  page: number,
  requestedLimit: number,
  departmentId?: string,
) {
  const limit = boundHrReadLimit(requestedLimit);
  const offset = (page - 1) * limit;
  // Each metric queries a different table, so the department predicate takes a
  // different shape per metric. hr_employments carries department_id directly;
  // the rest are user-keyed and go through the semi-join. The page query and
  // its COUNT must carry the SAME filter or `total` disagrees with `rows`.
  const employmentDept = departmentId ? sql` AND department_id = ${departmentId}` : sql``;
  const employmentDeptAliased = departmentId ? sql` AND e.department_id = ${departmentId}` : sql``;
  const leaveDept = departmentMemberFilter(orgId, departmentId, sql`lr.user_id`);
  const attendanceDept = departmentMemberFilter(orgId, departmentId, sql`user_id`);
  const casesDept = departmentMemberFilter(orgId, departmentId, sql`subject_employee_id`);
  let rows: unknown[] = [];
  let total = 0;

  if (metric === "attrition") {
    const result = await db.execute(sql`
      SELECT e.id, e.employee_number, op.first_name, op.last_name, e.exit_date, e.exit_reason, d.name as department
      FROM hr_employments e
      JOIN hr_people p ON p.id = e.person_id
      -- Names live on organization_people, not hr_people; selecting
      -- p.first_name/p.last_name made this metric fail with
      -- "column p.first_name does not exist" on every request. LEFT JOIN
      -- because hr_people.organization_person_id is nullable, and an
      -- unlinked person must still appear in the attrition list.
      LEFT JOIN organization_people op
        ON op.organization_id = p.org_id
       AND op.organization_person_id = p.organization_person_id
      LEFT JOIN org_units d ON d.id = e.department_id
      WHERE e.org_id = ${orgId} AND e.exit_date IS NOT NULL AND e.deleted_at IS NULL${employmentDeptAliased}
      ORDER BY e.exit_date DESC
      LIMIT ${limit} OFFSET ${offset}
    `);
    const cnt = await db.execute(sql`
      SELECT COUNT(*) as total FROM hr_employments
      WHERE org_id = ${orgId} AND exit_date IS NOT NULL AND deleted_at IS NULL${employmentDept}
    `);
    rows = result;
    total = Number(cnt[0]?.total ?? 0);
  } else if (metric === "leave") {
    const result = await db.execute(sql`
      SELECT lr.id, lr.user_id, lt.name as leave_type, lr.start_date, lr.end_date, lr.status
      FROM leave_requests lr
      JOIN leave_types lt ON lt.id = lr.leave_type_id
      WHERE lr.org_id = ${orgId}${leaveDept}
      ORDER BY lr.start_date DESC
      LIMIT ${limit} OFFSET ${offset}
    `);
    const cnt = await db.execute(
      sql`SELECT COUNT(*) as total FROM leave_requests lr WHERE lr.org_id = ${orgId}${leaveDept}`,
    );
    rows = result;
    total = Number(cnt[0]?.total ?? 0);
  } else if (metric === "attendance") {
    const result = await db.execute(sql`
      SELECT id, user_id, date, status, work_hours
      FROM attendance
      WHERE org_id = ${orgId}${attendanceDept}
      ORDER BY date DESC
      LIMIT ${limit} OFFSET ${offset}
    `);
    const cnt = await db.execute(
      sql`SELECT COUNT(*) as total FROM attendance WHERE org_id = ${orgId}${attendanceDept}`,
    );
    rows = result;
    total = Number(cnt[0]?.total ?? 0);
  } else if (metric === "cases") {
    const result = await db.execute(sql`
      SELECT id, case_number, category, severity, status, created_at
      FROM hr_cases
      WHERE org_id = ${orgId} AND status IN ('open','under_investigation') AND deleted_at IS NULL${casesDept}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);
    const cnt = await db.execute(sql`
      SELECT COUNT(*) as total FROM hr_cases
      WHERE org_id = ${orgId} AND status IN ('open','under_investigation') AND deleted_at IS NULL${casesDept}
    `);
    rows = result;
    total = Number(cnt[0]?.total ?? 0);
  }

  return { rows, total, page, limit };
}
