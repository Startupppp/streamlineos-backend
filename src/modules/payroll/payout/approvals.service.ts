import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  organizationMembers,
  payrollApprovals,
  payrollExceptions,
  payrollRunEvents,
  payrollRuns,
} from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import {
  DEFAULT_PAYROLL_TOGGLES,
  type PayrollApprovalStageDef,
  type PayrollPolicyConfig,
} from "../payroll.types";
import { PayrollNotificationsService } from "../insights/payroll-notifications.service";

@Injectable()
export class ApprovalsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly notifications: PayrollNotificationsService,
  ) {}

  async submitApproval(orgId: string, userId: string, runId: number) {
    const run = await this.db.query.payrollRuns.findFirst({
      where: and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)),
      with: { policyVersion: true },
    });

    if (!run) throw new NotFoundException(`Payroll run ${runId} not found`);

    if (run.status !== "PREVIEW_READY" && run.status !== "EXCEPTIONS_FOUND") {
      throw new ConflictException(`Cannot submit approval: run status is ${run.status}`);
    }

    const blockers = await this.db
      .select({ id: payrollExceptions.id })
      .from(payrollExceptions)
      .where(
        and(
          eq(payrollExceptions.runId, runId),
          eq(payrollExceptions.orgId, orgId),
          eq(payrollExceptions.severity, "BLOCKER"),
          eq(payrollExceptions.status, "OPEN"),
        ),
      );

    if (blockers.length > 0) {
      throw new BadRequestException(
        `Cannot submit: ${blockers.length} open blocker exception(s) must be resolved`,
      );
    }

    const toggles = (run.policyVersion?.toggles ?? DEFAULT_PAYROLL_TOGGLES) as typeof DEFAULT_PAYROLL_TOGGLES;
    const policyConfig = run.policyVersion?.config as PayrollPolicyConfig | null;
    const approvalWorkflow = toggles.approvalWorkflow !== false;

    if (!approvalWorkflow) {
      return this.db.transaction(async (tx) => {
        await tx
          .update(payrollRuns)
          .set({ status: "APPROVED", approvedAt: new Date(), approvedBy: userId })
          .where(eq(payrollRuns.id, runId));

        await tx.insert(payrollRunEvents).values([
          { orgId, runId, type: "APPROVAL_SUBMITTED", actorId: userId },
          { orgId, runId, type: "APPROVED", actorId: userId, metadata: { autoApproved: true } },
        ]);

        return { autoApproved: true, runStatus: "APPROVED" as const };
      });
    }

    const rawChain = policyConfig?.approvalChain;
    const chain: PayrollApprovalStageDef[] =
      rawChain && rawChain.length > 0
        ? rawChain
        : [{ stage: 1, stageName: "Finance Approval", requiredPermission: "payroll:runs:approve" }];

    return this.db.transaction(async (tx) => {
      await tx.insert(payrollApprovals).values(
        chain.map((def) => ({
          orgId,
          runId,
          stage: def.stage,
          stageName: def.stageName,
          requiredPermission: def.requiredPermission,
        })),
      );

      await tx
        .update(payrollRuns)
        .set({ status: "PENDING_APPROVAL" })
        .where(eq(payrollRuns.id, runId));

      await tx.insert(payrollRunEvents).values({
        orgId,
        runId,
        type: "APPROVAL_SUBMITTED",
        actorId: userId,
      });

      const firstStageName = chain[0]?.stageName ?? "Stage 1";
      this.notifications
        .notifyApprovalPending(orgId, userId, runId, firstStageName)
        .catch(e => console.error("notifyApprovalPending failed", e));

      return { autoApproved: false, runStatus: "PENDING_APPROVAL" as const, stagesCreated: chain.length };
    });
  }

  async listApprovals(orgId: string, runId: number) {
    const run = await this.db
      .select({ id: payrollRuns.id })
      .from(payrollRuns)
      .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)))
      .limit(1);

    if (!run[0]) throw new NotFoundException(`Payroll run ${runId} not found`);

    return this.db
      .select()
      .from(payrollApprovals)
      .where(and(eq(payrollApprovals.runId, runId), eq(payrollApprovals.orgId, orgId)))
      .orderBy(asc(payrollApprovals.stage));
  }

  async approveStage(
    orgId: string,
    userId: string,
    runId: number,
    approvalId: number,
    comment?: string,
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
        with: { policyVersion: true },
      }),
    ]);

    if (!approval || !run) throw new NotFoundException("Payroll run or approval not found");

    if (approval.status !== "PENDING") throw new ConflictException("Approval already acted on");

    if (run.status !== "PENDING_APPROVAL") throw new ConflictException("Run is not pending approval");

    const allStages = await this.db
      .select()
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
        eq(payrollRunEvents.type, "APPROVAL_SUBMITTED"),
      ),
    });

    if (submittedEvent?.actorId === userId) {
      throw new ForbiddenException(
        "Maker-checker violation: the submitter cannot approve their own payroll run",
      );
    }

    const isLastStage = allStages.every((s) => s.id === approvalId || s.status === "APPROVED");
    const toggles = (run.policyVersion?.toggles ?? DEFAULT_PAYROLL_TOGGLES) as typeof DEFAULT_PAYROLL_TOGGLES;
    const lockAfterApproval = toggles.lockAfterApproval !== false;

    return this.db.transaction(async (tx) => {
      await tx
        .update(payrollApprovals)
        .set({ status: "APPROVED", actedBy: userId, actedAt: new Date(), comment: comment ?? null })
        .where(eq(payrollApprovals.id, approvalId));

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
            })
            .where(eq(payrollRuns.id, runId));

          await tx.insert(payrollRunEvents).values([
            { orgId, runId, type: "APPROVED", actorId: userId },
            { orgId, runId, type: "LOCKED", actorId: userId },
          ]);
        } else {
          await tx
            .update(payrollRuns)
            .set({ status: "APPROVED", approvedAt: new Date(), approvedBy: userId })
            .where(eq(payrollRuns.id, runId));

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

      if (!isLastStage) {
        const nextStage = allStages.find(s => s.id !== approvalId && s.status === "PENDING");
        if (nextStage) {
          this.notifications
            .notifyApprovalPending(orgId, userId, runId, nextStage.stageName)
            .catch(e => console.error("notifyApprovalPending failed", e));
        }
      }

      return { success: true, runStatus };
    });
  }

  async rejectStage(
    orgId: string,
    userId: string,
    runId: number,
    approvalId: number,
    comment: string,
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

    const allStages = await this.db
      .select()
      .from(payrollApprovals)
      .where(and(eq(payrollApprovals.runId, runId), eq(payrollApprovals.orgId, orgId)))
      .orderBy(asc(payrollApprovals.stage));

    const nextPending = allStages.find((s) => s.status === "PENDING");

    if (nextPending?.id !== approvalId) {
      throw new ConflictException("This is not the next stage to reject");
    }

    return this.db.transaction(async (tx) => {
      await tx
        .update(payrollApprovals)
        .set({ status: "REJECTED", actedBy: userId, actedAt: new Date(), comment })
        .where(eq(payrollApprovals.id, approvalId));

      await tx
        .update(payrollRuns)
        .set({ status: "PREVIEW_READY" })
        .where(eq(payrollRuns.id, runId));

      await tx.insert(payrollRunEvents).values({
        orgId,
        runId,
        type: "REJECTED",
        actorId: userId,
        reason: comment,
      });

      return { success: true, runStatus: "PREVIEW_READY" as const };
    });
  }
}
