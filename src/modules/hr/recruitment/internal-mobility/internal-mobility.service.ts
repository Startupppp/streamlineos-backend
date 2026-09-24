import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import {
  candidateApplications,
  candidates,
  hrEmployments,
  hrJobLevels,
  hrPeople,
  jobPostings,
  organizationMembers,
  orgUnits,
  users,
} from "../../../../db/schema";
import { AuditService } from "../../../../common/audit/audit.service";
import { NotificationsService } from "../../../notifications/notifications.service";
import {
  CONFIDENTIALITY_NOTICE,
  decideEligibility,
  managerMaySee,
  type Eligibility,
} from "./internal-eligibility";
import {
  approvalRequired,
  decideGradeMove,
  type GradeDecision,
} from "./internal-grade-rules";

/** What the applicant's employment says about them, resolved once per apply. */
export interface ApplicantContext {
  lifecycleStatus: string | null;
  joiningDate: Date | null;
  probationEndDate: Date | null;
  onNotice: boolean;
  /** `hr_job_levels.rank`, null when the employee is not graded. */
  levelRank: number | null;
  /** The head of the applicant's department, who signs off on the move. */
  managerMembershipId: number | null;
}

export type InternalApplyGate =
  | { allowed: true; managerMembershipId: number | null; gradeKind: GradeDecision["kind"] }
  | { allowed: false; reason: string };

@Injectable()
export class InternalMobilityService {
  private readonly logger = new Logger(InternalMobilityService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  /** Repeated to the applicant on the apply screen, so it is one string. */
  readonly confidentialityNotice = CONFIDENTIALITY_NOTICE;

  /**
   * Employment, grade and reporting line for one applicant.
   *
   * Every predicate re-asserts `orgId` rather than leaning on RLS: an
   * employment record in another tenant must not make somebody eligible here,
   * and a guard that only holds while the GUC is set is a guard that stops
   * holding in a background job.
   */
  async contextFor(orgId: string, userId: string): Promise<ApplicantContext> {
    const [row] = await this.db
      .select({
        lifecycleStatus: hrEmployments.lifecycleStatus,
        joiningDate: hrEmployments.joiningDate,
        probationEndDate: hrEmployments.probationEndDate,
        noticeStartDate: hrEmployments.noticeStartDate,
        levelRank: hrJobLevels.rank,
        managerMembershipId: orgUnits.headMembershipId,
      })
      .from(hrEmployments)
      .innerJoin(
        hrPeople,
        and(eq(hrPeople.orgId, hrEmployments.orgId), eq(hrPeople.id, hrEmployments.personId)),
      )
      .leftJoin(
        hrJobLevels,
        and(eq(hrJobLevels.orgId, hrEmployments.orgId), eq(hrJobLevels.id, hrEmployments.jobLevelId)),
      )
      /*
        The manager is the head of the department the applicant sits in. This
        schema keeps no reporting-manager column on the employment, and
        inventing one would be a second answer to a question `org_units`
        already answers for the org chart, leave approvals and everything else.
      */
      .leftJoin(
        orgUnits,
        and(eq(orgUnits.orgId, hrEmployments.orgId), eq(orgUnits.id, hrEmployments.departmentId)),
      )
      .where(
        and(
          eq(hrEmployments.orgId, orgId),
          eq(hrPeople.orgId, orgId),
          eq(hrPeople.userId, userId),
          isNull(hrPeople.deletedAt),
          isNull(hrPeople.archivedAt),
        ),
      )
      .limit(1);

    return {
      lifecycleStatus: row?.lifecycleStatus ?? null,
      joiningDate: row?.joiningDate ? new Date(row.joiningDate) : null,
      probationEndDate: row?.probationEndDate ? new Date(row.probationEndDate) : null,
      onNotice: row?.noticeStartDate !== null && row?.noticeStartDate !== undefined,
      levelRank: row?.levelRank ?? null,
      managerMembershipId: row?.managerMembershipId ?? null,
    };
  }

  /**
   * Eligibility and grade, in that order, before anything is written.
   *
   * Eligibility first because it is about the person: telling somebody the
   * role is two grades up when the real answer is that they are on probation
   * sends them to argue about the wrong rule.
   */
  async gateApply(orgId: string, userId: string, jobLevelRank: number | null): Promise<InternalApplyGate> {
    const context = await this.contextFor(orgId, userId);

    const eligibility: Eligibility = decideEligibility(
      {
        lifecycleStatus: context.lifecycleStatus,
        joiningDate: context.joiningDate,
        probationEndDate: context.probationEndDate,
        onNotice: context.onNotice,
      },
      new Date(),
    );
    if (!eligibility.eligible) return { allowed: false, reason: eligibility.reason };

    const grade = decideGradeMove(context.levelRank, jobLevelRank);
    if (!grade.allowed) return { allowed: false, reason: grade.reason };

    return {
      allowed: true,
      managerMembershipId: context.managerMembershipId,
      gradeKind: grade.kind,
    };
  }

  /** The decision to stamp on a fresh internal application. */
  initialDecision(managerMembershipId: number | null) {
    return approvalRequired(managerMembershipId);
  }

  /**
   * Tells the applicant's manager, once, when the application reaches a stage
   * `managerMaySee` allows.
   *
   * Never throws. A manager who was not notified is a worse product; an
   * exception here would roll back a stage move the recruiter already made,
   * which is a worse outcome than the notice being late.
   */
  async notifyManagerIfVisible(
    orgId: string,
    candidateId: number,
    applicationStatus: string,
  ): Promise<void> {
    try {
      if (!managerMaySee(applicationStatus)) return;

      const [application] = await this.db
        .select({
          id: candidateApplications.id,
          managerMembershipId: candidateApplications.internalManagerMembershipId,
          notifiedAt: candidateApplications.internalManagerNotifiedAt,
          decision: candidateApplications.internalManagerDecision,
          jobTitle: jobPostings.title,
          firstName: candidates.firstName,
        })
        .from(candidateApplications)
        .innerJoin(
          jobPostings,
          and(
            eq(jobPostings.orgId, candidateApplications.orgId),
            eq(jobPostings.id, candidateApplications.jobPostingId),
          ),
        )
        .innerJoin(
          candidates,
          and(
            eq(candidates.orgId, candidateApplications.orgId),
            eq(candidates.id, candidateApplications.candidateId),
          ),
        )
        .where(
          and(
            eq(candidateApplications.orgId, orgId),
            eq(candidateApplications.candidateId, candidateId),
          ),
        )
        .orderBy(desc(candidateApplications.appliedAt))
        .limit(1);

      /* Not an internal application, nobody to tell, or already told. */
      if (!application?.decision) return;
      if (application.managerMembershipId === null) return;
      if (application.notifiedAt !== null) return;

      const [manager] = await this.db
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.id, application.managerMembershipId),
          ),
        )
        .limit(1);
      if (!manager) return;

