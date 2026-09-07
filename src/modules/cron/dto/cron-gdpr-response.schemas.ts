import { z } from "zod";
import { cronSkippedSchema } from "./cron-shared.schemas";

export const gdprExportArtifactRetentionResponseSchema = z.union([
  cronSkippedSchema,
  z.object({
    success: z.literal(true),
    organizations: z.number().int().nonnegative(),
    organizationsFailed: z.number().int().nonnegative(),
    jobsReclaimed: z.number().int().nonnegative(),
    jobsExpired: z.number().int().nonnegative(),
    objectsDeleted: z.number().int().nonnegative(),
    objectsOrphaned: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
]);
