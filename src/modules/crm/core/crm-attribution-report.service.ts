import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { crmLeadTouchpoints, crmCampaigns, deals } from "../../../db/schema";
import { businessParties, leadPartyMap } from "../../../db/schema/party";
import { PARTY_OF_LEAD } from "../crm-party-reads";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { resolveWonStageKeys } from "./won-stage-keys";

export interface CampaignAttribution {
  campaignId: number | null;
  campaignName: string;
  touchCount: number;
  convertedLeads: number;
  dealRevenueCents: number;
  roi: number;
}

/**
 * The touch log, reduced to one row per `(campaign, lead)` — the grain both
 * reports aggregate at.
 *
 * `crm_lead_touchpoints` is a log, not a set: nothing makes a row unique per
 * `(org, lead, touch_type)` — the table carries no such constraint and
 * `recordTouch` is a bare INSERT — so a lead that re-enters the funnel
 * legitimately holds two `first_touch` rows. Reducing to this grain before any
 * deal is joined is what stops a won deal being summed once per touchpoint.
 *
 * `touchRows` is carried through rather than discarded, because `touchCount` is
 * the one figure in the report that genuinely asks how many touches there were.
 */
function firstTouchGrain(db: Db, orgId: string) {
  return db
    .select({
      campaignId: crmLeadTouchpoints.campaignId,
      leadId: crmLeadTouchpoints.leadId,
      touchRows: sql<number>`count(*)`.as("touch_rows"),
    })
    .from(crmLeadTouchpoints)
    .where(and(
      eq(crmLeadTouchpoints.orgId, orgId),
      eq(crmLeadTouchpoints.touchType, "first_touch"),
    ))
    .groupBy(crmLeadTouchpoints.campaignId, crmLeadTouchpoints.leadId)
    .as("touch_grain");
}

type TouchGrain = ReturnType<typeof firstTouchGrain>;

/**
 * The same grain, over the touches that arrived last.
 *
 * Matching on equality with `MAX(occurred_at)` keeps every row of a tie, which
 * is right for counting touches and wrong for summing money. Both stay true
 * here: a tie contributes `touch_rows = 2` to one `(campaign, lead)` pair, so
 * the deal behind that lead is still joined exactly once.
 */
function lastTouchGrain(db: Db, orgId: string): TouchGrain {
  const lastTouchSub = db
    .select({
      leadId: crmLeadTouchpoints.leadId,
      maxOccurredAt: sql<Date>`MAX(${crmLeadTouchpoints.occurredAt})`.as("max_occurred_at"),
    })
    .from(crmLeadTouchpoints)
    .where(eq(crmLeadTouchpoints.orgId, orgId))
    .groupBy(crmLeadTouchpoints.leadId)
    .as("last_touch_sub");

  return db
    .select({
      campaignId: crmLeadTouchpoints.campaignId,
      leadId: crmLeadTouchpoints.leadId,
      touchRows: sql<number>`count(*)`.as("touch_rows"),
    })
    .from(crmLeadTouchpoints)
    .innerJoin(lastTouchSub, and(
      eq(crmLeadTouchpoints.leadId, lastTouchSub.leadId),
      eq(crmLeadTouchpoints.occurredAt, lastTouchSub.maxOccurredAt),
    ))
    .where(eq(crmLeadTouchpoints.orgId, orgId))
    .groupBy(crmLeadTouchpoints.campaignId, crmLeadTouchpoints.leadId)
    .as("touch_grain");
}

/**
 * Which campaign earned the money, counted once per deal.
 *
 * Both reports answer the same question under a different rule for which touch
 * gets the credit, and both are money on a screen — so the arithmetic matters
 * more than the shape of the query.
 *
 * Summing `deals.value` across a join that starts from the raw touch log
 * multiplies each won deal by however many touchpoint rows sit behind it, and
 * `count(converted_at)` counts joined rows rather than leads. So the log is
 * reduced to one row per `(campaign, lead)` first, and the deals are
 * pre-aggregated to one row per lead. Every join in `aggregateByCampaign` is
 * then many-to-one on a key the database enforces — `crm_campaigns.id`,
 * `lead_party_map (organization_id, lead_id)`, `business_parties.party_id` — so
 * the outer result holds exactly one row per `(campaign, lead)` and cannot fan
 * out. Revenue is counted once, and `count(converted_at)` becomes a
 * distinct-lead count because a lead appears once.
 *
 * `SUM(DISTINCT deals.value)` would make the first symptom go away and is not a
 * fix: two different deals worth the same amount would collapse into one.
 * Deduplication has to happen on the identity of the thing, never on its value,
 * which is why the reduction is by lead and the sum stays a plain `SUM`.
 */
