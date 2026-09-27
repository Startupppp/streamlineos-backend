import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { DbOrTx } from "../../common/rbac/access-invalidate";
import {
  hrEmployments,
  hrPeople,
  hrReportingLines,
  hrReportingManagerRequests,
  organizationMembers,
  users,
} from "../../db/schema";
import { orgBusinessDate } from "../hr/time/attendance-business-date";
import { liveEmployment, livePersonOfEmployment } from "./employment-query";
import type { ScopedRead } from "../access/scoped-read";
import {
  CANNOT_MANAGE_LIFECYCLE,
  cyclicProposals,
  managerStateOf,
  primaryChangeCounts,
  readReportingManagerPolicy,
  topLevelRolesBetween,
} from "./reporting-line-queries";
import { buildManagerCoverage } from "./reporting-line-coverage";
import type { CoverageScope } from "./reporting-line-coverage-lists";
import type {
  ApproverEligibility,
  ManagerAssignmentCheck,
  ManagerAssignmentRefusal,
  ManagerCoverageReport,
  PermittedActions,
  RelationshipEntry,
  ReportingLineHistoryEntry,
  ReportingLineView,
} from "./reporting-line.types";
import { REPORTING_LINE_HISTORY_CAP } from "./reporting-line.types";

/**
 * V-021. A refusal that names a table ("has no employment record") tells the
 * person nothing they can act on, and the person who hit it most was the
 * founder — a member and a user of their own company, never hired into it.
 * `{name}` is filled with whoever was actually picked when the caller knows it,
 * and falls back to "The selected manager" when it does not.
 */
const WHO = "{name}";
const DEFAULT_WHO = "The selected manager";

const REFUSAL_MESSAGES: Record<ManagerAssignmentRefusal, string> = {
  "self-reference": "An employee cannot report to themselves.",
  "manager-not-in-organization": "The selected manager is not an active member of this organization.",
  "manager-inactive": "The selected manager's account is inactive.",
  "manager-never-accepted":
    "The selected manager has not accepted their invitation yet, so they cannot approve anything. Resend it, or pick someone else.",
  "manager-has-no-employment": `${WHO} is not set up as an employee yet, so they cannot own approvals. Add them under People > Employees, then assign them again.`,
  "manager-exited": "The selected manager has exited and cannot be assigned as a reporting manager.",
  circular: "This reporting structure would create a circular management chain.",
};

const NO_ACTIONS: PermittedActions = { manage: false, review: false, override: false };

const managerEmployment = alias(hrEmployments, "reporting_line_manager_employment");
const managerPerson = alias(hrPeople, "reporting_line_manager_person");
const managerUser = alias(users, "reporting_line_manager_user");
const managerMember = alias(organizationMembers, "reporting_line_manager_member");

const managerDisplayName = sql<string>`coalesce(
  nullif(trim(${managerUser.name}), ''),
  nullif(trim(concat_ws(' ', ${managerUser.firstName}, ${managerUser.lastName})), ''),
  ${managerUser.email}
)`;

const candidateFields = {
  userId: organizationMembers.userId,
  membershipStatus: organizationMembers.status,
  isOwner: organizationMembers.isOwner,
  // V-021: so the refusal can name whoever was picked instead of saying
  // "the selected manager" about a founder looking at their own name.
  candidateName: sql<string>`coalesce(
    nullif(trim(${users.name}), ''),
    nullif(trim(concat_ws(' ', ${users.firstName}, ${users.lastName})), ''),
    ${users.email}
  )`,
  userActive: users.isActive,
  acceptedAt: users.emailVerified,
  employmentId: hrEmployments.id,
  lifecycleStatus: hrEmployments.lifecycleStatus,
};

interface Candidate {
  membershipStatus: string;
  isOwner: boolean;
  candidateName?: string | null;
  userActive: boolean;
  acceptedAt: Date | null;
  employmentId: number | null;
  lifecycleStatus: string | null;
}

