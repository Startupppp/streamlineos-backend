import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, inArray, isNull, notInArray, sql, sum } from "drizzle-orm";
import { deals, dealActivities, crmForecastSnapshots, users } from "../../db/schema";
import type { ForecastSnapshotData } from "../../db/schema/crm/deals";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { CrmMetadataService } from "../crm/metadata/crm-metadata.service";
import { applyScope } from "../access/apply-scope";
import type { DataScope } from "../access/access.types";
import {
  assessForecastHistory,
  type ForecastBasis,
  type ForecastReadiness,
} from "./forecast/forecast-cold-start";
import { ForecastTrainingService } from "./forecast/forecast-training.service";
import type { CreateForecastSnapshotInput, CompareForecastSnapshotsInput, ForecastSnapshotsQueryInput } from "./dto/deals.schemas";

export interface ForecastMonth {
  month: string;
  label: string;
  weighted: number;
  bestCase: number;
  dealCount: number;
}

export interface ForecastSummary {
  totalWeighted: number;
  totalBestCase: number;
  totalDeals: number;
  byMonth: ForecastMonth[];
  byStage: Array<{
    stage: string;
    count: number;
    totalValue: number;
    weightedValue: number;
    avgProbability: number;
  }>;
  /**
   * What the totals above actually are, so a surface can stop presenting a
   * tenant's own stage percentages back to them as if the product had learned
   * something. Added, never substituted: every field above still means what it
   * meant, so a consumer that ignores `basis` is exactly as correct as before —
   * it is only as honest as before, which is the point of the field.
   */
  basis: ForecastBasis;
}

/** Who a deals analytic is about. */
export interface DealsViewScope {
  scope: DataScope;
  userId: string;
}

/**
 * A read whose answer is the organisation's by definition.
 *
 * Used by the forecast SNAPSHOT paths. A snapshot is an organisation-level
 * artifact — it is captured for a period, compared against later, and overridden
 * by a manager — so it must be the same quantity no matter who pressed the
 * button, or two snapshots of one period would disagree because two different
 * people took them. Those routes are gated on `crm:deals:forecast` and
 * `crm:deals:manage`, neither of which the catalog declares scopable, which is
 * the same statement in the permission catalog.
 *
 * `applyScope("all", …)` returns `sql`true`` and never reads `userId`, so the
 * empty string here is unreachable rather than a placeholder that might leak.
 */
const ORG_WIDE: DealsViewScope = { scope: "all", userId: "" };

/**
 * The deals predicate for a caller, over the column the list narrows on.
 *
 * `deals.assignedToId` and nothing else — this is the owner column `listDeals`
 * and `getDeal` both use, and picking a different one here would quietly answer
 * about the wrong person.
 */
