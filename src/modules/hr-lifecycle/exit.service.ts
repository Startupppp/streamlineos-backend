import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import {
  resignations,
  exitChecklists,
  fnfSettlements,
  users,
  organizations,
  organizationMembers,
  richDocuments,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { EmailService } from "../email/email.service";
import { AutomationService } from "../automation/automation.service";
import { formatDdMmmYyyy, formatDdMmmYyyyTime, formatLongInIN, subMonths } from "./date.helpers";
import { generateResignationLetter, buildExperienceLetterContent } from "./letters";
import type {
  ExperienceLetterInput,
  ResignationCreateInput,
  ResignationUpdateInput,
  ResignationCeoReviewInput,
} from "./dto/hr-lifecycle.schemas";

export interface ExitActor {
  userId: string;
  role: string;
  isApprover: boolean;
}

type StepStatus = "completed" | "active" | "pending" | "rejected";

export interface ProgressStep {
  label: string;
  status: StepStatus;
  actor?: string;
  timestamp?: string;
  remarks?: string;
}

@Injectable()
export class ExitService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
    private readonly automation: AutomationService,
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

      this.dispatchResignationApproved(actor.userId, existing.userId, existing.lastWorkingDate, existing.noticePeriodDays, existing.createdAt);
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

  async getLetter(orgId: string, userId: string, isAdmin: boolean, resignationId: number) {
    const resignation = await this.db.query.resignations.findFirst({
      where: and(eq(resignations.id, resignationId), eq(resignations.orgId, orgId)),
      with: { user: true },
    });
    if (!resignation) throw new NotFoundException("Resignation not found.");

    if (!isAdmin && resignation.userId !== userId) {
      throw new ForbiddenException("Forbidden");
    }

    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
    });

    const employee = resignation.user;
    const letterHtml = generateResignationLetter({
      employeeName: employee?.name ?? "Employee",
      designation: employee?.designation ?? "N/A",
      department: null,
      joiningDate: employee?.joiningDate ? formatDdMmmYyyy(employee.joiningDate) : "N/A",
      date: formatDdMmmYyyy(resignation.createdAt ?? new Date()),
      reason: resignation.reason ?? "",
      reasonCategory: resignation.reasonCategory ?? "",
      lastWorkingDate: resignation.lastWorkingDate ? formatDdMmmYyyy(resignation.lastWorkingDate) : "N/A",
      companyName: org?.name ?? "the Company",
    });

    return { html: letterHtml };
  }

  async getProgress(orgId: string, userId: string, isAdmin: boolean, resignationId: number) {
    const record = await this.db.query.resignations.findFirst({
      where: and(eq(resignations.id, resignationId), eq(resignations.orgId, orgId)),
    });
    if (!record) throw new NotFoundException("Not found.");

    if (!isAdmin && record.userId !== userId) {
      throw new ForbiddenException("Access denied.");
    }

    const steps: ProgressStep[] = [];

    const isRejected = record.status === "REJECTED";
    const isWithdrawn = record.status === "WITHDRAWN";

    steps.push({
      label: "Submitted",
      status: "completed",
      timestamp: record.createdAt ? formatDdMmmYyyyTime(record.createdAt) : undefined,
    });

    if (record.hrReviewedAt) {
      const hrUser = record.hrReviewedBy
        ? await this.db.query.users.findFirst({ where: eq(users.id, record.hrReviewedBy) })
        : null;
      steps.push({
        label: "HR Review",
        status: record.status === "REJECTED" && !record.ceoReviewedAt ? "rejected" : "completed",
        actor: hrUser?.name ?? "HR",
        timestamp: formatDdMmmYyyyTime(record.hrReviewedAt),
        remarks: record.hrRemarks ?? undefined,
      });
    } else if (record.status === "PENDING_HR" || record.status === "SUBMITTED") {
      steps.push({ label: "HR Review", status: "active" });
    } else {
      steps.push({ label: "HR Review", status: "pending" });
    }

    if (record.ceoReviewedAt) {
      const ceoUser = record.ceoReviewedBy
        ? await this.db.query.users.findFirst({ where: eq(users.id, record.ceoReviewedBy) })
        : null;
      steps.push({
        label: "CEO Approval",
        status: record.status === "REJECTED" ? "rejected" : "completed",
        actor: ceoUser?.name ?? "CEO",
        timestamp: formatDdMmmYyyyTime(record.ceoReviewedAt),
        remarks: record.ceoRemarks ?? undefined,
      });
    } else if (record.status === "HR_APPROVED") {
      steps.push({ label: "CEO Approval", status: "active" });
    } else {
      steps.push({ label: "CEO Approval", status: "pending" });
    }

    steps.push({
      label: "Exit Process",
      status: record.status === "IN_PROGRESS" || record.status === "COMPLETED" ? "completed" : "pending",
    });

    steps.push({
      label: "Completed",
      status: record.status === "COMPLETED" ? "completed" : "pending",
    });

    return {
      id: record.id,
      status: record.status,
      isRejected,
      isWithdrawn,
      steps,
      lastWorkingDate: record.lastWorkingDate,
      reasonCategory: record.reasonCategory,
    };
  }

  async withdraw(orgId: string, userId: string, isAdmin: boolean, resignationId: number) {
    const record = await this.db.query.resignations.findFirst({
      where: and(eq(resignations.id, resignationId), eq(resignations.orgId, orgId)),
    });
    if (!record) throw new NotFoundException("Resignation not found.");

    if (!isAdmin && record.userId !== userId) {
      throw new ForbiddenException("You can only withdraw your own resignation.");
    }

    const nonWithdrawableStatuses = ["CEO_APPROVED", "IN_PROGRESS", "COMPLETED", "WITHDRAWN"];
    if (nonWithdrawableStatuses.includes(record.status ?? "")) {
      throw new BadRequestException("Resignation cannot be withdrawn at this stage.");
    }

    await this.db
      .update(resignations)
      .set({ status: "WITHDRAWN", updatedAt: new Date() })
      .where(eq(resignations.id, resignationId));

    return { success: true };
  }

  async createExperienceLetter(orgId: string, actorUserId: string, input: ExperienceLetterInput) {
    const employee = await this.db.query.users.findFirst({
      where: eq(users.id, input.userId),
    });
    if (!employee) throw new NotFoundException("Employee not found.");

    const name =
      `${employee.firstName ?? ""} ${employee.lastName ?? ""}`.trim() || employee.name || "Employee";
    const joiningDate = employee.joiningDate ? formatLongInIN(employee.joiningDate) : "N/A";
    const relievingDate = formatLongInIN(input.relievingDate);

    const content = buildExperienceLetterContent({
      name,
      joiningDate,
      relievingDate,
      designation: employee.designation ?? "a team member",
      role: employee.role,
    });

    const [doc] = await this.db
      .insert(richDocuments)
      .values({
        orgId,
        title: `Experience Certificate - ${name}`,
        contentJson: content,
        templateType: "experience_letter",
        isPublished: false,
        version: 1,
        createdBy: actorUserId,
      })
      .returning();

    return { documentId: doc.id, title: doc.title };
  }

  async getAnalytics(orgId: string) {
    const [totalEmp] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true)));

    const reasonBreakdown = await this.db
      .select({
        category: resignations.reasonCategory,
        count: sql<number>`count(*)::int`,
      })
      .from(resignations)
      .where(eq(resignations.orgId, orgId))
      .groupBy(resignations.reasonCategory);

    const twelveMonthsAgo = subMonths(new Date(), 12);
    const monthlyTrend = await this.db
      .select({
        month: sql<string>`to_char(${resignations.createdAt}, 'YYYY-MM')`,
        count: sql<number>`count(*)::int`,
      })
      .from(resignations)
      .where(and(eq(resignations.orgId, orgId), gte(resignations.createdAt, twelveMonthsAgo)))
      .groupBy(sql`to_char(${resignations.createdAt}, 'YYYY-MM')`)
      .orderBy(sql`to_char(${resignations.createdAt}, 'YYYY-MM')`);

    const avgTenure = await this.db
      .select({
        avgMonths: sql<number>`
          AVG(
            EXTRACT(EPOCH FROM (${resignations.createdAt} - ${users.joiningDate}::timestamp)) / 2592000
          )::int
        `,
      })
      .from(resignations)
      .innerJoin(users, eq(resignations.userId, users.id))
      .where(and(eq(resignations.orgId, orgId), sql`${users.joiningDate} IS NOT NULL`));

    const statusCounts = await this.db
      .select({
        status: resignations.status,
        count: sql<number>`count(*)::int`,
      })
      .from(resignations)
      .where(eq(resignations.orgId, orgId))
      .groupBy(resignations.status);

    const totalEmployees = totalEmp?.count ?? 0;
    const totalResignations = statusCounts.reduce((acc, s) => acc + s.count, 0);
    const attritionRate = totalEmployees > 0 ? Math.round((totalResignations / totalEmployees) * 100) : 0;

    return {
      totalEmployees,
      totalResignations,
      attritionRate,
      averageTenureMonths: avgTenure[0]?.avgMonths ?? 0,
      reasonBreakdown: reasonBreakdown.map((r) => ({
        category: r.category ?? "Uncategorized",
        count: r.count,
      })),
      monthlyTrend: monthlyTrend.map((m) => ({
        month: m.month,
        count: m.count,
      })),
      statusCounts: Object.fromEntries(statusCounts.map((s) => [s.status, s.count])),
    };
  }
}
