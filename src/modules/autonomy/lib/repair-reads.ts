/**
 * What the repair loop did, read back: the page of individual repairs, and the
 * loop's measure against the human queue.
 *
 * Nothing here writes. Both are the half of `AutonomyRepairService` a manager
 * looks at, answered from `autonomy_repairs` and the data-quality queue's own
 * counts.
 */
import { and, count, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBefore } from "../../../common/pagination/keyset";
import type { Db } from "../../../db/drizzle.types";
import { autonomyRepairs, businessParties } from "../../../db/schema";
import type { RepairDeps } from "../autonomy-repair.types";
import type { ListRepairsQuery } from "../dto/autonomy-review.schemas";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function listRepairsPage(db: Db, organizationId: string, query: ListRepairsQuery) {
  const position = decodeCursor(query.cursor);
  const conditions = and(
    eq(autonomyRepairs.organizationId, organizationId),
    query.repairClass ? eq(autonomyRepairs.repairClass, query.repairClass) : undefined,
    query.revertedOnly ? isNotNull(autonomyRepairs.revertedAt) : undefined,
  );

  const keyset = position
    ? and(
        conditions,
        keysetBefore(autonomyRepairs.appliedAt, autonomyRepairs.autonomyRepairId, position),
      )
    : conditions;

  const rows = await db
    .select({
      autonomyRepairId: autonomyRepairs.autonomyRepairId,
      autonomousDecisionId: autonomyRepairs.autonomousDecisionId,
      repairClass: autonomyRepairs.repairClass,
      findingId: autonomyRepairs.findingId,
      partyId: autonomyRepairs.partyId,
      field: autonomyRepairs.field,
      previousValue: autonomyRepairs.previousValue,
      repairedValue: autonomyRepairs.repairedValue,
      appliedAt: autonomyRepairs.appliedAt,
      revertedAt: autonomyRepairs.revertedAt,
      revertedByUserId: autonomyRepairs.revertedByUserId,
      revertedReason: autonomyRepairs.revertedReason,
      partyName: businessParties.name,
    })
    .from(autonomyRepairs)
    .leftJoin(
      businessParties,
      and(
        eq(businessParties.organizationId, autonomyRepairs.organizationId),
        eq(businessParties.partyId, autonomyRepairs.partyId),
      ),
    )
    .where(keyset)
    .orderBy(desc(autonomyRepairs.appliedAt), desc(autonomyRepairs.autonomyRepairId))
    .limit(query.limit + 1);

  return buildCursorPage(rows, query.limit, (row) => ({
    sortValue: row.appliedAt.toISOString(),
    id: row.autonomyRepairId,
  }));
}

export async function measureRepairLoop(
  deps: Pick<RepairDeps, "db" | "queue">,
  organizationId: string,
  days: number,
) {
  const since = new Date(Date.now() - days * DAY_MS);

  const [mix, health, byClass] = await Promise.all([
    deps.queue.resolutionMix(organizationId, since),
    deps.queue.health(organizationId, { days }),
    deps.db
      .select({
        repairClass: autonomyRepairs.repairClass,
        applied: count(),
        reverted: sql<number>`count(*) FILTER (WHERE ${autonomyRepairs.revertedAt} IS NOT NULL)`,
      })
      .from(autonomyRepairs)
      .where(
        and(
          eq(autonomyRepairs.organizationId, organizationId),
          gte(autonomyRepairs.appliedAt, since),
        ),
      )
      .groupBy(autonomyRepairs.repairClass),
  ]);

  const decided = mix.automated + mix.manual;

  return {
    windowDays: days,
    resolution: {
      ...mix,
      /**
       * Null rather than zero when nothing was decided. A ratio over an empty
       * window is not "no automation"; it is no evidence, and the two look the
       * same on a chart only if one of them lies.
       */
      automatedShare: decided > 0 ? mix.automated / decided : null,
    },
    repairs: {
      byClass: byClass.map((row) => ({
        repairClass: row.repairClass,
        applied: Number(row.applied),
        reverted: Number(row.reverted),
      })),
      applied: byClass.reduce((total, row) => total + Number(row.applied), 0),
      reverted: byClass.reduce((total, row) => total + Number(row.reverted), 0),
    },
    /** What the system did not take, in the shape it was left in. */
    remaining: {
      total: health.open.total,
      weighted: health.open.weighted,
      byProducer: health.open.byProducer,
      oldestOpenAgeDays: health.oldestOpenAgeDays,
    },
  };
}
