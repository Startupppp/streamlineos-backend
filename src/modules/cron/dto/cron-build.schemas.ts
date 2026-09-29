import { z } from "zod";

export const buildProjectRetentionPurgeQuerySchema = z
  .object({ confirm: z.literal("destroy").optional() })
  .strict();

export type BuildProjectRetentionPurgeQuery = z.infer<
  typeof buildProjectRetentionPurgeQuerySchema
>;
