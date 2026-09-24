import { z } from "zod";

export const upsertCommentDraftSchema = z.object({
  body: z.string().min(1).max(10_000),
}).strict();

export type UpsertCommentDraftInput = z.infer<typeof upsertCommentDraftSchema>;

export const recordDraftFailureSchema = z.object({
  error: z.string().min(1).max(2_000),
}).strict();

export type RecordDraftFailureInput = z.infer<typeof recordDraftFailureSchema>;

export const generatedDraftAiOutputSchema = z.object({
  body: z.string().min(1).max(10_000),
  evidence: z.string().max(2_000).nullable(),
  proposedChange: z.string().max(2_000).nullable(),
  impact: z.string().max(1_000).nullable(),
  confidence: z.number().int().min(0).max(100),
  affectedRecordIds: z.array(z.number().int()).nullable(),
}).strict();

export type GeneratedDraftAiOutput = z.infer<typeof generatedDraftAiOutputSchema>;
