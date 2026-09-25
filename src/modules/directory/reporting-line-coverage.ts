import { sql } from "drizzle-orm";
import type { DbOrTx } from "../../common/rbac/access-invalidate";
import { managerStateOf, readReportingManagerPolicy } from "./reporting-line-queries";
import {
  COVERAGE_LIST_CAP,
  MANAGER_CHAIN_DEPTH_CAP,
  SPAN_OF_CONTROL_LIMIT,
  type ManagerCoverageReport,
} from "./reporting-line.types";

const PERSON_NAME = (alias: string) =>
  sql.raw(`coalesce(nullif(trim(${alias}.name), ''), nullif(trim(concat_ws(' ', ${alias}.first_name, ${alias}.last_name)), ''), ${alias}.email)`);

function hasPrimaryOn(orgId: string, today: string) {
  return sql`EXISTS (
    SELECT 1 FROM hr_reporting_lines rl
    WHERE rl.org_id = ${orgId} AND rl.employment_id = emp.id AND rl.line_type = 'primary'
      AND rl.effective_from <= ${today}::date AND rl.effective_to >= ${today}::date
  )`;
}

function isTopLevelOn(orgId: string, today: string) {
  return sql`EXISTS (
    SELECT 1 FROM hr_top_level_roles tl
    WHERE tl.org_id = ${orgId} AND tl.employment_id = emp.id
      AND tl.effective_from <= ${today}::date AND tl.effective_to >= ${today}::date
  )`;
}

const ACTIVE_EMPLOYEE = sql`emp.is_primary = true AND emp.deleted_at IS NULL AND emp.lifecycle_status NOT IN ('CANDIDATE', 'EXITED', 'ALUMNI')`;

