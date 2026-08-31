import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import {
  assertOrganizationActor,
  OrganizationActorError,
  organizationActorHttpError,
} from "../../../common/organization/organization-actor";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  organizationMembers,
  payrollApprovals,
  payrollRunEvents,
  payrollRuns,
} from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import { logger } from "../../../common/logger/logger.service";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import {
  DEFAULT_PAYROLL_TOGGLES,
  type PayrollToggles,
} from "../payroll.types";
import { PayrollNotificationsService } from "../insights/payroll-notifications.service";
import { AuditService } from "../../../common/audit/audit.service";
import { GenerateService } from "../runs/generate.service";
import { PayrollApproverResolverService } from "./payroll-approver-resolver.service";

@Injectable()
export class ApprovalActionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly notifications: PayrollNotificationsService,
    private readonly audit: AuditService,
    private readonly generate: GenerateService,
    private readonly resolver: PayrollApproverResolverService,
  ) {}

  async approveStage(
    orgId: string,
    userId: string,
    runId: number,
    approvalId: number,
    comment?: string,
    requestId?: string | null,
  ) {
    const [approval, run] = await Promise.all([
      this.db.query.payrollApprovals.findFirst({
        where: and(
          eq(payrollApprovals.id, approvalId),
          eq(payrollApprovals.runId, runId),
          eq(payrollApprovals.orgId, orgId),
        ),
      }),
      this.db.query.payrollRuns.findFirst({
        where: and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)),
        with: { policyVersion: { columns: { toggles: true } } },
      }),
    ]);

    if (!approval || !run) throw new NotFoundException("Payroll run or approval not found");

    if (approval.status !== "PENDING") throw new ConflictException("Approval already acted on");

    if (run.status !== "PENDING_APPROVAL") throw new ConflictException("Run is not pending approval");

    const allStages = await this.db
      .select({
        id: payrollApprovals.id,
        status: payrollApprovals.status,
        requiredPermission: payrollApprovals.requiredPermission,
        stageName: payrollApprovals.stageName,
      })
      .from(payrollApprovals)
      .where(and(eq(payrollApprovals.runId, runId), eq(payrollApprovals.orgId, orgId)))
      .orderBy(asc(payrollApprovals.stage));

    const nextPending = allStages.find((s) => s.status === "PENDING");

    if (nextPending?.id !== approvalId) {
      throw new ConflictException("This is not the next stage to approve");
    }

    const memberRow = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.userId, userId), eq(organizationMembers.orgId, orgId)),
      columns: { isOwner: true },
    });
    const isOrgOwner = memberRow?.isOwner === true;

    if (!isOrgOwner) {
      const perms = await this.access.resolveUserPermissions(orgId, userId);
      if (!perms.has(approval.requiredPermission)) {
        throw new ForbiddenException(`Missing required permission: ${approval.requiredPermission}`);
      }
    }

    const submittedEvent = await this.db.query.payrollRunEvents.findFirst({
      where: and(
        eq(payrollRunEvents.runId, runId),
        eq(payrollRunEvents.orgId, orgId),
        eq(payrollRunEvents.type, "APPROVAL_SUBMITTED"),
      ),
    });

    if (submittedEvent?.actorId === userId) {
      throw new ForbiddenException(
        "Maker-checker violation: the submitter cannot approve their own payroll run",
      );
    }

    const stageActor = await assertOrganizationActor(this.db, orgId, { kind: "user", userId }).catch((e: unknown) => {
      if (e instanceof OrganizationActorError) throw organizationActorHttpError(e);
      throw e;
    });

    const isLastStage = allStages.every((s) => s.id === approvalId || s.status === "APPROVED");
    const rawRunToggles = run.policyVersion?.toggles;
    const runToggles: PayrollToggles = rawRunToggles && typeof rawRunToggles === "object"
      ? { ...DEFAULT_PAYROLL_TOGGLES, ...(rawRunToggles as Partial<PayrollToggles>) }
      : { ...DEFAULT_PAYROLL_TOGGLES };
    const lockAfterApproval = runToggles.lockAfterApproval !== false;

    const nextStage = !isLastStage
      ? (allStages.find((s) => s.id !== approvalId && s.status === "PENDING") ?? null)
      : null;

    const nextStageApprovers = nextStage
      ? await this.resolver.resolveApprovers(orgId, nextStage.requiredPermission)
      : [];

    const result = await this.db.transaction(async (tx) => {
      await tx
        .update(payrollApprovals)
        .set({ status: "APPROVED", actedBy: userId, actedByMembershipId: stageActor.membershipId, actedAt: new Date(), comment: comment ?? null })
        .where(and(eq(payrollApprovals.id, approvalId), eq(payrollApprovals.orgId, orgId)));

      if (isLastStage) {
        if (lockAfterApproval) {
          await tx
            .update(payrollRuns)
            .set({
              status: "LOCKED",
              lockedAt: new Date(),
              lockedBy: userId,
              approvedAt: new Date(),
              approvedBy: userId,
              approvedByMembershipId: stageActor.membershipId,
            })
            .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)));

          await tx.insert(payrollRunEvents).values([
            { orgId, runId, type: "APPROVED", actorId: userId },
            { orgId, runId, type: "LOCKED", actorId: userId },
          ]);

          await this.generate.postPayrollLock(orgId, runId, tx);
        } else {
          await tx
            .update(payrollRuns)
            .set({ status: "APPROVED", approvedAt: new Date(), approvedBy: userId, approvedByMembershipId: stageActor.membershipId })
            .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)));

          await tx.insert(payrollRunEvents).values({
            orgId,
            runId,
            type: "APPROVED",
            actorId: userId,
          });
        }
      }

      const runStatus: "LOCKED" | "APPROVED" | "PENDING_APPROVAL" = isLastStage
        ? lockAfterApproval
          ? "LOCKED"
          : "APPROVED"
        : "PENDING_APPROVAL";

      return { success: true, runStatus };
    });

    if (nextStage && nextStageApprovers.length > 0) {
      const { stageName } = nextStage;
      const notifyNext = () =>
        Promise.all(
          nextStageApprovers.map((approverId) =>
            this.notifications.notifyApprovalPending(orgId, approverId, runId, stageName),
          ),
        ).catch((e: unknown) => logger.error("notifyApprovalPending failed", { error: String(e) }));
      if (!registerAfterCommit(notifyNext)) void notifyNext();
    }

    this.audit.log({
      action: "payroll.run_approval_stage_approved",
      userId,
      orgId,
      actorMembershipId: stageActor.membershipId,
      targetId: String(runId),
      targetType: "payroll_run",
      requestId: requestId ?? null,
      metadata: { approvalId, stageName: approval.stageName, resultingStatus: result.runStatus },
    });

    return result;
  }

  async rejectStage(
    orgId: string,
    userId: string,
    runId: number,
    approvalId: number,
    comment: string,
    requestId?: string | null,
  ) {
    const [approval, run] = await Promise.all([
      this.db.query.payrollApprovals.findFirst({
        where: and(
          eq(payrollApprovals.id, approvalId),
          eq(payrollApprovals.runId, runId),
          eq(payrollApprovals.orgId, orgId),
        ),
      }),
      this.db.query.payrollRuns.findFirst({
        where: and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)),
        columns: { id: true, status: true },
      }),
    ]);

    if (!approval || !run) throw new NotFoundException("Payroll run or approval not found");

    if (approval.status !== "PENDING") throw new ConflictException("Approval already acted on");

    const memberRow = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.userId, userId), eq(organizationMembers.orgId, orgId)),
      columns: { isOwner: true },
    });
    const isOrgOwner = memberRow?.isOwner === true;

    if (!isOrgOwner) {
      const perms = await this.access.resolveUserPermissions(orgId, userId);
      if (!perms.has(approval.requiredPermission)) {
        throw new ForbiddenException(`Missing required permission: ${approval.requiredPermission}`);
      }
    }

    const submittedEvent = await this.db.query.payrollRunEvents.findFirst({
      where: and(
        eq(payrollRunEvents.runId, runId),
        eq(payrollRunEvents.orgId, orgId),
        eq(payrollRunEvents.type, "APPROVAL_SUBMITTED"),
      ),
    });
    if (submittedEvent?.actorId === userId) {
      throw new ForbiddenException(
        "Maker-checker violation: the submitter cannot reject their own payroll run",
      );
    }

    const rejectActor = await assertOrganizationActor(this.db, orgId, { kind: "user", userId }).catch((e: unknown) => {
      if (e instanceof OrganizationActorError) throw organizationActorHttpError(e);
      throw e;
    });

    const allStages = await this.db
      .select({
        id: payrollApprovals.id,
        status: payrollApprovals.status,
      })
      .from(payrollApprovals)
      .where(and(eq(payrollApprovals.runId, runId), eq(payrollApprovals.orgId, orgId)))
      .orderBy(asc(payrollApprovals.stage));

    const nextPending = allStages.find((s) => s.status === "PENDING");

    if (nextPending?.id !== approvalId) {
      throw new ConflictException("This is not the next stage to reject");
    }

    const result = await this.db.transaction(async (tx) => {
      await tx
        .update(payrollApprovals)
        .set({ status: "REJECTED", actedBy: userId, actedByMembershipId: rejectActor.membershipId, actedAt: new Date(), comment })
        .where(and(eq(payrollApprovals.id, approvalId), eq(payrollApprovals.orgId, orgId)));

      await tx
        .update(payrollRuns)
        .set({ status: "PREVIEW_READY" })
        .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)));

      await tx.insert(payrollRunEvents).values({
        orgId,
        runId,
        type: "REJECTED",
        actorId: userId,
        reason: comment,
      });

      return { success: true, runStatus: "PREVIEW_READY" as const };
    });

    this.audit.log({
      action: "payroll.run_approval_stage_rejected",
      userId,
      orgId,
      actorMembershipId: rejectActor.membershipId,
      targetId: String(runId),
      targetType: "payroll_run",
      requestId: requestId ?? null,
      metadata: { approvalId, stageName: approval.stageName, reason: comment },
    });

    return result;
  }
}
