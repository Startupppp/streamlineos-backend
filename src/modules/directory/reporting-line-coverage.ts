import { sql } from "drizzle-orm";
import type { DbOrTx } from "../../common/rbac/access-invalidate";
import { readReportingManagerPolicy } from "./reporting-line-queries";
import { COVERAGE_LIST_CAP, SPAN_OF_CONTROL_LIMIT, type ManagerCoverageReport } from "./reporting-line.types";
import {
  ACTIVE_EMPLOYEE,
  PERSON_NAME,
  circularChains,
  employeesWithInactiveManager,
  employeesWithoutManager,
  forPerson,
  hasPrimaryOn,
  isTopLevelOn,
  managersOverSpan,
  type CoverageScope,
} from "./reporting-line-coverage-lists";

export async function buildManagerCoverage(db: DbOrTx, orgId: string, today: string, scope: CoverageScope = {}): Promise<ManagerCoverageReport> {
  const [withoutManager, inactiveManager, circular, overSpan, totals, fallback, pendingReview, policy] = await Promise.all([
    employeesWithoutManager(db, orgId, today),
    employeesWithInactiveManager(db, orgId, today),
    circularChains(db, orgId, today),
    managersOverSpan(db, orgId, today),
    coverageTotals(db, orgId, today, scope),
    unconfirmedFallbacks(db, orgId, today, scope),
    pendingReviews(db, orgId, scope),
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

async function coverageTotals(db: DbOrTx, orgId: string, today: string, scope: CoverageScope) {
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
      )${forPerson(scope)}) AS fallback,
      (SELECT count(*) FROM hr_reporting_manager_requests rq
        INNER JOIN hr_employments emp ON emp.id = rq.employee_employment_id AND emp.org_id = ${orgId}
        INNER JOIN hr_people p ON p.id = emp.person_id AND p.org_id = ${orgId}
        WHERE rq.org_id = ${orgId} AND rq.deleted_at IS NULL AND rq.status IN ('PENDING', 'MORE_INFO_REQUIRED')${forPerson(scope)}) AS pending_review
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


async function unconfirmedFallbacks(db: DbOrTx, orgId: string, today: string, scope: CoverageScope): Promise<ManagerCoverageReport["fallback"]> {
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
      AND rl.effective_to >= ${today}::date${forPerson(scope)}
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

async function pendingReviews(db: DbOrTx, orgId: string, scope: CoverageScope): Promise<ManagerCoverageReport["pendingReview"]> {
  const rows = await db.execute<{ request_id: string; user_id: string | null; name: string | null; created_at: string }>(sql`
    SELECT rq.id AS request_id, p.user_id, ${PERSON_NAME("u")} AS name, to_char(rq.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
    FROM hr_reporting_manager_requests rq
    INNER JOIN hr_employments emp ON emp.id = rq.employee_employment_id AND emp.org_id = ${orgId}
    INNER JOIN hr_people p ON p.id = emp.person_id AND p.org_id = ${orgId}
    LEFT JOIN users u ON u.id = p.user_id
    WHERE rq.org_id = ${orgId}
      AND rq.deleted_at IS NULL
      AND rq.status IN ('PENDING', 'MORE_INFO_REQUIRED')${forPerson(scope)}
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
