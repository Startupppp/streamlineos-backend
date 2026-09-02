import { z } from "zod";

export const createTransitionSchema = z.object({
  fromStatusId: z.number().int().positive().nullable().optional(),
  toStatusId: z.number().int().positive(),
  name: z.string().min(1).max(200).optional(),
  requiresApproval: z.boolean().optional(),
  requiredFields: z.array(z.string()).optional(),
  allowedRoles: z.array(z.string()).optional(),
}).strict();

export const updateTransitionSchema = z.object({
  fromStatusId: z.number().int().positive().nullish(),
  toStatusId: z.number().int().positive().optional(),
  name: z.string().min(1).max(200).nullish(),
  requiresApproval: z.boolean().optional(),
  requiredFields: z.array(z.string()).optional(),
  allowedRoles: z.array(z.string()).optional(),
}).strict();

export const wipLimitSchema = z.object({
  wipLimit: z.number().int().nonnegative().nullable(),
}).strict();

export type CreateTransitionInput = z.infer<typeof createTransitionSchema>;
export type UpdateTransitionInput = z.infer<typeof updateTransitionSchema>;
export type WipLimitInput = z.infer<typeof wipLimitSchema>;
