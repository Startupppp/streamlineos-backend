import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { crmCampaigns, crmOptions, crmPipelineStages, leads, deals } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { resolveLeadStatusSemantics } from "../../leads/lead-status-semantics";
import type { CampaignCreateInput, CampaignUpdateInput, CampaignListQuery } from "./dto/campaigns.schemas";

@Injectable()
export class CrmCampaignsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, query: CampaignListQuery) {
    const offset = (query.page - 1) * query.limit;
    const conditions = [eq(crmCampaigns.orgId, orgId), isNull(crmCampaigns.deletedAt)];
    if (query.status) conditions.push(eq(crmCampaigns.status, query.status as never));

    const [items, [{ total }]] = await Promise.all([
      this.db.select().from(crmCampaigns).where(and(...conditions))
        .limit(query.limit).offset(offset),
      this.db.select({ total: count() }).from(crmCampaigns).where(and(...conditions)),
    ]);

    return { items, total, page: query.page, limit: query.limit };
  }

  async create(orgId: string, input: CampaignCreateInput) {
    const [campaign] = await this.db.insert(crmCampaigns).values({
      orgId,
      name: input.name,
      channel: input.channel,
      startDate: input.startDate,
      endDate: input.endDate,
      utmCampaignKey: input.utmCampaignKey,
      budgetAllocated: input.budgetAllocated?.toString(),
      description: input.description,
      targetAudience: input.targetAudience,
    }).returning();
    return campaign;
  }

  async update(orgId: string, campaignId: number, input: CampaignUpdateInput) {
    const [updated] = await this.db.update(crmCampaigns)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.channel !== undefined && { channel: input.channel }),
        ...(input.startDate !== undefined && { startDate: input.startDate }),
        ...(input.endDate !== undefined && { endDate: input.endDate }),
        ...(input.budgetAllocated !== undefined && { budgetAllocated: input.budgetAllocated.toString() }),
        ...(input.utmCampaignKey !== undefined && { utmCampaignKey: input.utmCampaignKey }),
        ...(input.status !== undefined && { status: input.status as never }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.targetAudience !== undefined && { targetAudience: input.targetAudience }),
      })
      .where(and(eq(crmCampaigns.id, campaignId), eq(crmCampaigns.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Campaign not found");
    return updated;
  }

  async remove(orgId: string, campaignId: number) {
    const [deleted] = await this.db.update(crmCampaigns)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(crmCampaigns.id, campaignId),
          eq(crmCampaigns.orgId, orgId),
          isNull(crmCampaigns.deletedAt),
        ),
      )
      .returning({ id: crmCampaigns.id });
    if (!deleted) throw new NotFoundException("Campaign not found");
    return { success: true };
  }

  async getCampaignRoi(orgId: string, campaignId: number) {
    const [campaign, statusOptions, wonStagesRows] = await Promise.all([
      this.db.query.crmCampaigns.findFirst({
        where: and(
          eq(crmCampaigns.id, campaignId),
          eq(crmCampaigns.orgId, orgId),
          isNull(crmCampaigns.deletedAt),
        ),
      }),
      this.db.select().from(crmOptions)
        .where(and(eq(crmOptions.orgId, orgId), eq(crmOptions.type, "lead_status"))),
      this.db.select({ key: crmPipelineStages.key }).from(crmPipelineStages)
        .where(and(eq(crmPipelineStages.orgId, orgId), eq(crmPipelineStages.stageType, "won"))),
    ]);
    if (!campaign) throw new NotFoundException("Campaign not found");
    const semantics = resolveLeadStatusSemantics(statusOptions);

    const wonStageKeys = wonStagesRows.length ? wonStagesRows.map((s) => s.key) : ["WON", "Closed Won"];

    const [leadCounts, revenueResult] = await Promise.all([
      this.db.select({ status: leads.status, cnt: count() })
        .from(leads)
        .where(and(eq(leads.orgId, orgId), eq(leads.campaignId, campaignId)))
        .groupBy(leads.status),

      this.db.select({ total: sql<number>`COALESCE(SUM(${deals.value}::numeric), 0)::float` })
        .from(deals)
        .innerJoin(leads, and(
          eq(deals.leadId, leads.id),
          eq(leads.campaignId, campaignId),
          eq(leads.orgId, orgId),
        ))
        .where(and(
          eq(deals.orgId, orgId), isNull(deals.deletedAt),
          inArray(deals.stage, wonStageKeys),
        )),
    ]);

    const byStatus: Record<string, number> = {};
    for (const r of leadCounts) byStatus[r.status] = r.cnt;

    const totalLeads = Object.values(byStatus).reduce((s, n) => s + n, 0);
    const converted = semantics.convertedKeys.reduce((s, k) => s + (byStatus[k] ?? 0), 0);
    const revenue = revenueResult[0]?.total ?? 0;
    const revenueCents = Math.round(revenue * 100);
    const spend = Number(campaign.spend ?? 0);
    const roi = spend > 0 ? Math.round(((revenue - spend) / spend) * 10000) / 100 : 0;

    return {
      spend,
      leads: totalLeads,
      converted,
      deals: converted,
      revenueCents,
      roi,
    };
  }

  async getCampaignLeads(orgId: string, campaignId: number, page: number, limit: number) {
    const safeLimit = Math.min(limit, 50);
    const offset = (page - 1) * safeLimit;

    const [items, [{ total }]] = await Promise.all([
      this.db
        .select({
          id: leads.id,
          orgId: leads.orgId,
          name: leads.name,
          email: leads.email,
          phone: leads.phone,
          source: leads.source,
          campaignId: leads.campaignId,
          status: leads.status,
          priority: leads.priority,
          potentialValue: leads.potentialValue,
          assignedToId: leads.assignedToId,
          company: leads.company,
          score: leads.score,
          followUpDate: leads.followUpDate,
          convertedAt: leads.convertedAt,
          createdAt: leads.createdAt,
          updatedAt: leads.updatedAt,
        })
        .from(leads)
        .where(and(eq(leads.orgId, orgId), eq(leads.campaignId, campaignId)))
        .limit(safeLimit)
        .offset(offset),
      this.db.select({ total: count() }).from(leads)
        .where(and(eq(leads.orgId, orgId), eq(leads.campaignId, campaignId))),
    ]);

    return { items, total, page, limit: safeLimit };
  }
}
