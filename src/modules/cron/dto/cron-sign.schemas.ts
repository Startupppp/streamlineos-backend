import { z } from "zod";

/**
 * `?dryRun=true` reports what a sweep would do and touches nothing. Only the
 * literal `true` enables it: the failure that matters is a dry run that
 * silently was not one, which is what `Boolean("false")` produces.
 */
export const signSweepTickQuerySchema = z
  .object({ dryRun: z.enum(["true", "false"]).optional() })
  .strict();

export type SignSweepTickQuery = z.infer<typeof signSweepTickQuerySchema>;
