import { z } from "zod";

export const addSkillRequirementSchema = z.object({
  jobRoleId: z.coerce.number().int().positive().optional(),
  roleName: z.string().trim().min(1, "Role name is required").max(200, "Role name must be at most 200 characters").optional(),
  skillName: z.string().trim().min(1, "Skill name is required").max(150, "Skill name must be at most 150 characters"),
  requiredLevel: z.coerce.number().int().min(1, "Required level must be at least 1").max(10, "Required level must be at most 10"),
});

export type AddSkillRequirementInput = z.infer<typeof addSkillRequirementSchema>;