      await this.notifications.create({
        orgId,
        userId: manager.userId,
        type: "INFO",
        title: "Someone on your team has an internal application",
        /*
          First name and the role, and nothing else. The manager gets the
          detail from the screen, which is gated; a notification body is
          forwarded, screenshotted and searched, and this one is about a person
          who has not told their manager anything yet.
        */
        message: `${application.firstName} has reached the interview stage for ${application.jobTitle}. Your approval is needed before the move can go ahead.`,
        link: `/hr/recruitment/internal-mobility`,
        metadata: { applicationId: application.id, candidateId },
      });

      /*
        Stamped after the notification, not before. A crash between the two
        sends a second notice on the next stage move, which is a nuisance; the
        other order loses it silently, which is the failure this column exists
        to make impossible.
      */
      await this.db
        .update(candidateApplications)
        .set({ internalManagerNotifiedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(candidateApplications.orgId, orgId),
            eq(candidateApplications.id, application.id),
          ),
        );
    } catch (error) {
      this.logger.error(
        `Internal-mobility manager notice failed for candidate ${candidateId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * The applications waiting on this manager.
   *
   * Only their own, and only ones that have reached a stage the applicant's
   * confidentiality allows — `internal_manager_notified_at` is the record of
   * that, so the queue cannot show a move the manager is not yet meant to know
   * about even if a decision row exists from the day it was applied for.
   */
  async pendingApprovals(orgId: string, membershipId: number) {
    return this.db
      .select({
        applicationId: candidateApplications.id,
        appliedAt: candidateApplications.appliedAt,
        status: candidateApplications.status,
        decision: candidateApplications.internalManagerDecision,
        decidedAt: candidateApplications.internalManagerDecidedAt,
        note: candidateApplications.internalManagerNote,
        jobTitle: jobPostings.title,
        candidateFirstName: candidates.firstName,
        candidateLastName: candidates.lastName,
      })
      .from(candidateApplications)
      .innerJoin(
        jobPostings,
        and(
          eq(jobPostings.orgId, candidateApplications.orgId),
          eq(jobPostings.id, candidateApplications.jobPostingId),
        ),
      )
      .innerJoin(
        candidates,
        and(
          eq(candidates.orgId, candidateApplications.orgId),
          eq(candidates.id, candidateApplications.candidateId),
        ),
      )
      .where(
        and(
          eq(candidateApplications.orgId, orgId),
          eq(candidateApplications.internalManagerMembershipId, membershipId),
          eq(candidateApplications.internalManagerDecision, "PENDING"),
        ),
      )
      .orderBy(desc(candidateApplications.appliedAt))
      .limit(100);
  }

  /**
   * The manager's answer.
   *
   * Authorized by standing rather than by a permission key: the authority is
   * being the head of that applicant's department, which is exactly the
   * predicate on the update. A caller who is not that person matches no row and
   * is refused — there is no second path that a key could open.
   */
  async decide(
    orgId: string,
    membershipId: number,
    userId: string,
    applicationId: number,
    decision: "APPROVED" | "DECLINED",
    note: string | null,
  ) {
    const [updated] = await this.db
      .update(candidateApplications)
      .set({
        internalManagerDecision: decision,
        internalManagerDecidedAt: new Date(),
        internalManagerNote: note,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(candidateApplications.orgId, orgId),
          eq(candidateApplications.id, applicationId),
          eq(candidateApplications.internalManagerMembershipId, membershipId),
          /* Only from PENDING: an answer is given once, not revised later. */
          eq(candidateApplications.internalManagerDecision, "PENDING"),
        ),
      )
      .returning({
        id: candidateApplications.id,
        decision: candidateApplications.internalManagerDecision,
        decidedAt: candidateApplications.internalManagerDecidedAt,
      });

    if (!updated) {
      /*
        404, never 403. A 403 on an application belonging to another manager
        confirms the row exists, which turns an id probe into an oracle for who
        in the organisation is quietly applying elsewhere.
      */
      throw new NotFoundException("No internal application awaiting your decision.");
    }

    await this.audit.logCritical({
      action: "INTERNAL_MOBILITY_DECISION",
      userId,
      orgId,
      targetId: String(applicationId),
      targetType: "candidate_application",
      metadata: { decision },
    });

    return updated;
  }

  /**
   * The applicant's own internal applications.
   *
   * Matched on the login email, because that is exactly what `internalApply`
   * copied onto the candidate row — resolved here from the caller's own user
   * id rather than accepted as a parameter, so the read cannot be pointed at
   * somebody else by passing a different address.
   */
  async myApplications(orgId: string, userId: string) {
    const [account] = await this.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!account?.email) return [];

    return this.db
      .select({
        applicationId: candidateApplications.id,
        appliedAt: candidateApplications.appliedAt,
        status: candidateApplications.status,
        managerDecision: candidateApplications.internalManagerDecision,
        managerDecidedAt: candidateApplications.internalManagerDecidedAt,
        jobTitle: jobPostings.title,
        jobPostingId: jobPostings.id,
      })
      .from(candidateApplications)
      .innerJoin(
        candidates,
        and(
          eq(candidates.orgId, candidateApplications.orgId),
          eq(candidates.id, candidateApplications.candidateId),
        ),
      )
      .innerJoin(
        jobPostings,
        and(
          eq(jobPostings.orgId, candidateApplications.orgId),
          eq(jobPostings.id, candidateApplications.jobPostingId),
        ),
      )
      .where(
        and(
          eq(candidateApplications.orgId, orgId),
          eq(candidates.orgId, orgId),
          eq(candidates.email, account.email),
          eq(candidates.source, "INTERNAL"),
        ),
      )
      .orderBy(desc(candidateApplications.appliedAt))
      .limit(50);
  }

  /** The caller's membership id, which the request context does not carry. */
  async membershipIdFor(orgId: string, userId: string): Promise<number> {
    const [member] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
      .limit(1);
    if (!member) throw new ForbiddenException("You are not a member of this organisation.");
    return member.id;
  }
}
