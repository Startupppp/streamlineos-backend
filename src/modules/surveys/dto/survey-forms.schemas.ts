import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../common/pagination/list-query.schema";

export const surveyModeSchema = z.enum(["survey", "assessment", "live_session", "lead_qualification", "custom"]);
export const surveyStatusSchema = z.enum(["draft", "testing", "published", "paused", "closed", "archived"]);

export const listSurveysSchema = z.object({
  status: surveyStatusSchema.optional(),
  mode: surveyModeSchema.optional(),
  search: z.string().trim().max(200).optional(),
  page: pageNumberField,
  pageSize: pageSizeField(25, 100),
}).strict();

export const createSurveySchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  mode: surveyModeSchema.default("survey"),
  defaultLanguage: z.string().min(2).max(10).default("en"),
  templateKey: z.string().max(100).optional(),
}).strict();

export const patchSurveySchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  ownerUserId: z.string().nullable().optional(),
  defaultLanguage: z.string().min(2).max(10).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  branding: z.record(z.string(), z.unknown()).optional(),
}).strict();

export type ListSurveysInput = z.infer<typeof listSurveysSchema>;
export type CreateSurveyInput = z.infer<typeof createSurveySchema>;
export type PatchSurveyInput = z.infer<typeof patchSurveySchema>;
