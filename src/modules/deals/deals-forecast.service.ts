import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { keysetBefore } from "../../common/pagination/keyset";
import { crmForecastSnapshots } from "../../db/schema";
import type { ForecastSnapshotData } from "../../db/schema/crm/deals";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { CrmMetadataService } from "../crm/metadata/crm-metadata.service";
import { ForecastTrainingService } from "./forecast/forecast-training.service";
import type {
  CreateForecastSnapshotInput,
  CompareForecastSnapshotsInput,
  ForecastSnapshotsQueryInput,
} from "./dto/deals.schemas";
import type { DealsViewScope, ForecastSummary } from "./deals-forecast.types";
import * as forecastSummary from "./lib/forecast-summary";

export type { DealsViewScope, ForecastMonth, ForecastSummary } from "./deals-forecast.types";
export { visibleDeals } from "./lib/forecast-summary";

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

@Injectable()
export class DealsForecastService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly crmMetadata: CrmMetadataService,
    private readonly forecastModel: ForecastTrainingService,
  ) {}

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

  /** The forecast itself, uncached; the arithmetic is in `lib/forecast-summary.ts`. */
  private buildForecast(orgId: string, view: DealsViewScope): Promise<ForecastSummary> {
    return forecastSummary.buildForecast(
      { db: this.db, crmMetadata: this.crmMetadata, forecastModel: this.forecastModel },
      orgId,
      view,
    );
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
