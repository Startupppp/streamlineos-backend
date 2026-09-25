import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DbOrTx } from "../../common/rbac/access-invalidate";
import { OPEN_ENDED } from "../../common/hr/sync-canonical-reporting-line";
import {
  hrEmployments,
  hrPeople,
  hrReportingManagerPolicies,
  hrTopLevelRoles,
  type ReportingLineSource,
} from "../../db/schema";
import {
  CYCLE_CHECK_FUTURE_DATE_CAP,
  MANAGER_CHAIN_DEPTH_CAP,
  PRIMARY_CHANGE_WINDOW_HOURS,
  type ManagerState,
  type ReportingManagerPolicy,
} from "./reporting-line.types";

export const CANNOT_MANAGE_LIFECYCLE = ["EXITED", "ALUMNI", "SUSPENDED"] as const;
const NOT_AN_EMPLOYEE_LIFECYCLE = ["CANDIDATE", "EXITED", "ALUMNI"];

export function managerStateOf(
  userActive: boolean | null,
  membershipStatus: string | null,
  lifecycleStatus: string | null,
): ManagerState {
  if (userActive === false || membershipStatus !== "ACTIVE") return "inactive";
  if (lifecycleStatus !== null && CANNOT_MANAGE_LIFECYCLE.some((status) => status === lifecycleStatus)) return "exited";
  if (lifecycleStatus === "NOTICE") return "on-notice";
  return "active";
}

export function isActiveEmployeeLifecycle(lifecycleStatus: string): boolean {
  return !NOT_AN_EMPLOYEE_LIFECYCLE.includes(lifecycleStatus);
}

/** A missing row is the defaults; `isConfigured` says which. */
export async function readReportingManagerPolicy(db: DbOrTx, orgId: string): Promise<ReportingManagerPolicy> {
  const [row] = await db
    .select({
      maxSecondaryManagersPerEmployee: hrReportingManagerPolicies.maxSecondaryManagersPerEmployee,
      defaultPrimaryManagerUserId: hrReportingManagerPolicies.defaultPrimaryManagerUserId,
      fallbackOrder: hrReportingManagerPolicies.fallbackOrder,
      requireReasonAfterChanges: hrReportingManagerPolicies.requireReasonAfterChanges,
      allowTopLevelWithoutManager: hrReportingManagerPolicies.allowTopLevelWithoutManager,
      version: hrReportingManagerPolicies.version,
      updatedAt: hrReportingManagerPolicies.updatedAt,
    })
    .from(hrReportingManagerPolicies)
    .where(eq(hrReportingManagerPolicies.orgId, orgId))
    .limit(1);
  if (!row)
    return {
      orgId,
      isConfigured: false,
      maxSecondaryManagersPerEmployee: 0,
      defaultPrimaryManagerUserId: null,
      fallbackOrder: "CONFIGURED_MANAGER_THEN_UPLOADER",
      requireReasonAfterChanges: 3,
      allowTopLevelWithoutManager: true,
      version: 0,
      updatedAt: null,
    };
  return { orgId, isConfigured: true, ...row, updatedAt: row.updatedAt.toISOString() };
}

export interface SubjectEmployment {
  userId: string | null;
  employmentId: number;
  lifecycleStatus: string;
  joiningDate: string | null;
  lastWorkingDay: string | null;
  exitDate: string | null;
}

/** Live primary employments, looked up by user or by employment id, in one statement. */
export async function subjectEmployments(
  db: DbOrTx,
  orgId: string,
  by: { userIds?: readonly string[]; employmentIds?: readonly number[] },
): Promise<SubjectEmployment[]> {
  const userIds = [...new Set(by.userIds ?? [])];
  const employmentIds = [...new Set(by.employmentIds ?? [])];
  if (userIds.length === 0 && employmentIds.length === 0) return [];
  return db
    .select({
      userId: hrPeople.userId,
      employmentId: hrEmployments.id,
      lifecycleStatus: hrEmployments.lifecycleStatus,
      joiningDate: hrEmployments.joiningDate,
      lastWorkingDay: hrEmployments.lastWorkingDay,
      exitDate: hrEmployments.exitDate,
    })
    .from(hrEmployments)
    .innerJoin(hrPeople, and(eq(hrPeople.id, hrEmployments.personId), eq(hrPeople.orgId, orgId), isNull(hrPeople.deletedAt)))
    .where(
      and(
        eq(hrEmployments.orgId, orgId),
        eq(hrEmployments.isPrimary, true),
        isNull(hrEmployments.deletedAt),
        userIds.length > 0 ? inArray(hrPeople.userId, userIds) : inArray(hrEmployments.id, employmentIds),
      ),
    );
}

