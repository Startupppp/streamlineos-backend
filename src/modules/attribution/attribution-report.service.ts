import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  activities,
  crmCampaigns,
  crmLeadTouchpoints,
  deals,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { resolveWonStageKeys } from "../crm/core/won-stage-keys";
import { attributeDeal } from "./attribution-allocate";
import {
  ATTRIBUTION_MODEL_DESCRIPTIONS,
  type AttributionModel,
} from "./attribution-models";
import {
  makeTouchKey,
  normaliseChannel,
  orderTouches,
  touchesUpTo,
  type AttributionTouch,
} from "./attribution-touch";

/**
 * The multi-touch report — the caller the weighting library was written for.
 *
 * `CrmAttributionReportService` answers the same question in SQL, one query per
 * model, and can therefore only ever answer it two ways: a `GROUP BY` gives one
 * row per campaign, and there is no place in a `GROUP BY` to say that a deal's
 * value should be split across the four rows that earned it. That is why the
 * shipped report is first-touch and last-touch and nothing else, and why the
 * division happens here instead: the touches are read once, and every model is
 * a different arithmetic over the same set.
 *
 * Nothing is written. This is a projection over `crm_lead_touchpoints`,
 * `activities` and `deals`, recomputed per request — there is no attribution
 * table to fall out of date, and changing the model cannot change what happened.
 */

/**
 * The bound on how much of a tenant's history one request will divide.
 *
 * The whole point of the design is that the arithmetic runs in the process
 * rather than in a `GROUP BY`, which means the touch set is materialised — so
 * an organisation with a decade of won deals would otherwise pull all of them
 * into one response. The window is the most recently created won deals, which
 * is the slice a report is asked about, and `truncated` says plainly when the
 * answer is a window rather than the whole history.
 */
export const MAX_DEALS_PER_REPORT = 2000;

export interface AttributedCampaign {
  /** Null is the real "no campaign" bucket — sales activity and direct leads. */
  campaignId: number | null;
  campaignName: string;
  /**
   * The campaign is soft-deleted but still holds credit.
   *
   * Surfaced rather than filtered: dropping the row would move its revenue into
   * the unattributed bucket and understate a real campaign, and dropping only
   * the name would leave an unreadable row. The reader is told instead.
   */
  campaignArchived: boolean;
  touchCount: number;
  dealCount: number;
  attributedRevenueMinor: number;
}

export interface AttributedChannel {
  channel: string;
  touchCount: number;
  attributedRevenueMinor: number;
}

export interface AttributionReport {
  model: AttributionModel;
  modelDescription: string;
  /** Echoed so a saved report says which curve produced it. */
  halfLifeDays: number;
  dealsConsidered: number;
  dealsAttributed: number;
  /** Won deals whose timeline holds nothing on or before the close. */
  dealsWithoutTouches: number;
  truncated: boolean;
  totalRevenueMinor: number;
  attributedRevenueMinor: number;
  /** `totalRevenueMinor - attributedRevenueMinor`, and never anything else. */
  unattributableRevenueMinor: number;
  campaigns: AttributedCampaign[];
  channels: AttributedChannel[];
}

interface WonDealRow {
  dealId: number;
  leadId: number | null;
  valueMinor: number;
  actualCloseDate: string | null;
  updatedAt: Date;
}

/**
 * The per-campaign running total, which is not the shape that is returned.
 *
 * `dealCount` is the number of DEALS a campaign touched, not the number of
 * touches it made, so the accumulator has to hold the set of deal ids while it
 * runs. Keeping that set off the response type means nothing has to remember to
 * strip it, and no cast is needed to pretend it was never there.
 */
interface CampaignAccumulator {
  campaignId: number | null;
  campaignName: string;
  campaignArchived: boolean;
  touchCount: number;
  dealIds: Set<number>;
  attributedRevenueMinor: number;
}

