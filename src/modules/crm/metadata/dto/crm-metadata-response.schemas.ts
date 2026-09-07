import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { successSchema } from "../../../../common/openapi/response-envelopes";

export const pipelineSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  type: z.string().nullable(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isDefault: z.boolean(),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const pipelineStageSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  pipelineId: z.string(),
  key: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  color: z.string().nullable(),
  icon: z.string().nullable(),
  sortOrder: z.number().int(),
  probability: z.number().int(),
  stageType: z.string(),
  isTerminal: z.boolean(),
  slaHours: z.number().int().nullable(),
  requiresApproval: z.boolean(),
  requiredFields: z.unknown().nullable(),
  allowedNextStageKeys: z.unknown().nullable(),
  isActive: z.boolean(),
  isSystemDefault: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const crmOptionSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  type: z.string(),
  key: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  color: z.string().nullable(),
  icon: z.string().nullable(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  isSystemDefault: z.boolean(),
  isTerminal: z.boolean(),
  metadata: z.unknown().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const uiMetadataSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  scope: z.string(),
  config: z.unknown().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const crmAggregateSchema = z.object({
  pipelines: z.array(pipelineSchema),
  stages: z.array(pipelineStageSchema),
  options: z.array(crmOptionSchema),
  uiMetadata: z.array(uiMetadataSchema),
});

export const validationRuleSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  entityType: z.string(),
  field: z.string(),
  ruleType: z.string(),
  config: z.unknown().nullable(),
  pipelineId: z.string().nullable(),
  stageKey: z.string().nullable(),
  sourceKey: z.string().nullable(),
  errorMessage: z.string().nullable(),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const testValidationSchema = z.object({
  valid: z.boolean(),
  errors: z.array(
    z.object({
      field: z.string(),
      ruleType: z.string(),
      message: z.string(),
    }),
  ),
});

export const blueprintSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  pipelineId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const blueprintTransitionSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  blueprintId: z.string(),
  fromStageKey: z.string(),
  toStageKey: z.string(),
  requiredFields: z.unknown().nullable(),
  requiredActivityTypeKeys: z.unknown().nullable(),
  requiresApproval: z.boolean(),
  requiresQuote: z.boolean(),
  autoTaskTemplates: z.unknown().nullable(),
  sortOrder: z.number().int(),
});

export const testTransitionSchema = z.object({
  allowed: z.boolean(),
  requiresApproval: z.boolean(),
  missingFields: z.array(z.string()),
});

export const dataQualityAggSchema = z.object({
  count: z.number().int(),
  offenders: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      detail: z.string().optional(),
    }),
  ),
});

export const dataQualityReportSchema = z.object({
  leadsWithoutEmail: dataQualityAggSchema,
  leadsWithInvalidPhone: dataQualityAggSchema,
  duplicateLeads: dataQualityAggSchema,
  duplicateCompanies: dataQualityAggSchema,
  staleDeals: dataQualityAggSchema,
  dealsWithNoNextActivity: dataQualityAggSchema,
  leadsWithNoOwner: dataQualityAggSchema,
  dealsMissingStageFields: dataQualityAggSchema,
});

export { successSchema };
