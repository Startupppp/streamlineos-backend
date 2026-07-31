import { z } from "zod";

const crStatusValues = [
  "submitted",
  "under_review",
  "estimated",
  "awaiting_approval",
  "approved",
  "rejected",
  "in_progress",
  "completed",
] as const;

export const createChangeRequestSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  impact: z.string().optional(),
  estimateMinutes: z.number().int().nonnegative().optional(),
  budgetImpactCents: z.number().int().optional(),
  timelineImpactDays: z.number().int().optional(),
});

export const updateChangeRequestSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().optional(),
  impact: z.string().optional(),
  estimateMinutes: z.number().int().nonnegative().optional(),
  budgetImpactCents: z.number().int().optional(),
  timelineImpactDays: z.number().int().optional(),
  status: z.enum(crStatusValues).optional(),
  approvalOwnerId: z.string().optional(),
  decisionComment: z.string().optional(),
});

export const listCrQuerySchema = z.object({
  status: z.enum(crStatusValues).optional(),
});

export type CreateChangeRequestInput = z.infer<typeof createChangeRequestSchema>;
export type UpdateChangeRequestInput = z.infer<typeof updateChangeRequestSchema>;
export type ListCrQuery = z.infer<typeof listCrQuerySchema>;
