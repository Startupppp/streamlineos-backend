import { z } from "zod";

export const runArticleMigrationSchema = z.object({
  dryRun: z.boolean().optional().default(false),
});
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
};
