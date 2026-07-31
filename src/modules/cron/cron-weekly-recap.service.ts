import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, gte, sql } from "drizzle-orm";
import { subDays, format } from "date-fns";
import {
  leadActivities,
  leads,
  leaveRequests,
  organizationMembers,
  organizations,
  tickets,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { EmailService } from "../email/email.service";
import { AiGatewayService } from "../ai/core/gateway/ai-gateway.service";
import { getWeeklyRecapEmailTemplate } from "../email/templates/reports";
import { logger } from "../../common/logger/logger.service";
import { forEachOrg } from "../../common/tenant";

interface RecapData {
  orgId: string;
  orgName: string;
  totalEmployees: number;
  newLeads: number;
  convertedLeads: number;
  totalActivities: number;
  openTickets: number;
  closedTickets: number;
  pendingLeaves: number;
  topPerformers: { name: string; score: number }[];
  pipelineSummary: { status: string; count: number }[];
}

@Injectable()
export class CronWeeklyRecapService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
    private readonly gateway: AiGatewayService,
  ) {}

  async sendWeeklyExecRecaps(): Promise<{
    results: { orgId: string; sent: boolean; error?: string }[];
    generatedAt: string;
  }> {
    const results: { orgId: string; sent: boolean; error?: string }[] = [];
    const weekStart = subDays(new Date(), 7);
    const weekRange = `${format(weekStart, "MMM d")} — ${format(new Date(), "MMM d, yyyy")}`;

    await forEachOrg(this.db, "cron-weekly-recap", async (tx, orgId) => {
      try {
        const [orgRow] = await tx
          .select({ name: organizations.name })
          .from(organizations)
          .where(eq(organizations.id, orgId));

        if (!orgRow) return;

        const owners = await tx
          .select({ email: users.email, name: users.name })
          .from(organizationMembers)
          .innerJoin(users, eq(users.id, organizationMembers.userId))
          .where(
            and(
              eq(organizationMembers.orgId, orgId),
              eq(organizationMembers.isOwner, true),
              eq(organizationMembers.status, "ACTIVE"),
              eq(users.isActive, true),
            ),
          );

        if (owners.length === 0) {
          results.push({ orgId, sent: false, error: "No active FINAL" });
          return;
        }

        const [employeeCount] = await tx
          .select({ count: count() })
          .from(organizationMembers)
          .innerJoin(users, eq(users.id, organizationMembers.userId))
          .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true)));

        const [newLeadCount] = await tx
          .select({ count: count() })
          .from(leads)
          .where(and(eq(leads.orgId, orgId), gte(leads.createdAt, weekStart)));

        const [convertedCount] = await tx
          .select({ count: count() })
          .from(leads)
          .where(
            and(eq(leads.orgId, orgId), eq(leads.status, "CONVERTED"), gte(leads.updatedAt, weekStart)),
          );

        const [activityCount] = await tx
          .select({ count: count() })
          .from(leadActivities)
          .innerJoin(leads, eq(leads.id, leadActivities.leadId))
          .where(and(eq(leads.orgId, orgId), gte(leadActivities.createdAt, weekStart)));

        const [openTicketCount] = await tx
          .select({ count: count() })
          .from(tickets)
          .where(
            and(eq(tickets.orgId, orgId), sql`${tickets.status} NOT IN ('DONE', 'CANCELLED')`),
          );

        const [closedTicketCount] = await tx
          .select({ count: count() })
          .from(tickets)
          .where(
            and(eq(tickets.orgId, orgId), eq(tickets.status, "DONE"), gte(tickets.updatedAt, weekStart)),
          );

        const [pendingLeaveCount] = await tx
          .select({ count: count() })
          .from(leaveRequests)
          .where(and(eq(leaveRequests.orgId, orgId), eq(leaveRequests.status, "PENDING")));

        const pipelineRaw = await tx
          .select({ status: leads.status, count: count() })
          .from(leads)
          .where(eq(leads.orgId, orgId))
          .groupBy(leads.status);

        const leaderboardRaw = await tx
          .select({
            name: users.name,
            converted: sql<number>`COUNT(CASE WHEN ${leads.status} = 'CONVERTED' THEN 1 END)::int`,
          })
          .from(leads)
          .innerJoin(users, eq(users.id, leads.assignedToId))
          .where(and(eq(leads.orgId, orgId), sql`${leads.assignedToId} IS NOT NULL`))
          .groupBy(leads.assignedToId, users.name)
          .orderBy(sql`COUNT(CASE WHEN ${leads.status} = 'CONVERTED' THEN 1 END) DESC`)
          .limit(5);

        const recapData: RecapData = {
          orgId,
          orgName: orgRow.name,
          totalEmployees: employeeCount?.count ?? 0,
          newLeads: newLeadCount?.count ?? 0,
          convertedLeads: convertedCount?.count ?? 0,
          totalActivities: activityCount?.count ?? 0,
          openTickets: openTicketCount?.count ?? 0,
          closedTickets: closedTicketCount?.count ?? 0,
          pendingLeaves: pendingLeaveCount?.count ?? 0,
          topPerformers: leaderboardRaw.map((r) => ({
            name: r.name ?? "Unknown",
            score: r.converted * 50,
          })),
          pipelineSummary: pipelineRaw.map((r) => ({ status: r.status ?? "", count: r.count })),
        };

        const aiNarrative = await this.generateNarrative(recapData, weekRange, orgId);
        const html = getWeeklyRecapEmailTemplate({
          orgName: recapData.orgName,
          weekRange,
          totalEmployees: recapData.totalEmployees,
          newLeads: recapData.newLeads,
          convertedLeads: recapData.convertedLeads,
          totalActivities: recapData.totalActivities,
          openTickets: recapData.openTickets,
          closedTickets: recapData.closedTickets,
          pendingLeaves: recapData.pendingLeaves,
          topPerformers: recapData.topPerformers,
          pipelineSummary: recapData.pipelineSummary,
          aiNarrative,
        });

        for (const owner of owners) {
          if (!owner.email) continue;
          await this.email.sendEmail({
            to: owner.email,
            subject: `Your week at ${orgRow.name} — ${weekRange}`,
            html,
          });
        }

        results.push({ orgId, sent: true });
      } catch (error) {
        logger.error("Weekly FINAL recap failed for org", { orgId, error });
        results.push({ orgId, sent: false, error: String(error) });
      }
    });

    return { results, generatedAt: new Date().toISOString() };
  }

  private async generateNarrative(data: RecapData, weekRange: string, orgId: string): Promise<string> {
    const conversionRate =
      data.newLeads > 0 ? ((data.convertedLeads / data.newLeads) * 100).toFixed(1) : "0.0";

    const topPerformersList =
      data.topPerformers.length > 0
        ? data.topPerformers
            .slice(0, 3)
            .map((p, i) => `${i + 1}. ${p.name} (${p.score} pts)`)
            .join(", ")
        : "No performers recorded";

    const pipelineBreakdown =
      data.pipelineSummary.length > 0
        ? data.pipelineSummary.map((s) => `${s.status}: ${s.count}`).join(", ")
        : "No pipeline data";

    const system = `You are an executive business analyst writing concise weekly performance narratives for a FINAL of an Indian investment and financial services firm. Your writing style is professional, confident, and insight-driven — not just descriptive. Highlight what matters most, flag any concerns worth attention, and frame numbers in context. Write in plain text only (no markdown, no bullet points, no headers). Output exactly 3 to 4 paragraphs separated by a single blank line.`;

    const user = `Write a weekly performance narrative for ${data.orgName} covering the week of ${weekRange}.\n\nKey metrics:\n- Total active employees: ${data.totalEmployees}\n- New leads this week: ${data.newLeads}\n- Leads converted this week: ${data.convertedLeads} (${conversionRate}% conversion rate)\n- Sales activities logged: ${data.totalActivities}\n- Open tickets: ${data.openTickets}\n- Tickets closed this week: ${data.closedTickets}\n- Pending leave requests: ${data.pendingLeaves}\n\nTop performers (by conversions): ${topPerformersList}\n\nLead pipeline breakdown: ${pipelineBreakdown}\n\nFocus on: overall business momentum, sales team effectiveness, operational health, and any areas requiring the FINAL's immediate attention.`;

    try {
      const result = await this.gateway.invokeText({
        actor: { orgId, userId: null },
        feature: "final.weekly-recap",
        tier: "standard",
        maxTokens: 1024,
        prompt: { system, user },
      });

      if (!result.ok) return "";
      return result.data;
    } catch {
      return "";
    }
  }
}
