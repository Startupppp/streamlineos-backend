import { z } from "zod";

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date");

const careerLevelSchema = z.object({
  title: z.string().trim().min(1, "Level title is required").max(200, "Level title must be at most 200 characters"),
  level: z.coerce.number().int().positive(),
  skills: z.array(z.string().trim().min(1)).max(50, "At most 50 skills are allowed").optional().default([]),
  requirements: z.array(z.string().trim().min(1)).max(50, "At most 50 requirements are allowed").optional().default([]),
});

export const createCareerPathSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200, "Name must be at most 200 characters"),
  description: z.string().trim().max(2000, "Description must be at most 2000 characters").optional(),
  department: z.string().trim().max(100, "Department must be at most 100 characters").optional(),
  levels: z.array(careerLevelSchema).max(20, "At most 20 levels are allowed").optional().default([]),
});

export const updateCareerPathSchema = z.object({
  name: z.string().trim().min(1).max(200, "Name must be at most 200 characters").optional(),
  description: z.string().trim().max(2000, "Description must be at most 2000 characters").optional(),
  department: z.string().trim().max(100, "Department must be at most 100 characters").optional(),
  levels: z.array(careerLevelSchema).max(20, "At most 20 levels are allowed").optional(),
  isActive: z.boolean().optional(),
});

const milestoneSchema = z.object({
  title: z.string().trim().min(1, "Milestone title is required").max(200, "Milestone title must be at most 200 characters"),
  dueDate: dateOnly,
  completed: z.boolean(),
});

export const saveCareerPlanSchema = z.object({
  pathId: z.coerce.number().int().positive().optional(),
  currentLevel: z.coerce.number().int().min(1, "Current level must be at least 1").optional(),
  targetRole: z.string().trim().max(200, "Target role must be at most 200 characters").optional(),
  targetDate: dateOnly.optional().or(z.literal("")),
  aspirations: z.string().trim().max(5000, "Aspirations must be at most 5000 characters").optional(),
  mentorId: z.string().trim().max(200, "Mentor must be at most 200 characters").optional(),
  milestones: z.array(milestoneSchema).max(100, "At most 100 milestones are allowed").optional(),
});

export const completedFlagSchema = z.boolean();

export type CreateCareerPathInput = z.infer<typeof createCareerPathSchema>;
export type UpdateCareerPathInput = z.infer<typeof updateCareerPathSchema>;
export type SaveCareerPlanInput = z.infer<typeof saveCareerPlanSchema>;
