import { z } from "zod";

export const addRequirementSchema = z.object({
  jobRoleId: z.number().int().positive().optional(),
  roleName: z.string().trim().max(200).optional(),
  skillName: z.string().trim().min(1).max(200),
  requiredLevel: z.number().int().min(0).max(10),
});
export type AddRequirementInput = z.infer<typeof addRequirementSchema>;
