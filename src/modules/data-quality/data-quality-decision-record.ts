import { ConflictException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import { dataQualityResolutions } from "../../db/schema";

export const MAX_RECORDED_FAILURES = 50;

type DecisionRow = typeof dataQualityResolutions.$inferInsert;

export type DecisionInput = Omit<DecisionRow, "resolvedCount">;

export type DecisionOutcome = Pick<DecisionRow, "resolvedCount" | "failedCount" | "failures">;

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
