/**
 * The existence checks and the step count every nurture read and write leans
 * on.
 *
 * Each re-asserts the organisation in its own predicate, so a sequence,
 * customer or deal belonging to another tenant reads as absent — a 404 —
 * rather than as somebody else's row. This file imports no other nurture lib,
 * which is what lets every other one import it.
 */
import { NotFoundException } from "@nestjs/common";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.types";
import {
  businessParties,
  crmNurtureSequenceSteps,
  crmNurtureSequences,
  deals,
} from "../../../../db/schema";
import type { NurtureSequenceSummary } from "../nurture-sequences.types";

export async function requireSequence(
  db: Db,
  organizationId: string,
  nurtureSequenceId: string,
): Promise<Omit<NurtureSequenceSummary, "stepCount">> {
  const [sequence] = await db
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
        eq(crmNurtureSequences.nurtureSequenceId, nurtureSequenceId),
        isNull(crmNurtureSequences.deletedAt),
      ),
    )
    .limit(1);

  if (!sequence) throw new NotFoundException("Sequence not found");
  return sequence;
}

export async function requireParty(db: Db, organizationId: string, partyId: string): Promise<void> {
  const [party] = await db
    .select({ partyId: businessParties.partyId })
    .from(businessParties)
    .where(
      and(
        eq(businessParties.organizationId, organizationId),
        eq(businessParties.partyId, partyId),
        isNull(businessParties.deletedAt),
      ),
    )
    .limit(1);

  if (!party) throw new NotFoundException("Customer not found");
}

/**
 * Resolves the wire's string to the integer the column holds.
 *
 * The existence check is not decoration: `deal_id` carries a foreign key, so
 * an unknown deal would fail on the insert as a `23503` and reach the caller
 * as a 500 rather than as the 404 it is.
 */
export async function requireDeal(db: Db, organizationId: string, dealId: string): Promise<number> {
  const numeric = Number(dealId);

  const [deal] = await db
    .select({ id: deals.id })
    .from(deals)
    .where(and(eq(deals.orgId, organizationId), eq(deals.id, numeric), isNull(deals.deletedAt)))
    .limit(1);

  if (!deal) throw new NotFoundException("Deal not found");
  return deal.id;
}

export async function countSteps(
  db: Db,
  organizationId: string,
  nurtureSequenceIds: string[],
): Promise<Map<string, number>> {
  if (nurtureSequenceIds.length === 0) return new Map();

  const rows = await db
    .select({
      nurtureSequenceId: crmNurtureSequenceSteps.nurtureSequenceId,
      steps: count(),
    })
    .from(crmNurtureSequenceSteps)
    .where(
      and(
        eq(crmNurtureSequenceSteps.organizationId, organizationId),
        inArray(crmNurtureSequenceSteps.nurtureSequenceId, nurtureSequenceIds),
      ),
    )
    .groupBy(crmNurtureSequenceSteps.nurtureSequenceId);

  return new Map(rows.map((row) => [row.nurtureSequenceId, Number(row.steps)]));
}
