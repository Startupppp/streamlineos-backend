import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import {
  resignations,
  exitChecklists,
  fnfSettlements,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { EmailService } from "../../email/email.service";
import { AutomationService } from "../../automation/automation.service";
import { HrAutomationEngineService } from "../automations/hr-automation-engine.service";
import { ResignationJobsService } from "./resignation-jobs.service";
import { ExitChecklistService } from "./exit-checklist.service";
import { HrPolicyEvaluationService } from "../policies/hr-policy-evaluation.service";
import { AssetsRecoveryService } from "../directory/assets-recovery.service";
import { HrAuditService } from "../core/hr-audit.service";
import { IdentityService } from "../enterprise-ops/identity/identity.service";
import { AccessService } from "../../access/access.service";
import { formatDdMmmYyyy } from "../../../common/date";
import type {
  ResignationCreateInput,
  ResignationUpdateInput,
  ResignationFinalReviewInput,
  ResignationHrReviewInput,
} from "./dto/hr-lifecycle.schemas";

export interface ExitActor {
  userId: string;
  role: string;
  isApprover: boolean;
}

@Injectable()
export class ExitWriteService {
  private readonly logger = new Logger(ExitWriteService.name);
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
    private readonly automation: AutomationService,
    private readonly hrAutomation: HrAutomationEngineService,
    private readonly resignationJobs: ResignationJobsService,
    private readonly exitChecklist: ExitChecklistService,
    private readonly policyEval: HrPolicyEvaluationService,
    private readonly assetsRecovery: AssetsRecoveryService,
    private readonly hrAudit: HrAuditService,
    private readonly identity: IdentityService,
    private readonly access: AccessService,
  ) {}

  private async resolveNoticePeriod(orgId: string, userId: string, fallbackDays: number): Promise<number> {
    const result = await this.policyEval.evaluatePolicy(orgId, userId, "notice_period", new Date().toISOString().slice(0, 10)).catch(() => null);
    if (!result) return fallbackDays;
    const rules = result.rules as Record<string, unknown>;
    const permanentDays = typeof rules["permanentDays"] === "number" ? rules["permanentDays"] : null;
    return permanentDays ?? fallbackDays;
  }

  async create(orgId: string, actorUserId: string, input: ResignationCreateInput) {
    const existing = await this.db.query.resignations.findFirst({
      where: and(
        eq(resignations.orgId, orgId),
        eq(resignations.userId, actorUserId),
        inArray(resignations.status, ["SUBMITTED", "PENDING_HR", "HR_APPROVED"]),
      ),
      columns: { id: true },
    });
    if (existing) {
      throw new ConflictException("You already have an active resignation request pending approval.");
    }

    const noticePeriodDays = await this.resolveNoticePeriod(orgId, actorUserId, input.noticePeriodDays ?? 30);

    const [resignation] = await this.db
      .insert(resignations)
      .values({
        orgId,
        userId: actorUserId,
        reason: input.reason,
        reasonCategory: input.reasonCategory,
        lastWorkingDate: input.lastWorkingDate,
        noticePeriodDays,
        willingForExitInterview: input.willingForExitInterview,
        companyFeedback: input.companyFeedback || null,
        resignationLetterUrl: input.resignationLetterUrl ?? null,
        status: "PENDING_HR",
      })
      .returning();

    this.dispatchResignationSubmitted(orgId, actorUserId, resignation.id, input, noticePeriodDays);
    this.resignationJobs.notifyResignationSubmitted(orgId, actorUserId);

    return resignation;
  }

  async update(orgId: string, actor: ExitActor, resignationId: number, input: ResignationUpdateInput) {
    const existing = await this.db.query.resignations.findFirst({
      where: and(eq(resignations.id, resignationId), eq(resignations.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Resignation not found.");

    if (input.status === "HR_APPROVED") {
      if (!actor.isApprover) throw new ForbiddenException("Only HR admins can perform HR review.");
      if (existing.status !== "PENDING_HR" && existing.status !== "SUBMITTED") {
        throw new BadRequestException("Resignation is not pending HR review.");
      }
      await this.db
        .update(resignations)
        .set({
          status: "HR_APPROVED",
          hrReviewedBy: actor.userId,
          hrReviewedAt: new Date(),
          hrRemarks: input.remarks || null,
          updatedAt: new Date(),
        })
        .where(eq(resignations.id, resignationId));
      this.resignationJobs.notifyHrApproved(orgId, existing.userId);
      return { success: true };
    }

    if (input.status === "FINAL_APPROVED") {
      if (!actor.isApprover) throw new ForbiddenException("Only approvers can approve at this stage.");
      if (existing.status !== "HR_APPROVED") {
        throw new BadRequestException("Resignation must be HR-approved first.");
      }
      await this.db.transaction(async (tx) => {
        await tx
          .update(resignations)
          .set({
            status: "FINAL_APPROVED",
            finalReviewedBy: actor.userId,
            finalReviewedAt: new Date(),
            finalRemarks: input.remarks || null,
            approvedBy: actor.userId,
            approvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(resignations.id, resignationId));

        await tx
          .insert(fnfSettlements)
          .values({ orgId, userId: existing.userId, resignationId, status: "DRAFT" })
          .onConflictDoNothing();
      });

      void this.exitChecklist.seedChecklistFromTemplate(orgId, resignationId).catch(() => undefined);

      this.dispatchResignationApproved(
        actor.userId,
        existing.userId,
        existing.lastWorkingDate,
        existing.noticePeriodDays,
        existing.createdAt,
      );
      return { success: true };
    }

    if (input.status === "REJECTED") {
      if (!actor.isApprover) throw new ForbiddenException("Only admins can reject.");
      if (!input.remarks) throw new BadRequestException("Remarks are required when rejecting.");
      const reviewFields = actor.isApprover
        ? { hrReviewedBy: actor.userId, hrReviewedAt: new Date(), hrRemarks: input.remarks }
        : { finalReviewedBy: actor.userId, finalReviewedAt: new Date(), finalRemarks: input.remarks };
      await this.db
        .update(resignations)
        .set({ status: "REJECTED", updatedAt: new Date(), ...reviewFields })
        .where(eq(resignations.id, resignationId));
      return { success: true };
    }

    if (input.status === "WITHDRAWN") {
      if (existing.userId !== actor.userId) throw new ForbiddenException("Only the employee can withdraw.");
      if (existing.status === "FINAL_APPROVED" || existing.status === "COMPLETED" || existing.status === "IN_PROGRESS") {
        throw new BadRequestException("Cannot withdraw after FINAL approval.");
      }
      await this.db
        .update(resignations)
        .set({ status: "WITHDRAWN", updatedAt: new Date() })
        .where(eq(resignations.id, resignationId));
      return { success: true };
    }

    if (input.status === "COMPLETED") {
      if (!actor.isApprover) throw new ForbiddenException("Only admins can complete.");
      const hasPendingRecovery = await this.assetsRecovery
        .hasPendingRecovery(orgId, existing.userId)
        .catch(() => false);
      if (hasPendingRecovery) {
        if (!input.overrideAssetGate) {
          throw new BadRequestException(
            "Asset recovery is pending for this employee. Recover all assigned assets or complete with an override reason.",
          );
        }
        if (!input.overrideReason) {
          throw new BadRequestException("An override reason is required to bypass pending asset recovery.");
        }
        await this.hrAudit.log({
          orgId,
          actorId: actor.userId,
          entityType: "resignations",
          entityId: String(resignationId),
          action: "asset_gate_overridden",
          after: { reason: input.overrideReason },
        });
      }
      const hasUnverifiedRevokes = await this.identity
        .hasUnverifiedRevokes(orgId, existing.userId)
        .catch(() => false);
      if (hasUnverifiedRevokes) {
        if (!input.overrideAssetGate) {
          throw new BadRequestException(
            "Access removal is not verified for this employee. Verify all revocations or complete with an override reason.",
          );
        }
        if (!input.overrideReason) {
          throw new BadRequestException("An override reason is required to bypass unverified access removal.");
        }
        await this.hrAudit.log({
          orgId,
          actorId: actor.userId,
          entityType: "resignations",
          entityId: String(resignationId),
          action: "access_gate_overridden",
          after: { reason: input.overrideReason },
        });
      }
      await this.db
        .update(resignations)
        .set({ status: "COMPLETED", updatedAt: new Date() })
        .where(eq(resignations.id, resignationId));

      this.dispatchExitCompleted(orgId, resignationId, existing.userId);
      return { success: true };
    }

    await this.db
      .update(resignations)
      .set({
        ...(input.exitInterviewNotes && { exitInterviewNotes: input.exitInterviewNotes }),
        ...(input.exitInterviewDate && {
          exitInterviewDate: new Date(input.exitInterviewDate),
          exitInterviewConductedBy: actor.userId,
        }),
        ...(input.feedback && { feedback: input.feedback }),
        updatedAt: new Date(),
      })
      .where(eq(resignations.id, resignationId));

    if (input.checklistItems?.length) {
      await this.db.insert(exitChecklists).values(
        input.checklistItems.map((item) => ({
          orgId,
          resignationId,
          item,
          status: "PENDING" as const,
        })),
      );
    }

    return { success: true };
  }

  async hrReview(orgId: string, actorUserId: string, resignationId: number, input: ResignationHrReviewInput) {
    if (input.decision === "reject" && !input.remarks) {
      throw new BadRequestException("Remarks required for rejection.");
    }

    const record = await this.db.query.resignations.findFirst({
      where: and(eq(resignations.id, resignationId), eq(resignations.orgId, orgId)),
    });
    if (!record) throw new NotFoundException("Resignation not found.");
    if (record.status !== "PENDING_HR" && record.status !== "SUBMITTED") {
      throw new BadRequestException("Resignation is not pending HR review.");
    }

    const approved = input.decision === "approve";

    await this.db
      .update(resignations)
      .set({
        status: approved ? "HR_APPROVED" : "REJECTED",
        hrReviewedBy: actorUserId,
        hrReviewedAt: new Date(),
        hrRemarks: input.remarks ?? null,
        updatedAt: new Date(),
      })
      .where(eq(resignations.id, resignationId));

    if (approved) this.resignationJobs.notifyHrApproved(orgId, record.userId);

    return { success: true };
  }

  async finalReview(orgId: string, actorUserId: string, resignationId: number, input: ResignationFinalReviewInput) {
    if (input.decision === "reject" && !input.remarks) {
      throw new BadRequestException("Remarks required for rejection.");
    }

    const record = await this.db.query.resignations.findFirst({
      where: and(eq(resignations.id, resignationId), eq(resignations.orgId, orgId)),
    });
    if (!record) throw new NotFoundException("Resignation not found.");
    if (record.status !== "HR_APPROVED") throw new BadRequestException("Resignation must be HR-approved first.");

    const approved = input.decision === "approve";

    await this.db
      .update(resignations)
      .set({
        status: approved ? "FINAL_APPROVED" : "REJECTED",
        finalReviewedBy: actorUserId,
        finalReviewedAt: new Date(),
        finalRemarks: input.remarks,
        updatedAt: new Date(),
      })
      .where(eq(resignations.id, resignationId));

    this.resignationJobs.notifyFinalDecision(orgId, record.userId, approved);

    if (approved) {
      await this.db
        .insert(fnfSettlements)
        .values({ orgId, userId: record.userId, resignationId, status: "DRAFT" })
        .onConflictDoNothing();

      void this.exitChecklist.seedChecklistFromTemplate(orgId, resignationId).catch(() => undefined);

      this.dispatchResignationApprovedAutomation(orgId, resignationId, record.userId, record.lastWorkingDate, actorUserId);
    }

    return { success: true };
  }

  private dispatchResignationSubmitted(
    orgId: string,
    actorUserId: string,
    resignationId: number,
    input: ResignationCreateInput,
    noticePeriodDays: number,
  ): void {
    void (async () => {
      const adminMembers = await this.access.membersWithPermission(orgId, "hr:exit:manage");

      const submittingUser = await this.db.query.users.findFirst({
        where: eq(users.id, actorUserId),
        columns: { email: true, name: true, designation: true },
      });

      const adminUserIds = adminMembers.map((m) => m.userId);
      const adminUsers = adminUserIds.length
        ? await this.db
            .select({ email: users.email, name: users.name })
            .from(users)
            .where(inArray(users.id, adminUserIds))
        : [];

      const submissionDate = formatDdMmmYyyy(new Date());
      const lastWorkingDate = formatDdMmmYyyy(new Date(input.lastWorkingDate));

      for (const admin of adminUsers) {
        if (admin.email && admin.email !== submittingUser?.email) {
          try {
            await this.email.sendResignationSubmittedEmail(
              admin.email,
              admin.name ?? "HR",
              submittingUser?.name ?? "Employee",
              submittingUser?.designation ?? "N/A",
              submissionDate,
              lastWorkingDate,
              noticePeriodDays,
              input.reason,
            );
          } catch (err) {
            this.logger.warn(`Resignation notification email failed for admin ${admin.email}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      await this.hrAutomation.emit(orgId, "resignation.submitted", {
        resignationId,
        userId: actorUserId,
        employeeName: submittingUser?.name ?? "Employee",
        employeeEmail: submittingUser?.email ?? "",
        lastWorkingDate: input.lastWorkingDate,
        noticePeriodDays,
        reasonCategory: input.reasonCategory ?? null,
        submittedAt: new Date().toISOString(),
      });

      await this.automation.runAutomationsForEvent(orgId, "resignation.submitted", {
        resignationId,
        userId: actorUserId,
        employeeName: submittingUser?.name ?? "Employee",
        employeeEmail: submittingUser?.email ?? "",
        lastWorkingDate: input.lastWorkingDate,
        noticePeriodDays,
        reasonCategory: input.reasonCategory ?? null,
        submittedAt: new Date().toISOString(),
      });
    })().catch(() => undefined);
  }

  private dispatchResignationApproved(
    actorUserId: string,
    employeeId: string,
    lastWorkingDate: string | null,
    noticePeriodDays: number,
    submittedAt: Date | null,
  ): void {
    void (async () => {
      const [employee, approver] = await Promise.all([
        this.db.query.users.findFirst({ where: eq(users.id, employeeId), columns: { email: true, name: true } }),
        this.db.query.users.findFirst({ where: eq(users.id, actorUserId), columns: { name: true } }),
      ]);
      if (!employee?.email) return;
      const lwd = lastWorkingDate ? new Date(lastWorkingDate) : new Date();
      const sub = submittedAt ?? new Date();
      await this.email.sendResignationApprovedEmail(
        employee.email,
        employee.name ?? "Employee",
        approver?.name ?? "Approver",
        formatDdMmmYyyy(lwd),
        noticePeriodDays ?? 30,
        formatDdMmmYyyy(sub),
      );
    })().catch(() => undefined);
  }

  private dispatchResignationApprovedAutomation(
    orgId: string,
    resignationId: number,
    employeeId: string,
    lastWorkingDate: string | null,
    actorUserId: string,
  ): void {
    void (async () => {
      const employee = await this.db.query.users.findFirst({
        where: eq(users.id, employeeId),
        columns: { name: true },
      });
      await this.automation.runAutomationsForEvent(orgId, "resignation.approved", {
        resignationId,
        userId: employeeId,
        employeeName: employee?.name ?? "Employee",
        lastWorkingDate,
        approvedBy: actorUserId,
        approvedAt: new Date().toISOString(),
      });
    })().catch(() => undefined);
  }

  private dispatchExitCompleted(orgId: string, resignationId: number, employeeId: string): void {
    void (async () => {
      const employee = await this.db.query.users.findFirst({
        where: eq(users.id, employeeId),
        columns: { name: true },
      });
      await this.hrAutomation.emit(orgId, "exit.completed", {
        resignationId,
        userId: employeeId,
        employeeName: employee?.name ?? "Employee",
        exitType: "resignation",
        completedAt: new Date().toISOString(),
      });
      await this.hrAutomation.emit(orgId, "employee.exited", {
        employeeId,
        exitType: "resignation",
        resignationId,
      });
    })().catch(() => undefined);
  }
}
