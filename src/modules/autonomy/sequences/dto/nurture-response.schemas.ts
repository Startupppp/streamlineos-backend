import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

/** `NurtureSequenceSummary` — the stored row plus its cadence's length. */
const nurtureSequenceSummarySchema = z.object({
  nurtureSequenceId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  stepCount: z.number().int(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

/** `NurtureStepView`. A step carries a wait and nothing else; the message is composed. */
const nurtureStepViewSchema = z.object({
  nurtureStepId: z.string(),
  stepNumber: z.number().int(),
  waitHours: z.number().int(),
});

/** `NurtureEnrollmentView`, with the party and deal names resolved for the page. */
const nurtureEnrollmentViewSchema = z.object({
  nurtureEnrollmentId: z.string(),
  nurtureSequenceId: z.string(),
  partyId: z.string(),
  /** Null only when the party is gone. */
  partyName: z.string().nullable(),
  dealId: z.number().int().nullable(),
  dealName: z.string().nullable(),
  status: z.string(),
  currentStep: z.number().int(),
  exitReason: z.string().nullable(),
  exitedAt: nullableWireDate(),
  enrolledAt: wireDate(),
});

export const listNurtureSequencesResponseSchema = cursorPageSchema(nurtureSequenceSummarySchema);

export const nurtureSequenceResponseSchema = nurtureSequenceSummarySchema;

/** `getSequenceWithSteps` — the summary and the whole cadence. */
export const getNurtureSequenceResponseSchema = z.object({
  sequence: nurtureSequenceSummarySchema,
  steps: z.array(nurtureStepViewSchema),
});

/**
 * `remove` — a soft delete that also lets go of the people it was holding.
 *
 * The count is reported rather than swallowed: the live-enrolment index is
 * tenant-wide on the party, so how many rows it freed is the answer to why
 * somebody can be nurtured again.
 */
export const removeNurtureSequenceResponseSchema = z.object({
  deleted: z.literal(true),
  exitedEnrollments: z.number().int(),
});

/** `replaceSteps` — the cadence as it now stands, renumbered densely. */
export const replaceNurtureStepsResponseSchema = z.array(nurtureStepViewSchema);

export const listNurtureEnrollmentsResponseSchema = cursorPageSchema(nurtureEnrollmentViewSchema);

export const nurtureEnrollmentResponseSchema = nurtureEnrollmentViewSchema;
