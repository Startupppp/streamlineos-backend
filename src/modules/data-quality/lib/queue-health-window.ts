import { and, asc, count, eq, gte } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import { dataQualityFindings } from "../../../db/schema";
import type { FindingSeverity } from "../../../db/schema/crm/data-quality";
import { SEVERITY_WEIGHTS, weightedOpenCount } from "../finding-vocabulary";
import type { HealthQuery } from "../dto/data-quality.schemas";

const DAY_MS = 24 * 60 * 60 * 1000;

const ageInDays = (from: Date, now: number): number =>
  Math.max(0, Math.floor((now - from.getTime()) / DAY_MS));

/**
 * The queue as ONE NUMBER, over the whole of it.
 *
 * Everything else on `DataQualityQueueService` answers "what is in the queue"
 * and hands back a page of it — a keyset window, a `GROUP BY` capped by the
 * caller's limit, a decision ledger. This answers "is it getting better", and it
 * cannot be paged: the totals, the window's opened and closed counts and the
 * oldest open item are each an aggregate over every row the tenant has. Five
 * whole-table reads behind one `Promise.all` behave nothing like a cursor page,
 * and mixing them into the same file made that easy to miss.
 *
 * A standing number alone cannot answer the question the ticket asks — a tenant
 * with 400 open findings that were 900 last month is winning, and one with 40
 * that were 4 is not — so the window's opened and closed counts sit beside the
 * total, and their difference is the only figure that says which.
 *
 * Not to be confused with `dataset-health.service.ts`, which is the SNAPSHOT
 * series: it records a composite per day so a trend survives a restart. This is
 * the live read of the same queue, and the two deliberately answer over
 * different horizons.
 */

export interface QueueHealthDeps {
  readonly db: Db;
}

export async function queueHealth(
  deps: QueueHealthDeps,
  organizationId: string,
  query: HealthQuery,
) {
  const since = new Date(Date.now() - query.days * DAY_MS);

  const [bySeverity, byProducer, opened, closed, oldest] = await Promise.all([
    deps.db
      .select({ severity: dataQualityFindings.severity, n: count() })
      .from(dataQualityFindings)
      .where(
        and(
          eq(dataQualityFindings.organizationId, organizationId),
          eq(dataQualityFindings.status, "open"),
        ),
      )
      .groupBy(dataQualityFindings.severity),

    deps.db
      .select({
        producer: dataQualityFindings.producer,
        severity: dataQualityFindings.severity,
        n: count(),
      })
      .from(dataQualityFindings)
      .where(
        and(
          eq(dataQualityFindings.organizationId, organizationId),
          eq(dataQualityFindings.status, "open"),
        ),
      )
      .groupBy(dataQualityFindings.producer, dataQualityFindings.severity),

    deps.db
      .select({ n: count() })
      .from(dataQualityFindings)
      .where(
        and(
          eq(dataQualityFindings.organizationId, organizationId),
          gte(dataQualityFindings.firstDetectedAt, since),
        ),
      ),

    deps.db
      .select({ status: dataQualityFindings.status, n: count() })
      .from(dataQualityFindings)
      .where(
        and(
          eq(dataQualityFindings.organizationId, organizationId),
          gte(dataQualityFindings.resolvedAt, since),
        ),
      )
      .groupBy(dataQualityFindings.status),

    deps.db
      .select({ firstDetectedAt: dataQualityFindings.firstDetectedAt })
      .from(dataQualityFindings)
      .where(
        and(
          eq(dataQualityFindings.organizationId, organizationId),
          eq(dataQualityFindings.status, "open"),
        ),
      )
      .orderBy(asc(dataQualityFindings.firstDetectedAt))
      .limit(1),
  ]);

  const severityCounts = bySeverity.map((row) => ({
    severity: row.severity,
    count: Number(row.n),
  }));

  const openTotal = severityCounts.reduce((total, row) => total + row.count, 0);
  const openedInWindow = Number(opened[0]?.n ?? 0);
  const closedInWindow = closed.reduce((total, row) => total + Number(row.n), 0);
  const oldestOpenAt = oldest[0]?.firstDetectedAt ?? null;

  const producers = new Map<string, { producer: string; count: number; weight: number }>();
  for (const row of byProducer) {
    const entry = producers.get(row.producer) ?? {
      producer: row.producer,
      count: 0,
      weight: 0,
    };
    entry.count += Number(row.n);
    entry.weight += SEVERITY_WEIGHTS[row.severity] * Number(row.n);
    producers.set(row.producer, entry);
  }

  return {
    windowDays: query.days,
    open: {
      total: openTotal,
      weighted: weightedOpenCount(severityCounts),
      bySeverity: severityMap(severityCounts),
      byProducer: [...producers.values()].sort((a, b) => b.weight - a.weight),
    },
    trend: {
      openedInWindow,
      closedInWindow,
      resolvedInWindow: Number(closed.find((row) => row.status === "resolved")?.n ?? 0),
      dismissedInWindow: Number(closed.find((row) => row.status === "dismissed")?.n ?? 0),
      /** Positive means the backlog grew. The only number worth a graph. */
      net: openedInWindow - closedInWindow,
    },
    oldestOpenAt,
    oldestOpenAgeDays: oldestOpenAt ? ageInDays(oldestOpenAt, Date.now()) : null,
  };
}

/** Every severity present, so a caller never has to decide what a gap means. */
function severityMap(
  counts: readonly { severity: FindingSeverity; count: number }[],
): Record<FindingSeverity, number> {
  const map: Record<FindingSeverity, number> = { high: 0, medium: 0, low: 0 };
  for (const row of counts) map[row.severity] = row.count;
  return map;
}
