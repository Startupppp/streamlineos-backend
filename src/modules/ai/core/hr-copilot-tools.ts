import { Injectable, Inject } from "@nestjs/common";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AiGatewayService } from "./gateway/ai-gateway.service";
import {
  type AskOsToolDefinition,
  type AskOsToolProvider,
  defineTool,
  data,
  empty,
  failed,
} from "./registry/ask-os-tool.types";

const HR_POLICY_CAP = 10;
const MAX_POLICY_DESCRIPTION_CHARS = 1_000;
const MAX_POLICY_RULES_CHARS = 1_500;

function policyTitle(policy: Record<string, unknown>): string {
  const name = typeof policy.name === "string" ? policy.name.trim() : "";
  return name || `Untitled ${String(policy.policy_type)} policy`;
}

function renderPolicyForPrompt(policy: Record<string, unknown>): string {
  const description =
    typeof policy.description === "string" && policy.description.trim()
      ? policy.description.trim().slice(0, MAX_POLICY_DESCRIPTION_CHARS)
      : "(no description recorded)";
  const rules =
    policy.rules === null || policy.rules === undefined
      ? "(no rules recorded)"
      : JSON.stringify(policy.rules).slice(0, MAX_POLICY_RULES_CHARS);
  return [
    `Policy: ${policyTitle(policy)}`,
    `Type: ${String(policy.policy_type)}`,
    `Description: ${description}`,
    `Rules: ${rules}`,
  ].join("\n");
}

