import { z } from "zod";
import { MAX_SEQUENCE_STEPS, MAX_STEP_WAIT_HOURS } from "../nurture-cadence";

/**
 * What a caller may say about a sequence, which is a cadence and a name.
 *
 * There is deliberately no `subject`, no `body`, no `to` and no `outboundClass`
 * anywhere in this file. Every one of those belongs to the outbound loop:
 * `outbound-eligibility.ts` picks the class, the drafter writes the words,
 * `send-guardrails.ts` decides whether it may leave. A schema that accepted a
 * body would be a route by which a person could put a message on the wire
 * without any of that running — which is the whole shape of the bypass this
 * ticket exists not to build.
 *
 * `waitHours` is accepted above its floor rather than validated against it here.
 * `clampWaitHours` raises anything too tight, and it has to do that anyway for
 * rows written before the floor moved; rejecting at the edge as well would give
 * the same input two different answers depending on which door it came through.
 */

export const createNurtureSequenceSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).optional(),
  })
  .strict();
export type CreateNurtureSequenceInput = z.infer<typeof createNurtureSequenceSchema>;

export const updateNurtureSequenceSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    /**
     * `draft` is absent on purpose. A sequence that has been active has
     * enrolments behind it, and moving it back to `draft` would describe it as
     * never having run. Pausing is the way to stop it.
     */
    status: z.enum(["active", "paused"]).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to update" });
export type UpdateNurtureSequenceInput = z.infer<typeof updateNurtureSequenceSchema>;

/**
 * The whole cadence, replaced at once rather than edited step by step.
 *
 * Step numbers must be dense (`stepNumbersAreDense` has the argument), and a
 * per-step insert cannot enforce that without a read-modify-write that two
 * concurrent editors would interleave into a gap. Sending the list is the only
 * shape in which the invariant is checkable in one statement.
 */
export const replaceNurtureStepsSchema = z
  .object({
    steps: z
      .array(z.object({ waitHours: z.number().int().min(0).max(MAX_STEP_WAIT_HOURS) }).strict())
      .max(MAX_SEQUENCE_STEPS),
  })
  .strict();
export type ReplaceNurtureStepsInput = z.infer<typeof replaceNurtureStepsSchema>;

export const enrolInNurtureSequenceSchema = z
  .object({
    /** The party to nurture. The address is resolved per step, at send time. */
    partyId: z.string().trim().min(1).max(64),
    /**
     * The deal it is about, passed through to `composeAndHold` untouched. It
     * carries the salesperson to write as and the conversation to write from, so
     * an enrolment without one produces steps that refuse before they draft.
     */
    dealId: z.string().trim().min(1).max(64).optional(),
  })
  .strict();
export type EnrolInNurtureSequenceInput = z.infer<typeof enrolInNurtureSequenceSchema>;
