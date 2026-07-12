import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql, inArray } from "drizzle-orm";
import { crmLeadTouchpoints, crmCampaigns, crmPipelineStages, leads, deals } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";

export interface CampaignAttribution {
  campaignId: number | null;
  campaignName: string;
  touchCount: number;
  convertedLeads: number;
  dealRevenueCents: number;
  roi: number;
}

@Injectable()
export class CrmAttributionReportService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getFirstTouchAttribution(orgId: string): Promise<CampaignAttribution[]> {
    const wonStageKeys = await this.resolveWonStageKeys(orgId);

    const rows = await this.db
      .select({
        campaignId: crmLeadTouchpoints.campaignId,
        campaignName: sql<string>`COALESCE(${crmCampaigns.name}, 'Direct/Unknown')`,
        touchCount: sql<number>`count(${crmLeadTouchpoints.id})::int`,
        convertedLeads: sql<number>`count(${leads.convertedAt})::int`,
        totalRevenue: sql<number>`COALESCE(SUM(${deals.value}::numeric), 0)::float`,
        spend: sql<number>`COALESCE(MAX(${crmCampaigns.spend}::numeric), 0)::float`,
      })
      .from(crmLeadTouchpoints)
      .leftJoin(crmCampaigns, and(
        eq(crmLeadTouchpoints.campaignId, crmCampaigns.id),
        eq(crmCampaigns.orgId, orgId),
      ))
      .leftJoin(leads, and(
        eq(crmLeadTouchpoints.leadId, leads.id),
        eq(leads.orgId, orgId),
      ))
      .leftJoin(deals, and(
        eq(deals.leadId, leads.id),
        eq(deals.orgId, orgId),
        inArray(deals.stage, wonStageKeys),
      ))
      .where(and(
        eq(crmLeadTouchpoints.orgId, orgId),
        eq(crmLeadTouchpoints.touchType, "first_touch"),
      ))
      .groupBy(crmLeadTouchpoints.campaignId, crmCampaigns.name);

    return rows.map((r) => this.toAttribution(r));
  }

  async getLastTouchAttribution(orgId: string): Promise<CampaignAttribution[]> {
    const wonStageKeys = await this.resolveWonStageKeys(orgId);

    const lastTouchSub = this.db
      .select({
        leadId: crmLeadTouchpoints.leadId,
        maxOccurredAt: sql<Date>`MAX(${crmLeadTouchpoints.occurredAt})`.as("max_occurred_at"),
      })
      .from(crmLeadTouchpoints)
      .where(eq(crmLeadTouchpoints.orgId, orgId))
      .groupBy(crmLeadTouchpoints.leadId)
      .as("last_touch_sub");

    const rows = await this.db
      .select({
        campaignId: crmLeadTouchpoints.campaignId,
        campaignName: sql<string>`COALESCE(${crmCampaigns.name}, 'Direct/Unknown')`,
        touchCount: sql<number>`count(${crmLeadTouchpoints.id})::int`,
        convertedLeads: sql<number>`count(${leads.convertedAt})::int`,
        totalRevenue: sql<number>`COALESCE(SUM(${deals.value}::numeric), 0)::float`,
        spend: sql<number>`COALESCE(MAX(${crmCampaigns.spend}::numeric), 0)::float`,
      })
      .from(crmLeadTouchpoints)
      .innerJoin(lastTouchSub, and(
        eq(crmLeadTouchpoints.leadId, lastTouchSub.leadId),
        eq(crmLeadTouchpoints.occurredAt, lastTouchSub.maxOccurredAt),
      ))
      .leftJoin(crmCampaigns, and(
        eq(crmLeadTouchpoints.campaignId, crmCampaigns.id),
        eq(crmCampaigns.orgId, orgId),
      ))
      .leftJoin(leads, and(
        eq(crmLeadTouchpoints.leadId, leads.id),
        eq(leads.orgId, orgId),
      ))
      .leftJoin(deals, and(
        eq(deals.leadId, leads.id),
        eq(deals.orgId, orgId),
        inArray(deals.stage, wonStageKeys),
      ))
      .where(eq(crmLeadTouchpoints.orgId, orgId))
      .groupBy(crmLeadTouchpoints.campaignId, crmCampaigns.name);

    return rows.map((r) => this.toAttribution(r));
  }

  private async resolveWonStageKeys(orgId: string): Promise<string[]> {
    const wonStages = await this.db
      .select({ key: crmPipelineStages.key })
      .from(crmPipelineStages)
      .where(and(
        eq(crmPipelineStages.orgId, orgId),
        eq(crmPipelineStages.stageType, "won"),
      ));
    return wonStages.length ? wonStages.map((s) => s.key) : ["WON", "Closed Won"];
  }

  private toAttribution(r: {
    campaignId: number | null;
    campaignName: string;
    touchCount: number;
    convertedLeads: number;
    totalRevenue: number;
    spend: number;
  }): CampaignAttribution {
    const revenueCents = Math.round(r.totalRevenue * 100);
    const spend = r.spend;
    const roi = spend > 0 ? Math.round(((r.totalRevenue - spend) / spend) * 10000) / 100 : 0;
    return {
      campaignId: r.campaignId,
      campaignName: r.campaignName,
      touchCount: r.touchCount,
      convertedLeads: r.convertedLeads,
      dealRevenueCents: revenueCents,
      roi,
    };
  }
}
