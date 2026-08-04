import { z } from "zod";

const READINESS = ["ready_now", "1_2_years", "3_plus"] as const;

export const successionListSchema = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const createSuccessionPlanSchema = z.object({
  roleName: z
    .string()
    .trim()
    .min(2, "Role name must be at least 2 characters")
    .max(200, "Role name must be at most 200 characters")
    .regex(/[a-zA-Z0-9]/, "Role name must contain at least one letter or number")
    .refine((v) => !/\s{2,}/.test(v), "Cannot have consecutive spaces"),
  jobRoleId: z.coerce.number().int().positive().nullable().optional(),
  incumbentId: z.string().trim().min(1, "Incumbent is required").nullable().optional(),
  successorId: z.string().trim().min(1, "Successor is required"),
  readiness: z.enum(READINESS).optional().default("ready_now"),
  note: z.string().trim().max(2000, "Note must be at most 2000 characters").nullable().optional(),
}).refine((d) => !d.incumbentId || d.incumbentId !== d.successorId, {
  message: "Incumbent and successor must be different people",
  path: ["incumbentId"],
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
export type SuccessionListInput = z.infer<typeof successionListSchema>;
