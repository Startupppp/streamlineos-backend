import { Injectable, Inject } from "@nestjs/common";
import { tool } from "ai";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { ToolAccessService } from "./tool-access.service";
import { AiGatewayService } from "./gateway/ai-gateway.service";

export interface HrToolContext {
  orgId: string;
  userId: string;
}

@Injectable()
export class HrCopilotTools {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly toolAccess: ToolAccessService,
    private readonly gateway: AiGatewayService,
  ) {}

  buildTools(ctx: HrToolContext) {
    const { orgId, userId } = ctx;

    return {
      askHrPolicy: tool({
        description:
          "Answer questions about HR policies, company rules, leave entitlements, attendance rules, code of conduct, or any policy-related question. Searches active HR policies and returns an answer with source citations.",
        inputSchema: z.object({
          question: z.string().min(1).describe("The HR policy question to answer"),
        }),
        execute: async ({ question }) => {
          const deny = await this.toolAccess.denyReason(orgId, userId, "hr:policies:view");
          if (deny) return { denied: true, reason: deny };

          const policies = await this.db.execute(sql`
            SELECT id, policy_type, status, scope_type, created_at
            FROM hr_policies
            WHERE org_id = ${orgId}
              AND status = 'active'
            ORDER BY created_at DESC
            LIMIT 10
          `);

          if (!policies || policies.length === 0) {
            return {
              answer:
                "No active HR policies found for your organization. Please contact HR to set up policies.",
              sources: [],
            };
          }

          const policyList = policies
            .map(
              (p: Record<string, unknown>) =>
                `Policy type: ${String(p.policy_type)}, scope: ${String(p.scope_type)}`,
            )
            .join("\n");

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
            if (result.kind === "quota_exceeded") {
              return { answer: "AI credits exhausted. Please top up your AI credits and try again.", sources: [] };
            }
            return {
              answer: `Your organization has ${policies.length} active policies covering: ${policies.map((p: Record<string, unknown>) => String(p.policy_type)).join(", ")}. For specific details, please contact HR.`,
              sources: [],
            };
          }

          return {
            answer: result.data,
            sources: policies.map((p: Record<string, unknown>) => ({
              policyType: String(p.policy_type),
              status: String(p.status),
              citation: `HR Policy: ${String(p.policy_type)} (active)`,
            })),
            disclaimer:
              "AI-generated response based on your organization's active HR policies. For official decisions, consult your HR department.",
          };
        },
      }),

      getHeadcountSummary: tool({
        description:
          "Get a summary of current headcount: total employees, active count, employees on probation, employees serving notice. Use when asked about employee numbers or workforce size.",
        inputSchema: z.object({
          departmentId: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Optional department ID to filter by"),
        }),
        execute: async ({ departmentId }) => {
          const deny = await this.toolAccess.denyReason(orgId, userId, "hr:analytics:read");
          if (deny) return { denied: true, reason: deny };

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

          const row = rows[0] as Record<string, string> | undefined;
          return {
            total: Number(row?.total ?? 0),
            active: Number(row?.active ?? 0),
            probation: Number(row?.probation ?? 0),
            notice: Number(row?.notice ?? 0),
            scope: departmentId !== undefined ? `Department ${departmentId}` : "All departments",
          };
        },
      }),

      getAttritionSummary: tool({
        description:
          "Get attrition statistics: number of exits in the past 12 months and attrition rate. Use when asked about turnover, attrition, or how many people left.",
        inputSchema: z.object({}),
        execute: async () => {
          const deny = await this.toolAccess.denyReason(orgId, userId, "hr:analytics:read");
          if (deny) return { denied: true, reason: deny };

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

          const row = rows[0] as Record<string, string> | undefined;
          const exits = Number(row?.exits_12mo ?? 0);
          const total = Number(row?.total_headcount ?? 0);
          const rate = total > 0 ? ((exits / total) * 100).toFixed(1) : "0.0";

          return {
            exitsLast12Months: exits,
            totalHeadcount: total,
            attritionRatePercent: rate,
            period: "Last 12 months",
          };
        },
      }),

      draftPerformanceReviewNote: tool({
        description:
          "Draft a performance review note for a specific employee. Returns a DRAFT only -- requires human review and approval before use. Never auto-saves or sends anything.",
        inputSchema: z.object({
          employeeId: z.string().describe("The user ID of the employee being reviewed"),
          reviewPeriod: z.string().describe("The review period (e.g. Q2 2026, Annual 2025)"),
          keyAchievements: z.string().optional().describe("Key achievements to highlight"),
          areasForImprovement: z.string().optional().describe("Areas for development"),
          overallRating: z.number().min(1).max(5).optional().describe("Rating from 1 to 5"),
        }),
        execute: async ({
          employeeId,
          reviewPeriod,
          keyAchievements,
          areasForImprovement,
          overallRating,
        }) => {
          const deny = await this.toolAccess.denyReason(orgId, userId, "hr:performance:manage");
          if (deny) return { denied: true, reason: deny };

          const empRows = await this.db.execute(sql`
            SELECT p.first_name, p.last_name
            FROM hr_employments e
            JOIN hr_people p ON p.id = e.person_id
            WHERE e.org_id = ${orgId}
              AND p.user_id = ${employeeId}
              AND e.deleted_at IS NULL
            LIMIT 1
          `);

          const emp = empRows[0] as Record<string, string> | undefined;
          const empName = emp ? `${emp.first_name} ${emp.last_name}` : employeeId;

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
            if (result.kind === "quota_exceeded") {
              return {
                draft: "AI credits exhausted. Please top up your AI credits and try again.",
                disclaimer: "DRAFT -- Requires human review and approval.",
                requiresApproval: true,
              };
            }
            return {
              draft: `Performance review draft for ${empName} (${reviewPeriod}):\n\nUnable to generate draft at this time. Please write the review manually based on the provided inputs.`,
              disclaimer: "DRAFT -- Requires human review and approval.",
              requiresApproval: true,
            };
          }

          return {
            draft: result.data,
            employee: empName,
            period: reviewPeriod,
            rating: overallRating,
            disclaimer:
              "DRAFT -- AI-generated suggestion. Requires human review, editing, and approval before any official use. Do not share with the employee until reviewed.",
            requiresApproval: true,
          };
        },
      }),

      draftPromotionLetter: tool({
        description:
          "Draft a promotion letter for an employee. Returns a DRAFT only -- does not save or send anything. Requires explicit human approval before any official use.",
        inputSchema: z.object({
          employeeId: z.string().describe("User ID of the employee being promoted"),
          newTitle: z.string().describe("The new job title"),
          newGrade: z.string().optional().describe("New grade or level"),
          effectiveDate: z.string().describe("Effective date of promotion (YYYY-MM-DD)"),
          additionalContext: z.string().optional().describe("Additional context for the letter"),
        }),
        execute: async ({ employeeId, newTitle, newGrade, effectiveDate, additionalContext }) => {
          const deny = await this.toolAccess.denyReason(orgId, userId, "hr:employees:update");
          if (deny) return { denied: true, reason: deny };

          const empRows = await this.db.execute(sql`
            SELECT p.first_name, p.last_name, e.designation
            FROM hr_employments e
            JOIN hr_people p ON p.id = e.person_id
            WHERE e.org_id = ${orgId}
              AND p.user_id = ${employeeId}
              AND e.deleted_at IS NULL
            LIMIT 1
          `);

          const emp = empRows[0] as Record<string, string> | undefined;
          const empName = emp ? `${emp.first_name} ${emp.last_name}` : employeeId;
          const currentTitle = emp?.designation ?? "current role";

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
            if (result.kind === "quota_exceeded") {
              return {
                draft: "AI credits exhausted. Please top up your AI credits and try again.",
                disclaimer: "DRAFT -- Requires human review and approval.",
                requiresApproval: true,
                autoSaved: false,
              };
            }
            return {
              draft: `Dear ${empName},\n\nWe are pleased to inform you of your promotion to ${newTitle} effective ${effectiveDate}.\n\n[Please complete this letter with specific achievements and expectations.]\n\nCongratulations,\nHR Department`,
              disclaimer: "DRAFT -- Requires human review and approval.",
              requiresApproval: true,
              autoSaved: false,
            };
          }

          return {
            draft: result.data,
            employee: empName,
            newTitle,
            effectiveDate,
            disclaimer:
              "DRAFT -- AI-generated promotion letter. Must be reviewed and approved by HR leadership, then signed by an authorized representative before delivery. Do NOT send to the employee without authorization.",
            requiresApproval: true,
            autoSaved: false,
          };
        },
      }),

      getMoodTrend: tool({
        description:
          "Get the mood check-in trend for the organization over the past 30 days, broken down by week. Use when asked about team morale, mood, or wellbeing trends.",
        inputSchema: z.object({}),
        execute: async () => {
          const deny = await this.toolAccess.denyReason(orgId, userId, "hr:engagement:view");
          if (deny) return { denied: true, reason: deny };

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

          const weeks = rows as Array<Record<string, unknown>>;

          if (weeks.length === 0) {
            return {
              trend: [],
              summary: "No mood check-in data available for the past 30 days.",
              period: "Last 30 days",
            };
          }

          const latest = weeks[weeks.length - 1];
          const oldest = weeks[0];
          const latestAvg = Number(latest?.avg_mood ?? 0);
          const oldestAvg = Number(oldest?.avg_mood ?? 0);
          const direction =
            latestAvg > oldestAvg ? "improving" : latestAvg < oldestAvg ? "declining" : "stable";

          return {
            trend: weeks.map((w) => ({
              weekStart: String(w.week_start).split("T")[0],
              averageMood: Number(w.avg_mood),
              checkInCount: Number(w.checkin_count),
            })),
            summary: `Team mood is ${direction}. Latest week average: ${latestAvg.toFixed(1)}/5 from ${Number(latest?.checkin_count ?? 0)} check-ins.`,
            period: "Last 30 days",
          };
        },
      }),

      getLeaveUtilization: tool({
        description:
          "Get leave utilization statistics: how many employees are currently on leave, pending leave requests, and leave approved this month. Use when asked about leave usage or who is out.",
        inputSchema: z.object({}),
        execute: async () => {
          const deny = await this.toolAccess.denyReason(orgId, userId, "hr:leaves:view");
          if (deny) return { denied: true, reason: deny };

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
          `);

          const row = rows[0] as Record<string, string> | undefined;
          return {
            currentlyOnLeave: Number(row?.currently_on_leave ?? 0),
            pendingRequests: Number(row?.pending_requests ?? 0),
            approvedThisMonth: Number(row?.approved_this_month ?? 0),
            asOf: today,
          };
        },
      }),
    };
  }
}