@Injectable()
export class HrCopilotTools implements AskOsToolProvider {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
  ) {}

  tools(): AskOsToolDefinition[] {
    return [
      defineTool({
        key: "askHrPolicy",
        description:
          "Answer questions about HR policies, company rules, leave entitlements, attendance rules, code of conduct, or any policy-related question. Searches active HR policies and returns an answer with source citations.",
        input: z.object({
          question: z.string().min(1).describe("The HR policy question to answer"),
        }),
        permission: "hr:policies:view",
        module: "hr",
        run: async ({ question }, ctx) => {
          const { orgId, userId } = ctx.actor;

          const policies = await this.db.execute(sql`
            SELECT id, policy_type, name, description, rules, status, created_at
            FROM hr_policies
            WHERE org_id = ${orgId}
              AND status = 'active'
              AND deleted_at IS NULL
              AND effective_from <= CURRENT_DATE
              AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
            ORDER BY created_at DESC
            LIMIT ${HR_POLICY_CAP}
          `);

          if (!policies || policies.length === 0) {
            return empty(
              "hr policies",
              "No active HR policies found for your organization. Please contact HR to set up policies.",
            );
          }

          const policyList = policies.map(renderPolicyForPrompt).join("\n\n");

          const result = await this.gateway.invokeText({
            actor: { orgId, userId },
            feature: "hr.policy-qa",
            prompt: {
              system:
                "You are an HR policy assistant. Answer the user's question based only on the provided HR policies. Be concise and accurate. If you cannot answer from the listed policies, say so clearly.",
              user: `Active HR policies:\n\n${policyList}\n\nQuestion: ${question}`,
            },
            charge: true,
          });

          if (!result.ok) {
            return failed(
              result.kind === "quota_exceeded"
                ? "AI credits exhausted. Please top up your AI credits and try again."
                : "AI gateway failed. No content was generated. Please try again later.",
            );
          }

          return data({
            answer: result.data,
            sources: policies.map((p: Record<string, unknown>) => ({
              policyId: Number(p.id),
              policyType: String(p.policy_type),
              status: String(p.status),
              citation: `${policyTitle(p)} (${String(p.policy_type)}, active)`,
            })),
            disclaimer:
              "AI-generated response based on your organization's active HR policies. For official decisions, consult your HR department.",
          });
        },
      }),

      defineTool({
        key: "getHeadcountSummary",
        description:
          "Get a summary of current headcount: total employees, active count, employees on probation, employees serving notice. Use when asked about employee numbers or workforce size.",
        input: z.object({
          departmentId: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Optional department ID to filter by"),
        }),
        permission: "hr:analytics:read",
        module: "hr",
        run: async ({ departmentId }, ctx) => {
          const { orgId } = ctx.actor;

          const rows = await this.db.execute(sql`
            SELECT
              COUNT(*) FILTER (WHERE lifecycle_status NOT IN ('EXITED','ALUMNI','CANDIDATE')) AS total,
              COUNT(*) FILTER (WHERE lifecycle_status = 'ACTIVE') AS active,
              COUNT(*) FILTER (WHERE lifecycle_status = 'PROBATION') AS probation,
              COUNT(*) FILTER (WHERE lifecycle_status = 'NOTICE') AS notice
            FROM hr_employments
            WHERE org_id = ${orgId}
              AND deleted_at IS NULL
              ${departmentId !== undefined ? sql`AND department_id = ${departmentId}` : sql``}
          `);

          const row = rows[0];
          return data({
            total: Number(row?.total ?? 0),
            active: Number(row?.active ?? 0),
            probation: Number(row?.probation ?? 0),
            notice: Number(row?.notice ?? 0),
            scope: departmentId !== undefined ? `Department ${departmentId}` : "All departments",
          });
        },
      }),

      defineTool({
        key: "getAttritionSummary",
        description:
          "Get attrition statistics: number of exits in the past 12 months and attrition rate. Use when asked about turnover, attrition, or how many people left.",
        input: z.object({}),
        permission: "hr:analytics:read",
        module: "hr",
        run: async (_input, ctx) => {
          const { orgId } = ctx.actor;

          const twelveMonthsAgo = new Date();
          twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
          const cutoff = twelveMonthsAgo.toISOString().split("T")[0];

          const rows = await this.db.execute(sql`
            SELECT
              COUNT(*) FILTER (WHERE lifecycle_status IN ('EXITED','ALUMNI') AND exit_date >= ${cutoff}::date) AS exits_12mo,
              COUNT(*) FILTER (WHERE lifecycle_status NOT IN ('CANDIDATE')) AS total_headcount
            FROM hr_employments
            WHERE org_id = ${orgId}
              AND deleted_at IS NULL
          `);

          const row = rows[0];
          const exits = Number(row?.exits_12mo ?? 0);
          const total = Number(row?.total_headcount ?? 0);
          const rate = total > 0 ? ((exits / total) * 100).toFixed(1) : "0.0";

          return data({
            exitsLast12Months: exits,
            totalHeadcount: total,
            attritionRatePercent: rate,
            period: "Last 12 months",
          });
        },
      }),

      defineTool({
        key: "draftPerformanceReviewNote",
        description:
          "Draft a performance review note for a specific employee. Returns a DRAFT only -- requires human review and approval before use. Never auto-saves or sends anything.",
        input: z.object({
          employeeId: z.string().describe("The user ID of the employee being reviewed"),
          reviewPeriod: z.string().describe("The review period (e.g. Q2 2026, Annual 2025)"),
          keyAchievements: z.string().optional().describe("Key achievements to highlight"),
          areasForImprovement: z.string().optional().describe("Areas for development"),
          overallRating: z.number().min(1).max(5).optional().describe("Rating from 1 to 5"),
        }),
        permission: "hr:performance:manage",
        module: "hr",
        run: async (
          { employeeId, reviewPeriod, keyAchievements, areasForImprovement, overallRating },
          ctx,
        ) => {
          const { orgId, userId } = ctx.actor;

          const empRows = await this.db.execute(sql`
            SELECT p.first_name, p.last_name
            FROM hr_employments e
            JOIN hr_people p ON p.id = e.person_id
            WHERE e.org_id = ${orgId}
              AND p.user_id = ${employeeId}
              AND e.deleted_at IS NULL
              AND p.deleted_at IS NULL
            LIMIT 1
          `);

          const emp = empRows[0];
          const empName = emp
            ? `${String(emp.first_name)} ${String(emp.last_name)}`
            : employeeId;

          const result = await this.gateway.invokeText({
            actor: { orgId, userId },
            feature: "hr.generate-review",
            prompt: {
              system:
                "You are an HR professional helping draft performance review notes. Write balanced, constructive, and specific reviews. Use professional language. Write in 2-3 focused paragraphs.",
              user: [
                `Draft a performance review note for ${empName}, period: ${reviewPeriod}.`,
                keyAchievements ? `Key achievements: ${keyAchievements}` : "",
                areasForImprovement ? `Areas for improvement: ${areasForImprovement}` : "",
                overallRating ? `Overall rating: ${overallRating}/5` : "",
              ]
                .filter(Boolean)
                .join("\n"),
            },
            charge: true,
          });

          if (!result.ok) {
            return failed(
              result.kind === "quota_exceeded"
                ? "AI credits exhausted. Please top up your AI credits and try again."
                : "AI gateway failed. No content was generated. Please try again later.",
            );
          }

          return data({
            draft: result.data,
            employee: empName,
            period: reviewPeriod,
            rating: overallRating,
            disclaimer:
              "DRAFT -- AI-generated suggestion. Requires human review, editing, and approval before any official use. Do not share with the employee until reviewed.",
            requiresApproval: true,
          });
        },
      }),

      defineTool({
        key: "draftPromotionLetter",
        description:
          "Draft a promotion letter for an employee. Returns a DRAFT only -- does not save or send anything. Requires explicit human approval before any official use.",
        input: z.object({
          employeeId: z.string().describe("User ID of the employee being promoted"),
          newTitle: z.string().describe("The new job title"),
          newGrade: z.string().optional().describe("New grade or level"),
          effectiveDate: z.string().describe("Effective date of promotion (YYYY-MM-DD)"),
          additionalContext: z.string().optional().describe("Additional context for the letter"),
        }),
        permission: "hr:employees:update",
        module: "hr",
        run: async ({ employeeId, newTitle, newGrade, effectiveDate, additionalContext }, ctx) => {
          const { orgId, userId } = ctx.actor;

          const empRows = await this.db.execute(sql`
            SELECT p.first_name, p.last_name, e.designation
            FROM hr_employments e
            JOIN hr_people p ON p.id = e.person_id
            WHERE e.org_id = ${orgId}
              AND p.user_id = ${employeeId}
              AND e.deleted_at IS NULL
              AND p.deleted_at IS NULL
            LIMIT 1
          `);

          const emp = empRows[0];
          const empName = emp
            ? `${String(emp.first_name)} ${String(emp.last_name)}`
            : employeeId;
          const currentTitle =
            emp?.designation != null ? String(emp.designation) : "current role";

          const result = await this.gateway.invokeText({
            actor: { orgId, userId },
            feature: "hr.letter-draft",
            prompt: {
              system:
                "You are an HR professional drafting formal promotion letters. Write in a warm yet professional tone. Structure: opening congratulations, recognition of contributions, new role details, expression of confidence, closing. Keep to 3-4 paragraphs.",
              user: [
                `Draft a promotion letter for ${empName}.`,
                `Current title: ${currentTitle}`,
                `New title: ${newTitle}`,
                newGrade ? `New grade: ${newGrade}` : "",
                `Effective date: ${effectiveDate}`,
                additionalContext ?? "",
              ]
                .filter(Boolean)
                .join("\n"),
            },
            charge: true,
          });

          if (!result.ok) {
            return failed(
              result.kind === "quota_exceeded"
                ? "AI credits exhausted. Please top up your AI credits and try again."
                : "AI gateway failed. No content was generated. Please try again later.",
            );
          }

          return data({
            draft: result.data,
            employee: empName,
            newTitle,
            effectiveDate,
            disclaimer:
              "DRAFT -- AI-generated promotion letter. Must be reviewed and approved by HR leadership, then signed by an authorized representative before delivery. Do NOT send to the employee without authorization.",
            requiresApproval: true,
            autoSaved: false,
          });
        },
      }),

      defineTool({
        key: "getMoodTrend",
        description:
          "Get the mood check-in trend for the organization over the past 30 days, broken down by week. Use when asked about team morale, mood, or wellbeing trends.",
        input: z.object({}),
        permission: "hr:engagement:view",
        module: "hr",
        run: async (_input, ctx) => {
          const { orgId } = ctx.actor;

          const thirtyDaysAgo = new Date();
          thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
          const cutoff = thirtyDaysAgo.toISOString().split("T")[0];

          const rows = await this.db.execute(sql`
            SELECT
              DATE_TRUNC('week', date) AS week_start,
              ROUND(AVG(mood)::numeric, 2) AS avg_mood,
              COUNT(*) AS checkin_count
            FROM hr_mood_checkins
            WHERE org_id = ${orgId}
              AND date >= ${cutoff}::date
            GROUP BY DATE_TRUNC('week', date)
            ORDER BY week_start ASC
          `);

          if (rows.length === 0) {
            return data({
              trend: [],
              summary: "No mood check-in data available for the past 30 days.",
              period: "Last 30 days",
            });
          }

          const latest = rows[rows.length - 1];
          const oldest = rows[0];
          const latestAvg = Number(latest?.avg_mood ?? 0);
          const oldestAvg = Number(oldest?.avg_mood ?? 0);
          const direction =
            latestAvg > oldestAvg ? "improving" : latestAvg < oldestAvg ? "declining" : "stable";

          return data({
            trend: rows.map((w: Record<string, unknown>) => ({
              weekStart: String(w.week_start).split("T")[0],
              averageMood: Number(w.avg_mood),
              checkInCount: Number(w.checkin_count),
            })),
            summary: `Team mood is ${direction}. Latest week average: ${latestAvg.toFixed(1)}/5 from ${Number(latest?.checkin_count ?? 0)} check-ins.`,
            period: "Last 30 days",
          });
        },
      }),

      defineTool({
        key: "getLeaveUtilization",
        description:
          "Get leave utilization statistics: how many employees are currently on leave, pending leave requests, and leave approved this month. Use when asked about leave usage or who is out.",
        input: z.object({}),
        permission: "hr:leaves:view",
        module: "hr",
        run: async (_input, ctx) => {
          const { orgId, userId } = ctx.actor;
          const selfFilter = ctx.scope === "all" ? sql`` : sql`AND user_id = ${userId}`;

          const today = new Date().toISOString().split("T")[0];
          const monthStart = new Date();
          monthStart.setDate(1);
          const monthStartStr = monthStart.toISOString().split("T")[0];

          const rows = await this.db.execute(sql`
            SELECT
              COUNT(*) FILTER (
                WHERE status = 'APPROVED'
                  AND start_date <= ${today}::date
                  AND end_date >= ${today}::date
              ) AS currently_on_leave,
              COUNT(*) FILTER (WHERE status = 'PENDING') AS pending_requests,
              COUNT(*) FILTER (
                WHERE status = 'APPROVED'
                  AND start_date >= ${monthStartStr}::date
              ) AS approved_this_month
            FROM leave_requests
            WHERE org_id = ${orgId}
            ${selfFilter}
          `);

          const row = rows[0];
          return data({
            currentlyOnLeave: Number(row?.currently_on_leave ?? 0),
            pendingRequests: Number(row?.pending_requests ?? 0),
            approvedThisMonth: Number(row?.approved_this_month ?? 0),
            asOf: today,
          });
        },
      }),
    ];
  }
}
