import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, gte, lte, sql } from "drizzle-orm";
import {
  attendance,
  goals,
  helpdeskTickets,
  leaveRequests,
  organizationMembers,
  performanceReviews,
  users,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { attritionRiskPrompt, reviewDraftPrompt } from "../prompts/hr.prompts";
import {
  AttritionRiskSchema,
  ReviewDraftSchema,
  type AttritionRiskResult,
  type ReviewDraftResult,
} from "../dto/output.schemas";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { unwrapAiResult } from "./gateway-result.util";

@Injectable()
export class HrPerformanceAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
  ) {}

  async analyzeAttritionRisk(
    orgId: string,
    userId: string,
  ): Promise<AttritionRiskResult | null> {
    const ctx = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const [employee] = await tx
          .select({
            name: users.name,
            role: organizationMembers.role,
            createdAt: users.createdAt,
          })
          .from(users)
          .innerJoin(
            organizationMembers,
            and(
              eq(organizationMembers.userId, users.id),
              eq(organizationMembers.orgId, orgId),
            ),
          )
          .where(eq(users.id, userId));
        if (!employee) return null;

        const tenureMonths = employee.createdAt
          ? Math.floor(
              (Date.now() - new Date(employee.createdAt).getTime()) /
                (1000 * 60 * 60 * 24 * 30),
            )
          : 0;

        const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
        const ninetyDaysAgoStr = ninetyDaysAgo.toISOString().slice(0, 10);

        const [attRate, leaveCount, openTickets, lastReview, activeGoals] =
          await Promise.all([
            tx
              .select({
                total: count(),
                present: sql<number>`SUM(CASE WHEN status = 'PRESENT' THEN 1 ELSE 0 END)::int`,
              })
              .from(attendance)
              .where(
                and(
                  eq(attendance.orgId, orgId),
                  eq(attendance.userId, userId),
                  gte(attendance.date, ninetyDaysAgoStr),
                ),
              ),
            tx
              .select({
                total: sql<number>`COALESCE(SUM(GREATEST(${leaveRequests.endDate}::date - ${leaveRequests.startDate}::date + 1, 0)), 0)::int`,
              })
              .from(leaveRequests)
              .where(
                and(
                  eq(leaveRequests.orgId, orgId),
                  eq(leaveRequests.userId, userId),
                  gte(leaveRequests.startDate, ninetyDaysAgoStr),
                ),
              ),
            tx
              .select({ count: count() })
              .from(helpdeskTickets)
              .where(
                and(
                  eq(helpdeskTickets.orgId, orgId),
                  eq(helpdeskTickets.userId, userId),
                  sql`${helpdeskTickets.status} != 'DONE'`,
                ),
              ),
            tx
              .select({ rating: performanceReviews.overallRating })
              .from(performanceReviews)
              .where(
                and(
                  eq(performanceReviews.orgId, orgId),
                  eq(performanceReviews.userId, userId),
                ),
              )
              .orderBy(desc(performanceReviews.createdAt))
              .limit(1),
            tx
              .select({ count: count() })
              .from(goals)
              .where(
                and(
                  eq(goals.orgId, orgId),
                  eq(goals.userId, userId),
                  sql`${goals.status} IN ('IN_PROGRESS', 'NOT_STARTED')`,
                ),
              ),
          ]);

        return { employee, tenureMonths, attRate, leaveCount, openTickets, lastReview, activeGoals };
      },
      { orgId },
    );
    if (!ctx) return null;

    const { employee, tenureMonths, attRate, leaveCount, openTickets, lastReview, activeGoals } = ctx;

    const attendanceRate =
      attRate[0] && attRate[0].total > 0
        ? Math.round((Number(attRate[0].present) / attRate[0].total) * 100)
        : null;

    const prompt = attritionRiskPrompt({
      employeeName: employee.name ?? "Employee",
      role: employee.role,
      department: null,
      tenureMonths,
      attendanceRate,
      recentLeaveDays: Number(leaveCount[0]?.total ?? 0),
      openTickets: openTickets[0]?.count ?? 0,
      lastReviewRating: lastReview[0]?.rating
        ? Number(lastReview[0].rating)
        : null,
      lastPromotionMonths: null,
      hasGoals: (activeGoals[0]?.count ?? 0) > 0,
    });

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "hr.attrition-risk",
      prompt: {
        system: prompt.system,
        user: prompt.user,
        promptKey: "hr.attrition_risk",
        promptVersion: 1,
      },
      schema: AttritionRiskSchema,
      tier: "fast",
      maxTokens: 512,
      charge: true,
    });

    const data = unwrapAiResult(result);
    data.attritionRiskScore = Math.max(
      0,
      Math.min(100, Math.round(data.attritionRiskScore)),
    );
    return data;
  }

  async generateReview(
    orgId: string,
    userId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<ReviewDraftResult | null> {
    const ctx = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const [[employee], employeeGoals, attendanceData] = await Promise.all([
          tx
            .select({ name: users.name, role: organizationMembers.role })
            .from(users)
            .innerJoin(
              organizationMembers,
              and(
                eq(organizationMembers.userId, users.id),
                eq(organizationMembers.orgId, orgId),
              ),
            )
            .where(eq(users.id, userId)),
          tx
            .select({
              goal: goals.title,
              achieved: goals.status,
              progress: goals.progress,
            })
            .from(goals)
            .where(
              and(
                eq(goals.orgId, orgId),
                eq(goals.userId, userId),
                gte(goals.createdAt, new Date(periodStart)),
                lte(goals.createdAt, new Date(periodEnd)),
              ),
            )
            .limit(20),
          tx
            .select({
              total: count(),
              present: sql<number>`SUM(CASE WHEN status = 'PRESENT' THEN 1 ELSE 0 END)::int`,
            })
            .from(attendance)
            .where(
              and(
                eq(attendance.orgId, orgId),
                eq(attendance.userId, userId),
                gte(attendance.date, periodStart),
                lte(attendance.date, periodEnd),
              ),
            ),
        ]);
        if (!employee) return null;
        return { employee, employeeGoals, attendanceData };
      },
      { orgId },
    );
    if (!ctx) return null;

    const { employee, employeeGoals, attendanceData } = ctx;

    const attendanceRate =
      attendanceData[0] && attendanceData[0].total > 0
        ? Math.round(
            (Number(attendanceData[0].present) / attendanceData[0].total) * 100,
          )
        : null;

    const prompt = reviewDraftPrompt({
      employeeName: employee.name ?? "Employee",
      role: employee.role,
      department: null,
      periodStart,
      periodEnd,
      goals: employeeGoals.map((g) => ({
        goal: g.goal,
        achieved: g.achieved === "COMPLETED",
        progress: g.progress ?? 0,
      })),
      recentActivities: null,
      attendanceRate,
      managerNotes: null,
    });

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "hr.generate-review",
      prompt: {
        system: prompt.system,
        user: prompt.user,
        promptKey: "hr.review_draft",
        promptVersion: 1,
      },
      schema: ReviewDraftSchema,
      tier: "fast",
      maxTokens: 1536,
      charge: true,
    });

    const data = unwrapAiResult(result);
    data.overallRating = Math.max(1, Math.min(5, data.overallRating));
    data.ratings = data.ratings.map((r) => ({
      ...r,
      score: Math.max(1, Math.min(5, r.score)),
    }));
    return data;
  }
}
