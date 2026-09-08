import { NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import { dataQualityFindings } from "../../db/schema";
import { MAX_BULK } from "./dto/data-quality.schemas";

export interface ClaimedFinding {
  findingId: string;
  proposedAction: string;
  partyId: string;
  relatedPartyId: string | null;
}

export interface ClaimInput {
  organizationId: string;
  userId: string;
  resolutionId: string;
  findingIds: string[];
  status: "resolved" | "dismissed";
}

/** One statement, whatever the size of the selection. */
/** Membership is checked before the status filter, so a foreign id is not a skip. */
export async function assertFindingsInOrg(
  db: Db,
  organizationId: string,
  findingIds: readonly string[],
): Promise<void> {
  const requestedIds = [...new Set(findingIds)];
  const owned = await db
    .select({ findingId: dataQualityFindings.findingId })
    .from(dataQualityFindings)
    .where(
      and(
        eq(dataQualityFindings.organizationId, organizationId),
        inArray(dataQualityFindings.findingId, requestedIds),
      ),
    )
    .limit(requestedIds.length);
  if (owned.length !== requestedIds.length)
    throw new NotFoundException("No open findings matched this selection");
}

/**
 * Take the open findings this decision covers, in one conditional update.
 *
 * `status = 'open'` sits in the predicate, so two people deciding about
 * overlapping selections at the same instant each take the rows the other has
 * not, and neither fails. A read-then-write would let both believe they had all
 * four hundred.
 */
export async function claimFindings(db: Db, input: ClaimInput): Promise<ClaimedFinding[]> {
  if (input.findingIds.length === 0) return [];

  return db
    .update(dataQualityFindings)
    .set({
      status: input.status,
      resolvedAt: new Date(),
      resolvedByUserId: input.userId,
      resolutionId: input.resolutionId,
      lastError: null,
    })
    .where(
      and(
        eq(dataQualityFindings.organizationId, input.organizationId),
        eq(dataQualityFindings.status, "open"),
        inArray(dataQualityFindings.findingId, input.findingIds),
      ),
    )
    .returning({
      findingId: dataQualityFindings.findingId,
      proposedAction: dataQualityFindings.proposedAction,
      partyId: dataQualityFindings.partyId,
      relatedPartyId: dataQualityFindings.relatedPartyId,
    });
}

/** Everything one decision closed, with whatever undoing it would need. */
export async function listClosedForResolution(
  db: Db,
  organizationId: string,
  resolutionId: string,
) {
  return db
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
}

/**
 * One statement, again.
 *
 * `resolutionId` is deliberately left in place: a reopened finding still points
 * at the last decision taken about it, which is how "what did that reversal
 * actually cover" stays answerable afterwards.
 */
export async function reopenFindings(
  db: Db,
  organizationId: string,
  findingIds: string[],
): Promise<number> {
  if (findingIds.length === 0) return 0;

  const rows = await db
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

/**
 * Put one failed item back in the queue, carrying why.
 *
 * The other items in the decision stay resolved. That asymmetry is the point of
 * the savepoint: a bulk decision is not all-or-nothing, because insisting it
 * were would mean one unmergeable pair discarding three hundred and ninety-nine
 * successful merges.
 */
export async function reopenFailedFinding(
  db: Db,
  organizationId: string,
  findingId: string,
  message: string,
): Promise<void> {
  await db
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
