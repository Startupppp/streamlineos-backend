import { z } from "zod";

const readinessEnum = z.enum(["ready_now", "1_2_years", "3_plus"]);

export const createSuccessionSchema = z.object({
  roleName: z.string().trim().min(1).max(200),
  jobRoleId: z.number().int().positive().optional(),
  incumbentId: z.string().uuid().optional(),
  successorId: z.string().uuid(),
  readiness: readinessEnum,
  note: z.string().max(2000).optional(),
});
export type CreateSuccessionInput = z.infer<typeof createSuccessionSchema>;

export const updateSuccessionSchema = z.object({
  roleName: z.string().trim().min(1).max(200).optional(),
  jobRoleId: z.number().int().positive().optional(),
  incumbentId: z.string().uuid().optional(),
  successorId: z.string().uuid().optional(),
  readiness: readinessEnum.optional(),
  note: z.string().max(2000).optional(),
});
export type UpdateSuccessionInput = z.infer<typeof updateSuccessionSchema>;
