import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { clientAccounts, clientAccountActivities } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { throwOnAiFailure } from "./gateway-result.util";
import { loadLeadContext, trunc } from "./crm-brief-loaders";
import { CrmMeetingBriefService } from "./crm-meeting-brief.service";
import { CrmNlSearchService } from "./crm-nl-search.service";
import type { AccountSummaryInput, MeetingPrepInput, NlSearchInput } from "../dto/request.schemas";

interface CitationItem {
  id: string;
  title: string;
  snippet: string;
}

@Injectable()
export class CrmBriefService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly meetingBrief: CrmMeetingBriefService,
    private readonly nlSearchService: CrmNlSearchService,
  ) {}

  async accountSummary(orgId: string, input: AccountSummaryInput, userId?: string) {
    const ctx = await runInTenantTransaction(this.db, async (tx) => {
      const account = await tx.query.clientAccounts.findFirst({
        where: and(eq(clientAccounts.id, input.clientId), eq(clientAccounts.orgId, orgId)),
      });

      if (!account) return null;

      const [resolvedLead, activities] = await Promise.all([
        account.leadId ? loadLeadContext(tx, orgId, account.leadId) : Promise.resolve(null),
        tx
          .select({
            activityType: clientAccountActivities.activityType,
            description: clientAccountActivities.description,
            createdAt: clientAccountActivities.createdAt,
          })
          .from(clientAccountActivities)
          .where(eq(clientAccountActivities.clientAccountId, input.clientId))
          .orderBy(desc(clientAccountActivities.createdAt))
          .limit(20),
      ]);

      return { account, resolvedLead: resolvedLead ?? null, activities };
    }, { orgId });

    if (!ctx) throw new NotFoundException("Client account not found");
    const { account, resolvedLead, activities } = ctx;

    const investmentAmount = account.investmentAmount
      ? `₹${Number(account.investmentAmount).toLocaleString("en-IN")}`
      : "Not specified";
    const estimatedInvestment = account.estimatedInvestment
      ? `₹${Number(account.estimatedInvestment).toLocaleString("en-IN")}`
      : "Not specified";

    const activitiesText =
      activities.length === 0
        ? "No recent activities recorded."
        : activities
            .map((a) => {
              const date = a.createdAt ? new Date(a.createdAt).toLocaleDateString("en-IN") : "Unknown date";
              return `- [${date}] ${a.activityType}: ${trunc(a.description)}`;
            })
            .join("\n");

    const userPrompt = `Generate a professional 1-page account summary for an executive briefing.

CLIENT ACCOUNT DETAILS:
- Client Name: ${account.clientName}
- Email: ${account.clientEmail ?? "N/A"}
- Phone: ${account.clientPhone ?? "N/A"}
- Status: ${account.status}
- Plan: ${account.planName ?? "Not specified"}
- Investment Amount: ${investmentAmount}
- Estimated Investment: ${estimatedInvestment}
- Investment Date: ${account.investmentDate ? new Date(account.investmentDate).toLocaleDateString("en-IN") : "N/A"}
- Renewal Stage: ${account.renewalStage}
- Renewal Date: ${account.renewalDate ?? "Not set"}
- Conversion Notes: ${trunc(account.conversionNotes)}
- Renewal Notes: ${trunc(account.renewalNotes)}
- Account Created: ${new Date(account.createdAt).toLocaleDateString("en-IN")}

LEAD CONTEXT:
${resolvedLead ? `- Source: ${resolvedLead.source ?? "N/A"}, Priority: ${resolvedLead.priority ?? "N/A"}, City: ${resolvedLead.city ?? "N/A"}, Company: ${resolvedLead.company ?? "N/A"}` : "- No lead data available"}

RECENT ACTIVITIES (Last 20):
${activitiesText}

Please generate a comprehensive account summary with:
1. Executive Overview (2-3 sentences on account health and relationship status)
2. Investment Profile (current investment, plan details, financial standing)
3. Renewal Status (upcoming renewal details, stage, recommended actions)
4. Recent Engagement (summary of recent interactions and outcomes)
5. Key Risks & Opportunities (any flags or upsell potential)
6. Recommended Next Steps (2-3 specific actions for the account manager)`;

    const result = await this.gateway.invokeText({
      actor: { orgId, userId: userId ?? null },
      feature: "crm.account-summary",
      prompt: {
        system:
          "You are an executive assistant preparing client briefing documents for an Indian investment firm. Generate concise, professional account summaries that help account managers and executives quickly understand the full picture of a client relationship. Be data-driven and specific.",
        user: userPrompt,
      },
      tier: "standard",
      maxTokens: 1024,
      charge: true,
      dedupe: true,
    });

    if (!result.ok) throwOnAiFailure(result);
    return { summary: result.data, clientName: account.clientName, generatedAt: new Date().toISOString() };
  }

  async meetingPrep(orgId: string, input: MeetingPrepInput, userId?: string) {
    return this.meetingBrief.meetingPrep(orgId, input, userId);
  }

  async nlSearch(orgId: string, input: NlSearchInput, userId?: string) {
    return this.nlSearchService.nlSearch(orgId, input, userId);
  }

  async meetingFollowUpDraft(
    orgId: string,
    input: {
      meetingTitle: string;
      attendeeType: "lead" | "client";
      attendeeId: number;
      outcome: string;
      actionItems?: string[];
      scheduledAt: string;
      notes?: string;
    },
    userId?: string,
  ) {
    return this.meetingBrief.meetingFollowUpDraft(orgId, input, userId);
  }

  async accountSummaryWithCitations(orgId: string, input: AccountSummaryInput, userId?: string) {
    const citations = await runInTenantTransaction(this.db, async (tx) => {
      const account = await tx.query.clientAccounts.findFirst({
        where: and(eq(clientAccounts.id, input.clientId), eq(clientAccounts.orgId, orgId)),
      });

      if (!account) return null;

      const [resolvedLead, activities] = await Promise.all([
        account.leadId ? loadLeadContext(tx, orgId, account.leadId) : Promise.resolve(null),
        tx
          .select({
            activityType: clientAccountActivities.activityType,
            description: clientAccountActivities.description,
            createdAt: clientAccountActivities.createdAt,
          })
          .from(clientAccountActivities)
          .where(eq(clientAccountActivities.clientAccountId, input.clientId))
          .orderBy(desc(clientAccountActivities.createdAt))
          .limit(20),
      ]);

      const built: CitationItem[] = [
        {
          id: `account-${account.id}`,
          title: "Account Profile",
          snippet: `${account.clientName} — Plan: ${account.planName ?? "N/A"}, Status: ${account.status}, Renewal Stage: ${account.renewalStage}`,
        },
      ];
      if (account.investmentAmount) {
        built.push({
          id: `account-investment-${account.id}`,
          title: "Investment Details",
          snippet: `Investment: ₹${Number(account.investmentAmount).toLocaleString("en-IN")}, Date: ${account.investmentDate ? new Date(account.investmentDate).toLocaleDateString("en-IN") : "N/A"}`,
        });
      }
      if (activities.length > 0) {
        built.push({
          id: `account-activities-${account.id}`,
          title: "Recent Activity Summary",
          snippet: `${activities.length} activities recorded. Latest: ${activities[0]?.activityType ?? "N/A"} on ${activities[0]?.createdAt ? new Date(activities[0].createdAt).toLocaleDateString("en-IN") : "N/A"}`,
        });
      }
      if (resolvedLead) {
        built.push({
          id: `lead-${resolvedLead.id}`,
          title: "Lead Context",
          snippet: `Source: ${resolvedLead.source ?? "N/A"}, Priority: ${resolvedLead.priority ?? "N/A"}, City: ${resolvedLead.city ?? "N/A"}`,
        });
      }
      return built;
    }, { orgId });

    if (!citations) throw new NotFoundException("Client account not found");

    const base = await this.accountSummary(orgId, input, userId);
    return { ...base, citations };
  }
}