@Injectable()
export class ReportingLineService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async checkManagerAssignment(
    orgId: string,
    subjectUserId: string,
    managerUserId: string,
    db: DbOrTx = this.db,
  ): Promise<ManagerAssignmentCheck> {
    return this.checkManagerAssignments(orgId, [subjectUserId], managerUserId, db);
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
    const subjects = await db
      .select({ employmentId: hrEmployments.id })
      .from(hrEmployments)
      .innerJoin(hrPeople, and(eq(hrPeople.id, hrEmployments.personId), eq(hrPeople.orgId, orgId), isNull(hrPeople.deletedAt)))
      .where(and(liveEmployment(orgId), eq(hrEmployments.isPrimary, true), inArray(hrPeople.userId, [...subjectUserIds])))
      .limit(subjectUserIds.length);
    const today = await orgBusinessDate(this.db, orgId);
    const cyclic = await cyclicProposals(
      db,
      orgId,
      subjects.map((subject, key) => ({ key, subjectEmploymentId: subject.employmentId, managerEmploymentId: manager.managerEmploymentId, from: today })),
    );
    if (cyclic.size > 0) return this.refuse("circular");
    return manager;
  }

  async checkManager(
    orgId: string,
    managerUserId: string,
    db: DbOrTx = this.db,
  ): Promise<ManagerAssignmentCheck> {
    const [candidate] = await this.candidates(orgId, db, [managerUserId]);
    return this.asManager(this.eligibilityOf(candidate, { requireAccepted: false }));
  }

  /** `checkManager` for many candidates in one statement — the preview and bulk path. */
  async checkManagers(
    orgId: string,
    managerUserIds: readonly string[],
    db: DbOrTx = this.db,
  ): Promise<Map<string, ManagerAssignmentCheck>> {
    const checks = new Map<string, ManagerAssignmentCheck>();
    const wanted = [...new Set(managerUserIds)];
    if (wanted.length === 0) return checks;
    const rows = await this.candidates(orgId, db, wanted);
    const byUser = new Map(rows.map((row) => [row.userId, row]));
    for (const userId of wanted) checks.set(userId, this.asManager(this.eligibilityOf(byUser.get(userId), { requireAccepted: false })));
    return checks;
  }

  async checkApprover(
    orgId: string,
    candidateUserId: string,
    db: DbOrTx = this.db,
  ): Promise<ApproverEligibility> {
    const [candidate] = await this.candidates(orgId, db, [candidateUserId]);
    return this.eligibilityOf(candidate, { requireAccepted: true });
  }

  /**
   * The reporting line of one employee as the scoped reader may see it. `permittedActions` is the
   * caller's resolved authority (`ReportingManagerPolicyService.permittedActions`); change reasons
   * are only returned when it grants `manage` or `review`.
   */
  async getLine(
    read: ScopedRead,
    userId: string,
    options: { permittedActions?: PermittedActions } = {},
  ): Promise<ReportingLineView | null> {
    const orgId = read.orgId;
    const permittedActions = options.permittedActions ?? NO_ACTIONS;
    const showReasons = permittedActions.manage || permittedActions.review;
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

    const [rows, today, policy] = await Promise.all([
      this.db
        .select({
          lineId: hrReportingLines.id,
          employmentId: hrReportingLines.employmentId,
          lineType: hrReportingLines.lineType,
          label: hrReportingLines.relationshipLabel,
          source: hrReportingLines.source,
          changeReason: hrReportingLines.changeReason,
          fallbackConfirmedAt: hrReportingLines.fallbackConfirmedAt,
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
        .where(and(eq(hrReportingLines.orgId, orgId), eq(subjectPerson.userId, userId)))
        .orderBy(desc(hrReportingLines.effectiveFrom), desc(hrReportingLines.id))
        .limit(REPORTING_LINE_HISTORY_CAP),
      orgBusinessDate(this.db, orgId),
      readReportingManagerPolicy(this.db, orgId),
    ]);

    const history: ReportingLineHistoryEntry[] = [];
    const secondary: RelationshipEntry[] = [];
    for (const row of rows) {
      const managerState = managerStateOf(row.managerUserActive, row.managerMembershipStatus, row.managerLifecycleStatus);
      const common = {
        lineId: row.lineId,
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
        recordedAt: row.createdAt.toISOString(),
        source: row.source,
        isFallback: row.source === "ONBOARDING_FALLBACK",
        fallbackConfirmedAt: row.fallbackConfirmedAt?.toISOString() ?? null,
        changeReason: showReasons ? row.changeReason : null,
      };
      if (row.lineType === "primary")
        history.push({
          ...common,
          managerUserId: row.managerUserId,
          managerName: row.managerName,
          managerEmail: row.managerEmail,
          managerDesignation: row.managerDesignation,
          recordedBy: row.createdBy,
          managerState,
          relationshipType: "PRIMARY",
        });
      else if (row.managerUserId !== null && (row.effectiveTo === null || row.effectiveTo >= today))
        secondary.push({
          ...common,
          relationshipType: "SECONDARY",
          // A fallback describes how a primary was chosen; a secondary is always named explicitly.
          isFallback: false,
          fallbackConfirmedAt: null,
          label: row.label,
          manager: {
            userId: row.managerUserId,
            name: row.managerName?.trim() || row.managerEmail || "Manager",
            email: row.managerEmail,
            designation: row.managerDesignation,
            state: managerState,
          },
        });
    }
    const current =
      history.find((entry) => entry.effectiveFrom <= today && (entry.effectiveTo === null || entry.effectiveTo >= today)) ?? null;
    const upcoming = history.filter((entry) => entry.effectiveFrom > today);

    const employmentId = rows[0]?.employmentId ?? (await this.primaryEmploymentIdOf(orgId, userId));
    const [roles, changes, pendingRequest] = employmentId === null
      ? [[], new Map<number, number>(), null]
      : await Promise.all([
          topLevelRolesBetween(this.db, orgId, [employmentId], today, today),
          primaryChangeCounts(this.db, orgId, [employmentId]),
          this.pendingRequestOf(orgId, employmentId),
        ]);
    const role = roles[0];

    return {
      userId,
      current,
      upcoming,
      history,
      secondary: secondary.reverse(),
      topLevel: role && current === null ? { reason: showReasons ? role.reason : null, effectiveFrom: role.effectiveFrom } : null,
      primaryChangesLast24h: employmentId === null ? 0 : changes.get(employmentId) ?? 0,
      changeThreshold: policy.requireReasonAfterChanges,
      maxSecondaryManagers: policy.maxSecondaryManagersPerEmployee,
      pendingRequest,
      permittedActions,
    };
  }

  async coverage(orgId: string, scope: CoverageScope = {}): Promise<ManagerCoverageReport> {
    return buildManagerCoverage(this.db, orgId, await orgBusinessDate(this.db, orgId), scope);
  }

  /** One row per member asked about — a member has one live primary employment. */
  private candidates(orgId: string, db: DbOrTx, userIds: readonly string[]) {
    return db
      .select(candidateFields)
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
      .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, [...userIds])))
      .limit(userIds.length);
  }

  /**
   * `requireAccepted` separates two questions. Routing an approval needs someone who can sign in
   * today; recording a reporting line does not — HRM-15 §7.3 bulk files name managers created by
   * the same file, all of them unopened invitations when the line is written.
   */
  private eligibilityOf(candidate: Candidate | undefined, options: { requireAccepted: boolean }): ApproverEligibility {
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
    if (options.requireAccepted && candidate.acceptedAt === null) return this.refuse("manager-never-accepted");
    if (candidate.employmentId === null || candidate.lifecycleStatus === null) {
      if (candidate.isOwner === true) return { ok: true, managerEmploymentId: null };
      return this.refuse("manager-has-no-employment", candidate.candidateName);
    }
    if (CANNOT_MANAGE_LIFECYCLE.some((status) => status === candidate.lifecycleStatus)) return this.refuse("manager-exited");

    return { ok: true, managerEmploymentId: candidate.employmentId };
  }

  private asManager(eligibility: ApproverEligibility): ManagerAssignmentCheck {
    if (!eligibility.ok) return eligibility;
    if (eligibility.managerEmploymentId === null) return this.refuse("manager-has-no-employment");
    return { ok: true, managerEmploymentId: eligibility.managerEmploymentId };
  }

  private async primaryEmploymentIdOf(orgId: string, userId: string): Promise<number | null> {
    const [row] = await this.db
      .select({ employmentId: hrEmployments.id })
      .from(hrEmployments)
      .innerJoin(hrPeople, and(eq(hrPeople.id, hrEmployments.personId), eq(hrPeople.orgId, orgId), isNull(hrPeople.deletedAt)))
      .where(and(liveEmployment(orgId), eq(hrEmployments.isPrimary, true), eq(hrPeople.userId, userId)))
      .limit(1);
    return row?.employmentId ?? null;
  }

  private async pendingRequestOf(orgId: string, employmentId: number): Promise<ReportingLineView["pendingRequest"]> {
    const [row] = await this.db
      .select({ requestId: hrReportingManagerRequests.id, status: hrReportingManagerRequests.status, createdAt: hrReportingManagerRequests.createdAt })
      .from(hrReportingManagerRequests)
      .where(
        and(
          eq(hrReportingManagerRequests.orgId, orgId),
          eq(hrReportingManagerRequests.employeeEmploymentId, employmentId),
          inArray(hrReportingManagerRequests.status, ["PENDING", "MORE_INFO_REQUIRED"]),
          isNull(hrReportingManagerRequests.deletedAt),
        ),
      )
      .orderBy(desc(hrReportingManagerRequests.createdAt))
      .limit(1);
    return row ? { requestId: row.requestId, status: row.status, createdAt: row.createdAt.toISOString() } : null;
  }

  private refuse(reason: ManagerAssignmentRefusal, who?: string | null): ManagerAssignmentCheck {
    return {
      ok: false,
      reason,
      message: REFUSAL_MESSAGES[reason].replace(WHO, who?.trim() || DEFAULT_WHO),
    };
  }
}
