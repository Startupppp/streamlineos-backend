import { z } from "zod";

export const runArticleMigrationSchema = z.union([
  z.object({
    dryRun: z.literal(false),
    confirmation: z.literal("CONVERT_PUBLISHED_ARTICLES"),
  }).strict(),
  z.object({ dryRun: z.literal(true).optional().default(true) }),
]);
export type RunArticleMigrationInput = z.infer<typeof runArticleMigrationSchema>;

export type ArticleMigrationPreview = {
  total: number;
  byStatus: Record<string, number>;
  alreadyMigrated: number;
  willMigrate: number;
  sample: { id: number; title: string; visibility: string }[];
};

export type MigrationResult = {
  migrated: number;
  skipped: number;
  total: number;
  dryRun: boolean;
  jobId?: number;
  failed: number;
  failedArticleIds?: number[];
};
