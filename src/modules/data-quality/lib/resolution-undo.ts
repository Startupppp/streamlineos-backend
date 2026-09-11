import { ConflictException, Logger, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import { dataQualityFindings, dataQualityResolutions } from "../../../db/schema";
import { DataQualityHealthService } from "../dataset-health.service";
import { planResolutionReversal } from "../resolution-reversal";
import { MAX_BULK, type ReverseResolutionInput } from "../dto/data-quality.schemas";
import { MAX_RECORDED_FAILURES, type ExecutionFailure } from "./finding-executors";

/**
 * Taking a decision back.
 *
 * The `── Taking it back ──` half of `data-quality-resolution.service.ts`. It is
 * split from the deciding half because it is a different transaction against
 * different rows with a different concurrency claim: deciding claims findings on
 * `status = 'open'`, undoing claims the RESOLUTION on `reversed_at IS NULL`, and
 * the two predicates are the whole of what makes each one safe against a second
 * clicker. Keeping them in one file made it easy to read one claim and believe
 * you had read both.
 *
 * It also depends on strictly less: undoing never reaches an executor, because
 * nothing here can put a merge back. `planResolutionReversal` decides whether
 * the undo may run at all, and the refusal is the feature.
 */

export interface ResolutionUndoDeps {
  readonly db: Db;
  readonly health: DataQualityHealthService;
  readonly logger: Logger;
}

/**
 * Undo one decision, if its reversibility class allows it.
 *
 * The refusal is the feature. `planResolutionReversal` decides, and it refuses
 * `irreversible` outright rather than attempting a remedy that cannot work —
 * offering the button anyway teaches people that undo works when it does not.
 */
export async function reverseResolution(
  deps: ResolutionUndoDeps,
  organizationId: string,
  userId: string,
  resolutionId: string,
  input: ReverseResolutionInput,
) {
  const [resolution] = await deps.db
    .select()
    .from(dataQualityResolutions)
    .where(
      and(
        eq(dataQualityResolutions.organizationId, organizationId),
        eq(dataQualityResolutions.resolutionId, resolutionId),
      ),
    )
    .limit(1);

  if (!resolution) throw new NotFoundException("Decision not found");

  const plan = planResolutionReversal(
    {
      action: resolution.action,
      reversibility: resolution.reversibility,
      holdUntil: resolution.holdUntil,
      reversedAt: resolution.reversedAt,
      resolvedCount: resolution.resolvedCount,
    },
    new Date(),
  );

  if (!plan.ok) throw new ConflictException(plan.explanation);

  /**
   * Claim the reversal before performing it. `reversed_at IS NULL` in the
   * predicate is what makes two people clicking undo at once safe: the second
   * update matches no row and this throws, rather than both proceeding and the
   * four hundred merges being reverted twice.
   */
  const claimed = await deps.db
    .update(dataQualityResolutions)
    .set({
      reversedAt: new Date(),
      reversedByUserId: userId,
      reversedReason: input.reason ?? null,
    })
    .where(
      and(
        eq(dataQualityResolutions.organizationId, organizationId),
        eq(dataQualityResolutions.resolutionId, resolutionId),
        isNull(dataQualityResolutions.reversedAt),
      ),
    )
    .returning({ resolutionId: dataQualityResolutions.resolutionId });

  if (claimed.length === 0)
    throw new ConflictException("This decision was reversed by someone else a moment ago.");

  const closed = await deps.db
    .select({
      findingId: dataQualityFindings.findingId,
      undoToken: dataQualityFindings.undoToken,
    })
    .from(dataQualityFindings)
    .where(
      and(
        eq(dataQualityFindings.organizationId, organizationId),
        eq(dataQualityFindings.resolutionId, resolutionId),
        sql`${dataQualityFindings.status} <> 'open'`,
      ),
    )
    .orderBy(asc(dataQualityFindings.findingId))
    .limit(MAX_BULK);

  const reopenable: string[] = [];
  const failures: ExecutionFailure[] = [];

  for (const finding of closed) {
    const partyMergeId = finding.undoToken?.["partyMergeId"];

    /**
     * Nothing was done to a record, so reopening the finding is the whole
     * undo. A dismissal is always this case, which is why the planner names it
     * separately rather than dispatching a no-op per item.
     */
    if (plan.action === "reopen" || typeof partyMergeId !== "string") {
      reopenable.push(finding.findingId);
      continue;
    }

    failures.push({ findingId: finding.findingId, error: "merge revert is not supported" });
    deps.logger.warn(`merge ${partyMergeId} cannot be reverted: capability is not implemented`);
  }

  /**
   * Only what actually came back is reopened. A finding whose merge could not
   * be undone stays closed, because reopening it would claim a record was
   * restored when it was not — and the next sweep would then file a second
   * finding for a problem that is still fixed.
   */
  const reopened = await reopen(deps, organizationId, reopenable);

  await deps.db
    .update(dataQualityResolutions)
    .set({ reversedCount: reopened })
    .where(
      and(
        eq(dataQualityResolutions.organizationId, organizationId),
        eq(dataQualityResolutions.resolutionId, resolutionId),
      ),
    );

  // An undo puts findings back in the queue, so the number goes back up. A
  // trend that only ever recorded improvements would be a graph of decisions
  // taken rather than of the dataset.
  await deps.health.captureQuietly(organizationId);

  return {
    reversed: true,
    action: plan.action,
    reopened,
    failedCount: failures.length,
    failures: failures.slice(0, MAX_RECORDED_FAILURES),
  };
}

/**
 * One statement, again.
 *
 * `resolutionId` is deliberately left in place: a reopened finding still
 * points at the last decision taken about it, which is how "what did that
 * reversal actually cover" stays answerable afterwards.
 */
async function reopen(
  deps: ResolutionUndoDeps,
  organizationId: string,
  findingIds: string[],
): Promise<number> {
  if (findingIds.length === 0) return 0;

  const rows = await deps.db
    .update(dataQualityFindings)
    .set({
      status: "open",
      resolvedAt: null,
      resolvedByUserId: null,
      undoToken: null,
    })
    .where(
      and(
        eq(dataQualityFindings.organizationId, organizationId),
        inArray(dataQualityFindings.findingId, findingIds),
      ),
    )
    .returning({ findingId: dataQualityFindings.findingId });

  return rows.length;
}
