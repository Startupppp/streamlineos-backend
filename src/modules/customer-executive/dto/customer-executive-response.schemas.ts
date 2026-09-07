import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";
import { successSchema } from "../../../common/openapi/response-envelopes";

const healthWeightsSchema = z.record(z.string(), z.number());
const healthThresholdsSchema = z.record(z.string(), z.number());

const latestHealthScoreSchema = z.object({
  clientAccountId: z.number().int(),
  clientName: z.string(),
  score: z.number(),
  status: z.string(),
  breakdown: z.record(z.string(), z.unknown()),
  computedAt: z.string(),
});

export const healthListSchema = z.object({
  items: z.array(latestHealthScoreSchema),
  summary: z.object({
    healthy: z.number().int(),
    atRisk: z.number().int(),
    critical: z.number().int(),
    total: z.number().int(),
    avgScore: z.number(),
  }),
});

export const healthConfigSchema = z.object({
  weights: healthWeightsSchema,
  thresholds: healthThresholdsSchema,
  isDefault: z.boolean(),
});

export const healthConfigUpdateSchema = z.object({
  weights: healthWeightsSchema,
  thresholds: healthThresholdsSchema,
});

export const recomputeHealthSchema = z.object({
  healthy: z.number().int(),
  atRisk: z.number().int(),
  critical: z.number().int(),
  total: z.number().int(),
  avgScore: z.number(),
});

const npsSurveyWithStatsSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  question: z.string(),
  status: z.string(),
  publicToken: z.string(),
  createdBy: z.string().nullable(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  responseCount: z.number().int(),
  promoters: z.number().int(),
  passives: z.number().int(),
  detractors: z.number().int(),
  nps: z.number(),
});

export const surveyListSchema = z.array(npsSurveyWithStatsSchema);
export const surveyCreateSchema = npsSurveyWithStatsSchema;

const npsBreakdownSchema = z.object({
  promoters: z.number().int(),
  passives: z.number().int(),
  detractors: z.number().int(),
  total: z.number().int(),
});

const trendItemSchema = z.object({
  category: z.string(),
  createdAt: z.string(),
});

export const npsStatsSchema = z.object({
  activeSurveys: z.number().int(),
  breakdown: npsBreakdownSchema,
  nps: z.number(),
  trend: z.array(trendItemSchema),
});

const npsResponseRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  surveyId: z.number().int(),
  score: z.number().int(),
  category: z.string(),
  comment: z.string().nullable(),
  respondentName: z.string().nullable(),
  respondentEmail: z.string().nullable(),
  clientAccountId: z.number().int().nullable(),
  createdAt: wireDate(),
});

export const surveyDetailSchema = z.object({
  survey: z.object({
    id: z.number().int(),
    orgId: z.string(),
    title: z.string(),
    question: z.string(),
    status: z.string(),
    publicToken: z.string(),
    createdBy: z.string().nullable(),
    createdByMembershipId: z.number().int().nullable(),
    createdAt: wireDate(),
    updatedAt: wireDate(),
  }),
  responses: z.array(npsResponseRowSchema),
  breakdown: npsBreakdownSchema,
  nps: z.number(),
});

export const surveyUpdateSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  question: z.string(),
  status: z.string(),
  publicToken: z.string(),
  createdBy: z.string().nullable(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export { successSchema as surveyDeleteSchema };

const slaBreachSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  priority: z.string(),
  status: z.string(),
  createdAt: z.string(),
  hoursOpen: z.number(),
  slaTarget: z.number(),
});

const slaPrioritySchema = z.object({
  priority: z.string(),
  total: z.number().int(),
  withinSla: z.number().int(),
  breached: z.number().int(),
  avgResolutionHours: z.number(),
  slaTarget: z.number(),
});

export const slaReportSchema = z.object({
  stats: z.object({
    totalTickets: z.number().int(),
    withinSla: z.number().int(),
    slaBreached: z.number().int(),
    complianceRate: z.number(),
    avgResolutionHours: z.number(),
  }),
  byPriority: z.array(slaPrioritySchema),
  recentBreaches: z.array(slaBreachSchema),
});
