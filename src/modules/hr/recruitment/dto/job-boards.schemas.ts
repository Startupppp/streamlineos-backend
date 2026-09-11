import { z } from "zod";

const POSTING_STATUSES = ["DRAFT", "POSTED", "EXPIRED", "CLOSED"] as const;

export const createJobBoardPostingSchema = z.object({
  platform: z.string().min(1).max(50),
  externalPostUrl: z.string().url().optional(),
  status: z.enum(POSTING_STATUSES).default("DRAFT"),
  postedAt: z.string().optional(),
  expiryDate: z.string().optional(),
  spend: z.number().min(0).optional(),
  notes: z.string().max(2000).optional(),
}).strict();
export type CreateJobBoardPostingInput = z.infer<typeof createJobBoardPostingSchema>;

export const updateJobBoardPostingSchema = z.object({
  externalPostUrl: z.string().url().optional(),
  status: z.enum(POSTING_STATUSES).optional(),
  postedAt: z.string().optional(),
  expiryDate: z.string().optional(),
  spend: z.number().min(0).optional(),
  applicantCount: z.number().int().min(0).optional(),
  qualifiedCount: z.number().int().min(0).optional(),
  hiredCount: z.number().int().min(0).optional(),
  notes: z.string().max(2000).optional(),
}).strict();
export type UpdateJobBoardPostingInput = z.infer<typeof updateJobBoardPostingSchema>;
