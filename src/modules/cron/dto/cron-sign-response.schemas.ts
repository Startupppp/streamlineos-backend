import { z } from "zod";
import { cronSkippedSchema } from "./cron-shared.schemas";

/**
 * Both e-sign sweep ticks answer with the same shape, because both call
 * `runSweepAllOrgs` — `sweep` is what tells the two apart in a log, and `dryRun`
 * is what says whether `affected` counts envelopes touched or envelopes that
 * would have been. `organizations` is every tenant walked; `succeeded` and
 * `failed` split them, so a pass where every tenant threw is distinguishable
 * from one with nothing to do.
 */
export const signSweepTickResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    message: z.string(),
    sweep: z.enum(["reminder", "expiration"]),
    dryRun: z.boolean(),
    organizations: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    affected: z.number().int().nonnegative(),
  }),
]);
