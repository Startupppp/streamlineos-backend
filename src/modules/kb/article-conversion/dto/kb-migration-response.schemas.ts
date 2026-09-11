import { z } from "zod";

export const kbMigrationPreviewSchema = z.object({
  total: z.number().int(),
  byStatus: z.record(z.string(), z.number().int()),
  alreadyMigrated: z.number().int(),
  willMigrate: z.number().int(),
  sample: z.array(
    z.object({
      id: z.number().int(),
      title: z.string(),
      visibility: z.string(),
    }),
  ),
});

export const kbMigrationRunSchema = z.object({
  migrated: z.number().int(),
  skipped: z.number().int(),
  total: z.number().int(),
  dryRun: z.boolean(),
  jobId: z.number().int().optional(),
  failed: z.number().int(),
  failedArticleIds: z.array(z.number().int()).optional(),
});
