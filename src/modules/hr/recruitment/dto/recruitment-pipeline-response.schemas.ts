import { z } from "zod";
import { nullableWireDate } from "../../../../common/openapi/wire-types";

export const pipelineStageSchema = z.object({
  stage: z.string(),
  /** Every candidate in this stage, including the ones not rendered. */
  total: z.number().int(),
  /** How many of them this payload carries. */
  shown: z.number().int(),
  /** `total > shown`. The board says so rather than dropping people silently. */
  truncated: z.boolean(),
  candidates: z.array(z.object({
    id: z.number().int(),
    name: z.string(),
    email: z.string(),
    phone: z.string().nullable(),
    source: z.string().nullable(),
    rating: z.number().int().nullable(),
    jobTitle: z.string().nullable(),
    applicationId: z.number().int().nullable(),
    appliedAt: nullableWireDate(),
    slaStatus: z.string().nullable(),
    resumeUrl: z.string().nullable(),
    notes: z.string().nullable(),
  })),
});

export const pipelineResponseSchema = z.object({
  stages: z.array(pipelineStageSchema),
});

export const diversityReportSchema = z.object({
  total: z.number().int(),
  genderBreakdown: z.array(z.object({ gender: z.string(), count: z.number().int() })),
  locationBreakdown: z.array(z.object({ location: z.string(), count: z.number().int() })),
  sourceBreakdown: z.array(z.object({ source: z.string(), count: z.number().int() })),
  stageBreakdown: z.array(z.object({ stage: z.string(), count: z.number().int() })),
});

export const bgvComplianceItemSchema = z.object({
  jobPostingId: z.number().int().nullable(),
  jobTitle: z.string(),
  total: z.number().int(),
  cleared: z.number().int(),
  failed: z.number().int(),
  pending: z.number().int(),
  initiated: z.number().int(),
  notInitiated: z.number().int(),
  clearedPct: z.number().int(),
});
