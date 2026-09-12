/**
 * A sequence's cadence: its steps read in order, and replaced wholesale.
 *
 * The timing rules themselves are `nurture-cadence.ts`; this file only keeps
 * `crm_nurture_sequence_steps` in the shape those rules assume — numbered from
 * one with no gaps, and never stored below the wait floor.
 */
import { BadRequestException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.types";
import { crmNurtureSequenceSteps } from "../../../../db/schema";
import type { ReplaceNurtureStepsInput } from "../dto/nurture.schemas";
import { clampWaitHours, stepNumbersAreDense } from "../nurture-cadence";
import type { NurtureStepView } from "../nurture-sequences.types";
import { requireSequence } from "./nurture-lookups";

export async function listSequenceSteps(
  db: Db,
  organizationId: string,
  nurtureSequenceId: string,
): Promise<NurtureStepView[]> {
  return db
    .select({
      nurtureStepId: crmNurtureSequenceSteps.nurtureStepId,
      stepNumber: crmNurtureSequenceSteps.stepNumber,
      waitHours: crmNurtureSequenceSteps.waitHours,
    })
    .from(crmNurtureSequenceSteps)
    .where(
      and(
        eq(crmNurtureSequenceSteps.organizationId, organizationId),
        eq(crmNurtureSequenceSteps.nurtureSequenceId, nurtureSequenceId),
      ),
    )
    .orderBy(asc(crmNurtureSequenceSteps.stepNumber));
}

export async function replaceSequenceSteps(
  db: Db,
  organizationId: string,
  nurtureSequenceId: string,
  input: ReplaceNurtureStepsInput,
): Promise<NurtureStepView[]> {
  await requireSequence(db, organizationId, nurtureSequenceId);

  const steps = input.steps.map((step, index) => ({
    stepNumber: index + 1,
    waitHours: step.waitHours,
  }));

  if (!stepNumbersAreDense(steps))
    throw new BadRequestException("Steps must be numbered from 1 with no gaps");

  return db.transaction(async (tx) => {
    /**
     * A hard DELETE, which the soft-delete default does not cover: a step is a
     * child row of the cadence with no history of its own, and the record that
     * a step happened lives in `crm_nurture_step_attempts` rather than here.
     */
    await tx
      .delete(crmNurtureSequenceSteps)
      .where(
        and(
          eq(crmNurtureSequenceSteps.organizationId, organizationId),
          eq(crmNurtureSequenceSteps.nurtureSequenceId, nurtureSequenceId),
        ),
      );

    if (steps.length === 0) return [];

    return tx
      .insert(crmNurtureSequenceSteps)
      .values(
        steps.map((step) => ({
          organizationId,
          nurtureSequenceId,
          stepNumber: step.stepNumber,
          /**
           * Clamped on the way in as well as on the way out.
           *
           * `waitMsForStep` clamps at read time because it has to — rows
           * written before the floor moved are still in the table — but a
           * value stored below the floor would show an operator a cadence
           * their sequence does not actually run.
           */
          waitHours: clampWaitHours(step.waitHours),
        })),
      )
      .returning({
        nurtureStepId: crmNurtureSequenceSteps.nurtureStepId,
        stepNumber: crmNurtureSequenceSteps.stepNumber,
        waitHours: crmNurtureSequenceSteps.waitHours,
      });
  });
}
