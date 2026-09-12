import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import {
  businessParties,
  dealActivities,
  dealStageTransitions,
  deals,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { CrmMetadataService } from "../../crm/metadata/crm-metadata.service";
import {
  FORECAST_FEATURE_CAPS,
  type DealSnapshot,
  type HistoricalRates,
  type StageMove,
} from "./deal-forecast-features";
import {
  FORECAST_TRAINING_HORIZON_DAYS,
  buildHistoricalRates,
  type ClosedDealRecord,
} from "./training-examples";

/**
 * Everything a fit or a score needs, read out of the tenant's own tables.
 *
 * The reason this is its own service rather than three methods on the trainer:
 * training and serving must see the same definitions of the same quantities, and
 * the cheapest way to guarantee that is for one place to answer both. A trainer
 * that assembles its own history and a scorer that assembles a slightly
 * different one produce a model fitted on one distribution and applied to
 * another — the failure that looks like a model getting worse over time and is
 * actually two disagreeing readers.
 *
 * The activity aggregate is computed in SQL rather than by pulling timestamps.
 * `summariseActivityWindow` is the definition; `TRAINING_AS_OF_SQL` below is the
 * same arithmetic expressed for the planner, and `forecast-corpus.db.spec.ts`
 * asserts the two agree on real rows. Pulling every activity row for five
 * thousand deals to count them in TypeScript would be a million rows crossing
 * the wire for two integers per deal.
 */

const DAY_MS = 86_400_000;

/**
 * When a closed deal is looked at, in SQL.
 *
 * `GREATEST(created_at, LEAST(closed_at - horizon, closed_at))` — the same
 * clamp `trainingAsOf` performs, so a deal that lived less than the horizon is
 * looked at on the day it was created rather than before it existed.
 */
const closedAtSql = sql`COALESCE(${deals.actualCloseDate}::timestamp, ${deals.updatedAt})`;
const trainingAsOfSql = sql`GREATEST(${deals.createdAt}, LEAST(${closedAtSql} - make_interval(days => ${FORECAST_TRAINING_HORIZON_DAYS}), ${closedAtSql}))`;

export interface DealTimelineParts {
  readonly moves: readonly StageMove[];
  readonly activityCount: number;
  readonly lastActivityAt: Date | null;
}

export interface ClosedDealCorpusRow {
  readonly record: ClosedDealRecord;
  readonly snapshot: DealSnapshot;
  readonly asOf: Date;
  readonly timeline: DealTimelineParts;
}

export interface OpenDealCorpusRow {
  readonly snapshot: DealSnapshot;
  readonly timeline: DealTimelineParts;
}

export interface StageVocabulary {
  readonly wonKeys: readonly string[];
  readonly lostKeys: readonly string[];
  readonly stageProbabilities: ReadonlyMap<string, number>;
}

export interface ClosedCorpus {
  readonly stages: StageVocabulary;
  readonly rows: readonly ClosedDealCorpusRow[];
  readonly rates: HistoricalRates;
}

/**
 * A timestamp that came back through a raw `sql` fragment.
 *
 * The driver hands those over as text — a `sql<Date>` annotation is a claim
 * TypeScript believes and Postgres never made. Converting here is the only
 * place that has to know.
 */
function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

@Injectable()
export class ForecastCorpusService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly crmMetadata: CrmMetadataService,
  ) {}

  /**
   * The tenant's own stage vocabulary, with the probabilities they typed.
   *
   * The terminal keys decide which deals are history and which are pipeline, and
   * both readers take them from here so a deal is never simultaneously absent
   * from the pipeline and absent from the history that would explain it.
   */
  async stageVocabulary(orgId: string): Promise<StageVocabulary> {
    const metadata = await this.crmMetadata.getAggregate(orgId);
    const active = metadata.stages.filter((stage) => stage.isActive);
    const wonKeys = active.filter((s) => s.stageType === "won").map((s) => s.key);
    const lostKeys = active.filter((s) => s.stageType === "lost").map((s) => s.key);
    return {
      wonKeys: wonKeys.length > 0 ? wonKeys : ["WON"],
      lostKeys: lostKeys.length > 0 ? lostKeys : ["LOST"],
      stageProbabilities: new Map(active.map((s) => [s.key, s.probability])),
    };
  }

  /**
   * How many closed deals this organisation has, split by outcome.
   *
   * The same window and the same terminal keys the corpus uses, because the
   * readiness a surface shows has to be the readiness a training run will act
   * on. Counting all closed deals ever, while the trainer only reads two years,
   * would tell a tenant they are ready and then refuse to train them.
   */
  async closedOutcomeCounts(
    orgId: string,
    now: Date,
    stages?: StageVocabulary,
  ): Promise<{ won: number; lost: number }> {
    const vocabulary = stages ?? (await this.stageVocabulary(orgId));
    const cutoffIso = new Date(
      now.getTime() - FORECAST_FEATURE_CAPS.trainingWindowDays * DAY_MS,
    ).toISOString();

    const rows = await this.db
      .select({ stage: deals.stage, closed: sql<number>`count(*)::int` })
      .from(deals)
      .where(
        and(
          eq(deals.orgId, orgId),
          isNull(deals.deletedAt),
          inArray(deals.stage, [...vocabulary.wonKeys, ...vocabulary.lostKeys]),
          sql`${closedAtSql} >= ${cutoffIso}::timestamp`,
        ),
      )
      .groupBy(deals.stage);

    const wonKeySet = new Set(vocabulary.wonKeys);
    let won = 0;
    let lost = 0;
    for (const row of rows) {
      const closed = Number(row.closed ?? 0);
      if (wonKeySet.has(row.stage)) won += closed;
      else lost += closed;
    }
    return { won, lost };
  }

  /** Every deal's stage ledger, in one read, keyed by deal. */
  private async movesFor(
    orgId: string,
    dealIds: readonly number[],
  ): Promise<Map<number, StageMove[]>> {
    const byDeal = new Map<number, StageMove[]>();
    if (dealIds.length === 0) return byDeal;

    const rows = await this.db
      .select({
        dealId: dealStageTransitions.dealId,
        fromStage: dealStageTransitions.fromStage,
        toStage: dealStageTransitions.toStage,
        occurredAt: dealStageTransitions.occurredAt,
      })
      .from(dealStageTransitions)
      .where(
        and(
          eq(dealStageTransitions.organizationId, orgId),
          inArray(dealStageTransitions.dealId, [...dealIds]),
        ),
      );

    for (const row of rows) {
      const occurredAt = toDate(row.occurredAt);
      if (occurredAt === null) continue;
      const list = byDeal.get(row.dealId) ?? [];
      list.push({ fromStage: row.fromStage, toStage: row.toStage, occurredAt });
      byDeal.set(row.dealId, list);
    }
    return byDeal;
  }

  /**
   * How many activities each deal had at the moment it is looked at, and when
   * the last of them was.
   *
   * `asOfSql` is the caller's definition of that moment: the training horizon
   * for a closed deal, `now()` for an open one. It is a fragment rather than a
   * parameter because the moment is per-deal, and a thousand round trips to ask
   * per deal is the shape this aggregate exists to avoid.
   */
  private async activitiesFor(
    orgId: string,
    dealIds: readonly number[],
    asOfSql: ReturnType<typeof sql>,
  ): Promise<Map<number, { activityCount: number; lastActivityAt: Date | null }>> {
    const byDeal = new Map<number, { activityCount: number; lastActivityAt: Date | null }>();
    if (dealIds.length === 0) return byDeal;

    const rows = await this.db
      .select({
        dealId: dealActivities.dealId,
        activityCount: sql<number>`count(*)::int`,
        lastActivityAt: sql`max(${dealActivities.createdAt})`,
      })
      .from(dealActivities)
      .innerJoin(
        deals,
        and(eq(deals.orgId, dealActivities.orgId), eq(deals.id, dealActivities.dealId)),
      )
      .where(
        and(
          eq(dealActivities.orgId, orgId),
          inArray(dealActivities.dealId, [...dealIds]),
          sql`${dealActivities.createdAt} <= ${asOfSql}`,
        ),
      )
      .groupBy(dealActivities.dealId);

    for (const row of rows)
      byDeal.set(row.dealId, {
        activityCount: Math.min(
          Number(row.activityCount ?? 0),
          FORECAST_FEATURE_CAPS.maxActivities,
        ),
        lastActivityAt: toDate(row.lastActivityAt),
      });
    return byDeal;
  }

  /**
   * The closed deals a fit is allowed to learn from, and the rates they imply.
   *
   * Bounded twice on purpose: by a window, because a sales process from two
   * years ago is a different process, and by a row cap, because the cost of a
   * training run has to be knowable before it is scheduled. Newest first inside
   * the window, so a tenant with more history than the cap is fitted on the part
   * of it that still resembles them.
   */
  async loadClosedCorpus(orgId: string, now: Date): Promise<ClosedCorpus> {
    const stages = await this.stageVocabulary(orgId);
    const terminal = [...stages.wonKeys, ...stages.lostKeys];
    const cutoffIso = new Date(
      now.getTime() - FORECAST_FEATURE_CAPS.trainingWindowDays * DAY_MS,
    ).toISOString();

    const rows = await this.db
      .select({
        dealId: deals.id,
        createdAt: deals.createdAt,
        closedAt: sql`${closedAtSql}`,
        asOf: sql`${trainingAsOfSql}`,
        stage: deals.stage,
        valueMinor: deals.valueMinor,
        expectedCloseDate: deals.expectedCloseDate,
        assignedToId: deals.assignedToId,
        sourceKey: businessParties.acquisitionSource,
      })
      .from(deals)
      .leftJoin(
        businessParties,
        and(
          eq(businessParties.organizationId, deals.orgId),
          eq(businessParties.partyId, sql`COALESCE(${deals.partyId}, ${deals.leadPartyId})`),
        ),
      )
      .where(
        and(
          eq(deals.orgId, orgId),
          isNull(deals.deletedAt),
          inArray(deals.stage, terminal),
          sql`${closedAtSql} >= ${cutoffIso}::timestamp`,
        ),
      )
      .orderBy(sql`${closedAtSql} desc`, sql`${deals.id} desc`)
      .limit(FORECAST_FEATURE_CAPS.maxTrainingExamples);

    const dealIds = rows.map((row) => row.dealId);
    const [moves, activities] = await Promise.all([
      this.movesFor(orgId, dealIds),
      this.activitiesFor(orgId, dealIds, trainingAsOfSql),
    ]);

    const wonKeySet = new Set(stages.wonKeys);
    const corpus: ClosedDealCorpusRow[] = [];

    for (const row of rows) {
      const createdAt = toDate(row.createdAt);
      const closedAt = toDate(row.closedAt);
      const asOf = toDate(row.asOf);
      if (createdAt === null || closedAt === null || asOf === null) continue;

      const activity = activities.get(row.dealId) ?? {
        activityCount: 0,
        lastActivityAt: null,
      };

      corpus.push({
        record: {
          dealId: row.dealId,
          createdAt,
          closedAt,
          outcome: wonKeySet.has(row.stage) ? "won" : "lost",
          assignedToId: row.assignedToId,
          sourceKey: row.sourceKey,
        },
        snapshot: {
          dealId: row.dealId,
          createdAt,
          valueMinor: Number(row.valueMinor ?? 0),
          stage: row.stage,
          expectedCloseDate: row.expectedCloseDate === null ? null : new Date(row.expectedCloseDate),
          assignedToId: row.assignedToId,
          sourceKey: row.sourceKey,
        },
        asOf,
        timeline: {
          moves: moves.get(row.dealId) ?? [],
          activityCount: activity.activityCount,
          lastActivityAt: activity.lastActivityAt,
        },
      });
    }

    return {
      stages,
      rows: corpus,
      rates: buildHistoricalRates(corpus.map((row) => row.record)),
    };
  }

  /**
   * The pipeline as it stands right now.
   *
   * `asOf` is `now()` for every one of these, which is why the activity
   * aggregate here has no horizon: an open deal's whole timeline is in the past
   * by definition.
   */
  async loadOpenDeals(
    orgId: string,
    stages: StageVocabulary,
  ): Promise<readonly OpenDealCorpusRow[]> {
    const terminal = [...stages.wonKeys, ...stages.lostKeys];

    const rows = await this.db
      .select({
        dealId: deals.id,
        createdAt: deals.createdAt,
        stage: deals.stage,
        valueMinor: deals.valueMinor,
        expectedCloseDate: deals.expectedCloseDate,
        assignedToId: deals.assignedToId,
        sourceKey: businessParties.acquisitionSource,
      })
      .from(deals)
      .leftJoin(
        businessParties,
        and(
          eq(businessParties.organizationId, deals.orgId),
          eq(businessParties.partyId, sql`COALESCE(${deals.partyId}, ${deals.leadPartyId})`),
        ),
      )
      .where(
        and(
          eq(deals.orgId, orgId),
          isNull(deals.deletedAt),
          notInArray(deals.stage, terminal),
        ),
      )
      .orderBy(sql`${deals.createdAt} desc`, sql`${deals.id} desc`)
      .limit(FORECAST_FEATURE_CAPS.maxOpenDealsScored);

    const dealIds = rows.map((row) => row.dealId);
    const [moves, activities] = await Promise.all([
      this.movesFor(orgId, dealIds),
      this.activitiesFor(orgId, dealIds, sql`now()`),
    ]);

    const open: OpenDealCorpusRow[] = [];
    for (const row of rows) {
      const createdAt = toDate(row.createdAt);
      if (createdAt === null) continue;
      const activity = activities.get(row.dealId) ?? {
        activityCount: 0,
        lastActivityAt: null,
      };
      open.push({
        snapshot: {
          dealId: row.dealId,
          createdAt,
          valueMinor: Number(row.valueMinor ?? 0),
          stage: row.stage,
          expectedCloseDate: row.expectedCloseDate === null ? null : new Date(row.expectedCloseDate),
          assignedToId: row.assignedToId,
          sourceKey: row.sourceKey,
        },
        timeline: {
          moves: moves.get(row.dealId) ?? [],
          activityCount: activity.activityCount,
          lastActivityAt: activity.lastActivityAt,
        },
      });
    }
    return open;
  }
}
