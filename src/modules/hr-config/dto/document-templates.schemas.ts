import { z } from "zod";

export const templateListQuerySchema = z.object({
  type: z.string().optional(),
});

export const createTemplateSchema = z.object({
  title: z
    .string()
    .min(2, "Template name must be at least 2 characters")
    .max(100, "Template name must be at most 100 characters")
    .refine((v) => /[a-zA-Z]/.test(v), { message: "Template name must contain at least one letter" })
    .refine((v) => !/\s{2,}/.test(v), { message: "Template name cannot have consecutive spaces" }),
  type: z.string().min(1, "Type is required").default("OFFER"),
  htmlContent: z.string().default(""),
  variables: z.array(z.string()).optional(),
});

export const setDefaultTemplateSchema = z.object({
  isDefault: z.boolean(),
});

export const updateTemplateSchema = z.object({
  title: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  htmlContent: z.string().optional(),
  variables: z.array(z.string()).optional(),
});

export type TemplateListQuery = z.infer<typeof templateListQuerySchema>;
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type SetDefaultTemplateInput = z.infer<typeof setDefaultTemplateSchema>;
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;
