import { z } from "zod";

export const createAttemptSchema = z.object({
  participantId: z.number().int().positive().optional(),
  accessToken: z.string().optional(),
});

export const listAttemptsSchema = z.object({
  status: z.enum(["not_started", "in_progress", "submitted", "passed", "failed", "expired"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type CreateAttemptInput = z.infer<typeof createAttemptSchema>;
export type ListAttemptsInput = z.infer<typeof listAttemptsSchema>;
