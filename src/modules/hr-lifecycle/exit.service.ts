import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  resignations,
  users,
  organizations,
  organizationMembers,
  richDocuments,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { formatDdMmmYyyy, formatDdMmmYyyyTime, formatLongInIN, subMonths } from "./date.helpers";
import { generateResignationLetter, buildExperienceLetterContent } from "./letters";
import type { ExperienceLetterInput } from "./dto/hr-lifecycle.schemas";

type StepStatus = "completed" | "active" | "pending" | "rejected";

export interface ProgressStep {
  label: string;
  status: StepStatus;
  actor?: string;
  timestamp?: string;
  remarks?: string;
}

interface TimelineRecord {
  status: string | null;
  createdAt: Date | null;
  hrReviewedAt: Date | null;
  hrRemarks: string | null;
  ceoReviewedAt: Date | null;
  ceoRemarks: string | null;
  hrReviewer?: { name: string | null } | null;
  ceoReviewer?: { name: string | null } | null;
}

export interface TimelineStep {
  label: string;
  status: StepStatus;
  actor: string | null;
  timestamp: Date | null;
  remarks: string | null;
}

@Injectable()
export class ExitService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  list(orgId: string, userId: string, isAdmin: boolean) {
    const conditions = [eq(resignations.orgId, orgId)];
    if (!isAdmin) conditions.push(eq(resignations.userId, userId));
    return this.db.query.resignations.findMany({
      where: and(...conditions),
      with: { user: true, checklists: true, hrReviewer: true, ceoReviewer: true },
      orderBy: [desc(resignations.createdAt)],
      limit: 500,
    });
  }

  async getDetail(orgId: string, userId: string, isAdmin: boolean, resignationId: number) {
    const data = await this.db.query.resignations.findFirst({
      where: and(eq(resignations.id, resignationId), eq(resignations.orgId, orgId)),
      with: { user: true, checklists: true, hrReviewer: true, ceoReviewer: true },
    });
    if (!data) throw new NotFoundException("Resignation not found.");

    if (!isAdmin && data.userId !== userId) {
      throw new ForbiddenException("Forbidden");
    }

    return { ...data, progress: this.buildTimeline(data) };
  }

  private buildTimeline(record: TimelineRecord): TimelineStep[] {
    return [
      { label: "Submitted", status: "completed", actor: null, timestamp: record.createdAt, remarks: null },
      {
        label: "HR Review",
        status: this.stepStatus(record, "HR"),
        actor: record.hrReviewer?.name ?? null,
        timestamp: record.hrReviewedAt,
        remarks: record.hrRemarks,
      },
      {
        label: "CEO Review",
        status: this.stepStatus(record, "CEO"),
        actor: record.ceoReviewer?.name ?? null,
        timestamp: record.ceoReviewedAt,
        remarks: record.ceoRemarks,
      },
      {
        label: "Exit Process",
        status: ["IN_PROGRESS", "COMPLETED"].includes(record.status ?? "") ? "completed" : "pending",
        actor: null,
        timestamp: null,
        remarks: null,
      },
      {
        label: "Completed",
        status: record.status === "COMPLETED" ? "completed" : "pending",
        actor: null,
        timestamp: null,
        remarks: null,
      },
    ];
  }

  private stepStatus(record: TimelineRecord, reviewer: "HR" | "CEO"): StepStatus {
    const status = record.status ?? "";
    if (status === "REJECTED") {
      if (reviewer === "HR" && record.hrReviewedAt && !record.ceoReviewedAt) return "rejected";
      if (reviewer === "CEO" && record.ceoReviewedAt) return "rejected";
    }
    if (reviewer === "HR") {
      if (["HR_APPROVED", "CEO_APPROVED", "IN_PROGRESS", "COMPLETED"].includes(status)) return "completed";
      if (["PENDING_HR", "SUBMITTED"].includes(status)) return "active";
    }
    if (reviewer === "CEO") {
      if (["CEO_APPROVED", "IN_PROGRESS", "COMPLETED"].includes(status)) return "completed";
      if (status === "HR_APPROVED") return "active";
    }
    return "pending";
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
      with: {
        hrReviewer: { columns: { name: true } },
        ceoReviewer: { columns: { name: true } },
      },
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
      steps.push({
        label: "HR Review",
        status: record.status === "REJECTED" && !record.ceoReviewedAt ? "rejected" : "completed",
        actor: record.hrReviewer?.name ?? "HR",
        timestamp: formatDdMmmYyyyTime(record.hrReviewedAt),
        remarks: record.hrRemarks ?? undefined,
      });
    } else if (record.status === "PENDING_HR" || record.status === "SUBMITTED") {
      steps.push({ label: "HR Review", status: "active" });
    } else {
      steps.push({ label: "HR Review", status: "pending" });
    }

    if (record.ceoReviewedAt) {
      steps.push({
        label: "CEO Approval",
        status: record.status === "REJECTED" ? "rejected" : "completed",
        actor: record.ceoReviewer?.name ?? "CEO",
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
