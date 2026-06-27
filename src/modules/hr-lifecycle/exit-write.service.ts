import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import {
  resignations,
  exitChecklists,
  fnfSettlements,
  users,
  organizationMembers,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { EmailService } from "../email/email.service";
import { AutomationService } from "../automation/automation.service";
import { ResignationJobsService } from "./resignation-jobs.service";
import { formatDdMmmYyyy } from "./date.helpers";
import type {
  ResignationCreateInput,
  ResignationUpdateInput,
  ResignationCeoReviewInput,
} from "./dto/hr-lifecycle.schemas";

export interface ExitActor {
  userId: string;
  role: string;
  isApprover: boolean;
}

@Injectable()
export class ExitWriteService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
    private readonly automation: AutomationService,
    private readonly resignationJobs: ResignationJobsService,
  ) {}

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

    const [resignation] = await this.db
      .insert(resignations)
      .values({
        orgId,
        userId: actorUserId,
        reason: input.reason,
        reasonCategory: input.reasonCategory,
        lastWorkingDate: input.lastWorkingDate,
        noticePeriodDays: input.noticePeriodDays,
        willingForExitInterview: input.willingForExitInterview,
        companyFeedback: input.companyFeedback || null,
        resignationLetterUrl: input.resignationLetterUrl ?? null,
        status: "PENDING_HR",
      })
      .returning();

    this.dispatchResignationSubmitted(orgId, actorUserId, resignation.id, input);
    this.resignationJobs.notifyResignationSubmitted(orgId, actorUserId);

    return resignation;
  }

  async update(orgId: string, actor: ExitActor, resignationId: number, input: ResignationUpdateInput) {
    const existing = await this.db.query.resignations.findFirst({
      where: and(eq(resignations.id, resignationId), eq(resignations.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Resignation not found.");

    if (input.status === "HR_APPROVED") {
      if (actor.role !== "HR" && actor.role !== "CEO") {
        throw new ForbiddenException("Only HR can perform HR review.");
      }
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

    if (input.status === "CEO_APPROVED") {
      if (actor.role !== "CEO") throw new ForbiddenException("Only CEO can approve at this stage.");
      if (existing.status !== "HR_APPROVED") {
        throw new BadRequestException("Resignation must be HR-approved first.");
      }
      await this.db
        .update(resignations)
        .set({
          status: "CEO_APPROVED",
          ceoReviewedBy: actor.userId,
          ceoReviewedAt: new Date(),
          ceoRemarks: input.remarks || null,
          approvedBy: actor.userId,
          approvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(resignations.id, resignationId));

      await this.db
        .insert(fnfSettlements)
        .values({ orgId, userId: existing.userId, resignationId, status: "DRAFT" })
        .onConflictDoNothing();

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
      const reviewFields =
        actor.role === "HR"
          ? { hrReviewedBy: actor.userId, hrReviewedAt: new Date(), hrRemarks: input.remarks }
          : { ceoReviewedBy: actor.userId, ceoReviewedAt: new Date(), ceoRemarks: input.remarks };
      await this.db
        .update(resignations)
        .set({ status: "REJECTED", updatedAt: new Date(), ...reviewFields })
        .where(eq(resignations.id, resignationId));
      return { success: true };
    }

    if (input.status === "WITHDRAWN") {
      if (existing.userId !== actor.userId) throw new ForbiddenException("Only the employee can withdraw.");
      if (existing.status === "CEO_APPROVED" || existing.status === "COMPLETED" || existing.status === "IN_PROGRESS") {
        throw new BadRequestException("Cannot withdraw after CEO approval.");
      }
      await this.db
        .update(resignations)
        .set({ status: "WITHDRAWN", updatedAt: new Date() })
        .where(eq(resignations.id, resignationId));
      return { success: true };
    }

    if (input.status === "COMPLETED") {
      if (!actor.isApprover) throw new ForbiddenException("Only admins can complete.");
      await this.db
        .update(resignations)
        .set({ status: "COMPLETED", updatedAt: new Date() })
        .where(eq(resignations.id, resignationId));
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
          resignationId,
          item,
          status: "PENDING" as const,
        })),
      );
    }

    return { success: true };
  }

  async ceoReview(orgId: string, actorUserId: string, resignationId: number, input: ResignationCeoReviewInput) {
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
        status: approved ? "CEO_APPROVED" : "REJECTED",
        ceoReviewedBy: actorUserId,
        ceoReviewedAt: new Date(),
        ceoRemarks: input.remarks,
        updatedAt: new Date(),
      })
      .where(eq(resignations.id, resignationId));

    this.resignationJobs.notifyCeoDecision(orgId, record.userId, approved);

    if (approved) {
      this.dispatchResignationApprovedAutomation(orgId, resignationId, record.userId, record.lastWorkingDate, actorUserId);
    }

    return { success: true };
  }

  private dispatchResignationSubmitted(
    orgId: string,
    actorUserId: string,
    resignationId: number,
    input: ResignationCreateInput,
  ): void {
    void (async () => {
      const adminMembers = await this.db
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.role, ["CEO", "HR"])));

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
          this.email
            .sendResignationSubmittedEmail(
              admin.email,
              admin.name ?? "HR",
              submittingUser?.name ?? "Employee",
              submittingUser?.designation ?? "N/A",
              submissionDate,
              lastWorkingDate,
              input.noticePeriodDays,
              input.reason,
            )
            .catch(() => undefined);
        }
      }

      await this.automation.runAutomationsForEvent(orgId, "resignation.submitted", {
        resignationId,
        userId: actorUserId,
        employeeName: submittingUser?.name ?? "Employee",
        employeeEmail: submittingUser?.email ?? "",
        lastWorkingDate: input.lastWorkingDate,
        noticePeriodDays: input.noticePeriodDays,
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
        approver?.name ?? "CEO",
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
}
