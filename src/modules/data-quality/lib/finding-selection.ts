import { and, asc, count, eq, inArray } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import { dataQualityFindings } from "../../../db/schema";
import type { FindingStatus } from "../../../db/schema/crm/data-quality";
import {
  MAX_BULK,
  type AssignFindingsInput,
  type FindingSelection,
} from "../dto/data-quality.schemas";

/**
 * Turning a SELECTION into rows — the contract the resolution path is built on.
 *
 * A caller names findings one of two ways: a list of identifiers, or a group
 * key. Everything downstream of that — assigning, resolving, dismissing, undoing
 * — assumes the choice has already been collapsed to a bounded, ordered list of
 * identifiers, exactly once. This file is that one place, which is why it is the
 * only part of the queue another service calls: `DataQualityResolutionService`
 * uses `selectCandidates` and `countOpenInGroup`, and nothing else here.
 *
 * `assign` belongs with it rather than with the reads. It is the only write in
 * the queue service, it is the only caller of `selectCandidateIds`, and it is
 * "apply a selection" with the cheapest possible body — one statement, whatever
 * the size of the selection.
 *
 * Every function asserts the tenant in its own predicate. That was not covered
 * by anything when these moved: replacing `organizationId` with a literal inside
 * `selectCandidates` left all 102 data-quality tests green, which is why
 * `data-quality-tenant-isolation.spec.ts` now pins all three.
 */

export interface FindingSelectionDeps {
  readonly db: Db;
}

/**
 * Hand a selection to a person, or hand it back to the queue.
 *
 * One statement whatever the size of the selection. Assignment is the cheapest
 * bulk action there is and it would be perverse to make it the one that loops.
 */
export async function assign(
  deps: FindingSelectionDeps,
  organizationId: string,
  actorUserId: string,
  input: AssignFindingsInput,
) {
  const candidates = await selectCandidateIds(deps, organizationId, input.selection, "open");
  if (candidates.length === 0) return { assigned: 0, findingIds: [] as string[] };

  const assigning = input.assigneeUserId !== null;

  const updated = await deps.db
    .update(dataQualityFindings)
    .set({
      assignedToUserId: input.assigneeUserId,
      // Cleared together with the assignee: "assigned to nobody, by Dave, last
      // Tuesday" is a state that reads as a bug every time somebody sees it.
      assignedByUserId: assigning ? actorUserId : null,
      assignedAt: assigning ? new Date() : null,
    })
    .where(
      and(
        eq(dataQualityFindings.organizationId, organizationId),
        eq(dataQualityFindings.status, "open"),
        inArray(dataQualityFindings.findingId, candidates),
      ),
    )
    .returning({ findingId: dataQualityFindings.findingId });

  return { assigned: updated.length, findingIds: updated.map((row) => row.findingId) };
}

/**
 * The identifiers a selection names, bounded, oldest first.
 *
 * A group selection never becomes a list of identifiers on the client, and it
 * is resolved to one exactly once here — which is what makes "one decision"
 * true no matter how the caller expressed it. Oldest first so a group larger
 * than one decision is worked down from its oldest end rather than churning
 * the same arbitrary slice.
 */
export async function selectCandidateIds(
  deps: FindingSelectionDeps,
  organizationId: string,
  selection: FindingSelection,
  status: FindingStatus,
): Promise<string[]> {
  const rows = await selectCandidates(deps, organizationId, selection, status);
  return rows.map((row) => row.findingId);
}

export async function selectCandidates(
  deps: FindingSelectionDeps,
  organizationId: string,
  selection: FindingSelection,
  status: FindingStatus,
) {
  const scope =
    selection.kind === "ids"
      ? inArray(dataQualityFindings.findingId, selection.findingIds)
      : eq(dataQualityFindings.groupKey, selection.groupKey);

  return deps.db
    .select({
      findingId: dataQualityFindings.findingId,
      proposedAction: dataQualityFindings.proposedAction,
      reversibility: dataQualityFindings.reversibility,
      partyId: dataQualityFindings.partyId,
      relatedPartyId: dataQualityFindings.relatedPartyId,
      groupKey: dataQualityFindings.groupKey,
    })
    .from(dataQualityFindings)
    .where(
      and(
        eq(dataQualityFindings.organizationId, organizationId),
        eq(dataQualityFindings.status, status),
        scope,
      ),
    )
    .orderBy(asc(dataQualityFindings.firstDetectedAt), asc(dataQualityFindings.findingId))
    .limit(MAX_BULK);
}

/** How much of a group one decision left behind. */
export async function countOpenInGroup(
  deps: FindingSelectionDeps,
  organizationId: string,
  groupKey: string,
): Promise<number> {
  const [row] = await deps.db
    .select({ n: count() })
    .from(dataQualityFindings)
    .where(
      and(
        eq(dataQualityFindings.organizationId, organizationId),
        eq(dataQualityFindings.status, "open"),
        eq(dataQualityFindings.groupKey, groupKey),
      ),
    );

  return Number(row?.n ?? 0);
}
