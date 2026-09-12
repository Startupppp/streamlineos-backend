import { z } from "zod";

const activationStepSchema = z.enum([
  "bring-your-data",
  "open-a-deal",
  "connect-a-channel",
  "invite-a-colleague",
]);

/**
 * How far this workspace is from first value.
 *
 * `signals` is returned alongside the derived verdict rather than instead of it:
 * the counts are what a person can argue with when the progress bar disagrees
 * with what they believe they have done. Every record count excludes the demo
 * dataset, so a workspace that has only the samples reports zero.
 *
 * `next` is null when there is nothing left, which is a different answer from an
 * empty `remaining` list read by a caller that forgot to check it.
 */
export const activationReportSchema = z.object({
  isActivated: z.boolean(),
  completed: z.array(activationStepSchema),
  remaining: z.array(activationStepSchema),
  percent: z.number().int(),
  signals: z.object({
    realParties: z.number().int(),
    realDeals: z.number().int(),
    realActivities: z.number().int(),
    activeMembers: z.number().int(),
    hasCompletedImport: z.boolean(),
    hasConnectedChannel: z.boolean(),
  }),
  next: z
    .object({ step: activationStepSchema, prompt: z.string() })
    .nullable(),
});
