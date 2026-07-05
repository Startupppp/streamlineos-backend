import { z } from "zod";

export const surveyQuestionTypeSchema = z.enum([
  "short_text",
  "long_text",
  "single_select",
  "multi_select",
  "dropdown",
  "rating",
  "star_rating",
  "nps",
  "number",
  "email",
  "phone",
  "date",
  "matrix",
  "likert",
  "ranking",
  "slider",
  "yes_no",
  "consent",
  "content_block",
]);

export const createSectionSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  sortOrder: z.number().int().min(0).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

export const patchSectionSchema = createSectionSchema.partial();

export const choiceInputSchema = z.object({
  choiceKey: z.string().min(1).max(100),
  label: z.string().min(1).max(500),
  value: z.string().max(500).optional(),
  score: z.number().int().optional(),
  sortOrder: z.number().int().min(0).optional(),
  isCorrect: z.boolean().optional(),
});

export const createQuestionSchema = z.object({
  sectionId: z.number().int().positive(),
  type: surveyQuestionTypeSchema,
  title: z.string().min(1).max(1000),
  description: z.string().max(2000).optional(),
  required: z.boolean().default(false),
  variableName: z.string().max(100).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  validation: z.record(z.string(), z.unknown()).optional(),
  scoring: z.record(z.string(), z.unknown()).optional(),
  sortOrder: z.number().int().min(0).optional(),
  choices: z.array(choiceInputSchema).optional(),
});

export const patchQuestionSchema = z.object({
  sectionId: z.number().int().positive().optional(),
  type: surveyQuestionTypeSchema.optional(),
  title: z.string().min(1).max(1000).optional(),
  description: z.string().max(2000).nullable().optional(),
  required: z.boolean().optional(),
  variableName: z.string().max(100).nullable().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  validation: z.record(z.string(), z.unknown()).optional(),
  scoring: z.record(z.string(), z.unknown()).optional(),
  sortOrder: z.number().int().min(0).optional(),
  choices: z.array(choiceInputSchema).optional(),
});

export const reorderSchema = z.object({
  sections: z.array(z.object({ id: z.number().int().positive(), sortOrder: z.number().int().min(0) })).optional(),
  questions: z.array(z.object({ id: z.number().int().positive(), sectionId: z.number().int().positive(), sortOrder: z.number().int().min(0) })).optional(),
});

const conditionSchema = z.object({
  op: z.enum(["answer_equals", "answer_contains", "score_gt", "score_lt", "metadata_equals", "collector_equals", "contact_field_equals", "completion_status_equals"]),
  questionId: z.number().int().positive().optional(),
  value: z.unknown().optional(),
});

const actionSchema = z.object({
  type: z.enum([
    "skip_to_question",
    "skip_to_section",
    "show_question",
    "hide_question",
    "disqualify",
    "end_survey",
    "assign_score",
    "assign_segment",
    "create_lead",
    "send_notification",
    "set_variable",
  ]),
});

export const createLogicRuleSchema = z.object({
  sourceQuestionId: z.number().int().positive(),
  condition: conditionSchema,
  action: actionSchema,
  target: z.record(z.string(), z.unknown()).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

export const patchLogicRuleSchema = createLogicRuleSchema.partial();

export type CreateSectionInput = z.infer<typeof createSectionSchema>;
export type PatchSectionInput = z.infer<typeof patchSectionSchema>;
export type CreateQuestionInput = z.infer<typeof createQuestionSchema>;
export type PatchQuestionInput = z.infer<typeof patchQuestionSchema>;
export type ReorderInput = z.infer<typeof reorderSchema>;
export type CreateLogicRuleInput = z.infer<typeof createLogicRuleSchema>;
export type PatchLogicRuleInput = z.infer<typeof patchLogicRuleSchema>;
