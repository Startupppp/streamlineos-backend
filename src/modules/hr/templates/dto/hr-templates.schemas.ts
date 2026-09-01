import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const HR_TEMPLATE_KINDS = [
  "onboarding_checklist",
  "offboarding_checklist",
  "probation_review",
  "performance_review",
  "goal",
  "letter",
  "document_request",
  "email",
  "notification",
  "survey",
  "training",
  "asset_assignment",
  "exit_interview",
] as const;

export const HR_TEMPLATE_STATUSES = ["draft", "review", "approved", "active", "archived"] as const;

export const HR_LETTER_TYPES = [
  "offer",
  "appointment",
  "confirmation",
  "promotion",
  "transfer",
  "salary_revision",
  "warning",
  "experience",
  "relieving",
  "termination",
] as const;

export const VALID_TRANSITIONS: Record<string, string[]> = {
  draft: ["review"],
  review: ["approved", "draft"],
  approved: ["active", "draft"],
  active: ["archived"],
  archived: [],
};


const hrTemplateNameSchema = z
  .string()
  .min(1, "Name is required")
  .max(100, "Name must be at most 100 characters")
  .transform((v) => v.trim())
  .refine((v) => v.length >= 3, "Name must be at least 3 characters")
  .refine((v) => /[a-zA-Z]/.test(v), "Name must contain at least one letter");

export const createTemplateSchema = z.object({
  kind: z.enum(HR_TEMPLATE_KINDS),
  name: hrTemplateNameSchema,
  description: z.string().max(500).transform((v) => v.trim()).optional(),
  content: z.record(z.string(), z.unknown()).default({}),
  variablesUsed: z.array(z.string()).optional(),
  letterType: z.enum(HR_LETTER_TYPES).optional(),
});

export const updateTemplateSchema = z.object({
  name: hrTemplateNameSchema.optional(),
  description: z.string().max(500).transform((v) => v.trim()).optional(),
  content: z.record(z.string(), z.unknown()).optional(),
  variablesUsed: z.array(z.string()).optional(),
  letterType: z.enum(HR_LETTER_TYPES).optional(),
});

export const transitionTemplateSchema = z.object({
  to: z.enum(HR_TEMPLATE_STATUSES),
});

export const renderTemplateSchema = z.object({
  employeeId: z.number().int().positive().optional(),
  extraContext: z.record(z.string(), z.string()).optional(),
  includeSensitive: z.boolean().default(false),
});

export const templateListQuerySchema = z.object({
  kind: z.enum(HR_TEMPLATE_KINDS).optional(),
  status: z.enum(HR_TEMPLATE_STATUSES).optional(),
  search: z.string().max(100).optional(),
  cursor: z.string().optional(),
  limit: pageSizeField(50, 100),
});

export const templateRendersQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(2048).optional(),
    limit: pageSizeField(50, 100),
  })
  .strict();

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;
export type TransitionTemplateInput = z.infer<typeof transitionTemplateSchema>;
export type RenderTemplateInput = z.infer<typeof renderTemplateSchema>;
export type TemplateListQuery = z.infer<typeof templateListQuerySchema>;
export type TemplateRendersQuery = z.infer<typeof templateRendersQuerySchema>;
