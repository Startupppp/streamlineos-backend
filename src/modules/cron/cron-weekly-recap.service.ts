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
        const html = this.buildHtml(recapData, weekRange, aiNarrative);

        for (const owner of owners) {
          if (!owner.email) continue;
          await this.email.sendEmail({
            to: owner.email,
            subject: `Weekly Recap — ${weekRange} | ${org.name}`,
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

  private buildHtml(data: RecapData, weekRange: string, aiNarrative: string): string {
    const topPerformersRows = data.topPerformers
      .slice(0, 5)
      .map(
        (p, i) =>
          `<tr><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`}</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${p.name}</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:bold;">${p.score} pts</td></tr>`,
      )
      .join("");

    const pipelineRows = data.pipelineSummary
      .map(
        (s) =>
          `<tr><td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;">${s.status}</td><td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:bold;">${s.count}</td></tr>`,
      )
      .join("");

    const narrativeBlock = aiNarrative
      ? `<div style="background:#f8f3e8;border-left:4px solid #bd882c;padding:16px 20px;margin-bottom:24px;border-radius:4px;"><p style="font-size:14px;color:#333;line-height:1.7;margin:0;">${aiNarrative.replace(/\n\n/g, '</p><p style="font-size:14px;color:#333;line-height:1.7;margin:12px 0 0 0;">').replace(/\n/g, " ")}</p></div>`
      : "";

    const topPerformersSection =
      data.topPerformers.length > 0
        ? `<h3 style="color:#0f2b7f;border-bottom:2px solid #bd882c;padding-bottom:8px;">Sales Leaderboard</h3><table style="width:100%;border-collapse:collapse;margin-bottom:20px;"><thead><tr style="background:#f9fafb;"><th style="padding:8px 12px;text-align:left;font-size:12px;color:#6b7280;">Rank</th><th style="padding:8px 12px;text-align:left;font-size:12px;color:#6b7280;">Name</th><th style="padding:8px 12px;text-align:right;font-size:12px;color:#6b7280;">Score</th></tr></thead><tbody>${topPerformersRows}</tbody></table>`
        : "";

    const pipelineSection =
      data.pipelineSummary.length > 0
        ? `<h3 style="color:#0f2b7f;border-bottom:2px solid #bd882c;padding-bottom:8px;">Lead Pipeline</h3><table style="width:100%;border-collapse:collapse;margin-bottom:20px;"><thead><tr style="background:#f9fafb;"><th style="padding:6px 12px;text-align:left;font-size:12px;color:#6b7280;">Status</th><th style="padding:6px 12px;text-align:right;font-size:12px;color:#6b7280;">Count</th></tr></thead><tbody>${pipelineRows}</tbody></table>`
        : "";

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Weekly CEO Recap</title></head><body style="font-family:Arial,sans-serif;line-height:1.6;color:#333;max-width:650px;margin:0 auto;padding:20px;background:#f9fafb;"><div style="background:linear-gradient(135deg,#0f2b7f 0%,#1e40af 100%);padding:30px;text-align:center;border-radius:10px 10px 0 0;"><h1 style="color:#bd882c;margin:0;font-size:26px;font-family:Georgia,serif;">StreamlineOS</h1><p style="color:#dbeafe;margin:8px 0 0 0;font-size:16px;">Weekly CEO Recap — ${weekRange}</p></div><div style="background:#ffffff;padding:30px;border:1px solid #e5e7eb;border-top:none;"><p style="margin-top:0;">Good morning! Here's your weekly overview for <strong>${data.orgName}</strong>.</p>${narrativeBlock}<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:20px 0;"><div style="background:#eff6ff;border-radius:8px;padding:16px;text-align:center;"><p style="margin:0;font-size:28px;font-weight:bold;color:#1e40af;">${data.newLeads}</p><p style="margin:4px 0 0;font-size:13px;color:#6b7280;">New Leads</p></div><div style="background:#f0fdf4;border-radius:8px;padding:16px;text-align:center;"><p style="margin:0;font-size:28px;font-weight:bold;color:#166534;">${data.convertedLeads}</p><p style="margin:4px 0 0;font-size:13px;color:#6b7280;">Conversions</p></div><div style="background:#fefce8;border-radius:8px;padding:16px;text-align:center;"><p style="margin:0;font-size:28px;font-weight:bold;color:#854d0e;">${data.totalActivities}</p><p style="margin:4px 0 0;font-size:13px;color:#6b7280;">Activities Logged</p></div><div style="background:#faf5ff;border-radius:8px;padding:16px;text-align:center;"><p style="margin:0;font-size:28px;font-weight:bold;color:#7c3aed;">${data.closedTickets}</p><p style="margin:4px 0 0;font-size:13px;color:#6b7280;">Tickets Closed</p></div></div><table style="width:100%;border-collapse:collapse;margin:20px 0;"><tr><td style="padding:8px 0;font-size:13px;color:#6b7280;">Total Employees</td><td style="text-align:right;font-weight:bold;">${data.totalEmployees}</td></tr><tr><td style="padding:8px 0;font-size:13px;color:#6b7280;">Open Tickets</td><td style="text-align:right;font-weight:bold;">${data.openTickets}</td></tr><tr><td style="padding:8px 0;font-size:13px;color:#6b7280;">Pending Leave Requests</td><td style="text-align:right;font-weight:bold;">${data.pendingLeaves}</td></tr></table>${topPerformersSection}${pipelineSection}</div><div style="text-align:center;padding:16px;border-radius:0 0 10px 10px;background:#f9fafb;"><p style="color:#9ca3af;font-size:12px;margin:0;">This is an automated weekly recap from StreamlineOS.</p></div></body></html>`;
  }
}
