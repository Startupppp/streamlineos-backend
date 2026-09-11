/**
 * Reading sequences: a page of them with their lengths, and one with its steps.
 *
 * The writes to a sequence stay on `NurtureSequencesService`, beside the
 * unique-name conflict they share.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { buildCursorPage, decodeCursor, type CursorPage } from "../../../../common/pagination/cursor";
import { keysetBefore } from "../../../../common/pagination/keyset";
import type { Db } from "../../../../db/drizzle.types";
import { crmNurtureSequences } from "../../../../db/schema";
import type { ListNurtureSequencesQuery } from "../dto/nurture.schemas";
import type { NurtureSequenceSummary, NurtureStepView } from "../nurture-sequences.types";
import { countSteps, requireSequence } from "./nurture-lookups";
import { listSequenceSteps } from "./nurture-steps";

export async function listSequencesPage(
  db: Db,
  organizationId: string,
  query: ListNurtureSequencesQuery,
): Promise<CursorPage<NurtureSequenceSummary>> {
  const position = decodeCursor(query.cursor);

  const rows = await db
    .select({
      nurtureSequenceId: crmNurtureSequences.nurtureSequenceId,
      name: crmNurtureSequences.name,
      description: crmNurtureSequences.description,
      status: crmNurtureSequences.status,
      createdAt: crmNurtureSequences.createdAt,
      updatedAt: crmNurtureSequences.updatedAt,
    })
    .from(crmNurtureSequences)
    .where(
      and(
        eq(crmNurtureSequences.organizationId, organizationId),
        isNull(crmNurtureSequences.deletedAt),
        query.status ? eq(crmNurtureSequences.status, query.status) : undefined,
        position
          ? keysetBefore(
              crmNurtureSequences.createdAt,
              crmNurtureSequences.nurtureSequenceId,
              position,
            )
          : undefined,
      ),
    )
    .orderBy(desc(crmNurtureSequences.createdAt), desc(crmNurtureSequences.nurtureSequenceId))
    .limit(query.limit + 1);

  /**
   * The step count in one grouped read over the page, not one read per row.
   *
   * A cadence rendered without its length is unreadable — "Post-demo" says
   * nothing about whether it is two touches or twelve — but asking per
   * sequence would make the list N+1 for a number that costs one query.
   */
  const stepCounts = await countSteps(
    db,
    organizationId,
    rows.map((row) => row.nurtureSequenceId),
  );

  return buildCursorPage(
    rows.map((row) => ({ ...row, stepCount: stepCounts.get(row.nurtureSequenceId) ?? 0 })),
    query.limit,
    (row) => ({ sortValue: row.createdAt.toISOString(), id: row.nurtureSequenceId }),
  );
}

export async function getSequenceWithSteps(
  db: Db,
  organizationId: string,
  nurtureSequenceId: string,
): Promise<{ sequence: NurtureSequenceSummary; steps: NurtureStepView[] }> {
  const sequence = await requireSequence(db, organizationId, nurtureSequenceId);
  const steps = await listSequenceSteps(db, organizationId, nurtureSequenceId);

  return {
    sequence: { ...sequence, stepCount: steps.length },
    steps,
  };
}
