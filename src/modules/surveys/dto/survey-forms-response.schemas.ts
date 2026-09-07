import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";
import { successSchema } from "../../../common/openapi/response-envelopes";

export const surveyFormRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  mode: z.enum(["survey", "assessment", "live_session", "lead_qualification", "custom"]),
  status: z.enum(["draft", "testing", "published", "paused", "closed", "archived"]),
  ownerUserId: z.string().nullable(),
  ownerMembershipId: z.number().int().nullable(),
  defaultLanguage: z.string(),
  activeVersionId: z.number().int().nullable(),
  settings: z.record(z.string(), z.unknown()),
  branding: z.record(z.string(), z.unknown()),
  createdBy: z.string().nullable(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  archivedAt: nullableWireDate(),
});

export const surveyFormListSchema = z.object({
  items: z.array(surveyFormRowSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  totalPages: z.number().int(),
});

const surveyTemplateChoiceSchema = z.object({
  choiceKey: z.string(),
  label: z.string(),
  value: z.string().optional(),
  score: z.number().optional(),
  isCorrect: z.boolean().optional(),
});

const surveyTemplateQuestionSchema = z.object({
  type: z.string(),
  title: z.string(),
  required: z.boolean().optional(),
  variableName: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  choices: z.array(surveyTemplateChoiceSchema).optional(),
});

const surveyTemplateSectionSchema = z.object({
  title: z.string(),
  questions: z.array(surveyTemplateQuestionSchema),
});

export const surveyTemplateSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  mode: z.enum(["survey", "assessment", "live_session", "lead_qualification", "custom"]),
  category: z.string(),
  sections: z.array(surveyTemplateSectionSchema),
});

export const surveyTemplateListSchema = z.array(surveyTemplateSchema);

export const surveyVersionRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  surveyId: z.number().int(),
  versionNumber: z.number().int(),
  schemaSnapshot: z.record(z.string(), z.unknown()).nullable(),
  publishedAt: nullableWireDate(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
});

export { successSchema };