@Injectable()
export class AttributionReportService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getReport(
    orgId: string,
    model: AttributionModel,
    halfLifeDays: number,
  ): Promise<AttributionReport> {
    const wonStageKeys = await resolveWonStageKeys(this.db, orgId);
    const { wonDeals, truncated } = await this.loadWonDeals(orgId, wonStageKeys);

    const leadIds = unique(
      wonDeals.map((d) => d.leadId).filter((id): id is number => id !== null),
    );
    const dealIds = wonDeals.map((d) => d.dealId);

    // Two reads rather than a join per deal: the touch set for the whole window
    // is fetched once and indexed in memory, because the alternative is one
    // query per won deal.
    const [touchesByLead, touchesByDeal] = await Promise.all([
      this.loadMarketingTouches(orgId, leadIds),
      this.loadSalesTouches(orgId, dealIds),
    ]);

    const campaigns = new Map<number | null, CampaignAccumulator>();
    const channels = new Map<string, AttributedChannel>();

    let totalRevenueMinor = 0;
    let attributedRevenueMinor = 0;
    let dealsAttributed = 0;
    let dealsWithoutTouches = 0;

    for (const deal of wonDeals) {
      totalRevenueMinor += deal.valueMinor;

      const closedAt = closeInstant(deal);
      const timeline = [
        ...(deal.leadId === null ? [] : (touchesByLead.get(deal.leadId) ?? [])),
        ...(touchesByDeal.get(deal.dealId) ?? []),
      ];

      // Order first, then cut at the close: `weightsFor` reads the ends of the
      // ordered set, and `touchesUpTo` keeps the order it is given.
      const eligible = touchesUpTo(orderTouches(timeline), closedAt);
      if (eligible.length === 0) {
        dealsWithoutTouches += 1;
        continue;
      }

      dealsAttributed += 1;
      const allocations = attributeDeal(
        model,
        { revenueMinor: deal.valueMinor, closedAt },
        eligible,
        halfLifeDays,
      );

      for (const allocation of allocations) {
        // The running total is the sum of the allocations, not the deal value,
        // so `attributed + unattributable = total` is a measurement of the
        // allocator rather than a restatement of its promise.
        attributedRevenueMinor += allocation.revenueMinor;
        accumulateCampaign(campaigns, deal.dealId, allocation);
        accumulateChannel(channels, allocation);
      }
    }

    await this.nameCampaigns(orgId, campaigns);

    return {
      model,
      modelDescription: ATTRIBUTION_MODEL_DESCRIPTIONS[model],
      halfLifeDays,
      dealsConsidered: wonDeals.length,
      dealsAttributed,
      dealsWithoutTouches,
      truncated,
      totalRevenueMinor,
      attributedRevenueMinor,
      unattributableRevenueMinor: totalRevenueMinor - attributedRevenueMinor,
      campaigns: [...campaigns.values()]
        .map(
          (c): AttributedCampaign => ({
            campaignId: c.campaignId,
            campaignName: c.campaignName,
            campaignArchived: c.campaignArchived,
            touchCount: c.touchCount,
            dealCount: c.dealIds.size,
            attributedRevenueMinor: c.attributedRevenueMinor,
          }),
        )
        .sort((a, b) => b.attributedRevenueMinor - a.attributedRevenueMinor),
      channels: [...channels.values()].sort(
        (a, b) => b.attributedRevenueMinor - a.attributedRevenueMinor,
      ),
    };
  }

  private async loadWonDeals(
    orgId: string,
    wonStageKeys: string[],
  ): Promise<{ wonDeals: WonDealRow[]; truncated: boolean }> {
    const rows = await this.db
      .select({
        dealId: deals.id,
        leadId: deals.leadId,
        valueMinor: deals.valueMinor,
        actualCloseDate: deals.actualCloseDate,
        updatedAt: deals.updatedAt,
      })
      .from(deals)
      .where(
        and(
          eq(deals.orgId, orgId),
          isNull(deals.deletedAt),
          inArray(deals.stage, wonStageKeys),
        ),
      )
      .orderBy(desc(deals.id))
      // One row over the cap is how truncation is detected without a second
      // COUNT over the same predicate.
      .limit(MAX_DEALS_PER_REPORT + 1);

    const truncated = rows.length > MAX_DEALS_PER_REPORT;
    return {
      wonDeals: truncated ? rows.slice(0, MAX_DEALS_PER_REPORT) : rows,
      truncated,
    };
  }

  /**
   * What marketing did, keyed by lead.
   *
   * `crm_lead_touchpoints` has no `deleted_at` — a touch is an immutable record
   * that something happened, so there is nothing to soft-delete and no filter to
   * forget. The channel comes from `source_key` alone: `medium` qualifies a
   * source ("newsletter" for an email) rather than naming a second channel, so
   * folding it in would split one channel into a row per campaign variant.
   */
  private async loadMarketingTouches(
    orgId: string,
    leadIds: number[],
  ): Promise<Map<number, AttributionTouch[]>> {
    const byLead = new Map<number, AttributionTouch[]>();
    if (leadIds.length === 0) return byLead;

    const rows = await this.db
      .select({
        id: crmLeadTouchpoints.id,
        leadId: crmLeadTouchpoints.leadId,
        campaignId: crmLeadTouchpoints.campaignId,
        sourceKey: crmLeadTouchpoints.sourceKey,
        touchType: crmLeadTouchpoints.touchType,
        occurredAt: crmLeadTouchpoints.occurredAt,
      })
      .from(crmLeadTouchpoints)
      .where(
        and(
          eq(crmLeadTouchpoints.orgId, orgId),
          inArray(crmLeadTouchpoints.leadId, leadIds),
        ),
      );

    for (const row of rows) {
      push(byLead, row.leadId, {
        touchKey: makeTouchKey("touchpoint", row.id),
        touchKind: "touchpoint",
        channel: normaliseChannel(row.sourceKey),
        campaignId: row.campaignId,
        occurredAt: row.occurredAt,
        detail: row.touchType,
      });
    }
    return byLead;
  }

  /**
   * What sales did, keyed by deal.
   *
   * These carry no campaign, so they land in the null-campaign bucket — which is
   * the point rather than a gap: under a multi-touch model the share a call or a
   * demo absorbs is exactly the share the campaigns did NOT earn, and a report
   * that omitted them would hand 100% of every deal to marketing.
   */
  private async loadSalesTouches(
    orgId: string,
    dealIds: number[],
  ): Promise<Map<number, AttributionTouch[]>> {
    const byDeal = new Map<number, AttributionTouch[]>();
    if (dealIds.length === 0) return byDeal;

    const rows = await this.db
      .select({
        activityId: activities.activityId,
        dealId: activities.dealId,
        kind: activities.kind,
        subject: activities.subject,
        occurredAt: activities.occurredAt,
      })
      .from(activities)
      .where(
        and(
          eq(activities.organizationId, orgId),
          inArray(activities.dealId, dealIds),
          isNull(activities.deletedAt),
        ),
      );

    for (const row of rows) {
      if (row.dealId === null) continue;
      push(byDeal, row.dealId, {
        touchKey: makeTouchKey("activity", row.activityId),
        touchKind: "activity",
        channel: normaliseChannel(`sales_${row.kind}`),
        campaignId: null,
        occurredAt: row.occurredAt,
        detail: row.subject ?? row.kind,
      });
    }
    return byDeal;
  }

  /**
   * Resolve the campaign names for the buckets that actually earned something.
   *
   * Looked up after the division rather than joined during it, so the read is
   * one query over the campaigns that appear in the answer instead of a join
   * fanning every touch row out by its campaign. Soft-deleted campaigns are
   * fetched too — see `campaignArchived`.
   */
  private async nameCampaigns(
    orgId: string,
    campaigns: Map<number | null, CampaignAccumulator>,
  ): Promise<void> {
    const ids = [...campaigns.keys()].filter((id): id is number => id !== null);
    if (ids.length === 0) return;

    const rows = await this.db
      .select({
        id: crmCampaigns.id,
        name: crmCampaigns.name,
        deletedAt: crmCampaigns.deletedAt,
      })
      .from(crmCampaigns)
      .where(and(eq(crmCampaigns.orgId, orgId), inArray(crmCampaigns.id, ids)));

    for (const row of rows) {
      const bucket = campaigns.get(row.id);
      if (!bucket) continue;
      bucket.campaignName = row.name;
      bucket.campaignArchived = row.deletedAt !== null;
    }
  }
}

