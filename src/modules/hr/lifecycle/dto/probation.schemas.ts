import { z } from "zod";

const businessDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const listProbationReviewsSchema = z
  .object({
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const startReviewSchema = z
  .object({
    reviewNotes: z.record(z.string(), z.unknown()).optional(),
    templateId: z.number().int().positive().optional(),
  })
  .strict();

export const extendProbationSchema = z
  .object({
    extendedUntil: businessDateSchema,
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();

export const confirmProbationSchema = z
  .object({
    confirmedAt: businessDateSchema.optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();

export type StartReviewInput = z.infer<typeof startReviewSchema>;
export type ExtendProbationInput = z.infer<typeof extendProbationSchema>;
export type ConfirmProbationInput = z.infer<typeof confirmProbationSchema>;
export type ListProbationReviewsInput = z.infer<typeof listProbationReviewsSchema>;
