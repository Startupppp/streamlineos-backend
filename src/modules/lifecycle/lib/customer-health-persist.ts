import { NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import { businessParties } from "../../../db/schema/party";
import { customerHealthAssessments, customerHealthFactors } from "../../../db/schema/crm/lifecycle";
import type { HealthComposite } from "../health-score";

/**
 * Writes the score, its inputs and the party projection in one transaction.
 *
 * One transaction because a score without its factors is exactly the thing
 * this feature exists to stop existing — a number nobody can take apart — and
 * a partial write would produce one. The factor rows are deleted and rewritten
 * rather than upserted per key so that a factor set which changes shape (a
 * fifth input, or one retired) cannot leave an orphan row from the old model
 * in a decomposition of the new one.
 */
export async function persistAssessment(
  handle: Db,
  organizationId: string,
  partyId: string,
  composite: HealthComposite,
  asOf: Date,
) {
  return handle.transaction(async (tx) => {
    const db = tx as Db;

    const [assessment] = await db
      .insert(customerHealthAssessments)
      .values({
        organizationId,
        partyId,
        score: composite.score,
        healthStatus: composite.band,
        coverageBps: composite.coverageBps,
        weightsVersion: composite.weightsVersion,
        computedAt: asOf,
      })
      .onConflictDoUpdate({
        target: [
          customerHealthAssessments.organizationId,
          customerHealthAssessments.partyId,
        ],
        set: {
          score: composite.score,
          healthStatus: composite.band,
          coverageBps: composite.coverageBps,
          weightsVersion: composite.weightsVersion,
          computedAt: asOf,
          updatedAt: asOf,
        },
      })
      .returning({
        customerHealthAssessmentId:
          customerHealthAssessments.customerHealthAssessmentId,
        computedAt: customerHealthAssessments.computedAt,
      });

    if (!assessment) throw new NotFoundException("Health assessment could not be stored");

    await db
      .delete(customerHealthFactors)
      .where(
        and(
          eq(customerHealthFactors.organizationId, organizationId),
          eq(
            customerHealthFactors.customerHealthAssessmentId,
            assessment.customerHealthAssessmentId,
          ),
        ),
      );

    await db.insert(customerHealthFactors).values(
      composite.factors.map((factor) => ({
        organizationId,
        customerHealthAssessmentId: assessment.customerHealthAssessmentId,
        factorKey: factor.key,
        weightBps: factor.weightBps,
        effectiveWeightBps: factor.effectiveWeightBps,
        status: factor.status,
        /**
         * Null for a missing input, never zero. The column's CHECK enforces
         * the same invariant from the other side, so a producer that bypassed
         * this service still cannot file a missing input as a scored one.
         */
        value: factor.status === "measured" ? factor.value : null,
        missingReason: factor.status === "missing" ? factor.reason : null,
        contributionBps: factor.contributionBps,
        observations: factor.status === "measured" ? factor.observations : 0,
        windowDays: factor.window.days,
        windowFrom: factor.window.from,
        windowTo: factor.window.to,
        detail: factor.detail,
      })),
    );

    /**
     * The projection onto the party. Null score and null status when the model
     * could not answer — carried all the way out rather than rounded into a
     * number, because `business_parties.health_score` is already nullable for
     * exactly this reason and every surface that reads it already handles it.
     */
    await db
      .update(businessParties)
      .set({
        healthScore: composite.score,
        healthStatus: composite.band,
        healthCheckedAt: asOf,
      })
      .where(
        and(
          eq(businessParties.organizationId, organizationId),
          eq(businessParties.partyId, partyId),
        ),
      );

    return assessment;
  });
}
