import { z } from "zod";
import {
  invAiActionSchema,
  invAiFactorSchema,
  invEvidenceReferenceSchema,
} from "../../dto/inv-ai-contract";
import { aiUsageMetaSchema, invAiProvenanceSchema } from "../../dto/inv-ai-wire.schemas";

/** `ResolvedInvAiAction` (`inv-ai-action-resolver.ts`) — resolved server-side. */
const resolvedActionSchema = z.object({
  action: invAiActionSchema,
  label: z.string(),
  href: z.string().nullable(),
  permission: z.string(),
  mutates: z.boolean(),
  rationale: z.string(),
  evidence: z.array(invEvidenceReferenceSchema),
});

/** `InvDemandRiskCoverage` — the periods the forecast was fitted over. */
const coverageSchema = z.object({
  from: z.string(),
  to: z.string(),
  periods: z.number().int(),
  historyWeeks: z.number().int(),
  horizonWeeks: z.number().int(),
});

/**
 * `InvDemandRiskUncertainty`. Every figure is an exact decimal STRING, because
 * these are `numeric` columns the forecasting engine computed — rendering them
 * as JSON numbers here would be a second, lossier copy of the same arithmetic.
 */
const uncertaintySchema = z.object({
  method: z.string().nullable(),
  demandCategory: z.string(),
  mae: z.string().nullable(),
  rmse: z.string().nullable(),
  bias: z.string().nullable(),
  mase: z.string().nullable(),
  demandMean: z.string(),
  demandStdDev: z.string(),
  serviceLevel: z.string(),
  z: z.string().nullable(),
  applicable: z.boolean(),
  refusalReason: z.string().nullable(),
  safetyStock: z.string().nullable(),
  reorderPoint: z.string().nullable(),
  leadTimeDemand: z.string().nullable(),
  censoredPeriods: z.number().int(),
  stockoutCensored: z.boolean(),
  censoringNote: z.string().nullable(),
  shapeNote: z.string().nullable(),
});

/** `InvDemandRiskResult` (`inv-demand-risk.service.ts`). */
export const demandRiskResponseSchema = z.object({
  status: z.enum(["ok", "insufficient_evidence", "facts_only"]),
  productVariantId: z.number().int(),
  warehouseId: z.number().int().nullable(),
  coverage: coverageSchema.nullable(),
  uncertainty: uncertaintySchema.nullable(),
  forecastId: z.number().int().nullable(),
  forecastGeneratedAt: z.string().nullable(),
  narration: z.string().nullable(),
  factors: z.array(invAiFactorSchema),
  actions: z.array(resolvedActionSchema),
  missing: z.array(z.string()),
  evidence: z.array(invEvidenceReferenceSchema),
  provenance: invAiProvenanceSchema.nullable(),
  aiUsage: aiUsageMetaSchema.optional(),
  generatedAt: z.string(),
});
