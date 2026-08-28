import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import {
  hrEmployments,
  hrPeople,
  resignations,
  users,
  organizations,
  organizationMembers,
} from "../../../db/schema";
import { EmploymentFactsService } from "../../directory/employment-facts.service";
import { livePersonOfUser, primaryEmploymentOfPerson } from "../../directory/employment-query";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { formatDdMmmYyyy, formatDdMmmYyyyTime, subMonths } from "../../../common/date";
import { generateResignationLetter } from "./letters";
import type { ListResignationsQueryInput } from "./dto/hr-lifecycle.schemas";
import { transitionResignation } from "./lifecycle-transition";

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
  finalReviewedAt: Date | null;
  finalRemarks: string | null;
  hrReviewer?: { name: string | null } | null;
  finalReviewer?: { name: string | null } | null;
}

function protectResignationFile<T extends { resignationLetterUrl: string | null }>(
  record: T,
): Omit<T, "resignationLetterUrl"> & { hasResignationLetter: boolean } {
  const { resignationLetterUrl, ...safeRecord } = record;
  return {
    ...safeRecord,
    hasResignationLetter: Boolean(resignationLetterUrl),
  };
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
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly employment: EmploymentFactsService,
  ) {}

  async list(orgId: string, userId: string, isAdmin: boolean, params: ListResignationsQueryInput) {
    const limit = Math.min(params.limit, 100);
    const offset = (params.page - 1) * limit;
    const conditions = [eq(resignations.orgId, orgId)];
    if (!isAdmin) conditions.push(eq(resignations.userId, userId));
    if (params.status) conditions.push(eq(resignations.status, params.status));
    const where = and(...conditions);

    const [data, countRows] = await Promise.all([
      this.db.query.resignations.findMany({
        where,
        with: {
          user: { columns: { id: true, name: true, email: true, image: true } },
          checklists: true,
          hrReviewer: { columns: { id: true, name: true } },
          finalReviewer: { columns: { id: true, name: true } },
        },
        orderBy: [desc(resignations.createdAt)],
        limit,
        offset,
      }),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(resignations)
        .where(where),
    ]);

    const total = countRows[0]?.total ?? 0;
    const userIds = data.flatMap((r) => (r.user ? [r.user.id] : []));
    const factsMap = userIds.length > 0 ? await this.employment.getFactsBatch(orgId, userIds) : new Map();

    return {
      data: data.map((r) => {
        const facts = r.user ? factsMap.get(r.user.id) : undefined;
        return protectResignationFile({
          ...r,
          user: r.user
            ? { ...r.user, designation: facts?.designation ?? null, joiningDate: facts?.joiningDate ?? null }
            : r.user,
        });
      }),
      pagination: { page: params.page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getDetail(orgId: string, userId: string, isAdmin: boolean, resignationId: number) {
    const data = await this.db.query.resignations.findFirst({
      where: and(eq(resignations.id, resignationId), eq(resignations.orgId, orgId)),
      with: {
        user: { columns: { id: true, name: true, email: true, image: true } },
        checklists: true,
        hrReviewer: { columns: { id: true, name: true } },
        finalReviewer: { columns: { id: true, name: true } },
      },
    });
    if (!data) throw new NotFoundException("Resignation not found.");

    if (!isAdmin && data.userId !== userId) {
      throw new ForbiddenException("Forbidden");
    }

    const facts = data.user ? await this.employment.getFacts(orgId, data.user.id) : undefined;
    const enrichedUser = data.user
      ? { ...data.user, designation: facts?.designation ?? null, joiningDate: facts?.joiningDate ?? null }
      : data.user;

    return {
      ...protectResignationFile({ ...data, user: enrichedUser }),
      progress: this.buildTimeline(data),
    };
  }

  async getFileReference(
    orgId: string,
    userId: string,
    isAdmin: boolean,
    resignationId: number,
  ): Promise<{ id: number; fileUrl: string }> {
    const record = await this.db.query.resignations.findFirst({
      where: and(eq(resignations.id, resignationId), eq(resignations.orgId, orgId)),
      columns: { id: true, userId: true, resignationLetterUrl: true },
    });
    if (!record?.resignationLetterUrl) {
      throw new NotFoundException("Resignation letter not found.");
    }
    if (!isAdmin && record.userId !== userId) {
      throw new ForbiddenException("Forbidden");
    }
    return { id: record.id, fileUrl: record.resignationLetterUrl };
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
        label: "Final Review",
        status: this.stepStatus(record, "FINAL"),
        actor: record.finalReviewer?.name ?? null,
        timestamp: record.finalReviewedAt,
        remarks: record.finalRemarks,
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

  private stepStatus(record: TimelineRecord, reviewer: "HR" | "FINAL"): StepStatus {
    const status = record.status ?? "";
    if (status === "REJECTED") {
      if (reviewer === "HR" && record.hrReviewedAt && !record.finalReviewedAt) return "rejected";
      if (reviewer === "FINAL" && record.finalReviewedAt) return "rejected";
    }
    if (reviewer === "HR") {
      if (["HR_APPROVED", "FINAL_APPROVED", "IN_PROGRESS", "COMPLETED"].includes(status)) return "completed";
      if (["PENDING_HR", "SUBMITTED"].includes(status)) return "active";
    }
    if (reviewer === "FINAL") {
      if (["FINAL_APPROVED", "IN_PROGRESS", "COMPLETED"].includes(status)) return "completed";
      if (status === "HR_APPROVED") return "active";
    }
    return "pending";
  }

  async getLetter(orgId: string, userId: string, isAdmin: boolean, resignationId: number) {
    const resignation = await this.db.query.resignations.findFirst({
      where: and(eq(resignations.id, resignationId), eq(resignations.orgId, orgId)),
      with: { user: { columns: { id: true, name: true } } },
    });
    if (!resignation) throw new NotFoundException("Resignation not found.");

    if (!isAdmin && resignation.userId !== userId) {
      throw new ForbiddenException("Forbidden");
    }

    const [org, facts] = await Promise.all([
      this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId) }),
      resignation.user ? this.employment.getFacts(orgId, resignation.user.id) : Promise.resolve(undefined),
    ]);

    const employee = resignation.user;
    const letterHtml = generateResignationLetter({
      employeeName: employee?.name ?? "Employee",
      designation: facts?.designation ?? "N/A",
      department: null,
      joiningDate: facts?.joiningDate ? formatDdMmmYyyy(facts.joiningDate) : "N/A",
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
        finalReviewer: { columns: { name: true } },
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
        status: record.status === "REJECTED" && !record.finalReviewedAt ? "rejected" : "completed",
        actor: record.hrReviewer?.name ?? "HR",
        timestamp: formatDdMmmYyyyTime(record.hrReviewedAt),
        remarks: record.hrRemarks ?? undefined,
      });
    } else if (record.status === "PENDING_HR" || record.status === "SUBMITTED") {
      steps.push({ label: "HR Review", status: "active" });
    } else {
      steps.push({ label: "HR Review", status: "pending" });
    }

    if (record.finalReviewedAt) {
      steps.push({
        label: "FINAL Approval",
        status: record.status === "REJECTED" ? "rejected" : "completed",
        actor: record.finalReviewer?.name ?? "FINAL",
        timestamp: formatDdMmmYyyyTime(record.finalReviewedAt),
        remarks: record.finalRemarks ?? undefined,
      });
    } else if (record.status === "HR_APPROVED") {
      steps.push({ label: "FINAL Approval", status: "active" });
    } else {
      steps.push({ label: "FINAL Approval", status: "pending" });
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

    const nonWithdrawableStatuses = ["FINAL_APPROVED", "IN_PROGRESS", "COMPLETED", "WITHDRAWN"];
    if (nonWithdrawableStatuses.includes(record.status ?? "")) {
      throw new BadRequestException("Resignation cannot be withdrawn at this stage.");
    }

    await transitionResignation(this.db, {
      organizationId: orgId,
      resignationId,
      currentStatus: record.status,
      currentVersion: record.rowVersion,
      changes: { status: "WITHDRAWN" },
    });

    return { success: true };
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
            EXTRACT(EPOCH FROM (${resignations.createdAt} - ${hrEmployments.joiningDate}::timestamp)) / 2592000
          )::int
        `,
      })
      .from(resignations)
      .innerJoin(users, eq(resignations.userId, users.id))
      .innerJoin(hrPeople, livePersonOfUser(orgId, users.id))
      .innerJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
      .where(and(eq(resignations.orgId, orgId), isNotNull(hrEmployments.joiningDate)));

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
