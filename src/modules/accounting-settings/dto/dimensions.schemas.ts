import { z } from "zod";

const keyPattern = /^[a-z][a-z0-9_-]*$/;

export const createDimensionSchema = z.object({
  name: z.string().min(1).max(100),
  key: z
    .string()
    .min(1)
    .max(50)
    .regex(keyPattern, "Key must be lowercase letters, digits, hyphens, or underscores"),
  requiredForAccountTypes: z.array(z.string()).optional().default([]),
});

export type CreateDimensionInput = z.infer<typeof createDimensionSchema>;

export const updateDimensionSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  requiredForAccountTypes: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
});

export type UpdateDimensionInput = z.infer<typeof updateDimensionSchema>;

export const createDimensionValueSchema = z.object({
  name: z.string().min(1).max(100),
  code: z.string().min(1).max(50),
});

export type CreateDimensionValueInput = z.infer<typeof createDimensionValueSchema>;

export const updateDimensionValueSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  isActive: z.boolean().optional(),
});

export type UpdateDimensionValueInput = z.infer<typeof updateDimensionValueSchema>;
