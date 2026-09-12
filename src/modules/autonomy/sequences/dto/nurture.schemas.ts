import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";
import {
  NURTURE_ENROLLMENT_STATUSES,
  NURTURE_SEQUENCE_STATUSES,
} from "../../../../db/schema/crm/nurture-sequences";
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
     *
     * A string on the wire, matching `composeOutboundSchema` — the two doors into
     * the same loop must not disagree about the shape of an identifier. Digits
     * only, though, which that schema does not require and this one must:
     * `crm_nurture_enrollments.deal_id` is an `integer` with a foreign key to
     * `deals.id`, so a non-numeric value reaches Postgres as a `22P02` on the
     * insert and surfaces as a 500 rather than as the 400 it is.
     */
    dealId: z
      .string()
      .trim()
      .regex(/^[0-9]{1,9}$/, "dealId must be a deal's numeric id")
      .optional(),
  })
  .strict();
export type EnrolInNurtureSequenceInput = z.infer<typeof enrolInNurtureSequenceSchema>;

/**
 * Cursor-paginated, like every other list a background writer is appending to.
 *
 * The sweep exits and advances enrolments while somebody is reading the page,
 * so an offset would shift rows out from under them; `buildCursorPage` walks a
 * `(timestamp, id)` keyset instead. See `common/pagination/cursor.ts`.
 */
export const listNurtureSequencesQuerySchema = z
  .object({
    limit: pageSizeField(25),
    cursor: z.string().min(1).max(512).optional(),
    status: z.enum(NURTURE_SEQUENCE_STATUSES).optional(),
  })
  .strict();
export type ListNurtureSequencesQuery = z.infer<typeof listNurtureSequencesQuerySchema>;

export const listNurtureEnrollmentsQuerySchema = z
  .object({
    limit: pageSizeField(25),
    cursor: z.string().min(1).max(512).optional(),
    /**
     * Defaults to everything rather than to `active`. A sequence nobody is
     * enrolled in any more and one nobody was ever enrolled in look identical
     * from an active-only list, and the exit reasons are the whole point of the
     * feature — `replied` is the number it is judged on.
     */
    status: z.enum(NURTURE_ENROLLMENT_STATUSES).optional(),
  })
  .strict();
export type ListNurtureEnrollmentsQuery = z.infer<typeof listNurtureEnrollmentsQuerySchema>;
