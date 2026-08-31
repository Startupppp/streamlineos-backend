import {
  BadRequestException,
  ConflictException,
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
  payrollExceptions,
  payrollRunEvents,
  payrollRuns,
} from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import { logger } from "../../../common/logger/logger.service";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import {
  DEFAULT_PAYROLL_TOGGLES,
  type PayrollApprovalStageDef,
  type PayrollPolicyConfig,
  type PayrollToggles,
} from "../payroll.types";
import { PayrollNotificationsService } from "../insights/payroll-notifications.service";
import { AuditService } from "../../../common/audit/audit.service";
import { PayrollApproverResolverService } from "./payroll-approver-resolver.service";
import { ApprovalActionsService } from "./approval-actions.service";

@Injectable()
export class ApprovalsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly notifications: PayrollNotificationsService,
    private readonly audit: AuditService,
    private readonly actions: ApprovalActionsService,
    private readonly resolver: PayrollApproverResolverService,
  ) {}

  async submitApproval(orgId: string, userId: string, runId: number, requestId?: string | null) {
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

    const rawToggles = run.policyVersion?.toggles;
    const toggles: PayrollToggles = rawToggles && typeof rawToggles === "object"
      ? { ...DEFAULT_PAYROLL_TOGGLES, ...(rawToggles as Partial<PayrollToggles>) }
      : { ...DEFAULT_PAYROLL_TOGGLES };
    const rawConfig = run.policyVersion?.config;
    const policyConfig: PayrollPolicyConfig | null = rawConfig && typeof rawConfig === "object" ? (rawConfig as PayrollPolicyConfig) : null;
    const approvalWorkflow = toggles.approvalWorkflow !== false;

    if (!approvalWorkflow) {
      const approverActor = await assertOrganizationActor(this.db, orgId, { kind: "user", userId }).catch((e: unknown) => {
        if (e instanceof OrganizationActorError) throw organizationActorHttpError(e);
        throw e;
      });
      const autoResult = await this.db.transaction(async (tx) => {
        await tx
          .update(payrollRuns)
          .set({ status: "APPROVED", approvedAt: new Date(), approvedBy: userId, approvedByMembershipId: approverActor.membershipId })
          .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)));

        await tx.insert(payrollRunEvents).values([
          { orgId, runId, type: "APPROVAL_SUBMITTED", actorId: userId },
          { orgId, runId, type: "APPROVED", actorId: userId, metadata: { autoApproved: true } },
        ]);

        return { autoApproved: true, runStatus: "APPROVED" as const };
      });

      this.audit.log({
        action: "payroll.run_approval_submitted",
        userId,
        orgId,
        actorMembershipId: approverActor.membershipId,
        targetId: String(runId),
        targetType: "payroll_run",
        requestId: requestId ?? null,
        metadata: { runId, autoApproved: true },
      });

      return autoResult;
    }

    const submitterActor = await assertOrganizationActor(this.db, orgId, { kind: "user", userId }).catch((e: unknown) => {
      if (e instanceof OrganizationActorError) throw organizationActorHttpError(e);
      throw e;
    });

    const rawChain = policyConfig?.approvalChain;
    const chain: PayrollApprovalStageDef[] =
      rawChain && rawChain.length > 0
        ? rawChain
        : [{ stage: 1, stageName: "Finance Approval", requiredPermission: "payroll:runs:approve" }];

    const firstStage = chain[0];
    const firstStageApprovers = firstStage
      ? await this.resolver.resolveApprovers(orgId, firstStage.requiredPermission)
      : [];

    const submitResult = await this.db.transaction(async (tx) => {
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
        .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)));

      await tx.insert(payrollRunEvents).values({
        orgId,
        runId,
        type: "APPROVAL_SUBMITTED",
        actorId: userId,
      });

      return { autoApproved: false, runStatus: "PENDING_APPROVAL" as const, stagesCreated: chain.length };
    });

    if (firstStage && firstStageApprovers.length > 0) {
      const { stageName } = firstStage;
      const notifyPending = () =>
        Promise.all(
          firstStageApprovers.map((approverId) =>
            this.notifications.notifyApprovalPending(orgId, approverId, runId, stageName),
          ),
        ).catch((e: unknown) => logger.error("notifyApprovalPending failed", { error: String(e) }));
      if (!registerAfterCommit(notifyPending)) void notifyPending();
    }

    const notifySubmitted = () =>
      this.notifications
        .notifyApprovalSubmitted(orgId, userId, runId)
        .catch((e: unknown) => logger.error("notifyApprovalSubmitted failed", { error: String(e) }));
    if (!registerAfterCommit(notifySubmitted)) void notifySubmitted();

    this.audit.log({
      action: "payroll.run_approval_submitted",
      userId,
      orgId,
      actorMembershipId: submitterActor.membershipId,
      targetId: String(runId),
      targetType: "payroll_run",
      requestId: requestId ?? null,
      metadata: { runId, autoApproved: false, stagesCreated: chain.length },
    });

    return submitResult;
  }

  async listApprovals(orgId: string, runId: number, userId: string) {
    const run = await this.db
      .select({ id: payrollRuns.id })
      .from(payrollRuns)
      .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)))
      .limit(1);

    if (!run[0]) throw new NotFoundException(`Payroll run ${runId} not found`);

    const rows = await this.db
      .select()
      .from(payrollApprovals)
      .where(and(eq(payrollApprovals.runId, runId), eq(payrollApprovals.orgId, orgId)))
      .orderBy(asc(payrollApprovals.stage));

    const nextPendingId = rows.find((r) => r.status === "PENDING")?.id;

    const memberRow = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.userId, userId), eq(organizationMembers.orgId, orgId)),
      columns: { isOwner: true },
    });
    const isOrgOwner = memberRow?.isOwner === true;
    const perms = isOrgOwner ? null : await this.access.resolveUserPermissions(orgId, userId);

    return rows.map((row) => {
      const isNextStage = row.id === nextPendingId;
      const hasPermission = isOrgOwner || (perms?.has(row.requiredPermission) ?? false);
      return {
        ...row,
        isCurrentUserApprover: isNextStage && hasPermission,
        approverName: row.stageName,
      };
    });
  }

  async approveStage(
    orgId: string,
    userId: string,
    runId: number,
    approvalId: number,
    comment?: string,
    requestId?: string | null,
  ) {
    return this.actions.approveStage(orgId, userId, runId, approvalId, comment, requestId);
  }

  async rejectStage(
    orgId: string,
    userId: string,
    runId: number,
    approvalId: number,
    comment: string,
    requestId?: string | null,
  ) {
    return this.actions.rejectStage(orgId, userId, runId, approvalId, comment, requestId);
  }
}