function visibleDeals(view: DealsViewScope, orgId: string) {
  return applyScope(view.scope, orgId, view.userId, { ownerColumn: deals.assignedToId });
}

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
  return view.scope === "all" || view.scope === "none"
    ? view.scope
    : `${view.scope}:${view.userId}`;
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
    private readonly forecastModel: ForecastTrainingService,
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
    return this.cache.cached(
      `deals:aging:${orgId}:${scopeSuffix(view)}`,
      async () => {
        const { wonKeys, lostKeys } = await this.getTerminalStageKeys(orgId);
        const allDeals = await this.db
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
          .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), notInArray(deals.stage, [...wonKeys, ...lostKeys]), visibleDeals(view, orgId)))
          .orderBy(sql`${deals.updatedAt} asc`)
          .limit(100);

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
   * ONLY THE ORG-WIDE ANSWER IS CACHED, and deliberately so. `CACHE_KEYS.dealsForecast`
   * is invalidated by exact key from three write paths in `deals-crud.service.ts`
   * — create, delete and the shared `invalidateDealCaches`. Appending a scope to
   * that key would leave every narrowed entry unreachable by those invalidations,
   * so a rep would keep reading a forecast that included a deal deleted ten
   * minutes earlier. Fixing that means changing the writers to bump a namespace,
   * which is a different file and a different change. A narrowed forecast is two
   * queries over one rep's open deals; it is computed each time and it is
   * correct, and the shared entry the whole organisation reads is untouched —
   * same key, same invalidation, same value.
   */
  getForecast(orgId: string, view: DealsViewScope): Promise<ForecastSummary> {
    if (view.scope !== "all") return this.buildForecast(orgId, view);
    return this.cache.cached(
      CACHE_KEYS.dealsForecast(orgId),
      () => this.buildForecast(orgId, ORG_WIDE),
      CACHE_TTL.MEDIUM,
    );
  }

  private async buildForecast(orgId: string, view: DealsViewScope): Promise<ForecastSummary> {
    const { wonKeys, lostKeys } = await this.getTerminalStageKeys(orgId);
    const metaRaw = await this.crmMetadata.getAggregate(orgId);
    const stageProbMap = new Map<string, number>(
      metaRaw.stages
        .filter((s) => s.isActive)
        .map((s) => [s.key, s.probability]),
    );

    // The closed count is read against the SAME terminal keys that exclude those
    // deals from the open pipeline above. If getTerminalStageKeys falls back to
    // ["WON"]/["LOST"] because the tenant has no active terminal stages, the two
    // reads are wrong together rather than separately: a deal is never both
    // absent from the pipeline and absent from the history that would explain it.
    //
    // THE TWO READS TAKE DIFFERENT SCOPES ON PURPOSE. The open pipeline is the
    // caller's — every money figure in the response comes out of it, and a rep
    // granted `own` must read their forecast and not the organisation's. The
    // closed history is NOT narrowed, because the only thing it produces is
    // `basis`: whether THIS ORGANISATION has enough closed deals to have trained
    // a forecast model. That is one fact about the product's state, identical for
    // every caller, and narrowing it would tell a rep with three closed deals
    // that their organisation cannot be forecast — a wrong answer, in the service
    // of hiding a count of deals that carries no name, no value and no customer.
    const [allDeals, closedByStage] = await Promise.all([
      this.db
        .select({
          id: deals.id,
          value: deals.value,
          stage: deals.stage,
          probability: deals.probability,
          expectedCloseDate: deals.expectedCloseDate,
          createdAt: deals.createdAt,
        })
        .from(deals)
        .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), notInArray(deals.stage, [...wonKeys, ...lostKeys]), visibleDeals(view, orgId))),
      this.db
        .select({ stage: deals.stage, closed: count() })
        .from(deals)
        .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), inArray(deals.stage, [...wonKeys, ...lostKeys])))
        .groupBy(deals.stage),
    ]);

    /**
     * The learned probabilities, where this organisation has a model that earned
     * the right to produce them.
     *
     * Read rather than computed: the nightly pass writes one row per open deal
     * with the features beside the answer, so the totals here and the
     * explanation on a deal page are the same arithmetic over the same numbers.
     * Computing them again in a cached GET would also be a write in a GET, since
     * a score that nobody stored cannot be argued with later.
     *
     * A deal with no row falls back to the weighted arithmetic below, which is
     * what it was already doing. That happens for a deal created since the last
     * pass, and for every deal in a tenant on the naive arm.
     */
    const readiness = this.forecastReadiness(closedByStage, wonKeys);
    const [basis, learnedProbabilities] = await Promise.all([
      this.forecastModel.basisFor(orgId, readiness),
      this.forecastModel.probabilitiesForOpenDeals(orgId),
    ]);

    const monthMap = new Map<string, ForecastMonth>();
    const stageMap = new Map<string, { count: number; totalValue: number; weightedValue: number; probSum: number }>();

    for (const deal of allDeals) {
      const value = Number(deal.value ?? 0);
      const learned = learnedProbabilities.get(deal.id);
      const probability =
        learned === undefined
          ? deal.probability || stageProbMap.get(deal.stage) || 20
          : learned * 100;
      const weighted = Math.round((value * probability) / 100);

      const closeDate = deal.expectedCloseDate
        ? new Date(deal.expectedCloseDate)
        : deal.createdAt
          ? new Date(new Date(deal.createdAt).getTime() + 90 * 24 * 60 * 60 * 1000)
          : new Date();

      const monthKey = `${closeDate.getFullYear()}-${String(closeDate.getMonth() + 1).padStart(2, "0")}`;
      const monthLabel = closeDate.toLocaleDateString("en-IN", { month: "short", year: "numeric" });

      const existing = monthMap.get(monthKey) ?? { month: monthKey, label: monthLabel, weighted: 0, bestCase: 0, dealCount: 0 };
      existing.weighted += weighted;
      existing.bestCase += value;
      existing.dealCount += 1;
      monthMap.set(monthKey, existing);

      const stageData = stageMap.get(deal.stage) ?? { count: 0, totalValue: 0, weightedValue: 0, probSum: 0 };
      stageData.count += 1;
      stageData.totalValue += value;
      stageData.weightedValue += weighted;
      stageData.probSum += probability;
      stageMap.set(deal.stage, stageData);
    }

    const byMonth = [...monthMap.values()].sort((a, b) => a.month.localeCompare(b.month));
    const byStage = [...stageMap.entries()].map(([stage, data]) => ({
      stage,
      count: data.count,
      totalValue: data.totalValue,
      weightedValue: data.weightedValue,
      avgProbability: data.count > 0 ? Math.round(data.probSum / data.count) : 0,
    }));

    return {
      totalWeighted: byMonth.reduce((s, m) => s + m.weighted, 0),
      totalBestCase: byMonth.reduce((s, m) => s + m.bestCase, 0),
      totalDeals: allDeals.length,
      byMonth,
      byStage,
      basis,
    };
  }

  /**
   * How much closed history this organisation has, against the floor a learned
   * forecast needs.
   *
   * Two readers, one arithmetic. `basisFor` turns this into the label the
   * response carries, and the standalone model endpoint counts the same rows a
   * different way to reach the same answer — which is why the counting lives
   * here and the labelling does not.
   *
   * The two naive reasons are not interchangeable. "insufficient-history" means
   * the tenant cannot yet be given better and readiness says how much is
   * missing; "not-trained-yet" means they could be and no accepted model exists,
   * which is our gap and not theirs. A surface that renders both as "not enough
   * data" is lying to the second tenant.
   *
   * Note for whoever writes that surface: the flat 20 in the loop above is a
   * default nobody typed, so copy along the lines of "the probabilities you set
   * yourself" is false for any deal left at 0 or sitting in a stage with no
   * active metadata.
   */
  private forecastReadiness(
    closedByStage: Array<{ stage: string; closed: number }>,
    wonKeys: string[],
  ): ForecastReadiness {
    const wonKeySet = new Set(wonKeys);
    let won = 0;
    let lost = 0;
    for (const row of closedByStage) {
      // count() comes back as a number from drizzle, but a raw driver row can
      // still hand over a bigint-as-string; Number() here rather than trusting it.
      const closed = Number(row.closed ?? 0);
      if (wonKeySet.has(row.stage)) won += closed;
      else lost += closed;
    }

    return assessForecastHistory({ won, lost });
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

  /**
   * A snapshot is the ORGANISATION's forecast, whoever pressed the button.
   *
   * `ORG_WIDE` rather than the caller's scope: a snapshot is captured for a
   * period and compared against later, so two captures of one period taken by
   * two different people have to be the same number. The route is gated on
   * `crm:deals:forecast`, which the catalog does not declare scopable — the same
   * statement, in the permission catalog.
   */
  async createForecastSnapshot(orgId: string, userId: string, input: CreateForecastSnapshotInput) {
    const forecast = await this.getForecast(orgId, ORG_WIDE);
    const data: ForecastSnapshotData = {
      byCategory: [],
      byRep: [],
      totalWeighted: forecast.totalWeighted,
      totalBestCase: forecast.totalBestCase,
      totalDeals: forecast.totalDeals,
      period: input.period,
    };
    const [row] = await this.db.insert(crmForecastSnapshots).values({
      orgId, period: input.period, createdById: userId, data,
    }).returning();
    return row;
  }

  async getForecastSnapshots(orgId: string, query: ForecastSnapshotsQueryInput) {
    const conditions = [eq(crmForecastSnapshots.orgId, orgId)];
    if (query.period) conditions.push(eq(crmForecastSnapshots.period, query.period));
    return this.db
      .select()
      .from(crmForecastSnapshots)
      .where(and(...conditions))
      .orderBy(desc(crmForecastSnapshots.capturedAt))
      .limit(query.limit ?? 20)
      .offset(query.offset ?? 0);
  }

  async overrideForecastSnapshot(
    orgId: string,
    userId: string,
    snapshotId: string,
    input: { overrideAmount?: number; overrideNote?: string },
  ) {
    const existing = await this.db.query.crmForecastSnapshots.findFirst({
      where: and(eq(crmForecastSnapshots.id, snapshotId), eq(crmForecastSnapshots.orgId, orgId)),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Forecast snapshot not found");

    const [updated] = await this.db
      .update(crmForecastSnapshots)
      .set({
        overrideAmount: input.overrideAmount !== undefined ? String(input.overrideAmount) : undefined,
        overrideNote: input.overrideNote,
        overriddenBy: userId,
      })
      .where(and(eq(crmForecastSnapshots.id, snapshotId), eq(crmForecastSnapshots.orgId, orgId)))
      .returning();
    return updated;
  }

  async compareForecastSnapshots(orgId: string, input: CompareForecastSnapshotsInput) {
    const snapshot = await this.db.query.crmForecastSnapshots.findFirst({
      where: and(eq(crmForecastSnapshots.orgId, orgId), eq(crmForecastSnapshots.period, input.period)),
      orderBy: [desc(crmForecastSnapshots.capturedAt)],
    });
    if (!snapshot) throw new NotFoundException(`No snapshot found for period ${input.period}`);
    const baseline = snapshot.data;
    // Org-wide, because the baseline it is subtracted from is org-wide. A
    // narrowed `current` against a stored organisation snapshot would report a
    // delta between two different populations.
    const current = await this.buildForecast(orgId, ORG_WIDE);
    const currentData: ForecastSnapshotData = {
      byCategory: [],
      byRep: [],
      totalWeighted: current.totalWeighted,
      totalBestCase: current.totalBestCase,
      totalDeals: current.totalDeals,
      period: input.period,
    };
    return {
      period: input.period,
      baseline,
      current: currentData,
      delta: {
        totalWeighted: currentData.totalWeighted - baseline.totalWeighted,
        totalBestCase: currentData.totalBestCase - baseline.totalBestCase,
        totalDeals: currentData.totalDeals - baseline.totalDeals,
        byCategory: [],
      },
    };
  }
}