export interface RelationshipRow {
  lineId: number;
  employmentId: number;
  managerEmploymentId: number;
  managerUserId: string | null;
  primary: boolean;
  label: string | null;
  source: ReportingLineSource;
  effectiveFrom: string;
  /** `infinity` for an open-ended line. */
  effectiveTo: string;
}

export interface TopLevelRoleRow {
  id: string;
  employmentId: number;
  reason: string;
  effectiveFrom: string;
  effectiveTo: string;
}

/** Whether a row read by `relationshipsBetween` / `topLevelRolesBetween` is in force on `day`. */
export function inForceOn(row: { effectiveFrom: string; effectiveTo: string }, day: string): boolean {
  return row.effectiveFrom <= day && (row.effectiveTo === OPEN_ENDED || row.effectiveTo >= day);
}

/** Every primary and secondary line in force on any day of [firstDay, lastDay], in one statement. */
export async function relationshipsBetween(
  db: DbOrTx,
  orgId: string,
  employmentIds: readonly number[],
  firstDay: string,
  lastDay: string,
): Promise<RelationshipRow[]> {
  if (employmentIds.length === 0) return [];
  const rows = await db.execute<{
    line_id: number;
    employment_id: number;
    manager_employment_id: number;
    manager_user_id: string | null;
    is_primary: boolean;
    label: string | null;
    source: ReportingLineSource;
    effective_from: string;
    effective_to: string;
  }>(sql`
    SELECT rl.id AS line_id, rl.employment_id, rl.manager_employment_id, mp.user_id AS manager_user_id,
           rl.line_type = 'primary' AS is_primary, rl.relationship_label AS label, rl.source,
           rl.effective_from::text AS effective_from, rl.effective_to::text AS effective_to
    FROM hr_reporting_lines rl
    LEFT JOIN hr_employments me ON me.org_id = ${orgId} AND me.id = rl.manager_employment_id
    LEFT JOIN hr_people mp ON mp.org_id = ${orgId} AND mp.id = me.person_id
    WHERE rl.org_id = ${orgId}
      AND rl.employment_id = ANY(${sql.param([...employmentIds])}::int[])
      AND rl.effective_from <= ${lastDay}::date
      AND rl.effective_to >= ${firstDay}::date
    ORDER BY rl.employment_id, rl.id
  `);
  return [...rows].map((row) => ({
    lineId: Number(row.line_id),
    employmentId: Number(row.employment_id),
    managerEmploymentId: Number(row.manager_employment_id),
    managerUserId: row.manager_user_id,
    primary: row.is_primary,
    label: row.label,
    source: row.source,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
  }));
}

export async function topLevelRolesBetween(
  db: DbOrTx,
  orgId: string,
  employmentIds: readonly number[],
  firstDay: string,
  lastDay: string,
): Promise<TopLevelRoleRow[]> {
  if (employmentIds.length === 0) return [];
  return db
    .select({
      id: hrTopLevelRoles.id,
      employmentId: hrTopLevelRoles.employmentId,
      reason: hrTopLevelRoles.reason,
      effectiveFrom: hrTopLevelRoles.effectiveFrom,
      effectiveTo: hrTopLevelRoles.effectiveTo,
    })
    .from(hrTopLevelRoles)
    .where(
      and(
        eq(hrTopLevelRoles.orgId, orgId),
        inArray(hrTopLevelRoles.employmentId, [...employmentIds]),
        sql`${hrTopLevelRoles.effectiveFrom} <= ${lastDay}::date`,
        sql`${hrTopLevelRoles.effectiveTo} >= ${firstDay}::date`,
      ),
    );
}

