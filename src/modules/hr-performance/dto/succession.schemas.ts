import { z } from "zod";

const READINESS = ["ready_now", "1_2_years", "3_plus"] as const;

export const createSuccessionPlanSchema = z.object({
  roleName: z.string().trim().min(1, "Role name is required").max(200, "Role name must be at most 200 characters"),
  jobRoleId: z.coerce.number().int().positive().nullable().optional(),
  incumbentId: z.string().trim().min(1, "Incumbent is required").nullable().optional(),
  successorId: z.string().trim().min(1, "Successor is required"),
  readiness: z.enum(READINESS).optional().default("ready_now"),
  note: z.string().trim().max(2000, "Note must be at most 2000 characters").nullable().optional(),
});

export const updateSuccessionPlanSchema = z.object({
  roleName: z.string().trim().min(1).max(200, "Role name must be at most 200 characters").optional(),
  jobRoleId: z.coerce.number().int().positive().nullable().optional(),
  incumbentId: z.string().trim().min(1, "Incumbent is required").nullable().optional(),
  successorId: z.string().trim().min(1).optional(),
  readiness: z.enum(READINESS).optional(),
  note: z.string().trim().max(2000, "Note must be at most 2000 characters").nullable().optional(),
});

export type CreateSuccessionPlanInput = z.infer<typeof createSuccessionPlanSchema>;
export type UpdateSuccessionPlanInput = z.infer<typeof updateSuccessionPlanSchema>;
