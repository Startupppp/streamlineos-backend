import { z } from "zod";

export const listSchema = z.object({
  userId: z.string().optional(),
  period: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  offset: z.coerce.number().min(0).optional(),
});

export const createSchema = z.object({
  userId: z.string().optional(),
  userIds: z.array(z.string()).optional(),
  metricType: z.string(),
  targetValue: z.string(),
  period: z.string().default("daily"),
  startDate: z.string(),
  endDate: z.string(),
  notes: z.string().optional(),
  branchId: z.number().optional(),
  parentTargetId: z.number().optional(),
});

export const updateSchema = z.object({
  targetValue: z.string().optional(),
  currentValue: z.string().optional(),
  notes: z.string().optional(),
});

export const leaderboardSchema = z.object({
  metricType: z.string().optional(),
});

export type ListInput = z.infer<typeof listSchema>;
export type CreateInput = z.infer<typeof createSchema>;
export type UpdateInput = z.infer<typeof updateSchema>;
export type LeaderboardInput = z.infer<typeof leaderboardSchema>;
