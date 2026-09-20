import { Injectable, Inject } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  goals,
  helpdeskTickets,
  hrCases,
  onboardingTasks,
  performanceReviews,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import {
  defineTool,
  data,
  empty,
  type AskOsToolDefinition,
  type AskOsToolProvider,
} from "../registry/ask-os-tool.types";
import { AskOsTools } from "../registry/ask-os-tools.decorator";

const ONBOARDING_CAP = 50;
const CASES_CAP = 20;
const GOALS_CAP = 50;
const REVIEWS_CAP = 20;
const HELPDESK_CAP = 30;

@AskOsTools()
@Injectable()
export class SelfGrowthTools implements AskOsToolProvider {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  tools(): AskOsToolDefinition[] {
    return [
      defineTool({
        key: "getMyOnboardingTasks",
        description:
          "Get the caller's own onboarding tasks and their completion status, ordered by creation date.",
        input: z.object({}),
        permission: "self:onboarding-tasks",
        run: async (_input, ctx) => {
          const { userId, orgId } = ctx.actor;
          const rows = await this.db
            .select({
              id: onboardingTasks.id,
              title: onboardingTasks.title,
              description: onboardingTasks.description,
              ownerRole: onboardingTasks.ownerRole,
              dueDate: onboardingTasks.dueDate,
              status: onboardingTasks.status,
              completedAt: onboardingTasks.completedAt,
              createdAt: onboardingTasks.createdAt,
            })
            .from(onboardingTasks)
            .where(
              and(
                eq(onboardingTasks.orgId, orgId),
                eq(onboardingTasks.userId, userId),
              ),
            )
            .orderBy(desc(onboardingTasks.createdAt))
            .limit(ONBOARDING_CAP);

          if (rows.length === 0) return empty("onboarding tasks", "No onboarding tasks found.");
          const completed = rows.filter((r) => r.status === "COMPLETED").length;
          return data({
            tasks: rows,
            total: rows.length,
            completed,
            pending: rows.length - completed,
          });
        },
      }),

      defineTool({
        key: "getMyDisciplinaryCases",
        description:
          "Get HR cases where the caller is the named subject. Returns case headers only. Excluded fields: details, assignedTo, assignedToMembershipId, reportedBy, reportedByMembershipId, anonymous — these contain investigator and reporter identity that must not be disclosed to the subject.",
        input: z.object({}),
        permission: "self:cases",
        run: async (_input, ctx) => {
          const { userId, orgId } = ctx.actor;
          const rows = await this.db
            .select({
              id: hrCases.id,
              caseNumber: hrCases.caseNumber,
              category: hrCases.category,
              severity: hrCases.severity,
              status: hrCases.status,
              summary: hrCases.summary,
              outcome: hrCases.outcome,
              resolvedAt: hrCases.resolvedAt,
              createdAt: hrCases.createdAt,
            })
            .from(hrCases)
            .where(
              and(
                eq(hrCases.orgId, orgId),
                eq(hrCases.subjectEmployeeId, userId),
                isNull(hrCases.deletedAt),
              ),
            )
            .orderBy(desc(hrCases.createdAt))
            .limit(CASES_CAP);

          if (rows.length === 0) return empty("cases", "No HR cases found where you are the subject.");
          return data({ cases: rows, total: rows.length });
        },
      }),

      defineTool({
        key: "getMyGoals",
        description:
          "Get the caller's own goals and OKRs, including current progress.",
        input: z.object({}),
        run: async (_input, ctx) => {
          const { userId, orgId } = ctx.actor;
          const rows = await this.db
            .select({
              id: goals.id,
              title: goals.title,
              description: goals.description,
              type: goals.type,
              targetValue: goals.targetValue,
              currentValue: goals.currentValue,
              unit: goals.unit,
              startDate: goals.startDate,
              endDate: goals.endDate,
              status: goals.status,
              progress: goals.progress,
              createdAt: goals.createdAt,
            })
            .from(goals)
            .where(
              and(
                eq(goals.orgId, orgId),
                eq(goals.userId, userId),
              ),
            )
            .orderBy(desc(goals.createdAt))
            .limit(GOALS_CAP);

          if (rows.length === 0) return empty("goals", "No goals found.");
          return data({ goals: rows, total: rows.length });
        },
      }),

      defineTool({
        key: "getMyReviews",
        description:
          "Get the caller's own performance reviews, most recent first.",
        input: z.object({}),
        run: async (_input, ctx) => {
          const { userId, orgId } = ctx.actor;
          const rows = await this.db
            .select({
              id: performanceReviews.id,
              periodStart: performanceReviews.periodStart,
              periodEnd: performanceReviews.periodEnd,
              status: performanceReviews.status,
              overallRating: performanceReviews.overallRating,
              strengths: performanceReviews.strengths,
              improvements: performanceReviews.improvements,
              createdAt: performanceReviews.createdAt,
            })
            .from(performanceReviews)
            .where(
              and(
                eq(performanceReviews.orgId, orgId),
                eq(performanceReviews.userId, userId),
              ),
            )
            .orderBy(desc(performanceReviews.createdAt))
            .limit(REVIEWS_CAP);

          if (rows.length === 0) return empty("reviews", "No performance reviews found.");
          return data({ reviews: rows, total: rows.length });
        },
      }),

      defineTool({
        key: "getMyHelpdeskItems",
        description:
          "Get the caller's own HR helpdesk tickets, most recent first.",
        input: z.object({}),
        module: "hr",
        run: async (_input, ctx) => {
          const { userId, orgId } = ctx.actor;
          const rows = await this.db
            .select({
              id: helpdeskTickets.id,
              title: helpdeskTickets.title,
              description: helpdeskTickets.description,
              category: helpdeskTickets.category,
              priority: helpdeskTickets.priority,
              status: helpdeskTickets.status,
              slaDueAt: helpdeskTickets.slaDueAt,
              resolvedAt: helpdeskTickets.resolvedAt,
              resolution: helpdeskTickets.resolution,
              createdAt: helpdeskTickets.createdAt,
            })
            .from(helpdeskTickets)
            .where(
              and(
                eq(helpdeskTickets.orgId, orgId),
                eq(helpdeskTickets.userId, userId),
              ),
            )
            .orderBy(desc(helpdeskTickets.createdAt))
            .limit(HELPDESK_CAP);

          if (rows.length === 0) return empty("helpdesk items", "No helpdesk tickets found.");
          return data({ tickets: rows, total: rows.length, capped: rows.length === HELPDESK_CAP });
        },
      }),
    ];
  }
}
