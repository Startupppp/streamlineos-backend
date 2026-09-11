/**
 * A repair class this tenant has not granted, written down as a decision.
 *
 * Kept apart from the pass that applies repairs because it writes nothing but
 * the ledger row: no party value, no repair row, no finding closed. Calling it
 * records that something was left for a person, which is the only thing it can
 * do.
 */
import type { Db } from "../../../db/drizzle.types";
import { autonomousDecisions } from "../../../db/schema";
import type { RepairClass } from "../../../db/schema/crm/autonomy-repairs";
import type { ClassOutcome } from "../autonomy-repair.types";
import { buildDecision } from "../decision-record";
import type { RepairPermission } from "../repair-classes";

/**
 * The refusal, written down.
 *
 * A class this tenant has not granted is not a no-op: findings were seen,
 * counted, and deliberately left in the human queue. Recording that as a
 * `skipped` decision is what makes "why did nothing happen" answerable from
 * the same feed as "why did this happen" — the alternative is a silence,
 * which reads identically to the loop never having run.
 */
export async function recordRepairRefusal(
  db: Db,
  organizationId: string,
  repairClass: RepairClass,
  considered: number,
  permission: Extract<RepairPermission, { allowed: false }>,
): Promise<ClassOutcome> {
  const [row] = await db
    .insert(autonomousDecisions)
    .values(
      buildDecision({
        organizationId,
        kind: "field.repaired",
        outcome: "skipped",
        triggerType: "repair.sweep",
        triggerId: repairClass,
        summary: `Left ${considered} ${repairClass} finding(s) for a person: ${permission.explanation}`,
        decision: {
          repairClass,
          refused: considered,
          reason: permission.reason,
          decidedBy: permission.decidedBy,
        },
      }),
    )
    .returning({ id: autonomousDecisions.autonomousDecisionId });

  return {
    repairClass,
    considered,
    repaired: 0,
    refused: considered,
    autonomousDecisionId: row?.id ?? null,
    failed: 0,
    outcome: "skipped",
    explanation: permission.explanation,
  };
}
