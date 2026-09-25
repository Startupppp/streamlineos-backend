import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { bumpPermissionsVersion, type DbOrTx } from "../../common/rbac/access-invalidate";
import {
  hrEmployments,
  hrPeople,
  hrReportingLines,
  organizationMembers,
  users,
} from "../../db/schema";
import {
  syncCanonicalReportingLine,
  syncCanonicalReportingLines,
  type ReportingLineOutcome,
} from "../../common/hr/sync-canonical-reporting-line";
import { liveEmployment, livePersonOfEmployment } from "./employment-query";
import type { ScopedRead } from "../access/scoped-read";
import type {
  ApproverEligibility,
  ManagerAssignmentCheck,
  ManagerAssignmentRefusal,
  ManagerCoverageReport,
  ReportingLineHistoryEntry,
  ReportingLineView,
} from "./reporting-line.types";
import {
  COVERAGE_LIST_CAP,
  MANAGER_CHAIN_DEPTH_CAP,
  REPORTING_LINE_HISTORY_CAP,
  SPAN_OF_CONTROL_LIMIT,
} from "./reporting-line.types";

const CANNOT_MANAGE_LIFECYCLE = ["EXITED", "ALUMNI", "SUSPENDED"] as const;

const REFUSAL_MESSAGES: Record<ManagerAssignmentRefusal, string> = {
  "self-reference": "An employee cannot report to themselves.",
  "manager-not-in-organization": "The selected manager is not an active member of this organization.",
  "manager-inactive": "The selected manager's account is inactive.",
  "manager-never-accepted":
    "The selected manager has not accepted their invitation yet, so they cannot approve anything. Resend it, or pick someone else.",
  "manager-has-no-employment": "The selected manager has no employment record, so they cannot own approvals.",
  "manager-exited": "The selected manager has exited and cannot be assigned as a reporting manager.",
  circular: "This reporting structure would create a circular management chain.",
};

const managerEmployment = alias(hrEmployments, "reporting_line_manager_employment");
const managerPerson = alias(hrPeople, "reporting_line_manager_person");
const managerUser = alias(users, "reporting_line_manager_user");
const managerMember = alias(organizationMembers, "reporting_line_manager_member");

const managerDisplayName = sql<string>`coalesce(
  nullif(trim(${managerUser.name}), ''),
  nullif(trim(concat_ws(' ', ${managerUser.firstName}, ${managerUser.lastName})), ''),
  ${managerUser.email}
)`;

