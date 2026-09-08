import { ConflictException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import { dataQualityResolutions } from "../../db/schema";

/** Enough failures for a person to see the pattern; not a second copy of the queue. */
export const MAX_RECORDED_FAILURES = 50;

type DecisionRow = typeof dataQualityResolutions.$inferInsert;

export type DecisionInput = Omit<DecisionRow, "resolvedCount">;

export type DecisionOutcome = Pick<DecisionRow, "resolvedCount" | "failedCount" | "failures">;

/**
 * The decision row, written before anything is claimed.
 *
 * It has to exist first because every claimed finding carries a foreign key to
 * it, so the counts it will end up reporting are filled in afterwards.
 */
export async function openDecision(db: Db, input: DecisionInput): Promise<string> {
  const [resolution] = await db
    .insert(dataQualityResolutions)
    .values({ ...input, resolvedCount: 0 })
    .returning({ resolutionId: dataQualityResolutions.resolutionId });

  if (!resolution) throw new ConflictException("The decision could not be recorded");
  return resolution.resolutionId;
}

export async function recordDecisionOutcome(
  db: Db,
  organizationId: string,
  resolutionId: string,
  outcome: DecisionOutcome,
): Promise<void> {
  await db
    .update(dataQualityResolutions)
    .set(outcome)
    .where(
      and(
        eq(dataQualityResolutions.organizationId, organizationId),
        eq(dataQualityResolutions.resolutionId, resolutionId),
      ),
    );
}

export async function loadDecision(db: Db, organizationId: string, resolutionId: string) {
  const [resolution] = await db
    .select()
    .from(dataQualityResolutions)
    .where(
      and(
        eq(dataQualityResolutions.organizationId, organizationId),
        eq(dataQualityResolutions.resolutionId, resolutionId),
      ),
    )
    .limit(1);

  return resolution;
}

/**
 * Claim the reversal before performing it.
 *
 * `reversed_at IS NULL` in the predicate is what makes two people clicking undo
 * at once safe: the second update matches no row and the caller refuses, rather
 * than both proceeding and the four hundred merges being reverted twice.
 */
export async function claimReversal(
  db: Db,
  organizationId: string,
  resolutionId: string,
  userId: string,
  reason: string | null,
): Promise<boolean> {
  const claimed = await db
    .update(dataQualityResolutions)
    .set({ reversedAt: new Date(), reversedByUserId: userId, reversedReason: reason })
    .where(
      and(
        eq(dataQualityResolutions.organizationId, organizationId),
        eq(dataQualityResolutions.resolutionId, resolutionId),
        isNull(dataQualityResolutions.reversedAt),
      ),
    )
    .returning({ resolutionId: dataQualityResolutions.resolutionId });

  return claimed.length > 0;
}

export async function recordReversedCount(
  db: Db,
  organizationId: string,
  resolutionId: string,
  reversedCount: number,
): Promise<void> {
  await db
    .update(dataQualityResolutions)
    .set({ reversedCount })
    .where(
      and(
        eq(dataQualityResolutions.organizationId, organizationId),
        eq(dataQualityResolutions.resolutionId, resolutionId),
      ),
    );
}
