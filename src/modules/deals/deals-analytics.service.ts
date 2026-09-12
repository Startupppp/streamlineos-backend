import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, inArray, isNull, notInArray, sql, sum } from "drizzle-orm";
import { deals, dealActivities, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import { CrmMetadataService } from "../crm/metadata/crm-metadata.service";
import {
  DealsForecastService,
  visibleDeals,
  type DealsViewScope,
  type ForecastSummary,
} from "./deals-forecast.service";
import type {
  CreateForecastSnapshotInput,
  CompareForecastSnapshotsInput,
  ForecastSnapshotsQueryInput,
} from "./dto/deals.schemas";
export type { DealsViewScope, ForecastMonth, ForecastSummary } from "./deals-forecast.service";

/**
 * The cache entry belongs to whoever may read it.
 *
 * A narrowed analytic reusing the org-wide key would serve one rep's pipeline to
 * the next rep and to the manager who asked for the organisation's. `all` and
 * `none` answer the same thing for everyone holding them and stay one shared
 * entry, so an organisation that grants nobody a narrowed scope keeps exactly one
 * entry per analytic; `own` and `team` fan out per caller.
 */
function scopeSuffix(view: DealsViewScope): string {
  return view.discriminator;
}

/**
 * WHAT A NARROWED DEALS ANALYTIC MEANS.
 *
 * `crm:deals:read` is declared `scopable: true`, `listDeals` has always honoured
 * it, and `getDeal` was made to honour it in 7b35e781e. Every read on this
 * service behind that key answered for the whole organisation, so a rep granted
 * `own` saw six deals on the board and the organisation's pipeline value in the
 * tile above it.
 *
 * The decision: every figure here is over THE DEALS THE CALLER MAY SEE. Pipeline
 * value, win rate, forecast and the aging list are "yours" for a rep at `own` and
 * the organisation's for everyone at `all` — which is every manager, every org
 * owner, and every organisation that has granted nobody a narrowed scope, where
 * the predicate is `true` and each number is unchanged.
 *
 * The ONE figure that stays org-wide is `basis` on the forecast, and it is
 * marked where it is computed: it says whether THIS ORGANISATION has enough
 * closed history to train a model, which is the same fact for every caller and is
 * a statement about the product rather than about anybody's deals.
 */
@Injectable()
export class DealsAnalyticsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly crmMetadata: CrmMetadataService,
    private readonly forecast: DealsForecastService,
  ) {}

  private async getTerminalStageKeys(orgId: string): Promise<{ wonKeys: string[]; lostKeys: string[] }> {
    const metadata = await this.crmMetadata.getAggregate(orgId);
    const wonKeys = metadata.stages
      .filter((s) => s.stageType === "won" && s.isActive)
      .map((s) => s.key);
    const lostKeys = metadata.stages
      .filter((s) => s.stageType === "lost" && s.isActive)
      .map((s) => s.key);
    return { wonKeys: wonKeys.length ? wonKeys : ["WON"], lostKeys: lostKeys.length ? lostKeys : ["LOST"] };
  }

  /**
   * The three tiles above the deals board, over the deals the caller may see.
   *
   * The board beneath them narrows and these did not, so a rep granted `own`
   * counted six deals on screen under a tile reading the organisation's whole
   * pipeline value — both a number contradicting the list under it, and a
   * disclosure of the exact total the grant was meant to withhold.
   */
  async getStats(orgId: string, view: DealsViewScope) {
    const { wonKeys, lostKeys } = await this.getTerminalStageKeys(orgId);
    const visible = visibleDeals(view, orgId);
    const [activeRow, wonRow] = await Promise.all([
      this.db
        .select({ cnt: count(), total: sum(deals.value) })
        .from(deals)
        .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), notInArray(deals.stage, [...wonKeys, ...lostKeys]), visible)),
      this.db
        .select({ total: sum(deals.value) })
        .from(deals)
        .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), inArray(deals.stage, wonKeys), visible)),
    ]);
    return {
      active: activeRow[0]?.cnt ?? 0,
      pipelineValue: Number(activeRow[0]?.total ?? 0),
      wonValue: Number(wonRow[0]?.total ?? 0),
    };
  }

  /**
   * The stale-deal list, out of the deals the caller may see.
   *
   * Not an aggregate: this returns up to a hundred deal ROWS with name, value,
   * stage and assignee. Unscoped it was a second, unnarrowed deals list sitting
   * behind the same key as the narrowed one — a rep at `own` could read a
   * colleague's deal names and values off it without ever opening a deal.
   */
  async getAging(orgId: string, view: DealsViewScope) {
    if (view.denied) return { summary: { total: 0, stale: 0, critical: 0 }, deals: [] };
    return this.cache.cached(
      `deals:aging:${orgId}:${scopeSuffix(view)}`,
      async () => {
        const { wonKeys, lostKeys } = await this.getTerminalStageKeys(orgId);
        const allDeals = await view.read(
          {
            tenant: deals.orgId,
            scope: { columns: { ownerColumn: deals.assignedToId } },
            and: [isNull(deals.deletedAt), notInArray(deals.stage, [...wonKeys, ...lostKeys])],
          },
          ({ sql: where }) => this.db
          .select({
            id: deals.id,
            name: deals.name,
            value: deals.value,
            stage: deals.stage,
            updatedAt: deals.updatedAt,
            createdAt: deals.createdAt,
            assignedToId: deals.assignedToId,
            assigneeName: users.name,
          })
            .from(deals)
            .leftJoin(users, eq(deals.assignedToId, users.id))
            .where(where)
            .orderBy(sql`${deals.updatedAt} asc`)
            .limit(100),
          () => [],
        );

        const now = Date.now();
        const enriched = allDeals.map((d) => {
          const updated = d.updatedAt ? new Date(d.updatedAt).getTime() : now;
          const daysInStage = Math.floor((now - updated) / (1000 * 60 * 60 * 24));
          return {
            ...d,
            daysInStage,
            isStale: daysInStage > 14,
            isCritical: daysInStage > 30,
          };
        });

        const stale = enriched.filter((d) => d.isStale).length;
        const critical = enriched.filter((d) => d.isCritical).length;

        return {
          summary: { total: enriched.length, stale, critical },
          deals: enriched,
        };
      },
      CACHE_TTL.MEDIUM,
    );
  }

  /**
   * The forecast, over the deals the caller may see.
   *
   * Computed and cached by `DealsForecastService`, which is also where the
   * reason only the org-wide answer is cached is written down.
   */
  getForecast(orgId: string, view: DealsViewScope): Promise<ForecastSummary> {
    return this.forecast.getForecast(orgId, view);
  }

  createForecastSnapshot(orgId: string, userId: string, input: CreateForecastSnapshotInput) {
    return this.forecast.createForecastSnapshot(orgId, userId, input);
  }

  getForecastSnapshots(orgId: string, query: ForecastSnapshotsQueryInput) {
    return this.forecast.getForecastSnapshots(orgId, query);
  }

  overrideForecastSnapshot(orgId: string, userId: string, snapshotId: string, input: { overrideAmount?: number; overrideNote?: string }) {
    return this.forecast.overrideForecastSnapshot(orgId, userId, snapshotId, input);
  }

  compareForecastSnapshots(orgId: string, input: CompareForecastSnapshotsInput) {
    return this.forecast.compareForecastSnapshots(orgId, input);
  }

  /**
   * Won against lost, over the deals the caller may see.
   *
   * A win rate narrowed to `own` is the rep's own win rate, which is what the
   * board beneath it is already showing them. Left org-wide it also handed a
   * restricted rep the organisation's won and lost VALUES and the free-text
   * reasons every deal in the organisation was lost for.
   */
  async getWinLoss(orgId: string, view: DealsViewScope) {
    return this.cache.cached(
      `deals:win-loss:${orgId}:${scopeSuffix(view)}`,
      async () => {
        const { wonKeys, lostKeys } = await this.getTerminalStageKeys(orgId);
        const visible = visibleDeals(view, orgId);

        const bucketTotals = (stageKeys: string[]) =>
          this.db
            .select({
              count: sql<number>`count(*)::int`,
              totalValue: sql<number>`COALESCE(SUM(${deals.value}::numeric), 0)::float`,
            })
            .from(deals)
            .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), inArray(deals.stage, stageKeys), visible));

        const [wonRows, lostRows, lostByReason] = await Promise.all([
          bucketTotals(wonKeys),
          bucketTotals(lostKeys),
          this.db
            .select({
              reason: sql<string>`COALESCE(${deals.lostReason}, 'Not specified')`,
              count: sql<number>`count(*)::int`,
              totalValue: sql<number>`COALESCE(SUM(${deals.value}::numeric), 0)::float`,
            })
            .from(deals)
            .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), inArray(deals.stage, lostKeys), visible))
            .groupBy(sql`1`)
            .orderBy(sql`2 desc`),
        ]);

        const wonRow = wonRows[0] ?? { count: 0, totalValue: 0 };
        const lostRow = lostRows[0] ?? { count: 0, totalValue: 0 };
        const total = wonRow.count + lostRow.count;
        const winRate = total > 0 ? Math.round((wonRow.count / total) * 100) : 0;

        return {
          summary: {
            won: wonRow.count,
            wonValue: wonRow.totalValue,
            lost: lostRow.count,
            lostValue: lostRow.totalValue,
            total,
            winRate,
          },
          lostByReason: lostByReason.map((r) => ({
            reason: r.reason,
            count: r.count,
            totalValue: r.totalValue,
          })),
        };
      },
      CACHE_TTL.MEDIUM,
    );
  }

  /**
   * One deal's health, behind the SAME scope `getDeal` and `listDeals` apply.
   *
   * A second detail read of a single deal by id, on a different controller from
   * the one 7b35e781e repaired, gated on the same `crm:deals:read`. The factors
   * it returns ARE the columns it selects, in words: "Past expected close date"
   * is `expected_close_date`, "No updates in 30+ days" is `updated_at`, "No deal
   * value set" is `value`. So a rep at `own` could read a colleague's deal by id
   * — how stale it is, whether it is overdue, whether anyone has touched it —
   * and see the same score their manager sees.
   *
   * The 404 is unchanged and stays a 404: it is what a deleted deal and another
   * organisation's deal both answer, so this is not an oracle for which deals
   * exist.
   */
  async getDealHealth(orgId: string, dealId: number, view: DealsViewScope) {
    const deal = await this.db.query.deals.findFirst({
      where: and(eq(deals.id, dealId), eq(deals.orgId, orgId), isNull(deals.deletedAt), visibleDeals(view, orgId)),
      columns: { stage: true, updatedAt: true, expectedCloseDate: true, value: true, lastContactDate: true, probability: true },
      with: { activities: { columns: { createdAt: true }, orderBy: [desc(dealActivities.createdAt)], limit: 1 } },
    });
    if (!deal) throw new NotFoundException("Deal not found");

    const factors: Array<{ key: string; label: string; impact: "positive" | "negative" | "neutral"; weight: number }> = [];
    let score = 100;
    const now = Date.now();
    const daysSinceUpdate = Math.floor((now - new Date(deal.updatedAt).getTime()) / 86400000);
    const lastActivity = deal.activities[0];
    const daysSinceActivity = lastActivity
      ? Math.floor((now - new Date(lastActivity.createdAt).getTime()) / 86400000)
      : 999;

    if (daysSinceUpdate > 30) { score -= 30; factors.push({ key: "stale_30d", label: "No updates in 30+ days", impact: "negative", weight: 30 }); }
    else if (daysSinceUpdate > 14) { score -= 15; factors.push({ key: "stale_14d", label: "No updates in 14+ days", impact: "negative", weight: 15 }); }

    if (daysSinceActivity > 14) { score -= 20; factors.push({ key: "no_activity", label: "No recent activity", impact: "negative", weight: 20 }); }

    if (deal.expectedCloseDate) {
      const daysToClose = Math.floor((new Date(deal.expectedCloseDate).getTime() - now) / 86400000);
      if (daysToClose < 0) { score -= 25; factors.push({ key: "overdue", label: "Past expected close date", impact: "negative", weight: 25 }); }
      else if (daysToClose < 7) { score -= 10; factors.push({ key: "closing_soon", label: "Close date within 7 days", impact: "neutral", weight: 10 }); }
    }

    if (!deal.value || Number(deal.value) === 0) { score -= 10; factors.push({ key: "no_value", label: "No deal value set", impact: "negative", weight: 10 }); }

    const finalScore = Math.max(0, score);
    const level = finalScore >= 70 ? "healthy" : finalScore >= 40 ? "at_risk" : "critical";

    return {
      dealId,
      score: finalScore,
      level,
      factors,
      computedAt: new Date().toISOString(),
    };
  }
}