@Injectable()
export class ReportingLineService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async checkManagerAssignment(
    orgId: string,
    subjectUserId: string,
    managerUserId: string,
    db: DbOrTx = this.db,
  ): Promise<ManagerAssignmentCheck> {
    if (subjectUserId === managerUserId) return this.refuse("self-reference");
    const manager = await this.checkManager(orgId, managerUserId, db);
    if (!manager.ok) return manager;
    if ((await this.chainAbove(db, orgId, managerUserId, [subjectUserId])).length > 0) return this.refuse("circular");
    return manager;
  }

  async checkManagerAssignments(
    orgId: string,
    subjectUserIds: readonly string[],
    managerUserId: string,
    db: DbOrTx = this.db,
  ): Promise<ManagerAssignmentCheck> {
    if (subjectUserIds.includes(managerUserId)) return this.refuse("self-reference");
    const manager = await this.checkManager(orgId, managerUserId, db);
    if (!manager.ok) return manager;
    if ((await this.chainAbove(db, orgId, managerUserId, subjectUserIds)).length > 0) return this.refuse("circular");
    return manager;
  }

  async checkManager(
    orgId: string,
    managerUserId: string,
    db: DbOrTx = this.db,
  ): Promise<ManagerAssignmentCheck> {
    const eligibility = await this.checkApprover(orgId, managerUserId, db);
    if (!eligibility.ok) return eligibility;
    if (eligibility.managerEmploymentId === null) return this.refuse("manager-has-no-employment");
    return { ok: true, managerEmploymentId: eligibility.managerEmploymentId };
  }

  async checkApprover(
    orgId: string,
    candidateUserId: string,
    db: DbOrTx = this.db,
  ): Promise<ApproverEligibility> {
    const [candidate] = await db
      .select({
        membershipStatus: organizationMembers.status,
        isOwner: organizationMembers.isOwner,
        userActive: users.isActive,
        acceptedAt: users.emailVerified,
        employmentId: hrEmployments.id,
        lifecycleStatus: hrEmployments.lifecycleStatus,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .leftJoin(
        hrPeople,
        and(
          eq(hrPeople.orgId, orgId),
          eq(hrPeople.userId, organizationMembers.userId),
          isNull(hrPeople.deletedAt),
        ),
      )
      .leftJoin(
        hrEmployments,
        and(
          liveEmployment(orgId),
          eq(hrEmployments.personId, hrPeople.id),
          eq(hrEmployments.isPrimary, true),
        ),
      )
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, candidateUserId)))
      .limit(1);

    if (!candidate || candidate.membershipStatus !== "ACTIVE") return this.refuse("manager-not-in-organization");
    if (!candidate.userActive) return this.refuse("manager-inactive");
    // HRMS-E2E-015/011. is_active is the ACCOUNT flag, true the moment an
    // administrator creates the person. A manager invited and never signed in
    // passed this check, so the resolver named them as approver and the request
    // sat with somebody who cannot open the product — indefinitely, with nothing
    // on screen saying why. Acceptance is email_verified, the same test the
    // headcount queries use.
    //
    // Deliberately above the owner exemption below: a founder is often not
    // hired, which is why they are excused an employment record, but an owner
    // who has never come through the magic link cannot approve anything either.
    //
    // Refusing is safe — `consider()` records the reason and tries the next
    // rung, ending at the HR queue, so the worst case is a request routed
    // onwards with a sentence explaining it, never one that cannot be filed.
    if (candidate.acceptedAt === null) return this.refuse("manager-never-accepted");
    if (candidate.employmentId === null || candidate.lifecycleStatus === null) {
      if (candidate.isOwner === true) return { ok: true, managerEmploymentId: null };
      return this.refuse("manager-has-no-employment");
    }
    if (CANNOT_MANAGE_LIFECYCLE.some((status) => status === candidate.lifecycleStatus)) return this.refuse("manager-exited");

    return { ok: true, managerEmploymentId: candidate.employmentId };
  }

  async assign(
    orgId: string,
    subjectUserId: string,
    managerUserId: string | null,
    effectiveFrom: string,
    actorUserId: string,
    db: DbOrTx = this.db,
  ): Promise<ReportingLineOutcome> {
    if (managerUserId !== null) {
      const check = await this.checkManagerAssignment(orgId, subjectUserId, managerUserId, db);
      if (!check.ok) throw new BadRequestException(check.message);
    }
    const outcome = await syncCanonicalReportingLine(db, orgId, subjectUserId, managerUserId, effectiveFrom, actorUserId);
    if (outcome.status === "unmappable") throw new BadRequestException(this.unmappableMessage(outcome.reason));
    return outcome;
  }

  async assignMany(
    orgId: string,
    subjectUserIds: readonly string[],
    managerUserId: string | null,
    effectiveFrom: string,
    actorUserId: string,
    db: DbOrTx = this.db,
  ): Promise<Map<string, ReportingLineOutcome>> {
    if (managerUserId !== null) {
      const check = await this.checkManagerAssignments(orgId, subjectUserIds, managerUserId, db);
      if (!check.ok) throw new BadRequestException(check.message);
    }
    const outcomes = await syncCanonicalReportingLines(db, orgId, subjectUserIds, managerUserId, effectiveFrom, actorUserId);
    for (const outcome of outcomes.values())
      if (outcome.status === "unmappable") throw new BadRequestException(this.unmappableMessage(outcome.reason));
    return outcomes;
  }

  async getLine(read: ScopedRead, userId: string): Promise<ReportingLineView | null> {
    const orgId = read.orgId;
    const visible = await read.read(
      {
        tenant: organizationMembers.orgId,
        scope: { columns: { ownerColumn: organizationMembers.userId } },
        and: [eq(organizationMembers.userId, userId)],
      },
      ({ sql: where }) =>
        this.db.select({ userId: organizationMembers.userId }).from(organizationMembers).where(where).limit(1),
      () => [],
    );
    if (visible.length === 0) return null;

    const subjectPerson = alias(hrPeople, "reporting_line_subject_person");
    const subjectEmployment = alias(hrEmployments, "reporting_line_subject_employment");

    const rows = await this.db
      .select({
        lineId: hrReportingLines.id,
        effectiveFrom: hrReportingLines.effectiveFrom,
        effectiveTo: sql<string | null>`case when isfinite(${hrReportingLines.effectiveTo}) then ${hrReportingLines.effectiveTo}::text else null end`,
        createdAt: hrReportingLines.createdAt,
        createdBy: hrReportingLines.createdBy,
        managerUserId: managerPerson.userId,
        managerName: managerDisplayName,
        managerEmail: managerUser.email,
        managerDesignation: managerEmployment.designation,
        managerLifecycleStatus: managerEmployment.lifecycleStatus,
        managerUserActive: managerUser.isActive,
        managerMembershipStatus: managerMember.status,
      })
      .from(hrReportingLines)
      .innerJoin(
        subjectEmployment,
        and(liveEmployment(orgId, subjectEmployment), eq(subjectEmployment.id, hrReportingLines.employmentId)),
      )
      .innerJoin(subjectPerson, livePersonOfEmployment(orgId, subjectEmployment, subjectPerson))
      .innerJoin(
        managerEmployment,
        and(eq(managerEmployment.orgId, orgId), eq(managerEmployment.id, hrReportingLines.managerEmploymentId)),
      )
      .innerJoin(
        managerPerson,
        and(eq(managerPerson.orgId, orgId), eq(managerPerson.id, managerEmployment.personId)),
      )
      .leftJoin(managerUser, eq(managerUser.id, managerPerson.userId))
      .leftJoin(
        managerMember,
        and(eq(managerMember.orgId, orgId), eq(managerMember.userId, managerPerson.userId)),
      )
      .where(
        and(
          eq(hrReportingLines.orgId, orgId),
          eq(hrReportingLines.lineType, "primary"),
          eq(subjectPerson.userId, userId),
        ),
      )
      .orderBy(desc(hrReportingLines.effectiveFrom), desc(hrReportingLines.id))
      .limit(REPORTING_LINE_HISTORY_CAP);

    const today = new Date().toISOString().slice(0, 10);
    const history: ReportingLineHistoryEntry[] = rows.map((row) => ({
      lineId: row.lineId,
      managerUserId: row.managerUserId,
      managerName: row.managerName,
      managerEmail: row.managerEmail,
      managerDesignation: row.managerDesignation,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      recordedAt: row.createdAt.toISOString(),
      recordedBy: row.createdBy,
      managerState: this.managerState(row.managerUserActive, row.managerMembershipStatus, row.managerLifecycleStatus),
    }));
    const current =
      history.find((entry) => entry.effectiveFrom <= today && (entry.effectiveTo === null || entry.effectiveTo >= today)) ?? null;
    const upcoming = history.filter((entry) => entry.effectiveFrom > today);

    return { userId, current, upcoming, history };
  }

  async coverage(orgId: string): Promise<ManagerCoverageReport> {
    const [withoutManager, inactiveManager, circular, overSpan, totals] = await Promise.all([
      this.employeesWithoutManager(orgId),
      this.employeesWithInactiveManager(orgId),
      this.circularChains(orgId),
      this.managersOverSpan(orgId),
      this.totals(orgId),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      spanOfControlLimit: SPAN_OF_CONTROL_LIMIT,
      summary: {
        employees: totals.employees,
        withManager: totals.withManager,
        withoutManager: totals.employees - totals.withManager,
        inactiveManager: inactiveManager.length,
        circular: circular.length,
        overSpan: overSpan.length,
      },
      withoutManager,
      inactiveManager,
      circular,
      overSpan,
    };
  }

  private refuse(reason: ManagerAssignmentRefusal): ManagerAssignmentCheck {
    return { ok: false, reason, message: REFUSAL_MESSAGES[reason] };
  }

  private unmappableMessage(reason: Exclude<ReportingLineOutcome, { status: "written" | "unchanged" | "cleared" }>["reason"]): string {
    switch (reason) {
      case "employment-missing":
        return "The employee has no employment record yet, so a reporting manager cannot be recorded.";
      case "manager-not-in-organization":
        return REFUSAL_MESSAGES["manager-not-in-organization"];
      case "manager-has-no-employment":
        return REFUSAL_MESSAGES["manager-has-no-employment"];
      case "self-reference":
        return REFUSAL_MESSAGES["self-reference"];
    }
  }

  private managerState(
    userActive: boolean | null,
    membershipStatus: string | null,
    lifecycleStatus: string | null,
  ): ReportingLineHistoryEntry["managerState"] {
    if (userActive === false || membershipStatus !== "ACTIVE") return "inactive";
    if (lifecycleStatus !== null && CANNOT_MANAGE_LIFECYCLE.some((status) => status === lifecycleStatus)) return "exited";
    if (lifecycleStatus === "NOTICE") return "on-notice";
    return "active";
  }

  private async chainAbove(db: DbOrTx, orgId: string, startUserId: string, lookFor: readonly string[]): Promise<string[]> {
    if (lookFor.length === 0) return [];
    const rows = await db.execute<{ user_id: string }>(sql`
      WITH RECURSIVE manager_chain AS (
        SELECT emp.id AS employment_id, p.user_id, ARRAY[p.user_id]::text[] AS path
        FROM hr_employments emp
        INNER JOIN hr_people p
          ON p.id = emp.person_id AND p.org_id = ${orgId} AND p.deleted_at IS NULL
        WHERE emp.org_id = ${orgId}
          AND emp.is_primary = true
          AND emp.deleted_at IS NULL
          AND p.user_id = ${startUserId}
        UNION ALL
        SELECT mgr_emp.id, mgr_p.user_id, chain.path || mgr_p.user_id
        FROM manager_chain chain
        INNER JOIN hr_reporting_lines rl
          ON rl.employment_id = chain.employment_id
          AND rl.org_id = ${orgId}
          AND rl.line_type = 'primary'
          AND rl.effective_from <= CURRENT_DATE
          AND rl.effective_to >= CURRENT_DATE
        INNER JOIN hr_employments mgr_emp
          ON mgr_emp.id = rl.manager_employment_id
          AND mgr_emp.org_id = ${orgId}
          AND mgr_emp.is_primary = true
          AND mgr_emp.deleted_at IS NULL
        INNER JOIN hr_people mgr_p
          ON mgr_p.id = mgr_emp.person_id AND mgr_p.org_id = ${orgId} AND mgr_p.deleted_at IS NULL
        WHERE NOT mgr_p.user_id = ANY(chain.path)
          AND cardinality(chain.path) < ${MANAGER_CHAIN_DEPTH_CAP}
      )
      SELECT DISTINCT user_id FROM manager_chain WHERE user_id = ANY(${sql.param([...lookFor])}::text[])
    `);
    return [...rows].map((row) => row.user_id);
  }

  private async totals(orgId: string): Promise<{ employees: number; withManager: number }> {
    const [row] = await this.db.execute<{ employees: string | number; with_manager: string | number }>(sql`
      SELECT
        count(*) AS employees,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM hr_reporting_lines rl
          WHERE rl.org_id = ${orgId}
            AND rl.employment_id = emp.id
            AND rl.line_type = 'primary'
            AND rl.effective_from <= CURRENT_DATE
            AND rl.effective_to >= CURRENT_DATE
        )) AS with_manager
      FROM hr_employments emp
      INNER JOIN hr_people p ON p.id = emp.person_id AND p.org_id = ${orgId} AND p.deleted_at IS NULL
      WHERE emp.org_id = ${orgId}
        AND emp.is_primary = true
        AND emp.deleted_at IS NULL
        AND emp.lifecycle_status NOT IN ('CANDIDATE', 'EXITED', 'ALUMNI')
    `);
    return { employees: Number(row?.employees ?? 0), withManager: Number(row?.with_manager ?? 0) };
  }

  private async employeesWithoutManager(orgId: string): Promise<ManagerCoverageReport["withoutManager"]> {
    const rows = await this.db.execute<{
      user_id: string | null;
      employment_id: number;
      employee_number: string;
      name: string | null;
      email: string | null;
      designation: string | null;
      department_id: string | null;
      lifecycle_status: string;
    }>(sql`
      SELECT
        p.user_id,
        emp.id AS employment_id,
        emp.employee_number,
        coalesce(nullif(trim(u.name), ''), nullif(trim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email) AS name,
        u.email,
        emp.designation,
        emp.department_id,
        emp.lifecycle_status
      FROM hr_employments emp
      INNER JOIN hr_people p ON p.id = emp.person_id AND p.org_id = ${orgId} AND p.deleted_at IS NULL
      LEFT JOIN users u ON u.id = p.user_id
      WHERE emp.org_id = ${orgId}
        AND emp.is_primary = true
        AND emp.deleted_at IS NULL
        AND emp.lifecycle_status NOT IN ('CANDIDATE', 'EXITED', 'ALUMNI')
        AND NOT EXISTS (
          SELECT 1 FROM hr_reporting_lines rl
          WHERE rl.org_id = ${orgId}
            AND rl.employment_id = emp.id
            AND rl.line_type = 'primary'
            AND rl.effective_from <= CURRENT_DATE
            AND rl.effective_to >= CURRENT_DATE
        )
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

  private async employeesWithInactiveManager(orgId: string): Promise<ManagerCoverageReport["inactiveManager"]> {
    const rows = await this.db.execute<{
      user_id: string | null;
      name: string | null;
      manager_user_id: string | null;
      manager_name: string | null;
      manager_user_active: boolean | null;
      manager_membership_status: string | null;
      manager_lifecycle_status: string | null;
      effective_from: string;
    }>(sql`
      SELECT
        p.user_id,
        coalesce(nullif(trim(u.name), ''), nullif(trim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email) AS name,
        mp.user_id AS manager_user_id,
        coalesce(nullif(trim(mu.name), ''), nullif(trim(concat_ws(' ', mu.first_name, mu.last_name)), ''), mu.email) AS manager_name,
        mu.is_active AS manager_user_active,
        mm.status AS manager_membership_status,
        memp.lifecycle_status AS manager_lifecycle_status,
        rl.effective_from
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
        AND rl.effective_from <= CURRENT_DATE
        AND rl.effective_to >= CURRENT_DATE
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
      managerState: this.managerState(row.manager_user_active, row.manager_membership_status, row.manager_lifecycle_status),
      effectiveFrom: row.effective_from,
    }));
  }

  private async circularChains(orgId: string): Promise<ManagerCoverageReport["circular"]> {
    const rows = await this.db.execute<{ cycle: string[] }>(sql`
      WITH RECURSIVE current_lines AS (
        SELECT sp.user_id AS user_id, mp.user_id AS manager_user_id
        FROM hr_reporting_lines rl
        INNER JOIN hr_employments se ON se.id = rl.employment_id AND se.org_id = ${orgId} AND se.deleted_at IS NULL
        INNER JOIN hr_people sp ON sp.id = se.person_id AND sp.org_id = ${orgId} AND sp.deleted_at IS NULL
        INNER JOIN hr_employments me ON me.id = rl.manager_employment_id AND me.org_id = ${orgId} AND me.deleted_at IS NULL
        INNER JOIN hr_people mp ON mp.id = me.person_id AND mp.org_id = ${orgId} AND mp.deleted_at IS NULL
        WHERE rl.org_id = ${orgId}
          AND rl.line_type = 'primary'
          AND rl.effective_from <= CURRENT_DATE
          AND rl.effective_to >= CURRENT_DATE
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
      )
      SELECT DISTINCT ON (sorted) w.path AS cycle
      FROM (
        SELECT path, (SELECT array_agg(x ORDER BY x) FROM unnest(path) AS x) AS sorted
        FROM walk
        WHERE node = origin
      ) AS w
      ORDER BY sorted
      LIMIT ${COVERAGE_LIST_CAP}
    `);
    return rows.map((row) => ({ userIds: row.cycle }));
  }

  private async managersOverSpan(orgId: string): Promise<ManagerCoverageReport["overSpan"]> {
    const rows = await this.db.execute<{
      manager_user_id: string | null;
      manager_name: string | null;
      direct_reports: string | number;
    }>(sql`
      SELECT
        mp.user_id AS manager_user_id,
        coalesce(nullif(trim(mu.name), ''), nullif(trim(concat_ws(' ', mu.first_name, mu.last_name)), ''), mu.email) AS manager_name,
        count(*) AS direct_reports
      FROM hr_reporting_lines rl
      INNER JOIN hr_employments emp
        ON emp.id = rl.employment_id AND emp.org_id = ${orgId} AND emp.is_primary = true AND emp.deleted_at IS NULL
        AND emp.lifecycle_status NOT IN ('CANDIDATE', 'EXITED', 'ALUMNI')
      INNER JOIN hr_employments memp ON memp.id = rl.manager_employment_id AND memp.org_id = ${orgId}
      INNER JOIN hr_people mp ON mp.id = memp.person_id AND mp.org_id = ${orgId}
      LEFT JOIN users mu ON mu.id = mp.user_id
      WHERE rl.org_id = ${orgId}
        AND rl.line_type = 'primary'
        AND rl.effective_from <= CURRENT_DATE
        AND rl.effective_to >= CURRENT_DATE
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
}