/**
 * The moment credit is assigned as of.
 *
 * `actual_close_date` is a date, not an instant, so it names a day — and the
 * conversion touch is normally written during that day. Taken as midnight the
 * deal would close before the touch that closed it and `touchesUpTo` would drop
 * it, so the end of the day is the only reading that does not lose the last
 * touch. The `Z` is explicit because the alternative is the host's timezone
 * deciding which day a deal closed on.
 *
 * With no close date recorded, `updated_at` is used: it is a fact about the row
 * rather than a forecast, which `expected_close_date` on a won deal is.
 */
function closeInstant(deal: WonDealRow): Date {
  return deal.actualCloseDate
    ? new Date(`${deal.actualCloseDate}T23:59:59.999Z`)
    : deal.updatedAt;
}

function accumulateCampaign(
  campaigns: Map<number | null, CampaignAccumulator>,
  dealId: number,
  allocation: { touch: AttributionTouch; revenueMinor: number },
): void {
  const key = allocation.touch.campaignId;
  const bucket: CampaignAccumulator = campaigns.get(key) ?? {
    campaignId: key,
    // Matches the shipped report's label for the no-campaign bucket, so the two
    // reports name the same thing the same way.
    campaignName: "Direct/Unknown",
    campaignArchived: false,
    touchCount: 0,
    dealIds: new Set<number>(),
    attributedRevenueMinor: 0,
  };

  bucket.touchCount += 1;
  bucket.attributedRevenueMinor += allocation.revenueMinor;
  bucket.dealIds.add(dealId);
  campaigns.set(key, bucket);
}

function accumulateChannel(
  channels: Map<string, AttributedChannel>,
  allocation: { touch: AttributionTouch; revenueMinor: number },
): void {
  const key = allocation.touch.channel;
  const bucket = channels.get(key) ?? {
    channel: key,
    touchCount: 0,
    attributedRevenueMinor: 0,
  };
  bucket.touchCount += 1;
  bucket.attributedRevenueMinor += allocation.revenueMinor;
  channels.set(key, bucket);
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

function unique(values: number[]): number[] {
  return [...new Set(values)];
}