@Injectable()
export class CrmAttributionReportService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getFirstTouchAttribution(orgId: string): Promise<CampaignAttribution[]> {
    const wonStageKeys = await resolveWonStageKeys(this.db, orgId);
    return this.aggregateByCampaign(orgId, firstTouchGrain(this.db, orgId), wonStageKeys);
  }

  async getLastTouchAttribution(orgId: string): Promise<CampaignAttribution[]> {
    const wonStageKeys = await resolveWonStageKeys(this.db, orgId);
    return this.aggregateByCampaign(orgId, lastTouchGrain(this.db, orgId), wonStageKeys);
  }

  /**
   * The half both rules share: money and leads, per campaign.
   *
   * One method rather than two copies — two copies of an aggregate over the
   * same quarter is precisely how two campaign revenue figures come to disagree.
   */
  private async aggregateByCampaign(
    orgId: string,
    touchGrain: TouchGrain,
    wonStageKeys: string[],
  ): Promise<CampaignAttribution[]> {
    /**
     * Won revenue, one row per lead, so the join below cannot multiply a deal.
     *
     * A lead with two won deals is one row carrying their sum, which is what
     * keeps two deals of equal value distinct — the distinctness lives in the
     * grouping key, never in the amount.
     */
    const wonRevenue = this.db
      .select({
        leadId: deals.leadId,
        revenue: sql<string>`SUM(${deals.value}::numeric)`.as("revenue"),
      })
      .from(deals)
      .where(and(
        eq(deals.orgId, orgId),
        isNull(deals.deletedAt),
        isNotNull(deals.leadId),
        inArray(deals.stage, wonStageKeys),
      ))
      .groupBy(deals.leadId)
      .as("won_revenue");

    const rows = await this.db
      .select({
        campaignId: touchGrain.campaignId,
        campaignName: sql<string>`COALESCE(${crmCampaigns.name}, 'Direct/Unknown')`,
        touchCount: sql<number>`COALESCE(SUM(${touchGrain.touchRows}), 0)::int`,
        convertedLeads: sql<number>`count(${businessParties.convertedAt})::int`,
        totalRevenue: sql<number>`COALESCE(SUM(${wonRevenue.revenue}), 0)::float`,
        spend: sql<number>`COALESCE(MAX(${crmCampaigns.spend}::numeric), 0)::float`,
      })
      .from(touchGrain)
      .leftJoin(crmCampaigns, and(
        eq(touchGrain.campaignId, crmCampaigns.id),
        eq(crmCampaigns.orgId, orgId),
      ))
      .leftJoin(leadPartyMap, and(
        eq(touchGrain.leadId, leadPartyMap.leadId),
        eq(leadPartyMap.organizationId, orgId),
      ))
      .leftJoin(businessParties, PARTY_OF_LEAD)
      /**
       * Keyed off the party map rather than the touchpoint's own `lead_id`, as
       * it always was: a touchpoint whose lead has no mapping row resolves to no
       * party and therefore to no revenue, and moving the key here would quietly
       * start crediting those deals.
       */
      .leftJoin(wonRevenue, eq(wonRevenue.leadId, leadPartyMap.leadId))
      .groupBy(touchGrain.campaignId, crmCampaigns.name);

    return rows.map((r) => this.toAttribution(r));
  }

  async recordTouch(params: {
    orgId: string;
    leadId: number;
    campaignId?: number | null;
    sourceKey: string;
    medium?: string | null;
    utmData?: Record<string, string> | null;
    touchType: 'first_touch' | 'interaction' | 'conversion';
    occurredAt?: Date;
  }): Promise<void> {
    await this.db.insert(crmLeadTouchpoints).values({
      orgId: params.orgId,
      leadId: params.leadId,
      campaignId: params.campaignId ?? null,
      sourceKey: params.sourceKey,
      medium: params.medium ?? null,
      utmData: params.utmData ?? null,
      touchType: params.touchType,
      occurredAt: params.occurredAt ?? new Date(),
    });
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
