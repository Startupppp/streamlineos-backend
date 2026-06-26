import { z } from "zod";

const ladderLevelSchema = z.object({
  level: z.number().int().positive(),
  title: z.string().min(1),
  description: z.string().min(1),
  minExperience: z.number().min(0),
  skills: z.array(z.string()),
});

export const createCareerLadderSchema = z.object({
  title: z
    .string()
    .min(2, "Title must be at least 2 characters")
    .max(100, "Title must be at most 100 characters")
    .refine((v) => /[a-zA-Z]/.test(v), "Title must contain at least one letter")
    .refine((v) => !/^\W+$/.test(v), "Title cannot contain only special characters")
    .refine((v) => !/\s{2,}/.test(v), "Title cannot have multiple consecutive spaces"),
  department: z.string().optional(),
  description: z
    .string()
    .min(10, "Description must be at least 10 characters")
    .max(1000, "Description must be at most 1000 characters")
    .refine((v) => /[a-zA-Z0-9]/.test(v), "Description cannot contain only special characters")
    .optional()
    .or(z.literal("")),
  levels: z.preprocess((v) => (v == null ? [] : v), z.array(ladderLevelSchema)).default([]),
});

const learningStepSchema = z.object({
  order: z.number().int().min(1),
  type: z.enum(["assessment", "certification"]),
  referenceId: z.number().int().positive(),
  title: z.string().min(1),
});

export const learningPathListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const createLearningPathSchema = z.object({
  title: z.string().min(2).max(200),
  description: z.string().max(1000).optional(),
  targetRole: z.string().max(100).optional(),
  level: z.enum(["Beginner", "Intermediate", "Advanced"]).optional(),
  estimatedHours: z.number().int().positive().optional(),
  steps: z.preprocess((v) => (v == null ? [] : v), z.array(learningStepSchema)).optional().default([]),
});

export type CreateCareerLadderInput = z.infer<typeof createCareerLadderSchema>;
export type LearningPathListQuery = z.infer<typeof learningPathListQuerySchema>;
export type CreateLearningPathInput = z.infer<typeof createLearningPathSchema>;
