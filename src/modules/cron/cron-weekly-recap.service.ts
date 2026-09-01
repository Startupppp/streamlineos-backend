import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, gte, isNull, sql } from "drizzle-orm";
import { subDays, format } from "date-fns";
import {
  leadActivities,
  leaveRequests,
  organizationMembers,
  organizations,
  tickets,
  users,
} from "../../db/schema";
import { businessParties, leadPartyMap } from "../../db/schema/party";
import { PARTY_OF_LEAD, leadStatus } from "../crm/crm-party-reads";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AiGatewayService } from "../ai/core/gateway/ai-gateway.service";
import { getWeeklyRecapEmailTemplate } from "../email/templates/reports";
import { appUrl } from "../email/app-url";
import { logger } from "../../common/logger/logger.service";
import { forEachOrg } from "../../common/tenant";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";

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
    private readonly dispatch: NotificationDispatchService,
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
          .select({ userId: users.id, email: users.email, name: users.name })
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

        /*
         * Every lead figure below is counted over `lead_party_map` joined to the
         * party, never over `business_parties` alone: a tenant's parties include
         * the ones minted from `clients`, `contacts` and `crm_organizations`, and
         * counting those as leads would inflate the recap the week the CRM was
         * first used. The map is what says "this party is a lead".
         *
         * No `deleted_at` predicate on any of them, which is not an oversight:
         * `leads` has the column and this report has never filtered on it, so a
         * deleted lead has always been counted and adding the filter here would
         * change the numbers an owner has been reading. `0241` carried
         * `leads.created_at` and `.updated_at` onto the party, so the windows are
         * the same rows.
         */
        const [newLeadCount] = await tx
          .select({ count: count() })
          .from(leadPartyMap)
          .innerJoin(businessParties, PARTY_OF_LEAD)
          .where(
            and(
              eq(leadPartyMap.organizationId, orgId),
              gte(businessParties.createdAt, weekStart),
            ),
          );

        const [convertedCount] = await tx
          .select({ count: count() })
          .from(leadPartyMap)
          .innerJoin(businessParties, PARTY_OF_LEAD)
          .where(
            and(
              eq(leadPartyMap.organizationId, orgId),
              // The coalesced expression, not the raw column: `lifecycle_stage`
              // is nullable on the party where `leads.status` was NOT NULL, and
              // comparing the raw column would silently exclude a lead that never
              // left NEW. Same reason every other reader uses `leadStatus`.
              eq(leadStatus, "CONVERTED"),
              gte(businessParties.updatedAt, weekStart),
            ),
          );

        const [activityCount] = await tx
          .select({ count: count() })
          .from(leadActivities)
          // The map alone, with no party joined: this counts activities and only
          // needs the tenant predicate the legacy join to `leads.org_id` supplied.
          .innerJoin(
            leadPartyMap,
            and(
              eq(leadPartyMap.leadId, leadActivities.leadId),
              eq(leadPartyMap.organizationId, orgId),
            ),
          )
          .where(gte(leadActivities.createdAt, weekStart));

        const [openTicketCount] = await tx
          .select({ count: count() })
          .from(tickets)
          .where(
            and(eq(tickets.orgId, orgId), isNull(tickets.deletedAt), sql`${tickets.status} NOT IN ('DONE', 'CANCELLED')`),
          );

        const [closedTicketCount] = await tx
          .select({ count: count() })
          .from(tickets)
          .where(
            and(eq(tickets.orgId, orgId), isNull(tickets.deletedAt), eq(tickets.status, "DONE"), gte(tickets.updatedAt, weekStart)),
          );

        const [pendingLeaveCount] = await tx
          .select({ count: count() })
          .from(leaveRequests)
          .where(and(eq(leaveRequests.orgId, orgId), eq(leaveRequests.status, "PENDING")));

        const pipelineRaw = await tx
          .select({ status: leadStatus, count: count() })
          .from(leadPartyMap)
          .innerJoin(businessParties, PARTY_OF_LEAD)
          .where(eq(leadPartyMap.organizationId, orgId))
          .groupBy(leadStatus);

        const leaderboardRaw = await tx
          .select({
            name: users.name,
            converted: sql<number>`COUNT(CASE WHEN ${leadStatus} = 'CONVERTED' THEN 1 END)::int`,
          })
          .from(leadPartyMap)
          .innerJoin(businessParties, PARTY_OF_LEAD)
          // `owner_user_id` is `leads.assigned_to_id` under the merged model's
          // name, so "top performers" still means the same people.
          .innerJoin(users, eq(users.id, businessParties.ownerUserId))
          .where(
            and(
              eq(leadPartyMap.organizationId, orgId),
              sql`${businessParties.ownerUserId} IS NOT NULL`,
            ),
          )
          .groupBy(businessParties.ownerUserId, users.name)
          // `created_at` is not in play here and the count ties freely across a
          // small team, so the owner id decides which five appear rather than the
          // heap order the map join changes.
          .orderBy(
            sql`COUNT(CASE WHEN ${leadStatus} = 'CONVERTED' THEN 1 END) DESC`,
            sql`${businessParties.ownerUserId} ASC`,
          )
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
          if (!owner.email || !owner.userId) continue;
          await this.dispatch.emit({
            orgId,
            eventKey: "system.weekly_recap",
            targetUserIds: [owner.userId],
            title: `Your week at ${orgRow.name} — ${weekRange}`,
            message: aiNarrative || "Your weekly executive recap is ready.",
            link: `${appUrl()}/dashboard`,
            emailHtml: html,
            dedupeKey: `weekly-recap:${weekStart.toISOString().slice(0, 10)}`,
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
        charge: false,
        prompt: { system, user },
      });

      if (!result.ok) return "";
      return result.data;
    } catch {
      return "";
    }
  }
}
