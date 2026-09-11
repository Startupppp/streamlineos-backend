/**
 * One repair class's pass: the permission, the drafts, and the batch.
 *
 * Only `runRepairClass` is exported, and it asks `mayRepair` and
 * `proposeRepair` before anything is written. `applyBatch` stays private to
 * this file, as it was private to the class: it writes whatever drafts it is
 * handed through the mirror and closes their findings, so exporting it would
 * be a second way to repair that skips the tenant's grant, the kill switch and
 * the one-unambiguous-fix rule.
 */
import { ConflictException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { autonomousDecisions, autonomyRepairs } from "../../../db/schema";
import type { RepairClass } from "../../../db/schema/crm/autonomy-repairs";
import { updatePartyWithMirror } from "../../party/party-legacy-writer";
import type {
  ClassOutcome,
  RepairDeps,
  RepairDraft,
  RepairRunContext,
} from "../autonomy-repair.types";
import { buildDecision } from "../decision-record";
import { REPAIR_CLASS_DEFINITIONS, mayRepair, proposeRepair } from "../repair-classes";
import { currentPartyFieldValue, fieldPatch } from "./repair-party-field";
import { recordRepairRefusal } from "./repair-refusal";

export async function runRepairClass(
  deps: RepairDeps,
  organizationId: string,
  repairClass: RepairClass,
  limit: number,
  context: RepairRunContext,
): Promise<ClassOutcome> {
  const definition = REPAIR_CLASS_DEFINITIONS[repairClass];
  const candidates = await deps.queue.repairCandidates(
    organizationId,
    [definition.findingKind],
    limit,
  );

  /**
   * Nothing to decide about, so nothing is recorded.
   *
   * The refusal below is a decision because something was actually left
   * undone. A row saying "considered zero findings and did nothing" would be
   * noise proportional to how often the loop runs rather than to what it
   * found, and it would bury the refusals that matter.
   */
  if (candidates.length === 0)
    return {
      repairClass,
      considered: 0,
      repaired: 0,
      refused: 0,
      failed: 0,
      autonomousDecisionId: null,
      outcome: "skipped",
      explanation: null,
    };

  const permission = mayRepair(repairClass, context);
  if (!permission.allowed)
    return recordRepairRefusal(deps.db, organizationId, repairClass, candidates.length, permission);

  const drafts: RepairDraft[] = [];
  let refused = 0;

  for (const candidate of candidates) {
    const current = await currentPartyFieldValue(
      deps.db,
      organizationId,
      candidate.partyId,
      definition.field,
    );
    if (current === null) {
      refused += 1;
      continue;
    }

    /**
     * Proposed from what is on the record now, never from the finding's
     * evidence.
     *
     * The evidence records what a sweep saw, possibly weeks ago. Repairing
     * from it would overwrite a value somebody has corrected since with a
     * "fix" for a problem that no longer exists — the same hazard
     * `planReversal` refuses a changed deal for.
     */
    const proposal = proposeRepair(repairClass, current);
    if (!proposal.ok) {
      refused += 1;
      continue;
    }

    drafts.push({
      findingId: candidate.findingId,
      partyId: candidate.partyId,
      field: definition.field,
      previousValue: current,
      repairedValue: proposal.next,
    });
  }

  if (drafts.length === 0)
    return {
      repairClass,
      considered: candidates.length,
      repaired: 0,
      refused,
      failed: 0,
      autonomousDecisionId: null,
      outcome: "skipped",
      explanation: "Nothing in this class had a single unambiguous repair.",
    };

  return applyBatch(deps, organizationId, repairClass, candidates.length, refused, drafts);
}

/**
 * One decision, one row per value, and the findings closed against it.
 *
 * The decision is written first because every repair row carries a foreign key
 * to it — the same ordering `DataQualityResolutionService` uses, and for the
 * same reason.
 */
async function applyBatch(
  deps: RepairDeps,
  organizationId: string,
  repairClass: RepairClass,
  considered: number,
  refusedSoFar: number,
  drafts: readonly RepairDraft[],
): Promise<ClassOutcome> {
  const definition = REPAIR_CLASS_DEFINITIONS[repairClass];

  const [decision] = await deps.db
    .insert(autonomousDecisions)
    .values(
      buildDecision({
        organizationId,
        kind: "field.repaired",
        outcome: "applied",
        triggerType: "repair.sweep",
        triggerId: repairClass,
        summary: `Repaired ${drafts.length} ${definition.field} value(s): ${repairClass}`,
        decision: {
          repairClass,
          field: definition.field,
          considered,
          repaired: drafts.length,
        },
        /**
         * A sample, not the batch. The values live one per row in
         * `autonomy_repairs`; this is the handful a reviewer sees without
         * opening anything, and copying four hundred of them here would make
         * the ledger larger than the records it describes.
         */
        inputs: {
          examples: drafts.slice(0, 5).map((draft) => ({
            from: draft.previousValue,
            to: draft.repairedValue,
          })),
        },
      }),
    )
    .returning({ id: autonomousDecisions.autonomousDecisionId });

  if (!decision) throw new ConflictException("The repair could not be recorded");

  const applied: RepairDraft[] = [];
  const failures: string[] = [];

  for (const draft of drafts) {
    try {
      /**
       * Through the mirror writer rather than a direct column update.
       *
       * Party is canonical and `leads`/`contacts` mirror it, so a repair
       * written only to `business_parties` would be invisible on every legacy
       * screen — the record would still show the malformed value and the next
       * divergence check would report the party as the one that is wrong.
       * `updatePartyWithMirror` opens its own savepoint, so one party failing
       * costs that party.
       */
      await updatePartyWithMirror(
        deps.db,
        organizationId,
        draft.partyId,
        fieldPatch(draft.field, draft.repairedValue),
      );
      applied.push(draft);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(draft.findingId);
      deps.logger.warn(`repair of party ${draft.partyId} failed: ${message}`);
    }
  }

  if (applied.length > 0)
    await deps.db.insert(autonomyRepairs).values(
      applied.map((draft) => ({
        organizationId,
        autonomousDecisionId: decision.id,
        repairClass,
        findingId: draft.findingId,
        partyId: draft.partyId,
        field: draft.field,
        previousValue: draft.previousValue,
        repairedValue: draft.repairedValue,
      })),
    );

  const closed = await deps.queue.closeAsRepaired(
    organizationId,
    decision.id,
    applied.map((draft) => draft.findingId),
  );

  /**
   * The counts are corrected on the decision after the fact rather than
   * predicted before it, so a partly-applied batch never reads as complete.
   */
  if (applied.length !== drafts.length)
    await deps.db
      .update(autonomousDecisions)
      .set({
        summary: `Repaired ${applied.length} of ${drafts.length} ${definition.field} value(s): ${repairClass}`,
        decision: {
          repairClass,
          field: definition.field,
          considered,
          repaired: applied.length,
          failed: drafts.length - applied.length,
        },
      })
      .where(
        and(
          eq(autonomousDecisions.organizationId, organizationId),
          eq(autonomousDecisions.autonomousDecisionId, decision.id),
        ),
      );

  return {
    repairClass,
    considered,
    repaired: closed.length,
    refused: refusedSoFar,
    failed: failures.length,
    autonomousDecisionId: decision.id,
    outcome: "applied",
    explanation: null,
  };
}
