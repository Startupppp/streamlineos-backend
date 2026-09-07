import { z } from "zod";
import { wireDate } from "../../../common/openapi/wire-types";
import { successSchema } from "../../../common/openapi/response-envelopes";

export const surveyChoiceSchema = z.object({
  id: z.number().int(),
  choiceKey: z.string(),
  label: z.string(),
  value: z.string().nullable(),
  score: z.number().int().nullable(),
  sortOrder: z.number().int(),
  isCorrect: z.boolean(),
  createdAt: wireDate(),
});

export const surveyQuestionSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  surveyId: z.number().int(),
  versionId: z.number().int(),
  sectionId: z.number().int(),
  questionKey: z.string(),
  variableName: z.string().nullable(),
  type: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  required: z.boolean(),
  settings: z.record(z.string(), z.unknown()),
  validation: z.record(z.string(), z.unknown()),
  scoring: z.record(z.string(), z.unknown()),
  sortOrder: z.number().int(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  choices: z.array(surveyChoiceSchema),
});

export const surveySectionRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  surveyId: z.number().int(),
  versionId: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  sortOrder: z.number().int(),
  settings: z.record(z.string(), z.unknown()),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const builderChoiceSchema = z.object({
  id: z.number().int(),
  choiceKey: z.string(),
  label: z.string(),
  value: z.string().nullable(),
  score: z.number().int().nullable(),
  sortOrder: z.number().int(),
  isCorrect: z.boolean(),
});

const builderQuestionSchema = z.object({
  id: z.number().int(),
  questionKey: z.string(),
  variableName: z.string().nullable(),
  type: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  required: z.boolean(),
  settings: z.record(z.string(), z.unknown()),
  validation: z.record(z.string(), z.unknown()),
  scoring: z.record(z.string(), z.unknown()),
  sortOrder: z.number().int(),
  choices: z.array(builderChoiceSchema),
});

const builderSectionSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  sortOrder: z.number().int(),
  settings: z.record(z.string(), z.unknown()),
  questions: z.array(builderQuestionSchema),
});

const builderLogicRuleSchema = z.object({
  id: z.number().int(),
  sourceQuestionId: z.number().int(),
  condition: z.record(z.string(), z.unknown()),
  action: z.record(z.string(), z.unknown()),
  target: z.record(z.string(), z.unknown()).nullable(),
  sortOrder: z.number().int(),
});

export const surveyBuilderSnapshotSchema = z.object({
  sections: z.array(builderSectionSchema),
  logicRules: z.array(builderLogicRuleSchema),
});

export const surveyLogicRuleRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  surveyId: z.number().int(),
  versionId: z.number().int(),
  sourceQuestionId: z.number().int(),
  condition: z.record(z.string(), z.unknown()),
  action: z.record(z.string(), z.unknown()),
  target: z.record(z.string(), z.unknown()).nullable(),
  sortOrder: z.number().int(),
  createdAt: wireDate(),
});

export const surveyLogicRuleListSchema = z.array(surveyLogicRuleRowSchema);

export { successSchema };
