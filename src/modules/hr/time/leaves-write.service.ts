import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
} from "@nestjs/common";
import { and, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import {
  leaveBalances,
  leaveBlackoutDates,
  leavePolicies,
  leaveRequests,
  leaveTypes,
  organizationMembers,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AuditService } from "../../../common/audit/audit.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { AutomationService } from "../../automation/automation.service";
import { formatDateOnly } from "../../../common/date";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import { logSideEffectFailure } from "../../../common/logger/side-effect";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { HrWorkflowEngineService } from "../workflows/hr-workflow-engine.service";
import { CacheService } from "../../../common/cache/cache.service";
import {
  CACHE_KEYS,
  DASHBOARD_PENDING_APPROVALS_NAMESPACE,
} from "../../../common/cache/cache-keys";
import { AccessService } from "../../access/access.service";
import { EmploymentFactsService } from "../../directory/employment-facts.service";
import type { CreateLeaveInput } from "./dto/leaves.schemas";
import { LeaveApproverService } from "./leave-approver.service";
import { decideProbationLeave } from "./probation-leave-restriction";
import { ProbationService } from "../lifecycle/probation.service";
import {
  assertOrganizationActor,
  OrganizationActorError,
  organizationActorHttpError,
} from "../../../common/organization/organization-actor";
import { requireOrganizationMembershipId } from "./organization-membership";

interface LeaveRow {
  userId: string;
  leaveTypeId: number;
  startDate: string;
  endDate: string;
}

@Injectable()
export class LeavesWriteService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly dispatch: NotificationDispatchService,
    private readonly automation: AutomationService,
    private readonly workflowEngine: HrWorkflowEngineService,
    private readonly cache: CacheService,
    private readonly access: AccessService,
    private readonly approvers: LeaveApproverService,
    private readonly probation: ProbationService,
    private readonly employment: EmploymentFactsService,
  ) {}

  private async invalidateLeaveAnalytics(orgId: string): Promise<void> {
    await Promise.all([
      this.cache.invalidateNamespace(CACHE_KEYS.leaveAnalyticsNamespace(orgId)),
      this.cache.invalidateNamespaceForOrg(orgId, DASHBOARD_PENDING_APPROVALS_NAMESPACE),
    ]);
  }

  async create(currentUser: CurrentUserContext, body: CreateLeaveInput) {
    const userMembershipId = await requireOrganizationMembershipId(
      this.db,
      currentUser.orgId,
      currentUser.userId,
    );
    const approver = await this.approvers.resolve(currentUser.orgId, currentUser.userId);
    if (!approver) {
      throw new ConflictException(
        "No authorized leave approver is configured. Ask an organization administrator to assign one.",
      );
    }

    let approverMembershipId: number;
    try {
      const approverActor = await assertOrganizationActor(this.db, currentUser.orgId, {
        kind: "user",
        userId: approver.id,
      });
      approverMembershipId = approverActor.membershipId;
    } catch (e) {
      if (e instanceof OrganizationActorError) throw organizationActorHttpError(e);
      throw e;
    }

    const requestedDays = body.isHalfDay
      ? 0.5
      : Math.round(
          Math.abs(new Date(body.endDate).getTime() - new Date(body.startDate).getTime()) /
            (1000 * 60 * 60 * 24),
        ) + 1;

    const startStr = formatDateOnly(body.startDate);
    const endStr = formatDateOnly(body.endDate);

    const teamConflicts = await this.detectTeamConflicts(currentUser.orgId, currentUser.userId, startStr, endStr);

    const [activePolicy] = await this.db
      .select({ probationRestricted: leavePolicies.probationRestricted })
      .from(leavePolicies)
      .where(
        and(
          eq(leavePolicies.orgId, currentUser.orgId),
          eq(leavePolicies.leaveTypeId, body.leaveTypeId),
          eq(leavePolicies.isActive, true),
        ),
      )
      .limit(1);

    if (activePolicy?.probationRestricted) {
      const coverage = await this.probation.probationCoverageOn(
        currentUser.orgId,
        currentUser.userId,
        startStr,
      );
      const decision = decideProbationLeave({ probationRestricted: true, coverage });
      if (!decision.allowed) throw new BadRequestException(decision.reason);
    }

    const { leaveRequest, leaveTypeName } = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${currentUser.orgId}:${currentUser.userId}:leave-request`}, 0))`,
      );
      const balanceRows = await tx
        .select()
        .from(leaveBalances)
        .where(
          and(
            eq(leaveBalances.userMembershipId, userMembershipId),
            eq(leaveBalances.orgId, currentUser.orgId),
            eq(leaveBalances.leaveTypeId, body.leaveTypeId),
            eq(leaveBalances.year, new Date().getFullYear()),
          ),
        )
        .for("update")
        .limit(1);
      const balance = balanceRows[0];

      const leaveTypeRow = await tx.query.leaveTypes.findFirst({
        where: and(eq(leaveTypes.id, body.leaveTypeId), eq(leaveTypes.orgId, currentUser.orgId)),
        columns: { name: true, daysPerYear: true },
      });

      const isUnpaid = (leaveTypeRow?.daysPerYear ?? 1) === 0;
      if (!isUnpaid && balance && Number(balance.balance) < requestedDays) {
        throw new BadRequestException(
          `Insufficient leave balance. Available: ${balance.balance}, Required: ${requestedDays}`,
        );
      }

      const [overlapping, blackout] = await Promise.all([
        tx.query.leaveRequests.findFirst({
          where: and(
            eq(leaveRequests.userMembershipId, userMembershipId),
            eq(leaveRequests.orgId, currentUser.orgId),
            lte(leaveRequests.startDate, endStr),
            gte(leaveRequests.endDate, startStr),
          ),
        }),
        tx.query.leaveBlackoutDates.findFirst({
          where: and(
            eq(leaveBlackoutDates.orgId, currentUser.orgId),
            lte(leaveBlackoutDates.startDate, endStr),
            gte(leaveBlackoutDates.endDate, startStr),
            or(
              eq(leaveBlackoutDates.appliesTo, "ALL"),
              eq(leaveBlackoutDates.appliesTo, currentUser.userId),
            ),
          ),
        }),
      ]);

      if (overlapping && overlapping.status !== "REJECTED" && overlapping.status !== "CANCELLED") {
        throw new BadRequestException("You already have a leave request for overlapping dates.");
      }

      if (blackout) {
        throw new BadRequestException(
          `Leave cannot be requested during blackout period: ${blackout.reason}`,
        );
      }

      const serializedOverlap = await tx.query.leaveRequests.findFirst({
        where: and(
          eq(leaveRequests.userMembershipId, userMembershipId),
          eq(leaveRequests.orgId, currentUser.orgId),
          lte(leaveRequests.startDate, endStr),
          gte(leaveRequests.endDate, startStr),
          inArray(leaveRequests.status, ["PENDING", "APPROVED"]),
        ),
        columns: { id: true },
      });
      if (serializedOverlap) {
        throw new ConflictException("You already have a leave request for overlapping dates.");
      }

      const [inserted] = await tx
        .insert(leaveRequests)
        .values({
          orgId: currentUser.orgId,
          userId: currentUser.userId,
          userMembershipId,
          leaveTypeId: body.leaveTypeId,
          startDate: startStr,
          endDate: endStr,
          reason: body.reason,
          priority: body.priority,
          approverId: approver.id,
          approverMembershipId,
          createdByMembershipId: userMembershipId,
          updatedByMembershipId: userMembershipId,
          attachmentUrl: body.attachmentUrl ?? null,
          isHalfDay: body.isHalfDay,
          halfDayPeriod: body.halfDayPeriod ?? null,
          status: "PENDING",
        })
        .returning();

      if (!inserted) {
        throw new InternalServerErrorException("Failed to create leave request.");
      }

      return { leaveRequest: inserted, leaveTypeName: leaveTypeRow?.name ?? "Leave" };
    });

    this.scheduleLeaveRequested(
      currentUser,
      leaveRequest.id,
      approver.id,
      body,
      leaveTypeName,
      requestedDays,
    );

    await this.invalidateLeaveAnalytics(currentUser.orgId);

    return {
      success: true,
      conflictWarning:
        teamConflicts.length > 0
          ? `${teamConflicts.length} team member(s) are also on leave during this period.`
          : undefined,
    };
  }

  private scheduleLeaveRequested(
    currentUser: CurrentUserContext,
    leaveRequestId: number,
    approverId: string,
    body: CreateLeaveInput,
    leaveTypeName: string,
    requestedDays: number,
  ): void {
    const dispatch = () =>
      runInNewTenantTransaction(this.db, currentUser.orgId, async () => {
        await this.startLeaveWorkflow(currentUser, leaveRequestId, approverId);
        await this.dispatchLeaveRequested(
          currentUser,
          leaveRequestId,
          body,
          leaveTypeName,
          requestedDays,
        );
      }).catch(
        logSideEffectFailure("leave requested side effects", {
          orgId: currentUser.orgId,
          leaveRequestId,
        }),
      );
    if (!registerAfterCommit(dispatch)) void dispatch();
  }

  async cancel(currentUser: CurrentUserContext, leaveId: number) {
    const userMembershipId = await requireOrganizationMembershipId(
      this.db,
      currentUser.orgId,
      currentUser.userId,
    );
    const existing = await this.db.transaction(async (tx) => {
      const current = await tx.query.leaveRequests.findFirst({
        where: and(eq(leaveRequests.id, leaveId), eq(leaveRequests.orgId, currentUser.orgId)),
      });

      if (!current) return null;
      if (current.userMembershipId !== userMembershipId) {
        throw new ForbiddenException("You can only cancel your own leave requests.");
      }

      if (current.status !== "PENDING") {
        throw new ConflictException("Only pending leave requests can be cancelled.");
      }

      const changed = await tx
        .update(leaveRequests)
        .set({
          status: "CANCELLED",
          rowVersion: current.rowVersion + 1,
          updatedByMembershipId: userMembershipId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(leaveRequests.id, leaveId),
            eq(leaveRequests.orgId, currentUser.orgId),
            eq(leaveRequests.userMembershipId, userMembershipId),
            eq(leaveRequests.status, "PENDING"),
            eq(leaveRequests.rowVersion, current.rowVersion),
          ),
        )
        .returning({ id: leaveRequests.id });

      if (changed.length !== 1) {
        throw new ConflictException("This leave request was already updated. Refresh and try again.");
      }

      await this.audit.logCritical({
        action: "hr.leave_cancelled",
        userId: currentUser.userId,
        orgId: currentUser.orgId,
        targetId: String(leaveId),
        targetType: "leave_request",
      });
      return current;
    });

    if (!existing) return { ok: false as const, reason: "not_found" as const };

    const dispatch = () => this.dispatchLeaveCancellation(currentUser, leaveId, existing);
    if (!registerAfterCommit(dispatch)) void dispatch();

    await this.invalidateLeaveAnalytics(currentUser.orgId);

    return { ok: true as const };
  }

  private async detectTeamConflicts(
    orgId: string,
    userId: string,
    startDate: string,
    endDate: string,
  ): Promise<string[]> {
    const facts = await this.employment.getFacts(orgId, userId);

    const peerIds = facts.managerUserId
      ? (await this.employment.getDirectReportUserIds(orgId, facts.managerUserId)).filter(
          (id) => id !== userId,
        )
      : [];
    if (peerIds.length === 0) return [];

    const conflicts = await this.db
      .select({ userId: leaveRequests.userId })
      .from(leaveRequests)
      .innerJoin(organizationMembers, eq(organizationMembers.id, leaveRequests.userMembershipId))
      .where(and(
        eq(leaveRequests.orgId, orgId),
        eq(leaveRequests.status, "APPROVED"),
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.status, "ACTIVE"),
        inArray(organizationMembers.userId, peerIds),
        lte(leaveRequests.startDate, endDate),
        gte(leaveRequests.endDate, startDate),
      ))
      .limit(10);

    return [...new Set(conflicts.map((c) => c.userId))];
  }

  private async startLeaveWorkflow(
    currentUser: CurrentUserContext,
    leaveRequestId: number,
    approverId?: string | null,
  ): Promise<void> {
    try {
      await this.workflowEngine.startWorkflow({
        orgId: currentUser.orgId,
        objectType: "leave_request",
        objectId: String(leaveRequestId),
        requestedByUserId: currentUser.userId,
        subjectEmployeeId: currentUser.userId,
        context: { leaveRequestId, approverId },
      });
    } catch (err: unknown) {
      logSideEffectFailure("leave approval workflow start", {
        orgId: currentUser.orgId,
        leaveRequestId,
      })(err);
    }
  }

  private async dispatchLeaveRequested(
    currentUser: CurrentUserContext,
    leaveRequestId: number,
    body: CreateLeaveInput,
    leaveTypeName: string,
    requestedDays: number,
  ): Promise<void> {
    try {
      const actor = await this.db.query.users.findFirst({
        where: eq(users.id, currentUser.userId),
        columns: { name: true },
      });
      const actorName = actor?.name ?? null;

      await this.automation.runAutomationsForEvent(currentUser.orgId, "leave.requested", {
        leaveRequestId,
        userId: currentUser.userId,
        employeeName: actorName ?? "",
        leaveType: leaveTypeName,
        startDate: body.startDate,
        endDate: body.endDate,
        totalDays: requestedDays,
        reason: body.reason ?? null,
        priority: body.priority,
      });

      const recipients = await this.hrRecipientIds(currentUser.orgId);
      await this.dispatch.emit({
        eventKey: "hr.leave.requested",
        orgId: currentUser.orgId,
        actorUserId: currentUser.userId,
        targetUserIds: recipients,
        entityType: "leave_request",
        entityId: String(leaveRequestId),
        message: `${actorName ?? "Employee"} submitted a ${leaveTypeName} leave request.`,
        variables: { employeeName: actorName ?? "Employee", leaveType: leaveTypeName, startDate: formatDateOnly(body.startDate), endDate: formatDateOnly(body.endDate), reason: body.reason ?? "No reason provided" },
      });
    } catch (err: unknown) {
      logSideEffectFailure("leave requested notification", {
        orgId: currentUser.orgId,
        leaveRequestId,
      })(err);
    }
  }

  private async dispatchLeaveCancellation(currentUser: CurrentUserContext, leaveId: number, existing: LeaveRow): Promise<void> {
    try {
      const [leaveTypeRow, actor] = await Promise.all([
        existing.leaveTypeId
          ? this.db.query.leaveTypes.findFirst({
              where: eq(leaveTypes.id, existing.leaveTypeId),
              columns: { name: true },
            })
          : Promise.resolve(null),
        this.db.query.users.findFirst({
          where: eq(users.id, currentUser.userId),
          columns: { name: true },
        }),
      ]);

      const leaveTypeName = leaveTypeRow?.name ?? "Leave";
      const employeeName = actor?.name ?? "Employee";

      const recipients = await this.hrRecipientIds(currentUser.orgId);
      await this.dispatch.emit({
        eventKey: "hr.leave.cancelled",
        orgId: currentUser.orgId,
        actorUserId: currentUser.userId,
        targetUserIds: recipients,
        entityType: "leave_request",
        entityId: String(leaveId),
        message: `${employeeName} cancelled a ${leaveTypeName} leave request.`,
        variables: { employeeName, leaveType: leaveTypeName, startDate: existing.startDate, endDate: existing.endDate },
      });
    } catch (err: unknown) {
      logSideEffectFailure("leave cancellation notification", {
        orgId: currentUser.orgId,
        leaveId,
      })(err);
    }
  }

  private async hrRecipientIds(orgId: string): Promise<string[]> {
    const approvers = await this.access.membersWithPermission(orgId, "hr:leaves:approve");
    if (approvers.length === 0) return [];

    return approvers.map((m) => m.userId);
  }
}
