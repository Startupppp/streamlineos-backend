import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gte, inArray, isNull, lte, or, type SQL } from "drizzle-orm";
import { activities, crmPipelineStages, deals, organizations } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import type { AttributionModelId } from "./attribution-models";
import {
  attributeConversion,
  summariseByChannel,
  MAX_TOUCHES_PER_CONVERSION,
  type AttributedConversion,
  type AttributionReport,
} from "./attribution-projection";
import type { AttributionTouch, Conversion } from "./attribution-touch";

/**
 * The read side of ticket 18: touches out of the timeline, credit out of a model.
 *
 * This service holds no state and writes nothing. Every method is a read of
 * `activities` and `deals` followed by a call into the pure projection, which is
 * what makes the fifth criterion true operationally as well as in the type:
 * there is no row here to become stale when a tenant changes model, because
 * there is no row here.
 */

/**
 * How many conversions one report will attribute.
 *
 * A report is a page in the product sense — a quarter's closed deals — and the
 * touch read below is `IN (...)` over these ids, so an unbounded deal set is an
 * unbounded activity read. The platform's hard page cap is 100 elsewhere; a
 * report is a different shape of read and gets its own, larger, bound.
 */
export const MAX_CONVERSIONS_PER_REPORT = 200;

/** What the tenant's stage vocabulary calls a win, if it never said. */
const DEFAULT_WON_STAGE_KEYS = ["WON", "Closed Won"] as const;

export interface AttributionReportQuery {
  readonly model: AttributionModelId;
  readonly from: Date;
  readonly to: Date;
}

interface DealRow {
  readonly id: number;
  readonly partyId: string | null;
  readonly valueMinor: number;
  readonly actualCloseDate: string | null;
  readonly updatedAt: Date;
}

