import { Logger } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import { dataQualityFindings } from "../../../db/schema";
import { PartyMergeService } from "../../party/party-merge.service";
import { refuseIfContradicted } from "../merge-guard";
import { withSavepoint } from "../savepoint";

/**
 * Performing what a finding PROPOSED, one item at a time.
 *
 * The `── Executors ──` half of `data-quality-resolution.service.ts`, and the
 * one part of a bulk decision that is not set-based. Everything else about
 * resolving is a single statement whatever the size of the selection; a merge
 * is irreducibly pairwise, so this is where the `for` lives — and, because it
 * loops, where the per-item isolation and the per-item failure record live too.
 *
 * That is the seam: the decision path decides and claims, and hands the claimed
 * rows here. A failure in here costs one finding and reopens it carrying why,
 * which is the opposite of how the claim above it behaves, where a failure costs
 * the whole decision. Two different answers to "what does a failure cost" is not
 * a split worth arguing with.
 *
 * `ExecutionFailure` and its recording cap are declared here rather than beside
 * the decision, because this is the only thing that produces one.
 */

/** Enough failures for a person to see the pattern; not a second copy of the queue. */
export const MAX_RECORDED_FAILURES = 50;

export interface ClaimedFinding {
  findingId: string;
  proposedAction: string;
  partyId: string;
  relatedPartyId: string | null;
}

export interface ExecutionFailure {
  findingId: string;
  error: string;
}

export interface FindingExecutorDeps {
  readonly db: Db;
  readonly merges: PartyMergeService;
  readonly logger: Logger;
}

/**
 * Perform what each claimed finding proposed.
 *
 * `none` is the common case and costs nothing: most findings exist so a person
 * looks at a record, and there is no safe automatic remedy to run. Only
 * `merge-parties` executes, and merging is irreducibly pairwise — there is no
 * set-based statement that merges four hundred pairs — so it is the one thing
 * here that iterates, and every iteration is isolated.
 */
export async function applyAll(
  deps: FindingExecutorDeps,
  organizationId: string,
  userId: string,
  claimed: readonly ClaimedFinding[],
): Promise<ExecutionFailure[]> {
  const failures: ExecutionFailure[] = [];

  for (const finding of claimed) {
    if (finding.proposedAction === "none") continue;

    try {
      const undoToken = await withSavepoint(() => execute(deps, organizationId, userId, finding));
      await deps.db
        .update(dataQualityFindings)
        .set({ undoToken })
        .where(
          and(
            eq(dataQualityFindings.organizationId, organizationId),
            eq(dataQualityFindings.findingId, finding.findingId),
          ),
        );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ findingId: finding.findingId, error: message });
      deps.logger.warn(`finding ${finding.findingId} could not be applied: ${message}`);
      await reopenFailed(deps, organizationId, finding.findingId, message);
    }
  }

  return failures;
}

async function execute(
  deps: FindingExecutorDeps,
  organizationId: string,
  userId: string,
  finding: ClaimedFinding,
): Promise<Record<string, unknown>> {
  if (finding.proposedAction !== "merge-parties")
    throw new Error(`No executor for ${finding.proposedAction}`);

  if (!finding.relatedPartyId)
    throw new Error("A merge needs two parties and this finding names one");

  await refuseIfContradicted(deps.db, organizationId, finding.partyId, finding.relatedPartyId);

  const outcome = await deps.merges.merge(organizationId, {
    leftPartyId: finding.partyId,
    rightPartyId: finding.relatedPartyId,
    // A human confirmed this one, which is what separates it from the merges
    // the detector was confident enough to make on its own.
    decidedBy: "USER",
    userId,
  });

  /**
   * Captured now, not reconstructed later. `party_merges` holds both rows
   * verbatim, and this is the pointer an undo replays — deriving it afterwards
   * from the surviving record cannot tell a field the merge filled from one a
   * person edited since.
   */
  return {
    partyMergeId: outcome.partyMergeId,
    survivorPartyId: outcome.survivorPartyId,
    mergedPartyId: outcome.mergedPartyId,
  };
}

/**
 * Put one failed item back in the queue, carrying why.
 *
 * The other items in the decision stay resolved. That asymmetry is the point
 * of the savepoint: a bulk decision is not all-or-nothing, because insisting
 * it were would mean one unmergeable pair discarding three hundred and
 * ninety-nine successful merges.
 */
async function reopenFailed(
  deps: FindingExecutorDeps,
  organizationId: string,
  findingId: string,
  message: string,
) {
  await deps.db
    .update(dataQualityFindings)
    .set({
      status: "open",
      resolvedAt: null,
      resolvedByUserId: null,
      lastError: message.slice(0, 500),
      attemptCount: sql`${dataQualityFindings.attemptCount} + 1`,
    })
    .where(
      and(
        eq(dataQualityFindings.organizationId, organizationId),
        eq(dataQualityFindings.findingId, findingId),
      ),
    );
}
