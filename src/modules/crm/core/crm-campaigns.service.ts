import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { crmCampaigns, crmOptions, crmPipelineStages, deals } from "../../../db/schema";
import { businessParties, leadPartyMap } from "../../../db/schema/party";
import { PARTY_OF_LEAD, leadPriority, leadSource, leadStatus } from "../crm-party-reads";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { resolveLeadStatusSemantics } from "../../leads/lead-status-semantics";
import { buildCursorPage, buildIdCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBefore } from "../../../common/pagination/keyset";
import type { CampaignCreateInput, CampaignUpdateInput, CampaignListQuery } from "./dto/campaigns.schemas";

@Injectable()
export class CrmCampaignsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, query: CampaignListQuery) {
    const limit = query.limit;
    const position = decodeCursor(query.cursor);
    const baseConditions = [eq(crmCampaigns.orgId, orgId), isNull(crmCampaigns.deletedAt)];
    if (query.status) baseConditions.push(eq(crmCampaigns.status, query.status as never));
    const where = position
      ? and(...baseConditions, keysetBefore(crmCampaigns.createdAt, crmCampaigns.id, position))
      : and(...baseConditions);

    const [rows, totalResult] = await Promise.all([
      this.db.select().from(crmCampaigns).where(where)
        .orderBy(desc(crmCampaigns.createdAt), desc(crmCampaigns.id))
        .limit(limit + 1),
      query.cursor === undefined
        ? this.db.select({ c: count() }).from(crmCampaigns).where(and(...baseConditions))
        : Promise.resolve(null),
    ]);

    const page = buildCursorPage(rows, limit, (r) => ({ sortValue: r.createdAt.toISOString(), id: String(r.id) }));
    return {
      items: page.data,
      hasMore: page.pagination.hasMore,
      nextCursor: page.pagination.nextCursor,
      total: totalResult ? Number(totalResult[0]?.c ?? 0) : undefined,
    };
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
      ownerId: input.ownerId ?? null,
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
        ...(input.budgetAllocated !== undefined && {
          budgetAllocated: input.budgetAllocated === null ? null : input.budgetAllocated.toString(),
        }),
        ...(input.utmCampaignKey !== undefined && { utmCampaignKey: input.utmCampaignKey }),
        ...(input.status !== undefined && { status: input.status as never }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.targetAudience !== undefined && { targetAudience: input.targetAudience }),
        ...(input.ownerId !== undefined && { ownerId: input.ownerId }),
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
      this.db.select({ status: leadStatus, cnt: count() })
        .from(leadPartyMap)
        .innerJoin(businessParties, PARTY_OF_LEAD)
        .where(and(
          eq(leadPartyMap.organizationId, orgId),
          eq(businessParties.acquisitionCampaignId, campaignId),
        ))
        .groupBy(leadStatus),

      this.db.select({ total: sql<number>`COALESCE(SUM(${deals.value}::numeric), 0)::float` })
        .from(deals)
        .innerJoin(leadPartyMap, and(
          eq(deals.leadId, leadPartyMap.leadId),
          eq(leadPartyMap.organizationId, orgId),
        ))
        .innerJoin(businessParties, and(
          PARTY_OF_LEAD,
          eq(businessParties.acquisitionCampaignId, campaignId),
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

  async getCampaignLeads(orgId: string, campaignId: number, cursor?: string) {
    const safeLimit = 50;
    const afterId = cursor !== undefined ? Number(cursor) : undefined;
    const baseWhere = and(
      eq(leadPartyMap.organizationId, orgId),
      eq(businessParties.acquisitionCampaignId, campaignId),
      afterId !== undefined && !Number.isNaN(afterId) ? gt(leadPartyMap.leadId, afterId) : undefined,
    );

    const [rows, totalResult] = await Promise.all([
      this.db
        .select({
          id: leadPartyMap.leadId,
          orgId: businessParties.organizationId,
          name: businessParties.name,
          email: businessParties.email,
          phone: businessParties.phone,
          source: leadSource,
          campaignId: businessParties.acquisitionCampaignId,
          status: leadStatus,
          priority: leadPriority,
          potentialValue: businessParties.expectedValue,
          assignedToId: businessParties.ownerUserId,
          company: businessParties.companyName,
          score: businessParties.qualificationScore,
          followUpDate: businessParties.nextFollowUpAt,
          convertedAt: businessParties.convertedAt,
          createdAt: businessParties.createdAt,
          updatedAt: businessParties.updatedAt,
        })
        .from(leadPartyMap)
        .innerJoin(businessParties, PARTY_OF_LEAD)
        .where(baseWhere)
        .orderBy(leadPartyMap.leadId)
        .limit(safeLimit + 1),
      cursor === undefined
        ? this.db.select({ c: count() })
            .from(leadPartyMap)
            .innerJoin(businessParties, PARTY_OF_LEAD)
            .where(and(eq(leadPartyMap.organizationId, orgId), eq(businessParties.acquisitionCampaignId, campaignId)))
        : Promise.resolve(null),
    ]);

    const page = buildIdCursorPage(rows, safeLimit, (r) => r.id);
    return {
      items: page.data,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor !== null ? String(page.nextCursor) : null,
      total: totalResult ? Number(totalResult[0]?.c ?? 0) : undefined,
    };
  }
}
