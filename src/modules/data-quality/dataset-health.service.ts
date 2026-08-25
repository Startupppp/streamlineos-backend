import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, count, eq, gte } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { dataQualityFindings, dataQualityHealthSnapshots } from "../../db/schema";
import {
  datasetHealth,
  healthDirection,
  type DatasetHealth,
  type HealthDirection,
  type OpenFindingCount,
} from "./dataset-health";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The longest series any window can produce, and the cap every read here obeys.
 *
 * One point per day and a window capped at a year means 365 rows; 400 is the
 * platform's limit ceiling and leaves the headroom without inventing a second
 * number.
 */
const MAX_SERIES_POINTS = 400;

/** The UTC day a snapshot belongs to, as the `date` column stores it. */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export interface HealthSeriesPoint {
  readonly capturedOn: string;
  readonly composite: number;
  readonly openTotal: number;
}

export interface DatasetHealthTrend {
  readonly windowDays: number;
  /** What is true right now, read from the queue rather than from a snapshot. */
  readonly current: DatasetHealth;
  readonly series: readonly HealthSeriesPoint[];
  /** The oldest recorded point in the window — what "since then" means. */
  readonly baseline: HealthSeriesPoint | null;
  /** Negative is progress, because the composite is a penalty. */
  readonly delta: number | null;
  readonly direction: HealthDirection | null;
}

/**
 * How bad the dataset is, recorded so the answer has a direction.
 *
 * Separate from `DataQualityQueueService` because it is the module's only
 * scheduled-shaped write: everything else here is a read or a decision somebody
 * took, while this is bookkeeping that runs *because* of those. Keeping it apart
 * is also what lets the autonomy scoreboard depend on this one small service
 * rather than on the queue, its cursors and its resolution machinery.
 *
 * `current` is always read live and never served from the newest snapshot. A
 * snapshot is a record of a day, and a tenant whose last capture was Tuesday
 * should see today's number today — not Tuesday's, quietly relabelled.
 */
@Injectable()
export class DataQualityHealthService {
  private readonly logger = new Logger("DataQualityHealth");

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * The open queue, grouped the two ways the composite needs at once.
   *
   * One `GROUP BY producer, severity` rather than two queries: severity gives
   * the weight and producer gives the class, and deriving both from the same
   * rows is what stops the totals disagreeing when a sweep lands between them.
   */
  private async openCounts(organizationId: string): Promise<OpenFindingCount[]> {
    const rows = await this.db
      .select({
        producer: dataQualityFindings.producer,
        severity: dataQualityFindings.severity,
        n: count(),
      })
      .from(dataQualityFindings)
      .where(
        and(
          eq(dataQualityFindings.organizationId, organizationId),
          // The predicate the whole number rests on. A composite counting closed
          // findings would never move however hard anyone worked the queue.
          eq(dataQualityFindings.status, "open"),
        ),
      )
      .groupBy(dataQualityFindings.producer, dataQualityFindings.severity);

    return rows.map((row) => ({
      producer: row.producer,
      severity: row.severity,
      count: Number(row.n),
    }));
  }

  /** The composite as it stands, decomposed by class. Reads nothing recorded. */
  async current(organizationId: string): Promise<DatasetHealth> {
    return datasetHealth(await this.openCounts(organizationId));
  }

  /**
   * Compute the composite and record today's point.
   *
   * Upserts, so calling it from every path that changes the number costs one
   * statement and cannot flood the table. Today's row is overwritten rather than
   * appended to: a day has one value, which is whatever was true the last time
   * anything happened.
   */
  async capture(organizationId: string): Promise<DatasetHealth> {
    const health = await this.current(organizationId);
    const capturedOn = utcDay(new Date());

    const point = {
      composite: health.composite,
      openTotal: health.openTotal,
      byClass: [...health.byClass],
      bySeverity: health.bySeverity,
      capturedAt: new Date(),
    };

    await this.db
      .insert(dataQualityHealthSnapshots)
      .values({ organizationId, capturedOn, ...point })
      .onConflictDoUpdate({
        target: [
          dataQualityHealthSnapshots.organizationId,
          dataQualityHealthSnapshots.capturedOn,
        ],
        set: point,
      });

    return health;
  }

  /**
   * Record the point, but never at the cost of the work that triggered it.
   *
   * The callers are a bulk resolution and a sweep — writes a person is waiting
   * on. Failing a merge of four hundred records because the graph could not be
   * written would be the tail wagging the dog, and the next capture recovers the
   * missing point anyway since the composite is read live rather than
   * accumulated.
   */
  async captureQuietly(organizationId: string): Promise<void> {
    try {
      await this.capture(organizationId);
    } catch (error) {
      this.logger.warn(
        `dataset health not recorded for ${organizationId}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * The number, the series behind it, and which way it went.
   *
   * The direction compares today against the *oldest* point in the window rather
   * than the previous one. "Better than yesterday" is noise — a sweep ran, or it
   * did not — while "better than a month ago" is the question somebody asks when
   * they are deciding whether the triage was worth the time.
   */
  async trend(organizationId: string, windowDays: number): Promise<DatasetHealthTrend> {
    const since = utcDay(new Date(Date.now() - windowDays * DAY_MS));

    const [current, rows] = await Promise.all([
      this.current(organizationId),
      this.db
        .select({
          capturedOn: dataQualityHealthSnapshots.capturedOn,
          composite: dataQualityHealthSnapshots.composite,
          openTotal: dataQualityHealthSnapshots.openTotal,
        })
        .from(dataQualityHealthSnapshots)
        .where(
          and(
            eq(dataQualityHealthSnapshots.organizationId, organizationId),
            // `date` sorts and compares as YYYY-MM-DD, so lexicographic and
            // chronological are the same order and no cast is needed.
            gte(dataQualityHealthSnapshots.capturedOn, since),
          ),
        )
        .orderBy(asc(dataQualityHealthSnapshots.capturedOn))
        .limit(MAX_SERIES_POINTS),
    ]);

    const series: HealthSeriesPoint[] = rows.map((row) => ({
      capturedOn: row.capturedOn,
      composite: row.composite,
      openTotal: row.openTotal,
    }));

    const baseline = series[0] ?? null;

    return {
      windowDays,
      current,
      series,
      baseline,
      delta: baseline ? current.composite - baseline.composite : null,
      direction: healthDirection(current.composite, baseline?.composite ?? null),
    };
  }
}
