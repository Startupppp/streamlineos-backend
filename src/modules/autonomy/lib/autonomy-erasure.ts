/**
 * Erasure of one party from the autonomy measurement stores.
 *
 * A separate file because it is a separate obligation. Everything else in
 * `AutonomyScoringService` answers "is this working"; this answers a data-subject
 * request, and it is the only path in the module that deletes rows and blanks
 * free text on purpose.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import {
  autonomousDecisions,
  autonomyCorrections,
  autonomyShadowScores,
} from "../../../db/schema";

export interface AutonomyErasureDeps {
  readonly db: Db;
}

/**
 * Remove everything about one party from the measurement stores.
 *
 * Evaluation datasets are within the scope of an erasure request, and the
 * corrections that feed them carry the customer's own words. Erasure that
 * reaches the CRM record but leaves the training material behind is nominal
 * rather than complete.
 *
 * This is deliberately a separate path from `purge-user.mjs`, which deletes
 * rows referencing a *user account* — an employee. The subject of an erasure
 * request is the person on the other side of the conversation, and nothing
 * about them is a foreign key.
 *
 * The decision rows themselves survive with their free text cleared. An audit
 * trail that loses the record of an action is a different kind of failure, and
 * the identifiers left behind resolve to nobody once the party is gone.
 */
export async function erasePartyData(
  deps: AutonomyErasureDeps,
  organizationId: string,
  partyId: string,
) {
  const decisions = await deps.db
    .select({ id: autonomousDecisions.autonomousDecisionId })
    .from(autonomousDecisions)
    .where(
      and(
        eq(autonomousDecisions.organizationId, organizationId),
        eq(autonomousDecisions.partyId, partyId),
      ),
    );

  if (decisions.length === 0) return { decisions: 0, corrections: 0, scores: 0 };

  const ids = decisions.map((d) => d.id);

  const [corrections, scores] = await Promise.all([
    deps.db
      .delete(autonomyCorrections)
      .where(
        and(
          eq(autonomyCorrections.organizationId, organizationId),
          inArray(autonomyCorrections.autonomousDecisionId, ids),
        ),
      )
      .returning({ id: autonomyCorrections.autonomyCorrectionId }),
    deps.db
      .delete(autonomyShadowScores)
      .where(
        and(
          eq(autonomyShadowScores.organizationId, organizationId),
          inArray(autonomyShadowScores.autonomousDecisionId, ids),
        ),
      )
      .returning({ id: autonomyShadowScores.autonomyShadowScoreId }),
  ]);

  // The free text is what carries the person. The row stays so the action is
  // still auditable; what it considered and concluded does not.
  await deps.db
    .update(autonomousDecisions)
    .set({ inputs: null, decision: null, summary: null })
    .where(
      and(
        eq(autonomousDecisions.organizationId, organizationId),
        inArray(autonomousDecisions.autonomousDecisionId, ids),
      ),
    );

  return {
    decisions: ids.length,
    corrections: corrections.length,
    scores: scores.length,
  };
}
