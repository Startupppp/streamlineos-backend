import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { keysetBefore } from "../../common/pagination/keyset";
import { deals, crmForecastSnapshots } from "../../db/schema";
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
import type {
  CreateForecastSnapshotInput,
  CompareForecastSnapshotsInput,
  ForecastSnapshotsQueryInput,
} from "./dto/deals.schemas";

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

/**
 * Who a deals analytic is about.
 *
 * Declared here rather than in `deals-analytics.service.ts`, which re-exports
 * it: that file imports this one, so declaring it there would close a cycle.
 */
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
 * about the wrong person. Exported for `DealsAnalyticsService`, whose other
 * `crm:deals:read` analytics narrow the same way.
 */
export function visibleDeals(view: DealsViewScope, orgId: string) {
  return applyScope(view.scope, orgId, view.userId, { ownerColumn: deals.assignedToId });
}

@Injectable()
export class DealsForecastService {
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
        .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), notInArray(deals.stage, [...wonKeys, ...lostKeys]), visibleDeals(view, orgId)))
        .limit(10000),
      this.db
        .select({ stage: deals.stage, closed: count() })
        .from(deals)
        .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), inArray(deals.stage, [...wonKeys, ...lostKeys])))
        .groupBy(deals.stage)
        // One row per terminal stage key, so this never approaches the bound.
        .limit(1000),
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
    const limit = query.limit ?? 20;
    const position = decodeCursor(query.cursor);
    const baseConditions = [eq(crmForecastSnapshots.orgId, orgId)];
    if (query.period) baseConditions.push(eq(crmForecastSnapshots.period, query.period));
    const where = position
      ? and(...baseConditions, keysetBefore(crmForecastSnapshots.capturedAt, crmForecastSnapshots.id, position))
      : and(...baseConditions);
    const rows = await this.db
      .select()
      .from(crmForecastSnapshots)
      .where(where)
      .orderBy(desc(crmForecastSnapshots.capturedAt), desc(crmForecastSnapshots.id))
      .limit(limit + 1);
    const cursorPage = buildCursorPage(rows, limit, (row) => ({
      sortValue: row.capturedAt.toISOString(),
      id: row.id,
    }));
    return { snapshots: cursorPage.data, hasMore: cursorPage.pagination.hasMore, nextCursor: cursorPage.pagination.nextCursor };
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