export async function buildManagerCoverage(db: DbOrTx, orgId: string, today: string): Promise<ManagerCoverageReport> {
  const [withoutManager, inactiveManager, circular, overSpan, totals, fallback, pendingReview, policy] = await Promise.all([
    employeesWithoutManager(db, orgId, today),
    employeesWithInactiveManager(db, orgId, today),
    circularChains(db, orgId, today),
    managersOverSpan(db, orgId, today),
    coverageTotals(db, orgId, today),
    unconfirmedFallbacks(db, orgId, today),
    pendingReviews(db, orgId),
    readReportingManagerPolicy(db, orgId),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    spanOfControlLimit: SPAN_OF_CONTROL_LIMIT,
    summary: {
      employees: totals.employees,
      withManager: totals.withManager,
      withoutManager: totals.withoutManager,
      inactiveManager: inactiveManager.length,
      circular: circular.length,
      overSpan: overSpan.length,
      topLevel: totals.topLevel,
      fallback: totals.fallback,
      pendingReview: totals.pendingReview,
    },
    policyMissing: policy.defaultPrimaryManagerUserId === null,
    withoutManager,
    inactiveManager,
    circular,
    overSpan,
    fallback,
    pendingReview,
  };
}

async function coverageTotals(db: DbOrTx, orgId: string, today: string) {
  const [row] = await db.execute<{
    employees: string | number;
    with_manager: string | number;
    top_level: string | number;
    without_manager: string | number;
    fallback: string | number;
    pending_review: string | number;
  }>(sql`
    SELECT
      count(*) AS employees,
      count(*) FILTER (WHERE ${hasPrimaryOn(orgId, today)}) AS with_manager,
      count(*) FILTER (WHERE NOT ${hasPrimaryOn(orgId, today)} AND ${isTopLevelOn(orgId, today)}) AS top_level,
      count(*) FILTER (WHERE NOT ${hasPrimaryOn(orgId, today)} AND NOT ${isTopLevelOn(orgId, today)}) AS without_manager,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM hr_reporting_lines rl
        WHERE rl.org_id = ${orgId} AND rl.employment_id = emp.id AND rl.line_type = 'primary'
          AND rl.effective_from <= ${today}::date AND rl.effective_to >= ${today}::date
          AND rl.source = 'ONBOARDING_FALLBACK' AND rl.fallback_confirmed_at IS NULL
      )) AS fallback,
      (SELECT count(*) FROM hr_reporting_manager_requests rq
        WHERE rq.org_id = ${orgId} AND rq.deleted_at IS NULL AND rq.status IN ('PENDING', 'MORE_INFO_REQUIRED')) AS pending_review
    FROM hr_employments emp
    INNER JOIN hr_people p ON p.id = emp.person_id AND p.org_id = ${orgId} AND p.deleted_at IS NULL
    WHERE emp.org_id = ${orgId} AND ${ACTIVE_EMPLOYEE}
  `);
  return {
    employees: Number(row?.employees ?? 0),
    withManager: Number(row?.with_manager ?? 0),
    topLevel: Number(row?.top_level ?? 0),
    withoutManager: Number(row?.without_manager ?? 0),
    fallback: Number(row?.fallback ?? 0),
    pendingReview: Number(row?.pending_review ?? 0),
  };
}

async function employeesWithoutManager(db: DbOrTx, orgId: string, today: string): Promise<ManagerCoverageReport["withoutManager"]> {
  const rows = await db.execute<{
    user_id: string | null;
    employment_id: number;
    employee_number: string;
    name: string | null;
    email: string | null;
    designation: string | null;
    department_id: string | null;
    lifecycle_status: string;
  }>(sql`
    SELECT p.user_id, emp.id AS employment_id, emp.employee_number, ${PERSON_NAME("u")} AS name, u.email,
           emp.designation, emp.department_id, emp.lifecycle_status
    FROM hr_employments emp
    INNER JOIN hr_people p ON p.id = emp.person_id AND p.org_id = ${orgId} AND p.deleted_at IS NULL
    LEFT JOIN users u ON u.id = p.user_id
    WHERE emp.org_id = ${orgId} AND ${ACTIVE_EMPLOYEE}
      AND NOT ${hasPrimaryOn(orgId, today)}
      AND NOT ${isTopLevelOn(orgId, today)}
    ORDER BY emp.joining_date DESC NULLS LAST, emp.id DESC
    LIMIT ${COVERAGE_LIST_CAP}
  `);
  return rows.map((row) => ({
    userId: row.user_id,
    employmentId: Number(row.employment_id),
    employeeNumber: row.employee_number,
    name: row.name,
    email: row.email,
    designation: row.designation,
    departmentId: row.department_id,
    lifecycleStatus: row.lifecycle_status,
  }));
}

async function employeesWithInactiveManager(db: DbOrTx, orgId: string, today: string): Promise<ManagerCoverageReport["inactiveManager"]> {
  const rows = await db.execute<{
    user_id: string | null;
    name: string | null;
    manager_user_id: string | null;
    manager_name: string | null;
    manager_user_active: boolean | null;
    manager_membership_status: string | null;
    manager_lifecycle_status: string | null;
    effective_from: string;
  }>(sql`
    SELECT p.user_id, ${PERSON_NAME("u")} AS name, mp.user_id AS manager_user_id, ${PERSON_NAME("mu")} AS manager_name,
           mu.is_active AS manager_user_active, mm.status AS manager_membership_status,
           memp.lifecycle_status AS manager_lifecycle_status, rl.effective_from
    FROM hr_reporting_lines rl
    INNER JOIN hr_employments emp
      ON emp.id = rl.employment_id AND emp.org_id = ${orgId} AND emp.is_primary = true AND emp.deleted_at IS NULL
    INNER JOIN hr_people p ON p.id = emp.person_id AND p.org_id = ${orgId} AND p.deleted_at IS NULL
    LEFT JOIN users u ON u.id = p.user_id
    INNER JOIN hr_employments memp ON memp.id = rl.manager_employment_id AND memp.org_id = ${orgId}
    INNER JOIN hr_people mp ON mp.id = memp.person_id AND mp.org_id = ${orgId}
    LEFT JOIN users mu ON mu.id = mp.user_id
    LEFT JOIN organization_members mm ON mm.org_id = ${orgId} AND mm.user_id = mp.user_id
    WHERE rl.org_id = ${orgId}
      AND rl.line_type = 'primary'
      AND rl.effective_from <= ${today}::date
      AND rl.effective_to >= ${today}::date
      AND emp.lifecycle_status NOT IN ('CANDIDATE', 'EXITED', 'ALUMNI')
      AND (
        memp.deleted_at IS NOT NULL
        OR memp.lifecycle_status IN ('EXITED', 'ALUMNI', 'SUSPENDED')
        OR mp.deleted_at IS NOT NULL
        OR mu.is_active = false
        OR mm.status IS DISTINCT FROM 'ACTIVE'
      )
    ORDER BY rl.effective_from DESC, rl.id DESC
    LIMIT ${COVERAGE_LIST_CAP}
  `);
  return rows.map((row) => ({
    userId: row.user_id,
    name: row.name,
    managerUserId: row.manager_user_id,
    managerName: row.manager_name,
    managerState: managerStateOf(row.manager_user_active, row.manager_membership_status, row.manager_lifecycle_status),
    effectiveFrom: row.effective_from,
  }));
}

async function circularChains(db: DbOrTx, orgId: string, today: string): Promise<ManagerCoverageReport["circular"]> {
  const rows = await db.execute<{ cycle: string[]; names: Array<string | null> }>(sql`
    WITH RECURSIVE current_lines AS (
      SELECT sp.user_id AS user_id, mp.user_id AS manager_user_id
      FROM hr_reporting_lines rl
      INNER JOIN hr_employments se ON se.id = rl.employment_id AND se.org_id = ${orgId} AND se.deleted_at IS NULL
      INNER JOIN hr_people sp ON sp.id = se.person_id AND sp.org_id = ${orgId} AND sp.deleted_at IS NULL
      INNER JOIN hr_employments me ON me.id = rl.manager_employment_id AND me.org_id = ${orgId} AND me.deleted_at IS NULL
      INNER JOIN hr_people mp ON mp.id = me.person_id AND mp.org_id = ${orgId} AND mp.deleted_at IS NULL
      WHERE rl.org_id = ${orgId}
        AND rl.line_type = 'primary'
        AND rl.effective_from <= ${today}::date
        AND rl.effective_to >= ${today}::date
        AND sp.user_id IS NOT NULL
        AND mp.user_id IS NOT NULL
    ),
    walk AS (
      SELECT cl.user_id AS origin, cl.manager_user_id AS node, ARRAY[cl.user_id]::text[] AS path
      FROM current_lines cl
      UNION ALL
      SELECT w.origin, cl.manager_user_id, w.path || w.node
      FROM walk w
      INNER JOIN current_lines cl ON cl.user_id = w.node
      WHERE w.node <> w.origin
        AND NOT w.node = ANY(w.path)
        AND cardinality(w.path) < ${MANAGER_CHAIN_DEPTH_CAP}
    ),
    cycles AS (
      SELECT DISTINCT ON (sorted) w.path AS cycle
      FROM (
        SELECT path, (SELECT array_agg(x ORDER BY x) FROM unnest(path) AS x) AS sorted
        FROM walk
        WHERE node = origin
      ) AS w
      ORDER BY sorted
      LIMIT ${COVERAGE_LIST_CAP}
    )
    SELECT c.cycle,
           ARRAY(SELECT ${PERSON_NAME("u")} FROM unnest(c.cycle) WITH ORDINALITY AS m(user_id, ord)
                 LEFT JOIN users u ON u.id = m.user_id ORDER BY m.ord) AS names
    FROM cycles c
  `);
  return rows.map((row) => ({
    userIds: row.cycle,
    members: row.cycle.map((userId, index) => ({ userId, name: row.names[index] ?? null })),
  }));
}

async function managersOverSpan(db: DbOrTx, orgId: string, today: string): Promise<ManagerCoverageReport["overSpan"]> {
  const rows = await db.execute<{
    manager_user_id: string | null;
    manager_name: string | null;
    direct_reports: string | number;
  }>(sql`
    SELECT mp.user_id AS manager_user_id, ${PERSON_NAME("mu")} AS manager_name, count(*) AS direct_reports
    FROM hr_reporting_lines rl
    INNER JOIN hr_employments emp
      ON emp.id = rl.employment_id AND emp.org_id = ${orgId} AND emp.is_primary = true AND emp.deleted_at IS NULL
      AND emp.lifecycle_status NOT IN ('CANDIDATE', 'EXITED', 'ALUMNI')
    INNER JOIN hr_employments memp ON memp.id = rl.manager_employment_id AND memp.org_id = ${orgId}
    INNER JOIN hr_people mp ON mp.id = memp.person_id AND mp.org_id = ${orgId}
    LEFT JOIN users mu ON mu.id = mp.user_id
    WHERE rl.org_id = ${orgId}
      AND rl.line_type = 'primary'
      AND rl.effective_from <= ${today}::date
      AND rl.effective_to >= ${today}::date
    GROUP BY mp.user_id, mu.name, mu.first_name, mu.last_name, mu.email
    HAVING count(*) > ${SPAN_OF_CONTROL_LIMIT}
    ORDER BY count(*) DESC
    LIMIT ${COVERAGE_LIST_CAP}
  `);
  return rows.map((row) => ({
    managerUserId: row.manager_user_id,
    managerName: row.manager_name,
    directReports: Number(row.direct_reports),
  }));
}

async function unconfirmedFallbacks(db: DbOrTx, orgId: string, today: string): Promise<ManagerCoverageReport["fallback"]> {
  const rows = await db.execute<{
    user_id: string | null;
    name: string | null;
    manager_user_id: string | null;
    manager_name: string | null;
    effective_from: string;
  }>(sql`
    SELECT p.user_id, ${PERSON_NAME("u")} AS name, mp.user_id AS manager_user_id, ${PERSON_NAME("mu")} AS manager_name,
           rl.effective_from::text AS effective_from
    FROM hr_reporting_lines rl
    INNER JOIN hr_employments emp
      ON emp.id = rl.employment_id AND emp.org_id = ${orgId} AND ${ACTIVE_EMPLOYEE}
    INNER JOIN hr_people p ON p.id = emp.person_id AND p.org_id = ${orgId} AND p.deleted_at IS NULL
    LEFT JOIN users u ON u.id = p.user_id
    INNER JOIN hr_employments memp ON memp.id = rl.manager_employment_id AND memp.org_id = ${orgId}
    INNER JOIN hr_people mp ON mp.id = memp.person_id AND mp.org_id = ${orgId}
    LEFT JOIN users mu ON mu.id = mp.user_id
    WHERE rl.org_id = ${orgId}
      AND rl.line_type = 'primary'
      AND rl.source = 'ONBOARDING_FALLBACK'
      AND rl.fallback_confirmed_at IS NULL
      AND rl.effective_from <= ${today}::date
      AND rl.effective_to >= ${today}::date
    ORDER BY rl.effective_from DESC, rl.id DESC
    LIMIT ${COVERAGE_LIST_CAP}
  `);
  return rows.map((row) => ({
    userId: row.user_id,
    name: row.name,
    managerUserId: row.manager_user_id,
    managerName: row.manager_name,
    effectiveFrom: row.effective_from,
  }));
}

async function pendingReviews(db: DbOrTx, orgId: string): Promise<ManagerCoverageReport["pendingReview"]> {
  const rows = await db.execute<{ request_id: string; user_id: string | null; name: string | null; created_at: string }>(sql`
    SELECT rq.id AS request_id, p.user_id, ${PERSON_NAME("u")} AS name, to_char(rq.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
    FROM hr_reporting_manager_requests rq
    INNER JOIN hr_employments emp ON emp.id = rq.employee_employment_id AND emp.org_id = ${orgId}
    INNER JOIN hr_people p ON p.id = emp.person_id AND p.org_id = ${orgId}
    LEFT JOIN users u ON u.id = p.user_id
    WHERE rq.org_id = ${orgId}
      AND rq.deleted_at IS NULL
      AND rq.status IN ('PENDING', 'MORE_INFO_REQUIRED')
    ORDER BY rq.created_at ASC, rq.id ASC
    LIMIT ${COVERAGE_LIST_CAP}
  `);
  return rows.map((row) => ({
    requestId: row.request_id,
    userId: row.user_id,
    name: row.name,
    createdAt: row.created_at,
  }));
}