/**
 * Primary lines recorded for each employee in the rolling D4 window, counting lines later moved to
 * `hr_reporting_lines_superseded` — a same-day correction is still a change.
 */
export async function primaryChangeCounts(
  db: DbOrTx,
  orgId: string,
  employmentIds: readonly number[],
): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  if (employmentIds.length === 0) return counts;
  const ids = sql.param([...employmentIds]);
  const rows = await db.execute<{ employment_id: number; changes: string | number }>(sql`
    SELECT employment_id, count(*) AS changes FROM (
      SELECT employment_id FROM hr_reporting_lines
      WHERE org_id = ${orgId} AND line_type = 'primary' AND employment_id = ANY(${ids}::int[])
        AND created_at > now() - make_interval(hours => ${PRIMARY_CHANGE_WINDOW_HOURS})
      UNION ALL
      SELECT employment_id FROM hr_reporting_lines_superseded
      WHERE org_id = ${orgId} AND line_type = 'primary' AND employment_id = ANY(${ids}::int[])
        AND created_at > now() - make_interval(hours => ${PRIMARY_CHANGE_WINDOW_HOURS})
    ) recent
    GROUP BY employment_id
  `);
  for (const row of rows) counts.set(Number(row.employment_id), Number(row.changes));
  return counts;
}

/**
 * Which proposed primary edges would close a loop. Each proposal is checked on its effective date
 * and on every later date a primary line in the org starts (the only days the hierarchy changes),
 * walking up from the proposed manager; reaching the subject is a cycle. Proposals are checked in
 * one statement, so a 500-row preview costs one round trip.
 */
export async function cyclicProposals(
  db: DbOrTx,
  orgId: string,
  proposals: ReadonlyArray<{ key: number; subjectEmploymentId: number; managerEmploymentId: number; from: string }>,
): Promise<Set<number>> {
  const cyclic = new Set<number>();
  if (proposals.length === 0) return cyclic;
  const rows = await db.execute<{ key: number }>(sql`
    WITH RECURSIVE proposals AS (
      SELECT * FROM unnest(
        ${sql.param(proposals.map((p) => p.key))}::int[],
        ${sql.param(proposals.map((p) => p.subjectEmploymentId))}::int[],
        ${sql.param(proposals.map((p) => p.managerEmploymentId))}::int[],
        ${sql.param(proposals.map((p) => p.from))}::date[]
      ) AS p(key, subject, manager, day)
    ),
    checkpoints AS (
      SELECT key, subject, manager, day FROM proposals
      UNION
      SELECT p.key, p.subject, p.manager, later.effective_from
      FROM proposals p
      CROSS JOIN LATERAL (
        SELECT DISTINCT rl.effective_from FROM hr_reporting_lines rl
        WHERE rl.org_id = ${orgId} AND rl.line_type = 'primary' AND rl.effective_from > p.day
        ORDER BY rl.effective_from
        LIMIT ${CYCLE_CHECK_FUTURE_DATE_CAP}
      ) later
    ),
    walk AS (
      SELECT key, subject, day, manager AS node, ARRAY[manager]::int[] AS path FROM checkpoints
      UNION ALL
      SELECT w.key, w.subject, w.day, rl.manager_employment_id, w.path || rl.manager_employment_id
      FROM walk w
      INNER JOIN hr_reporting_lines rl
        ON rl.org_id = ${orgId}
       AND rl.employment_id = w.node
       AND rl.line_type = 'primary'
       AND rl.effective_from <= w.day
       AND rl.effective_to >= w.day
      WHERE w.node <> w.subject
        AND NOT rl.manager_employment_id = ANY(w.path)
        AND cardinality(w.path) < ${MANAGER_CHAIN_DEPTH_CAP}
    )
    SELECT DISTINCT key FROM walk WHERE node = subject
  `);
  for (const row of rows) cyclic.add(Number(row.key));
  return cyclic;
}
