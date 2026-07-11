import { z } from "zod";

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

const checklistItemSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  assigneeRole: z.enum(["hr", "manager", "it", "employee", "buddy"]),
  dueOffsetDays: z.number().int().min(0),
  required: z.boolean(),
  order: z.number().int().min(0),
});

const reviewQuestionSchema = z.object({
  id: z.string(),
  text: z.string().min(1),
  type: z.enum(["rating", "text", "boolean"]),
  required: z.boolean(),
});

const reviewSectionSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  questions: z.array(reviewQuestionSchema),
});

const surveyQuestionSchema = z.object({
  id: z.string(),
  text: z.string().min(1),
  type: z.enum(["rating", "text", "boolean", "multiple_choice"]),
  options: z.array(z.string()).optional(),
  required: z.boolean(),
  order: z.number().int().min(0),
});

const goalItemSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  metricType: z.enum(["numeric", "percentage", "boolean"]),
  targetValue: z.number().optional(),
  required: z.boolean(),
});

export const templateContentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum(["onboarding_checklist", "offboarding_checklist", "asset_assignment"]),
    items: z.array(checklistItemSchema),
  }),
  z.object({
    kind: z.enum(["probation_review", "performance_review", "exit_interview"]),
    sections: z.array(reviewSectionSchema),
  }),
  z.object({
    kind: z.literal("survey"),
    questions: z.array(surveyQuestionSchema),
  }),
  z.object({
    kind: z.literal("goal"),
    goals: z.array(goalItemSchema),
  }),
  z.object({
    kind: z.enum(["letter", "document_request", "email", "notification", "training"]),
    subject: z.string().optional(),
    bodyHtml: z.string(),
  }),
]);

export const createTemplateSchema = z.object({
  kind: z.enum(HR_TEMPLATE_KINDS),
  name: z.string().min(2).max(120),
  description: z.string().max(500).optional(),
  content: z.record(z.string(), z.unknown()).default({}),
  variablesUsed: z.array(z.string()).optional(),
  letterType: z.enum(HR_LETTER_TYPES).optional(),
});

export const updateTemplateSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  description: z.string().max(500).optional(),
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
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;
export type TransitionTemplateInput = z.infer<typeof transitionTemplateSchema>;
export type RenderTemplateInput = z.infer<typeof renderTemplateSchema>;
export type TemplateListQuery = z.infer<typeof templateListQuerySchema>;
