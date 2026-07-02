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
import { LlmService } from "../ai/providers/llm.service";
import { getWeeklyRecapEmailTemplate } from "../email/templates/reports";
import { logger } from "../../common/logger/logger.service";

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
    private readonly llm: LlmService,
  ) {}

  async sendWeeklyCeoRecaps(): Promise<{
    results: { orgId: string; sent: boolean; error?: string }[];
    generatedAt: string;
  }> {
    const allOrgs = await this.db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations);

    const results: { orgId: string; sent: boolean; error?: string }[] = [];
    const weekStart = subDays(new Date(), 7);
    const weekRange = `${format(weekStart, "MMM d")} — ${format(new Date(), "MMM d, yyyy")}`;

    for (const org of allOrgs) {
      try {
        const owners = await this.db
          .select({ email: users.email, name: users.name })
          .from(organizationMembers)
          .innerJoin(users, eq(users.id, organizationMembers.userId))
          .where(
            and(
              eq(organizationMembers.orgId, org.id),
              eq(organizationMembers.role, "CEO"),
              eq(users.isActive, true),
            ),
          );

        if (owners.length === 0) {
          results.push({ orgId: org.id, sent: false, error: "No active CEO" });
          continue;
        }

        const [
          [employeeCount],
          [newLeadCount],
          [convertedCount],
          [activityCount],
          [openTicketCount],
          [closedTicketCount],
          [pendingLeaveCount],
          pipelineRaw,
        ] = await Promise.all([
          this.db
            .select({ count: count() })
            .from(organizationMembers)
            .innerJoin(users, eq(users.id, organizationMembers.userId))
            .where(and(eq(organizationMembers.orgId, org.id), eq(users.isActive, true))),
          this.db
            .select({ count: count() })
            .from(leads)
            .where(and(eq(leads.orgId, org.id), gte(leads.createdAt, weekStart))),
          this.db
            .select({ count: count() })
            .from(leads)
            .where(
              and(eq(leads.orgId, org.id), eq(leads.status, "CONVERTED"), gte(leads.updatedAt, weekStart)),
            ),
          this.db
            .select({ count: count() })
            .from(leadActivities)
            .innerJoin(leads, eq(leads.id, leadActivities.leadId))
            .where(and(eq(leads.orgId, org.id), gte(leadActivities.createdAt, weekStart))),
          this.db
            .select({ count: count() })
            .from(tickets)
            .where(
              and(eq(tickets.orgId, org.id), sql`${tickets.status} NOT IN ('DONE', 'CANCELLED')`),
            ),
          this.db
            .select({ count: count() })
            .from(tickets)
            .where(
              and(eq(tickets.orgId, org.id), eq(tickets.status, "DONE"), gte(tickets.updatedAt, weekStart)),
            ),
          this.db
            .select({ count: count() })
            .from(leaveRequests)
            .where(and(eq(leaveRequests.orgId, org.id), eq(leaveRequests.status, "PENDING"))),
          this.db
            .select({ status: leads.status, count: count() })
            .from(leads)
            .where(eq(leads.orgId, org.id))
            .groupBy(leads.status),
        ]);

        const leaderboardRaw = await this.db
          .select({
            name: users.name,
            converted: sql<number>`COUNT(CASE WHEN ${leads.status} = 'CONVERTED' THEN 1 END)::int`,
          })
          .from(leads)
          .innerJoin(users, eq(users.id, leads.assignedToId))
          .where(and(eq(leads.orgId, org.id), sql`${leads.assignedToId} IS NOT NULL`))
          .groupBy(leads.assignedToId, users.name)
          .orderBy(sql`COUNT(CASE WHEN ${leads.status} = 'CONVERTED' THEN 1 END) DESC`)
          .limit(5);

        const recapData: RecapData = {
          orgId: org.id,
          orgName: org.name,
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

        const aiNarrative = await this.generateNarrative(recapData, weekRange);
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
            subject: `Your week at ${org.name} — ${weekRange}`,
            html,
          });
        }

        results.push({ orgId: org.id, sent: true });
      } catch (error) {
        logger.error("Weekly CEO recap failed for org", { orgId: org.id, error });
        results.push({ orgId: org.id, sent: false, error: String(error) });
      }
    }

    return { results, generatedAt: new Date().toISOString() };
  }

  private async generateNarrative(data: RecapData, weekRange: string): Promise<string> {
    if (!this.llm.isConfigured()) return "";

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

    const system = `You are an executive business analyst writing concise weekly performance narratives for a CEO of an Indian investment and financial services firm. Your writing style is professional, confident, and insight-driven — not just descriptive. Highlight what matters most, flag any concerns worth attention, and frame numbers in context. Write in plain text only (no markdown, no bullet points, no headers). Output exactly 3 to 4 paragraphs separated by a single blank line.`;

    const user = `Write a weekly performance narrative for ${data.orgName} covering the week of ${weekRange}.\n\nKey metrics:\n- Total active employees: ${data.totalEmployees}\n- New leads this week: ${data.newLeads}\n- Leads converted this week: ${data.convertedLeads} (${conversionRate}% conversion rate)\n- Sales activities logged: ${data.totalActivities}\n- Open tickets: ${data.openTickets}\n- Tickets closed this week: ${data.closedTickets}\n- Pending leave requests: ${data.pendingLeaves}\n\nTop performers (by conversions): ${topPerformersList}\n\nLead pipeline breakdown: ${pipelineBreakdown}\n\nFocus on: overall business momentum, sales team effectiveness, operational health, and any areas requiring the CEO's immediate attention.`;

    try {
      return await this.llm.invokeText({ model: "fast", system, user, temperature: 0.5 });
    } catch {
      return "";
    }
  }

}
