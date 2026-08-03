import { z } from "zod";

export const startReviewSchema = z.object({
  reviewNotes: z.record(z.string(), z.unknown()).optional(),
  templateId: z.number().int().positive().optional(),
});

export const extendProbationSchema = z.object({
  extendedUntil: z.string().min(1, "extendedUntil is required"),
  reason: z.string().max(1000).optional(),
});

export const confirmProbationSchema = z.object({
  confirmedAt: z.string().optional(),
  notes: z.string().max(2000).optional(),
});

export type StartReviewInput = z.infer<typeof startReviewSchema>;
export type ExtendProbationInput = z.infer<typeof extendProbationSchema>;
export type ConfirmProbationInput = z.infer<typeof confirmProbationSchema>;