@Injectable()
export class AttributionService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** One deal's revenue, decomposed to the touches on its timeline. */
  async forDeal(
    orgId: string,
    dealId: number,
    model: AttributionModelId,
  ): Promise<AttributedConversion> {
    const [deal, currency] = await Promise.all([
      this.db.query.deals.findFirst({
        where: and(eq(deals.id, dealId), eq(deals.orgId, orgId), isNull(deals.deletedAt)),
        columns: {
          id: true,
          partyId: true,
          valueMinor: true,
          actualCloseDate: true,
          updatedAt: true,
        },
      }),
      this.currencyOf(orgId),
    ]);
    if (!deal) throw new NotFoundException("Deal not found");

    const conversion = this.conversionOf(deal, orgId, currency);
    const touches = await this.touchesFor(orgId, [deal], conversion.convertedAt);
    return attributeConversion(conversion, touches.get(String(deal.id)) ?? [], model);
  }

  /**
   * A window of closed-won revenue, attributed and rolled up by channel.
   *
   * Two queries rather than two per deal. A report over a quarter is a hundred
   * deals, and a timeline read per deal is a hundred round trips for a screen
   * somebody refreshes while changing the model dropdown — which is exactly the
   * interaction the fifth criterion invites them to perform.
   */
  async report(orgId: string, query: AttributionReportQuery): Promise<AttributionReport> {
    const [wonKeys, currency] = await Promise.all([
      this.wonStageKeys(orgId),
      this.currencyOf(orgId),
    ]);

    const rows = await this.db
      .select({
        id: deals.id,
        partyId: deals.partyId,
        valueMinor: deals.valueMinor,
        actualCloseDate: deals.actualCloseDate,
        updatedAt: deals.updatedAt,
      })
      .from(deals)
      .where(
        and(
          eq(deals.orgId, orgId),
          isNull(deals.deletedAt),
          inArray(deals.stage, wonKeys),
          gte(deals.updatedAt, query.from),
          lte(deals.updatedAt, query.to),
        ),
      )
      .orderBy(asc(deals.id))
      .limit(MAX_CONVERSIONS_PER_REPORT);

    const conversions = rows.map((row) => this.conversionOf(row, orgId, currency));
    const horizon = conversions.reduce(
      (latest, conversion) =>
        conversion.convertedAt.getTime() > latest.getTime() ? conversion.convertedAt : latest,
      new Date(0),
    );
    const touches = await this.touchesFor(orgId, rows, horizon);

    const attributed = conversions.map((conversion) =>
      attributeConversion(conversion, touches.get(conversion.dealId) ?? [], query.model),
    );

    return summariseByChannel(query.model, currency, attributed);
  }

  /**
   * When the revenue landed.
   *
   * `actual_close_date` is a DATE, so it names a day and not an instant. Taken
   * as midnight it would exclude every touch made on the closing day itself —
   * including the call that closed it, which under last-touch is the entire
   * figure. The end of that day is the reading that keeps the day's touches on
   * the right side of the boundary.
   *
   * Falling back to `updated_at` when a tenant never fills the date in: a deal
   * sitting in a won stage has converted whether or not anybody typed a date,
   * and refusing to attribute it would quietly drop revenue out of the report.
   */
  private conversionOf(deal: DealRow, orgId: string, currency: string): Conversion {
    const convertedAt = deal.actualCloseDate
      ? new Date(`${deal.actualCloseDate}T23:59:59.999Z`)
      : deal.updatedAt;

    return {
      dealId: String(deal.id),
      organizationId: orgId,
      currency,
      valueMinor: Number(deal.valueMinor),
      convertedAt,
    };
  }

  /**
   * Every timeline row that could have contributed to these deals.
   *
   * Anchored two ways and unioned, because both are real and neither is
   * complete. A row anchored to the deal is unambiguous but only exists once
   * somebody logged it against the deal; a row anchored to the party is
   * everything ever exchanged with that customer, which is where the early
   * touches live — the marketing mail and the first call happened before there
   * was a deal to anchor to.
   *
   * `activities.deal_id` is TEXT while `deals.id` is a serial, so the ids are
   * compared as strings. That is how the rest of the platform reads this edge
   * (see `my-tasks.service.ts`); doing the coercion in SQL instead would put a
   * cast on the left of the predicate and lose `idx_activities_deal_timeline`.
   */
  private async touchesFor(
    orgId: string,
    rows: readonly DealRow[],
    horizon: Date,
  ): Promise<Map<string, AttributionTouch[]>> {
    const byDeal = new Map<string, AttributionTouch[]>();
    if (rows.length === 0) return byDeal;

    const dealIds = rows.map((row) => String(row.id));
    const partyIds = [...new Set(rows.map((row) => row.partyId).filter((id): id is string => !!id))];
    const dealsByParty = new Map<string, string[]>();
    for (const row of rows) {
      if (!row.partyId) continue;
      const list = dealsByParty.get(row.partyId) ?? [];
      list.push(String(row.id));
      dealsByParty.set(row.partyId, list);
    }

    const anchors: SQL[] = [inArray(activities.dealId, dealIds)];
    if (partyIds.length > 0) anchors.push(inArray(activities.partyId, partyIds));
    const anchor = anchors.length === 1 ? anchors[0] : or(...anchors);

    const found = await this.db
      .select({
        activityId: activities.activityId,
        occurredAt: activities.occurredAt,
        kind: activities.kind,
        source: activities.source,
        partyId: activities.partyId,
        dealId: activities.dealId,
      })
      .from(activities)
      .where(
        and(
          eq(activities.organizationId, orgId),
          isNull(activities.deletedAt),
          anchor,
          lte(activities.occurredAt, horizon),
        ),
      )
      .orderBy(asc(activities.occurredAt), asc(activities.activityId))
      .limit(MAX_TOUCHES_PER_CONVERSION * rows.length + 1);

    for (const row of found) {
      const touch: AttributionTouch = {
        activityId: row.activityId,
        occurredAt: row.occurredAt,
        kind: row.kind,
        channel: row.source,
        partyId: row.partyId,
        dealId: row.dealId,
      };

      /*
        A row anchored to the deal AND to the party would otherwise arrive on
        that deal twice, once from each half of the union. The projection
        rejects a repeated activity id rather than quietly halving it, so the
        deduplication has to happen here.
      */
      const targets = new Set<string>();
      if (touch.dealId && dealIds.includes(touch.dealId)) targets.add(touch.dealId);
      if (touch.partyId)
        for (const dealId of dealsByParty.get(touch.partyId) ?? []) targets.add(dealId);

      for (const dealId of targets) {
        const list = byDeal.get(dealId) ?? [];
        list.push(touch);
        byDeal.set(dealId, list);
      }
    }

    return byDeal;
  }

  /**
   * What the tenant's own stage vocabulary calls a win.
   *
   * `deals.stage` is a per-tenant key, not an enum, so the set is read rather
   * than assumed — and the fallback is the same pair every other reader of this
   * fact uses, so a tenant who never configured a pipeline gets the same answer
   * from the attribution report as from the campaigns screen.
   */
  private async wonStageKeys(orgId: string): Promise<string[]> {
    const stages = await this.db
      .select({ key: crmPipelineStages.key })
      .from(crmPipelineStages)
      .where(and(eq(crmPipelineStages.orgId, orgId), eq(crmPipelineStages.stageType, "won")));
    return stages.length > 0 ? stages.map((stage) => stage.key) : [...DEFAULT_WON_STAGE_KEYS];
  }

  /** `deals.value_minor` is in the organisation's currency; the figure has to say which. */
  private async currencyOf(orgId: string): Promise<string> {
    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
      columns: { currency: true },
    });
    return org?.currency ?? "INR";
  }
}
